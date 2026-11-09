/**
 * ffprobe/ffmpeg I/O used by the calibration spike. Thin wrappers only; the
 * analysis maths lives in timing.js.
 */

import { spawnSync } from "child_process";

function run(cmd, args, { encoding = "utf8", maxBuffer = 1 << 30 } = {}) {
  const r = spawnSync(cmd, args, { encoding, maxBuffer, windowsHide: true });
  if (r.status !== 0) {
    const err = Buffer.isBuffer(r.stderr) ? r.stderr.toString() : r.stderr;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${err?.slice(-2000)}`);
  }
  return r.stdout;
}

export function probeStream(file, stream = "v:0") {
  const out = run("ffprobe", [
    "-v", "error", "-select_streams", stream,
    "-show_entries", "stream=codec_name,time_base,r_frame_rate,avg_frame_rate,width,height,start_time,duration,sample_rate,nb_frames:format=duration,start_time",
    "-of", "json", file,
  ]);
  const j = JSON.parse(out);
  return { ...(j.streams?.[0] || {}), format: j.format };
}

/** Frame PTS in ms (best-effort timestamp) for the first video stream. */
export function framePtsMs(file) {
  const out = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", file,
  ]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((s) => Number(s) * 1000);
}

/**
 * Decode every frame (no frame-rate conversion) to tiny rgb24 thumbnails.
 * Returns an array of Buffers of width*height*3 bytes.
 */
export function decodeThumbs(file, width = 64, height = 36) {
  const buf = run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-vf", `scale=${width}:${height}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer" },
  );
  const size = width * height * 3;
  const frames = [];
  for (let o = 0; o + size <= buf.length; o += size) frames.push(buf.subarray(o, o + size));
  return frames;
}

export function ffmpeg(args) {
  return run("ffmpeg", ["-v", "error", "-y", ...args]);
}

export function toWav(input, output) {
  ffmpeg(["-i", input, "-c:a", "pcm_s16le", output]);
}

export function audioStart(file) {
  const out = run("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,start_time,duration:stream_side_data", "-of", "json", file,
  ]);
  return JSON.parse(out).streams?.[0] || {};
}
