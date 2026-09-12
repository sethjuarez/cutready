#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";

const reportPath = resolve(
  process.env.CUTREADY_AUDITAUR_VIDEO_EXPORT_REPORT ??
    "target/auditaur-video-export-drill-report.json",
);

const checks = [
  {
    id: "resolved-demo-schema",
    description: "Scenecast resolved demo wire shape and optional-field tolerance",
    args: ["test", "-p", "cutready", "resolved_demo", "--lib", "--quiet"],
    expectedMinTests: 9,
  },
  {
    id: "resolved-demo-loader",
    description: "Project-safe resolved demo loading and unsupported schema rejection",
    args: ["test", "-p", "cutready", "load_resolved_demo", "--lib", "--quiet"],
    expectedMinTests: 2,
  },
  {
    id: "resolved-demo-media",
    description: "Resolved-demo captures and frames render screenshot-less rows from bundle-relative media",
    args: ["test", "-p", "cutready", "resolved_demo_media", "--lib", "--quiet"],
    expectedMinTests: 4,
    forbiddenOutput: ["Skipping resolved demo media export test", "Skipping resolved demo media overlay test"],
  },
  {
    id: "resolved-demo-inspection",
    description: "Resolved-demo inspection reports row coverage, diagnostics, and blocking schema state",
    args: ["test", "-p", "cutready", "inspect_resolved_demo", "--lib", "--quiet"],
    expectedMinTests: 2,
  },
  {
    id: "scenecast-adapter",
    description: "CutReady sketch rows materialize into portable Scenecast bundles and CLI export calls",
    args: ["test", "-p", "cutready", "scenecast_adapter", "--lib", "--quiet"],
    expectedMinTests: 10,
  },
  {
    id: "frame-sequence-planner",
    description: "Elucim frame sequence terminal, dwell, exact-fit, and truncation rules",
    args: ["test", "-p", "cutready", "frame_sequence", "--lib", "--quiet"],
    expectedMinTests: 12,
  },
  {
    id: "frame-count-quantization",
    description: "Sub-100ms visual frames preserve total duration as integer frame counts",
    args: [
      "test",
      "-p",
      "cutready",
      "planned_frame_counts_preserve_total_for_sub_100ms_frames",
      "--lib",
      "--quiet",
    ],
    expectedMinTests: 1,
  },
  {
    id: "elucim-frame-renderer",
    description: "Elucim visuals rasterize to themed PNG frames and a terminal frame manifest",
    args: ["test", "-p", "cutready", "animation", "--lib", "--quiet"],
    expectedMinTests: 2,
  },
  {
    id: "rendered-video-duration",
    description: "FFmpeg export renders a visual-only frame manifest to expected duration",
    args: [
      "test",
      "-p",
      "cutready",
      "export_sketch_video_renders_visual_frame_manifest_duration",
      "--lib",
      "--quiet",
    ],
    expectedMinTests: 1,
    forbiddenOutput: ["Skipping visual frame manifest export test"],
  },
  {
    id: "automatic-elucim-visual-export",
    description: "FFmpeg export auto-generates frame manifests for attached Elucim visual rows",
    args: [
      "test",
      "-p",
      "cutready",
      "export_sketch_video_generates_elucim_frame_manifest_for_visual_row",
      "--lib",
      "--quiet",
    ],
    expectedMinTests: 1,
    forbiddenOutput: ["Skipping Elucim visual export test"],
  },
];

const report = {
  label: "video-export",
  startedAt: new Date().toISOString(),
  status: "running",
  checks: [],
};

mkdirSync(dirname(reportPath), { recursive: true });
writeReport();

const ffmpeg = spawnSync("ffmpeg", ["-version"], {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: false,
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
});
if (ffmpeg.error || ffmpeg.status !== 0) {
  report.status = "failed";
  report.checks.push({
    id: "ffmpeg-preflight",
    description: "FFmpeg must be available so duration assertions cannot pass by skipping",
    command: "ffmpeg -version",
    status: "failed",
    exitCode: ffmpeg.status,
    error: ffmpeg.error?.message,
    stdout: ffmpeg.stdout?.trim() ?? "",
    stderr: ffmpeg.stderr?.trim() ?? "",
  });
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.error(`FFmpeg is required for the video-export drill. Report: ${reportPath}`);
  process.exit(1);
}

for (const check of checks) {
  const started = Date.now();
  console.log(`\n== ${check.id} ==`);
  report.currentCheck = check.id;
  writeReport();
  const result = spawnSync("cargo", check.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - started;
  const passedTests = parsePassedTests(result.stdout ?? "");
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const forbiddenHit = check.forbiddenOutput?.find((needle) => combinedOutput.includes(needle));
  let status = result.status === 0 && !result.error ? "passed" : "failed";
  let error = result.error?.message;
  if (status === "passed" && passedTests < check.expectedMinTests) {
    status = "failed";
    error = `Expected at least ${check.expectedMinTests} tests, but cargo reported ${passedTests}.`;
  }
  if (status === "passed" && forbiddenHit) {
    status = "failed";
    error = `Matched forbidden output: ${forbiddenHit}`;
  }
  const entry = {
    id: check.id,
    description: check.description,
    command: ["cargo", ...check.args].join(" "),
    status,
    exitCode: result.status,
    passedTests,
    expectedMinTests: check.expectedMinTests,
    elapsedMs,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
  if (error) {
    entry.error = error;
  }
  report.checks.push(entry);
  delete report.currentCheck;
  writeReport();

  if (entry.stdout) process.stdout.write(`${entry.stdout}\n`);
  if (entry.stderr) process.stderr.write(`${entry.stderr}\n`);
  if (entry.status !== "passed") {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    writeReport();
    console.error(`\nvideo-export drill FAILED at ${check.id}. Report: ${reportPath}`);
    process.exit(1);
  }
}

report.status = "passed";
report.finishedAt = new Date().toISOString();
writeReport();
console.log(`\nvideo-export drill PASSED. Report: ${reportPath}`);

function writeReport() {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function parsePassedTests(stdout) {
  const matches = [...stdout.matchAll(/test result:\s+ok\.\s+(\d+)\s+passed/g)];
  if (matches.length === 0) return 0;
  return matches.reduce((sum, match) => sum + Number.parseInt(match[1], 10), 0);
}
