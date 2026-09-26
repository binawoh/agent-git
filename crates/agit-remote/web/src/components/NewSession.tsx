import { useEffect, useState } from "react";
import { displayPath, loadModels, projectName, startSession, toast, useStore } from "../store";
import type { ModelChoice } from "../types";
import { Composer, Picker } from "./Composer";
import { effortName, permissionName, runtimeName } from "./labels";

export function NewSession({ projectId }: { projectId: string | null }) {
  const projects = useStore((state) => state.projects);
  const description = useStore((state) => state.description);
  const peerState = useStore((state) => state.peerState);
  const available = Object.entries(description?.capabilities ?? {})
    .filter(([, capability]) => capability.available)
    .map(([name]) => name);
  const runtimes = available.length ? available : ["claude-code", "codex"];

  const [project, setProject] = useState(projectId ?? projects[0]?.project_id ?? "");
  const [runtime, setRuntime] = useState(() => localStorage.getItem("agit.runtime") ?? "claude-code");
  const [permission, setPermission] = useState(() => localStorage.getItem("agit.permission") ?? "default");
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  const activeRuntime = runtimes.includes(runtime) ? runtime : (runtimes[0] ?? runtime);
  const modes = description?.capabilities?.[activeRuntime]?.permission_modes ?? ["default"];
  const activePermission = modes.includes(permission) ? permission : "default";
  const cwd = projects.find((item) => item.project_id === project)?.local_path;

  useEffect(() => {
    if (!project && projects[0]) setProject(projects[0].project_id);
  }, [project, projects]);

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setModel("");
    setEffort("");
    if (peerState !== "online") return;
    setLoadingModels(true);
    void loadModels(activeRuntime, cwd).then((choices) => {
      if (cancelled) return;
      setModels(choices);
      setLoadingModels(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeRuntime, cwd, peerState]);

  async function submit(prompt: string) {
    if (!project) {
      toast("先在左侧添加一个项目文件夹");
      return;
    }
    localStorage.setItem("agit.runtime", activeRuntime);
    localStorage.setItem("agit.permission", activePermission);
    try {
      await startSession({
        projectId: project,
        runtime: activeRuntime,
        model: model || null,
        effort: effort || null,
        permissionMode: activePermission,
        prompt,
      });
    } catch (error) {
      toast(`新建会话失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const selected = projects.find((item) => item.project_id === project);
  // Efforts belong to a model; with no explicit choice, the default model's list applies.
  const chosen =
    models.find((choice) => choice.id === model) ??
    models.find((choice) => choice.is_default) ??
    models.find((choice) => choice.id === "default") ??
    models[0];
  const efforts = chosen?.efforts ?? [];
  const defaultEffort = chosen?.default_effort ? `默认强度（${effortName[chosen.default_effort] ?? chosen.default_effort}）` : "默认强度";
  return (
    <div className="new-session">
      <div className="new-hero">
        <h2>{selected ? `要在 ${projectName(selected)} 里做什么？` : "先在左侧添加一个项目文件夹"}</h2>
        {selected && <p className="muted">{displayPath(selected.local_path)}</p>}
      </div>
      <div className="composer-wrap">
        <Composer placeholder="描述你要做的事…" disabled={peerState !== "online" || !project} onSubmit={submit}>
          <Picker
            title="项目"
            value={project}
            disabled={projects.length < 2}
            options={projects.length ? projects.map((item) => ({ value: item.project_id, label: projectName(item) })) : [{ value: "", label: "没有项目" }]}
            onChange={setProject}
          />
          <Picker
            title="Agent"
            value={activeRuntime}
            options={runtimes.map((value) => ({ value, label: runtimeName[value] ?? value }))}
            onChange={setRuntime}
          />
          <Picker
            title={loadingModels ? "正在读取模型列表…" : "模型"}
            value={model}
            options={[{ value: "", label: loadingModels ? "默认模型（读取中…）" : "默认模型" }, ...models.map((choice) => ({ value: choice.id, label: choice.name ?? choice.id }))]}
            onChange={(value) => {
              setModel(value);
              setEffort("");
            }}
          />
          <Picker
            title="思考强度"
            value={effort}
            disabled={efforts.length === 0}
            options={[{ value: "", label: defaultEffort }, ...efforts.map((choice) => ({ value: choice.id, label: effortName[choice.id] ?? choice.name ?? choice.id }))]}
            onChange={setEffort}
          />
          <Picker
            title="权限模式"
            value={activePermission}
            options={modes.map((value) => ({ value, label: permissionName[value] ?? value }))}
            onChange={setPermission}
          />
        </Composer>
      </div>
    </div>
  );
}
