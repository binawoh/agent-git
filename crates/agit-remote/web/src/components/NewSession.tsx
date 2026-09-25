import { useEffect, useState } from "react";
import { displayPath, loadModels, projectName, startSession, toast, useStore } from "../store";
import type { ModelChoice } from "../types";
import { Composer, Picker } from "./Composer";
import { permissionName, runtimeName } from "./labels";

export function NewSession({ projectId }: { projectId: string | null }) {
  const projects = useStore((state) => state.projects);
  const description = useStore((state) => state.description);
  const peerState = useStore((state) => state.peerState);
  const runtimes = Object.entries(description?.capabilities ?? {})
    .filter(([, capability]) => capability.available)
    .map(([name]) => name);

  const [project, setProject] = useState(projectId ?? projects[0]?.project_id ?? "");
  const [runtime, setRuntime] = useState(() => localStorage.getItem("agit.runtime") ?? "claude-code");
  const [permission, setPermission] = useState(() => localStorage.getItem("agit.permission") ?? "default");
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState("");

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
    if (peerState !== "online") return;
    void loadModels(activeRuntime, cwd).then((choices) => {
      if (!cancelled) setModels(choices);
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
      await startSession({ projectId: project, runtime: activeRuntime, model: model || null, permissionMode: activePermission, prompt });
    } catch (error) {
      toast(`新建会话失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const selected = projects.find((item) => item.project_id === project);
  return (
    <div className="new-session">
      <div className="new-hero">
        <h2>要在 {selected ? projectName(selected) : "哪个项目"} 里做什么？</h2>
        {selected && <p className="muted">{displayPath(selected.local_path)}</p>}
      </div>
      <div className="composer-wrap">
        <Composer placeholder="描述你要做的事…" disabled={peerState !== "online" || !project} onSubmit={submit}>
          {projects.length > 1 && (
            <Picker title="项目" value={project} options={projects.map((item) => ({ value: item.project_id, label: projectName(item) }))} onChange={setProject} />
          )}
          {runtimes.length > 0 && (
            <Picker
              title="Agent"
              value={activeRuntime}
              options={runtimes.map((value) => ({ value, label: runtimeName[value] ?? value }))}
              onChange={setRuntime}
            />
          )}
          {models.length > 0 && (
            <Picker
              title="模型"
              value={model}
              options={[{ value: "", label: "默认模型" }, ...models.map((choice) => ({ value: choice.id, label: choice.name ?? choice.id }))]}
              onChange={setModel}
            />
          )}
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
