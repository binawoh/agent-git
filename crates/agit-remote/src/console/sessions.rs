//! Browser sessions are bound to a Hub sign-in: revoking the PAT behind it ends the session
//! at the next revalidation, and a relay restart keeps the owner signed in.

use crate::{
    auth::{Accounts, Refresh},
    util::{digest, now_ms, secret},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

/// Sliding lifetime; every successful revalidation extends it, matching the Hub's refresh window.
const LIFETIME_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// How long a session is trusted between checks with the Hub.
const REVALIDATE_MS: i64 = 10 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub account_id: String,
    pub username: String,
    refresh_token: String,
    expires_at_ms: i64,
    verified_at_ms: i64,
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
        refresh_token: String,
    ) -> anyhow::Result<String> {
        let token = secret("agrl_console");
        let now = now_ms();
        let mut inner = self.inner.lock().unwrap();
        inner.sessions.insert(
            digest(&token),
            Session {
                account_id,
                username,
                refresh_token,
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

    /// Returns the session when it is valid. A Hub outage does not sign the owner out; a
    /// rejected refresh does.
    pub async fn authenticate(&self, accounts: &Accounts, token: &str) -> Option<Session> {
        let key = digest(token);
        let session = self.current(&key)?;
        if now_ms() - session.verified_at_ms < REVALIDATE_MS {
            return Some(session);
        }
        let _refreshing = self.refreshing.lock().await;
        let session = self.current(&key)?;
        let now = now_ms();
        if now - session.verified_at_ms < REVALIDATE_MS {
            return Some(session);
        }
        match accounts.refresh(&session.refresh_token).await {
            Refresh::Renewed(refresh_token) => {
                let mut inner = self.inner.lock().unwrap();
                let stored = inner.sessions.get_mut(&key)?;
                stored.refresh_token = refresh_token;
                stored.verified_at_ms = now;
                stored.expires_at_ms = now + LIFETIME_MS;
                let session = stored.clone();
                if let Err(error) = self.persist(&inner) {
                    eprintln!("agit-remote: saving console sessions failed: {error:#}");
                }
                Some(session)
            }
            Refresh::Rejected => {
                let mut inner = self.inner.lock().unwrap();
                inner.sessions.remove(&key);
                let _ = self.persist(&inner);
                None
            }
            Refresh::Unavailable => Some(session),
        }
    }

    fn current(&self, key: &str) -> Option<Session> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.sessions.get(key)?.clone();
        if session.expires_at_ms > now_ms() {
            return Some(session);
        }
        inner.sessions.remove(key);
        let _ = self.persist(&inner);
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
