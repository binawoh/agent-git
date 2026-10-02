import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { runtimeUsage } from "../store";
import type { HistoryItem, ModelState, RuntimeCapability, RuntimeUsage } from "../types";
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

function rememberWindow(model: string, window: number): void {
  withWindow(model, 0, window);
}

/** Context use with the window this browser knows for `model` where the use lacks one. */
export function knownWindow(model: string | null | undefined, use: ContextUse | null | undefined): ContextUse | null {
  if (!use) return null;
  if (use.window || !model) return use;
  return { used: use.used, window: knownWindows()[model] ?? null };
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
  return ordered([...listed, ...catalog.filter((command) => !seen.has(command.name))]);
}

/** The source Claude Code appends to the description of a command that is not its own. */
const addedSource = /\((user|project|plugin|claude\.ai sync|dynamic workflow)[^)]*\)\s*$/;

/** The agent's own commands first, as the desktop app lists them, then those that users,
 *  projects and plugins added. A name with a leading double underscore is an internal entry
 *  point of the CLI and is not offered. */
function ordered(commands: SlashCommand[]): SlashCommand[] {
  const offered = commands.filter((command) => !command.name.startsWith("__"));
  const added = (command: SlashCommand) => command.name.includes(":") || addedSource.test(command.description ?? "");
  return [...offered.filter((command) => !added(command)), ...offered.filter(added)];
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
  /** When the machine's agent reported this, in Unix seconds. */
  observedAt: number | null;
}

// Plan limits belong to the account rather than a session; the newest usage each agent
// reported is kept in this browser and shown in every session of that agent.
const usageKey = (runtime: string) => `agit.usage.${runtime}`;

function savedUsage(runtime: string): PlanUsage | null {
  try {
    const saved = JSON.parse(localStorage.getItem(usageKey(runtime)) ?? "null");
    return saved && Array.isArray(saved.windows) ? saved : null;
  } catch {
    return null;
  }
}

function saveUsage(runtime: string, usage: PlanUsage): void {
  try {
    localStorage.setItem(usageKey(runtime), JSON.stringify(usage));
  } catch {
    // Storage is a convenience here.
  }
}

function windowOrder(key: string): number {
  if (key === "five_hour" || key === "primary") return 0;
  if (key === "seven_day" || key === "secondary") return 1;
  return 2;
}

/** The newer report replaces the windows it names. A window only the older report names keeps
 *  its last known share, because a model call reports fewer windows than a usage query. */
function mergeUsage(saved: PlanUsage | null, report: PlanUsage): PlanUsage {
  if (!saved) return report;
  const [older, newer] = (saved.observedAt ?? 0) > (report.observedAt ?? 0) ? [report, saved] : [saved, report];
  const named = new Set(newer.windows.map((window) => window.key));
  const windows = [...newer.windows, ...older.windows.filter((window) => !named.has(window.key))];
  windows.sort((a, b) => windowOrder(a.key) - windowOrder(b.key));
  return { plan: newer.plan ?? older.plan, windows, observedAt: newer.observedAt };
}

/** Claude Code's windows as a model call reports them, in the order its usage panel lists them. */
const claudeLimitNames = t.usage.claudeLimit;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A model call reports each window's use as a fraction; a report without the windows still
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

/** A usage query lists every limit with a percentage, including limits scoped to one model. */
function claudeLimits(usage: Record<string, any> | undefined): LimitWindow[] {
  const limits = usage?.rate_limits?.limits;
  if (!Array.isArray(limits)) return [];
  return limits.flatMap((limit: any) => {
    if (typeof limit?.percent !== "number") return [];
    const scope = limit.scope?.model?.display_name;
    const [key, label] =
      limit.kind === "session"
        ? ["five_hour", claudeLimitNames.five_hour]
        : limit.kind === "weekly_all"
          ? ["seven_day", claudeLimitNames.seven_day]
          : typeof scope === "string"
            ? [`weekly:${scope}`, t.usage.weeklyScoped(scope)]
            : [String(limit.kind), String(limit.kind)];
    const resets = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) / 1000 : NaN;
    return [{ key, label, used: limit.percent / 100, resetsAt: Number.isFinite(resets) ? resets : null }];
  });
}

/** Codex reports a percentage per window and names a window by its length. */
function codexWindow(key: string, window: any): LimitWindow[] {
  if (!window || typeof window.usedPercent !== "number") return [];
  const minutes = window.windowDurationMins;
  const label =
    minutes === 300
      ? claudeLimitNames.five_hour
      : minutes === 10080
        ? t.usage.weekly
        : typeof minutes === "number" && minutes > 0
          ? minutes % 1440 === 0
            ? t.usage.days(minutes / 1440)
            : t.usage.hours(+(minutes / 60).toFixed(1))
          : key === "primary"
            ? t.usage.shortTerm
            : t.usage.longTerm;
  return [{ key, label, used: window.usedPercent / 100, resetsAt: numberOrNull(window.resetsAt) }];
}

function planName(value: unknown): string | null {
  return typeof value === "string" && value && value !== "unknown" ? value.charAt(0).toUpperCase() + value.slice(1) : null;
}

/** Usage as a session reported it with its latest model call. */
export function planUsage(runtime: string, report: LimitReport | null | undefined): PlanUsage | null {
  const info = report?.info;
  if (!info || typeof info !== "object") return null;
  const windows = runtime === "codex" ? [...codexWindow("primary", info.primary), ...codexWindow("secondary", info.secondary)] : claudeWindows(info);
  if (!windows.length) return null;
  return { plan: runtime === "codex" ? planName(info.planType) : null, windows, observedAt: numberOrNull(report?.observed_at) };
}

/** Usage as the machine's agent answered a usage query. */
function queriedUsage(runtime: string, result: RuntimeUsage): PlanUsage | null {
  if (runtime === "codex") return planUsage(runtime, { observed_at: result.observed_at, info: result.usage?.rateLimits });
  const windows = claudeLimits(result.usage);
  if (!windows.length) return null;
  return { plan: planName(result.usage?.subscription_type), windows, observedAt: numberOrNull(result.observed_at) };
}

/** A copy younger than this is not queried again when the panel opens. */
const FRESH_SECONDS = 60;
/** A copy older than this is queried again when a session opens. */
const STALE_SECONDS = 600;
const queries = new Map<string, Promise<void>>();
const lastQuery = new Map<string, number>();

/** Plan usage for a session: its own reports as they arrive, and a query of the machine's agent
 *  when this browser's copy is old or the context window of `model` is unknown. A query starts a
 *  short-lived agent on the machine, so one runs at a time for an agent and model, and none is
 *  repeated within a minute of the last, whether that one succeeded or not. */
export function useAgentUsage(runtime: string, model: string | null | undefined, report: LimitReport | null | undefined) {
  const [usage, setUsage] = useState<PlanUsage | null>(() => savedUsage(runtime));
  const [refreshing, setRefreshing] = useState(false);
  const [, setWindowsSeen] = useState(0);

  useEffect(() => setUsage(savedUsage(runtime)), [runtime]);

  useEffect(() => {
    const reported = planUsage(runtime, report);
    if (!reported) return;
    const merged = mergeUsage(savedUsage(runtime), reported);
    saveUsage(runtime, merged);
    setUsage(merged);
  }, [runtime, report]);

  const refresh = useCallback(
    (maxAge: number) => {
      const saved = savedUsage(runtime);
      const age = saved?.observedAt ? Date.now() / 1000 - saved.observedAt : Infinity;
      const asked = runtime === "codex" ? null : model || null;
      const windowUnknown = !!asked && !knownWindows()[asked];
      if (age < maxAge && !windowUnknown) return;
      const key = `${runtime}|${asked ?? ""}`;
      let query = queries.get(key);
      if (!query) {
        if (Date.now() - (lastQuery.get(key) ?? 0) < FRESH_SECONDS * 1000) return;
        lastQuery.set(key, Date.now());
        query = runtimeUsage(runtime, asked)
          .then((result) => {
            if (!result) return;
            if (typeof result.context_window === "number" && result.model) rememberWindow(result.model, result.context_window);
            const queried = queriedUsage(runtime, result);
            if (queried) saveUsage(runtime, mergeUsage(savedUsage(runtime), queried));
          })
          .finally(() => queries.delete(key));
        queries.set(key, query);
      }
      setRefreshing(true);
      void query.then(() => {
        setUsage(savedUsage(runtime));
        setWindowsSeen((count) => count + 1);
        setRefreshing(false);
      });
    },
    [runtime, model],
  );

  useEffect(() => refresh(STALE_SECONDS), [refresh]);

  return { usage, refreshing, refresh: () => refresh(FRESH_SECONDS) };
}

function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** When a window starts over: a countdown within a day, otherwise the weekday and time. */
function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  const seconds = resetsAt - now / 1000;
  if (seconds <= 0) return t.usage.reset;
  if (seconds < 3600) return t.usage.resetsInMinutes(Math.max(1, Math.floor(seconds / 60)));
  if (seconds < 86400) return t.usage.resetsInHours(Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60));
  const date = new Date(resetsAt * 1000);
  return t.usage.resetsAt(date, clock(date));
}

function observedText(observedAt: number | null, now: number): string {
  if (observedAt === null) return "";
  const age = now / 1000 - observedAt;
  if (age < 60) return t.usage.updatedJustNow;
  if (age < 3600) return t.usage.updatedMinutesAgo(Math.floor(age / 60));
  const date = new Date(observedAt * 1000);
  const today = new Date(now).toDateString() === date.toDateString();
  return today ? t.usage.updatedToday(clock(date)) : t.usage.updatedOn(date, clock(date));
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
 *  the context and the account's plan limits, as the desktop app's usage panel does, and asks
 *  the machine for fresh usage when the copy shown is older than a minute. */
export function UsageRing({ context, usage, refreshing, onOpen }: { context: ContextUse | null; usage: PlanUsage | null; refreshing?: boolean; onOpen?: () => void }) {
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
  const left = context?.window ? Math.max(0, context.window - context.used) : null;
  const contextText = context
    ? context.window
      ? t.usage.contextShare(tokens(context.used), tokens(context.window), Math.round((share ?? 0) * 100))
      : tokens(context.used)
    : null;
  const current = usage?.windows.filter((window) => window.resetsAt === null || window.resetsAt * 1000 > now) ?? [];
  const busiest = current.reduce<LimitWindow | null>((top, window) => (!top || window.used > top.used ? window : top), null);
  const title = [
    contextText && t.usage.contextTitle(contextText, left !== null ? tokens(left) : null),
    busiest && `${busiest.label} ${Math.round(busiest.used * 100)}% · ${resetText(busiest.resetsAt, now)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="menu-anchor" ref={anchor}>
      <button
        type="button"
        className={`context-ring ${tone(share)}`}
        title={title}
        aria-label={title || t.usage.label}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
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
                <span>{t.usage.contextWindow}</span>
                <span>{contextText}</span>
              </div>
              {share !== null && <UsageBar share={share} />}
              {left !== null && (
                <div className="usage-left">
                  {t.usage.left(tokens(left))}
                  {share !== null && share > 0.8 ? t.usage.compactHint : ""}
                </div>
              )}
            </section>
          )}
          {(usage || refreshing) && (
            <section className="usage-section">
              <div className="usage-heading">
                <span>{t.usage.plan(usage?.plan ?? null)}</span>
                <span>{refreshing ? t.usage.refreshing : observedText(usage?.observedAt ?? null, now)}</span>
              </div>
              {usage?.windows.map((window) => {
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
        </div>
      )}
    </div>
  );
}
