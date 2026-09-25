//! The Web console: PAT sign-in, a session cookie, and one WebSocket per browser tab that
//! speaks the `agitd-controller` JSON-RPC surface. Requests go through
//! `agit_controller::host::dispatch` to an in-process controller, which reaches executors
//! through this same relay over loopback.

mod assets;
mod sessions;

use crate::{
    App,
    error::{ApiError, ApiResult},
    registry::Kind,
    util::secret,
};
use agit_controller::{Controller, Event, Worker, cloud::Credentials};
use agit_peer::{
    Identity,
    client::Client,
    cloud::{DevicePresence, Enrollment, Secret},
};
use axum::{
    Json, Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{broadcast::error::RecvError, mpsc};

const COOKIE: &str = "agit_console";
const COOKIE_MAX_AGE: u64 = 30 * 24 * 60 * 60;
const MAX_REQUESTS: usize = 64;
const MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const OUTPUT_QUEUE: usize = 256;
/// With no tab attached for this long, peers are disconnected; tabs reconnect and replay.
const DETACHED_PEERS: Duration = Duration::from_secs(5 * 60);
/// Failed sign-ins allowed per window before the endpoint refuses further attempts.
const SIGN_IN_FAILURES: usize = 10;
const SIGN_IN_WINDOW: Duration = Duration::from_secs(60);

/// One controller per account, shared by every tab: peers and their event streams survive a
/// tab closing, the same way Desktop keeps peers across UI reconnects.
struct Host {
    controller: Arc<Controller>,
    api: Client,
    credentials: Arc<Credentials>,
    /// Attached tabs, and when the last one left.
    attached: Mutex<(usize, Option<Instant>)>,
}

/// Counts one attached tab for as long as it lives.
struct Attachment(Arc<Host>);

impl Attachment {
    fn new(host: Arc<Host>) -> Self {
        host.attached.lock().unwrap().0 += 1;
        Self(host)
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        let mut attached = self.0.attached.lock().unwrap();
        attached.0 -= 1;
        if attached.0 == 0 {
            attached.1 = Some(Instant::now());
        }
    }
}

pub struct Console {
    sessions: sessions::Sessions,
    hosts: Mutex<HashMap<String, Arc<Host>>>,
    transport_origin: String,
    secure_cookie: bool,
    failures: Mutex<Vec<Instant>>,
    dev_pat: Option<String>,
}

impl Console {
    pub fn open(
        data: &Path,
        issuer: &str,
        transport_origin: String,
        dev_pat: Option<String>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            sessions: sessions::Sessions::open(data.join("console-sessions.json"))?,
            hosts: Mutex::default(),
            transport_origin,
            secure_cookie: issuer.starts_with("https://"),
            failures: Mutex::default(),
            dev_pat,
        })
    }

    fn host(&self, app: &App, account_id: &str) -> anyhow::Result<Arc<Host>> {
        let mut hosts = self.hosts.lock().unwrap();
        if let Some(host) = hosts.get(account_id) {
            return Ok(host.clone());
        }
        let owner = app.accounts.principal_of(account_id);
        let identity = Identity::generate()?;
        // Registered in-process and never persisted: the identity lives exactly as long as
        // this process, like the lease an `agitd-controller` host renews.
        let device = app
            .registry
            .enroll(
                &owner,
                Enrollment {
                    machine_id: format!("web-console-{}", uuid::Uuid::new_v4()),
                    display_name: "Web console".into(),
                    certificate: identity.certificate().clone(),
                },
                Kind::Controller,
                None,
            )
            .map_err(|error| anyhow::anyhow!("registering the console controller: {error:?}"))?;
        let token = secret("agrl_internal");
        app.accounts.register_internal(&token, account_id);
        let host = Arc::new(Host {
            controller: Arc::new(Controller::new(Worker {
                executable: std::env::current_exe()?,
                args: vec!["tunnel".into()],
            })),
            api: Client::new(&app.issuer)?.with_trusted_transport_origin(&self.transport_origin)?,
            credentials: Arc::new(Credentials {
                identity: Arc::new(identity),
                device,
                account: Secret::new(token),
            }),
            attached: Mutex::new((0, Some(Instant::now()))),
        });
        hosts.insert(account_id.to_owned(), host.clone());
        Ok(host)
    }

    /// Peers of an unattended console keep retrying offline devices; nobody consumes their
    /// events, and executors keep running sessions without them.
    pub fn sweep(&self) {
        let hosts: Vec<_> = self.hosts.lock().unwrap().values().cloned().collect();
        for host in hosts {
            let idle = matches!(*host.attached.lock().unwrap(),
                (0, Some(since)) if since.elapsed() >= DETACHED_PEERS);
            if idle {
                for peer in host.controller.list() {
                    host.controller.disconnect(&peer.peer_id);
                }
            }
        }
    }

    fn throttle(&self) -> ApiResult<()> {
        let mut failures = self.failures.lock().unwrap();
        failures.retain(|failed| failed.elapsed() < SIGN_IN_WINDOW);
        if failures.len() >= SIGN_IN_FAILURES {
            return Err(ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "too many failed sign-ins; wait a minute",
            ));
        }
        Ok(())
    }

    fn cookie(&self, value: &str, max_age: u64) -> HeaderValue {
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{COOKIE}={value}; Path=/console; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"
        ))
        .expect("cookie values are ASCII")
    }
}

pub fn routes() -> Router<Arc<App>> {
    // Only page assets are compressed; the socket and JSON endpoints are left as they are.
    let pages = Router::new()
        .route("/console/", get(page))
        .route("/console/{*path}", get(page))
        .layer(tower_http::compression::CompressionLayer::new());
    Router::new()
        .route("/console", get(assets::redirect))
        .merge(pages)
        .route("/console/api/login", post(login))
        .route("/console/api/logout", post(logout))
        .route("/console/api/me", get(me))
        .route("/console/api/options", get(options))
        .route("/console/ws", get(socket))
}

async fn page(State(app): State<Arc<App>>, uri: Uri) -> Response {
    assets::serve(&uri, assets::content_security_policy(&app.issuer))
}

fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(COOKIE)?.strip_prefix('='))
        .filter(|token| !token.is_empty())
}

async fn session(app: &App, headers: &HeaderMap) -> ApiResult<sessions::Session> {
    let token = session_token(headers).ok_or_else(|| ApiError::unauthorized("sign in first"))?;
    app.console
        .sessions
        .authenticate(&app.accounts, token)
        .await
        .ok_or_else(|| ApiError::unauthorized("the session has ended; sign in again"))
}

/// Cookies are `SameSite=Strict`, and state-changing requests must also come from this origin.
fn same_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    match headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        Some(origin) if origin == app.issuer => Ok(()),
        _ => Err(ApiError::forbidden("cross-origin request refused")),
    }
}

#[derive(Deserialize)]
struct SignInRequest {
    #[serde(default)]
    token: String,
    /// Sign in with the server's development PAT; only honoured when one was configured.
    #[serde(default)]
    dev: bool,
}

async fn options(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({"dev_login": app.console.dev_pat.is_some()}))
}

async fn login(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<SignInRequest>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    app.console.throttle()?;
    let token = match (&app.console.dev_pat, request.dev) {
        (Some(pat), true) => pat.as_str(),
        (None, true) => return Err(ApiError::forbidden("development sign-in is disabled")),
        _ => request.token.trim(),
    };
    let signed_in = match app.accounts.sign_in(token).await {
        Ok(signed_in) => signed_in,
        Err(error) => {
            app.console.failures.lock().unwrap().push(Instant::now());
            return Err(error);
        }
    };
    let token = app.console.sessions.create(
        signed_in.account_id.clone(),
        signed_in.username.clone(),
        signed_in.refresh_token,
    )?;
    Ok((
        [(
            header::SET_COOKIE,
            app.console.cookie(&token, COOKIE_MAX_AGE),
        )],
        Json(json!({"account_id": signed_in.account_id, "username": signed_in.username})),
    )
        .into_response())
}

async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    if let Some(token) = session_token(&headers) {
        app.console.sessions.remove(token)?;
    }
    Ok((
        [(header::SET_COOKIE, app.console.cookie("", 0))],
        Json(json!({"ok": true})),
    )
        .into_response())
}

async fn me(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let session = session(&app, &headers).await?;
    Ok(Json(
        json!({"account_id": session.account_id, "username": session.username, "issuer": app.issuer}),
    ))
}

async fn socket(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    let session = session(&app, &headers).await?;
    let host = app.console.host(&app, &session.account_id)?;
    Ok(upgrade
        .max_message_size(MESSAGE_BYTES)
        .on_upgrade(move |socket| serve(app, host, session, socket)))
}

/// Mirrors the `agitd-controller` stdio loop: bounded concurrent requests, replies in any
/// order, and controller events forwarded as `peer.state` / `peer.frame` notifications. A tab
/// that falls behind the event stream is disconnected so it reconnects and replays.
async fn serve(app: Arc<App>, host: Arc<Host>, session: sessions::Session, socket: WebSocket) {
    let _attachment = Attachment::new(host.clone());
    let (mut sink, mut stream) = socket.split();
    let (output, mut queue) = mpsc::channel::<String>(OUTPUT_QUEUE);
    let mut events = host.controller.subscribe();
    let writer = async move {
        while let Some(text) = queue.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
    };
    let requests = {
        let output = output.clone();
        async move {
            let mut running = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    message = stream.next() => {
                        let request = match message {
                            Some(Ok(Message::Text(text))) => match serde_json::from_str::<Value>(&text) {
                                Ok(request) => request,
                                Err(_) => return,
                            },
                            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                            _ => return,
                        };
                        if running.len() >= MAX_REQUESTS {
                            let reply = rejected(&request["id"], "console request capacity exceeded");
                            if output.send(reply.to_string()).await.is_err() {
                                return;
                            }
                            continue;
                        }
                        let (app, host, session, output) = (app.clone(), host.clone(), session.clone(), output.clone());
                        running.spawn(async move {
                            let reply = handle(&app, &host, &session, request).await;
                            let _ = output.send(reply.to_string()).await;
                        });
                    }
                    Some(_) = running.join_next(), if !running.is_empty() => {}
                }
            }
        }
    };
    let notifications = async move {
        loop {
            let frame = match events.recv().await {
                Ok(event) => notification(&event),
                Err(RecvError::Lagged(_)) => {
                    let _ = output
                        .send(
                            json!({"jsonrpc":"2.0","method":"console.lagged","params":{}})
                                .to_string(),
                        )
                        .await;
                    return;
                }
                Err(RecvError::Closed) => return,
            };
            if output.send(frame.to_string()).await.is_err() {
                return;
            }
        }
    };
    tokio::select! {
        _ = writer => {}
        _ = requests => {}
        _ = notifications => {}
    }
}

fn notification(event: &Event) -> Value {
    match event {
        Event::State { status } => json!({"jsonrpc":"2.0","method":"peer.state",
            "params":{"peer_id":status.peer_id,"status":status}}),
        Event::Frame {
            peer_id,
            route_id,
            generation,
            frame,
            ..
        } => json!({"jsonrpc":"2.0","method":"peer.frame",
            "params":{"peer_id":peer_id,"route_id":route_id,"generation":generation,"frame":frame}}),
    }
}

async fn handle(app: &App, host: &Host, session: &sessions::Session, request: Value) -> Value {
    let id = request["id"].clone();
    match request["method"].as_str().unwrap_or("") {
        "console.devices" => {
            let owner = app.accounts.principal_of(&session.account_id);
            let mut devices = Vec::new();
            let mut after = None;
            loop {
                let (page, next) = app.registry.page(&owner, after.as_deref());
                devices.extend(page.into_iter().map(|device| DevicePresence {
                    online: app.relay.online(&device.id),
                    device,
                }));
                match next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            json!({"jsonrpc":"2.0","id":id,"result":{"devices":devices}})
        }
        "console.me" => json!({"jsonrpc":"2.0","id":id,"result":{
            "account_id": session.account_id, "username": session.username, "issuer": app.issuer}}),
        _ => {
            agit_controller::host::dispatch(
                host.controller.clone(),
                host.api.clone(),
                host.credentials.clone(),
                request,
            )
            .await
        }
    }
}

fn rejected(id: &Value, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":300,"message":message,
        "data":{"outcome":"not_sent"}}})
}
