import { ArrowUp, Check, File as FileIcon, Folder, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { displayPath, readDirectory, type DirectoryListing } from "../store";

/** Browses the machine's files, starting in the project, and returns the chosen paths. */
export function FilePicker(props: { start: string; onPick: (paths: string[]) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);

  async function go(path: string) {
    setLoading(true);
    setError(null);
    try {
      setListing(await readDirectory(path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void go(props.start);
  }, [props.start]);

  const here = listing?.path ?? props.start;
  const separator = here.includes("\\") ? "\\" : "/";
  const join = (name: string) => `${here.replace(/[\\/]+$/, "")}${separator}${name}`;
  const parent = here.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
  const toggle = (path: string) => setChosen((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog picker-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>从电脑选择文件</h3>
        <div className="picker-path">
          <button className="icon-button small" title="上一级" disabled={!parent || parent === here} onClick={() => void go(parent)}>
            <ArrowUp size={14} />
          </button>
          <span title={displayPath(here)}>{displayPath(here)}</span>
        </div>
        <div className="picker-list">
          {loading && (
            <div className="loading">
              <LoaderCircle size={16} className="spin" />
            </div>
          )}
          {error && <div className="login-error">{error}</div>}
          {!loading &&
            listing?.entries.map((entry) => {
              const path = join(entry.name);
              const picked = chosen.includes(path);
              return (
                <button key={entry.name} className={`picker-entry ${picked ? "picked" : ""}`} onClick={() => (entry.is_dir ? void go(path) : toggle(path))}>
                  {entry.is_dir ? <Folder size={15} /> : <FileIcon size={15} />}
                  <span>{entry.name}</span>
                  {picked && <Check size={14} />}
                </button>
              );
            })}
          {!loading && listing?.entries.length === 0 && <div className="group-empty">空文件夹</div>}
        </div>
        <div className="dialog-actions">
          <button onClick={props.onClose}>取消</button>
          <button className="primary" disabled={!chosen.length} onClick={() => props.onPick(chosen)}>
            添加 {chosen.length ? `${chosen.length} 个文件` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
