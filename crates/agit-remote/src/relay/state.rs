//! Presence, grants, join tickets and half-open links live in memory: a relay restart drops
//! every link, and endpoints reconnect through fresh admission.

use crate::{
    error::{ApiError, ApiResult},
    registry::Registry,
    util::{digest, now_ms, secret},
};
use agit_peer::{
    access::Principal,
    cloud::{ConnectionGrant, Device, DialedConnection, GrantedConnection, PresenceEvent, Secret},
};
use axum::extract::ws::WebSocket;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Notify, mpsc, oneshot};

/// Executors renew at half of the remaining lease, so a live grant is renewed long before it expires.
pub const GRANT_LIFETIME_MS: i64 = 120_000;
/// Both ends must join their data sockets within this window after admission.
const TICKET_LIFETIME: Duration = Duration::from_secs(30);
/// Clients give up on readiness at their own deadline; waiting longer than that only holds sockets.
pub const PAIRING_TIMEOUT: Duration = Duration::from_secs(30);
/// Executors run a bounded number of offers at once and silently drop the rest.
pub const OFFER_QUEUE: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Controller,
    Executor,
}

pub struct Presence {
    pub epoch: String,
    /// Only executors that advertise `grant-v1` accept the optional `grant` field in offers.
    pub grant_offers: bool,
    pub offers: mpsc::Sender<PresenceEvent>,
    pub stop: Arc<Notify>,
}

struct Ticket {
    link_id: String,
    role: Role,
    device_id: String,
    expires: Instant,
}

struct Link {
    grant: String,
    created: Instant,
    waiting: Option<(Role, oneshot::Sender<WebSocket>)>,
    paired: bool,
}

#[derive(Default)]
struct Inner {
    presence: HashMap<String, Presence>,
    grants: HashMap<String, ConnectionGrant>,
    tickets: HashMap<String, Ticket>,
    links: HashMap<String, Link>,
}

pub struct Claimed {
    pub link_id: String,
    pub role: Role,
    pub grant: String,
}

pub enum Joined {
    /// The peer has not arrived: the caller keeps its socket and waits for the peer's.
    First(Box<WebSocket>, oneshot::Receiver<WebSocket>),
    /// The socket went to the waiting peer, which now owns the link.
    Handed,
    /// The link no longer exists or its other end gave up.
    Gone,
}

#[derive(Default)]
pub struct Relay {
    inner: Mutex<Inner>,
}

impl Relay {
    pub fn online(&self, device_id: &str) -> bool {
        self.inner.lock().unwrap().presence.contains_key(device_id)
    }

    /// A newer presence socket for the same device replaces the older one.
    pub fn attach(&self, device_id: &str, presence: Presence) {
        let previous = self
            .inner
            .lock()
            .unwrap()
            .presence
            .insert(device_id.to_owned(), presence);
        if let Some(previous) = previous {
            previous.stop.notify_one();
        }
    }

    pub fn detach(&self, device_id: &str, epoch: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .presence
            .get(device_id)
            .is_some_and(|presence| presence.epoch == epoch)
        {
            inner.presence.remove(device_id);
        }
    }

    pub fn dial(
        &self,
        caller: Principal,
        source: Device,
        target: Device,
    ) -> ApiResult<DialedConnection> {
        let mut inner = self.inner.lock().unwrap();
        let Some(presence) = inner.presence.get(&target.id) else {
            return Err(ApiError::unavailable("the target device is offline"));
        };
        let (offers, grant_offers) = (presence.offers.clone(), presence.grant_offers);
        let grant_token = secret("agrl_grant");
        let grant_key = digest(&grant_token);
        let grant = ConnectionGrant {
            id: uuid::Uuid::new_v4().to_string(),
            caller,
            source: source.clone(),
            target: target.clone(),
            expires_at_ms: now_ms() + GRANT_LIFETIME_MS,
            session_controller: None,
            project_controller: None,
        };
        let link_id = uuid::Uuid::new_v4().to_string();
        let controller_ticket = secret("agrl_ticket");
        let executor_ticket = secret("agrl_ticket");
        let expires = Instant::now() + TICKET_LIFETIME;
        for (ticket, role, device) in [
            (&controller_ticket, Role::Controller, &source),
            (&executor_ticket, Role::Executor, &target),
        ] {
            inner.tickets.insert(
                digest(ticket),
                Ticket {
                    link_id: link_id.clone(),
                    role,
                    device_id: device.id.clone(),
                    expires,
                },
            );
        }
        inner.links.insert(
            link_id.clone(),
            Link {
                grant: grant_key.clone(),
                created: Instant::now(),
                waiting: None,
                paired: false,
            },
        );
        inner.grants.insert(grant_key.clone(), grant.clone());
        let offer = PresenceEvent::Offer {
            link_id: link_id.clone(),
            source_id: source.id.clone(),
            ticket: Secret::new(executor_ticket.clone()),
            grant_token: Secret::new(grant_token.clone()),
            grant: grant_offers.then(|| Box::new(grant.clone())),
        };
        if offers.try_send(offer).is_err() {
            inner.links.remove(&link_id);
            inner.grants.remove(&grant_key);
            inner.tickets.remove(&digest(&controller_ticket));
            inner.tickets.remove(&digest(&executor_ticket));
            return Err(ApiError::unavailable(
                "the target device is busy; retry shortly",
            ));
        }
        Ok(DialedConnection {
            connection: GrantedConnection {
                grant,
                token: Secret::new(grant_token),
            },
            link_id,
            ticket: Secret::new(controller_ticket),
        })
    }

    /// An executor may read only grants addressed to its current credential.
    pub fn grant_for(&self, executor: &Device, token: &str) -> Option<ConnectionGrant> {
        let inner = self.inner.lock().unwrap();
        let grant = inner.grants.get(&digest(token))?;
        (grant.target.id == executor.id
            && grant.target.credential_epoch == executor.credential_epoch
            && grant.expires_at_ms > now_ms())
        .then(|| grant.clone())
    }

    /// Renewal keeps the grant's identity and strictly advances its expiry. A revoked or
    /// re-enrolled endpoint ends the grant; the executor then closes the connection itself.
    pub fn renew(
        &self,
        executor: &Device,
        token: &str,
        registry: &Registry,
    ) -> ApiResult<ConnectionGrant> {
        let key = digest(token);
        let rejected = || ApiError::forbidden("the connection grant is no longer valid");
        let grant = self.grant_for(executor, token).ok_or_else(rejected)?;
        if !registry.current(&grant.source) || !registry.current(&grant.target) {
            self.inner.lock().unwrap().grants.remove(&key);
            return Err(rejected());
        }
        let mut inner = self.inner.lock().unwrap();
        let grant = inner.grants.get_mut(&key).ok_or_else(rejected)?;
        grant.expires_at_ms = (now_ms() + GRANT_LIFETIME_MS).max(grant.expires_at_ms + 1);
        Ok(grant.clone())
    }

    /// Tickets are single use and bound to the device the admission named for that role.
    pub fn claim(&self, ticket: &str, device_id: &str) -> Option<Claimed> {
        let mut inner = self.inner.lock().unwrap();
        let key = digest(ticket);
        let usable = inner
            .tickets
            .get(&key)
            .is_some_and(|ticket| ticket.device_id == device_id && ticket.expires > Instant::now());
        if !usable {
            return None;
        }
        let ticket = inner.tickets.remove(&key)?;
        let grant = inner.links.get(&ticket.link_id)?.grant.clone();
        Some(Claimed {
            link_id: ticket.link_id,
            role: ticket.role,
            grant,
        })
    }

    pub fn join(&self, link_id: &str, role: Role, socket: WebSocket) -> Joined {
        let mut inner = self.inner.lock().unwrap();
        let Some(link) = inner.links.get_mut(link_id) else {
            return Joined::Gone;
        };
        match link.waiting.take() {
            Some((waiting, peer)) if waiting != role => {
                link.paired = true;
                match peer.send(socket) {
                    Ok(()) => Joined::Handed,
                    Err(_) => Joined::Gone,
                }
            }
            Some(duplicate) => {
                link.waiting = Some(duplicate);
                Joined::Gone
            }
            None => {
                let (sender, receiver) = oneshot::channel();
                link.waiting = Some((role, sender));
                Joined::First(Box::new(socket), receiver)
            }
        }
    }

    pub fn finish(&self, link_id: &str) {
        self.inner.lock().unwrap().links.remove(link_id);
    }

    /// The endpoints of a grant that has not expired.
    pub fn grant_endpoints(&self, grant: &str) -> Option<(Device, Device)> {
        let inner = self.inner.lock().unwrap();
        let grant = inner.grants.get(grant)?;
        (grant.expires_at_ms > now_ms()).then(|| (grant.source.clone(), grant.target.clone()))
    }

    pub fn forget_device(&self, device_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(presence) = inner.presence.remove(device_id) {
            presence.stop.notify_one();
        }
        inner
            .grants
            .retain(|_, grant| grant.source.id != device_id && grant.target.id != device_id);
        inner
            .tickets
            .retain(|_, ticket| ticket.device_id != device_id);
    }

    pub fn sweep(&self) {
        let now = Instant::now();
        let now_ms = now_ms();
        let mut inner = self.inner.lock().unwrap();
        inner.tickets.retain(|_, ticket| ticket.expires > now);
        inner.links.retain(|_, link| {
            link.paired || now.duration_since(link.created) < TICKET_LIFETIME + PAIRING_TIMEOUT
        });
        inner.grants.retain(|_, grant| grant.expires_at_ms > now_ms);
    }
}
