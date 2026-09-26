import { dismissToast, useStore } from "../store";

/** Toasts sit at the top so they never cover the composer; a tap dismisses one. */
export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <button key={toast.id} className={`toast ${toast.tone}`} onClick={() => dismissToast(toast.id)}>
          {toast.text}
        </button>
      ))}
    </div>
  );
}
