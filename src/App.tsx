import { useTheme } from "./hooks/useTheme";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";

function App() {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <TitleBar />

      {/* Main content area — offset by title bar height */}
      <main
        className="flex flex-col items-center justify-center px-6"
        style={{
          paddingTop: "var(--titlebar-height)",
          paddingBottom: "var(--statusbar-height)",
          minHeight: "100vh",
        }}
      >
        <div className="flex flex-col items-center gap-8 max-w-lg text-center">
          {/* Logo */}
          <div className="flex items-center justify-center w-20 h-20 rounded-2xl bg-indigo-500/10 dark:bg-indigo-400/10">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              className="text-indigo-500 dark:text-indigo-400"
            >
              <path
                d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          {/* Title & description */}
          <div className="space-y-3">
            <h1 className="text-3xl font-bold tracking-tight">CutReady</h1>
            <p className="text-zinc-500 dark:text-zinc-400 text-base leading-relaxed">
              From script to screen in one click. Record demos, refine with AI,
              and export edit-ready packages for DaVinci Resolve.
            </p>
          </div>

          {/* Workflow steps */}
          <div className="grid grid-cols-2 gap-3 w-full">
            {[
              {
                icon: "⏺",
                title: "Record",
                desc: "Capture demo interactions",
              },
              {
                icon: "✨",
                title: "Refine",
                desc: "AI cleans & narrates",
              },
              {
                icon: "▶",
                title: "Produce",
                desc: "Automated replay + recording",
              },
              {
                icon: "📦",
                title: "Export",
                desc: "FCPXML for Resolve",
              },
            ].map((step) => (
              <div
                key={step.title}
                className="flex items-start gap-3 p-3 rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-left"
              >
                <span className="text-lg mt-0.5">{step.icon}</span>
                <div>
                  <div className="text-sm font-medium">{step.title}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {step.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <StatusBar theme={theme} resolved={resolved} onSetTheme={setTheme} />
    </div>
  );
}

export default App;

