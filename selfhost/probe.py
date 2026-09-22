"""Probe an explicit agit binary against a synthetic loopback Hub."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


# Non-English text is fixture data for CJK transport, not documentation.
QUERY = "缓存"
EXCERPT = "虚构记录：使用缓存避免重复查询。"
ACCOUNT = {
    "account_id": "f047b86c-653f-4824-afca-2ab925140b4f",
    "username": "tester",
    "email": "tester@example.invalid",
}
ACCESS = "synthetic-probe-access-token"
TOKENS = {
    "access_token": ACCESS,
    "access_expires_at": "2030-01-01T00:00:00Z",
    "refresh_token": "synthetic-probe-refresh-token",
    "refresh_expires_at": "2031-01-01T00:00:00Z",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def record(self):
        self.server.requests.append({
            "method": self.command,
            "path": self.path,
            "authorization_present": bool(self.headers.get("Authorization")),
        })

    def do_POST(self):
        self.record()
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 <= size <= 4096:
            self.reply(413, {"error": "Probe request too large"})
            return
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self.reply(400, {"error": "Invalid JSON"})
            return
        if self.path == "/api/auth/login" and isinstance(body, dict):
            if body.get("token") == "synthetic-probe-pat":
                self.reply(200, {**ACCOUNT, **TOKENS})
                return
        self.reply(404, {"error": "Unsupported probe route"})

    def do_GET(self):
        self.record()
        if self.headers.get("Authorization") != f"Bearer {ACCESS}":
            self.reply(401, {"error": "Unauthorized"})
            return
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/auth/me":
            self.reply(200, ACCOUNT)
        elif parsed.path == "/api/search/sessions":
            filters = {key: params[key][0]
                       for key in ("author", "since", "before", "code_origin")
                       if key in params}
            self.reply(200, {
                "type": "sessions",
                "applied_filters": filters if self.server.acknowledge else {},
                "total": 1, "page": int(params.get("page", ["1"])[0]),
                "per": int(params.get("per", ["10"])[0]),
                "items": [{"agent": "tester/demo", "session_id": "synthetic-session",
                           "excerpt": EXCERPT, "scope": "reply", "runtime": "codex",
                           "line": 2, "turns": 1, "secondhand": False,
                           "outcome": "unknown", "paths": []}],
                "incomplete": False, "unknown": [], "terms": [QUERY],
            })
        else:
            self.reply(404, {"error": "Unsupported probe route"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agit", type=Path, required=True, help="Client binary to execute")
    parser.add_argument("--system-git", action="store_true", help="Use installed Git; keep credential protection")
    parser.add_argument("--output", type=Path, help="Write a local JSON report")
    parser.add_argument("--state-parent", type=Path, help="Trusted existing parent for isolated client state")
    args = parser.parse_args()
    executable = args.agit.expanduser().resolve(strict=True)
    if not executable.is_file():
        parser.error("--agit must name a file")
    work = Path(tempfile.mkdtemp(prefix="agit-headless-probe-", dir=args.state_parent))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.requests = []
    server.acknowledge = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    hub = f"http://127.0.0.1:{server.server_port}"
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith("AGIT_")}
    env.update({"AGIT_HOME": str(work / "agit-home"), "AGIT_HUB_URL": hub,
                "AGIT_QUIET": "1", "AGIT_TELEMETRY_DISABLED": "1", "DO_NOT_TRACK": "1",
                "CI": "1", "NO_COLOR": "1"})
    for key, value in {"HTTP_PROXY": "http://127.0.0.1:1",
                       "HTTPS_PROXY": "http://127.0.0.1:1",
                       "ALL_PROXY": "http://127.0.0.1:1",
                       "NO_PROXY": "127.0.0.1,localhost"}.items():
        env[key] = env[key.lower()] = value
    if args.system_git:
        env["AGIT_USE_SYSTEM_GIT"] = "1"
    report = {"scope": "Synthetic loopback contract probe; no real backend or transcripts",
              "hub": hub, "work_dir": str(work), "steps": [], "status": "blocked"}

    def run(name, command, stdin=None):
        start = len(server.requests)
        proc = subprocess.run([str(executable), *command], input=stdin, text=True,
                              encoding="utf-8", errors="replace", capture_output=True,
                              env=env, cwd=work, timeout=30)
        step = {"name": name, "args": command, "exit_code": proc.returncode,
                "stdout": proc.stdout, "stderr": proc.stderr,
                "requests": list(server.requests[start:])}
        report["steps"].append(step)
        return step

    def require(condition, message):
        if not condition:
            raise AssertionError(message)

    def check_contract():
        version = run("version", ["--version"])
        if version["exit_code"]:
            report["reason"] = "Client startup failed; dependent checks skipped"
            return
        login = run("pat_login", ["login", "--hub", hub, "--with-token", "--json"],
                    "synthetic-probe-pat\n")
        if login["exit_code"]:
            report["reason"] = "Login or credential persistence failed; dependent checks skipped"
            return
        identity = run("authenticated_identity", ["whoami", "--check", "--json"])
        require(identity["exit_code"] == 0, "Authenticated identity check failed")
        require(any(item["path"] == "/api/auth/me" and item["authorization_present"]
                    for item in identity["requests"]), "Identity was not verified with the Hub")
        search = run("cjk_search", ["search", QUERY, "--repo", "tester/demo", "--json"])
        require(search["exit_code"] == 0 and EXCERPT in search["stdout"],
                "CJK search did not preserve the fixture excerpt")
        filtered = run("acknowledged_filter", ["search", QUERY, "--author", "tester", "--json"])
        require(filtered["exit_code"] == 0, "Acknowledged filter was rejected")
        server.acknowledge = False
        rejected = run("unacknowledged_filter", ["search", QUERY, "--author", "tester", "--json"])
        require(rejected["exit_code"] != 0 and "did not acknowledge" in
                rejected["stdout"] + rejected["stderr"], "Unacknowledged filter was silently accepted")
        server.acknowledge = True
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
                "name": "search", "arguments": {"query": QUERY, "repo": "tester/demo"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
                "name": "show", "arguments": {"ref": "tester/demo@main#1"}}},
        ]
        mcp = run("mcp_search_and_local_show", ["mcp"],
                  "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in messages))
        require(mcp["exit_code"] == 0, "MCP process failed")
        responses = {item["id"]: item for item in
                     (json.loads(line) for line in mcp["stdout"].splitlines() if line.strip())}
        search_result = responses[3]["result"]
        require(not search_result.get("isError", False) and
                EXCERPT in json.dumps(search_result, ensure_ascii=False), "MCP search failed")
        show_result = responses[4]["result"]
        require(show_result.get("isError") is True and
                "local" in json.dumps(show_result).lower(), "Expected local-repository show boundary missing")
        report["status"] = "passed"

    try:
        check_contract()
    except (AssertionError, KeyError, ValueError) as error:
        report.update(status="failed", reason=str(error))
    except (OSError, subprocess.TimeoutExpired) as error:
        report.update(status="blocked", reason=str(error))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        report["server_stopped"] = not thread.is_alive()
        report["requests"] = server.requests
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "output": str(args.output.resolve()),
                          "work_dir": str(work), "server_stopped": report["server_stopped"]}))
    else:
        print(output)
    return {"passed": 0, "failed": 1, "blocked": 2}[report["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
