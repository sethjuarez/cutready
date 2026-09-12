import { spawn } from "node:child_process";

const port = Number.parseInt(process.env.CUTREADY_AUDITAUR_DEV_PORT ?? "1432", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[auditaur-start-debug] Invalid CUTREADY_AUDITAUR_DEV_PORT: ${process.env.CUTREADY_AUDITAUR_DEV_PORT}`);
  process.exit(1);
}

const config = JSON.stringify({
  build: {
    beforeDevCommand: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    devUrl: `http://localhost:${port}`,
  },
});
const command = process.platform === "win32" ? "cmd" : "npx";
const args = process.platform === "win32"
  ? ["/c", "npx", "tauri", "dev", "--config", config]
  : ["tauri", "dev", "--config", config];
const child = spawn(command, args, {
  stdio: "inherit",
  shell: false,
});

const forward = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", forward);
process.on("SIGTERM", forward);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[auditaur-start-debug] Failed to start Auditaur debug app on port ${port}: ${error.message}`);
  process.exit(1);
});
