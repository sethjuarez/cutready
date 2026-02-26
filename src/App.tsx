import { useEffect } from "react";
import { useTheme } from "./hooks/useTheme";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { StatusBar } from "./components/StatusBar";
import { AppLayout } from "./components/AppLayout";
import { useAppStore } from "./stores/appStore";

function App() {
  const { theme, toggle } = useTheme();
  useGlobalHotkeys();

  // Auto-open last project on startup
  useEffect(() => {
    const lastProject = localStorage.getItem("cutready:lastProject");
    if (lastProject) {
      useAppStore.getState().openProject(lastProject);
    } else {
      useAppStore.getState().loadRecentProjects();
    }
  }, []);

  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text)]">
      <AppLayout />
      <StatusBar theme={theme} onToggleTheme={toggle} />
    </div>
  );
}

export default App;

