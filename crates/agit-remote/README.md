# agit-remote: remote control for a private Hub

The private Hub (`agit-selfhost`) stores and searches session history but serves requests
one at a time, so it cannot hold the long-lived sockets that remote control needs. This
service runs beside it, behind the same HTTPS origin, and adds two things:

- **The cloud peer relay** under `/api/peer/*`: device enrollment and discovery, connection
  grants, the presence socket that carries offers to executors, and the data socket that
  pairs a controller with an executor. It implements the server side of the contract the
  stock client already speaks (`crates/agit-peer`), so `agit rc start` works unchanged.
  The relay forwards opaque bytes; controller and executor authenticate each other with TLS
  inside the tunnel.
- **A Web console** under `/console/`: sign in with a Hub PAT, pick a machine, browse its
  projects and sessions, start Claude Code or Codex sessions, send messages, answer
  approvals and interrupt turns. The console runs `agit-controller` in-process and reaches
  executors through the same relay over loopback.

```
browser ──HTTPS──▶ nginx ──▶ agit-remote ◀──outbound WSS── agit rc daemon on the PC
                     │          (relay + console)
                     └──────▶ agit-selfhost (history, search, sign-in)
```

## Build

The console's web assets are embedded in the binary at compile time; build them first.

```sh
cd crates/agit-remote/web && npm ci && npm run build && cd -
cargo build --release --locked -p agit-remote
```

For a Linux server, a static musl build avoids depending on the host's glibc:

```sh
cargo build --release --locked -p agit-remote --target x86_64-unknown-linux-musl
```

## Deploy

1. Install the binary as `/usr/local/bin/agit-remote`, create a system user and a private data
   directory, and install [`deploy/agit-remote.service`](deploy/agit-remote.service) with
   `--public-url` set to the Hub's public origin exactly as clients use it. It is the issuer
   of every device and grant; a different spelling makes clients reject them.
2. Route `/api/peer/` and `/console` to `127.0.0.1:8178` in the Hub's HTTPS server block with
   WebSocket upgrade headers, as in [`deploy/nginx.conf.example`](deploy/nginx.conf.example).
3. Check `curl https://HUB/api/peer/devices` returns 401 and `https://HUB/console/` loads.

The service keeps the device registry and console sessions in its data directory. Presence,
grants and links live in memory: a restart drops open links and endpoints reconnect.

## Sign in to the console

The first sign-in uses a Hub PAT. Issue one for the console without reusing another client's:

```sh
sudo -u agit-hub agit-selfhost --data /var/lib/agit-selfhost issue-token --label web-console
```

After signing in, the key button in the sidebar sets a console password; from then on the
sign-in page asks for the password. It is stored as an Argon2id hash in the service's data
directory (`console-password.json`). Changing it ends every session that signed in with the
old password. A session signed in with a PAT may replace a forgotten password without the old
one, so a new PAT is the recovery path. The command line keeps using PATs: `agit login` has no
password flow.

## Connect a machine

On the machine to control, with `AGIT_HUB_URL` pointing at the Hub and a signed-in account:

```sh
agit rc start --detach
agit rc cloud status --hub https://HUB
```

The machine appears in the console once its presence connects. Bind project folders from the
console's sidebar before starting sessions in them.

Sessions that another program is writing (an open Claude Code or Codex window) are shown
read-only; close them there to continue them from the console.

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
