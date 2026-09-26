import { useEffect, useState, type FormEvent } from "react";
import { options, type Credential } from "../api";
import { signIn } from "../store";
import { BrandMark } from "./Brand";

export function Login() {
  const [mode, setMode] = useState<"password" | "token">("token");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dev, setDev] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);

  useEffect(() => {
    void options().then((result) => {
      setDev(result.dev_login);
      setHasPassword(result.password_login);
      if (result.password_login) setMode("password");
    });
  }, []);

  async function submit(credential: Credential) {
    setBusy(true);
    setError(null);
    try {
      await signIn(credential);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setError(text === "wrong password" ? "密码不对" : text);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = mode === "password" ? value : value.trim();
    if (text) void submit(mode === "password" ? { password: text } : { token: text });
  }

  function switchMode(next: "password" | "token") {
    setMode(next);
    setValue("");
    setError(null);
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={onSubmit}>
        <BrandMark size={44} />
        <h1>AgentGit Remote</h1>
        <p className="muted">{mode === "password" ? "输入你设置的登录密码。" : "用 Hub 的个人访问令牌（PAT）登录。"}</p>
        <input
          key={mode}
          type="password"
          autoComplete={mode === "password" ? "current-password" : "off"}
          placeholder={mode === "password" ? "密码" : "agsh_pat_…"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="primary" disabled={busy || !value}>
          {busy ? "登录中…" : "登录"}
        </button>
        {hasPassword && (
          <button type="button" className="link" onClick={() => switchMode(mode === "password" ? "token" : "password")}>
            {mode === "password" ? "忘了密码？用访问令牌登录" : "用密码登录"}
          </button>
        )}
        {dev && (
          <button type="button" disabled={busy} onClick={() => void submit({ dev: true })}>
            开发登录（本地测试实例）
          </button>
        )}
      </form>
    </div>
  );
}
