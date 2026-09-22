"""Exercise the real private Hub with synthetic histories and isolated client homes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler
import uuid

from collect import inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agit", type=Path, required=True)
    parser.add_argument("--server", type=Path, required=True)
    parser.add_argument("--state-parent", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    agit, server = args.agit.resolve(), args.server.resolve()
    root = Path(tempfile.mkdtemp(prefix="agit-selfhost-e2e-", dir=args.state_parent))
    project = root / "project"
    project.mkdir()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    hub = f"http://127.0.0.1:{port}"
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("AGIT_")}
    env.update(AGIT_HOME=str(root / "client"), AGIT_HUB_URL=hub,
               AGIT_USE_SYSTEM_GIT="1", AGIT_TELEMETRY_DISABLED="1", DO_NOT_TRACK="1",
               CI="1", NO_COLOR="1", CODEX_HOME=str(root / "codex"),
               CLAUDE_CONFIG_DIR=str(root / "claude"),
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_NAME="tester", GIT_AUTHOR_EMAIL="tester@example.invalid",
               GIT_COMMITTER_NAME="tester", GIT_COMMITTER_EMAIL="tester@example.invalid")
    for key, value in {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1",
                       "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": "127.0.0.1,localhost"}.items():
        env[key] = env[key.lower()] = value
    results = []
    opener = build_opener(ProxyHandler({}))
    access = None
    process = None
    report = {"work_dir": str(root), "steps": results, "status": "failed"}

    def run(command, stdin=None, environment=None, cwd=project, success=True):
        result = subprocess.run([str(v) for v in command], input=stdin.encode("utf-8") if isinstance(stdin, str) else stdin,
                                capture_output=True, cwd=cwd,
                                env=environment or env, timeout=120)
        result.stdout = result.stdout.decode("utf-8", errors="replace")
        result.stderr = result.stderr.decode("utf-8", errors="replace")
        if success and result.returncode:
            raise AssertionError(f"Command failed: {command}\n{result.stdout}\n{result.stderr}")
        return result

    def cli(*command, environment=None):
        return run([agit, *command, "--json"], environment=environment)

    def api(path, method="GET", data=None, status=200, headers=None, authenticated=True):
        body = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if authenticated and access:
            request_headers["Authorization"] = f"Bearer {access}"
        request = Request(hub + path, data=body, method=method, headers=request_headers)
        try:
            response = opener.open(request, timeout=120)
        except HTTPError as error:
            response = error
        content = response.read()
        assert response.code == status, (path, response.code, content[:2000])
        return json.loads(content) if content and "json" in response.headers.get("Content-Type", "") else content

    def passed(name):
        results.append(name)
        print(name, flush=True)

    def start():
        log = (root / "server.log").open("ab")
        child = subprocess.Popen([str(server), "--data", str(root / "data"), "serve", "--listen", f"127.0.0.1:{port}"],
                                 env=env, stdout=log, stderr=log,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        log.close()
        for _ in range(100):
            if child.poll() is not None:
                raise AssertionError((root / "server.log").read_text())
            try:
                api("/api/health", authenticated=False)
                return child
            except OSError:
                time.sleep(0.1)
        child.terminate()
        child.wait(timeout=10)
        raise AssertionError("Server readiness timeout")

    try:
        pat = run([server, "--data", root / "data", "init", "--owner", "tester", "--public-url", hub]).stdout.strip()
        process = start()
        api("/api/agents", status=401, authenticated=False)
        login = api("/api/auth/login", "POST", {"token": pat}, authenticated=False)
        access = login["access_token"]
        run([agit, "login", "--hub", hub, "--with-token", "--json"], pat + "\n")
        cli("whoami", "--check")
        passed("PAT login, private routes and client identity")
        run(["git", "init", "--initial-branch=main"])
        native_ids = {runtime: str(uuid.uuid4()) for runtime in ("codex", "claude-code")}
        paths = {}
        for runtime, sid in native_ids.items():
            if runtime == "codex":
                path = root / "codex" / "archived_sessions" / f"rollout-2026-09-22T00-00-00-{sid}.jsonl"
                rows = [{"type": "session_meta", "payload": {"id": sid, "cwd": str(project), "timestamp": "2026-09-22T00:00:00Z"}}]
                for role, text in [("user", "缓存 fixture question"), ("assistant", "缓存 fixture answer codex")]:
                    rows.append({"type": "response_item", "payload": {"type": "message", "role": role,
                                 "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}]}})
            else:
                path = root / "claude" / "projects" / "synthetic" / f"{sid}.jsonl"
                rows = [{"type": role, "uuid": str(uuid.uuid4()), "sessionId": sid, "cwd": str(project),
                         "timestamp": "2026-09-22T00:00:00Z", "message": {"role": role,
                         "content": [{"type": "text", "text": text}]}}
                        for role, text in [("user", "缓存 fixture question"), ("assistant", "缓存 fixture answer claude")]]
                rows.insert(0, {"type": "file-history-snapshot", "snapshot": {"trackedFileBackups": {}}})
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
            paths[runtime] = path
            cli("import", sid, "--from", runtime, "--into", f"tester/demo@{runtime}", "--independent")
        passed("Archived Codex and Claude synthetic imports")
        collected = inventory(root / "codex", root / "claude")
        assert len(collected) == 2 and any(row["archived"] for row in collected)
        cli("import", native_ids["codex"], "--from", "codex", "--into", "tester/demo@codex", "--independent")
        source = root / "client" / "repos" / "tester" / "demo"
        for saved in run(["git", "rev-list", "--all"], cwd=source).stdout.splitlines():
            run(["git", "tag", f"agit-{saved}", saved], cwd=source)
        run(["git", "tag", "-a", "fixture-milestone", "-m", "Synthetic milestone", "codex"], cwd=source)
        cli("push", "tester/demo", "--all", "--private")
        repo = api("/api/agents/tester/demo")
        identity = {"X-AgentGit-Expected-Agent-Id": repo["agent_id"]}
        api("/tester/demo.git/info/refs?service=git-upload-pack", status=428)
        api("/tester/demo.git/info/refs?service=git-upload-pack", status=412,
            headers={"X-AgentGit-Expected-Agent-Id": str(uuid.uuid4())})
        passed("Real Smart HTTP push and immutable repository identity")
        search = api("/api/search/sessions?" + urlencode({"q": "缓存"}))
        assert len(search["items"]) == 2 and not search["incomplete"], search
        cli("search", "缓存", "--repo", "tester/demo")
        filtered = api("/api/search/sessions?" + urlencode({"q": "缓存", "author": "nobody"}))
        assert not filtered["items"] and filtered["applied_filters"]["author"] == "nobody"
        hit = search["items"][0]
        transcript = api(hit["url"][len(hub):])
        assert transcript["commit"] == hit["commit"] and "缓存" in json.dumps(transcript, ensure_ascii=False)
        continued = api(f"/api/agents/tester/demo/sessions/{hit['session_id']}?ref={hit['commit']}&from=11")
        assert not continued["turns"] and continued["to"] == 21
        cold = dict(env, AGIT_HOME=str(root / "cold"), CODEX_HOME=str(root / "no-native"),
                    CLAUDE_CONFIG_DIR=str(root / "no-claude"))
        run([agit, "login", "--hub", hub, "--with-token", "--json"], pat + "\n", environment=cold)
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "read_remote",
                     "arguments": {"repo": "tester/demo", "session_id": hit["session_id"], "reference": hit["commit"], "from": 1}}}]
        mcp = run([agit, "mcp"], "".join(json.dumps(v) + "\n" for v in messages), environment=cold)
        reply = [json.loads(line) for line in mcp.stdout.splitlines() if line.strip()][-1]
        assert not reply["result"].get("isError") and "缓存" in json.dumps(reply, ensure_ascii=False), reply
        passed("CJK search, real author filtering and MCP remote read before clone")
        payload = b"synthetic binary fixture\x00" * 1000
        oid = hashlib.sha256(payload).hexdigest()
        objects = api("/tester/demo.git/info/lfs/objects/batch", "POST", {"operation": "upload", "objects": [{"oid": oid, "size": len(payload)}]}, headers=identity)
        href = objects["objects"][0]["actions"]["upload"]["href"][len(hub):]
        api(href, "PUT", b"corrupt", status=422, headers=identity)
        api(href, "PUT", payload, headers=identity)
        assert api(href, headers=identity) == payload
        api(href + "/verify", "POST", {"oid": oid, "size": len(payload)}, headers=identity)
        passed("LFS upload, SHA-256 rejection, verification and download")
        source = root / "client" / "repos" / "tester" / "demo"
        restored = root / "cold" / "repos" / "tester" / "demo"
        with paths["codex"].open("a", encoding="utf-8") as stream:
            for role, text in [("user", "Follow-up question"), ("assistant", "Second saved version")]:
                stream.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": role,
                    "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}]}}) + "\n")
        cli("commit", "tester/demo@codex")
        saved = run(["git", "rev-parse", "codex"], cwd=source).stdout.strip()
        run(["git", "tag", f"agit-{saved}", saved], cwd=source)
        cli("push", "tester/demo@codex")
        saved_again = api(hit["url"][len(hub):])
        assert saved_again == transcript, "An immutable read changed after publishing another version"
        passed("Incremental save retains immutable historical reads")
        run(["git", "switch", "main"], cwd=source)
        run(["git", "lfs", "install", "--local"], cwd=source)
        with (source / ".gitattributes").open("a", encoding="utf-8") as stream:
            stream.write("\n*.bin filter=lfs diff=lfs merge=lfs -text\n")
        attachment = payload + b"real Git LFS client"
        (source / "fixture.bin").write_bytes(attachment)
        run(["git", "add", ".gitattributes", "fixture.bin"], cwd=source)
        run(["git", "commit", "-m", "Synthetic LFS file"], cwd=source)
        cli("push", "tester/demo@main")
        cli("clone", "tester/demo@main", "--no-bind", environment=cold)
        assert source.exists() and restored.exists(), (source, restored)
        restored_file = root / "restored.bin"
        cli("file", "get", "fixture.bin", "--into", "tester/demo@main", "--output", str(restored_file), environment=cold)
        assert restored_file.read_bytes() == attachment
        for reference in ("refs/heads/codex", "refs/heads/claude-code"):
            expected = run(["git", "rev-parse", reference], cwd=source).stdout.strip()
            actual = run(["git", "rev-parse", reference.replace("refs/heads/", "refs/remotes/origin/")], cwd=restored).stdout.strip()
            assert expected == actual
        tags = run(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags"], cwd=source).stdout
        assert "fixture-milestone" in tags and tags == run(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags"], cwd=restored).stdout
        passed("Cold clone preserves branch commits, version tags and Git LFS bytes")
        before_refs = api("/api/agents/tester/demo/refs")
        git_env = dict(env, GIT_CONFIG_COUNT="3", GIT_CONFIG_KEY_0="http.extraHeader",
                       GIT_CONFIG_VALUE_0=f"Authorization: Bearer {access}",
                       GIT_CONFIG_KEY_1="http.extraHeader",
                       GIT_CONFIG_VALUE_1=f"X-AgentGit-Expected-Agent-Id: {repo['agent_id']}",
                       GIT_CONFIG_KEY_2="core.hooksPath", GIT_CONFIG_VALUE_2=str(root / "empty-hooks"))
        refs = ["main:refs/heads/transaction-probe", "main:refs/tags/agit-" + "b" * 40]
        for flags in ([], ["--atomic"]):
            rejected = run(["git", "push", *flags, "origin", *refs], environment=git_env, cwd=source, success=False)
            assert rejected.returncode != 0
            assert api("/api/agents/tester/demo/refs") == before_refs, "Rejected transaction changed published refs"
        index_env = dict(env, GIT_INDEX_FILE=str(root / "temporary-index"))
        run(["git", "read-tree", "main"], environment=index_env, cwd=source)
        missing = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a" * 64 + "\nsize 3\n"
        blob = run(["git", "hash-object", "-w", "--stdin"], missing, cwd=source).stdout.strip()
        run(["git", "update-index", "--add", "--cacheinfo", f"100644,{blob},missing.pointer"], environment=index_env, cwd=source)
        tree = run(["git", "write-tree"], environment=index_env, cwd=source).stdout.strip()
        bad = run(["git", "commit-tree", tree, "-p", "main"], "Missing LFS fixture\n", cwd=source).stdout.strip()
        rejected = run(["git", "push", "--atomic", "origin", f"{bad}:refs/heads/missing-lfs"], environment=git_env, cwd=source, success=False)
        assert rejected.returncode != 0 and "LFS" in rejected.stderr
        assert api("/api/agents/tester/demo/refs") == before_refs
        passed("Rejected multi-ref updates and missing LFS objects leave refs unchanged")
        metadata = json.loads(run(["git", "show", "codex:session/meta.json"], cwd=source).stdout)
        record = {"type": "assistant", "uuid": str(uuid.uuid4()), "sessionId": str(uuid.uuid4()),
                  "message": {"role": "assistant", "content": [{"type": "text", "text": "mixed-runtime-marker"}]}}
        content = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        content_id = hashlib.sha256(content.encode()).hexdigest()[:40]
        envelope = '{"_source":"claude-code","_session_id":"' + metadata["session"] + '\",\"_object_hash\":\"' + content_id + '\",\"content\":' + content + '}\n'
        event_id = hashlib.sha256(envelope.encode()).hexdigest()[:40]
        event_path = "events/" + "/".join(event_id[:4]) + "/" + event_id
        run(["git", "read-tree", "codex"], environment=index_env, cwd=source)
        changes = {event_path: envelope}
        for name in ("LOG", "VIEW"):
            changes[name] = run(["git", "show", f"codex:{name}"], cwd=source).stdout + event_id + "\n"
        for path, contents in changes.items():
            blob = run(["git", "hash-object", "-w", "--stdin"], contents, cwd=source).stdout.strip()
            run(["git", "update-index", "--add", "--cacheinfo", f"100644,{blob},{path}"], environment=index_env, cwd=source)
        tree = run(["git", "write-tree"], environment=index_env, cwd=source).stdout.strip()
        mixed = run(["git", "commit-tree", tree, "-p", "codex"], "Mixed runtime fixture\n", cwd=source).stdout.strip()
        run(["git", "push", "--atomic", "origin", f"{mixed}:refs/heads/codex"], environment=git_env, cwd=source)
        mixed_search = api("/api/search/sessions?q=mixed-runtime-marker")
        assert mixed_search["total"] == 1 and not mixed_search["incomplete"], mixed_search
        mixed_read = api(mixed_search["items"][0]["url"][len(hub):])
        assert any(event["source"] == "claude-code" and "mixed-runtime-marker" in json.dumps(event)
                   for turn in mixed_read["turns"] for event in turn["events"])
        passed("Mixed-runtime snapshots preserve searchable content and source provenance")
        collected_id = str(uuid.uuid4())
        collected_path = root / "codex" / "archived_sessions" / f"rollout-2026-09-22T00-00-01-{collected_id}.jsonl"
        collected_path.write_text("".join(json.dumps(row) + "\n" for row in [
            {"type": "session_meta", "payload": {"id": collected_id, "cwd": str(project), "timestamp": "2026-09-22T00:00:01Z"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Collector fixture"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Collector answer"}]}}
        ]), encoding="utf-8")
        original = collected_path.read_bytes()
        collect = [sys.executable, "-X", "utf8", Path(__file__).with_name("collect.py").resolve(), "--agit", agit,
                   "--repo", "tester/collected", "--codex-home", root / "codex", "--claude-home", root / "claude",
                   "--session", collected_id, "--apply", "--push"]
        run(collect)
        collected_refs = api("/api/agents/tester/collected/refs")
        run(collect)
        assert api("/api/agents/tester/collected/refs") == collected_refs
        assert collected_path.read_bytes() == original
        passed("Collector publishes archived IDs and repeats without rewriting history or native files")
        busy = run([server, "--data", root / "data", "reindex"], success=False)
        assert busy.returncode != 0 and "Stop the running Hub" in busy.stderr
        process.terminate()
        process.wait(timeout=10)
        run([server, "--data", root / "data", "reindex"])
        process = start()
        with collected_path.open("a", encoding="utf-8") as stream:
            for role, text in [("user", "Large answer fixture"), ("assistant", "large " * 200000),
                               ("user", "Subsequent valid question"), ("assistant", "after-limit-marker")]:
                stream.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": role,
                    "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}]}}) + "\n")
        run(collect)
        partial = api("/api/search/sessions?q=after-limit-marker")
        assert partial["total"] == 1 and partial["incomplete"], partial
        process.terminate()
        process.wait(timeout=10)
        rebuilt = run([server, "--data", root / "data", "reindex"], success=False)
        assert rebuilt.returncode != 0 and "incomplete indexes" in rebuilt.stderr
        process = start()
        partial = api("/api/search/sessions?q=after-limit-marker")
        assert partial["total"] == 1 and partial["incomplete"], partial
        passed("Oversized events preserve later search hits and honest incompleteness through rebuild")
        assert api("/api/search/sessions?" + urlencode({"q": "缓存"}))["total"] == 2
        rotated = api("/api/auth/refresh", "POST", {"refresh_token": login["refresh_token"]}, authenticated=False)
        api("/api/auth/refresh", "POST", {"refresh_token": login["refresh_token"]}, status=401, authenticated=False)
        access = rotated["access_token"]
        tokens = json.loads(run([server, "--data", root / "data", "list-tokens"]).stdout)
        run([server, "--data", root / "data", "revoke-token", tokens[0]["id"]])
        api("/api/agents", status=401)
        api("/api/auth/login", "POST", {"token": pat}, status=401, authenticated=False)
        passed("Restart persistence, refresh rotation and PAT revocation")
        report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        report["server_stopped"] = process is None or process.poll() is not None
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": report["status"], "work_dir": str(root)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
