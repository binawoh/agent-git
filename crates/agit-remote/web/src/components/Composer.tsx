import { ArrowUp, ChevronLeft, ChevronRight, File as FileIcon, FolderOpen, Image as ImageIcon, LoaderCircle, Paperclip, Plug, Plus, Server, Slash, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { readImage, toast, uploadFile, withAttachments } from "../store";
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
  /** A local object URL for an image picked on this device, shown before upload finishes. */
  preview?: string;
}

/** A command the agent accepts when a message starts with `/name`. */
export interface SlashCommand {
  name: string;
  description?: string;
}

/** What the agent reported about its extensions, listed from the attachment menu. */
export interface ExtensionInfo {
  mcp: { name: string; status?: string }[];
  plugins: { name: string; detail?: string }[];
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
  commands?: SlashCommand[];
  extensions?: ExtensionInfo | null;
}) {
  const storageKey = props.draftKey ? `agit.draft.${props.draftKey}` : null;
  const [text, setText] = useState(() => (storageKey ? (localStorage.getItem(storageKey) ?? "") : ""));
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [panel, setPanel] = useState<"mcp" | "plugins" | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploading = files.some((file) => file.path === null);
  const slashQuery = /^\/([^\s]*)$/.exec(text)?.[1];
  const slashMatches = slashQuery === undefined ? [] : (props.commands ?? []).filter((command) => command.name.toLowerCase().includes(slashQuery.toLowerCase()));
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashOpen = slashMatches.length > 0 && !slashDismissed;
  useEffect(() => {
    setSlashIndex(0);
    if (slashQuery === undefined) setSlashDismissed(false);
  }, [slashQuery]);

  function pickCommand(command: SlashCommand) {
    setText(`/${command.name} `);
    setSlashDismissed(true);
    area.current?.focus();
  }

  function startSlash() {
    setText("/");
    setSlashDismissed(false);
    area.current?.focus();
  }

  async function upload(list: File[]) {
    const target = props.attach;
    if (!target) return;
    for (const file of list) {
      const key = crypto.randomUUID();
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setFiles((current) => [...current, { key, name: file.name || "image.png", path: null, preview }]);
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
    const cap = window.innerHeight * 0.4;
    element.style.height = `${Math.min(element.scrollHeight, cap)}px`;
    // A scrollbar appears only once the text outgrows the box.
    element.classList.toggle("capped", element.scrollHeight > cap);
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
    if (slashOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((index) => (index + step + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && slashMatches[slashIndex]?.name !== slashQuery)) {
        event.preventDefault();
        pickCommand(slashMatches[slashIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
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
                {imageName.test(file.name) || file.preview ? (
                  <Thumbnail file={file} />
                ) : file.path === null ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <FileIcon size={13} />
                )}
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
        {slashOpen && (
          <div className="slash-menu" role="listbox" aria-label="斜杠命令">
            {slashMatches.map((command, index) => (
              <button
                type="button"
                key={command.name}
                role="option"
                aria-selected={index === slashIndex}
                className={`slash-option ${index === slashIndex ? "active" : ""}`}
                title={command.description}
                onMouseEnter={() => setSlashIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickCommand(command)}
              >
                <span className="slash-name">/{command.name}</span>
                {command.description && <span className="slash-description">{command.description}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="composer-input">
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
                  { label: "添加文件或照片", description: "从这台设备上传，最大 5 MB", icon: <Paperclip size={15} />, onSelect: () => input.current?.click() },
                  { label: "从电脑选择文件", description: "直接引用电脑上的文件", icon: <FolderOpen size={15} />, onSelect: () => setBrowsing(true) },
                  ...(props.commands?.length ? [{ label: "斜杠命令", icon: <Slash size={15} />, onSelect: startSlash }] : []),
                  ...(props.extensions ? [{ label: "MCP 服务器", icon: <Server size={15} />, onSelect: () => setPanel("mcp") }] : []),
                  ...(props.extensions ? [{ label: "插件", icon: <Plug size={15} />, onSelect: () => setPanel("plugins") }] : []),
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
          </div>
        </div>
      {panel && props.extensions && <ExtensionPanel kind={panel} info={props.extensions} onClose={() => setPanel(null)} />}
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

/** The picture of an image attachment: the local copy while it uploads, otherwise the file as
 *  saved on the machine. A tap shows it full size. */
function Thumbnail({ file }: { file: Attachment }) {
  const [remote, setRemote] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (file.preview || !file.path) return;
    let cancelled = false;
    void readImage(file.path).then((url) => {
      if (!cancelled) setRemote(url);
    });
    return () => {
      cancelled = true;
    };
  }, [file.preview, file.path]);
  const url = file.preview ?? remote;
  if (!url) return file.path === null ? <LoaderCircle size={13} className="spin" /> : <ImageIcon size={13} />;
  return (
    <>
      <button type="button" className="attachment-thumb" title="查看大图" onClick={() => setZoomed(true)}>
        <img src={url} alt={file.name} />
        {file.path === null && <LoaderCircle size={14} className="spin attachment-thumb-busy" />}
      </button>
      {zoomed && (
        <div className="image-viewer" onClick={() => setZoomed(false)}>
          <img src={url} alt={file.name} />
        </div>
      )}
    </>
  );
}

/** The agent's MCP servers or plugins, as it reported them when it started. */
function ExtensionPanel({ kind, info, onClose }: { kind: "mcp" | "plugins"; info: ExtensionInfo; onClose: () => void }) {
  const rows = kind === "mcp" ? info.mcp.map((server) => ({ name: server.name, detail: server.status })) : info.plugins;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog extension-panel" onClick={(event) => event.stopPropagation()}>
        <h3>
          <button type="button" className="icon-button small" title="关闭" onClick={onClose}>
            <ChevronLeft size={16} />
          </button>
          {kind === "mcp" ? "MCP 服务器" : "插件"}
        </h3>
        {rows.length === 0 ? (
          <p className="muted">{kind === "mcp" ? "这个会话没有连接 MCP 服务器。" : "这个会话没有启用插件。"}</p>
        ) : (
          <ul className="extension-list">
            {rows.map((row) => (
              <li key={row.name}>
                <span className="extension-name">{row.name}</span>
                {row.detail && <span className={`extension-status ${row.detail}`}>{statusText(row.detail)}</span>}
                <ChevronRight size={14} className="extension-chevron" />
              </li>
            ))}
          </ul>
        )}
        <p className="muted extension-note">以 agent 启动时报告的为准。</p>
      </div>
    </div>
  );
}

function statusText(status: string): string {
  const names: Record<string, string> = { connected: "已连接", failed: "连接失败", pending: "连接中", "needs-auth": "需要授权", disabled: "已停用" };
  return names[status] ?? status;
}
