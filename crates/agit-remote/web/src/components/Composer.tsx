import { ArrowUp, FolderOpen, Paperclip, Plus, Square, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast, uploadFile, withAttachments } from "../store";
import { FilePicker } from "./FilePicker";

/** Where attachments go: files picked on the machine are referenced where they are; files
 *  from this device are uploaded into the project first. */
export interface AttachTarget {
  projectId: string;
  root: string;
}

interface Attachment {
  key: string;
  name: string;
  path: string | null;
}

/** Enter sends on devices with a keyboard; an IME composition never sends (it confirms a
 *  candidate), and touch keyboards insert a newline so sending is always the button. */
const coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function Composer(props: {
  placeholder: string;
  disabled?: boolean;
  running?: boolean;
  draftKey?: string;
  onSubmit: (text: string) => Promise<void> | void;
  onStop?: () => void;
  attach?: AttachTarget | null;
  children?: ReactNode;
}) {
  const storageKey = props.draftKey ? `agit.draft.${props.draftKey}` : null;
  const [text, setText] = useState(() => (storageKey ? (localStorage.getItem(storageKey) ?? "") : ""));
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploading = files.some((file) => file.path === null);

  async function upload(list: File[]) {
    const target = props.attach;
    if (!target) return;
    for (const file of list) {
      const key = crypto.randomUUID();
      setFiles((current) => [...current, { key, name: file.name || "image", path: null }]);
      try {
        const saved = await uploadFile(target.projectId, file);
        setFiles((current) => current.map((item) => (item.key === key ? { ...item, path: saved } : item)));
      } catch (error) {
        setFiles((current) => current.filter((item) => item.key !== key));
        toast(`上传失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!images.length || !props.attach) return;
    event.preventDefault();
    void upload(images);
  }

  useEffect(() => {
    if (!storageKey) return;
    if (text) localStorage.setItem(storageKey, text);
    else localStorage.removeItem(storageKey);
  }, [storageKey, text]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  async function submit() {
    const paths = files.flatMap((file) => (file.path ? [file.path] : []));
    const value = text.trim() || (paths.length ? "请看附件。" : "");
    if (!value || props.disabled || sending || uploading) return;
    setSending(true);
    setText("");
    setFiles([]);
    try {
      await props.onSubmit(withAttachments(value, paths));
    } finally {
      setSending(false);
      area.current?.focus();
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 || coarsePointer) return;
    event.preventDefault();
    void submit();
  }

  return (
    <div className="composer">
      {files.length > 0 && (
        <div className="attachments">
          {files.map((file) => (
            <span key={file.key} className={`attachment ${file.path ? "" : "uploading"}`} title={file.path ?? "上传中…"}>
              <Paperclip size={12} />
              {file.name}
              <button className="icon-button small" title="移除" onClick={() => setFiles((current) => current.filter((item) => item.key !== file.key))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        onPaste={paste}
        ref={area}
        rows={1}
        value={text}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="composer-bar">
        {props.attach && (
          <div className="attach-menu-anchor">
            <button className="icon-button" title="添加文件" onClick={() => setMenu(!menu)}>
              <Plus size={17} />
            </button>
            {menu && (
              <div className="attach-menu" onMouseLeave={() => setMenu(false)}>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(false);
                    setBrowsing(true);
                  }}
                >
                  <FolderOpen size={14} /> 从电脑选择文件
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(false);
                    input.current?.click();
                  }}
                >
                  <Upload size={14} /> 从这台设备上传
                </button>
              </div>
            )}
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void upload([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
          </div>
        )}
        <div className="composer-controls">{props.children}</div>
        {props.running && props.onStop && (
          <button className="round stop" title="中断" onClick={props.onStop}>
            <Square size={13} fill="currentColor" />
          </button>
        )}
        <button className="round send" title="发送" disabled={(!text.trim() && !files.length) || props.disabled || sending || uploading} onClick={() => void submit()}>
          <ArrowUp size={17} />
        </button>
      </div>
      {browsing && props.attach && (
        <FilePicker
          start={props.attach.root}
          onClose={() => setBrowsing(false)}
          onPick={(paths) => {
            setBrowsing(false);
            setFiles((current) => [...current, ...paths.map((picked) => ({ key: crypto.randomUUID(), name: picked.split(/[\\/]/).pop() ?? picked, path: picked }))]);
          }}
        />
      )}
    </div>
  );
}

export function Picker(props: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <select className="picker" title={props.title} value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
