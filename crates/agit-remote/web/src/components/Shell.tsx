import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { displayPath, projectName, projectOfLocal, useStore } from "../store";
import { NewSession } from "./NewSession";
import { PasswordDialog } from "./PasswordDialog";
import { SessionView } from "./SessionView";
import { Sidebar } from "./Sidebar";
import { runtimeName, sessionTitle } from "./labels";

export function Shell() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const view = useStore((state) => state.view);
  const passwordDialog = useStore((state) => state.passwordDialog);
  return (
    <div className={`shell ${sidebarOpen ? "sidebar-open" : ""}`}>
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
    </div>
  );
}

function PasswordHint() {
  const me = useStore((state) => state.me);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem("agit.passwordHint") === "hidden");
  if (!me || me.password_login !== false || hidden) return null;
  return (
    <div className="banner hint">
      <span>还没有设置登录密码。设置后，以后登录不用再输令牌。</span>
      <button className="primary small" onClick={() => useStore.setState({ passwordDialog: true })}>
        设置密码
      </button>
      <button
        className="icon-button small"
        title="暂时不设置"
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
  let title = "AgentGit Remote";
  let project: string | null = null;
  let runtime: string | null = null;
  if (view.type === "session") {
    const session = sessions.find((item) => item.session_id === view.sessionId);
    if (session) {
      title = sessionTitle(session);
      project = projectName(projects.find((item) => item.project_id === session.project_id));
      runtime = session.runtime;
    }
  } else if (view.type === "local") {
    const session = local.find((item) => item.runtime_session_id === view.nativeId);
    if (session) {
      title = sessionTitle(session);
      project = projectName(projectOfLocal(session) ?? { local_path: session.cwd });
      runtime = session.runtime;
    }
  } else if (view.type === "new") {
    title = "新会话";
    project = view.projectId ? projectName(projects.find((item) => item.project_id === view.projectId)) : null;
  }
  return (
    <header className="topbar">
      <button className="icon-button mobile-only" aria-label="打开侧栏" onClick={() => useStore.setState({ sidebarOpen: true })}>
        <Menu size={18} />
      </button>
      <div className="topbar-title" title={title}>
        {title}
      </div>
      {project && <span className="tag">{project}</span>}
      {runtime && <span className="tag subtle">{runtimeName[runtime] ?? runtime}</span>}
    </header>
  );
}

const pageLoadedAt = Date.now();

/** Re-renders every second while a condition that depends on elapsed time is pending. */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

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
  if (connection !== "open") {
    if (connectedOnce && disconnectedAt && now - disconnectedAt > 2500) return <div className="banner">网络断了一下，正在重新连接…</div>;
    if (!connectedOnce && now - pageLoadedAt > 4000) return <div className="banner">正在连接服务器…</div>;
    return null;
  }
  if (devices.length === 0) return null;
  if (peerState === "offline") return <div className="banner warn">这台电脑现在离线。确认电脑开着，并且 agit daemon 在运行（agit rc start）。</div>;
  if (peerState === "connecting") return now - pageLoadedAt > 4000 ? <div className="banner">正在连接电脑…</div> : null;
  if (peerState === "backoff" || peerState === "rejected" || peerState === "stopped")
    return <div className="banner warn">连接电脑失败{peerError ? `：${peerError}` : ""}，正在重试…</div>;
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
        <p className="muted">正在连接…</p>
      </div>
    );
  }
  if (devices.length === 0) {
    return (
      <div className="empty">
        <h2>还没有电脑连上来</h2>
        <p>在要远程控制的电脑上运行下面的命令，这台电脑就会出现在这里：</p>
        <pre>agit rc start --detach</pre>
      </div>
    );
  }
  return (
    <div className="empty">
      <h2>{description?.machine?.display_name ?? "AgentGit Remote"}</h2>
      {peerState === "online" && catalogLoaded && projects.length === 0 ? (
        <p>还没有绑定项目文件夹。在左侧点「添加文件夹」，填入电脑上的项目路径。</p>
      ) : (
        <p>从左侧选一个会话，或者在项目旁点「+」开始新会话。</p>
      )}
      {projects.length > 0 && (
        <ul className="project-paths">
          {projects.map((project) => (
            <li key={project.project_id}>
              <strong>{projectName(project)}</strong>
              <span className="muted">{displayPath(project.local_path)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
