import { useStore } from "../store";

export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
