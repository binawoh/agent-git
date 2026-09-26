//! The owner's console password: an Argon2id hash, never the password itself. Its version
//! advances on every change, and a session stays valid only while the version it signed in
//! with is the current one.

use crate::util::now_ms;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};

pub const MIN_LENGTH: usize = 10;
const MAX_LENGTH: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    account_id: String,
    username: String,
    hash: String,
    version: u64,
    updated_at_ms: i64,
}

pub struct Owner {
    pub account_id: String,
    pub username: String,
    pub version: u64,
}

pub struct Password {
    path: PathBuf,
    stored: Mutex<Option<Stored>>,
}

impl Password {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let stored = match std::fs::read(&path) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            path,
            stored: Mutex::new(stored),
        })
    }

    pub fn is_set(&self) -> bool {
        self.stored.lock().unwrap().is_some()
    }

    pub fn version(&self) -> Option<u64> {
        self.stored
            .lock()
            .unwrap()
            .as_ref()
            .map(|stored| stored.version)
    }

    /// Argon2 is deliberately slow; callers run this off the async executor.
    pub fn verify(&self, candidate: &str) -> Option<Owner> {
        let stored = self.stored.lock().unwrap().clone()?;
        let hash = PasswordHash::new(&stored.hash).ok()?;
        Argon2::default()
            .verify_password(candidate.as_bytes(), &hash)
            .ok()?;
        Some(Owner {
            account_id: stored.account_id,
            username: stored.username,
            version: stored.version,
        })
    }

    pub fn validate(candidate: &str) -> Result<(), String> {
        let length = candidate.chars().count();
        if length < MIN_LENGTH {
            return Err(format!(
                "the password needs at least {MIN_LENGTH} characters"
            ));
        }
        if length > MAX_LENGTH || candidate.chars().any(char::is_control) {
            return Err("the password is too long or contains control characters".into());
        }
        Ok(())
    }

    /// Replaces the password and returns its new version.
    pub fn set(&self, account_id: &str, username: &str, password: &str) -> anyhow::Result<u64> {
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).map_err(|error| anyhow::anyhow!("randomness: {error}"))?;
        let salt = SaltString::encode_b64(&salt).map_err(|error| anyhow::anyhow!("{error}"))?;
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|error| anyhow::anyhow!("hashing the password: {error}"))?
            .to_string();
        let mut stored = self.stored.lock().unwrap();
        let next = Stored {
            account_id: account_id.to_owned(),
            username: username.to_owned(),
            hash,
            version: stored.as_ref().map_or(1, |current| current.version + 1),
            updated_at_ms: now_ms(),
        };
        let directory = self
            .path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("password path has no directory"))?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer(&mut file, &next)?;
        file.as_file().sync_all()?;
        file.persist(&self.path)?;
        let version = next.version;
        *stored = Some(next);
        Ok(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A changed password must reject the old one and advance the version that older
    /// sessions are checked against; the hash must survive a restart.
    #[test]
    fn changing_the_password_rejects_the_old_one_and_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("console-password.json");
        let password = Password::open(path.clone()).unwrap();
        assert!(!password.is_set());
        assert_eq!(
            password.set("account", "owner", "first password").unwrap(),
            1
        );
        assert_eq!(
            password.set("account", "owner", "second password").unwrap(),
            2
        );
        assert!(password.verify("first password").is_none());
        let reopened = Password::open(path).unwrap();
        let owner = reopened.verify("second password").unwrap();
        assert_eq!((owner.account_id.as_str(), owner.version), ("account", 2));
        assert!(
            !std::fs::read_to_string(directory.path().join("console-password.json"))
                .unwrap()
                .contains("second password")
        );
        assert!(Password::validate("short").is_err());
    }
}
