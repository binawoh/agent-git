//! Browser sessions. A session signed in with a PAT is bound to that Hub sign-in: revoking the
//! PAT ends it at the next revalidation. A session signed in with the console password is bound
//! to that password's version: changing the password ends it. A relay restart keeps both.

use crate::{
    auth::{Accounts, Refresh},
    util::{digest, now_ms, secret},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

/// Sliding lifetime; every revalidation extends it, matching the Hub's refresh window.
const LIFETIME_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How long a session is trusted between revalidations.
const REVALIDATE_MS: i64 = 10 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub account_id: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_version: Option<u64>,
    expires_at_ms: i64,
    verified_at_ms: i64,
}

impl Session {
    pub fn by_password(&self) -> bool {
        self.password_version.is_some()
    }
}

pub enum Credential {
    /// The refresh token of the Hub sign-in a PAT produced.
    Hub(String),
    /// The version of the console password that was verified.
    Password(u64),
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    sessions: HashMap<String, Session>,
}

pub struct Sessions {
    path: PathBuf,
    inner: Mutex<Stored>,
    /// Refresh tokens rotate, so two concurrent refreshes of one token would reject the second
    /// and sign the owner out; refreshes run one at a time and re-read the session first.
    refreshing: tokio::sync::Mutex<()>,
}

impl Sessions {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let mut stored: Stored = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(error.into()),
        };
        let now = now_ms();
        stored
            .sessions
            .retain(|_, session| session.expires_at_ms > now);
        Ok(Self {
            path,
            inner: Mutex::new(stored),
            refreshing: tokio::sync::Mutex::new(()),
        })
    }

    pub fn create(
        &self,
        account_id: String,
        username: String,
        credential: Credential,
    ) -> anyhow::Result<String> {
        let token = secret("agrl_console");
        let now = now_ms();
        let (refresh_token, password_version) = match credential {
            Credential::Hub(refresh_token) => (Some(refresh_token), None),
            Credential::Password(version) => (None, Some(version)),
        };
        let mut inner = self.inner.lock().unwrap();
        inner.sessions.insert(
            digest(&token),
            Session {
                account_id,
                username,
                refresh_token,
                password_version,
                expires_at_ms: now + LIFETIME_MS,
                verified_at_ms: now,
            },
        );
        self.persist(&inner)?;
        Ok(token)
    }

    pub fn remove(&self, token: &str) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if inner.sessions.remove(&digest(token)).is_some() {
            self.persist(&inner)?;
        }
        Ok(())
    }

    /// Returns the session when it is valid. `password_version` is the current password's
    /// version, if one is set. A Hub outage does not sign the owner out; a rejected refresh does.
    pub async fn authenticate(
        &self,
        accounts: &Accounts,
        password_version: Option<u64>,
        token: &str,
    ) -> Option<Session> {
        let key = digest(token);
        let session = self.current(&key)?;
        if let Some(version) = session.password_version {
            if Some(version) != password_version {
                self.forget(&key);
                return None;
            }
            return Some(self.extend(&key, session));
        }
        if now_ms() - session.verified_at_ms < REVALIDATE_MS {
            return Some(session);
        }
        let _refreshing = self.refreshing.lock().await;
        let session = self.current(&key)?;
        let now = now_ms();
        if now - session.verified_at_ms < REVALIDATE_MS {
            return Some(session);
        }
        let Some(refresh_token) = session.refresh_token.as_deref() else {
            self.forget(&key);
            return None;
        };
        match accounts.refresh(refresh_token).await {
            Refresh::Renewed(refresh_token) => {
                let mut inner = self.inner.lock().unwrap();
                let stored = inner.sessions.get_mut(&key)?;
                stored.refresh_token = Some(refresh_token);
                stored.verified_at_ms = now;
                stored.expires_at_ms = now + LIFETIME_MS;
                let session = stored.clone();
                if let Err(error) = self.persist(&inner) {
                    eprintln!("agit-remote: saving console sessions failed: {error:#}");
                }
                Some(session)
            }
            Refresh::Rejected => {
                self.forget(&key);
                None
            }
            Refresh::Unavailable => Some(session),
        }
    }

    /// Password sessions slide their lifetime at most once per revalidation interval.
    fn extend(&self, key: &str, session: Session) -> Session {
        let now = now_ms();
        if now - session.verified_at_ms < REVALIDATE_MS {
            return session;
        }
        let mut inner = self.inner.lock().unwrap();
        let Some(stored) = inner.sessions.get_mut(key) else {
            return session;
        };
        stored.verified_at_ms = now;
        stored.expires_at_ms = now + LIFETIME_MS;
        let session = stored.clone();
        if let Err(error) = self.persist(&inner) {
            eprintln!("agit-remote: saving console sessions failed: {error:#}");
        }
        session
    }

    fn forget(&self, key: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.sessions.remove(key).is_some() {
            let _ = self.persist(&inner);
        }
    }

    fn current(&self, key: &str) -> Option<Session> {
        let session = self.inner.lock().unwrap().sessions.get(key)?.clone();
        if session.expires_at_ms > now_ms() {
            return Some(session);
        }
        self.forget(key);
        None
    }

    fn persist(&self, stored: &Stored) -> anyhow::Result<()> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("session store path has no directory"))?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer(&mut file, stored)?;
        file.as_file().sync_all()?;
        file.persist(&self.path)?;
        Ok(())
    }
}
