import { ArrowDown, Clock, Eye, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { continueStored, interrupt, loadHistory, loadModels, nativeRecords, projectOfLocal, runCommand, send, sessionCommands, sessionModel, setModel, setPermissionMode, useStore } from "../store";
import { emptyTranscript } from "../transcript";
import type { LocalSession, ModelChoice, ModelState, SessionInfo } from "../types";
import { Composer, type AttachTarget, type SlashCommand } from "./Composer";
import { commandCatalog, contextUse, extensionInfo, lastNative, newestLimits, planUsage, recordedSettings, rememberLimits, rememberNative, slashCommands, UsageRing, type RecordedSettings } from "./SessionInfo";
import { blocks, EntryView } from "./Entries";
import { effortName, runtimeName } from "./labels";
import { EffortPicker, effortOptions, ModelPicker, modelOptions, ModePicker } from "./Pickers";
import { elapsed, useTicking } from "./time";

export function SessionView({ sessionKey, local }: { sessionKey: string; local?: boolean }) {
  const transcript = useStore((state) => state.transcripts[sessionKey]) ?? emptyTranscript();
  const session = useStore((state) => (local ? undefined : state.sessions.find((item) => item.session_id === sessionKey)));
  const localInfo = useStore((state) => (local ? state.local.find((item) => item.runtime_session_id === sessionKey) : undefined));
  const entries = useMemo(() => blocks([...transcript.history, ...transcript.live]), [transcript.history, transcript.live]);
  const running = session?.status === "running" || session?.status === "awaiting_approval";

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    setAtBottom(pinned.current);
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
  function toBottom() {
    pinned.current = true;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="session">
      <div className="conversation-area">
        <div className="conversation" ref={scroller} onScroll={onScroll}>
          <div className="column">
            {transcript.loadingEarlier && <div className="loading-more">加载更早的消息…</div>}
            {transcript.loading && !transcript.loaded && (
              <div className="loading">
                <LoaderCircle size={18} className="spin" />
              </div>
            )}
            {transcript.error && <div className="notice error">读取记录失败：{transcript.error}</div>}
            {entries.map((block, index) => (
              <EntryView key={block.id} block={block} sessionId={sessionKey} live={running && index === entries.length - 1} />
            ))}
            {running && <Working awaiting={session?.status === "awaiting_approval"} since={transcript.turnStartedAt} />}
          </div>
        </div>
        {!atBottom && (
          <button type="button" className="jump-bottom" title="回到底部" aria-label="回到底部" onClick={toBottom}>
            <ArrowDown size={16} />
          </button>
        )}
      </div>
      {local ? localInfo?.likely_active ? (
        <div className="composer-wrap">
          <div className="readonly-bar">
            <Eye size={16} />
            <ReleaseNote modifiedAt={localInfo.modified_at} />
          </div>
        </div>
      ) : localInfo ? (
        <LocalComposer session={localInfo} />
      ) : null : session ? (
        <SessionComposer session={session} running={running} />
      ) : null}
    </div>
  );
}

/** The line under a running turn; the clock counts from when this page saw the turn start. */
function Working({ awaiting, since }: { awaiting: boolean; since: number | null }) {
  const [mounted] = useState(() => Date.now());
  const now = useTicking(!awaiting);
  const start = since ?? mounted;
  return (
    <div className={`working ${awaiting ? "awaiting" : ""}`}>
      {awaiting ? <span className="working-dot" /> : <LoaderCircle size={15} className="spin" />}
      <span>{awaiting ? "等待你审批" : "正在工作…"}</span>
      {!awaiting && <span className="working-time">{elapsed(now - start)}</span>}
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
  const [recorded, setRecorded] = useState<RecordedSettings>({});
  const native = useMemo(() => lastNative(session.runtime), [session.runtime]);
  const catalog = useMemo(() => commandCatalog(capability), [capability]);
  const commands = slashCommands(native.commands, null, catalog);
  const usage = planUsage(session.runtime, newestLimits(session.runtime, null));

  // Read again when the transcript grows, so changes made by another program show up too.
  useEffect(() => {
    let cancelled = false;
    if (peerState !== "online") return;
    void nativeRecords(session.runtime_session_id).then((items) => {
      if (!cancelled) setRecorded(recordedSettings(items));
    });
    return () => {
      cancelled = true;
    };
  }, [session.runtime_session_id, session.modified_at, peerState]);

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
  const ownModel = recorded.model ? models.find((choice) => choice.id === recorded.model)?.name || recorded.model : null;
  const ownEffort = recorded.effort ? effortName[recorded.effort] ?? recorded.effort : null;
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
        commands={commands}
        extensions={native.extensions}
        left={<ModePicker keep kept={recorded.mode} value={mode} modes={modes} disabled={modes.length === 0} onChange={setMode} />}
        right={
          <>
            <ModelPicker
              value={model}
              display={model ? undefined : ownModel ?? "原模型"}
              options={[{ value: "", label: ownModel ? `沿用原模型（${ownModel}）` : "沿用原模型", description: "保持这个会话原来的模型" }, ...modelOptions(models)]}
              onChange={(value) => {
                setModelChoice(value);
                setEffort("");
              }}
            />
            <EffortPicker
              value={effort}
              display={effort ? undefined : ownEffort ?? "原强度"}
              disabled={efforts.length === 0}
              options={[{ value: "", label: ownEffort ? `沿用原强度（${ownEffort}）` : "沿用原强度", description: "保持这个会话原来的思考强度" }, ...effortOptions(efforts)]}
              onChange={setEffort}
            />
            {(recorded.context || usage) && <UsageRing context={recorded.context ?? null} usage={usage} />}
          </>
        }
      />
    </div>
  );
}

function SessionComposer({ session, running }: { session: SessionInfo; running: boolean }) {
  const capability = useStore((state) => state.description?.capabilities?.[session.runtime]);
  const project = useStore((state) => state.projects.find((item) => item.project_id === session.project_id));
  const attach: AttachTarget | null = project ? { projectId: project.project_id, root: project.local_path } : null;
  const [state, setState] = useState<ModelState>({});
  // The executor refuses model changes during a turn; a change made then waits for its end.
  const [queued, setQueued] = useState<{ model?: string; effort?: string } | null>(null);
  const [liveCommands, setLiveCommands] = useState<SlashCommand[]>([]);
  const [recorded, setRecorded] = useState<RecordedSettings>({});
  const live = session.status !== "detached" && session.status !== "ended";

  // Context use changes with every turn, so the state is read again whenever a turn ends.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    void sessionModel(session.session_id).then((result) => {
      if (!cancelled && result) setState(result);
    });
    // Claude Code does not report its effort; its records name the effort of each reply.
    void nativeRecords(session.session_id).then((items) => {
      if (!cancelled) setRecorded(recordedSettings(items));
    });
    return () => {
      cancelled = true;
    };
  }, [session.session_id, running]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void sessionCommands(session.session_id).then((commands) => {
      if (!cancelled) setLiveCommands(commands.map((command) => ({ name: command.name, description: command.description })));
    });
    return () => {
      cancelled = true;
    };
  }, [session.session_id, live]);

  const catalog = useMemo(() => commandCatalog(capability), [capability]);
  const commands = slashCommands(liveCommands, state.native?.slash_commands, catalog);
  const extensions = extensionInfo(state);
  const context = contextUse(state) ?? recorded.context ?? null;
  const usage = planUsage(session.runtime, newestLimits(session.runtime, state.rate_limits));
  useEffect(() => rememberNative(session.runtime, { commands, extensions }), [session.runtime, state, liveCommands, catalog]);
  useEffect(() => rememberLimits(session.runtime, state.rate_limits), [session.runtime, state.rate_limits]);

  /** Codex runs its commands natively; Claude Code reads a `/name` message itself. */
  function submit(text: string) {
    const command = /^\/([\w:.-]+)\s*$/.exec(text.trim())?.[1];
    if (session.runtime === "codex" && command && liveCommands.some((item) => item.name === command)) return runCommand(session.session_id, command);
    return send(session.session_id, text);
  }

  const models = state.models ?? [];
  const model = state.selected_model ?? state.model ?? null;
  const efforts = state.efforts?.length ? state.efforts : models.find((choice) => choice.id === model)?.efforts;
  const mode = session.permission_mode ?? "default";
  const modes = capability?.permission_modes?.length ? capability.permission_modes : [mode];
  // The lists come from the running agent and can be slow or unavailable; the pickers stay in
  // place and show what is known.
  const modelChoices = modelOptions(models);
  if (model && !modelChoices.some((option) => option.value === model)) modelChoices.unshift({ value: model, label: model });
  if (modelChoices.length === 0) modelChoices.push({ value: "", label: "默认模型" });
  const effort = state.effort ?? "";
  const ownEffort = !effort && recorded.effort ? effortName[recorded.effort] ?? recorded.effort : null;
  const effortChoices = effortOptions(efforts);
  if (effort && !effortChoices.some((option) => option.value === effort)) effortChoices.unshift({ value: effort, label: effortName[effort] ?? effort });
  if (!effort) effortChoices.unshift({ value: "", label: "默认强度" });
  const note = queued ? "这一轮结束后切换" : undefined;

  useEffect(() => {
    if (running || !queued) return;
    setQueued(null);
    void apply(queued);
  }, [running, queued]);

  async function change(update: { model?: string; effort?: string }) {
    setState((current) => ({ ...current, ...update, ...(update.model !== undefined ? { selected_model: update.model } : {}) }));
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
        onSubmit={submit}
        onStop={() => void interrupt(session.session_id)}
        attach={attach}
        commands={commands}
        extensions={extensions}
        left={<ModePicker value={mode} modes={modes} disabled={modes.length < 2} onChange={(value) => void setPermissionMode(session.session_id, value)} />}
        right={
          <>
            {queued && (
              <span className="pending-note" title="模型或思考强度会在这一轮结束后切换">
                <Clock size={12} />
                <span>稍后生效</span>
              </span>
            )}
            <ModelPicker value={model ?? ""} options={modelChoices} disabled={models.length === 0} note={note} onChange={(value) => void change({ model: value })} />
            <EffortPicker
              value={effort}
              display={effort ? undefined : ownEffort ?? "默认"}
              options={effortChoices}
              disabled={!efforts?.length}
              note={note}
              onChange={(value) => void change({ effort: value })}
            />
            {(context || usage) && <UsageRing context={context} usage={usage} />}
          </>
        }
      />
    </div>
  );
}

/** Window of silence after which the executor treats a transcript as released; it matches the
 *  executor's own test, so the countdown ends when a takeover would be accepted. */
const RELEASE_SECONDS = 90;

function ReleaseNote({ modifiedAt }: { modifiedAt: string }) {
  const now = useTicking(true);
  const written = Date.parse(modifiedAt);
  const quiet = Number.isNaN(written) ? 0 : Math.max(0, Math.floor((now - written) / 1000));
  const left = Math.max(0, RELEASE_SECONDS - quiet);
  return (
    <span>
      这个会话正在电脑上的其他程序里运行，这里只能查看，内容每 4 秒刷新。
      {quiet < 5
        ? "它刚刚还在写入。"
        : left > 0
          ? `最后一次写入在 ${quiet} 秒前，再没有写入的话约 ${left} 秒后就能在这里接着聊。`
          : "已经停止写入，马上就能接着聊。"}
    </span>
  );
}
