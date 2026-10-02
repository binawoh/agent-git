// Display names for executor vocabulary.

import { t } from "../i18n";

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

export const permissionName = t.labels.permission;

/** What each mode lets the agent do without asking, shown under its name in the mode menu. */
export const permissionHint = t.labels.permissionHint;

export const effortName = t.labels.effort;

/** Shown under an effort level when the runtime does not describe it. */
export const effortHint = t.labels.effortHint;

export const statusName = t.labels.status;

export function sessionTitle(session: { title?: string | null; gist?: string | null }): string {
  const text = (session.title || session.gist || "").trim();
  return text ? text.split("\n")[0] : t.common.newSession;
}
