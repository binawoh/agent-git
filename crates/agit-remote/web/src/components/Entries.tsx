import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Plug,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { decide } from "../store";
import type { Entry } from "../transcript";
import { MarkdownText } from "./Markdown";
import { commandOf, diffOf, parseInput, shortPath, stepKind, stepVerb, summarize, todosOf, type Diff, type StepKind, type Todo } from "./steps";
import { UserMessage } from "./UserMessage";

type ToolEntry = Extract<Entry, { type: "tool" }>;
type ReasoningEntry = Extract<Entry, { type: "reasoning" }>;
type Step = ToolEntry | ReasoningEntry;
type Block = Entry | { type: "steps"; id: string; entries: Step[] };

/** Consecutive tool calls and reasoning collapse into one block, summarised in one line. */
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

/** `live` marks the newest block of a running turn: its steps stay open while the agent works
 *  and fold into their summary once it moves on. */
export function EntryView({ block, sessionId, live }: { block: Block; sessionId: string; live?: boolean }) {
  switch (block.type) {
    case "user":
      return <UserMessage text={block.text} pending={block.pending} />;
    case "assistant":
      return (
        <div className="assistant">
          <MarkdownText text={block.text} />
          {block.streaming && <span className="caret" />}
        </div>
      );
    case "steps":
      return <Steps entries={block.entries} live={live} />;
    case "approval":
      return <ApprovalCard sessionId={sessionId} entry={block} />;
    case "notice":
      return block.tone === "error" ? (
        <div className="notice error">
          <CircleAlert size={15} />
          <span>{block.text}</span>
        </div>
      ) : (
        <div className="notice divider">
          <span>{block.text}</span>
        </div>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------- steps

interface StepView {
  kind: StepKind;
  verb: string;
  target: string;
  title: string;
  input: unknown;
  command: string | null;
  diff: Diff | null;
  todos: Todo[] | null;
}

// Entries keep their identity until their content changes, so a streamed delta re-describes
// only the entry it touched instead of re-diffing every edit on screen.
const described = new WeakMap<ToolEntry, StepView>();

function describe(entry: ToolEntry): StepView {
  let view = described.get(entry);
  if (!view) {
    view = describeUncached(entry);
    described.set(entry, view);
  }
  return view;
}

function describeUncached(entry: ToolEntry): StepView {
  const kind = stepKind(entry.tool);
  const input = parseInput(entry.input);
  const command = kind === "command" ? commandOf(input) : null;
  const diff = kind === "edit" || kind === "write" ? diffOf(input) : null;
  const todos = kind === "todo" ? todosOf(input) : null;
  const files = diff?.lines.filter((line) => line.type === "file").map((line) => line.text) ?? [];
  let target = entry.summary;
  let title = entry.summary;
  if (command) target = title = command.split("\n")[0];
  else if (files.length) {
    target = files.length > 1 ? `${shortPath(files[0])} 等 ${files.length} 个文件` : shortPath(files[0]);
    title = files.join("\n");
  } else if (kind === "read" || kind === "edit" || kind === "write") target = shortPath(entry.summary);
  else if (todos) target = `${todos.filter((todo) => todo.status === "completed").length}/${todos.length} 已完成`;
  return { kind, verb: stepVerb(kind, entry.tool), target, title, input, command, diff, todos };
}

function kindIcon(kind: StepKind): ReactNode {
  const size = 15;
  switch (kind) {
    case "command":
      return <SquareTerminal size={size} />;
    case "read":
      return <FileText size={size} />;
    case "edit":
      return <FilePen size={size} />;
    case "write":
      return <FilePlus size={size} />;
    case "search":
      return <Search size={size} />;
    case "web":
      return <Globe size={size} />;
    case "agent":
      return <Bot size={size} />;
    case "todo":
      return <ListChecks size={size} />;
    case "plan":
      return <ClipboardList size={size} />;
    case "mcp":
      return <Plug size={size} />;
    default:
      return <Wrench size={size} />;
  }
}

function Steps({ entries, live }: { entries: Step[]; live?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const views = entries.map((entry) => (entry.type === "tool" ? describe(entry) : null));
  const active = Boolean(live) || entries.some((entry) => entry.streaming);
  const rows = entries.map((entry, index) =>
    entry.type === "tool" ? <ToolRow key={entry.id} entry={entry} view={views[index]!} /> : <ReasoningRow key={entry.id} entry={entry} />,
  );
  if (entries.length === 1) return <div className="steps single">{rows}</div>;

  const expanded = open ?? active;
  const tools = views.filter((view): view is StepView => view !== null);
  const summary = summarize(entries.map((entry, index) => (entry.type === "tool" ? { kind: views[index]!.kind, target: entry.summary } : { kind: "reasoning", target: "" })));
  const added = tools.reduce((total, view) => total + (view.diff?.added ?? 0), 0);
  const removed = tools.reduce((total, view) => total + (view.diff?.removed ?? 0), 0);
  const failed = entries.some((entry) => entry.type === "tool" && entry.failed);
  const counts = new Map<StepKind, number>();
  for (const view of tools) counts.set(view.kind, (counts.get(view.kind) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (
    <div className={`steps ${expanded ? "expanded" : ""}`}>
      <button type="button" className="steps-summary" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span className="step-icon">{active ? <LoaderCircle size={15} className="spin" /> : main ? kindIcon(main) : <Lightbulb size={15} />}</span>
        <span className="steps-text">{summary || `${entries.length} 个步骤`}</span>
        {(added > 0 || removed > 0) && <DiffStat added={added} removed={removed} />}
        {failed && <span className="step-failed">有失败</span>}
        <ChevronRight size={14} className="chevron" />
      </button>
      {expanded && <div className="timeline">{rows}</div>}
    </div>
  );
}

function ToolRow({ entry, view }: { entry: ToolEntry; view: StepView }) {
  const [open, setOpen] = useState(false);
  const detail = Boolean(entry.input || entry.output);
  return (
    <div className={`step ${open ? "open" : ""} ${entry.failed ? "failed" : ""}`}>
      <button type="button" className="step-head" aria-expanded={open} disabled={!detail} onClick={() => setOpen(!open)}>
        <span className="step-icon">{entry.streaming ? <LoaderCircle size={15} className="spin" /> : kindIcon(view.kind)}</span>
        <span className="step-verb">{view.verb}</span>
        <span className={`step-target ${view.kind === "command" ? "mono" : ""}`} title={view.title}>
          {view.target}
        </span>
        {view.diff && <DiffStat added={view.diff.added} removed={view.diff.removed} />}
        {entry.failed && <span className="step-failed">失败</span>}
        {detail && <ChevronRight size={14} className="chevron" />}
      </button>
      {open && <StepDetail entry={entry} view={view} />}
    </div>
  );
}

function StepDetail({ entry, view }: { entry: ToolEntry; view: StepView }) {
  const output = entry.output.trim() ? entry.output : "";
  const hasFiles = view.diff?.lines.some((line) => line.type === "file");
  let body: ReactNode = null;
  if (view.todos) body = <TodoList todos={view.todos} />;
  else if (view.command !== null) body = <CommandView command={view.command} />;
  else if (view.diff) body = <DiffView diff={view.diff} path={hasFiles ? undefined : entry.summary} />;
  else if (view.kind === "read") body = entry.summary ? <div className="step-caption">{entry.summary}</div> : null;
  else if (entry.input) body = <pre className="step-pre">{typeof view.input === "string" ? view.input : JSON.stringify(view.input, null, 2)}</pre>;
  // A successful change needs no confirmation text below its diff.
  const showOutput = output && !((view.diff || view.todos) && !entry.failed);
  return (
    <div className="step-body">
      {body}
      {showOutput && <pre className={`step-pre output ${entry.failed ? "failed" : ""}`}>{output}</pre>}
    </div>
  );
}

function ReasoningRow({ entry }: { entry: ReasoningEntry }) {
  const [open, setOpen] = useState(false);
  const first = entry.text.trim().split("\n")[0].replace(/^\*\*(.*)\*\*$/, "$1");
  return (
    <div className={`step reasoning ${open ? "open" : ""}`}>
      <button type="button" className="step-head" aria-expanded={open} disabled={!entry.text} onClick={() => setOpen(!open)}>
        <span className="step-icon">{entry.streaming ? <LoaderCircle size={15} className="spin" /> : <Lightbulb size={15} />}</span>
        <span className="step-verb">思考</span>
        <span className="step-target thought">{first}</span>
        {entry.text && <ChevronRight size={14} className="chevron" />}
      </button>
      {open && (
        <div className="step-body">
          <div className="thinking">
            <MarkdownText text={entry.text} />
          </div>
        </div>
      )}
    </div>
  );
}

function CommandView({ command }: { command: string }) {
  return (
    <pre className="step-pre command">
      <span className="prompt">$ </span>
      {command}
    </pre>
  );
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">-{removed}</span>}
    </span>
  );
}

function DiffView({ diff, path }: { diff: Diff; path?: string }) {
  return (
    <div className="diff">
      {path && <div className="diff-line file">{path}</div>}
      {diff.lines.map((line, index) => (
        <div key={index} className={`diff-line ${line.type}`}>
          {line.type === "file" || line.type === "gap" ? (
            line.text
          ) : (
            <>
              <span className="diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
              <span className="diff-text">{line.text || " "}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo, index) => (
        <li key={index} className={`todo ${todo.status}`}>
          {todo.status === "completed" ? <CircleCheck size={15} /> : todo.status === "in_progress" ? <CircleDot size={15} /> : <Circle size={15} />}
          <span>{todo.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------- approvals

const approvalTitle: Record<string, string> = {
  exec: "要运行这条命令吗？",
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
  const input = typeof request.input === "string" ? parseInput(request.input) : request.input;
  const command = request.kind === "exec" ? (commandOf(input) ?? (typeof input === "string" ? input : null)) : null;
  const diff = command === null ? diffOf(input) : null;
  const detail = preview(request.input);
  const path = input && typeof input === "object" && typeof (input as Record<string, unknown>).file_path === "string" ? String((input as Record<string, unknown>).file_path) : undefined;
  const act = async (decision: "allow" | "deny", scope: "once" | "session" = "once") => {
    setBusy(true);
    await decide(sessionId, request.approval_id, decision, scope);
    setBusy(false);
  };
  return (
    <div className={`approval ${entry.decided ? "decided" : ""}`}>
      <div className="approval-head">
        <ShieldAlert size={16} />
        <span className="approval-title">{approvalTitle[request.kind] ?? "需要你确认"}</span>
        {request.tool && <span className="tag">{request.tool}</span>}
      </div>
      {request.summary && request.summary !== command && <div className="approval-summary">{request.summary}</div>}
      {command !== null ? (
        <CommandView command={command} />
      ) : diff ? (
        <DiffView diff={diff} path={path} />
      ) : (
        detail && detail !== request.summary && <pre className="step-pre">{detail}</pre>
      )}
      {request.paths && request.paths.length > 0 && <div className="approval-paths">{request.paths.join("\n")}</div>}
      {entry.decided ? (
        <div className={`approval-result ${entry.decided}`}>
          {entry.decided === "deny" || entry.decided === "expired" ? <X size={14} /> : <Check size={14} />}
          {decidedText[entry.decided] ?? entry.decided}
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void act("allow")}>
            允许
          </button>
          {request.can_allow_for_session && request.suggested_permission_mode && (
            <button type="button" disabled={busy} onClick={() => void act("allow", "session")}>
              本会话都允许
            </button>
          )}
          <button type="button" className="danger" disabled={busy} onClick={() => void act("deny")}>
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
