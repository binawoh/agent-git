# agit-remote: a Web console for your agents, through a private Hub

Drive Claude Code and Codex on your own computers from a browser: start sessions in your
project folders, continue saved ones, send messages and files, answer approvals, switch models,
effort and permission modes, and watch each turn as it runs. The console follows the browser's
language, English or Simplified Chinese, and the sign-in page and account menu switch it.

This is part of an independent, community-built setup for the
[AgentGit](https://github.com/Einsia/agent-git) client. It is not affiliated with Einsia and is
not the official hosted service.

## How it fits together

The private Hub, [agit-selfhost](https://github.com/binawoh/agentgit-selfhost), stores and searches
session history but serves requests one at a time, so it cannot hold the long-lived sockets that
remote control needs. `agit-remote` runs beside it, behind the same HTTPS origin, and adds:

- **The cloud peer relay** under `/api/peer/*`: device enrollment and discovery, connection
  grants, the presence socket that carries offers to executors, and the data socket that pairs a
  controller with an executor. It implements the server side of the contract the client speaks
  (`crates/agit-peer`), so `agit rc start` needs no other setup. The relay forwards opaque
  bytes; controller and executor authenticate each other with TLS inside the tunnel.
- **The Web console** under `/console/`. It runs `agit-controller` in-process and reaches
  executors through the same relay over loopback.

```
browser ──HTTPS──▶ nginx ──▶ agit-remote ◀──outbound WSS── agit rc daemon on the PC
                     │          (relay + console)
                     └──────▶ agit-selfhost (history, search, sign-in)
```

## What you need

- A running private Hub with HTTPS, set up with the
  [agit-selfhost quick start](https://github.com/binawoh/agentgit-selfhost#quick-start).
- On the same Linux server (x64 or ARM64): systemd and the Hub's nginx site.
- On each computer to control: Git, Git LFS, Claude Code and/or Codex, and the companion
  `agit` client from this fork's [releases](https://github.com/binawoh/agent-git/releases).
  Other clients are not tested with this relay.

## Install the relay and console

Each [companion release](https://github.com/binawoh/agent-git/releases) carries static Linux
binaries and a `SHA256SUMS` file. Pick the release tag and your server's architecture (`x64` or
`arm64`):

```sh
TAG=companion-v0.2.6-1
ARCH=x64
curl -fLO "https://github.com/binawoh/agent-git/releases/download/$TAG/agit-remote-linux-$ARCH"
curl -fLO "https://github.com/binawoh/agent-git/releases/download/$TAG/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
sudo install -m 0755 "agit-remote-linux-$ARCH" /usr/local/bin/agit-remote
sudo useradd --system --home /var/lib/agit-remote --shell /usr/sbin/nologin agit-remote
sudo install -d -o agit-remote -g agit-remote -m 0700 /var/lib/agit-remote
```

Install the service with your Hub's public origin. It must be spelled exactly as clients use it:
it is the issuer of every device and grant, and a different spelling makes clients reject them.

```sh
curl -fL "https://raw.githubusercontent.com/binawoh/agent-git/$TAG/crates/agit-remote/deploy/agit-remote.service" \
  | sed 's#https://history.example.com#https://YOUR_HUB_DOMAIN#' \
  | sudo tee /etc/systemd/system/agit-remote.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now agit-remote
```

Route `/api/peer/` and `/console` to `127.0.0.1:8178` in the Hub's HTTPS server block, with
WebSocket upgrade headers, as in [`deploy/nginx.conf.example`](deploy/nginx.conf.example). Check
the configuration, reload nginx, and verify from outside:

```sh
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR_HUB_DOMAIN/api/peer/devices
```

The command prints `401`, and `https://YOUR_HUB_DOMAIN/console/` shows the sign-in page.

The service keeps the device registry and console sessions in its data directory. Presence,
grants and links live in memory: a restart drops open links and endpoints reconnect. To upgrade,
replace `/usr/local/bin/agit-remote` with the new release's binary and restart the service.

## Sign in to the console

The first sign-in uses a Hub PAT. Issue one for the console instead of reusing another
client's; with the Hub installed from npm, the executable is `/opt/agit-selfhost/bin/agit-selfhost`:

```sh
sudo -u agit-hub /opt/agit-selfhost/bin/agit-selfhost --data /var/lib/agit-selfhost issue-token --label web-console
```

After signing in, set a console password from the banner or the account menu; from then on the
sign-in page asks for the password. It is stored as an Argon2id hash in the service's data
directory (`console-password.json`). Changing it ends every session that signed in with the old
password. A session signed in with a PAT may replace a forgotten password without the old one,
so a new PAT is the recovery path. The command line keeps using PATs: `agit login` has no
password flow.

## Connect a computer

Download the companion client for the computer from the same release and put it on `PATH`
ahead of any other `agit`:

| Platform | Release file | Install as |
| --- | --- | --- |
| Windows x64 | `agit-windows-x64.exe` | `agit.exe` in a folder on `PATH` |
| macOS, Apple silicon | `agit-macos-arm64` | `~/.local/bin/agit`, then `chmod +x` |
| macOS, Intel | `agit-macos-x64` | `~/.local/bin/agit`, then `chmod +x` |
| Linux x64 / ARM64 | `agit-linux-x64` / `agit-linux-arm64` | `~/.local/bin/agit`, then `chmod +x` |

The binaries are not signed. On macOS, download with `curl` as above, or clear the quarantine
flag a browser download gets with `xattr -d com.apple.quarantine ~/.local/bin/agit`.

Point the client at the Hub, sign in with a PAT, and start the remote-control daemon. The
[agit-selfhost quick start](https://github.com/binawoh/agentgit-selfhost#4-connect-a-computer)
shows how to set the variables persistently on each platform.

```sh
export AGIT_HOME="$HOME/agit-private" AGIT_USE_SYSTEM_GIT=1 \
  AGIT_TELEMETRY_DISABLED=1 AGIT_HUB_URL=https://YOUR_HUB_DOMAIN
agit login --hub "$AGIT_HUB_URL" --with-token
agit rc start --detach
agit rc cloud status --hub "$AGIT_HUB_URL"
```

The computer appears in the console once its presence connects. Bind project folders from the
console's sidebar before starting sessions in them. Sessions that another program is writing (an
open Claude Code or Codex window) are shown read-only; close them there to continue them from the
console.

`agit upgrade` asks the Hub for the newest client, and this Hub does not answer that question, so
the companion client stays in place. Update it by downloading a newer companion release.

## Security

- Whoever signs in to the console can run agents on every connected computer of the account, in
  any permission mode those agents offer, including modes that skip approvals. Use a long console
  password, keep PATs out of shell history and logs, and serve the console only over HTTPS.
- Repeated failed sign-ins are refused for a short while. The session cookie is `HttpOnly`,
  `SameSite=Strict`, and `Secure` on an HTTPS origin.
- The relay cannot read the tunnels it forwards. The console's own controller runs inside
  `agit-remote`, so what you view in the browser passes through the server in that process.
- `--dev-proxy` and `--dev-login-pat-file` exist for local testing and are refused unless the
  public URL is a loopback `http` origin.

## Build from source

The console's web assets are embedded in the binary at compile time; build them first.

```sh
cd crates/agit-remote/web && npm ci && npm run build && cd -
cargo build --release --locked -p agit-remote
```

For a Linux server, a static musl build avoids depending on the host's glibc:

```sh
cargo build --release --locked -p agit-remote --target x86_64-unknown-linux-musl
```

The `Companion release` workflow builds the relay and the client for every platform when a
`companion-v*` tag is pushed, and publishes them with their checksums.

## Local testing

`--dev-proxy` forwards every other route to the Hub so one loopback origin serves sign-in
and the relay. `--dev-login-pat-file` offers a console sign-in that uses a PAT file, so a
browser under test never handles the token; both are refused unless the public URL is a
loopback `http` origin.

```sh
agit-selfhost --data ./hub init --owner tester --public-url http://127.0.0.1:18178 > pat.txt
agit-selfhost --data ./hub serve --listen 127.0.0.1:18177 &
agit-remote serve --data ./relay --listen 127.0.0.1:18178 --public-url http://127.0.0.1:18178 \
  --upstream http://127.0.0.1:18177 --dev-proxy --dev-login-pat-file pat.txt
```

On Windows, keep an executor's `AGIT_HOME` short: agent repositories nest several identifiers
below it, and paths past the platform's length limit make privacy protection withhold content.
