# Private headless AgentGit Hub

This fork adds a single-owner private Hub to the upstream MIT-licensed client.
It stores Git history and LFS attachments, authenticates with personal access
tokens (PATs), and serves session search and bounded transcript reads. There is
no browser management UI, subscription service, public sharing, organization
management, or remote agent execution. Unsupported API operations fail explicitly.

The baseline is `agit-v0.2.3` at
`222d3c3d2250e0771bcccf0aa77dab6aa4d8b832`. Use the client built from this branch:
it adds `read_remote` to MCP, archive-aware Codex ID lookup, atomic Hub pushes,
and a Windows OWNER RIGHTS permission fix. It retains all other credential checks.

## Build and verify

Install Rust through rustup, Python 3, Git and Git LFS. The repository pins its
Rust toolchain. Ordinary source builds use system Git; Git is still required.

```sh
cargo build --locked --bin agit
cargo build --locked -p agit-selfhost
cargo test --locked -p agit-selfhost
python3 selfhost/e2e.py --agit target/debug/agit --server target/debug/agit-selfhost \
  --output selfhost/artifacts/e2e-linux.json
```

On Windows use `python -X utf8`, `.exe` binaries, and a trusted state parent:

```powershell
python -X utf8 selfhost/e2e.py --agit target/debug/agit.exe --server target/debug/agit-selfhost.exe --state-parent $env:USERPROFILE --output selfhost/artifacts/e2e-windows.json
```

The test creates isolated client homes and synthetic transcripts, including an
archived Codex file. It starts and stops its own loopback Hub. It checks real
Git transport, Chinese search, filters, MCP reads before cloning, incremental
versions, Git LFS restoration, rejected transactions, restart persistence and
token revocation. It retains temporary data for diagnosis and prints that path.
No real native sessions are read. Raw local test reports are ignored by Git.
The `Self-hosted Hub` workflow runs the protocol test against a release server
on Ubuntu 24.04. Successful runs attach `agit-selfhost-linux-x86_64` with its
SHA-256 checksum. This artifact is for x86-64 Linux, not an ARM VPS.

## Ubuntu deployment

Inspect the actual VPS OS, architecture, free disk, memory, installed services,
firewall and domain before applying these examples. They assume a Linux host
using systemd and an HTTPS domain routed to that host. The HTTP service binds to
loopback; do not expose port 8177 directly. Existing web-server configuration
must be integrated without replacing unrelated sites.

Build on a machine matching the VPS architecture, or on the VPS if it has enough
build memory. The server is independent of Claude/Codex binaries and model runtimes.

```sh
cargo build --locked --release -p agit-selfhost
sudo apt-get update
sudo apt-get install -y git
sudo useradd --system --home /var/lib/agit-selfhost --shell /usr/sbin/nologin agit-hub
sudo install -d -o agit-hub -g agit-hub -m 0700 /var/lib/agit-selfhost
sudo install -m 0755 target/release/agit-selfhost /usr/local/bin/agit-selfhost
sudo -u agit-hub /usr/local/bin/agit-selfhost --data /var/lib/agit-selfhost init \
  --owner YOUR_OWNER --public-url https://history.example.com
```

`init` prints the initial PAT once. Store it in a password manager; do not paste
it into Git, shell command arguments or server logs. The database stores token
hashes. Access tokens expire after an hour; refresh tokens rotate and expire
after 30 days. Revoking a PAT also revokes every session issued from it.

```sh
sudo install -m 0644 selfhost/deploy/agit-selfhost.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agit-selfhost
curl --fail http://127.0.0.1:8177/api/health
```

Configure the existing HTTPS reverse proxy using
[`deploy/nginx.conf.example`](deploy/nginx.conf.example) as a reference. Obtain
a valid certificate using the host's existing certificate management method.
Validate the proxy configuration before reloading it. Verify the public health
endpoint and confirm `/api/agents` returns 401 without credentials.

The service example has a 768 MiB memory ceiling. This is a failure-containment
setting, not a measured minimum or a capacity promise. Default request limits
are 256 MiB per Git/LFS upload and 64 MiB per materialized LOG or VIEW. Parsing,
indexing and Git add overhead beyond those buffers. Measure representative
synthetic data before deciding whether the VPS can handle your longest sessions.
`init --max-snapshot-mib` and `--max-upload-mib` set these limits; proxy limits
must agree. Requests are processed serially; this is a personal archive service.

Keep the executable at `/usr/local/bin/agit-selfhost`: repository receive hooks
record its absolute path. Stop the service before replacing the executable.

## Windows client and collection

Use a private `AGIT_HOME` outside ancestors writable by other users. A path under
the current user's profile can work when some AppData ancestors do not. The
fork reports the specific rejected ancestor. Do not bypass checks or weaken ACLs.
Set environment variables for the client process and its MCP process; using a
different `AGIT_HOME` means a different login and local repository store.

```powershell
$env:AGIT_HOME = Join-Path $env:USERPROFILE 'agit-private'
$env:AGIT_USE_SYSTEM_GIT = '1'
$env:AGIT_TELEMETRY_DISABLED = '1'
$env:AGIT_HUB_URL = 'https://history.example.com'
agit login --hub $env:AGIT_HUB_URL --with-token
agit whoami --check
```

`--with-token` reads from stdin. Supply the PAT through stdin using your terminal
or password manager. Do not put the PAT in the command line. `AGIT_HOME` contains
credentials and local snapshots; the VPS does not automatically eliminate this
local copy or the original Codex/Claude transcript.

First inventory exactly what would be collected:

```powershell
python -X utf8 selfhost/collect.py --agit C:/path/to/agit.exe --repo YOUR_OWNER/history
```

Collection includes Codex `sessions` and `archived_sessions`, and Claude's main
project transcripts. It skips Claude subagent files, fails on duplicate native
IDs, and never deletes or resumes native conversations. Add `--session ID` to
select exact IDs. After reviewing the inventory, add `--apply --push` to import
and privately publish those branches. Re-running uses the same runtime/ID branch
and settles new content. A session already claimed on another branch is refused
instead of silently rerouted. Native formats or headers it cannot recognize are
not a complete backup; inspect the inventory and failed commands.

For one explicitly selected session:

```text
agit import NATIVE_ID --from codex --into YOUR_OWNER/history@codex-ID --independent
agit push YOUR_OWNER/history@codex-ID --private
```

Configure each agent's stdio MCP server to launch this fork's `agit mcp`, with
the same private `AGIT_HOME` and Hub URL. `search` returns saved hits; `read_remote`
takes `repo`, `session_id`, the immutable commit from the hit URL's `ref` query
parameter as `reference`, and optional `from`. Follow `next_from` with the same
commit. Reads return original source records in bounded turn ranges. Regular
`show` remains a local-repository operation.

```json
{"command":"C:/path/to/agit.exe","args":["mcp"],"env":{"AGIT_HOME":"C:/Users/YOU/agit-private","AGIT_USE_SYSTEM_GIT":"1","AGIT_HUB_URL":"https://history.example.com","AGIT_TELEMETRY_DISABLED":"1"}}
```

This is a server definition to place in the agent's own MCP configuration format,
not a command that changes all agents automatically.

## Restore, maintain and back up

```text
agit clone YOUR_OWNER/history@BRANCH --no-bind
agit file get PATH --into YOUR_OWNER/history@BRANCH --output DESTINATION
```

Clone retrieves Git snapshots and version tags. LFS files initially remain
pointers; `file get` downloads and verifies the requested attachment. Test a cold
restore with a new `AGIT_HOME`, including historical tags and attachment hashes,
before any local retention changes.

Server administration is local:

```sh
sudo -u agit-hub /usr/local/bin/agit-selfhost --data /var/lib/agit-selfhost list-tokens
sudo -u agit-hub /usr/local/bin/agit-selfhost --data /var/lib/agit-selfhost issue-token --label laptop
sudo -u agit-hub /usr/local/bin/agit-selfhost --data /var/lib/agit-selfhost revoke-token TOKEN_ID
sudo systemctl stop agit-selfhost
sudo -u agit-hub /usr/local/bin/agit-selfhost --data /var/lib/agit-selfhost reindex
sudo systemctl start agit-selfhost
sudo journalctl -u agit-selfhost
```

`reindex` rebuilds derived search tables from saved Git history and requires the
service to be stopped. It preserves repository identities and credentials. Failed indexing preserves Git
history and sets `incomplete=true` on searches until a successful indexing run.
An oversized event is indexed up to a bounded prefix and marks that snapshot
incomplete; later events and other valid snapshots are still indexed. Original
Git data is retained. Rebuild continues across failures and returns a failing
exit code while any repository remains incomplete. Search caps candidate scanning
and reports truncation as incomplete. Unsupported
filters are rejected or exposed through the query's `unknown` field. The index
deduplicates event bodies, but retains snapshot memberships, so disk usage is
not identical to compressed Git history. No automatic eviction or disk quota is
implemented; monitor disk use and keep a separate backup.

For a consistent server backup, stop the service, copy the entire private data
directory (including config, SQLite/WAL, repositories and LFS), then restart.
Encrypt the backup and store it outside this VPS. Restoring the whole directory
preserves repository UUIDs and tokens. Test restoration on a separate loopback
instance. Copying only `.git` repositories omits authentication and LFS objects.

The client's `.git/agit/secret-dictionary/` and its keys are not pushed. They need
a separate encrypted client backup if restoration of substituted secrets is
required. Git/LFS cold restoration does not prove recovery of native plaintext
secrets. Do not delete original transcripts or dictionaries on that assumption.

Each Git receive transaction is atomic, rejects ref deletion/rewrites and invalid
version tags, and checks LFS existence before publishing refs. Normal client push
still uploads LFS, branches and tags in separate stages. An interrupted push can
leave uploaded but unreferenced objects or branches awaiting tag retry; re-run
push and verify tags. This service does not claim a single transaction across
those three client stages.
