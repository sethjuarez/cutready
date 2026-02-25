import { useTheme } from "./hooks/useTheme";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { AppLayout } from "./components/AppLayout";

function App() {
  const { theme, resolved, setTheme } = useTheme();
  useGlobalHotkeys();

  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text)]">
      <TitleBar />
      <AppLayout />
      <StatusBar theme={theme} resolved={resolved} onSetTheme={setTheme} />
    </div>
  );
}

export default App;

