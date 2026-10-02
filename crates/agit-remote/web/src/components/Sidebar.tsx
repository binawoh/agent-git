import { ChevronDown, ChevronRight, ChevronsUpDown, FolderPlus, KeyRound, ListFilter, LoaderCircle, LogOut, Monitor, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { locale, locales, switchLocale, t } from "../i18n";
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
      sort === "name" ? (a.project ? projectName(a.project) : "~").localeCompare(b.project ? projectName(b.project) : "~", locale) : b.latest - a.latest,
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
        <button type="button" className="sidebar-icon desktop-only" title={t.sidebar.collapse} aria-label={t.sidebar.collapse} onClick={() => setSidebarCollapsed(true)}>
          <PanelLeftClose size={17} />
        </button>
        <button type="button" className="sidebar-icon mobile-only" title={t.sidebar.close} aria-label={t.sidebar.close} onClick={() => useStore.setState({ sidebarOpen: false })}>
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
          <span>{t.common.newSession}</span>
        </button>
      </div>
      <div className="section-header">
        <span>{t.sidebar.projects}</span>
        <div className="section-actions">
          <button
            type="button"
            className={`icon-button small ${searching ? "active" : ""}`}
            title={t.sidebar.searchSessions}
            aria-label={t.sidebar.searchSessions}
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
              <button type="button" className={`icon-button small ${isOpen || filtered ? "active" : ""}`} title={t.sidebar.sortAndFilter} aria-label={t.sidebar.sortAndFilter} onClick={toggleMenu}>
                <ListFilter size={14} />
              </button>
            )}
            items={[
              { heading: t.sidebar.sort },
              { label: t.sidebar.byRecent, checked: sort === "recent", onSelect: () => setSort("recent") },
              { label: t.sidebar.byName, checked: sort === "name", onSelect: () => setSort("name") },
              { heading: "Agent" },
              { label: t.sidebar.all, checked: agent === "all", onSelect: () => setAgent("all") },
              { label: "Claude Code", checked: agent === "claude-code", onSelect: () => setAgent("claude-code") },
              { label: "Codex", checked: agent === "codex", onSelect: () => setAgent("codex") },
            ]}
          />
          <button type="button" className="icon-button small" title={t.common.addFolder} aria-label={t.common.addFolder} onClick={() => useStore.setState({ folderDialog: true })}>
            <FolderPlus size={14} />
          </button>
        </div>
      </div>
      {searching && (
        <div className="sidebar-search">
          <Search size={14} />
          <input autoFocus placeholder={t.sidebar.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && (
            <button type="button" className="icon-button small" title={t.common.clear} aria-label={t.common.clear} onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
      )}
      <nav className="sidebar-scroll">
        {groups.map(({ key, project, rows }) => (
          <Group key={key || "other"} project={project} rows={rows} selected={selected} now={now} collapsed={!needle && collapsed.has(key)} onToggle={() => toggle(key)} />
        ))}
        {groups.length === 0 && <div className="group-empty">{needle || agent !== "all" ? t.sidebar.noMatch : t.sidebar.noProjects}</div>}
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
              label: me?.password_login ? t.password.change : t.password.set,
              icon: <KeyRound size={15} />,
              onSelect: () => useStore.setState({ passwordDialog: true }),
            },
            { separator: true },
            { heading: t.sidebar.language },
            ...locales.map((item) => ({ label: item.name, checked: item.id === locale, onSelect: () => switchLocale(item.id) })),
            { separator: true },
            { label: t.sidebar.signOut, icon: <LogOut size={15} />, danger: true, onSelect: () => void signOut() },
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
          <span className="group-name">{project ? projectName(project) : t.sidebar.other}</span>
          {collapsed && rows.length > 0 && <span className="group-count">{rows.length}</span>}
        </button>
        {project && (
          <button type="button" className="group-add" title={t.sidebar.newInProject} aria-label={t.sidebar.newInProject} onClick={() => open({ type: "new", projectId: project.project_id })}>
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
                <span className="row-status">
                  <RowStatus status={row.status} time={row.time} now={props.now} />
                </span>
              </span>
            </button>
          ))}
          {rows.length > PER_GROUP && (
            <button type="button" className="more" onClick={() => setExpanded(!expanded)}>
              {expanded ? t.sidebar.showLess : t.sidebar.showAll(rows.length)}
            </button>
          )}
          {rows.length === 0 && <div className="group-empty">{t.sidebar.empty}</div>}
        </>
      )}
    </section>
  );
}

function RowStatus({ status, time, now }: { status: string; time: number; now: number }) {
  if (status === "running") return <LoaderCircle size={13} className="spin row-running" />;
  if (status === "awaiting_approval") return <span className="row-badge">{t.sidebar.awaitingBadge}</span>;
  return (
    <>
      {status === "elsewhere" && <span className="row-dot" />}
      <span className="row-time">{ago(time, now)}</span>
    </>
  );
}

function statusText(status: string): string {
  if (status === "elsewhere") return t.sidebar.elsewhere;
  if (status === "stored") return t.sidebar.stored;
  return statusName[status] ?? status;
}

function DevicePicker() {
  const devices = useStore((state) => state.devices);
  const deviceId = useStore((state) => state.deviceId);
  const peerState = useStore((state) => state.peerState);
  const devicesLoaded = useStore((state) => state.devicesLoaded);
  const current = devices.find((row) => row.device.id === deviceId);
  const state = peerState === "online" ? "online" : current?.online ? "connecting" : "offline";
  const stateText = state === "online" ? t.common.connected : state === "connecting" ? t.common.connecting : current ? t.common.offline : "";
  return (
    <MenuPicker
      className="device-picker"
      placement="bottom"
      title={t.sidebar.computer}
      icon={
        <span className="device-icon">
          <Monitor size={16} />
          <span className={`status-dot ${state}`} />
        </span>
      }
      value={deviceId ?? ""}
      display={
        <span className="device-label">
          <span className="device-name">{current?.device.display_name ?? (devicesLoaded ? t.sidebar.noComputer : t.common.connecting)}</span>
          {stateText && <span className="device-state">{stateText}</span>}
        </span>
      }
      disabled={devices.length < 2}
      options={devices.map((row) => ({
        value: row.device.id,
        label: row.device.display_name,
        description: row.online ? t.common.online : t.common.offline,
        icon: <span className={`status-dot ${row.online ? "online" : "offline"}`} />,
      }))}
      onChange={(value) => void selectDevice(value)}
    />
  );
}
