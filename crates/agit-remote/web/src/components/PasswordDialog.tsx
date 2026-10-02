import { useState, type FormEvent } from "react";
import { setPassword } from "../api";
import { t } from "../i18n";
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
    if ([...password].length < MIN_LENGTH) return setError(t.password.tooShort(MIN_LENGTH));
    if (password !== confirm) return setError(t.password.mismatch);
    setBusy(true);
    setError(null);
    try {
      await setPassword(needsCurrent ? current : null, password);
      await refreshMe();
      toast(t.password.saved, "info");
      onClose();
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setError(text === "wrong password" ? t.password.wrongCurrent : text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && onClose()} onSubmit={submit}>
        <h3>{me?.password_login ? t.password.change : t.password.set}</h3>
        <p className="muted">{t.password.explain(MIN_LENGTH)}</p>
        {needsCurrent && (
          <input type="password" autoComplete="current-password" placeholder={t.password.current} value={current} onChange={(event) => setCurrent(event.target.value)} autoFocus />
        )}
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t.password.next}
          value={password}
          onChange={(event) => setNewPassword(event.target.value)}
          autoFocus={!needsCurrent}
        />
        <input type="password" autoComplete="new-password" placeholder={t.password.repeat} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className="primary" disabled={busy || !password || !confirm || (needsCurrent && !current)}>
            {busy ? t.common.saving : t.common.save}
          </button>
        </div>
      </form>
    </div>
  );
}
