import { LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { continueStored, interrupt, loadHistory, loadModels, projectOfLocal, send, sessionModel, setModel, setPermissionMode, useStore } from "../store";
import { emptyTranscript } from "../transcript";
import type { EffortChoice, LocalSession, ModelChoice, ModelState, SessionInfo } from "../types";
import { Composer, Picker, type AttachTarget } from "./Composer";
import { blocks, EntryView } from "./Entries";
import { effortName, permissionName, runtimeName } from "./labels";

export function SessionView({ sessionKey, local }: { sessionKey: string; local?: boolean }) {
  const transcript = useStore((state) => state.transcripts[sessionKey]) ?? emptyTranscript();
  const session = useStore((state) => (local ? undefined : state.sessions.find((item) => item.session_id === sessionKey)));
  const localInfo = useStore((state) => (local ? state.local.find((item) => item.runtime_session_id === sessionKey) : undefined));
  const entries = useMemo(() => blocks([...transcript.history, ...transcript.live]), [transcript.history, transcript.live]);
  const running = session?.status === "running" || session?.status === "awaiting_approval";

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    if (element.scrollTop < 80 && transcript.hasMore && !transcript.loadingEarlier) {
      const before = element.scrollHeight;
      void loadHistory(sessionKey, true).then(() => {
        // Keep the reader's place when older messages are prepended.
        requestAnimationFrame(() => {
          if (scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - before;
        });
      });
    }
  }

  return (
    <div className="session">
      <div className="conversation" ref={scroller} onScroll={onScroll}>
        <div className="column">
          {transcript.loadingEarlier && <div className="loading-more">加载更早的消息…</div>}
          {transcript.loading && !transcript.loaded && (
            <div className="loading">
              <LoaderCircle size={18} className="spin" />
            </div>
          )}
          {transcript.error && <div className="notice error">读取记录失败：{transcript.error}</div>}
          {entries.map((block) => (
            <EntryView key={block.id} block={block} sessionId={sessionKey} />
          ))}
          {running && (
            <div className="working">
              <span className="pulse" /> {session?.status === "awaiting_approval" ? "等待你审批" : "正在工作…"}
            </div>
          )}
        </div>
      </div>
      {local ? localInfo?.likely_active ? (
        <div className="local-bar">
          <span>这个会话正在电脑上的其他程序里运行，这里只能查看，每 4 秒自动刷新。关掉那边之后就能在这里接着聊。</span>
        </div>
      ) : localInfo ? (
        <LocalComposer session={localInfo} />
      ) : null : session ? (
        <SessionComposer session={session} running={running} />
      ) : null}
    </div>
  );
}

/** A stored native session continues on its first message. With every picker on "keep" the
 *  takeover carries the message and the session keeps its own settings; a changed picker is
 *  applied after the takeover, before the message is sent. */
function LocalComposer({ session }: { session: LocalSession }) {
  const capability = useStore((state) => state.description?.capabilities?.[session.runtime]);
  const peerState = useStore((state) => state.peerState);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModelChoice] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (peerState !== "online") return;
    void loadModels(session.runtime, session.cwd).then((choices) => {
      if (!cancelled) setModels(choices);
    });
    return () => {
      cancelled = true;
    };
  }, [session.runtime, session.cwd, peerState]);

  const chosen =
    models.find((choice) => choice.id === model) ??
    models.find((choice) => choice.is_default) ??
    models.find((choice) => choice.id === "default") ??
    models[0];
  const efforts = chosen?.efforts ?? [];
  const modes = capability?.permission_modes ?? [];
  const project = projectOfLocal(session);
  const attach: AttachTarget | null = project ? { projectId: project.project_id, root: project.local_path } : null;

  return (
    <div className="composer-wrap">
      <Composer
        placeholder={`接着这个会话发消息给 ${runtimeName[session.runtime] ?? session.runtime}…`}
        draftKey={session.runtime_session_id}
        attach={attach}
        onSubmit={(text) =>
          continueStored(session.runtime_session_id, text, {
            model: model || undefined,
            effort: effort || undefined,
            permissionMode: mode || undefined,
          })
        }
      >
        <span className="picker static" title="Agent（会话创建后不能更换）">
          {runtimeName[session.runtime] ?? session.runtime}
        </span>
        <Picker
          title="模型"
          value={model}
          options={[{ value: "", label: "沿用原模型" }, ...models.map((choice) => ({ value: choice.id, label: choice.name ?? choice.id }))]}
          onChange={(value) => {
            setModelChoice(value);
            setEffort("");
          }}
        />
        <Picker
          title="思考强度"
          value={effort}
          disabled={efforts.length === 0}
          options={[{ value: "", label: "沿用原强度" }, ...efforts.map((choice) => ({ value: choice.id, label: effortName[choice.id] ?? choice.name ?? choice.id }))]}
          onChange={setEffort}
        />
        <Picker
          title="权限模式"
          value={mode}
          disabled={modes.length === 0}
          options={[{ value: "", label: "沿用原权限" }, ...modes.map((value) => ({ value, label: permissionName[value] ?? value }))]}
          onChange={setMode}
        />
      </Composer>
    </div>
  );
}

function effortOptions(efforts: EffortChoice[] | undefined, current: string | null | undefined, defaultLabel: string) {
  const options = (efforts ?? []).map((choice) => ({ value: choice.id, label: effortName[choice.id] ?? choice.name ?? choice.id }));
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: effortName[current] ?? current });
  if (!current) options.unshift({ value: "", label: defaultLabel });
  return options;
}

function SessionComposer({ session, running }: { session: SessionInfo; running: boolean }) {
  const capability = useStore((state) => state.description?.capabilities?.[session.runtime]);
  const project = useStore((state) => state.projects.find((item) => item.project_id === session.project_id));
  const attach: AttachTarget | null = project ? { projectId: project.project_id, root: project.local_path } : null;
  const [state, setState] = useState<ModelState>({});
  // The executor refuses model changes during a turn; a change made then waits for its end.
  const [queued, setQueued] = useState<{ model?: string; effort?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void sessionModel(session.session_id).then((result) => {
      if (!cancelled && result) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [session.session_id]);

  const models = state.models ?? [];
  const model = state.model ?? null;
  const efforts = state.efforts?.length ? state.efforts : models.find((choice) => choice.id === model)?.efforts;
  const mode = session.permission_mode ?? "default";
  const modes = capability?.permission_modes?.length ? capability.permission_modes : [mode];
  // The lists come from the running agent and can be slow or unavailable; the pickers stay in
  // place and show what is known.
  const modelOptions = models.map((choice) => ({ value: choice.id, label: choice.name ?? choice.id }));
  if (model && !modelOptions.some((option) => option.value === model)) modelOptions.unshift({ value: model, label: model });
  if (modelOptions.length === 0) modelOptions.push({ value: "", label: "默认模型" });

  useEffect(() => {
    if (running || !queued) return;
    setQueued(null);
    void apply(queued);
  }, [running, queued]);

  async function change(update: { model?: string; effort?: string }) {
    setState((current) => ({ ...current, ...update }));
    if (running) {
      setQueued((current) => ({ ...(current ?? {}), ...update, ...(update.model !== undefined && update.effort === undefined ? { effort: undefined } : {}) }));
      return;
    }
    await apply(update);
  }

  async function apply(update: { model?: string; effort?: string }) {
    const result = await setModel(session.session_id, update);
    // A different model can offer different efforts; read back what now applies.
    const fresh = result && result.efforts !== undefined ? result : await sessionModel(session.session_id);
    if (fresh) setState(fresh);
  }

  return (
    <div className="composer-wrap">
      <Composer
        placeholder={running ? "补充说明，会在合适的时机交给 agent…" : `发消息给 ${runtimeName[session.runtime] ?? session.runtime}…`}
        running={running}
        draftKey={session.session_id}
        onSubmit={(text) => send(session.session_id, text)}
        onStop={() => void interrupt(session.session_id)}
        attach={attach}
      >
        <span className="picker static" title="Agent（会话创建后不能更换）">
          {runtimeName[session.runtime] ?? session.runtime}
        </span>
        {queued && <span className="pending-note">本轮结束后生效</span>}
        <Picker title="模型" value={model ?? ""} disabled={models.length === 0} options={modelOptions} onChange={(value) => void change({ model: value })} />
        <Picker
          title="思考强度"
          value={state.effort ?? ""}
          disabled={!efforts?.length}
          options={effortOptions(efforts, state.effort, "默认强度")}
          onChange={(value) => void change({ effort: value })}
        />
        <Picker
          title="权限模式"
          value={mode}
          disabled={modes.length < 2}
          options={modes.map((value) => ({ value, label: permissionName[value] ?? value }))}
          onChange={(value) => void setPermissionMode(session.session_id, value)}
        />
      </Composer>
    </div>
  );
}
