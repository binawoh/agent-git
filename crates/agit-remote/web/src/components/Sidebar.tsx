import { FolderPlus, KeyRound, LogOut, Monitor, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { bindProject, open, projectName, projectOfLocal, selectDevice, signOut, toast, useStore } from "../store";
import type { LocalSession, Project, SessionInfo } from "../types";
import { runtimeName, sessionTitle, statusName } from "./labels";

interface Row {
  key: string;
  title: string;
  time: number;
  status: string;
  runtime: string;
  local?: LocalSession;
  session?: SessionInfo;
}

const PER_GROUP = 8;

export function Sidebar() {
  const projects = useStore((state) => state.projects);
  const sessions = useStore((state) => state.sessions);
  const local = useStore((state) => state.local);
  const view = useStore((state) => state.view);
  const me = useStore((state) => state.me);

  const groups = useMemo(() => {
    const byProject = new Map<string, Row[]>();
    const other: Row[] = [];
    const push = (project: Project | undefined, row: Row) => {
      if (!project) return other.push(row);
      byProject.set(project.project_id, [...(byProject.get(project.project_id) ?? []), row]);
    };
    for (const session of sessions) {
      push(
        projects.find((project) => project.project_id === session.project_id),
        { key: session.session_id, title: sessionTitle(session), time: Date.parse(session.updated_at) || 0, status: session.status, runtime: session.runtime, session },
      );
    }
    for (const session of local) {
      push(projectOfLocal(session), {
        key: session.runtime_session_id,
        title: sessionTitle(session),
        time: Date.parse(session.modified_at) || 0,
        status: session.likely_active ? "elsewhere" : "stored",
        runtime: session.runtime,
        local: session,
      });
    }
    const sort = (rows: Row[]) => rows.sort((a, b) => b.time - a.time);
    const result = projects.map((project) => ({ project, rows: sort(byProject.get(project.project_id) ?? []) }));
    if (other.length) result.push({ project: undefined as unknown as Project, rows: sort(other) });
    return result;
  }, [projects, sessions, local]);

  const selected = view.type === "session" ? view.sessionId : view.type === "local" ? view.nativeId : null;

  async function addFolder() {
    const path = window.prompt("输入电脑上的项目文件夹路径，例如 D:\\codex\\my-project");
    if (!path?.trim()) return;
    try {
      await bindProject(path.trim());
      toast("已添加文件夹", "info");
    } catch (error) {
      toast(`添加失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <DevicePicker />
        <button className="nav-item" onClick={() => open({ type: "new", projectId: projects[0]?.project_id ?? null })}>
          <Plus size={16} /> 新会话
        </button>
      </div>
      <nav className="sidebar-scroll">
        {groups.map(({ project, rows }) => (
          <Group key={project?.project_id ?? "other"} project={project} rows={rows} selected={selected} />
        ))}
        <button className="nav-item muted" onClick={addFolder}>
          <FolderPlus size={16} /> 添加文件夹
        </button>
      </nav>
      <div className="sidebar-footer">
        <span className="avatar">{me?.username.slice(0, 1).toUpperCase()}</span>
        <span className="footer-name">{me?.username}</span>
        <button className="icon-button" title={me?.password_login ? "修改登录密码" : "设置登录密码"} onClick={() => useStore.setState({ passwordDialog: true })}>
          <KeyRound size={16} />
        </button>
        <button className="icon-button" title="退出登录" onClick={() => void signOut()}>
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}

function Group({ project, rows, selected }: { project: Project | undefined; rows: Row[]; selected: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, PER_GROUP);
  return (
    <section className="group">
      <div className="group-header">
        <span title={project?.local_path}>{project ? projectName(project) : "其他"}</span>
        {project && (
          <button className="icon-button small" title="在这个项目里新建会话" onClick={() => open({ type: "new", projectId: project.project_id })}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {shown.map((row) => (
        <button
          key={row.key}
          className={`session-row ${row.key === selected ? "selected" : ""}`}
          title={`${runtimeName[row.runtime] ?? row.runtime} · ${statusText(row.status)}`}
          onClick={() => open(row.local ? { type: "local", nativeId: row.key } : { type: "session", sessionId: row.key })}
        >
          <span className={`dot ${row.status}`} />
          <span className="row-title">{row.title}</span>
        </button>
      ))}
      {rows.length > PER_GROUP && (
        <button className="more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `显示全部 ${rows.length} 个`}
        </button>
      )}
      {rows.length === 0 && <div className="group-empty">暂无会话</div>}
    </section>
  );
}

function statusText(status: string): string {
  if (status === "elsewhere") return "正在其他程序中运行";
  if (status === "stored") return "本机历史会话";
  return statusName[status] ?? status;
}

function DevicePicker() {
  const devices = useStore((state) => state.devices);
  const deviceId = useStore((state) => state.deviceId);
  const peerState = useStore((state) => state.peerState);
  const current = devices.find((row) => row.device.id === deviceId);
  const state = peerState === "online" ? "online" : current?.online ? "connecting" : "offline";
  return (
    <div className="device">
      <Monitor size={16} />
      {devices.length > 1 ? (
        <select value={deviceId ?? ""} onChange={(event) => void selectDevice(event.target.value)}>
          {devices.map((row) => (
            <option key={row.device.id} value={row.device.id}>
              {row.device.display_name}
              {row.online ? "" : "（离线）"}
            </option>
          ))}
        </select>
      ) : (
        <span className="device-name">{current?.device.display_name ?? "没有电脑"}</span>
      )}
      <span className={`dot ${state}`} title={state === "online" ? "已连接" : state === "connecting" ? "连接中" : "离线"} />
    </div>
  );
}
