import { ChevronDown, ChevronRight, FolderPlus, KeyRound, ListFilter, LogOut, Monitor, Plus, Search, X } from "lucide-react";
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

type Sort = "recent" | "name";
type AgentFilter = "all" | "claude-code" | "codex";

const PER_GROUP = 8;

function stored<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T | null) ?? fallback;
}

export function Sidebar() {
  const projects = useStore((state) => state.projects);
  const sessions = useStore((state) => state.sessions);
  const local = useStore((state) => state.local);
  const view = useStore((state) => state.view);
  const me = useStore((state) => state.me);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [sort, setSortState] = useState<Sort>(() => stored("agit.sort", "recent"));
  const [agent, setAgentState] = useState<AgentFilter>(() => stored("agit.agentFilter", "all"));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("agit.collapsed") ?? "[]")));

  const setSort = (value: Sort) => {
    localStorage.setItem("agit.sort", value);
    setSortState(value);
  };
  const setAgent = (value: AgentFilter) => {
    localStorage.setItem("agit.agentFilter", value);
    setAgentState(value);
  };
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    localStorage.setItem("agit.collapsed", JSON.stringify([...next]));
    setCollapsed(next);
  };

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const byProject = new Map<string, Row[]>();
    const push = (project: Project | undefined, row: Row) => {
      if (agent !== "all" && row.runtime !== agent) return;
      if (needle && !row.title.toLowerCase().includes(needle)) return;
      const key = project?.project_id ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), row]);
    };
    for (const session of sessions) {
      push(projects.find((project) => project.project_id === session.project_id), {
        key: session.session_id,
        title: sessionTitle(session),
        time: Date.parse(session.updated_at) || 0,
        status: session.status,
        runtime: session.runtime,
        session,
      });
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
    const result = projects.map((project) => {
      const rows = (byProject.get(project.project_id) ?? []).sort((a, b) => b.time - a.time);
      return { key: project.project_id, project, rows, latest: rows[0]?.time ?? 0 };
    });
    const other = (byProject.get("") ?? []).sort((a, b) => b.time - a.time);
    if (other.length) result.push({ key: "", project: undefined as unknown as Project, rows: other, latest: other[0].time });
    result.sort((a, b) =>
      sort === "name" ? (a.project ? projectName(a.project) : "~").localeCompare(b.project ? projectName(b.project) : "~", "zh-CN") : b.latest - a.latest,
    );
    // While searching or filtering, groups without a match are noise.
    return needle || agent !== "all" ? result.filter((group) => group.rows.length > 0) : result;
  }, [projects, sessions, local, sort, agent, needle]);

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
        <button className="nav-item" onClick={() => open({ type: "new", projectId: groups.find((group) => group.project)?.project.project_id ?? projects[0]?.project_id ?? null })}>
          <Plus size={16} /> 新会话
        </button>
      </div>
      <div className="section-header">
        <span>项目</span>
        <div className="section-actions">
          <button className={`icon-button small ${searching ? "active" : ""}`} title="搜索会话" onClick={() => { setSearching(!searching); setQuery(""); }}>
            <Search size={14} />
          </button>
          <button className={`icon-button small ${menu || sort !== "recent" || agent !== "all" ? "active" : ""}`} title="排序和筛选" onClick={() => setMenu(!menu)}>
            <ListFilter size={14} />
          </button>
          <button className="icon-button small" title="添加文件夹" onClick={() => void addFolder()}>
            <FolderPlus size={14} />
          </button>
        </div>
      </div>
      {searching && (
        <div className="sidebar-search">
          <Search size={14} />
          <input autoFocus placeholder="搜索会话标题" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && (
            <button className="icon-button small" title="清空" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {menu && (
        <div className="sort-menu">
          <div className="menu-label">排序</div>
          <MenuItem active={sort === "recent"} onClick={() => setSort("recent")}>按最近活动</MenuItem>
          <MenuItem active={sort === "name"} onClick={() => setSort("name")}>按名称</MenuItem>
          <div className="menu-label">Agent</div>
          <MenuItem active={agent === "all"} onClick={() => setAgent("all")}>全部</MenuItem>
          <MenuItem active={agent === "claude-code"} onClick={() => setAgent("claude-code")}>Claude Code</MenuItem>
          <MenuItem active={agent === "codex"} onClick={() => setAgent("codex")}>Codex</MenuItem>
        </div>
      )}
      <nav className="sidebar-scroll">
        {groups.map(({ key, project, rows }) => (
          <Group key={key || "other"} project={project} rows={rows} selected={selected} collapsed={!needle && collapsed.has(key)} onToggle={() => toggle(key)} />
        ))}
        {groups.length === 0 && <div className="group-empty">{needle || agent !== "all" ? "没有匹配的会话" : "还没有项目，点上方的文件夹按钮添加"}</div>}
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

function MenuItem(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button className={`menu-item ${props.active ? "active" : ""}`} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

function Group(props: { project: Project | undefined; rows: Row[]; selected: string | null; collapsed: boolean; onToggle: () => void }) {
  const { project, rows, selected, collapsed } = props;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, PER_GROUP);
  return (
    <section className="group">
      <div className="group-header">
        <button className="group-toggle" title={project?.local_path} onClick={props.onToggle}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>{project ? projectName(project) : "其他"}</span>
          {collapsed && rows.length > 0 && <span className="group-count">{rows.length}</span>}
        </button>
        {project && (
          <button className="icon-button small" title="在这个项目里新建会话" onClick={() => open({ type: "new", projectId: project.project_id })}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          {shown.map((row) => (
            <button
              key={row.key}
              className={`session-row ${row.key === selected ? "selected" : ""}`}
              title={`${runtimeName[row.runtime] ?? row.runtime} · ${statusText(row.status)}`}
              onClick={() => open(row.local ? { type: "local", nativeId: row.key } : { type: "session", sessionId: row.key })}
            >
              <span className={`dot ${row.status}`} />
              <span className="row-title">{row.title}</span>
              <span className={`runtime-mark ${row.runtime}`}>{row.runtime === "codex" ? "Cx" : row.runtime === "claude-code" ? "CC" : "OC"}</span>
            </button>
          ))}
          {rows.length > PER_GROUP && (
            <button className="more" onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : `显示全部 ${rows.length} 个`}
            </button>
          )}
          {rows.length === 0 && <div className="group-empty">暂无会话</div>}
        </>
      )}
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
