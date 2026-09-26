import { ChevronDown, ChevronRight, ChevronsUpDown, FolderPlus, KeyRound, ListFilter, LoaderCircle, LogOut, Monitor, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { open, projectName, projectOfLocal, selectDevice, setSidebarCollapsed, signOut, useStore } from "../store";
import type { LocalSession, Project, SessionInfo } from "../types";
import { runtimeMark, runtimeName, sessionTitle, statusName } from "./labels";
import { ActionMenu, MenuPicker } from "./Menu";
import { ago, useTicking } from "./time";

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
  const [sort, setSortState] = useState<Sort>(() => stored("agit.sort", "recent"));
  const [agent, setAgentState] = useState<AgentFilter>(() => stored("agit.agentFilter", "all"));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("agit.collapsed") ?? "[]")));
  const now = useTicking(true, 60_000);

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
  const filtered = sort !== "recent" || agent !== "all";

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <DevicePicker />
        <button type="button" className="sidebar-icon desktop-only" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebarCollapsed(true)}>
          <PanelLeftClose size={17} />
        </button>
        <button type="button" className="sidebar-icon mobile-only" title="关闭侧栏" aria-label="关闭侧栏" onClick={() => useStore.setState({ sidebarOpen: false })}>
          <X size={17} />
        </button>
      </div>
      <div className="sidebar-nav">
        <button
          type="button"
          className="nav-item"
          onClick={() => open({ type: "new", projectId: groups.find((group) => group.project)?.project.project_id ?? projects[0]?.project_id ?? null })}
        >
          <Plus size={16} />
          <span>新会话</span>
        </button>
      </div>
      <div className="section-header">
        <span>项目</span>
        <div className="section-actions">
          <button
            type="button"
            className={`icon-button small ${searching ? "active" : ""}`}
            title="搜索会话"
            aria-label="搜索会话"
            onClick={() => {
              setSearching(!searching);
              setQuery("");
            }}
          >
            <Search size={14} />
          </button>
          <ActionMenu
            align="right"
            trigger={(isOpen, toggleMenu) => (
              <button type="button" className={`icon-button small ${isOpen || filtered ? "active" : ""}`} title="排序和筛选" aria-label="排序和筛选" onClick={toggleMenu}>
                <ListFilter size={14} />
              </button>
            )}
            items={[
              { heading: "排序" },
              { label: "按最近活动", checked: sort === "recent", onSelect: () => setSort("recent") },
              { label: "按名称", checked: sort === "name", onSelect: () => setSort("name") },
              { heading: "Agent" },
              { label: "全部", checked: agent === "all", onSelect: () => setAgent("all") },
              { label: "Claude Code", checked: agent === "claude-code", onSelect: () => setAgent("claude-code") },
              { label: "Codex", checked: agent === "codex", onSelect: () => setAgent("codex") },
            ]}
          />
          <button type="button" className="icon-button small" title="添加文件夹" aria-label="添加文件夹" onClick={() => useStore.setState({ folderDialog: true })}>
            <FolderPlus size={14} />
          </button>
        </div>
      </div>
      {searching && (
        <div className="sidebar-search">
          <Search size={14} />
          <input autoFocus placeholder="搜索会话标题" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && (
            <button type="button" className="icon-button small" title="清空" aria-label="清空" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
      )}
      <nav className="sidebar-scroll">
        {groups.map(({ key, project, rows }) => (
          <Group key={key || "other"} project={project} rows={rows} selected={selected} now={now} collapsed={!needle && collapsed.has(key)} onToggle={() => toggle(key)} />
        ))}
        {groups.length === 0 && <div className="group-empty">{needle || agent !== "all" ? "没有匹配的会话" : "还没有项目，点上方的文件夹按钮添加"}</div>}
      </nav>
      <div className="sidebar-footer">
        <ActionMenu
          placement="top"
          className="account-anchor"
          trigger={(isOpen, toggleMenu) => (
            <button type="button" className={`account ${isOpen ? "open" : ""}`} onClick={toggleMenu}>
              <span className="avatar">{me?.username.slice(0, 1).toUpperCase()}</span>
              <span className="account-name">{me?.username}</span>
              <ChevronsUpDown size={14} className="account-chevron" />
            </button>
          )}
          items={[
            {
              label: me?.password_login ? "修改登录密码" : "设置登录密码",
              icon: <KeyRound size={15} />,
              onSelect: () => useStore.setState({ passwordDialog: true }),
            },
            { separator: true },
            { label: "退出登录", icon: <LogOut size={15} />, danger: true, onSelect: () => void signOut() },
          ]}
        />
      </div>
    </aside>
  );
}

function Group(props: { project: Project | undefined; rows: Row[]; selected: string | null; now: number; collapsed: boolean; onToggle: () => void }) {
  const { project, rows, selected, collapsed } = props;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, PER_GROUP);
  return (
    <section className="group">
      <div className="group-header">
        <button type="button" className="group-toggle" title={project?.local_path} aria-expanded={!collapsed} onClick={props.onToggle}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="group-name">{project ? projectName(project) : "其他"}</span>
          {collapsed && rows.length > 0 && <span className="group-count">{rows.length}</span>}
        </button>
        {project && (
          <button type="button" className="group-add" title="在这个项目里新建会话" aria-label="在这个项目里新建会话" onClick={() => open({ type: "new", projectId: project.project_id })}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          {shown.map((row) => (
            <button
              type="button"
              key={row.key}
              className={`session-row ${row.key === selected ? "selected" : ""}`}
              title={`${row.title}\n${runtimeName[row.runtime] ?? row.runtime} · ${statusText(row.status)}`}
              onClick={() => open(row.local ? { type: "local", nativeId: row.key } : { type: "session", sessionId: row.key })}
            >
              <span className="row-title">{row.title}</span>
              <span className="row-meta">
                <span className="runtime-mark">{runtimeMark[row.runtime] ?? row.runtime.slice(0, 2)}</span>
                <RowStatus status={row.status} time={row.time} now={props.now} />
              </span>
            </button>
          ))}
          {rows.length > PER_GROUP && (
            <button type="button" className="more" onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : `显示全部 ${rows.length} 个`}
            </button>
          )}
          {rows.length === 0 && <div className="group-empty">暂无会话</div>}
        </>
      )}
    </section>
  );
}

function RowStatus({ status, time, now }: { status: string; time: number; now: number }) {
  if (status === "running") return <LoaderCircle size={13} className="spin row-running" />;
  if (status === "awaiting_approval") return <span className="row-badge">待审批</span>;
  return (
    <>
      {status === "elsewhere" && <span className="row-dot" />}
      <span className="row-time">{ago(time, now)}</span>
    </>
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
  const devicesLoaded = useStore((state) => state.devicesLoaded);
  const current = devices.find((row) => row.device.id === deviceId);
  const state = peerState === "online" ? "online" : current?.online ? "connecting" : "offline";
  const stateText = state === "online" ? "已连接" : state === "connecting" ? "连接中…" : current ? "离线" : "";
  return (
    <MenuPicker
      className="device-picker"
      placement="bottom"
      title="电脑"
      icon={
        <span className="device-icon">
          <Monitor size={16} />
          <span className={`status-dot ${state}`} />
        </span>
      }
      value={deviceId ?? ""}
      display={
        <span className="device-label">
          <span className="device-name">{current?.device.display_name ?? (devicesLoaded ? "没有电脑" : "连接中…")}</span>
          {stateText && <span className="device-state">{stateText}</span>}
        </span>
      }
      disabled={devices.length < 2}
      options={devices.map((row) => ({
        value: row.device.id,
        label: row.device.display_name,
        description: row.online ? "在线" : "离线",
        icon: <span className={`status-dot ${row.online ? "online" : "offline"}`} />,
      }))}
      onChange={(value) => void selectDevice(value)}
    />
  );
}
