# Headless private Hub investigation

Status: investigation and a synthetic client contract probe only. No backend has
been implemented or deployed. Changes belong to this fork's `selfhost` branch;
upstream is a source of updates, not a push or pull-request destination.

The compatibility baseline is upstream `agit-v0.2.3`, commit
`222d3c3d2250e0771bcccf0aa77dab6aa4d8b832`. The fork's `main` branch may contain
newer upstream work. Keep the investigated baseline explicit until a new client
version passes the compatibility checks.

## Intended use

One owner, private repositories, a small Linux VPS, and local coding agents.
Save Codex and Claude Code histories, including archived sessions, and let either
agent search and read the history through MCP. Fetch a complete repository only
when local restoration or continued work needs it. Administration uses a CLI;
there is no web management UI in the initial scope.

The public code repository contains software and synthetic fixtures. Runtime
transcripts, Hub credentials, secret dictionaries, server data, and local probe
output do not belong in Git.

## Reuse and missing pieces

The upstream MIT license is retained. Its shared Rust library explicitly supports
backend reuse through `default-features = false`, exposing adapters, domain logic,
and infrastructure. Reuse the event format, metadata checks, query parsing, CJK
text processing, and transcript adapters instead of introducing another format.
The HTTP Hub client is CLI-gated, so the server still needs explicit wire models.
[Cargo features][features], [module exports][modules], [license][license]

```toml
agit = { git = "https://github.com/Einsia/agent-git", rev = "222d3c3d2250e0771bcccf0aa77dab6aa4d8b832", default-features = false }
```

Three client-side issues prevent a backend-only solution:

- The Windows release can reject private state paths during bundled Git setup or
  credential persistence. A loopback probe reached PAT authentication but could
  not save credentials. Resolve the actual rejected path or supported storage
  arrangement without disabling credential protection. [Windows checks][acl]
- The Codex list queries filter `archived = 0`; explicit ID lookup does not.
  Collection needs an archive-inclusive entry point and stable session-ID
  deduplication. A server cannot recover histories that were never uploaded.
  [Codex index][codex-index]
- MCP search can query the Hub, but MCP show opens a local repository. Add a
  bounded remote-read tool, or an equivalent separate MCP adapter, for reading
  cold history without cloning. [MCP dispatch][mcp], [local show][show]

## Minimum server contract

| Area | Required behavior |
| --- | --- |
| Headless login | `POST /api/auth/login` accepts a PAT in `{token}`. Return username, access/refresh tokens and RFC3339 expirations. `account_id` and email are optional. |
| Credential lifecycle | Authenticated `GET /api/auth/me`, `POST /api/auth/refresh`, and `POST /api/auth/logout`. A single account still requires real authentication and revocation. |
| Repository metadata | `GET /api/agents` returns an array. `GET /api/agents/{owner}/{name}` returns stable UUID identity, owner/name, visibility and clone URL. `POST /api/agents` creates a private repository and returns identity, push URL and `web_url`. |
| Git transport | Authenticated Smart HTTP advertisements and upload-pack/receive-pack under the returned `.git` URL. Preserve `X-AgentGit-Expected-Agent-Id`; validate authorization and identity before accepting a pack. |
| Large files | Git LFS basic batch, upload/verify and download actions. Validate object size and SHA-256. Missing objects must not be reported as already uploaded. Locks can explicitly be unsupported. |
| Search | `GET /api/search/sessions` with query, pagination and filters. Return `items`, not the CLI's display envelope. Echo only filters actually applied. Preserve incomplete and unknown-query information. |
| Remote read | A bounded, authenticated endpoint pinned to an immutable commit, returning source events, turn/line coordinates, truncation and a continuation position. Wire it into MCP. |

Sources: [login][login], [wire types][wire], [HTTP client][client],
[Git transport][git-transport], [catalog read paths][catalog].

PAT login already exists as `agit login --hub <url> --with-token`, taking the PAT
from stdin; browser OAuth is not required. A future server administration command
can issue and revoke PATs locally. API tokens should not be hardcoded in config
examples or logs.

`RemoteAgent` requires `agent_id`, `owner`, `name`, and `clone_url`; creation also
checks visibility. `PublishResponse` requires `agent_id`, `owner`, `name`,
`push_url`, and `web_url`. A real read-only API URL can satisfy the last field,
or the fork can suppress browser-oriented output. A nonexistent UI is not a
completed feature.

The catalog module already requests paths shaped like:

```text
GET /api/agents/{owner}/{name}/refs
GET /api/agents/{owner}/{name}/sessions?ref=*&page=1&per=20
GET /api/agents/{owner}/{name}/sessions/{id}?ref=<ref>&from=1&to=11&detail=inline
```

It decodes generic JSON, not a complete public response schema. Define and test
the fork's remote-read model explicitly instead of claiming full official Hub
compatibility. The existing JSON client caps responses at 10 MiB. [JSON limit][json-limit]

## Storage and correctness

Use one API service, Git bare repositories, an LFS object directory, and SQLite
for identity, indexing jobs and derived search data. Mature Git transport such as
`git-http-backend` can handle packfiles and protocol negotiation; it does not
implement AgentGit metadata, immutable-history or provenance rules for us.
[Git documentation](https://git-scm.com/docs/git-http-backend)

The current format uses `LOG` / `VIEW` event-ID sequences, `events/` objects and
`session/meta.json`. Older documents also describe a v0 layout; use the shared
library and actual version fields. Validate event references, session identity,
published history and version tags before accepting new refs. Rejected updates
must not leave partially accepted histories. Cross-ref publication semantics need
explicit testing, not an assumption about Git's default receive behavior.
[Storage format][format], [receiver design][receiver]

Normal push uploads LFS, then branches, then version tags in separate stages.
Tag failure can be a warning after branches have succeeded. Check every saved
version after a cold restore rather than accepting the command's exit status as
proof of a complete backup. [Push sequence][push]

Search indexing should be incremental and bounded. Reuse upstream CJK bigrams
and query matching, retaining event provenance and immutable version references.
Keep the index rebuildable from saved history. The shared LOG/VIEW materializer
allows 512 MiB per result, so blindly parsing both in parallel is unsuitable for
an unmeasured small VPS. CPU, RAM and storage requirements remain unmeasured.
[Text processing][text], [query parser][query], [storage bounds][storage]

Git push excludes `.git/agit/secret-dictionary/`, including mappings and keys used
to restore substituted secrets. Remote repository data alone is not necessarily
a byte-for-byte backup of native plaintext. A complete restoration plan needs a
separate encrypted dictionary/key backup and a missing-key test.
[Secret dictionary][secrets]

Remote storage does not automatically remove native transcripts or local AgentGit
repositories. Local retention should only change after a successful cold restore.

## Contract probe

`probe.py` uses Python's standard library, an explicitly supplied client binary,
synthetic tokens and CJK fixture text. The mock binds only to `127.0.0.1` and is
stopped on exit. Each run creates a new isolated `AGIT_HOME`; no runtime sessions
are imported and no system-wide agent configuration is changed. Proxy environment
settings apply only to probe children, limiting their HTTP traffic to loopback.

```powershell
python -X utf8 selfhost/probe.py --agit 'C:\path\to\agit.exe' --system-git --output selfhost/artifacts/probe-results.json
```

`--system-git` selects the client's documented existing-Git mode and keeps its
credential checks enabled. It does not prove Git/LFS integration or bypass a
credential-storage failure. The work directory and results contain only synthetic
data and are retained for diagnosis; remove that reported temporary directory
when finished.

The intended checks are version, PAT login, authenticated identity, a CJK search,
filter acknowledgement and rejection, MCP search, and the expected local-only
show failure. Exit 0 means those narrow mock checks passed; exit 1 means a
contract assertion failed; exit 2 means the probe was blocked or could not run.
Passing does not establish real server indexing, Git/LFS or production readiness.

### Recorded investigation result, 2026-09-22

Official Windows archive SHA-256:

```text
58edcb9b3915d909c746075a56e1f9b0a0d4434c5d929a695f871f22ebcb8378
```

The published checksum matched. Bundled Git preparation failed in one isolated
path with a private-state ACL rejection. Selecting system Git allowed
`agit --version` to report `0.2.3`; the mock then received `POST /api/auth/login`,
but the client failed to persist returned credentials. Dependent search/MCP
checks were skipped. No system ACLs were changed and no mapped-drive workaround
was used. The exact rejected ancestor was not instrumented, so it remains
unconfirmed. A related report exists in [upstream issue #4][windows-issue].

These are observations from an investigation, not a successful end-to-end test.
Local paths and raw probe reports are intentionally excluded from this public
repository.

## Implementation gates

1. Resolve Windows credential storage and pass the mock's authentication/search
   checks; implement a bounded remote-read response and MCP tool.
2. Implement repository metadata, Git reception and LFS. Cold-restore multiple
   synthetic Codex and Claude Code versions, including every tag and binary
   object, from a new client state directory.
3. Verify failed uploads and tag retries, bad UUIDs/tokens, missing/corrupt objects,
   prohibited ref rewrites, invalid event provenance and recovery after restart.
4. Add archive-inclusive collection, CJK query cases, honest index-completeness
   reporting, and cross-agent reads with no local clone.
5. Measure memory and disk, test dictionary backup restoration, then deploy to a
   VPS whose architecture, available capacity, HTTPS and backup arrangements have
   been inspected.

No web UI, organizations, public sharing, pull-request collaboration, or remote
control is included in the first version. Unsupported operations fail explicitly.

[features]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/Cargo.toml#L49-L72
[modules]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/lib.rs#L60-L158
[license]: ../LICENSE
[acl]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/infra/windows_security.rs#L174-L285
[codex-index]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/adapter/codex_index.rs#L197-L244
[mcp]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/commands/mcp.rs#L181-L239
[show]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/commands/show.rs#L557-L587
[login]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/commands/login.rs#L31-L101
[wire]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/hub/mod.rs
[client]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/hub/client.rs
[git-transport]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/hub/git.rs
[catalog]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/hub/catalog.rs#L80-L144
[json-limit]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/hub/json_response.rs#L1-L32
[format]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/domain/meta/mod.rs#L63-L116
[receiver]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/docs/03_branch_model.md#L151-L215
[push]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/commands/push.rs#L512-L560
[text]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/domain/text.rs#L62-L101
[query]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/domain/query.rs#L296-L444
[storage]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/src/domain/storage.rs#L47-L58
[secrets]: https://github.com/Einsia/agent-git/blob/222d3c3d2250e0771bcccf0aa77dab6aa4d8b832/docs/06_repository_secret_dictionary.md#L128-L158
[windows-issue]: https://github.com/Einsia/agent-git/issues/4
