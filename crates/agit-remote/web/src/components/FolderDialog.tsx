import { useState, type FormEvent } from "react";
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
      toast("已添加文件夹", "info");
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
        <h3>添加项目文件夹</h3>
        <p className="muted">填入电脑上的项目文件夹路径，例如 D:\codex\my-project。</p>
        <input
          autoFocus
          placeholder="文件夹路径"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !path.trim()}>
            {busy ? "添加中…" : "添加"}
          </button>
        </div>
      </form>
    </div>
  );
}
