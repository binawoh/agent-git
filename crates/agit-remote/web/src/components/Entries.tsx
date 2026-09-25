import {
  Bot,
  Brain,
  ChevronRight,
  FileText,
  Globe,
  ListChecks,
  LoaderCircle,
  Pencil,
  Search,
  ShieldAlert,
  Terminal,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { decide } from "../store";
import type { Entry } from "../transcript";
import { MarkdownText } from "./Markdown";

type ToolEntry = Extract<Entry, { type: "tool" }>;
type ReasoningEntry = Extract<Entry, { type: "reasoning" }>;
type Block = Entry | { type: "steps"; id: string; entries: (ToolEntry | ReasoningEntry)[] };

/** Consecutive tool calls and reasoning collapse into one card, as in Claude Code. */
export function blocks(entries: Entry[]): Block[] {
  const result: Block[] = [];
  for (const entry of entries) {
    if (entry.type === "tool" || entry.type === "reasoning") {
      const last = result[result.length - 1];
      if (last?.type === "steps") last.entries.push(entry);
      else result.push({ type: "steps", id: `steps:${entry.id}`, entries: [entry] });
    } else {
      result.push(entry);
    }
  }
  return result;
}

export function EntryView({ block, sessionId }: { block: Block; sessionId: string }) {
  switch (block.type) {
    case "user":
      return <div className={`user-bubble ${block.pending ? "pending" : ""}`}>{block.text}</div>;
    case "assistant":
      return (
        <div className="assistant">
          <MarkdownText text={block.text} />
          {block.streaming && <span className="caret" />}
        </div>
      );
    case "steps":
      return (
        <div className="steps">
          {block.entries.map((entry) => (entry.type === "tool" ? <ToolRow key={entry.id} entry={entry} /> : <ReasoningRow key={entry.id} entry={entry} />))}
        </div>
      );
    case "approval":
      return <ApprovalCard sessionId={sessionId} entry={block} />;
    case "notice":
      return <div className={`notice ${block.tone}`}>{block.text}</div>;
    default:
      return null;
  }
}

function toolIcon(tool: string): ReactNode {
  const name = tool.toLowerCase();
  if (/bash|shell|exec|command|powershell/.test(name)) return <Terminal size={15} />;
  if (/read|view|cat/.test(name)) return <FileText size={15} />;
  if (/edit|write|patch|apply/.test(name)) return <Pencil size={15} />;
  if (/grep|glob|search|find|ls/.test(name)) return <Search size={15} />;
  if (/web|fetch|url|browser/.test(name)) return <Globe size={15} />;
  if (/task|agent/.test(name)) return <Bot size={15} />;
  if (/todo|plan/.test(name)) return <ListChecks size={15} />;
  return <Wrench size={15} />;
}

function ToolRow({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const detail = entry.input || entry.output;
  return (
    <div className={`step ${open ? "open" : ""}`}>
      <button className="step-head" onClick={() => detail && setOpen(!open)} disabled={!detail}>
        <span className="step-icon">{entry.streaming ? <LoaderCircle size={15} className="spin" /> : toolIcon(entry.tool)}</span>
        <span className="step-name">{entry.tool}</span>
        <span className="step-summary">{entry.summary}</span>
        {entry.failed && <span className="step-failed">失败</span>}
        {detail && <ChevronRight size={14} className="chevron" />}
      </button>
      {open && (
        <div className="step-body">
          {entry.input && <pre className="step-pre">{entry.input}</pre>}
          {entry.output && <pre className={`step-pre output ${entry.failed ? "failed" : ""}`}>{entry.output}</pre>}
        </div>
      )}
    </div>
  );
}

function ReasoningRow({ entry }: { entry: ReasoningEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`step ${open ? "open" : ""}`}>
      <button className="step-head" onClick={() => entry.text && setOpen(!open)} disabled={!entry.text}>
        <span className="step-icon">{entry.streaming ? <LoaderCircle size={15} className="spin" /> : <Brain size={15} />}</span>
        <span className="step-name">思考</span>
        <span className="step-summary">{entry.text.split("\n")[0]}</span>
        {entry.text && <ChevronRight size={14} className="chevron" />}
      </button>
      {open && (
        <div className="step-body">
          <MarkdownText text={entry.text} />
        </div>
      )}
    </div>
  );
}

const approvalTitle: Record<string, string> = {
  exec: "要执行这条命令吗？",
  file_change: "要修改这些文件吗？",
  permission_escalation: "需要更高的权限",
};

const decidedText: Record<string, string> = {
  allow: "已允许",
  allow_session: "已允许（本会话）",
  deny: "已拒绝",
  expired: "已失效",
};

function preview(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "content", "patch", "new_string"]) {
      const field = value[key];
      if (typeof field === "string") return field;
      if (Array.isArray(field)) return field.join(" ");
    }
    return JSON.stringify(input, null, 2);
  }
  return "";
}

function ApprovalCard({ sessionId, entry }: { sessionId: string; entry: Extract<Entry, { type: "approval" }> }) {
  const [busy, setBusy] = useState(false);
  const request = entry.request;
  const detail = preview(request.input);
  const act = async (decision: "allow" | "deny", scope: "once" | "session" = "once") => {
    setBusy(true);
    await decide(sessionId, request.approval_id, decision, scope);
    setBusy(false);
  };
  return (
    <div className={`approval ${entry.decided ? "decided" : ""}`}>
      <div className="approval-title">
        <ShieldAlert size={16} />
        {approvalTitle[request.kind] ?? "需要你确认"}
        {request.tool && <span className="tag subtle">{request.tool}</span>}
      </div>
      {request.summary && <div className="approval-summary">{request.summary}</div>}
      {detail && detail !== request.summary && <pre className="step-pre">{detail}</pre>}
      {request.paths && request.paths.length > 0 && <div className="approval-paths">{request.paths.join("\n")}</div>}
      {entry.decided ? (
        <div className="approval-result">{decidedText[entry.decided] ?? entry.decided}</div>
      ) : (
        <div className="approval-actions">
          <button className="primary" disabled={busy} onClick={() => void act("allow")}>
            允许
          </button>
          {request.can_allow_for_session && request.suggested_permission_mode && (
            <button disabled={busy} onClick={() => void act("allow", "session")}>
              本会话都允许
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => void act("deny")}>
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
