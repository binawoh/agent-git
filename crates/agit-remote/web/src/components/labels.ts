// Display names for executor vocabulary.

export const runtimeName: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const runtimeMark: Record<string, string> = {
  "claude-code": "CC",
  codex: "Cx",
  opencode: "OC",
};

export const permissionName: Record<string, string> = {
  default: "逐项审批",
  accept_edits: "自动接受编辑",
  auto: "自动",
  plan: "计划模式",
  bypass: "跳过所有审批",
};

/** What each mode lets the agent do without asking, shown under its name in the mode menu. */
export const permissionHint: Record<string, string> = {
  default: "改文件、运行命令之前都先问你",
  accept_edits: "文件修改直接生效，运行其他命令前仍会询问",
  auto: "常规操作直接执行，有风险的操作仍会拦下",
  plan: "只读探索并提出方案，不改动任何文件",
  bypass: "所有操作都不再询问，只在隔离环境里使用",
};

export const effortName: Record<string, string> = {
  none: "不思考",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  ultra: "极限",
};

/** Shown under an effort level when the runtime does not describe it. */
export const effortHint: Record<string, string> = {
  none: "直接回答，不做推理",
  minimal: "最快，只做很少的推理",
  low: "更快，适合简单明确的任务",
  medium: "速度和深度兼顾",
  high: "更深入地推敲，适合复杂任务",
  xhigh: "推敲更久，适合困难的问题",
  max: "尽可能深入，耗时最长",
  ultra: "不计耗时，做最充分的推理",
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
