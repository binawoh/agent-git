// Console state and the operations behind every control. One controller peer per device;
// the executor's owner RPC is reached through `peer.request`.
import { create } from "zustand";
import * as api from "./api";
import { Rpc, RpcError, type ConnectionState } from "./rpc";
import { applyFrame, emptyTranscript, mergeHistory, settleLive, type Entry, type Transcript } from "./transcript";
import type {
  DeviceRow,
  Frame,
  HistoryPage,
  LocalSession,
  MachineDescription,
  ModelChoice,
  ModelState,
  PeerState,
  PeerStatus,
  Project,
  SessionInfo,
  Target,
} from "./types";

const WORKSPACE = "local-owner";

export type View =
  | { type: "home" }
  | { type: "new"; projectId: string | null }
  | { type: "session"; sessionId: string }
  | { type: "local"; nativeId: string };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

interface State {
  me: api.Me | null;
  authChecked: boolean;
  connection: ConnectionState;
  devices: DeviceRow[];
  deviceId: string | null;
  target: Target | null;
  peerState: PeerState | "idle" | "offline";
  peerError: string | null;
  description: MachineDescription | null;
  projects: Project[];
  sessions: SessionInfo[];
  local: LocalSession[];
  catalogLoaded: boolean;
  view: View;
  transcripts: Record<string, Transcript>;
  sidebarOpen: boolean;
  toasts: Toast[];
  models: Record<string, ModelChoice[]>;
  passwordDialog: boolean;
}

export const useStore = create<State>(() => ({
  me: null,
  authChecked: false,
  connection: "connecting",
  devices: [],
  deviceId: localStorage.getItem("agit.device"),
  target: null,
  peerState: "idle",
  peerError: null,
  description: null,
  projects: [],
  sessions: [],
  local: [],
  catalogLoaded: false,
  view: { type: "home" },
  transcripts: {},
  sidebarOpen: false,
  toasts: [],
  models: {},
  passwordDialog: false,
}));

const get = useStore.getState;
const set = useStore.setState;
const rpc = new Rpc();

// ---------------------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let toastId = 0;

export function toast(text: string, tone: Toast["tone"] = "error"): void {
  const id = ++toastId;
  set((state) => ({ toasts: [...state.toasts, { id, text, tone }] }));
  setTimeout(() => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })), 6000);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function projectName(project: Pick<Project, "local_path"> | undefined): string {
  if (!project) return "未分组";
  const path = displayPath(project.local_path);
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\/, "");
}

const samePath = (a: string, b: string) => displayPath(a).replace(/[\\/]+$/, "").toLowerCase() === displayPath(b).replace(/[\\/]+$/, "").toLowerCase();

export function projectOfLocal(local: LocalSession): Project | undefined {
  return get().projects.find((project) => samePath(project.local_path, local.cwd));
}

function updateTranscript(key: string, update: (transcript: Transcript) => Partial<Transcript> | void): void {
  set((state) => {
    const current = state.transcripts[key] ?? emptyTranscript();
    const next = { ...current, live: [...current.live] };
    const patch = update(next);
    return { transcripts: { ...state.transcripts, [key]: { ...next, ...(patch ?? {}) } } };
  });
}

function patchSession(sessionId: string, patch: Partial<SessionInfo>): void {
  set((state) => ({ sessions: state.sessions.map((session) => (session.session_id === sessionId ? { ...session, ...patch } : session)) }));
}

// ---------------------------------------------------------------------------- sign-in and connection

export async function boot(): Promise<void> {
  try {
    const me = await api.me();
    set({ me, authChecked: true });
    if (me) connect();
  } catch (error) {
    set({ authChecked: true });
    toast(`无法连接服务器：${message(error)}`);
  }
}

export async function signIn(credential: api.Credential): Promise<void> {
  await api.login(credential);
  await boot();
}

export async function refreshMe(): Promise<void> {
  const me = await api.me();
  if (me) set({ me });
}

export async function signOut(): Promise<void> {
  rpc.stop();
  await api.logout().catch(() => {});
  set({ me: null, devices: [], target: null, projects: [], sessions: [], local: [], transcripts: {}, view: { type: "home" }, catalogLoaded: false });
}

function connect(): void {
  rpc.onFrame = handleFrame;
  rpc.onState = (connection, everOpened) => {
    set({ connection });
    if (connection === "open") void onOpen();
    // A socket that never opens may mean the session ended; check before retrying forever.
    if (connection === "closed" && !everOpened) {
      void api.me().then((me) => {
        if (!me) {
          rpc.stop();
          set({ me: null });
        }
      });
    }
  };
  rpc.start();
}

async function onOpen(): Promise<void> {
  try {
    await loadDevices();
    await attachPeer();
  } catch (error) {
    set({ peerError: message(error) });
  }
}

export async function loadDevices(): Promise<void> {
  const { devices } = await rpc.call<{ devices: DeviceRow[] }>("console.devices");
  let deviceId = get().deviceId;
  if (!devices.some((row) => row.device.id === deviceId)) {
    deviceId = (devices.find((row) => row.online) ?? devices[0])?.device.id ?? null;
  }
  set({ devices, deviceId });
}

export async function selectDevice(deviceId: string): Promise<void> {
  localStorage.setItem("agit.device", deviceId);
  set({ deviceId, target: null, projects: [], sessions: [], local: [], transcripts: {}, view: { type: "home" }, catalogLoaded: false, description: null });
  await loadDevices().catch(() => {});
  await attachPeer();
}

async function attachPeer(): Promise<void> {
  const { deviceId, devices } = get();
  const row = devices.find((candidate) => candidate.device.id === deviceId);
  if (!row) {
    set({ peerState: "idle", target: null });
    return;
  }
  if (!row.online) {
    set({ peerState: "offline", target: null, peerError: null });
    return;
  }
  set({ peerState: "connecting", peerError: null });
  const connectCloud = () =>
    rpc.call<{ route_id: string; generation: number; description: MachineDescription }>("peer.connect_cloud", {
      peer_id: row.device.id,
      target: row.device,
    });
  try {
    let result;
    try {
      result = await connectCloud();
    } catch (error) {
      // A re-enrolled device has a new identity; the old configuration must be dropped first.
      if (!message(error).includes("configuration changed")) throw error;
      await rpc.call("peer.disconnect", { peer_id: row.device.id });
      result = await connectCloud();
    }
    set({
      target: { peer_id: row.device.id, route_id: result.route_id, generation: result.generation },
      description: result.description,
      peerState: "online",
    });
    await refreshCatalog();
    await reopenView();
  } catch (error) {
    set({ peerState: "backoff", peerError: message(error) });
  }
}

/** Executor methods, fenced to the current route generation. A request refused because the
 *  route moved on is repeated once against the new generation. */
export async function request<T = any>(method: string, params: unknown = {}, timeoutMs = 90_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const target = get().target;
    if (!target) throw new Error("电脑未连接");
    try {
      return await rpc.call<T>("peer.request", { ...target, method, params, timeout_ms: timeoutMs });
    } catch (error) {
      if (attempt === 0 && error instanceof RpcError && error.notSent && error.code === 300) {
        await refreshTarget();
        continue;
      }
      throw error;
    }
  }
}

async function refreshTarget(): Promise<void> {
  const { peers } = await rpc.call<{ peers: PeerStatus[] }>("peer.list");
  const peer = peers.find((candidate) => candidate.peer_id === get().deviceId);
  if (peer && peer.state === "online") set({ target: { peer_id: peer.peer_id, route_id: peer.route_id, generation: peer.generation } });
}

// ---------------------------------------------------------------------------- catalog

export async function refreshCatalog(): Promise<void> {
  try {
    const [workspaces, list] = await Promise.all([
      request<{ workspaces: { projects: Project[] }[] }>("workspace.list", { workspace_id: WORKSPACE }),
      request<{ sessions: SessionInfo[]; local?: LocalSession[] }>("session.list", { workspace_id: WORKSPACE, include_local: true }).catch((error) => {
        // Before any folder is bound the executor has no workspace to list sessions in.
        if (error instanceof RpcError && error.code === 301) return { sessions: [], local: [] };
        throw error;
      }),
    ]);
    set({
      projects: workspaces.workspaces.flatMap((workspace) => workspace.projects),
      sessions: list.sessions,
      // Listing includes native sessions the daemon already supervises; show each once.
      local: (list.local ?? []).filter((session) => !list.sessions.some((managed) => managed.runtime_session_id === session.runtime_session_id)),
      catalogLoaded: true,
    });
  } catch (error) {
    toast(`读取会话列表失败：${message(error)}`);
  }
}

let catalogTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCatalog(delay = 800): void {
  if (catalogTimer) clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => {
    catalogTimer = null;
    void refreshCatalog();
  }, delay);
}

setInterval(() => {
  if (document.visibilityState !== "visible" || get().connection !== "open") return;
  if (get().target) void refreshCatalog();
  // A machine that comes online after the page loaded is attached as soon as it is seen.
  void loadDevices()
    .then(() => {
      const { devices, deviceId, peerState } = get();
      if (peerState === "offline" && devices.some((row) => row.device.id === deviceId && row.online)) void attachPeer();
    })
    .catch(() => {});
}, 20_000);

export async function bindProject(path: string): Promise<void> {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const projectId = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
  await request("project.bind", { workspace_id: WORKSPACE, project_id: projectId, local_path: path });
  await refreshCatalog();
}

// ---------------------------------------------------------------------------- views and history

export function open(view: View): void {
  set({ view, sidebarOpen: false });
  void reopenView();
}

async function reopenView(): Promise<void> {
  const view = get().view;
  if (view.type === "session") {
    await Promise.all([loadHistory(view.sessionId), subscribe(view.sessionId)]);
  } else if (view.type === "local") {
    await loadHistory(view.nativeId);
  }
}

function historyParams(key: string): Record<string, unknown> {
  const local = get().local.find((session) => session.runtime_session_id === key);
  return local ? { session_id: key, runtime: local.runtime, cwd: local.cwd } : { session_id: key };
}

export async function loadHistory(key: string, older = false): Promise<void> {
  const current = get().transcripts[key] ?? emptyTranscript();
  if (older && (!current.hasMore || current.loadingEarlier)) return;
  updateTranscript(key, () => (older ? { loadingEarlier: true } : { loading: !current.loaded, error: null }));
  try {
    const params: Record<string, unknown> = { ...historyParams(key), view: "conversation" };
    if (older) Object.assign(params, { before: current.before, snapshot: current.snapshot });
    const page = await request<HistoryPage>("session.history", params);
    updateTranscript(key, (transcript) => ({
      ...mergeHistory(transcript, page.items, older),
      ...(older ? {} : { live: settleLive(transcript, page.items) }),
      // Paging backwards continues from the oldest page loaded so far.
      ...(older || !transcript.loaded ? { before: page.before, snapshot: page.snapshot, hasMore: page.has_more } : {}),
      loaded: true,
      loading: false,
      loadingEarlier: false,
    }));
  } catch (error) {
    // A session that has not written its first native record yet simply has no history.
    if (error instanceof RpcError && (error.data?.kind === "source_missing" || /source_missing/.test(error.message))) {
      updateTranscript(key, () => ({ loading: false, loadingEarlier: false, loaded: true }));
      return;
    }
    updateTranscript(key, () => ({ loading: false, loadingEarlier: false, error: message(error) }));
  }
}

async function subscribe(sessionId: string): Promise<void> {
  const info = get().sessions.find((session) => session.session_id === sessionId);
  const known = get().transcripts[sessionId]?.lastSeq ?? 0;
  const afterSeq = known || info?.last_seq || 0;
  updateTranscript(sessionId, (transcript) => ({ lastSeq: Math.max(transcript.lastSeq, afterSeq) }));
  try {
    const result = await request<{ session: SessionInfo }>("session.subscribe", { session_id: sessionId, after_seq: afterSeq });
    patchSession(sessionId, result.session);
  } catch (error) {
    toast(`订阅会话失败：${message(error)}`);
  }
}

// Live-updating a session that another program is writing: the newest page is cheap to poll.
setInterval(() => {
  const { view, local, target } = get();
  if (!target || view.type !== "local" || document.visibilityState !== "visible") return;
  if (local.find((session) => session.runtime_session_id === view.nativeId)?.likely_active) void loadHistory(view.nativeId);
}, 4000);

// ---------------------------------------------------------------------------- live events

const historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleHistory(key: string): void {
  clearTimeout(historyTimers.get(key));
  // The native transcript is written shortly after the turn ends.
  historyTimers.set(
    key,
    setTimeout(() => {
      historyTimers.delete(key);
      const view = get().view;
      if (view.type === "session" && view.sessionId === key) void loadHistory(key);
    }, 1500),
  );
}

function handleFrame(frame: Frame): void {
  if (frame.method === "console.lagged") {
    rpc.restart();
    return;
  }
  const params = frame.params ?? {};
  if (params.peer_id !== get().deviceId) return;
  if (frame.method === "peer.state") {
    const status = params.status as PeerStatus;
    const target = get().target;
    const moved = status.state === "online" && (!target || target.route_id !== status.route_id || target.generation !== status.generation);
    set({
      peerState: status.state,
      peerError: status.error,
      ...(status.description ? { description: status.description } : {}),
      ...(status.state === "online" ? { target: { peer_id: status.peer_id, route_id: status.route_id, generation: status.generation } } : {}),
    });
    // A first attachment loads the catalog; a new generation is a new executor attachment,
    // so the open session replays what it missed.
    if (moved && !target) void refreshCatalog().then(reopenView);
    else if (moved) void reopenView();
    return;
  }
  if (frame.method !== "peer.frame") return;
  const inner = params.frame as Frame;
  const key = inner.stream;
  if (!key) return;
  const info = get().sessions.find((session) => session.session_id === key);
  if (inner.method === "session.status") {
    if (info) patchSession(key, { status: inner.params.status });
    else scheduleCatalog();
  }
  if (inner.method === "session.permissionMode" && info) patchSession(key, { permission_mode: inner.params.mode });
  set((state) => {
    const current = state.transcripts[key] ?? emptyTranscript();
    const next: Transcript = { ...current, live: [...current.live] };
    if (!applyFrame(next, inner, info?.runtime)) return state;
    return { transcripts: { ...state.transcripts, [key]: next } };
  });
  if (inner.method === "turn.completed") {
    scheduleHistory(key);
    scheduleCatalog();
  }
  if (inner.method === "approval.request") {
    const view = get().view;
    if (!(view.type === "session" && view.sessionId === key)) toast(`「${info?.title ?? info?.gist ?? "会话"}」在等你审批`, "info");
  }
}

// ---------------------------------------------------------------------------- operations

const busy = (status: string | undefined) => status === "running" || status === "awaiting_approval";

export async function send(sessionId: string, text: string): Promise<void> {
  const clientId = crypto.randomUUID();
  updateTranscript(sessionId, (transcript) => {
    transcript.live.push({ type: "user", id: `pending:${clientId}`, text, clientId, pending: true });
  });
  let method = busy(get().sessions.find((session) => session.session_id === sessionId)?.status) ? "turn.steer" : "turn.start";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await request(method, { session_id: sessionId, message: text, client_msg_id: clientId });
      return;
    } catch (error) {
      const text = message(error);
      const retryable = error instanceof RpcError && error.code === 303 && error.data?.outcome !== "unknown";
      if (retryable && /already running|steer it/i.test(text) && method === "turn.start") {
        method = "turn.steer";
        continue;
      }
      if (retryable && /still opening|still proving|restarting/i.test(text)) {
        await sleep(1000);
        continue;
      }
      updateTranscript(sessionId, (transcript) => ({
        live: transcript.live.map((entry): Entry =>
          entry.type === "user" && entry.clientId === clientId ? { type: "notice", id: entry.id, text: `发送失败：${text}`, tone: "error" } : entry,
        ),
      }));
      return;
    }
  }
}

export async function interrupt(sessionId: string): Promise<void> {
  try {
    await request("turn.interrupt", { session_id: sessionId });
  } catch (error) {
    toast(`中断失败：${message(error)}`);
  }
}

export async function decide(sessionId: string, approvalId: string, decision: "allow" | "deny", scope: "once" | "session" = "once"): Promise<void> {
  const mark = (decided: string) =>
    updateTranscript(sessionId, (transcript) => ({
      live: transcript.live.map((entry): Entry => (entry.type === "approval" && entry.request.approval_id === approvalId ? { ...entry, decided } : entry)),
    }));
  try {
    await request("approval.decide", { session_id: sessionId, approval_id: approvalId, decision, scope });
    mark(decision === "allow" ? (scope === "session" ? "allow_session" : "allow") : "deny");
  } catch (error) {
    if (error instanceof RpcError && error.code === 306) mark("expired");
    else toast(`审批失败：${message(error)}`);
  }
}

export async function startSession(options: {
  projectId: string;
  runtime: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  prompt: string;
}): Promise<void> {
  const params: Record<string, unknown> = {
    workspace_id: WORKSPACE,
    project_id: options.projectId,
    runtime: options.runtime,
    start_id: crypto.randomUUID(),
    permission_mode: options.permissionMode,
  };
  if (options.model) params.model = options.model;
  // The launch takes no effort, so a chosen one is applied before the first prompt is sent.
  if (!options.effort) params.prompt = options.prompt;
  const { session } = await request<{ session: SessionInfo }>("session.start", params, 120_000);
  set((state) => ({ sessions: [session, ...state.sessions.filter((item) => item.session_id !== session.session_id)] }));
  if (options.effort) {
    updateTranscript(session.session_id, () => ({ loaded: true }));
    open({ type: "session", sessionId: session.session_id });
    await setModel(session.session_id, { effort: options.effort });
    await send(session.session_id, options.prompt);
    return;
  }
  showPendingPrompt(session.session_id, options.prompt);
  open({ type: "session", sessionId: session.session_id });
}

function showPendingPrompt(sessionId: string, prompt: string): void {
  updateTranscript(sessionId, (transcript) => {
    if (!transcript.live.some((entry) => entry.type === "user" && entry.pending && entry.text === prompt)) {
      transcript.live.push({ type: "user", id: `pending:${crypto.randomUUID()}`, text: prompt, pending: true });
    }
    return { turnStartedAt: Date.now() };
  });
}

/** Takes over a native session; with a prompt, the takeover also sends it as the next turn. */
export async function resume(nativeId: string, prompt?: string): Promise<boolean> {
  try {
    const params: Record<string, unknown> = { workspace_id: WORKSPACE, session_id: nativeId };
    if (prompt) params.prompt = prompt;
    const { session } = await request<{ session: SessionInfo }>("session.resume", params, 120_000);
    set((state) => ({ sessions: [session, ...state.sessions.filter((item) => item.session_id !== session.session_id)] }));
    if (prompt) showPendingPrompt(session.session_id, prompt);
    open({ type: "session", sessionId: session.session_id });
    scheduleCatalog();
    return true;
  } catch (error) {
    toast(error instanceof RpcError && error.code === 303 ? "这个会话正在另一个程序里运行，先在那边关掉它再接着聊" : `接管失败：${message(error)}`);
    return false;
  }
}

export async function setPermissionMode(sessionId: string, mode: string): Promise<void> {
  try {
    await request("session.setPermissionMode", { session_id: sessionId, mode });
    patchSession(sessionId, { permission_mode: mode });
  } catch (error) {
    toast(`切换权限模式失败：${message(error)}`);
  }
}

export async function loadModels(runtime: string, cwd?: string): Promise<ModelChoice[]> {
  const cached = get().models[runtime];
  if (cached) return cached;
  try {
    const { models } = await request<{ models: ModelChoice[] }>("runtime.models", cwd ? { runtime, cwd } : { runtime }, 60_000);
    set((state) => ({ models: { ...state.models, [runtime]: models } }));
    return models;
  } catch {
    return [];
  }
}

export async function sessionModel(sessionId: string): Promise<ModelState | null> {
  try {
    return await request<ModelState>("session.model", { session_id: sessionId });
  } catch {
    return null;
  }
}

/** Changes the model, the reasoning effort, or both; an empty value restores the default.
 *  A session that is still opening refuses without accepting anything, so it is retried. */
export async function setModel(sessionId: string, change: { model?: string; effort?: string }): Promise<ModelState | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await request<ModelState>("session.setModel", { session_id: sessionId, ...change });
    } catch (error) {
      if (error instanceof RpcError && error.code === 303 && error.data?.outcome !== "unknown" && /opening|restarting|proving/i.test(error.message)) {
        await sleep(1000);
        continue;
      }
      toast(`切换${change.effort !== undefined ? "思考强度" : "模型"}失败：${message(error)}`);
      return null;
    }
  }
  return null;
}
