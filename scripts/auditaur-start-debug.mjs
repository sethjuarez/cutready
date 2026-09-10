import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(command, ["run", "debug"], {
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
  console.error(`[auditaur-start-debug] Failed to start npm run debug: ${error.message}`);
  process.exit(1);
});
