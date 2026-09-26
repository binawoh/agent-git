import { Brain, ClipboardList, FilePen, Hand, ShieldCheck, ShieldOff, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { EffortChoice, ModelChoice } from "../types";
import { effortHint, effortName, permissionHint, permissionName } from "./labels";
import { MenuPicker, type MenuOption } from "./Menu";

export function modeIcon(mode: string, size = 15): ReactNode {
  switch (mode) {
    case "default":
      return <Hand size={size} />;
    case "accept_edits":
      return <FilePen size={size} />;
    case "auto":
      return <Zap size={size} />;
    case "plan":
      return <ClipboardList size={size} />;
    case "bypass":
      return <ShieldOff size={size} />;
    default:
      return <ShieldCheck size={size} />;
  }
}

/** The permission mode button. With `keep`, the empty value leaves a stored session's own mode. */
export function ModePicker(props: { value: string; modes: string[]; onChange: (value: string) => void; disabled?: boolean; keep?: boolean }) {
  const options: MenuOption[] = props.modes.map((mode) => ({
    value: mode,
    label: permissionName[mode] ?? mode,
    description: permissionHint[mode],
    icon: modeIcon(mode),
  }));
  if (props.keep) options.unshift({ value: "", label: "沿用原权限", description: "保持这个会话原来的权限模式", icon: modeIcon("") });
  return (
    <MenuPicker
      className={`mode-picker ${props.value === "bypass" ? "danger" : ""}`}
      title="权限模式"
      icon={modeIcon(props.value)}
      value={props.value}
      display={props.keep && !props.value ? "原权限" : undefined}
      options={options}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  );
}

export function modelOptions(models: ModelChoice[]): MenuOption[] {
  return models.map((choice) => ({
    value: choice.id,
    label: choice.name ?? choice.id,
    description: choice.description || (choice.name && choice.name !== choice.id ? choice.id : undefined),
  }));
}

export function effortOptions(efforts: EffortChoice[] | undefined): MenuOption[] {
  return (efforts ?? []).map((choice) => ({
    value: choice.id,
    label: effortName[choice.id] ?? choice.name ?? choice.id,
    description: choice.description || effortHint[choice.id],
  }));
}

export function ModelPicker(props: {
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  display?: string;
  disabled?: boolean;
  loading?: boolean;
  note?: ReactNode;
}) {
  return (
    <MenuPicker
      className="model-picker"
      title={props.loading ? "模型（正在读取列表…）" : "模型"}
      align="right"
      value={props.value}
      display={props.display}
      options={props.options}
      disabled={props.disabled}
      note={props.note}
      onChange={props.onChange}
    />
  );
}

export function EffortPicker(props: { value: string; options: MenuOption[]; onChange: (value: string) => void; display?: string; disabled?: boolean; note?: ReactNode }) {
  return (
    <MenuPicker
      className="effort-picker"
      title="思考强度"
      icon={<Brain size={15} />}
      align="right"
      value={props.value}
      display={props.display}
      options={props.options}
      disabled={props.disabled}
      note={props.note}
      onChange={props.onChange}
    />
  );
}
