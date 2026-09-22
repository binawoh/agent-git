use anyhow::{Context, Result, ensure};
use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub struct Config {
    pub schema: u32,
    pub owner: String,
    pub account_id: String,
    pub public_url: String,
    pub max_snapshot_mib: usize,
    pub max_upload_mib: u64,
}

#[derive(Clone)]
pub struct Repository {
    pub id: String,
    pub owner: String,
    pub name: String,
}

pub struct State {
    pub root: PathBuf,
    pub config: Config,
    pub db: Connection,
}

pub fn digest(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}

fn secret(prefix: &str) -> String {
    format!(
        "{prefix}_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

pub fn timestamp(value: i64) -> String {
    chrono::DateTime::from_timestamp(value, 0)
        .expect("bounded timestamp")
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn valid_name(name: &str) -> Result<()> {
    ensure!(
        name == name.trim() && name.len() <= 80,
        "Invalid repository or owner name"
    );
    agit::domain::repo::valid_name(name)
}

impl State {
    pub fn exclusive_lock(&self) -> Result<std::fs::File> {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("server.lock"))?;
        lock.try_lock_exclusive()
            .context("Stop the running Hub before exclusive maintenance")?;
        Ok(lock)
    }

    pub fn initialize(
        root: &Path,
        owner: String,
        public_url: String,
        max_snapshot_mib: usize,
        max_upload_mib: u64,
    ) -> Result<Self> {
        valid_name(&owner)?;
        ensure!(
            (1..=512).contains(&max_snapshot_mib),
            "Snapshot limit must be between 1 and 512 MiB"
        );
        ensure!(
            (1..=4096).contains(&max_upload_mib),
            "Upload limit must be between 1 and 4096 MiB"
        );
        let url = url::Url::parse(&public_url)?;
        ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Public URL must not contain credentials, query or fragment"
        );
        ensure!(
            url.path() == "/" || url.path().is_empty(),
            "This Hub requires a root public URL, without a path prefix"
        );
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        ensure!(
            url.scheme() == "https" || (url.scheme() == "http" && loopback),
            "Use HTTPS, or HTTP on loopback for development"
        );
        ensure!(
            !root.join("config.json").exists(),
            "Hub is already initialized"
        );
        if root.exists() {
            ensure!(
                std::fs::read_dir(root)?.next().is_none(),
                "Initialize an empty data directory"
            );
        }
        std::fs::create_dir_all(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        let config = Config {
            schema: 1,
            owner,
            account_id: Uuid::new_v4().to_string(),
            public_url: url.as_str().trim_end_matches('/').to_owned(),
            max_snapshot_mib,
            max_upload_mib,
        };
        for directory in ["repos", "lfs", "tmp"] {
            std::fs::create_dir(root.join(directory))?;
        }
        std::fs::write(
            root.join("config.json"),
            serde_json::to_vec_pretty(&config)?,
        )?;
        Self::open(root)
    }

    pub fn open(root: &Path) -> Result<Self> {
        let root = dunce::canonicalize(root).context("Initialize the Hub data directory first")?;
        let config: Config = serde_json::from_slice(&std::fs::read(root.join("config.json"))?)?;
        ensure!(config.schema == 1, "Unsupported Hub schema");
        let db = Connection::open(root.join("hub.sqlite3"))?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS pats(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY, pat_id TEXT NOT NULL REFERENCES pats(id), access_hash TEXT UNIQUE NOT NULL, refresh_hash TEXT UNIQUE NOT NULL, access_exp INTEGER NOT NULL, refresh_exp INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, origins TEXT NOT NULL, created INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, UNIQUE(owner,name));
            CREATE TABLE IF NOT EXISTS snapshots(repo_id TEXT NOT NULL, oid TEXT NOT NULL, session TEXT NOT NULL, runtime TEXT NOT NULL, saved INTEGER NOT NULL, author TEXT NOT NULL, email TEXT NOT NULL, origin TEXT, turns INTEGER NOT NULL, PRIMARY KEY(repo_id,oid));
            CREATE TABLE IF NOT EXISTS saved_refs(repo_id TEXT NOT NULL, name TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY(repo_id,name));
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL, tool TEXT, paths TEXT NOT NULL, secondhand INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshot_events(repo_id TEXT NOT NULL, oid TEXT NOT NULL, ordinal INTEGER NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), line INTEGER NOT NULL, turn INTEGER NOT NULL, PRIMARY KEY(repo_id,oid,ordinal));
            CREATE INDEX IF NOT EXISTS event_membership ON snapshot_events(event_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS event_search USING fts5(id UNINDEXED, text, tokenize='trigram');")?;
        let has_completeness: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('snapshots') WHERE name='index_complete')", [], |row|row.get(0))?;
        if !has_completeness {
            db.execute_batch(
                "ALTER TABLE snapshots ADD COLUMN index_complete INTEGER NOT NULL DEFAULT 1",
            )?;
        }
        Ok(Self { root, config, db })
    }

    pub fn issue_token(&self, label: &str) -> Result<String> {
        ensure!(
            !label.is_empty() && label.len() <= 120,
            "Token label must contain 1-120 bytes"
        );
        let token = secret("agsh_pat");
        self.db.execute(
            "INSERT INTO pats(id,hash,label) VALUES (?1,?2,?3)",
            params![Uuid::new_v4().to_string(), digest(&token), label],
        )?;
        Ok(token)
    }

    pub fn list_tokens(&self) -> Result<Value> {
        let mut statement = self
            .db
            .prepare("SELECT id,label,revoked FROM pats ORDER BY rowid")?;
        let rows = statement.query_map([], |row| Ok(json!({"id":row.get::<_,String>(0)?,"label":row.get::<_,String>(1)?,"revoked":row.get::<_,bool>(2)?})))?;
        Ok(Value::Array(rows.collect::<rusqlite::Result<Vec<_>>>()?))
    }

    pub fn revoke_token(&self, id: &str) -> Result<()> {
        ensure!(
            self.db
                .execute("UPDATE pats SET revoked=1 WHERE id=?1", [id])?
                == 1,
            "Unknown PAT identifier"
        );
        self.db
            .execute("DELETE FROM auth_sessions WHERE pat_id=?1", [id])?;
        Ok(())
    }

    pub fn account(&self) -> Value {
        json!({"account_id": self.config.account_id, "username":self.config.owner})
    }

    pub fn login(&self, pat: &str) -> Result<Option<Value>> {
        let id: Option<String> = self
            .db
            .query_row(
                "SELECT id FROM pats WHERE hash=?1 AND revoked=0",
                [digest(pat)],
                |row| row.get(0),
            )
            .optional()?;
        id.map(|id| self.new_session(&id)).transpose()
    }

    fn new_session(&self, pat: &str) -> Result<Value> {
        let access = secret("agsh_access");
        let refresh = secret("agsh_refresh");
        let now = Utc::now().timestamp();
        self.db.execute(
            "INSERT INTO auth_sessions VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                Uuid::new_v4().to_string(),
                pat,
                digest(&access),
                digest(&refresh),
                now + 3600,
                now + 30 * 86400
            ],
        )?;
        let mut result = self.account();
        result.as_object_mut().unwrap().extend(json!({"access_token":access,"refresh_token":refresh,"access_expires_at":timestamp(now+3600),"refresh_expires_at":timestamp(now+30*86400)}).as_object().unwrap().clone());
        Ok(result)
    }

    pub fn refresh(&mut self, token: &str) -> Result<Option<Value>> {
        let tx = self.db.unchecked_transaction()?;
        let row: Option<(String,String)> = tx.query_row("SELECT s.id,s.pat_id FROM auth_sessions s JOIN pats p ON p.id=s.pat_id WHERE refresh_hash=?1 AND refresh_exp>?2 AND p.revoked=0", params![digest(token),Utc::now().timestamp()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((id, pat)) = row else {
            return Ok(None);
        };
        tx.execute("DELETE FROM auth_sessions WHERE id=?1", [id])?;
        let result = self.new_session(&pat)?;
        tx.commit()?;
        Ok(Some(result))
    }

    pub fn authenticated(&self, access: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM auth_sessions s JOIN pats p ON p.id=s.pat_id WHERE access_hash=?1 AND access_exp>?2 AND p.revoked=0)",params![digest(access),Utc::now().timestamp()],|r|r.get(0))?)
    }

    pub fn logout(&self, access: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM auth_sessions WHERE access_hash=?1",
            [digest(access)],
        )?;
        Ok(())
    }

    pub fn repository(&self, owner: &str, name: &str) -> Result<Option<Repository>> {
        Ok(self
            .db
            .query_row(
                "SELECT id,owner,name FROM repositories WHERE owner=?1 AND name=?2",
                params![owner, name],
                |row| {
                    Ok(Repository {
                        id: row.get(0)?,
                        owner: row.get(1)?,
                        name: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn repositories(&self) -> Result<Vec<Repository>> {
        let mut statement = self
            .db
            .prepare("SELECT id,owner,name FROM repositories ORDER BY name")?;
        Ok(statement
            .query_map([], |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    owner: row.get(1)?,
                    name: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn repo_path(&self, repo: &Repository) -> PathBuf {
        self.root.join("repos").join(format!("{}.git", repo.id))
    }

    pub fn repo_json(&self, repo: &Repository) -> Result<Value> {
        let count: i64 = self.db.query_row(
            "SELECT count(DISTINCT session) FROM snapshots WHERE repo_id=?1",
            [&repo.id],
            |row| row.get(0),
        )?;
        Ok(
            json!({"agent_id":repo.id,"owner":repo.owner,"name":repo.name,"visibility":"private","session_count":count,"clone_url":format!("{}/{}/{}.git",self.config.public_url,repo.owner,repo.name)}),
        )
    }

    pub fn create_repo(&self, name: &str, origins: &Value) -> Result<Repository> {
        valid_name(name)?;
        let origins = origins
            .as_array()
            .context("repo_origins must be an array")?;
        ensure!(
            origins.len() <= 64
                && origins
                    .iter()
                    .all(|v| v.as_str().is_some_and(|s| s.len() <= 4096)),
            "Invalid repo origins"
        );
        ensure!(
            self.repository(&self.config.owner, name)?.is_none(),
            "Repository already exists"
        );
        let repo = Repository {
            id: Uuid::new_v4().to_string(),
            owner: self.config.owner.clone(),
            name: name.to_owned(),
        };
        crate::git::initialize(self, &repo)?;
        self.db.execute(
            "INSERT INTO repositories(id,owner,name,origins,created) VALUES (?1,?2,?3,?4,?5)",
            params![
                repo.id,
                repo.owner,
                repo.name,
                serde_json::to_string(origins)?,
                Utc::now().timestamp()
            ],
        )?;
        Ok(repo)
    }
}
