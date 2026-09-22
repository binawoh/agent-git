# Private AgentGit Hub npm package

This package distributes a prebuilt private Hub from
[binawoh/agent-git](https://github.com/binawoh/agent-git/tree/selfhost).
The service and its data run on your own VPS. The npm registry hosts the
installation package; it does not host the service or save your conversations.

The binary targets **Ubuntu 24.04 on x86-64** with glibc. ARM, Alpine Linux,
Windows, and older Linux distributions are not supported by this package.
Git must be installed separately. Node.js/npm are only needed to install or
update the package; the running server is a native executable. The package has
no JavaScript dependencies or install scripts, and installation does not start
services, create credentials, or import sessions.

## Install a downloaded package

Verify the tarball against the checksum supplied by the release, then use a
stable prefix outside the Hub data directory:

```sh
sha256sum --check PACKAGE.tgz.sha256
sudo npm install --global --prefix /opt/agit-selfhost --ignore-scripts \
  --no-audit --no-fund ./PACKAGE.tgz
/opt/agit-selfhost/bin/agit-selfhost --help
```

Follow `RUNBOOK.md` to create the service user, initialize the Hub, configure
HTTPS, and set up clients. Use `/opt/agit-selfhost/bin/agit-selfhost` for both
initialization and the systemd `ExecStart` executable. Persistent data belongs
in `/var/lib/agit-selfhost`, outside the npm installation.

Do not run a persistent Hub through `npx`: its cache path is not a stable
installation location. Git receive hooks record the real executable's absolute
path. Keep the same npm prefix and package name for updates, stop the service
before replacing the package, then start and verify it. Moving from a standalone
binary installation to npm requires preserving the original executable path for
existing hooks; installing a package alone does not migrate those hooks.

## Build and publish

From the fork checkout, use Python 3.11 or later and npm:

```sh
cargo build --locked --release -p agit-selfhost
python3 selfhost/npm/pack.py --binary target/release/agit-selfhost \
  --name @YOUR_NPM_ACCOUNT/agit-selfhost --source-commit "$(git rev-parse HEAD)" \
  --output selfhost/artifacts/npm
```

Replace the package name with a lowercase name owned by your actual npm account.
The packer does not publish anything. Its allowlist includes only the binary,
license, deployment examples, and documentation. The build metadata contains the
binary checksum and the source commit supplied by the caller; build from that
commit before packing. Run the protocol test against the installed package before
publishing.

After logging into your npm account, a verified tarball can be published with
`npm publish ./PACKAGE.tgz --access public --tag next`. This is separate from the
upstream `@einsia/agent-git` CLI package. Local tarball installation does not
require an npm account or a public registry release.
