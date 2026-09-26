// Wire types of the agit executor and controller protocols, as the console uses them.

export interface Principal {
  issuer: string;
  account_id: string;
}

export interface Device {
  id: string;
  owner: Principal;
  machine_id: string;
  display_name: string;
  certificate: number[];
  credential_epoch: number;
}

export interface DeviceRow {
  device: Device;
  online: boolean;
}

export interface Target {
  peer_id: string;
  route_id: string;
  generation: number;
}

export type PeerState = "connecting" | "online" | "backoff" | "rejected" | "stopped";

export interface RuntimeCapability {
  runtime: string;
  available: boolean;
  permission_modes?: string[];
  approvals?: boolean;
  interrupt?: boolean;
  resume?: boolean;
  /** Commands the machine's agent accepts in every project, each with its own description. */
  commands?: { name: string; description?: string | null; argument_hint?: string | null }[];
}

export interface MachineDescription {
  authority: string;
  instance_id: string;
  machine?: { display_name?: string; machine_fingerprint?: string };
  capabilities?: Record<string, RuntimeCapability>;
}

export interface PeerStatus {
  peer_id: string;
  route_id: string;
  generation: number;
  state: PeerState;
  description: MachineDescription | null;
  worker_pid: number | null;
  error: string | null;
}

export interface Project {
  project_id: string;
  local_path: string;
  exists: boolean;
  git_origin?: string | null;
}

export type SessionStatus = "idle" | "running" | "awaiting_approval" | "detached" | "ended";

export interface SessionInfo {
  session_id: string;
  runtime_session_id?: string | null;
  project_id?: string | null;
  runtime: string;
  status: SessionStatus;
  last_seq: number;
  gist?: string | null;
  title?: string | null;
  dangerous?: boolean;
  permission_mode?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalSession {
  runtime_session_id: string;
  runtime: string;
  cwd: string;
  modified_at: string;
  gist?: string | null;
  title?: string | null;
  adopted: boolean;
  likely_active: boolean;
}

export interface HistoryEvent {
  kind: string;
  text: string | null;
  timestamp?: string | null;
  paths?: string[];
  tool?: string | null;
}

export interface HistoryItem {
  item_id: string;
  event: HistoryEvent;
  raw?: unknown;
}

export interface HistoryPage {
  items: HistoryItem[];
  before: string | null;
  has_more: boolean;
  snapshot: string | null;
}

export interface ApprovalRequest {
  approval_id: string;
  session_id: string;
  kind: "exec" | "file_change" | "permission_escalation" | string;
  tool?: string | null;
  input?: unknown;
  summary?: string | null;
  paths?: string[];
  can_allow_for_session?: boolean;
  suggested_permission_mode?: string | null;
}

export interface RpcFailure {
  code: number;
  message: string;
  data?: { outcome?: string; [key: string]: unknown };
}

export interface Frame {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: RpcFailure;
  seq?: number;
  stream?: string;
}

export interface EffortChoice {
  id: string;
  name?: string;
  description?: string | null;
}

export interface ModelChoice {
  id: string;
  name?: string;
  description?: string | null;
  is_default?: boolean;
  efforts?: EffortChoice[];
  default_effort?: string | null;
}

/** `session.model`: the running session's model and reasoning effort, and what it offers.
 *  `selected_model` is the catalog entry chosen for the session when it differs from the
 *  model the agent reports running. */
export interface ModelState {
  model?: string | null;
  selected_model?: string | null;
  effort?: string | null;
  models?: ModelChoice[];
  efforts?: EffortChoice[];
  /** Claude Code: prompt size of the latest call and, once a turn reports it, the window. */
  context?: { used?: number; window?: number; output?: number } | null;
  /** Claude Code: the CLI's start report (tools, MCP servers, plugins, slash commands...). */
  native?: Record<string, any> | null;
  /** Codex: the thread's latest token usage as the app-server reported it. */
  token_usage?: Record<string, any> | null;
  /** The account's plan limits as the agent last reported them with a model call, and when the
   *  executor received that report, in Unix seconds. */
  rate_limits?: { observed_at?: number; info?: Record<string, any> | null } | null;
}
