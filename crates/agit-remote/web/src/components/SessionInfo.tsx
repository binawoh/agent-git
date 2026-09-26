import { useEffect, useRef, useState } from "react";
import type { ModelState } from "../types";
import type { ExtensionInfo, SlashCommand } from "./Composer";

export interface ContextUse {
  used: number;
  window: number | null;
}

/** Context use as the agent reported it: Claude Code's prompt size and window, or Codex's
 *  latest token usage and model context window. */
export function contextUse(state: ModelState): ContextUse | null {
  const claude = state.context;
  if (claude && typeof claude.used === "number") return { used: claude.used, window: claude.window ?? null };
  const codex = state.token_usage;
  if (codex && typeof codex === "object") {
    const last = codex.last ?? codex.last_token_usage ?? {};
    const used = last.totalTokens ?? last.total_tokens ?? last.inputTokens ?? last.input_tokens;
    const window = codex.modelContextWindow ?? codex.model_context_window ?? null;
    if (typeof used === "number") return { used, window };
  }
  return null;
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
