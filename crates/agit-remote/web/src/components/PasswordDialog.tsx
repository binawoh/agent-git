import { useState, type FormEvent } from "react";
import { setPassword } from "../api";
import { refreshMe, toast, useStore } from "../store";

const MIN_LENGTH = 10;

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const me = useStore((state) => state.me);
  // Proving the current password is required only when this session signed in with it.
  const needsCurrent = Boolean(me?.password_login && me.signed_in_with === "password");
  const [current, setCurrent] = useState("");
  const [password, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ([...password].length < MIN_LENGTH) return setError(`密码至少 ${MIN_LENGTH} 个字符`);
    if (password !== confirm) return setError("两次输入的密码不一样");
    setBusy(true);
    setError(null);
    try {
      await setPassword(needsCurrent ? current : null, password);
      await refreshMe();
      toast("登录密码已设置，其他用旧密码登录的设备已下线", "info");
      onClose();
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setError(text === "wrong password" ? "当前密码不对" : text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && onClose()} onSubmit={submit}>
        <h3>{me?.password_login ? "修改登录密码" : "设置登录密码"}</h3>
        <p className="muted">以后在网页上用这个密码登录，不需要再输入令牌。至少 {MIN_LENGTH} 个字符。</p>
        {needsCurrent && (
          <input type="password" autoComplete="current-password" placeholder="当前密码" value={current} onChange={(event) => setCurrent(event.target.value)} autoFocus />
        )}
        <input
          type="password"
          autoComplete="new-password"
          placeholder="新密码"
          value={password}
          onChange={(event) => setNewPassword(event.target.value)}
          autoFocus={!needsCurrent}
        />
        <input type="password" autoComplete="new-password" placeholder="再输入一次" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !password || !confirm || (needsCurrent && !current)}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
