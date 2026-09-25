// Display names for executor vocabulary.

export const runtimeName: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const permissionName: Record<string, string> = {
  default: "逐项审批",
  accept_edits: "自动接受编辑",
  auto: "自动",
  plan: "计划模式",
  bypass: "跳过所有审批",
};

export const statusName: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  awaiting_approval: "等待审批",
  detached: "已分离",
  ended: "已结束",
};

export function sessionTitle(session: { title?: string | null; gist?: string | null }): string {
  const text = (session.title || session.gist || "").trim();
  return text ? text.split("\n")[0] : "新会话";
}
