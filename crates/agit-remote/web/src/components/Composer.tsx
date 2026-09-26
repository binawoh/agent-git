import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
  children?: ReactNode;
}) {
  const storageKey = props.draftKey ? `agit.draft.${props.draftKey}` : null;
  const [text, setText] = useState(() => (storageKey ? (localStorage.getItem(storageKey) ?? "") : ""));
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

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
    const value = text.trim();
    if (!value || props.disabled || sending) return;
    setSending(true);
    setText("");
    try {
      await props.onSubmit(value);
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
      <textarea
        ref={area}
        rows={1}
        value={text}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keyDown}
      />
      <div className="composer-bar">
        <div className="composer-controls">{props.children}</div>
        {props.running && props.onStop && (
          <button className="round stop" title="中断" onClick={props.onStop}>
            <Square size={13} fill="currentColor" />
          </button>
        )}
        <button className="round send" title="发送" disabled={!text.trim() || props.disabled || sending} onClick={() => void submit()}>
          <ArrowUp size={17} />
        </button>
      </div>
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
