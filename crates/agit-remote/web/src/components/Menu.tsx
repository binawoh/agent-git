import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
}

export type MenuItem =
  | { heading: string }
  | { separator: true }
  | { label: string; description?: string; icon?: ReactNode; onSelect: () => void; checked?: boolean; danger?: boolean; disabled?: boolean };

type Placement = "top" | "bottom";
type Align = "left" | "right";

const ITEMS = "[role^=menuitem]:not(:disabled)";

/** Open state of a popover anchored in `anchor`, whose first button is the trigger. The popover
 *  closes when the pointer goes down outside the anchor or Escape is pressed. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) anchor.current?.querySelector<HTMLElement>(":scope > button")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (anchor.current && !anchor.current.contains(event.target as Node)) close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return { open, toggle: () => setOpen((current) => !current), close, anchor };
}

const EDGE = 8;

/** The floating list. It opens on the preferred side and flips when that side lacks room, and
 *  slides sideways to stay on screen; focus moves into it so arrow keys, Home/End and the
 *  digits 1 to 9 pick items. */
function Popover(props: { placement: Placement; align: Align; title?: string; className?: string; onClose: (refocus: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(props.placement);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const anchor = menu.parentElement?.getBoundingClientRect();
    if (anchor) {
      const above = anchor.top - EDGE;
      const below = window.innerHeight - anchor.bottom - EDGE;
      if (props.placement === "bottom" && rect.height > below && above > below) setPlacement("top");
      if (props.placement === "top" && rect.height > above && below > above) setPlacement("bottom");
    }
    if (rect.left < EDGE) setShift(EDGE - rect.left);
    else if (rect.right > window.innerWidth - EDGE) setShift(window.innerWidth - EDGE - rect.right);
    const first = menu.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? menu.querySelector<HTMLElement>(ITEMS);
    first?.focus({ preventScroll: true });
  }, [props.placement]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(ITEMS)];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus({ preventScroll: true });
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") props.onClose(false);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose(true);
    } else if (/^[1-9]$/.test(event.key) && items[Number(event.key) - 1]) {
      event.preventDefault();
      items[Number(event.key) - 1].click();
    }
  }

  return (
    <div
      ref={ref}
      className={`menu-popover ${placement} ${props.align} ${props.className ?? ""}`}
      style={shift ? { translate: `${shift}px 0` } : undefined}
      role="menu"
      onKeyDown={keyDown}
    >
      {props.title && <div className="menu-heading">{props.title}</div>}
      {props.children}
    </div>
  );
}

function OptionContent(props: { icon?: ReactNode; label: ReactNode; description?: string; check?: boolean }) {
  return (
    <>
      {props.icon && <span className="menu-option-icon">{props.icon}</span>}
      <span className="menu-option-text">
        <span className="menu-option-label">{props.label}</span>
        {props.description && <span className="menu-option-description">{props.description}</span>}
      </span>
      {props.check && <Check size={15} className="menu-check" />}
    </>
  );
}

/** A button naming the current choice that opens the list of choices, as the model, effort and
 *  mode buttons of a composer. `actions` follow the choices below a separator. */
export function MenuPicker(props: {
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  title?: string;
  icon?: ReactNode;
  /** What the button shows when it should differ from the chosen option's label. */
  display?: ReactNode;
  disabled?: boolean;
  placement?: Placement;
  align?: Align;
  className?: string;
  note?: ReactNode;
  actions?: { label: string; icon?: ReactNode; onSelect: () => void }[];
}) {
  const { open, toggle, close, anchor } = usePopover();
  const current = props.options.find((option) => option.value === props.value);
  const label = props.display ?? current?.label ?? props.value;
  return (
    <div className={`menu-anchor ${props.className ?? ""}`} ref={anchor}>
      <button
        type="button"
        className={`menu-button ${open ? "open" : ""}`}
        title={props.title}
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {props.icon}
        <span className="menu-button-label">{label}</span>
        {!props.disabled && <ChevronDown size={13} className="menu-chevron" />}
      </button>
      {open && (
        <Popover placement={props.placement ?? "top"} align={props.align ?? "left"} title={props.title} onClose={close}>
          {props.options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === props.value}
              className="menu-option"
              onClick={() => {
                close(true);
                if (option.value !== props.value) props.onChange(option.value);
              }}
            >
              <OptionContent icon={option.icon} label={option.label} description={option.description} check />
            </button>
          ))}
          {props.note && <div className="menu-note">{props.note}</div>}
          {props.actions && props.actions.length > 0 && <div className="menu-separator" />}
          {props.actions?.map((action) => (
            <button
              type="button"
              key={action.label}
              role="menuitem"
              className="menu-option"
              onClick={() => {
                close(true);
                action.onSelect();
              }}
            >
              <OptionContent icon={action.icon} label={action.label} />
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** A list of actions in a popover, opened by any trigger button. Items with `checked` behave
 *  as choices and show a check when set. */
export function ActionMenu(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  items: MenuItem[];
  title?: string;
  placement?: Placement;
  align?: Align;
  className?: string;
}) {
  const { open, toggle, close, anchor } = usePopover();
  return (
    <div className={`menu-anchor ${props.className ?? ""}`} ref={anchor}>
      {props.trigger(open, toggle)}
      {open && (
        <Popover placement={props.placement ?? "bottom"} align={props.align ?? "left"} title={props.title} onClose={close}>
          {props.items.map((item, index) => {
            if ("heading" in item)
              return (
                <div key={`heading:${item.heading}`} className="menu-heading">
                  {item.heading}
                </div>
              );
            if ("separator" in item) return <div key={`separator:${index}`} className="menu-separator" />;
            const choice = item.checked !== undefined;
            return (
              <button
                type="button"
                key={`${index}:${item.label}`}
                role={choice ? "menuitemradio" : "menuitem"}
                aria-checked={choice ? item.checked : undefined}
                disabled={item.disabled}
                className={`menu-option ${item.danger ? "danger" : ""}`}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                <OptionContent icon={item.icon} label={item.label} description={item.description} check={choice} />
              </button>
            );
          })}
        </Popover>
      )}
    </div>
  );
}
