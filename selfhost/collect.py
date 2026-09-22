"""Inventory local Codex/Claude transcripts; explicitly apply and push selected history."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid


def inventory(codex_home, claude_home):
    sessions = {}
    roots = [("codex", codex_home / name) for name in ("sessions", "archived_sessions")]
    roots.append(("claude-code", claude_home / "projects"))
    for runtime, root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
                raise ValueError(f"Refusing a symlinked transcript: {path}")
            with path.open("rb") as stream:
                first = stream.readline(1024 * 1024 + 1)
            if len(first) > 1024 * 1024:
                raise ValueError(f"Transcript header exceeds limit: {path}")
            try:
                record = json.loads(first)
            except (ValueError, UnicodeDecodeError):
                raise ValueError(f"Unreadable transcript header: {path}") from None
            if runtime == "codex":
                if record.get("type") != "session_meta":
                    continue
                session = record.get("payload", {}).get("id")
            else:
                # Claude may start with bookkeeping that has no sessionId; its carrier name is the native UUID.
                session = record.get("sessionId") or path.stem
                if "subagents" in path.parts:
                    continue
            if not session:
                continue
            try:
                uuid.UUID(session)
            except (ValueError, TypeError, AttributeError):
                continue
            key = (runtime, session)
            if key in sessions:
                raise ValueError(f"Duplicate native identity {runtime}/{session}; resolve copies before collecting")
            sessions[key] = {"runtime": runtime, "session_id": session, "path": str(path),
                             "archived": "archived_sessions" in path.parts,
                             "branch": f"{runtime}-{session}"}
    return list(sessions.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agit", type=Path, required=True)
    parser.add_argument("--repo", required=True, help="Existing or new owner/name destination")
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")))
    parser.add_argument("--claude-home", type=Path, default=Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")))
    parser.add_argument("--session", action="append", help="Limit to these exact native IDs; repeatable")
    parser.add_argument("--apply", action="store_true", help="Import and settle the inventory locally")
    parser.add_argument("--push", action="store_true", help="Publish each successfully collected branch privately")
    args = parser.parse_args()
    if args.push and not args.apply:
        parser.error("--push requires --apply")
    if len(args.repo.split("/")) != 2 or any(not piece or not all(c.isascii() and (c.isalnum() or c in "-_") for c in piece) for piece in args.repo.split("/")):
        parser.error("--repo must be owner/name with ASCII letters, digits, hyphens or underscores")
    rows = inventory(args.codex_home, args.claude_home)
    if args.session:
        wanted = set(args.session)
        rows = [row for row in rows if row["session_id"] in wanted]
        missing = wanted - {row["session_id"] for row in rows}
        if missing:
            parser.error("Requested session IDs were not found: " + ", ".join(sorted(missing)))
    print(json.dumps({"apply": args.apply, "push": args.push, "sessions": rows}, ensure_ascii=False, indent=2), flush=True)
    if not args.apply:
        return
    env = dict(os.environ, CODEX_HOME=str(args.codex_home.resolve()), CLAUDE_CONFIG_DIR=str(args.claude_home.resolve()))
    for row in rows:
        target = f"{args.repo}@{row['branch']}"
        subprocess.run([str(args.agit.resolve()), "import", row["session_id"], "--from", row["runtime"],
                        "--into", target, "--independent", "--json"], env=env, check=True)
        if args.push:
            subprocess.run([str(args.agit.resolve()), "push", target, "--private", "--json"], env=env, check=True)


if __name__ == "__main__":
    main()
