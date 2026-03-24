import { useEffect, useState } from "react";

export function StatusBar() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(import.meta.env.DEV ? `${v}-dev` : v))
      .catch(() => setVersion("dev"));
  }, []);

  return (
    <div
      className="no-select fixed bottom-0 left-0 right-0 z-50 flex items-center bg-[var(--color-surface)] border-t border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)]"
      style={{ height: "var(--statusbar-height)" }}
    >
      {version && <span className="opacity-60">v{version}</span>}
    </div>
  );
}

