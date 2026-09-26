import { Folder, FolderPlus, KeyRound, LoaderCircle, Menu, PanelLeftOpen, Plus, SquarePen, WifiOff, X } from "lucide-react";
import { useState } from "react";
import { displayPath, open, projectName, projectOfLocal, setSidebarCollapsed, useStore } from "../store";
import { BrandMark } from "./Brand";
import { FolderDialog } from "./FolderDialog";
import { NewSession } from "./NewSession";
import { PasswordDialog } from "./PasswordDialog";
import { SessionView } from "./SessionView";
import { Sidebar } from "./Sidebar";
import { runtimeName, sessionTitle } from "./labels";
import { useTicking } from "./time";

export function Shell() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const view = useStore((state) => state.view);
  const passwordDialog = useStore((state) => state.passwordDialog);
  const folderDialog = useStore((state) => state.folderDialog);
  return (
    <div className={`shell ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar />
      <div className="backdrop" onClick={() => useStore.setState({ sidebarOpen: false })} />
      <main className="main">
        <TopBar />
        <ConnectionBanner />
        <PasswordHint />
        {view.type === "session" ? (
          <SessionView key={view.sessionId} sessionKey={view.sessionId} />
        ) : view.type === "local" ? (
          <SessionView key={view.nativeId} sessionKey={view.nativeId} local />
        ) : view.type === "new" ? (
          <NewSession key={view.projectId ?? "none"} projectId={view.projectId} />
        ) : (
          <Home />
        )}
      </main>
      {passwordDialog && <PasswordDialog onClose={() => useStore.setState({ passwordDialog: false })} />}
      {folderDialog && <FolderDialog onClose={() => useStore.setState({ folderDialog: false })} />}
    </div>
  );
}

function PasswordHint() {
  const me = useStore((state) => state.me);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem("agit.passwordHint") === "hidden");
  if (!me || me.password_login !== false || hidden) return null;
  return (
    <div className="banner hint">
      <KeyRound size={15} />
      <span className="banner-text">还没有设置登录密码。设置后，以后登录不用再输令牌。</span>
      <button type="button" className="primary small" onClick={() => useStore.setState({ passwordDialog: true })}>
        设置密码
      </button>
      <button
        type="button"
        className="icon-button small"
        title="暂时不设置"
        aria-label="暂时不设置"
        onClick={() => {
          sessionStorage.setItem("agit.passwordHint", "hidden");
          setHidden(true);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function TopBar() {
  const view = useStore((state) => state.view);
  const sessions = useStore((state) => state.sessions);
  const local = useStore((state) => state.local);
  const projects = useStore((state) => state.projects);
  const collapsed = useStore((state) => state.sidebarCollapsed);
  const machine = useStore((state) => state.description?.machine?.display_name);
  let title = machine ?? "AgentGit Remote";
  let project: string | null = null;
  let projectId: string | null = null;
  let runtime: string | null = null;
  let status: "running" | "awaiting" | "readonly" | null = null;
  if (view.type === "session") {
    const session = sessions.find((item) => item.session_id === view.sessionId);
    if (session) {
      title = sessionTitle(session);
      project = projectName(projects.find((item) => item.project_id === session.project_id));
      projectId = session.project_id ?? null;
      runtime = session.runtime;
      status = session.status === "running" ? "running" : session.status === "awaiting_approval" ? "awaiting" : null;
    }
  } else if (view.type === "local") {
    const session = local.find((item) => item.runtime_session_id === view.nativeId);
    if (session) {
      const owner = projectOfLocal(session);
      title = sessionTitle(session);
      project = projectName(owner ?? { local_path: session.cwd });
      projectId = owner?.project_id ?? null;
      runtime = session.runtime;
      status = session.likely_active ? "readonly" : null;
    }
  } else if (view.type === "new") {
    title = "新会话";
    projectId = view.projectId;
  }
  const newSession = () => open({ type: "new", projectId: projectId ?? projects[0]?.project_id ?? null });
  return (
    <header className="topbar">
      <button type="button" className="icon-button mobile-only" aria-label="打开侧栏" onClick={() => useStore.setState({ sidebarOpen: true })}>
        <Menu size={18} />
      </button>
      {collapsed && (
        <>
          <button type="button" className="icon-button desktop-only" title="展开侧栏" aria-label="展开侧栏" onClick={() => setSidebarCollapsed(false)}>
            <PanelLeftOpen size={17} />
          </button>
          <button type="button" className="icon-button desktop-only" title="新会话" aria-label="新会话" onClick={newSession}>
            <SquarePen size={16} />
          </button>
        </>
      )}
      <div className="topbar-title">
        <span className="title-text" title={title}>
          {title}
        </span>
        {(project || runtime) && (
          <span className="title-meta">
            {project && (
              <span className="crumb">
                <Folder size={13} />
                {project}
              </span>
            )}
            {runtime && <span className="crumb">{runtimeName[runtime] ?? runtime}</span>}
          </span>
        )}
      </div>
      <div className="topbar-actions">
        {status === "running" && (
          <span className="status-pill running">
            <LoaderCircle size={12} className="spin" />
            运行中
          </span>
        )}
        {status === "awaiting" && <span className="status-pill warn">等待审批</span>}
        {status === "readonly" && <span className="status-pill">只读</span>}
        <button type="button" className="icon-button mobile-only" title="新会话" aria-label="新会话" onClick={newSession}>
          <SquarePen size={17} />
        </button>
      </div>
    </header>
  );
}

const pageLoadedAt = Date.now();

/** Brief reconnects stay silent: a banner appears only when a connection is missing for a
 *  noticeable time, so a reload or a proxy hiccup does not flash an error. */
function ConnectionBanner() {
  const connection = useStore((state) => state.connection);
  const connectedOnce = useStore((state) => state.connectedOnce);
  const disconnectedAt = useStore((state) => state.disconnectedAt);
  const peerState = useStore((state) => state.peerState);
  const peerError = useStore((state) => state.peerError);
  const devices = useStore((state) => state.devices);
  const waiting = connection !== "open" || peerState === "connecting";
  const now = useTicking(waiting);
  const busy = (text: string) => (
    <div className="banner">
      <LoaderCircle size={14} className="spin" />
      <span className="banner-text">{text}</span>
    </div>
  );
  if (connection !== "open") {
    if (connectedOnce && disconnectedAt && now - disconnectedAt > 2500) return busy("网络断了一下，正在重新连接…");
    if (!connectedOnce && now - pageLoadedAt > 4000) return busy("正在连接服务器…");
    return null;
  }
  if (devices.length === 0) return null;
  if (peerState === "offline")
    return (
      <div className="banner warn" title={peerError ?? undefined}>
        <WifiOff size={14} />
        <span className="banner-text">这台电脑现在连不上：可能关机、休眠、daemon 没在运行（agit rc start），或者网络断了。它一恢复就会自动连上。</span>
      </div>
    );
  if (peerState === "connecting") return now - pageLoadedAt > 4000 ? busy("正在连接电脑…") : null;
  if (peerState === "backoff" || peerState === "rejected" || peerState === "stopped")
    return (
      <div className="banner warn" title={peerError ?? undefined}>
        <LoaderCircle size={14} className="spin" />
        <span className="banner-text">和电脑的连接中断了，正在重新连接…</span>
      </div>
    );
  return null;
}

function Home() {
  const devices = useStore((state) => state.devices);
  const devicesLoaded = useStore((state) => state.devicesLoaded);
  const description = useStore((state) => state.description);
  const projects = useStore((state) => state.projects);
  const peerState = useStore((state) => state.peerState);
  const catalogLoaded = useStore((state) => state.catalogLoaded);
  if (devices.length === 0 && !devicesLoaded) {
    return (
      <div className="empty">
        <LoaderCircle size={20} className="spin muted" />
      </div>
    );
  }
  if (devices.length === 0) {
    return (
      <div className="empty">
        <BrandMark size={40} />
        <h1>还没有电脑连上来</h1>
        <p className="muted">在要远程控制的电脑上运行下面的命令，这台电脑就会出现在这里：</p>
        <pre>agit rc start --detach</pre>
      </div>
    );
  }
  const unbound = peerState === "online" && catalogLoaded && projects.length === 0;
  return (
    <div className="empty">
      <BrandMark size={40} />
      <h1>{description?.machine?.display_name ?? "AgentGit Remote"}</h1>
      <p className="muted">{unbound ? "还没有绑定项目文件夹。添加一个电脑上的项目文件夹，就能在里面开始会话。" : "从左侧选一个会话，或者选一个项目开始新会话。"}</p>
      {projects.length > 0 && (
        <div className="project-cards">
          {projects.map((project) => (
            <button type="button" key={project.project_id} className="project-card" onClick={() => open({ type: "new", projectId: project.project_id })}>
              <Folder size={16} className="project-card-icon" />
              <span className="project-card-text">
                <strong>{projectName(project)}</strong>
                <span>{displayPath(project.local_path)}</span>
              </span>
              <Plus size={15} className="project-card-add" />
            </button>
          ))}
        </div>
      )}
      {unbound && (
        <button type="button" className="primary" onClick={() => useStore.setState({ folderDialog: true })}>
          <FolderPlus size={15} />
          添加文件夹
        </button>
      )}
    </div>
  );
}
