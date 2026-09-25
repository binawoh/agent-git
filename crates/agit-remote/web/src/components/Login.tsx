import { useEffect, useState, type FormEvent } from "react";
import { devLogin } from "../api";
import { signIn } from "../store";

export function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dev, setDev] = useState(false);

  useEffect(() => {
    void devLogin().then(setDev, () => {});
  }, []);

  async function submit(event: FormEvent | null, development = false) {
    event?.preventDefault();
    if (!development && !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(development ? null : token.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark">A</div>
        <h1>AgentGit Remote</h1>
        <p className="muted">用你 Hub 的个人访问令牌（PAT）登录。</p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="agsh_pat_…"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoFocus
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="primary" disabled={busy || !token.trim()}>
          {busy ? "登录中…" : "登录"}
        </button>
        {dev && (
          <button type="button" disabled={busy} onClick={() => void submit(null, true)}>
            开发登录（本地测试实例）
          </button>
        )}
      </form>
    </div>
  );
}
