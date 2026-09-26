import { useEffect, useRef, useState } from "react";
import type { HistoryItem, ModelState, RuntimeCapability } from "../types";
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

/** The machine's catalog of an agent's commands, each with the agent's own description. */
export function commandCatalog(capability: RuntimeCapability | undefined): SlashCommand[] {
  return (capability?.commands ?? []).map((command) => ({ name: command.name, description: command.description ?? undefined }));
}

/** Commands the agent accepts. A live agent's own list comes first; Claude Code's start report
 *  names its commands only, so descriptions come from the machine's catalog, which also stands
 *  in while the agent has reported nothing. */
export function slashCommands(live: SlashCommand[], names: unknown, catalog: SlashCommand[]): SlashCommand[] {
  const described = new Map(catalog.map((command) => [command.name, command.description]));
  const reported: SlashCommand[] = live.length
    ? live
    : Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string" && name.length > 0).map((name) => ({ name }))
      : [];
  const listed = reported.map((command) => ({ ...command, description: command.description || described.get(command.name) }));
  const seen = new Set(listed.map((command) => command.name));
  return [...listed, ...catalog.filter((command) => !seen.has(command.name))];
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

type LimitReport = NonNullable<ModelState["rate_limits"]>;

/** One plan limit: the share of it used and when its window starts over, in Unix seconds. */
export interface LimitWindow {
  key: string;
  label: string;
  used: number;
  resetsAt: number | null;
}

export interface PlanUsage {
  plan: string | null;
  windows: LimitWindow[];
  /** When the executor received the report, in Unix seconds. */
  observedAt: number | null;
}

// Plan limits belong to the account rather than a session, and agents report them only with a
// model call; the newest report of each agent is kept in this browser and shown in its sessions.
const limitsKey = (runtime: string) => `agit.limits.${runtime}`;

function savedLimits(runtime: string): LimitReport | null {
  try {
    const saved = JSON.parse(localStorage.getItem(limitsKey(runtime)) ?? "null");
    return saved && typeof saved === "object" && saved.info ? saved : null;
  } catch {
    return null;
  }
}

/** The newer of a session's report and the one kept in this browser. */
export function newestLimits(runtime: string, report: LimitReport | null | undefined): LimitReport | null {
  const saved = savedLimits(runtime);
  if (!report?.info) return saved;
  return saved && (saved.observed_at ?? 0) > (report.observed_at ?? 0) ? saved : report;
}

export function rememberLimits(runtime: string, report: LimitReport | null | undefined): void {
  if (!report?.info || newestLimits(runtime, report) !== report) return;
  try {
    localStorage.setItem(limitsKey(runtime), JSON.stringify(report));
  } catch {
    // Storage is a convenience here.
  }
}

/** Claude Code's windows, in the order its own usage panel lists them. */
const claudeLimitNames: Record<string, string> = {
  five_hour: "5 小时限额",
  seven_day: "每周 · 所有模型",
  seven_day_opus: "每周 · Opus",
  seven_day_sonnet: "每周 · Sonnet",
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Claude Code reports each window's use as a fraction; a report without the windows still
 *  names the one limit it is about. */
function claudeWindows(info: Record<string, any>): LimitWindow[] {
  const unified = info.unifiedWindows;
  if (unified && typeof unified === "object") {
    return Object.entries(claudeLimitNames).flatMap(([key, label]) => {
      const window = unified[key];
      return window && typeof window.utilization === "number" ? [{ key, label, used: window.utilization, resetsAt: numberOrNull(window.resetsAt) }] : [];
    });
  }
  const type = info.rateLimitType;
  if (typeof type === "string" && claudeLimitNames[type] && typeof info.utilization === "number") {
    return [{ key: type, label: claudeLimitNames[type], used: info.utilization, resetsAt: numberOrNull(info.resetsAt) }];
  }
  return [];
}

/** Codex reports a percentage per window and names a window by its length. */
function codexWindow(key: string, window: any): LimitWindow[] {
  if (!window || typeof window.usedPercent !== "number") return [];
  const minutes = window.windowDurationMins;
  const label =
    minutes === 300
      ? "5 小时限额"
      : minutes === 10080
        ? "每周限额"
        : typeof minutes === "number" && minutes > 0
          ? minutes % 1440 === 0
            ? `${minutes / 1440} 天限额`
            : `${+(minutes / 60).toFixed(1)} 小时限额`
          : key === "primary"
            ? "短期限额"
            : "长期限额";
  return [{ key, label, used: window.usedPercent / 100, resetsAt: numberOrNull(window.resetsAt) }];
}

export function planUsage(runtime: string, report: LimitReport | null | undefined): PlanUsage | null {
  const info = report?.info;
  if (!info || typeof info !== "object") return null;
  const windows = runtime === "codex" ? [...codexWindow("primary", info.primary), ...codexWindow("secondary", info.secondary)] : claudeWindows(info);
  if (!windows.length) return null;
  const planType = runtime === "codex" ? info.planType : null;
  const plan = typeof planType === "string" && planType !== "unknown" ? planType.charAt(0).toUpperCase() + planType.slice(1) : null;
  return { plan, windows, observedAt: numberOrNull(report?.observed_at) };
}

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** When a window starts over: a countdown within a day, otherwise the weekday and time. */
function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  const seconds = resetsAt - now / 1000;
  if (seconds <= 0) return "已重置";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟后重置`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours} 小时 ${minutes} 分后重置` : `${hours} 小时后重置`;
  }
  const date = new Date(resetsAt * 1000);
  return `${weekdays[date.getDay()]} ${clock(date)} 重置`;
}

function observedText(observedAt: number | null, now: number): string {
  if (observedAt === null) return "";
  const age = now / 1000 - observedAt;
  if (age < 60) return "刚刚更新";
  if (age < 3600) return `${Math.floor(age / 60)} 分钟前更新`;
  const date = new Date(observedAt * 1000);
  const today = new Date(now).toDateString() === date.toDateString();
  return today ? `今天 ${clock(date)} 更新` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)} 更新`;
}

function tone(share: number | null): string {
  return share === null ? "" : share > 0.9 ? "danger" : share > 0.7 ? "warn" : "";
}

function UsageBar({ share }: { share: number }) {
  const width = share > 0 ? Math.max(1, Math.min(1, share) * 100) : 0;
  return (
    <div className="context-bar">
      <div className={`context-bar-fill ${tone(share)}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/** The ring beside the pickers, filled to the share of the context window in use. A tap shows
 *  the context and the account's plan limits, as the desktop app's usage panel does. */
export function UsageRing({ context, usage }: { context: ContextUse | null; usage: PlanUsage | null }) {
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
  const now = Date.now();
  const share = context?.window ? Math.min(1, context.used / context.window) : null;
  const contextText = context ? (context.window ? `${tokens(context.used)} / ${tokens(context.window)}（${Math.round((share ?? 0) * 100)}%）` : tokens(context.used)) : null;
  const current = usage?.windows.filter((window) => window.resetsAt === null || window.resetsAt * 1000 > now) ?? [];
  const busiest = current.reduce<LimitWindow | null>((top, window) => (!top || window.used > top.used ? window : top), null);
  const title = [contextText && `上下文 ${contextText}`, busiest && `${busiest.label} ${Math.round(busiest.used * 100)}% · ${resetText(busiest.resetsAt, now)}`]
    .filter(Boolean)
    .join("\n");
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="menu-anchor" ref={anchor}>
      <button type="button" className={`context-ring ${tone(share)}`} title={title} aria-label={title || "用量"} onClick={() => setOpen(!open)}>
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
          {context && (
            <section className="usage-section">
              <div className="context-row">
                <span>上下文窗口</span>
                <span>{contextText}</span>
              </div>
              {share !== null && <UsageBar share={share} />}
            </section>
          )}
          {usage && (
            <section className="usage-section">
              <div className="usage-heading">
                <span>{usage.plan ? `套餐用量 · ${usage.plan}` : "套餐用量"}</span>
                <span>{observedText(usage.observedAt, now)}</span>
              </div>
              {usage.windows.map((window) => {
                const over = window.resetsAt !== null && window.resetsAt * 1000 <= now;
                return (
                  <div key={window.key} className="usage-window">
                    <div className="usage-row">
                      <span className="usage-label">{window.label}</span>
                      <span className="usage-reset">{resetText(window.resetsAt, now)}</span>
                      <span className="usage-percent">{over ? "—" : `${Math.round(window.used * 100)}%`}</span>
                    </div>
                    <UsageBar share={over ? 0 : window.used} />
                  </div>
                );
              })}
            </section>
          )}
          {context && <p className="context-note">上下文按最近一次模型调用统计，快满时可以用 /compact 压缩对话。</p>}
        </div>
      )}
    </div>
  );
}
