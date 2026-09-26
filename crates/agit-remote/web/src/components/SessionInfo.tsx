import { useEffect, useRef, useState } from "react";
import type { HistoryItem, ModelState } from "../types";
import type { ExtensionInfo, SlashCommand } from "./Composer";

export interface ContextUse {
  used: number;
  window: number | null;
}

// Agents report a model's context window only at the end of a turn; windows seen once are
// kept in this browser so a session that has not finished a turn here still shows its share.
const windowsKey = "agit.contextWindows";

function knownWindows(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(windowsKey) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function withWindow(model: string | null | undefined, used: number, window: number | null | undefined): ContextUse {
  if (!model) return { used, window: window ?? null };
  const windows = knownWindows();
  if (window && windows[model] !== window) {
    try {
      localStorage.setItem(windowsKey, JSON.stringify({ ...windows, [model]: window }));
    } catch {
      // Storage is a convenience here.
    }
  }
  return { used, window: window ?? windows[model] ?? null };
}

/** Context use as the agent reported it: Claude Code's prompt size and window, or Codex's
 *  latest token usage and model context window. */
export function contextUse(state: ModelState): ContextUse | null {
  const model = state.model ?? state.selected_model;
  const claude = state.context;
  if (claude && typeof claude.used === "number") return withWindow(model, claude.used, claude.window);
  const codex = state.token_usage;
  if (codex && typeof codex === "object") {
    const last = codex.last ?? codex.last_token_usage ?? {};
    const used = last.totalTokens ?? last.total_tokens ?? last.inputTokens ?? last.input_tokens;
    const window = codex.modelContextWindow ?? codex.model_context_window ?? null;
    if (typeof used === "number") return withWindow(model, used, window);
  }
  return null;
}

/** What a session's own records say about it: the model and effort of its latest reply, the
 *  permission mode of its latest prompt, and the context that reply used. */
export interface RecordedSettings {
  model?: string;
  effort?: string;
  mode?: string;
  context?: ContextUse;
}

const claudeModes: Record<string, string> = {
  default: "default",
  acceptEdits: "accept_edits",
  auto: "auto",
  plan: "plan",
  bypassPermissions: "bypass",
};

/** Codex records the approval policy and sandbox; together they name one of agit's modes. */
function codexMode(approval: unknown, sandbox: unknown): string | undefined {
  if (approval === "on-request" || approval === "untrusted" || approval === "on-failure") return "default";
  if (approval !== "never") return undefined;
  if (sandbox === "danger-full-access") return "bypass";
  if (sandbox === "read-only") return "plan";
  if (sandbox === "workspace-write") return "auto";
  return undefined;
}

export function recordedSettings(items: HistoryItem[]): RecordedSettings {
  const found: RecordedSettings = {};
  let used: number | undefined;
  let window: number | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const raw = items[index].raw as any;
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "assistant" && !raw.isSidechain && !found.model) {
      const model = raw.message?.model;
      // Error notices carry a placeholder model such as "<synthetic>".
      if (typeof model === "string" && !model.startsWith("<")) {
        found.model = model;
        if (typeof raw.effort === "string") found.effort = raw.effort;
        const usage = raw.message.usage;
        if (usage) used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      }
    } else if (raw.type === "user" && !found.mode && typeof raw.permissionMode === "string") {
      found.mode = claudeModes[raw.permissionMode];
    } else if (raw.type === "turn_context" && !found.model) {
      const payload = raw.payload ?? {};
      if (typeof payload.model === "string") found.model = payload.model;
      const effort = payload.effort ?? payload.reasoning_effort;
      if (typeof effort === "string") found.effort = effort;
      found.mode ??= codexMode(payload.approval_policy, payload.sandbox_policy?.type ?? payload.sandbox_policy);
    } else if (raw.type === "token_usage_record" && used === undefined) {
      const total = raw.payload?.usage?.total_tokens;
      if (typeof total === "number") used = total;
    } else if (raw.type === "event_msg" && raw.payload?.type === "token_count") {
      const info = raw.payload.info ?? {};
      window ??= info.model_context_window ?? undefined;
      used ??= info.last_token_usage?.total_tokens;
    }
  }
  if (used !== undefined) found.context = withWindow(found.model, used, window);
  return found;
}

// A stored session learns its commands and extensions only once the agent starts; the last
// lists a live session of the same agent reported stand in until then.
const nativeKey = (runtime: string) => `agit.native.${runtime}`;

export interface NativeLists {
  commands: SlashCommand[];
  extensions: ExtensionInfo | null;
}

export function rememberNative(runtime: string, lists: NativeLists): void {
  if (!lists.commands.length && !lists.extensions) return;
  try {
    localStorage.setItem(nativeKey(runtime), JSON.stringify(lists));
  } catch {
    // Storage is a convenience here.
  }
}

export function lastNative(runtime: string): NativeLists {
  try {
    const saved = JSON.parse(localStorage.getItem(nativeKey(runtime)) ?? "null");
    if (saved && Array.isArray(saved.commands)) return saved;
  } catch {
    // Fall through to nothing known.
  }
  return { commands: [], extensions: null };
}

/** Claude Code names its commands; a few common ones get a description here. */
const claudeDescriptions: Record<string, string> = {
  compact: "压缩对话历史，释放上下文",
  clear: "清空对话，重新开始",
  context: "查看上下文的使用情况",
  cost: "查看这个会话的花费",
  init: "为项目生成 CLAUDE.md",
  review: "审查代码改动",
  "security-review": "检查改动里的安全问题",
  memory: "查看或编辑记忆文件",
  status: "查看会话状态",
};

/** Commands the agent accepts: Claude Code lists names at start, Codex lists its own commands. */
export function slashCommands(state: ModelState, codexCommands: SlashCommand[]): SlashCommand[] {
  const names = state.native?.slash_commands;
  if (Array.isArray(names)) {
    return names
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .map((name) => ({ name, description: claudeDescriptions[name] }));
  }
  return codexCommands;
}

export function extensionInfo(state: ModelState): ExtensionInfo | null {
  const native = state.native;
  if (!native || typeof native !== "object") return null;
  const mcp = Array.isArray(native.mcp_servers)
    ? native.mcp_servers.map((server: any) => ({ name: String(server?.name ?? server), status: server?.status ? String(server.status) : undefined }))
    : [];
  const plugins = Array.isArray(native.plugins)
    ? native.plugins.map((plugin: any) => ({ name: String(plugin?.name ?? plugin), detail: plugin?.source ? String(plugin.source) : undefined }))
    : [];
  return { mcp, plugins };
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** A ring filled to the share of the context window in use; a tap shows the numbers. */
export function ContextRing({ use }: { use: ContextUse }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (anchor.current && !anchor.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const share = use.window ? Math.min(1, use.used / use.window) : null;
  const percent = share === null ? null : Math.round(share * 100);
  const label = use.window ? `上下文 ${tokens(use.used)} / ${tokens(use.window)}（${percent}%）` : `上下文 ${tokens(use.used)}`;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const tone = share === null ? "" : share > 0.9 ? "danger" : share > 0.7 ? "warn" : "";
  return (
    <div className="menu-anchor" ref={anchor}>
      <button type="button" className={`context-ring ${tone}`} title={label} aria-label={label} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={radius} className="context-ring-track" />
          <circle
            cx="9"
            cy="9"
            r={radius}
            className="context-ring-fill"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - (share ?? 0))}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {open && (
        <div className="menu-popover top right context-popover">
          <div className="context-row">
            <span>上下文窗口</span>
            <span>{use.window ? `${tokens(use.used)} / ${tokens(use.window)}（${percent}%）` : tokens(use.used)}</span>
          </div>
          {share !== null && (
            <div className="context-bar">
              <div className={`context-bar-fill ${tone}`} style={{ width: `${Math.max(1, share * 100)}%` }} />
            </div>
          )}
          <p className="context-note">按最近一次模型调用统计；快满时可以用 /compact 压缩对话。</p>
        </div>
      )}
    </div>
  );
}
