use crate::{
    git, index,
    state::{Repository, State},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::process::Stdio;
use tiny_http::{Header, Request, Response, Server, StatusCode};

#[derive(Debug)]
struct ApiError(u16, String);
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.1.fmt(f)
    }
}
impl std::error::Error for ApiError {}
fn error(status: u16, message: impl Into<String>) -> anyhow::Error {
    ApiError(status, message.into()).into()
}

struct Reply {
    status: u16,
    headers: Vec<Header>,
    body: Box<dyn Read + Send>,
    length: usize,
}
impl Reply {
    fn json(status: u16, value: Value) -> Self {
        let bytes = serde_json::to_vec(&value).expect("serializable JSON");
        Self {
            status,
            length: bytes.len(),
            body: Box::new(Cursor::new(bytes)),
            headers: vec![
                header("Content-Type", "application/json; charset=utf-8"),
                header("Cache-Control", "no-store"),
            ],
        }
    }
    fn file(file: File) -> Result<Self> {
        let length = usize::try_from(file.metadata()?.len())?;
        Ok(Self {
            status: 200,
            headers: vec![
                header("Content-Type", "application/octet-stream"),
                header("Cache-Control", "no-store"),
            ],
            body: Box::new(file),
            length,
        })
    }
    fn response(self) -> Response<Box<dyn Read + Send>> {
        Response::new(
            StatusCode(self.status),
            self.headers,
            self.body,
            Some(self.length),
            None,
        )
    }
}
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid fixed HTTP header")
}
fn request_header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_owned())
}
fn json_body(request: &mut Request) -> Result<Value> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take(64 * 1024 + 1)
        .read_to_end(&mut body)?;
    if body.len() > 64 * 1024 {
        return Err(error(413, "JSON request exceeds limit"));
    }
    serde_json::from_slice(&body).map_err(|_| error(400, "Invalid JSON body"))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error(400, format!("Missing {key}")))
}

pub fn serve(state: &mut State, listen: &str) -> Result<()> {
    let _lock = state.exclusive_lock()?;
    let server = Server::http(listen).map_err(|e| anyhow::anyhow!("Cannot listen: {e}"))?;
    eprintln!("agit-selfhost listening on {}", server.server_addr());
    for mut request in server.incoming_requests() {
        let response = match handle(state, &mut request) {
            Ok(reply) => reply,
            Err(failure) => {
                let status = failure
                    .downcast_ref::<ApiError>()
                    .map(|e| e.0)
                    .unwrap_or(500);
                if status == 500 {
                    eprintln!("Request failed: {failure:#}");
                }
                let message = if status == 500 {
                    "Internal Hub error; see server diagnostics".to_owned()
                } else {
                    failure.to_string()
                };
                Reply::json(
                    status,
                    json!({"error":message,"kind":match status {401=>"unauthorized",403=>"forbidden",404=>"not_found",409=>"conflict",412=>"agent_identity_mismatch",428=>"agent_identity_required",413=>"payload_too_large",_=>"request_failed"}}),
                )
            }
        };
        if let Err(error) = request.respond(response.response()) {
            eprintln!("Response interrupted: {error}");
        }
    }
    Ok(())
}

fn handle(state: &mut State, request: &mut Request) -> Result<Reply> {
    if request.url().len() > 8192 {
        return Err(error(414, "Request URL is too long"));
    }
    let url = url::Url::parse(&format!("http://localhost{}", request.url()))
        .map_err(|_| error(400, "Invalid request URL"))?;
    let path = url.path();
    let method = request.method().as_str().to_owned();
    let params: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    if path == "/api/health" && method == "GET" {
        return Ok(Reply::json(
            200,
            json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"selfhost":true}),
        ));
    }
    if path == "/api/auth/login" && method == "POST" {
        let body = json_body(request)?;
        let login = state
            .login(string(&body, "token")?)?
            .ok_or_else(|| error(401, "Invalid or revoked PAT"))?;
        return Ok(Reply::json(200, login));
    }
    if path == "/api/auth/refresh" && method == "POST" {
        let body = json_body(request)?;
        let refreshed = state
            .refresh(string(&body, "refresh_token")?)?
            .ok_or_else(|| error(401, "Invalid or expired refresh token"))?;
        return Ok(Reply::json(200, refreshed));
    }
    let authorization = request_header(request, "Authorization").unwrap_or_default();
    let access = authorization
        .strip_prefix("Bearer ")
        .ok_or_else(|| error(401, "Bearer authentication required"))?;
    if !state.authenticated(access)? {
        return Err(error(401, "Invalid or expired access token"));
    }
    if path == "/api/auth/me" && method == "GET" {
        return Ok(Reply::json(200, state.account()));
    }
    if path == "/api/auth/logout" && method == "POST" {
        state.logout(access)?;
        return Ok(Reply::json(200, json!({})));
    }
    if path == "/api/search/sessions" && method == "GET" {
        return Ok(Reply::json(
            200,
            index::search(state, &params).map_err(|e| error(422, e.to_string()))?,
        ));
    }
    if path == "/api/agents" && method == "POST" {
        let body = json_body(request)?;
        if body.get("public").is_some_and(|v| v != &Value::Bool(false)) {
            return Err(error(403, "Only private repositories are supported"));
        }
        if body
            .get("owner")
            .and_then(Value::as_str)
            .is_some_and(|o| o != state.config.owner)
        {
            return Err(error(403, "Only the configured owner is supported"));
        }
        let name = string(&body, "name")?;
        crate::state::valid_name(name).map_err(|e| error(400, e.to_string()))?;
        if state.repository(&state.config.owner, name)?.is_some() {
            return Err(error(409, "Repository already exists"));
        }
        let repo = state.create_repo(name, body.get("repo_origins").unwrap_or(&json!([])))?;
        return Ok(Reply::json(
            201,
            json!({"agent_id":repo.id,"owner":repo.owner,"name":repo.name,"push_url":format!("{}/{}/{}.git",state.config.public_url,repo.owner,repo.name),"web_url":format!("{}/api/agents/{}/{}",state.config.public_url,repo.owner,repo.name)}),
        ));
    }
    if (path == "/api/agents" || path == "/api/agents/for-repo") && method == "GET" {
        let mut results = Vec::new();
        for repo in state.repositories()? {
            if params.get("owner").is_some_and(|o| o != &repo.owner) {
                continue;
            }
            if path.ends_with("/for-repo") {
                let origin = params
                    .get("origin")
                    .ok_or_else(|| error(400, "Missing origin"))?;
                let origins: String = state.db.query_row(
                    "SELECT origins FROM repositories WHERE id=?1",
                    [&repo.id],
                    |r| r.get(0),
                )?;
                if !serde_json::from_str::<Vec<String>>(&origins)?.contains(origin) {
                    continue;
                }
            }
            results.push(state.repo_json(&repo)?);
        }
        return Ok(Reply::json(200, json!(results)));
    }
    let segments: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if segments.len() >= 4 && segments[..2] == ["api", "agents"] {
        let repo = state
            .repository(segments[2], segments[3])?
            .ok_or_else(|| error(404, "Repository not found"))?;
        if segments.len() == 4 && method == "GET" {
            return Ok(Reply::json(200, state.repo_json(&repo)?));
        }
        if segments.len() == 5 && segments[4] == "refs" && method == "GET" {
            let refs = git::output(
                &state.repo_path(&repo),
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                    "refs/tags",
                ],
            )?;
            let refs: Vec<_> = refs
                .lines()
                .filter_map(|line| line.split_once(' '))
                .map(|(name, oid)| json!({"name":name,"commit":oid}))
                .collect();
            return Ok(Reply::json(200, json!({"items":refs})));
        }
        if segments.len() == 6 && segments[4] == "sessions" && method == "GET" {
            return Ok(Reply::json(
                200,
                index::read_remote(state, &repo, segments[5], &params)
                    .map_err(|e| error(422, e.to_string()))?,
            ));
        }
        return Err(error(404, "Unsupported repository operation"));
    }
    if segments.len() >= 3 && segments[1].ends_with(".git") {
        let name = segments[1].strip_suffix(".git").unwrap();
        let repo = state
            .repository(segments[0], name)?
            .ok_or_else(|| error(404, "Repository not found"))?;
        let expected = request_header(request, "X-AgentGit-Expected-Agent-Id")
            .ok_or_else(|| error(428, "Expected repository identity required"))?;
        if expected != repo.id {
            return Err(error(412, "Repository identity mismatch"));
        }
        let suffix = segments[2..].join("/");
        if suffix.starts_with("info/lfs/") {
            return lfs(state, &repo, &suffix, request, access);
        }
        if !matches!(
            (method.as_str(), suffix.as_str()),
            ("GET", "info/refs") | ("POST", "git-upload-pack") | ("POST", "git-receive-pack")
        ) {
            return Err(error(404, "Unsupported Git operation"));
        }
        if method == "GET"
            && !params
                .get("service")
                .is_some_and(|v| v == "git-upload-pack" || v == "git-receive-pack")
        {
            return Err(error(400, "Smart HTTP service required"));
        }
        return smart_http(state, &repo, &suffix, url.query().unwrap_or(""), request);
    }
    Err(error(404, "Unsupported operation"))
}

fn valid_oid(oid: &str) -> bool {
    oid.len() == 64
        && oid
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn lfs(
    state: &State,
    repo: &Repository,
    path: &str,
    request: &mut Request,
    access: &str,
) -> Result<Reply> {
    let method = request.method().as_str().to_owned();
    let root = state.root.join("lfs").join(&repo.id);
    std::fs::create_dir_all(&root)?;
    if path == "info/lfs/locks/verify" {
        return Ok(Reply::json(
            404,
            json!({"message":"locking is not supported"}),
        ));
    }
    if path == "info/lfs/objects/batch" && method == "POST" {
        let body = json_body(request)?;
        let operation = string(&body, "operation")?;
        if !["upload", "download"].contains(&operation) {
            return Err(error(422, "Unsupported LFS operation"));
        }
        let objects = body
            .get("objects")
            .and_then(Value::as_array)
            .ok_or_else(|| error(400, "Missing LFS objects"))?;
        if objects.len() > 1000 {
            return Err(error(413, "Too many LFS objects"));
        }
        let mut results = Vec::new();
        for item in objects {
            let oid = string(item, "oid")?;
            let size = item
                .get("size")
                .and_then(Value::as_u64)
                .ok_or_else(|| error(400, "Invalid LFS size"))?;
            if !valid_oid(oid) || size > state.config.max_upload_mib * 1024 * 1024 {
                return Err(error(413, "Invalid or oversized LFS object"));
            }
            let object = root.join(oid);
            let exists = object
                .metadata()
                .is_ok_and(|m| m.is_file() && m.len() == size);
            let href = format!(
                "{}/{}/{}.git/info/lfs/objects/{oid}",
                state.config.public_url, repo.owner, repo.name
            );
            let headers = json!({"Authorization":format!("Bearer {access}"),"X-AgentGit-Expected-Agent-Id":repo.id});
            let result = if operation == "download" {
                if exists {
                    json!({"oid":oid,"size":size,"authenticated":true,"actions":{"download":{"href":href,"header":headers}}})
                } else {
                    json!({"oid":oid,"size":size,"error":{"code":404,"message":"LFS object is missing"}})
                }
            } else if exists {
                json!({"oid":oid,"size":size})
            } else {
                json!({"oid":oid,"size":size,"authenticated":true,"actions":{"upload":{"href":href,"header":headers},"verify":{"href":format!("{href}/verify"),"header":headers}}})
            };
            results.push(result);
        }
        return Ok(Reply::json(
            200,
            json!({"transfer":"basic","hash_algo":"sha256","objects":results}),
        ));
    }
    let suffix = path
        .strip_prefix("info/lfs/objects/")
        .ok_or_else(|| error(404, "Unsupported LFS route"))?;
    let oid = suffix.strip_suffix("/verify").unwrap_or(suffix);
    if !valid_oid(oid) {
        return Err(error(400, "Invalid LFS object id"));
    }
    let object = root.join(oid);
    if suffix.ends_with("/verify") && method == "POST" {
        let body = json_body(request)?;
        let size = body
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| error(400, "Missing object size"))?;
        if body.get("oid").and_then(Value::as_str) != Some(oid)
            || !object.metadata().is_ok_and(|m| m.len() == size)
        {
            return Err(error(422, "LFS verification failed"));
        }
        return Ok(Reply::json(200, json!({})));
    }
    if suffix == oid && method == "GET" {
        return Reply::file(File::open(object).map_err(|_| error(404, "LFS object not found"))?);
    }
    if suffix == oid && method == "PUT" {
        let mut temporary = tempfile::NamedTempFile::new_in(&root)?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = request.as_reader().read(&mut buffer)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > state.config.max_upload_mib * 1024 * 1024 {
                return Err(error(413, "LFS object exceeds upload limit"));
            }
            hash.update(&buffer[..n]);
            temporary.write_all(&buffer[..n])?;
        }
        if hex::encode(hash.finalize()) != oid {
            return Err(error(422, "LFS SHA-256 mismatch"));
        }
        temporary.as_file().sync_all()?;
        if !object.exists() {
            temporary.persist_noclobber(object)?;
        }
        return Ok(Reply::json(200, json!({})));
    }
    Err(error(405, "Unsupported LFS method"))
}

fn smart_http(
    state: &mut State,
    repo: &Repository,
    suffix: &str,
    query: &str,
    request: &mut Request,
) -> Result<Reply> {
    let method = request.method().as_str().to_owned();
    if suffix == "git-receive-pack"
        && request_header(request, "Content-Encoding").is_some_and(|v| v != "identity")
    {
        return Err(error(
            415,
            "Compressed receive-pack requests are unsupported",
        ));
    }
    let mut input = tempfile::NamedTempFile::new_in(state.root.join("tmp"))?;
    let limit = state.config.max_upload_mib * 1024 * 1024;
    let copied = std::io::copy(&mut request.as_reader().take(limit + 1), &mut input)?;
    if copied > limit {
        return Err(error(413, "Git request exceeds upload limit"));
    }
    input.seek(SeekFrom::Start(0))?;
    let output = tempfile::NamedTempFile::new_in(state.root.join("tmp"))?;
    let receives = suffix == "git-receive-pack";
    if receives {
        git::validate_push_commands(&mut input).map_err(|e| error(422, e.to_string()))?;
        input.seek(SeekFrom::Start(0))?;
    }
    if receives {
        state
            .db
            .execute("UPDATE repositories SET dirty=1 WHERE id=?1", [&repo.id])?;
    }
    let mut command = git::command(&state.root);
    command
        .arg("http-backend")
        .env("GIT_PROJECT_ROOT", state.root.join("repos"))
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", format!("/{}.git/{suffix}", repo.id))
        .env("QUERY_STRING", query)
        .env("REQUEST_METHOD", &method)
        .env(
            "CONTENT_TYPE",
            request_header(request, "Content-Type").unwrap_or_default(),
        )
        .env("CONTENT_LENGTH", copied.to_string())
        .env("REMOTE_USER", &state.config.owner)
        .env(
            "GIT_PROTOCOL",
            request_header(request, "Git-Protocol").unwrap_or_default(),
        )
        .env(
            "HTTP_CONTENT_ENCODING",
            request_header(request, "Content-Encoding").unwrap_or_default(),
        )
        .stdin(input.reopen()?)
        .stdout(output.reopen()?)
        .stderr(Stdio::piped());
    let result = command.output()?;
    if !result.status.success() {
        return Err(anyhow::anyhow!(
            "Git HTTP backend failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    if receives && let Err(error) = index::reindex(state, repo) {
        eprintln!("Index pending for {}: {error:#}", repo.id);
    }
    let mut file = output.into_file();
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(file);
    let mut headers = Vec::new();
    let mut status = 200;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line)?;
        header_bytes += count;
        if count == 0 || header_bytes > 16384 {
            return Err(anyhow::anyhow!("Invalid Git CGI headers"));
        }
        if line.trim_end().is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').context("Malformed Git CGI header")?;
        if name.eq_ignore_ascii_case("Status") {
            status = value.trim().split(' ').next().unwrap_or("500").parse()?;
        } else {
            headers.push(
                Header::from_bytes(name, value.trim())
                    .map_err(|_| anyhow::anyhow!("Invalid CGI header"))?,
            );
        }
    }
    let offset = reader.stream_position()?;
    let mut file = reader.into_inner();
    file.seek(SeekFrom::Start(offset))?;
    let length = usize::try_from(file.metadata()?.len() - offset)?;
    Ok(Reply {
        status,
        headers,
        body: Box::new(file),
        length,
    })
}
