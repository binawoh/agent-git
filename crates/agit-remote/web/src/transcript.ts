// Turns executor history records and live session events into the entries the console draws.
//
// History (`session.history`) is the canonical transcript for both runtimes. Live events give
// immediacy: streamed assistant text, tool calls and approvals appear as they happen, and
// the next history load replaces them once the native transcript has the finished turn.
import { t } from "./i18n";
import type { ApprovalRequest, Frame, HistoryItem } from "./types";

export type Entry =
  | { type: "user"; id: string; text: string; clientId?: string; pending?: boolean }
  | { type: "assistant"; id: string; text: string; streaming?: boolean }
  | { type: "reasoning"; id: string; text: string; streaming?: boolean }
  | {
      type: "tool";
      id: string;
      tool: string;
      summary: string;
      input: string;
      output: string;
      failed?: boolean;
      streaming?: boolean;
    }
  | { type: "approval"; id: string; request: ApprovalRequest; decided?: string }
  | { type: "notice"; id: string; text: string; tone: "info" | "error" };

export interface Transcript {
  history: Entry[];
  historyIds: string[];
  live: Entry[];
  before: string | null;
  snapshot: string | null;
  hasMore: boolean;
  lastSeq: number;
  loaded: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  /** When the running turn started, to decide whether a history load already contains it. */
  turnStartedAt: number | null;
}

export function emptyTranscript(): Transcript {
  return {
    history: [],
    historyIds: [],
    live: [],
    before: null,
    snapshot: null,
    hasMore: false,
    lastSeq: 0,
    loaded: false,
    loading: false,
    loadingEarlier: false,
    error: null,
    turnStartedAt: null,
  };
}

const record = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (record(part)?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** A one-line description of a tool call, from whichever argument names it best. */
export function describeInput(tool: string, input: unknown): string {
  const args = record(input);
  if (args) {
    for (const key of ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0];
      if (Array.isArray(value) && value.length) return value.join(" ");
    }
    return "";
  }
  if (typeof input === "string") {
    const parsed = safeJson(input);
    if (parsed) return describeInput(tool, parsed);
    // Codex code-mode calls carry a script; the command is inside it.
    const command = input.match(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (command) return command[1].replace(/\\(.)/g, "$1");
    return input.trim().split("\n")[0];
  }
  return "";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The tool-use block of a native record: Claude's content block or Codex's payload. */
function toolCall(raw: unknown): { name?: string; input?: unknown } {
  const value = record(raw);
  const blocks = value?.message?.content;
  if (Array.isArray(blocks)) {
    const block = blocks.find((part: any) => part?.type === "tool_use");
    if (block) return { name: block.name, input: block.input };
  }
  const payload = record(value?.payload);
  if (payload) return { name: payload.name, input: payload.arguments ?? payload.input };
  return {};
}

function toolResult(raw: unknown, fallback: string | null): { output: string; failed: boolean } {
  const value = record(raw);
  const blocks = value?.message?.content;
  if (Array.isArray(blocks)) {
    const block = blocks.find((part: any) => part?.type === "tool_result");
    if (block) return { output: textOf(block.content), failed: Boolean(block.is_error) };
  }
  const payload = record(value?.payload);
  if (payload && payload.output !== undefined) {
    const output = typeof payload.output === "string" ? payload.output : textOf(payload.output);
    return { output, failed: false };
  }
  return { output: fallback ?? "", failed: false };
}

export function fromHistory(items: HistoryItem[]): Entry[] {
  const entries: Entry[] = [];
  let openTool: Extract<Entry, { type: "tool" }> | null = null;
  for (const item of items) {
    const { kind, text, tool, paths } = item.event;
    switch (kind) {
      case "user_prompt":
      case "user_interjection":
        if (text?.trim()) entries.push({ type: "user", id: item.item_id, text });
        openTool = null;
        break;
      case "assistant_reply":
        if (text?.trim()) entries.push({ type: "assistant", id: item.item_id, text });
        openTool = null;
        break;
      case "tool_use":
      case "file_edit": {
        const call = toolCall(item.raw);
        const name = call.name ?? tool ?? text ?? (kind === "file_edit" ? "Edit" : "Tool");
        const summary = describeInput(name, call.input) || (paths ?? []).join(", ");
        const input = call.input === undefined ? "" : typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2);
        openTool = { type: "tool", id: item.item_id, tool: name, summary, input, output: "" };
        entries.push(openTool);
        break;
      }
      case "tool_result": {
        const result = toolResult(item.raw, text);
        if (openTool && !openTool.output) {
          openTool.output = result.output;
          openTool.failed = result.failed;
        } else {
          entries.push({ type: "tool", id: item.item_id, tool: "Result", summary: "", input: "", output: result.output, failed: result.failed });
        }
        break;
      }
      case "compact_summary":
        entries.push({ type: "notice", id: item.item_id, text: t.transcript.compacted, tone: "info" });
        break;
    }
  }
  return entries;
}

/** History ids carry the record's byte offset in the native transcript, which orders them. */
function offset(id: string): number {
  const match = /^history:(\d+)/.exec(id);
  return match ? Number(match[1]) : Number.NaN;
}

/** Merges a history page with what is on screen: older pages prepend, the newest page
 *  replaces everything from its first record onwards. */
export function mergeHistory(current: Transcript, items: HistoryItem[], older: boolean): Pick<Transcript, "history" | "historyIds"> {
  const ids = items.map((item) => item.item_id);
  if (older) {
    const known = new Set(current.historyIds);
    const fresh = items.filter((item) => !known.has(item.item_id));
    return {
      history: [...fromHistory(fresh), ...current.history],
      historyIds: [...fresh.map((item) => item.item_id), ...current.historyIds],
    };
  }
  const start = offset(ids[0] ?? "");
  if (!current.loaded || Number.isNaN(start)) return { history: fromHistory(items), historyIds: ids };
  const keptIds = current.historyIds.filter((id) => offset(id) < start);
  const kept = new Set(keptIds);
  return {
    history: [...current.history.filter((entry) => kept.has(entry.id)), ...fromHistory(items)],
    historyIds: [...keptIds, ...ids],
  };
}

const liveKinds = new Set(["assistant_message", "reasoning", "tool_call", "tool_result"]);

/** Applies one live executor frame to a transcript. Returns false when it changed nothing. */
export function applyFrame(transcript: Transcript, frame: Frame, runtime: string | undefined): boolean {
  if (typeof frame.seq === "number") {
    if (frame.seq <= transcript.lastSeq) return false;
    transcript.lastSeq = frame.seq;
  }
  const params = frame.params ?? {};
  const live = transcript.live;
  const find = (id: string) => live.findIndex((entry) => entry.id === id);
  switch (frame.method) {
    case "turn.started": {
      transcript.turnStartedAt = Date.now();
      if (!params.prompt) return true;
      // A session's opening prompt carries no client id; match its placeholder by text instead.
      let pending = live.findIndex((entry) => entry.type === "user" && entry.pending && entry.clientId && entry.clientId === params.client_msg_id);
      if (pending < 0) pending = live.findIndex((entry) => entry.type === "user" && entry.pending && !entry.clientId && entry.text === params.prompt);
      const user: Entry = { type: "user", id: `turn:${params.turn_id}`, text: params.prompt };
      if (pending >= 0) live[pending] = user;
      else live.push(user);
      return true;
    }
    case "turn.steered": {
      const pending = live.findIndex((entry) => entry.type === "user" && entry.pending && entry.clientId === params.client_msg_id);
      const user: Entry = { type: "user", id: `steer:${frame.seq}`, text: params.message };
      if (pending >= 0) live[pending] = user;
      else live.push(user);
      return true;
    }
    case "item.started": {
      if (!liveKinds.has(params.kind) || find(params.item_id) >= 0) return true;
      if (params.kind === "assistant_message") live.push({ type: "assistant", id: params.item_id, text: "", streaming: true });
      else if (params.kind === "reasoning") live.push({ type: "reasoning", id: params.item_id, text: "", streaming: true });
      else live.push({ type: "tool", id: params.item_id, tool: params.tool ?? "Tool", summary: "", input: "", output: "", streaming: true });
      return true;
    }
    case "item.delta": {
      const index = find(params.item_id);
      if (index < 0) return false;
      const entry = live[index];
      if (entry.type === "assistant" || entry.type === "reasoning") {
        live[index] = { ...entry, text: entry.text + (params.text ?? "") };
      } else if (entry.type === "tool") {
        // Claude streams the call's arguments; Codex streams the command's output.
        if (runtime === "codex") live[index] = { ...entry, output: entry.output + (params.text ?? "") };
        else {
          const input = entry.input + (params.text ?? "");
          live[index] = { ...entry, input, summary: describeInput(entry.tool, input) || entry.summary };
        }
      }
      return true;
    }
    case "item.finished": {
      const index = find(params.item_id);
      if (index < 0) return false;
      live[index] = { ...live[index], streaming: false } as Entry;
      return true;
    }
    case "item.completed": {
      // Codex reports tool results only as transcript records; attach them to the running call.
      if (params.event?.kind !== "tool_result") return false;
      for (let index = live.length - 1; index >= 0; index--) {
        const entry = live[index];
        if (entry.type === "tool") {
          if (!entry.output) live[index] = { ...entry, output: toolResult(params.raw, params.event.text).output };
          return true;
        }
      }
      return false;
    }
    case "approval.request":
      live.push({ type: "approval", id: `approval:${params.approval_id}`, request: params });
      return true;
    case "turn.completed":
      for (let index = 0; index < live.length; index++) {
        const entry = live[index];
        if ("streaming" in entry && entry.streaming) live[index] = { ...entry, streaming: false } as Entry;
        if (entry.type === "approval" && !entry.decided) live[index] = { ...entry, decided: "expired" };
      }
      if (params.outcome === "error") live.push({ type: "notice", id: `error:${frame.seq}`, text: params.error ?? t.transcript.turnFailed, tone: "error" });
      if (params.outcome === "interrupted") live.push({ type: "notice", id: `interrupted:${frame.seq}`, text: t.transcript.interrupted, tone: "info" });
      return true;
    default:
      return typeof frame.seq === "number";
  }
}

/** After a history load, live entries of turns that history now contains are redundant. */
export function settleLive(transcript: Transcript, items: HistoryItem[]): Entry[] {
  const started = transcript.turnStartedAt;
  if (started === null) return transcript.live.filter((entry) => entry.type === "approval" && !entry.decided);
  const newest = items.reduce((latest, item) => Math.max(latest, Date.parse(item.event.timestamp ?? "") || 0), 0);
  const covered = newest >= started - 5_000 && items.some((item) => item.event.kind === "assistant_reply" && (Date.parse(item.event.timestamp ?? "") || 0) >= started - 5_000);
  return covered ? transcript.live.filter((entry) => (entry.type === "approval" && !entry.decided) || (entry.type === "user" && entry.pending)) : transcript.live;
}
