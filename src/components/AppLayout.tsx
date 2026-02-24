import { useAppStore } from "../stores/appStore";
import { HomePanel } from "./HomePanel";
import { ScriptEditorPanel } from "./ScriptEditorPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const view = useAppStore((s) => s.view);

  return (
    <div
      className="flex w-full"
      style={{
        paddingTop: "var(--titlebar-height)",
        paddingBottom: "var(--statusbar-height)",
        height: "100vh",
      }}
    >
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {view === "home" && <HomePanel />}
        {view === "editor" && <ScriptEditorPanel />}
        {view === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}

