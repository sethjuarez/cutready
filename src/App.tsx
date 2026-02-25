import { useTheme } from "./hooks/useTheme";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { StatusBar } from "./components/StatusBar";
import { AppLayout } from "./components/AppLayout";

function App() {
  const { theme, resolved, setTheme } = useTheme();
  useGlobalHotkeys();

  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text)]">
      <AppLayout />
      <StatusBar theme={theme} resolved={resolved} onSetTheme={setTheme} />
    </div>
  );
}

export default App;

