//! Presence carries offers to executors. Data sockets are paired by ticket and then forward
//! opaque binary records in both directions without interpreting them.

use super::state::{Claimed, Joined, OFFER_QUEUE, PAIRING_TIMEOUT, Presence};
use crate::{App, error::ApiError, registry::Kind, util::bearer};
use agit_peer::cloud::{DataJoin, DataReady, Device, PresenceEvent};
use axum::{
    body::Bytes,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{Notify, mpsc, oneshot},
    time::{Instant, interval_at},
};

/// Pings must arrive well inside the executor's presence silence limit, or it drops the socket.
const PRESENCE_PING: Duration = Duration::from_secs(20);
/// Executors answer every ping. A path that dies without closing keeps the socket open here,
/// and until it is dropped the device looks online while every offer goes nowhere; missing
/// several answers in a row marks the device offline instead.
const PRESENCE_SILENCE: Duration = Duration::from_secs(60);
/// The ping keeps proxies from timing out idle links and rechecks the grant between the
/// controller's own health checks.
const DATA_PING: Duration = Duration::from_secs(25);
/// Clients join within a few seconds of opening, and drop sockets they could not use in time.
const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
/// Senders chunk records below this bound; a larger message is not a valid record.
const DATA_MESSAGE_BYTES: usize = 128 * 1024;
const PRESENCE_MESSAGE_BYTES: usize = 64 * 1024;
/// The controller sends its TLS ClientHello before readiness; a first flight is small.
const EARLY_BYTES: usize = 256 * 1024;
const FORWARD_QUEUE: usize = 64;

fn authenticate(app: &App, headers: &HeaderMap) -> Result<(Device, Kind), ApiError> {
    bearer(headers)
        .and_then(|token| app.registry.authenticate(token))
        .map(|authenticated| (authenticated.device, authenticated.kind))
        .ok_or_else(|| ApiError::unauthorized("Invalid device credential"))
}

pub async fn presence(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (device, kind) = match authenticate(&app, &headers) {
        Ok(authenticated) => authenticated,
        Err(error) => return error.into_response(),
    };
    if kind != Kind::Device {
        return ApiError::forbidden("controllers do not receive offers").into_response();
    }
    let grant_offers = headers
        .get_all("x-agit-peer-offer")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim() == "grant-v1");
    upgrade
        .max_message_size(PRESENCE_MESSAGE_BYTES)
        .on_upgrade(move |socket| run_presence(app, device, grant_offers, socket))
}

async fn run_presence(app: Arc<App>, device: Device, grant_offers: bool, mut socket: WebSocket) {
    let epoch = uuid::Uuid::new_v4().to_string();
    let (offers, mut queue) = mpsc::channel(OFFER_QUEUE);
    let stop = Arc::new(Notify::new());
    app.relay.attach(
        &device.id,
        Presence {
            epoch: epoch.clone(),
            grant_offers,
            offers,
            stop: stop.clone(),
        },
    );
    let ready = PresenceEvent::Ready {
        epoch: epoch.clone(),
    };
    let mut open = send_json(&mut socket, &ready).await;
    let mut heartbeat = interval_at(Instant::now() + PRESENCE_PING, PRESENCE_PING);
    let mut heard = Instant::now();
    while open {
        open = tokio::select! {
            _ = stop.notified() => false,
            Some(offer) = queue.recv() => send_json(&mut socket, &offer).await,
            _ = heartbeat.tick() => {
                heard.elapsed() < PRESENCE_SILENCE
                    && app.registry.current(&device)
                    && socket.send(Message::Ping(Bytes::new())).await.is_ok()
            }
            // Executors send nothing on presence except control frames.
            message = socket.recv() => {
                heard = Instant::now();
                matches!(message, Some(Ok(Message::Ping(_) | Message::Pong(_))))
            }
        };
    }
    app.relay.detach(&device.id, &epoch);
    let _ = socket.send(Message::Close(None)).await;
}

async fn send_json(socket: &mut WebSocket, value: &impl serde::Serialize) -> bool {
    match serde_json::to_string(value) {
        Ok(text) => socket.send(Message::Text(text.into())).await.is_ok(),
        Err(_) => false,
    }
}

pub async fn data(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (device, _) = match authenticate(&app, &headers) {
        Ok(authenticated) => authenticated,
        Err(error) => return error.into_response(),
    };
    upgrade
        .max_message_size(DATA_MESSAGE_BYTES)
        .on_upgrade(move |socket| run_data(app, device, socket))
}

async fn run_data(app: Arc<App>, device: Device, mut socket: WebSocket) {
    let Ok(Some(text)) = tokio::time::timeout(JOIN_TIMEOUT, first_text(&mut socket)).await else {
        return;
    };
    let Ok(join) = serde_json::from_str::<DataJoin>(&text) else {
        return;
    };
    let Some(claimed) = app.relay.claim(join.ticket.expose(), &device.id) else {
        return;
    };
    if let Joined::First(socket, peer) = app.relay.join(&claimed.link_id, claimed.role, socket) {
        pair(&app, &claimed, *socket, peer).await;
        app.relay.finish(&claimed.link_id);
    }
}

async fn first_text(socket: &mut WebSocket) -> Option<String> {
    loop {
        match socket.recv().await? {
            Ok(Message::Text(text)) => return Some(text.to_string()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            _ => return None,
        }
    }
}

/// The first end to join owns the link. It buffers what its client sends before readiness
/// (the controller's ClientHello), announces readiness to both ends, then flushes the buffer.
async fn pair(
    app: &Arc<App>,
    claimed: &Claimed,
    mut first: WebSocket,
    peer: oneshot::Receiver<WebSocket>,
) {
    let mut early = Vec::new();
    let mut early_bytes = 0;
    let deadline = tokio::time::sleep(PAIRING_TIMEOUT);
    tokio::pin!(peer, deadline);
    let second = loop {
        tokio::select! {
            second = &mut peer => break second.ok(),
            _ = &mut deadline => break None,
            message = first.recv() => match message {
                Some(Ok(Message::Binary(bytes))) if early_bytes + bytes.len() <= EARLY_BYTES => {
                    early_bytes += bytes.len();
                    early.push(bytes);
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break None,
            },
        }
    };
    let Some(mut second) = second else {
        let _ = first.send(Message::Close(None)).await;
        return;
    };
    let ready = DataReady {
        link_id: claimed.link_id.clone(),
    };
    if !send_json(&mut first, &ready).await || !send_json(&mut second, &ready).await {
        return;
    }
    for bytes in early {
        if second.send(Message::Binary(bytes)).await.is_err() {
            return;
        }
    }
    forward(app, &claimed.grant, first, second).await;
}

/// Each direction has its own writer queue, so a slow reader stalls only the direction that
/// feeds it; a single loop awaiting one socket's write while the other side is full deadlocks.
async fn forward(app: &Arc<App>, grant: &str, first: WebSocket, second: WebSocket) {
    let (first_sink, first_stream) = first.split();
    let (second_sink, second_stream) = second.split();
    let (to_first, first_queue) = mpsc::channel(FORWARD_QUEUE);
    let (to_second, second_queue) = mpsc::channel(FORWARD_QUEUE);
    let heartbeat = {
        let (app, grant) = (app.clone(), grant.to_owned());
        let (to_first, to_second) = (to_first.clone(), to_second.clone());
        async move {
            let mut ticks = interval_at(Instant::now() + DATA_PING, DATA_PING);
            loop {
                ticks.tick().await;
                let Some((source, target)) = app.relay.grant_endpoints(&grant) else {
                    return;
                };
                if !app.registry.current(&source) || !app.registry.current(&target) {
                    return;
                }
                let ping = || Message::Ping(Bytes::new());
                if to_first.send(ping()).await.is_err() || to_second.send(ping()).await.is_err() {
                    return;
                }
            }
        }
    };
    tokio::select! {
        _ = write(first_sink, first_queue) => {}
        _ = write(second_sink, second_queue) => {}
        _ = read(first_stream, to_second) => {}
        _ = read(second_stream, to_first) => {}
        _ = heartbeat => {}
    }
}

async fn write(
    mut sink: futures_util::stream::SplitSink<WebSocket, Message>,
    mut queue: mpsc::Receiver<Message>,
) {
    while let Some(message) = queue.recv().await {
        if sink.send(message).await.is_err() {
            return;
        }
    }
}

/// After readiness only encrypted binary records are valid; any text frame ends the link.
async fn read(
    mut stream: futures_util::stream::SplitStream<WebSocket>,
    peer: mpsc::Sender<Message>,
) {
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Binary(bytes) => {
                if peer.send(Message::Binary(bytes)).await.is_err() {
                    return;
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            _ => return,
        }
    }
}
