import { Bot, Folder, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { displayPath, loadModels, projectName, startSession, toast, useStore } from "../store";
import type { ModelChoice } from "../types";
import { BrandMark } from "./Brand";
import { Composer } from "./Composer";
import { effortName, runtimeName } from "./labels";
import { MenuPicker } from "./Menu";
import { EffortPicker, effortOptions, ModelPicker, modelOptions, ModePicker } from "./Pickers";

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
      toast("先添加一个项目文件夹");
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
  const defaultEffort = chosen?.default_effort ? (effortName[chosen.default_effort] ?? chosen.default_effort) : null;
  const addFolder = () => useStore.setState({ folderDialog: true });

  return (
    <div className="new-session">
      <div className="new-center">
        <div className="new-hero">
          <BrandMark size={30} />
          <h1>{selected ? `要在 ${projectName(selected)} 里做什么？` : "先添加一个项目文件夹"}</h1>
        </div>
        <Composer
          placeholder="描述你要做的事…"
          disabled={peerState !== "online" || !project}
          onSubmit={submit}
          attach={selected ? { projectId: selected.project_id, root: selected.local_path } : null}
          left={<ModePicker value={activePermission} modes={modes} onChange={setPermission} />}
          right={
            <>
              <ModelPicker
                value={model}
                loading={loadingModels}
                display={model ? undefined : loadingModels ? "读取中…" : "默认模型"}
                options={[{ value: "", label: "默认模型", description: "使用这个 agent 在电脑上的默认设置" }, ...modelOptions(models)]}
                onChange={(value) => {
                  setModel(value);
                  setEffort("");
                }}
              />
              <EffortPicker
                value={effort}
                display={effort ? undefined : (defaultEffort ?? "默认")}
                disabled={efforts.length === 0}
                options={[{ value: "", label: defaultEffort ? `默认（${defaultEffort}）` : "默认强度", description: "使用模型的默认思考强度" }, ...effortOptions(efforts)]}
                onChange={setEffort}
              />
            </>
          }
          footer={
            <>
              <MenuPicker
                className="footer-picker"
                placement="bottom"
                title="项目文件夹"
                icon={<Folder size={14} />}
                value={project}
                display={projects.length ? undefined : "没有项目"}
                options={projects.map((item) => ({ value: item.project_id, label: projectName(item), description: displayPath(item.local_path), icon: <Folder size={15} /> }))}
                actions={[{ label: "添加文件夹…", icon: <FolderPlus size={15} />, onSelect: addFolder }]}
                onChange={setProject}
              />
              <MenuPicker
                className="footer-picker"
                placement="bottom"
                title="Agent"
                icon={<Bot size={14} />}
                value={activeRuntime}
                options={runtimes.map((value) => ({ value, label: runtimeName[value] ?? value }))}
                onChange={setRuntime}
              />
              {selected && (
                <span className="footer-path" title={displayPath(selected.local_path)}>
                  {displayPath(selected.local_path)}
                </span>
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
