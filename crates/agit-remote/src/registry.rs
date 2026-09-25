//! Enrolled executors persist across restarts; controller identities live only as long as their lease.

use crate::{
    error::{ApiError, ApiResult},
    util::{digest, now_ms, secret},
};
use agit_peer::{
    PeerCertificate,
    access::Principal,
    cloud::{Device, DeviceCredential, Enrollment, Secret},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

/// A controller that stops renewing loses its identity; the lease outlasts several of the
/// host's renewal intervals, so one delayed renewal does not revoke it.
pub const CONTROLLER_LEASE: Duration = Duration::from_secs(90);
const PAGE_SIZE: usize = 100;
const MAX_DEVICES_PER_ACCOUNT: usize = 64;
const MAX_NAME_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Registered through `/api/peer/devices`: an executor, or a CLI controller sharing its home.
    Device,
    /// Registered through `/api/peer/controllers`: never a connection target, never listed.
    Controller,
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    kind: Kind,
    account_id: String,
    machine_id: String,
    display_name: String,
    certificate: PeerCertificate,
    credential_epoch: u64,
    token_digest: String,
    created_at_ms: i64,
    /// `None` never expires; controllers carry the deadline of their current lease.
    #[serde(skip)]
    lease: Option<Instant>,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    devices: Vec<Record>,
}

#[derive(Default)]
struct Inner {
    records: BTreeMap<String, Record>,
    tokens: HashMap<String, String>,
}

pub struct Authenticated {
    pub device: Device,
    pub kind: Kind,
}

pub struct Registry {
    issuer: String,
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl Registry {
    pub fn open(path: PathBuf, issuer: String) -> anyhow::Result<Self> {
        let stored: Stored = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(error.into()),
        };
        let mut inner = Inner::default();
        for record in stored.devices {
            anyhow::ensure!(record.kind == Kind::Device, "only devices are persisted");
            inner
                .tokens
                .insert(record.token_digest.clone(), record.id.clone());
            inner.records.insert(record.id.clone(), record);
        }
        Ok(Self {
            issuer,
            path,
            inner: Mutex::new(inner),
        })
    }

    fn device(&self, record: &Record) -> Device {
        Device {
            id: record.id.clone(),
            owner: Principal {
                issuer: self.issuer.clone(),
                account_id: record.account_id.clone(),
            },
            machine_id: record.machine_id.clone(),
            display_name: record.display_name.clone(),
            certificate: record.certificate.clone(),
            credential_epoch: record.credential_epoch,
        }
    }

    /// Re-enrolling a machine keeps its device id, rotates its token and certificate, and
    /// advances its credential epoch so that grants naming the old credential stop matching.
    pub fn enroll(
        &self,
        owner: &Principal,
        enrollment: Enrollment,
        kind: Kind,
        lease: Option<Duration>,
    ) -> ApiResult<DeviceCredential> {
        if owner.issuer != self.issuer {
            return Err(ApiError::forbidden("enrollment for another issuer"));
        }
        let valid_text = |value: &str, allow_empty: bool| {
            (allow_empty || !value.is_empty())
                && value.len() <= MAX_NAME_BYTES
                && !value.chars().any(char::is_control)
        };
        if !valid_text(&enrollment.machine_id, false) || !valid_text(&enrollment.display_name, true)
        {
            return Err(ApiError::bad_request("invalid machine_id or display_name"));
        }
        let certificate = PeerCertificate::from_der(enrollment.certificate.as_der().to_vec())
            .map_err(|_| ApiError::bad_request("invalid peer certificate"))?;
        let token = secret("agrl_device");
        let mut inner = self.inner.lock().unwrap();
        let existing = (kind == Kind::Device)
            .then(|| {
                inner.records.values().find(|record| {
                    record.kind == Kind::Device
                        && record.account_id == owner.account_id
                        && record.machine_id == enrollment.machine_id
                })
            })
            .flatten()
            .map(|record| {
                (
                    record.id.clone(),
                    record.credential_epoch,
                    record.token_digest.clone(),
                )
            });
        let (id, credential_epoch) = match existing {
            Some((id, epoch, old_token)) => {
                inner.tokens.remove(&old_token);
                (id, epoch + 1)
            }
            None => {
                let owned = inner
                    .records
                    .values()
                    .filter(|record| record.account_id == owner.account_id)
                    .count();
                if owned >= MAX_DEVICES_PER_ACCOUNT {
                    return Err(ApiError::forbidden(
                        "device quota exceeded; revoke a device first",
                    ));
                }
                (uuid::Uuid::new_v4().to_string(), 1)
            }
        };
        let record = Record {
            id: id.clone(),
            kind,
            account_id: owner.account_id.clone(),
            machine_id: enrollment.machine_id,
            display_name: enrollment.display_name,
            certificate,
            credential_epoch,
            token_digest: digest(&token),
            created_at_ms: now_ms(),
            lease: lease.map(|lease| Instant::now() + lease),
        };
        inner.tokens.insert(record.token_digest.clone(), id.clone());
        let device = self.device(&record);
        inner.records.insert(id, record);
        if kind == Kind::Device {
            self.persist(&inner)?;
        }
        Ok(DeviceCredential {
            device,
            token: Secret::new(token),
        })
    }

    pub fn authenticate(&self, token: &str) -> Option<Authenticated> {
        let inner = self.inner.lock().unwrap();
        let record = inner.records.get(inner.tokens.get(&digest(token))?)?;
        live(record).then(|| Authenticated {
            device: self.device(record),
            kind: record.kind,
        })
    }

    pub fn owned(&self, owner: &Principal, id: &str) -> Option<(Device, Kind)> {
        let inner = self.inner.lock().unwrap();
        let record = inner.records.get(id)?;
        (live(record) && owner.issuer == self.issuer && record.account_id == owner.account_id)
            .then(|| (self.device(record), record.kind))
    }

    /// True while the device exists with this exact credential.
    pub fn current(&self, device: &Device) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.records.get(&device.id).is_some_and(|record| {
            live(record)
                && record.credential_epoch == device.credential_epoch
                && record.certificate == device.certificate
        })
    }

    /// Pages are ordered by id, so each cursor is strictly greater than the one before it.
    pub fn page(&self, owner: &Principal, after: Option<&str>) -> (Vec<Device>, Option<String>) {
        let inner = self.inner.lock().unwrap();
        let mut devices = inner
            .records
            .values()
            .filter(|record| {
                record.kind == Kind::Device
                    && record.account_id == owner.account_id
                    && after.is_none_or(|after| record.id.as_str() > after)
            })
            .map(|record| self.device(record));
        let page: Vec<_> = devices.by_ref().take(PAGE_SIZE).collect();
        let next = devices
            .next()
            .and_then(|_| page.last().map(|device| device.id.clone()));
        (page, next)
    }

    pub fn revoke(&self, owner: &Principal, id: &str) -> ApiResult<bool> {
        let mut inner = self.inner.lock().unwrap();
        let Some(record) = inner.records.get(id) else {
            return Ok(false);
        };
        if record.account_id != owner.account_id {
            return Ok(false);
        }
        let record = inner.records.remove(id).unwrap();
        inner.tokens.remove(&record.token_digest);
        if record.kind == Kind::Device {
            self.persist(&inner)?;
        }
        Ok(true)
    }

    pub fn renew(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        match inner.records.get_mut(id) {
            Some(record) if live(record) => {
                if record.lease.is_some() {
                    record.lease = Some(Instant::now() + CONTROLLER_LEASE);
                }
                true
            }
            _ => false,
        }
    }

    pub fn sweep(&self) {
        let mut inner = self.inner.lock().unwrap();
        let expired: Vec<_> = inner
            .records
            .values()
            .filter(|record| !live(record))
            .map(|record| (record.id.clone(), record.token_digest.clone()))
            .collect();
        for (id, token) in expired {
            inner.records.remove(&id);
            inner.tokens.remove(&token);
        }
    }

    fn persist(&self, inner: &Inner) -> anyhow::Result<()> {
        let stored = Stored {
            devices: inner
                .records
                .values()
                .filter(|record| record.kind == Kind::Device)
                .cloned()
                .collect(),
        };
        let directory = self
            .path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("device registry path has no directory"))?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut file, &stored)?;
        file.as_file().sync_all()?;
        file.persist(&self.path)?;
        Ok(())
    }
}

fn live(record: &Record) -> bool {
    record
        .lease
        .is_none_or(|deadline| Instant::now() < deadline)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enrollment(machine: &str) -> Enrollment {
        Enrollment {
            machine_id: machine.into(),
            display_name: "Machine".into(),
            certificate: agit_peer::Identity::generate()
                .unwrap()
                .certificate()
                .clone(),
        }
    }

    /// Re-enrollment must keep the id (saved controller configuration names it) while making
    /// the previous token and epoch stale; a regenerated id would orphan every saved route.
    #[test]
    fn reenrollment_rotates_credentials_under_the_same_id_and_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("devices.json");
        let issuer = "https://hub.example".to_owned();
        let owner = Principal {
            issuer: issuer.clone(),
            account_id: "owner".into(),
        };
        let registry = Registry::open(path.clone(), issuer.clone()).unwrap();
        let first = registry
            .enroll(&owner, enrollment("machine"), Kind::Device, None)
            .unwrap();
        let second = registry
            .enroll(&owner, enrollment("machine"), Kind::Device, None)
            .unwrap();
        assert_eq!(first.device.id, second.device.id);
        assert_eq!(second.device.credential_epoch, 2);
        assert!(registry.authenticate(first.token.expose()).is_none());
        assert!(!registry.current(&first.device));

        let reopened = Registry::open(path, issuer).unwrap();
        let authenticated = reopened.authenticate(second.token.expose()).unwrap();
        assert_eq!(authenticated.device.credential_epoch, 2);
        assert!(reopened.current(&second.device));
        let (page, next) = reopened.page(&owner, None);
        assert_eq!(page.len(), 1);
        assert!(next.is_none());
    }

    #[test]
    fn controllers_are_not_listed_and_expire_without_renewal() {
        let directory = tempfile::tempdir().unwrap();
        let issuer = "https://hub.example".to_owned();
        let owner = Principal {
            issuer: issuer.clone(),
            account_id: "owner".into(),
        };
        let registry = Registry::open(directory.path().join("devices.json"), issuer).unwrap();
        let controller = registry
            .enroll(
                &owner,
                enrollment("web"),
                Kind::Controller,
                Some(Duration::ZERO),
            )
            .unwrap();
        assert!(registry.page(&owner, None).0.is_empty());
        assert!(registry.authenticate(controller.token.expose()).is_none());
        registry.sweep();
        assert!(!registry.renew(&controller.device.id));
    }
}
