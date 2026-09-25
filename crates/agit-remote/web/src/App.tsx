import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { Toasts } from "./components/Toasts";
import { useStore } from "./store";

export function App() {
  const authChecked = useStore((state) => state.authChecked);
  const me = useStore((state) => state.me);
  return (
    <>
      {!authChecked ? <div className="splash" /> : me ? <Shell /> : <Login />}
      <Toasts />
    </>
  );
}
