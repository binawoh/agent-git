import { ArrowUp, File as FileIcon, FolderOpen, Image as ImageIcon, LoaderCircle, Plus, Square, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { toast, uploadFile, withAttachments } from "../store";
import { FilePicker } from "./FilePicker";
import { ActionMenu } from "./Menu";

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

const imageName = /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i;

/** The prompt box: the text, and under it a toolbar with the attachment menu and `left`
 *  controls on one side, `right` controls and the send button on the other. `footer` sits
 *  below the box. */
export function Composer(props: {
  placeholder: string;
  disabled?: boolean;
  running?: boolean;
  draftKey?: string;
  onSubmit: (text: string) => Promise<void> | void;
  onStop?: () => void;
  attach?: AttachTarget | null;
  left?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
}) {
  const storageKey = props.draftKey ? `agit.draft.${props.draftKey}` : null;
  const [text, setText] = useState(() => (storageKey ? (localStorage.getItem(storageKey) ?? "") : ""));
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploading = files.some((file) => file.path === null);

  async function upload(list: File[]) {
    const target = props.attach;
    if (!target) return;
    for (const file of list) {
      const key = crypto.randomUUID();
      setFiles((current) => [...current, { key, name: file.name || "image.png", path: null }]);
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

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!props.attach || props.disabled || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (!props.attach || props.disabled || !event.dataTransfer.files.length) return;
    event.preventDefault();
    void upload([...event.dataTransfer.files]);
  }

  /** A click on the box's empty space focuses the text; controls keep the focus they take,
   *  so opening a menu on a phone does not raise the keyboard. */
  function focusFromBox(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target as HTMLElement).closest("button, input, .menu-popover")) area.current?.focus();
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

  const canSend = (text.trim() !== "" || files.length > 0) && !props.disabled && !sending && !uploading;
  return (
    <div className="composer">
      <div
        className={`composer-box ${props.disabled ? "disabled" : ""} ${dragging ? "dragging" : ""}`}
        onClick={focusFromBox}
        onDragOver={dragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        {files.length > 0 && (
          <div className="attachments">
            {files.map((file) => (
              <span key={file.key} className={`attachment ${file.path ? "" : "uploading"}`} title={file.path ?? "上传中…"}>
                {file.path === null ? <LoaderCircle size={13} className="spin" /> : imageName.test(file.name) ? <ImageIcon size={13} /> : <FileIcon size={13} />}
                <span className="attachment-name">{file.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  title="移除"
                  onClick={() => setFiles((current) => current.filter((item) => item.key !== file.key))}
                >
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
        <div className="composer-toolbar">
          <div className="toolbar-side">
            {props.attach && (
              <ActionMenu
                placement="top"
                trigger={(open, toggle) => (
                  <button type="button" className={`toolbar-icon ${open ? "active" : ""}`} title="添加文件" aria-label="添加文件" onClick={toggle}>
                    <Plus size={18} />
                  </button>
                )}
                items={[
                  { label: "从电脑选择文件", description: "直接引用电脑上的文件", icon: <FolderOpen size={15} />, onSelect: () => setBrowsing(true) },
                  { label: "从这台设备上传", description: "上传到项目文件夹，最大 5 MB", icon: <Upload size={15} />, onSelect: () => input.current?.click() },
                ]}
              />
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
            {props.left}
          </div>
          <div className="toolbar-side right">
            {props.right}
            {props.running && props.onStop && !canSend ? (
              <button type="button" className="send-button stop" title="中断" aria-label="中断" onClick={props.onStop}>
                <Square size={11} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button type="button" className={`send-button ${canSend ? "ready" : ""}`} title="发送" aria-label="发送" disabled={!canSend} onClick={() => void submit()}>
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
      {props.footer && <div className="composer-footer">{props.footer}</div>}
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
