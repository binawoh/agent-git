// How tool calls read in the transcript: what kind of work each is, a verb and target for its
// row, a summary for a run of steps, and the diff of a file change.

import { t } from "../i18n";

export type StepKind = "command" | "read" | "edit" | "write" | "search" | "web" | "agent" | "todo" | "plan" | "mcp" | "result" | "other";

export function stepKind(tool: string): StepKind {
  const name = tool.toLowerCase();
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "result") return "result";
  if (/^(bash|bashoutput|killshell|shell|local_shell|exec|exec_command|powershell|run_command|terminal)$/.test(name) || /shell|command/.test(name)) return "command";
  if (/web|fetch|browser|url/.test(name)) return "web";
  if (/^(write|write_file|create_file)$/.test(name)) return "write";
  if (/edit|patch|str_replace|apply/.test(name)) return "edit";
  if (/^(read|read_file|view|view_image|notebookread|cat)$/.test(name)) return "read";
  if (/grep|glob|search|find|^ls$|list_dir|list_files/.test(name)) return "search";
  if (/^(task|agent)$/.test(name) || /subagent/.test(name)) return "agent";
  if (/todo|update_plan/.test(name)) return "todo";
  if (/exitplanmode/.test(name)) return "plan";
  return "other";
}

export function stepVerb(kind: StepKind, tool: string): string {
  const verb = t.steps.verb;
  switch (kind) {
    case "command":
      return verb.command;
    case "read":
      return verb.read;
    case "edit":
      return verb.edit;
    case "write":
      return verb.write;
    case "search":
      return verb.search;
    case "web":
      return /search/i.test(tool) ? verb.webSearch : verb.webOpen;
    case "agent":
      return verb.agent;
    case "todo":
      return verb.todo;
    case "plan":
      return verb.plan;
    case "result":
      return verb.result;
    case "mcp": {
      const [, server, name] = tool.split("__");
      return name ? `${server} · ${name}` : tool;
    }
    default:
      return tool;
  }
}

/** The tail of a path, enough to recognise the file in a narrow row. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

export function parseInput(input: string): unknown {
  if (!input.trim().startsWith("{")) return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

const record = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;

/** The full command line of a shell call; a `bash -lc <script>` wrapper shows the script. */
export function commandOf(input: unknown): string | null {
  const args = record(input);
  const value = args?.command ?? args?.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    if (value.length === 3 && /^-l?c$/.test(value[1])) return value[2];
    return value.join(" ");
  }
  return null;
}

export interface Todo {
  text: string;
  status: string;
}

/** Claude's `todos` and Codex's `plan` lists. */
export function todosOf(input: unknown): Todo[] | null {
  const args = record(input);
  const list = args?.todos ?? args?.plan;
  if (!Array.isArray(list)) return null;
  return list.flatMap((item) => {
    const todo = record(item);
    const text = todo?.content ?? todo?.step ?? todo?.activeForm;
    return typeof text === "string" ? [{ text, status: String(todo?.status ?? "pending") }] : [];
  });
}

// ---------------------------------------------------------------------------- diffs

export interface DiffLine {
  type: "add" | "del" | "ctx" | "gap" | "file";
  text: string;
}

export interface Diff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

const MAX_LINES = 600;
const CONTEXT = 3;

/** Line diff by longest common subsequence; inputs too large for the table fall back to
 *  showing every old line removed and every new line added. */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) lines.push({ type: "del", text: a[i++] });
    else lines.push({ type: "add", text: b[j++] });
  }
  while (i < a.length) lines.push({ type: "del", text: a[i++] });
  while (j < b.length) lines.push({ type: "add", text: b[j++] });
  return lines;
}

/** Long runs of unchanged lines shrink to a few lines of context around each change. */
function trimContext(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (last: boolean) => {
    const first = result.length === 0;
    const keepHead = first ? 0 : CONTEXT;
    const keepTail = last ? 0 : CONTEXT;
    if (run.length > keepHead + keepTail + 1) {
      result.push(...run.slice(0, keepHead));
      result.push({ type: "gap", text: t.steps.unchanged(run.length - keepHead - keepTail) });
      result.push(...run.slice(run.length - keepTail));
    } else result.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (line.type === "ctx") run.push(line);
    else {
      flush(false);
      result.push(line);
    }
  }
  flush(true);
  return result;
}

/** Codex's `*** Begin Patch` format or a unified diff; only the latter has `---`/`+++` headers,
 *  so in the former such lines are content. */
function patchDiff(patch: string): DiffLine[] {
  const unified = !/^\s*\*\*\* Begin Patch/.test(patch);
  const lines: DiffLine[] = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line) ?? (unified ? /^\+\+\+ (?:b\/)?(.+)$/.exec(line) : null);
    if (file) lines.push({ type: "file", text: file[1] });
    else if (/^\*\*\* (Begin|End) Patch|^\*\*\* End of File/.test(line) || (unified && /^--- |^diff --git|^index /.test(line))) continue;
    else if (line.startsWith("@@")) lines.push({ type: "gap", text: line.replace(/^@@\s*|\s*@@.*$/g, "") || "…" });
    else if (line.startsWith("+")) lines.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) lines.push({ type: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) lines.push({ type: "ctx", text: line.slice(1) });
  }
  return lines;
}

const looksLikePatch = (text: string) => /^\*\*\* Begin Patch|^(---|\+\+\+|@@) /m.test(text);

function finish(lines: DiffLine[]): Diff | null {
  if (!lines.some((line) => line.type === "add" || line.type === "del")) return null;
  const added = lines.filter((line) => line.type === "add").length;
  const removed = lines.filter((line) => line.type === "del").length;
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), { type: "gap" as const, text: t.steps.moreLines(lines.length - MAX_LINES) }] : lines;
  return { lines: shown, added, removed };
}

/** The change a file tool makes, from its arguments: an edit's old and new text, a write's
 *  content, or a patch. */
export function diffOf(input: unknown): Diff | null {
  if (typeof input === "string") return looksLikePatch(input) ? finish(patchDiff(input)) : null;
  const args = record(input);
  if (!args) return null;
  if (typeof args.old_string === "string" && typeof args.new_string === "string") return finish(trimContext(lineDiff(args.old_string, args.new_string)));
  if (Array.isArray(args.edits)) {
    const lines: DiffLine[] = [];
    for (const edit of args.edits) {
      const change = record(edit);
      if (typeof change?.old_string !== "string" || typeof change?.new_string !== "string") continue;
      if (lines.length) lines.push({ type: "gap", text: "…" });
      lines.push(...trimContext(lineDiff(change.old_string, change.new_string)));
    }
    return finish(lines);
  }
  if (typeof args.content === "string") return finish(args.content.replace(/\n$/, "").split("\n").map((text) => ({ type: "add" as const, text })));
  for (const key of ["patch", "input"]) {
    if (typeof args[key] === "string" && looksLikePatch(args[key])) return finish(patchDiff(args[key]));
  }
  return null;
}

// ---------------------------------------------------------------------------- summaries

const phrase = t.steps.summary;
const summaryPhrases: [StepKind[], (count: number) => string][] = [
  [["read"], phrase.read],
  [["edit", "write"], phrase.edit],
  [["command"], phrase.command],
  [["search"], phrase.search],
  [["web"], phrase.web],
  [["agent"], phrase.agent],
  [["todo", "plan"], phrase.plan],
  [["mcp", "other", "result"], phrase.tool],
];

/** One line for a run of steps, naming at most three kinds of work with their counts. A file
 *  counts once however often it is touched. */
export function summarize(steps: { kind: StepKind | "reasoning"; target: string }[]): string {
  const parts: string[] = [];
  for (const [kinds, phrase] of summaryPhrases) {
    const matching = steps.filter((step) => (kinds as string[]).includes(step.kind));
    if (!matching.length) continue;
    const files = kinds.includes("read") || kinds.includes("edit");
    const unnamed = matching.filter((step) => !step.target).length;
    parts.push(phrase(files ? new Set(matching.flatMap((step) => (step.target ? [step.target] : []))).size + unnamed : matching.length));
  }
  if (!parts.length) return steps.some((step) => step.kind === "reasoning") ? t.steps.thinking : "";
  return t.steps.joinSummary(parts.slice(0, 3), parts.length > 3);
}
