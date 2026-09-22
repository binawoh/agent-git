"""Pack the Linux Hub binary without publishing or reading local Hub data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--name", required=True, help="npm package name owned by the publisher")
    parser.add_argument("--source-commit", required=True, help="Git commit used to build the binary")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*", args.name):
        parser.error("Expected a lowercase npm package name")
    if len(args.name) > 214 or args.name.startswith("@einsia/"):
        parser.error("Use the fork publisher's own npm name, not the upstream namespace")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_commit):
        parser.error("Expected the full source commit SHA")
    root = Path(__file__).resolve().parents[2]
    binary = args.binary.read_bytes()
    if len(binary) < 20 or binary[:6] != b"\x7fELF\x02\x01" or binary[18:20] != b"\x3e\x00":
        parser.error("Expected a little-endian x86-64 Linux ELF binary")
    version = tomllib.loads((root / "crates/agit-selfhost/Cargo.toml").read_text("utf-8"))["package"]["version"]
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        parser.error("npm is required to create the package")
    with tempfile.TemporaryDirectory(prefix="agit-selfhost-npm-") as temporary:
        stage = Path(temporary)
        (stage / "bin").mkdir()
        executable = stage / "bin/agit-selfhost"
        executable.write_bytes(binary)
        executable.chmod(0o755)
        shutil.copyfile(root / "LICENSE", stage / "LICENSE")
        shutil.copyfile(root / "selfhost/npm/README.md", stage / "README.md")
        shutil.copyfile(root / "selfhost/RUNBOOK.md", stage / "RUNBOOK.md")
        shutil.copytree(root / "selfhost/deploy", stage / "deploy")
        manifest = {
            "name": args.name, "version": version,
            "description": "Single-owner private AgentGit Hub for Ubuntu 24.04 x86-64",
            "license": "MIT",
            "repository": {"type": "git", "url": "git+https://github.com/binawoh/agent-git.git", "directory": "selfhost/npm"},
            "homepage": "https://github.com/binawoh/agent-git/blob/selfhost/selfhost/RUNBOOK.md",
            "os": ["linux"], "cpu": ["x64"], "libc": ["glibc"],
            "bin": {"agit-selfhost": "bin/agit-selfhost"},
            "files": ["bin/agit-selfhost", "build.json", "README.md", "RUNBOOK.md", "LICENSE", "deploy/"],
            "publishConfig": {"access": "public", "registry": "https://registry.npmjs.org/"},
        }
        (stage / "package.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
        (stage / "build.json").write_text(json.dumps({
            "source_commit": args.source_commit,
            "binary_sha256": hashlib.sha256(binary).hexdigest(),
            "target": "x86_64-unknown-linux-gnu", "tested_os": "Ubuntu 24.04",
        }, indent=2) + "\n", "utf-8")
        result = subprocess.run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", str(output)],
                                cwd=stage, capture_output=True, check=True)
        reports = json.loads(result.stdout.decode("utf-8"))
        report = reports[0] if isinstance(reports, list) else reports[args.name]
        tarball = output / report["filename"]
        checksum = hashlib.sha256(tarball.read_bytes()).hexdigest()
        tarball.with_suffix(tarball.suffix + ".sha256").write_text(f"{checksum}  {tarball.name}\n", "utf-8")
        print(json.dumps({"tarball": str(tarball), "sha256": checksum,
                          "files": [entry["path"] for entry in report["files"]]}, indent=2))


if __name__ == "__main__":
    main()
