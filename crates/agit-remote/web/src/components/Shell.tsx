import { Menu } from "lucide-react";
import { displayPath, projectName, projectOfLocal, useStore } from "../store";
import { NewSession } from "./NewSession";
import { SessionView } from "./SessionView";
import { Sidebar } from "./Sidebar";
import { runtimeName, sessionTitle } from "./labels";

export function Shell() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const view = useStore((state) => state.view);
  return (
    <div className={`shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <Sidebar />
      <div className="backdrop" onClick={() => useStore.setState({ sidebarOpen: false })} />
      <main className="main">
        <TopBar />
        <ConnectionBanner />
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

function ConnectionBanner() {
  const connection = useStore((state) => state.connection);
  const peerState = useStore((state) => state.peerState);
  const peerError = useStore((state) => state.peerError);
  const devices = useStore((state) => state.devices);
  if (connection !== "open") return <div className="banner">与服务器的连接断开了，正在重连…</div>;
  if (devices.length === 0) return null;
  if (peerState === "offline") return <div className="banner warn">这台电脑现在离线。确认电脑开着，并且 agit daemon 在运行（agit rc start）。</div>;
  if (peerState === "connecting") return <div className="banner">正在连接电脑…</div>;
  if (peerState === "backoff" || peerState === "rejected" || peerState === "stopped")
    return <div className="banner warn">连接电脑失败{peerError ? `：${peerError}` : ""}，正在重试…</div>;
  return null;
}

function Home() {
  const devices = useStore((state) => state.devices);
  const description = useStore((state) => state.description);
  const projects = useStore((state) => state.projects);
  const peerState = useStore((state) => state.peerState);
  const catalogLoaded = useStore((state) => state.catalogLoaded);
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
