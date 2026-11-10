/**
 * Pure timing helpers for the live video recorder spike.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested (see ../test/timing.test.mjs). Units:
 *   - host clock: process.hrtime.bigint() nanoseconds (bigint) or ms (number)
 *   - Azure Speech offsets: 100 ns "ticks"
 *   - video: seconds from ffprobe, converted to ms here
 */

export const TICKS_PER_MS = 10_000;

export function ticksToMs(ticks) {
  return Number(ticks) / TICKS_PER_MS;
}

/** Milliseconds between two hrtime bigint stamps (b - a), µs precision. */
export function nsDiffMs(a, b) {
  return Number(b - a) / 1e6;
}

export function stats(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN, p50: NaN, p95: NaN };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const sorted = [...values].sort((x, y) => x - y);
  const pct = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return {
    n,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    p50: pct(50),
    p95: pct(95),
  };
}

/** Ordinary least squares y = a + b x. Returns residuals too. */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n === 0) throw new Error("linearFit needs equal, non-empty arrays");
  if (n === 1) return { a: ys[0] - xs[0], b: 1, residuals: [0] };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx === 0 ? 1 : sxy / sxx;
  const a = my - b * mx;
  const residuals = xs.map((x, i) => ys[i] - (a + b * x));
  return { a, b, residuals };
}

/**
 * Classify a frame PTS sequence (ms) as CFR or VFR.
 * CFR when every delta is within `toleranceMs` of the median delta.
 */
export function cadence(ptsMs, toleranceMs = 0.5) {
  const deltas = [];
  for (let i = 1; i < ptsMs.length; i++) deltas.push(ptsMs[i] - ptsMs[i - 1]);
  const s = stats(deltas);
  const median = s.p50;
  const outliers = deltas.filter((d) => Math.abs(d - median) > toleranceMs).length;
  const histogram = {};
  for (const d of deltas) {
    const k = d.toFixed(1);
    histogram[k] = (histogram[k] || 0) + 1;
  }
  return {
    frames: ptsMs.length,
    deltaStats: s,
    medianDeltaMs: median,
    nominalFps: median > 0 ? 1000 / median : NaN,
    outliers,
    mode: outliers === 0 ? "CFR" : "VFR",
    histogram,
  };
}

/** True when an RGB mean looks like the calibration magenta (#ff00ff). */
export function isMarkerColor([r, g, b], { min = 200, max = 70 } = {}) {
  return r >= min && b >= min && g <= max;
}

/**
 * Collapse per-frame marker flags into runs. Each run reports the PTS of its
 * first and last marker frames plus the PTS of the neighbouring frames, so the
 * true onset lies in (prevPts, onPts] and the true offset in (lastPts, offPts].
 */
export function markerRuns(flags, ptsMs) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const end = i - 1;
      runs.push({
        startIndex: start,
        endIndex: end,
        onPts: ptsMs[start],
        prevPts: start > 0 ? ptsMs[start - 1] : null,
        lastPts: ptsMs[end],
        offPts: end + 1 < ptsMs.length ? ptsMs[end + 1] : null,
        frames: end - start + 1,
      });
      start = -1;
    }
  }
  return runs;
}

/** Mean absolute difference between two equally-sized byte buffers. */
export function meanAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error("buffer size mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Mean RGB of an rgb24 buffer. */
export function meanRgb(buf) {
  let r = 0;
  let g = 0;
  let b = 0;
  const px = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    r += buf[i];
    g += buf[i + 1];
    b += buf[i + 2];
  }
  return [r / px, g / px, b / px];
}

/**
 * First frame index in [fromIndex, untilIndex) whose diff against `refIndex`
 * exceeds `threshold`, skipping marker frames. Returns -1 when none.
 */
export function firstChangedFrame(frames, markerFlags, refIndex, fromIndex, threshold, untilIndex = frames.length) {
  for (let i = fromIndex; i < Math.min(untilIndex, frames.length); i++) {
    if (markerFlags[i]) continue;
    if (meanAbsDiff(frames[i], frames[refIndex]) > threshold) return i;
  }
  return -1;
}

/** Index of the last frame whose PTS is <= t (ms). -1 if none. */
export function frameAtOrBefore(ptsMs, t) {
  let lo = 0;
  let hi = ptsMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ptsMs[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function quantizeMs(ms, fps) {
  const frame = 1000 / fps;
  return Math.round(ms / frame) * frame;
}

/**
 * Plan a retime edit so each source anchor lands at its target output time.
 *
 * anchors: [{ srcMs, targetMs, label? }] sorted by srcMs; all times in ms.
 * Returns segments of { kind: "play", srcStart, srcEnd } or
 * { kind: "freeze", srcAt, durMs }, every boundary quantized to the output
 * frame grid, and the predicted landing time of each anchor.
 *
 * If an anchor is late (needs to land earlier), a source range of the required
 * length is dropped, ending `dropMarginMs` before the anchor so the cut sits
 * in idle footage rather than on the action itself.
 */
export function planRetime({ anchors, fps, sourceDurationMs, dropMarginMs = 200 }) {
  const frame = 1000 / fps;
  const q = (v) => Math.round(v / frame) * frame;
  const segments = [];
  const landings = [];
  let src = 0;
  let out = 0;
  for (const anchor of anchors) {
    const srcMs = q(anchor.srcMs);
    const targetMs = q(anchor.targetMs);
    if (srcMs < src) throw new Error(`anchor ${anchor.label ?? srcMs} is before the cursor`);
    const natural = out + (srcMs - src);
    const shift = targetMs - natural;
    if (shift >= 0) {
      if (srcMs > src) segments.push({ kind: "play", srcStart: src, srcEnd: srcMs });
      if (shift > 0) segments.push({ kind: "freeze", srcAt: Math.max(0, srcMs - frame), durMs: shift });
      out = natural + shift;
    } else {
      const drop = -shift;
      const dropEnd = srcMs - q(dropMarginMs);
      const dropStart = dropEnd - drop;
      if (dropStart < src) throw new Error(`cannot drop ${drop}ms before anchor ${anchor.label ?? srcMs}`);
      if (dropStart > src) segments.push({ kind: "play", srcStart: src, srcEnd: dropStart });
      segments.push({ kind: "play", srcStart: dropEnd, srcEnd: srcMs });
      out = natural - drop;
    }
    src = srcMs;
    landings.push({ label: anchor.label, srcMs, targetMs, predictedMs: out });
  }
  if (sourceDurationMs > src) segments.push({ kind: "play", srcStart: src, srcEnd: q(sourceDurationMs) });
  const outputDurationMs = segments.reduce(
    (s, seg) => s + (seg.kind === "play" ? seg.srcEnd - seg.srcStart : seg.durMs),
    0,
  );
  return { frameMs: frame, segments, landings, outputDurationMs };
}

/** Build an ffmpeg filter_complex for planRetime segments on input 0. */
export function retimeFilter(segments, fps) {
  const frame = 1 / fps;
  const parts = [];
  const labels = [];
  segments.forEach((seg, i) => {
    const label = `s${i}`;
    if (seg.kind === "play") {
      parts.push(
        `[0:v]trim=start=${(seg.srcStart / 1000).toFixed(6)}:end=${(seg.srcEnd / 1000).toFixed(6)},setpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      const at = seg.srcAt / 1000;
      parts.push(
        `[0:v]trim=start=${at.toFixed(6)}:end=${(at + frame).toFixed(6)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${(seg.durMs / 1000 - frame).toFixed(6)}[${label}]`,
      );
    }
    labels.push(`[${label}]`);
  });
  parts.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0,fps=${fps}[vout]`);
  return parts.join(";");
}

/** Parse a canonical PCM WAV buffer. Returns header fields + data offset. */
export function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("data chunk before fmt chunk");
      // Streaming encoders sometimes write 0 or 0xFFFFFFFF as the data size.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      return { ...fmt, dataOffset: body, dataBytes: size };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** Decode the first channel of a PCM16 WAV buffer. */
export function wavSamples(buf) {
  const info = parseWav(buf);
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) throw new Error("only PCM16 supported");
  const count = Math.floor(info.dataBytes / 2 / info.channels);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(info.dataOffset + i * 2 * info.channels);
  return { ...info, samples };
}

/** First sample index whose |amplitude| exceeds `threshold`; -1 if silent. */
export function firstOnset(samples, threshold = 328, from = 0) {
  for (let i = from; i < samples.length; i++) if (Math.abs(samples[i]) > threshold) return i;
  return -1;
}

/**
 * Short-window RMS envelope; returns onsets (window start ms) where energy
 * rises above `threshold` after at least `minGapMs` of quiet.
 */
export function energyOnsets(samples, sampleRate, { windowMs = 5, threshold = 300, minGapMs = 60 } = {}) {
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const onsets = [];
  let quietMs = minGapMs;
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / win);
    const t = (i / sampleRate) * 1000;
    if (rms > threshold) {
      if (quietMs >= minGapMs) onsets.push(t);
      quietMs = 0;
    } else {
      quietMs += windowMs;
    }
  }
  return onsets;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Largest tick count that divides every offset (the provider's time grid). */
export function tickGranularity(ticks) {
  return ticks.map((t) => Math.abs(Math.round(Number(t)))).reduce((g, t) => gcd(g, t), 0);
}
