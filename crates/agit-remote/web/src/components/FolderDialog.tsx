import { useState, type FormEvent } from "react";
import { t } from "../i18n";
import { bindProject, toast } from "../store";

/** Binds a folder on the machine as a project. */
export function FolderDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = path.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await bindProject(value);
      toast(t.folder.added, "info");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && onClose()} onSubmit={submit}>
        <h3>{t.folder.title}</h3>
        <p className="muted">{t.folder.explain}</p>
        <input
          autoFocus
          placeholder={t.folder.placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className="primary" disabled={busy || !path.trim()}>
            {busy ? t.common.adding : t.common.add}
          </button>
        </div>
      </form>
    </div>
  );
}
