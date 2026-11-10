#!/usr/bin/env node
/**
 * Live video recorder calibration spike.
 *
 *   node spike/calibrate.mjs [--out <dir>] [--repeat 3] [--headful] [--skip-public] [--skip-tts]
 *
 * Env (TTS, optional):
 *   SPEECH_ENDPOINT      Azure AI / Foundry resource endpoint (custom domain)
 *   SPEECH_TOKEN         Entra token for https://cognitiveservices.azure.com;
 *                        when unset, `az account get-access-token` is used
 *                        (add SPEECH_AZ_SUBSCRIPTION to pick the tenant).
 *   SPEECH_VOICE         default en-US-AvaMultilingualNeural
 *
 * Writes <out>/results.json and prints a summary. Requires ffmpeg/ffprobe.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { runTake } from "../lib/take.js";
import { synthesize } from "../lib/tts.js";
import { probeStream, framePtsMs, decodeThumbs, ffmpeg, toWav, audioStart } from "../lib/media.js";
import {
  cadence, stats, linearFit, isMarkerColor, meanRgb, markerRuns, firstChangedFrame,
  frameAtOrBefore, meanAbsDiff, planRetime, retimeFilter, wavSamples, firstOnset,
  energyOnsets, tickGranularity,
} from "../lib/timing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = path.resolve(opt("--out", path.join(here, "..", "..", ".spike-out", "calibration")));
const REPEAT = Number(opt("--repeat", 3));
const THUMB_W = 160;
const THUMB_H = 90;
const DIFF_THRESHOLD = 0.25;
const FPS = 25;
const NARRATION =
  "First we open the panel. Then we type a greeting, and finally we scroll down to the footer.";
const CUES = { open: "open", type: "type", scroll: "scroll" };

fs.mkdirSync(OUT, { recursive: true });
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);
const roundStats = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round(v)]));

// ── Scenarios ────────────────────────────────────────────────────────────────

function fixtureScenario() {
  return {
    name: "fixture",
    url: pathToFileURL(path.join(here, "fixture.html")).href,
    expect: { selector: "#open" },
    steps: [
      { type: "click", label: "open", selectors: ["[data-testid=missing-on-purpose]", "#open"], expect: { selector: "#panel.open" } },
      { type: "type", label: "type", selectors: ["#name"], text: "hello", expect: { selector: "#name", value: "hello" } },
      { type: "wait", label: "idle", ms: 1500 },
      { type: "scroll", label: "scroll", dy: 900, expect: { scrollYAtLeast: 800 } },
    ],
  };
}

function publicScenario() {
  return {
    name: "playwright.dev",
    url: "https://playwright.dev/",
    expect: { selector: "a:has-text('Get started')" },
    steps: [
      { type: "click", label: "get-started", selectors: ["a.getStarted_Sjon", "a:has-text('Get started')"], expect: { url: "/docs/intro" } },
      { type: "scroll", label: "scroll", dy: 800, expect: { scrollYAtLeast: 400 } },
      { type: "click", label: "search", selectors: ["button.DocSearch", "button[aria-label^='Search']"], expect: { selector: ".DocSearch-Modal" } },
      { type: "type", label: "query", selectors: [".DocSearch-Input", "input[type=search]"], text: "locator", expect: { selector: ".DocSearch-Input", value: "locator" } },
    ],
  };
}

// ── Video analysis ───────────────────────────────────────────────────────────

function analyzeVideo(videoPath) {
  const stream = probeStream(videoPath);
  const pts = framePtsMs(videoPath);
  const frames = decodeThumbs(videoPath, THUMB_W, THUMB_H);
  if (frames.length !== pts.length) {
    throw new Error(`decoded ${frames.length} frames but ffprobe reported ${pts.length}`);
  }
  const flags = frames.map((f) => isMarkerColor(meanRgb(f)));
  let duplicates = 0;
  for (let i = 1; i < frames.length; i++) if (meanAbsDiff(frames[i], frames[i - 1]) === 0) duplicates++;
  return { stream, pts, frames, flags, runs: markerRuns(flags, pts), cadence: cadence(pts), duplicates };
}

/** Pair logged markers with detected runs and compute host→PTS offsets. */
function calibrate(log, video) {
  const matched = log.markers.length === video.runs.length;
  const pairs = [];
  const n = Math.min(log.markers.length, video.runs.length);
  for (let i = 0; i < n; i++) {
    const m = log.markers[i];
    const r = video.runs[i];
    pairs.push({
      label: m.label,
      onPts: r.onPts,
      offPts: r.offPts,
      on_requested_ms: m.on_requested_ms,
      on_ack_ms: m.on_ack_ms,
      off_ack_ms: m.off_ack_ms,
      onOffsetAck: r.onPts - m.on_ack_ms,
      onOffsetReq: r.onPts - m.on_requested_ms,
      offOffsetAck: r.offPts != null ? r.offPts - m.off_ack_ms : null,
      runFrames: r.frames,
      heldMs: m.off_ack_ms - m.on_ack_ms,
    });
  }
  const onAck = pairs.map((p) => p.onOffsetAck);
  // Exclude the first marker: it is painted before the screencast's first
  // frame and gets clamped to PTS 0, which would bias the offset and slope.
  const steady = pairs.slice(1);
  const fitPairs = steady.length >= 2 ? steady : pairs;
  const fit = linearFit(fitPairs.map((p) => p.on_ack_ms), fitPairs.map((p) => p.onPts));
  return {
    matched,
    loggedMarkers: log.markers.length,
    detectedRuns: video.runs.length,
    pairs,
    onOffsetAck: roundStats(stats(onAck)),
    onOffsetAckSteady: roundStats(stats(steady.map((p) => p.onOffsetAck))),
    onOffsetReqSteady: roundStats(stats(steady.map((p) => p.onOffsetReq))),
    offOffsetAckSteady: roundStats(stats(steady.filter((p) => p.offOffsetAck != null).map((p) => p.offOffsetAck))),
    fit: { interceptMs: round(fit.a), slope: round(fit.b, 6), residual: roundStats(stats(fit.residuals)) },
    offsetMs: stats(steady.map((p) => p.onOffsetAck)).mean,
  };
}

/** Find, per step, the first visibly changed frame after dispatch. */
function latencies(log, video, cal) {
  const offset = cal.offsetMs;
  const out = [];
  for (const step of log.steps) {
    if (step.status !== "ok" || step.type === "wait" || step.dispatched_ms == null) continue;
    const dispatchPts = step.dispatched_ms + offset;
    let ref = frameAtOrBefore(video.pts, dispatchPts);
    while (ref > 0 && video.flags[ref]) ref--;
    const nextMarker = video.runs.find((r) => r.onPts > dispatchPts);
    const until = nextMarker ? nextMarker.startIndex : video.frames.length;
    const idx = firstChangedFrame(video.frames, video.flags, ref, ref + 1, DIFF_THRESHOLD, until);
    const visiblePts = idx >= 0 ? video.pts[idx] : null;
    const visibleHost = visiblePts != null ? visiblePts - offset : null;
    out.push({
      label: step.label,
      type: step.type,
      selector: step.selector,
      selector_attempts: step.selector_attempts,
      dispatched_ms: round(step.dispatched_ms),
      input_effect_ms: round(step.input_effect_ms),
      postcondition_ms: round(step.postcondition_ms),
      dispatchPts: round(dispatchPts),
      visiblePts,
      visibleFrame: idx,
      dispatchToInputEffect: round(step.input_effect_ms - step.dispatched_ms),
      dispatchToPostcondition: round(step.postcondition_ms - step.dispatched_ms),
      dispatchToVisible: visibleHost != null ? round(visibleHost - step.dispatched_ms) : null,
      inputEffectToVisible: visibleHost != null ? round(visibleHost - step.input_effect_ms) : null,
      postconditionToVisible: visibleHost != null ? round(visibleHost - step.postcondition_ms) : null,
    });
  }
  return out;
}

async function recordAndAnalyze(scenario, tag, { headless = true } = {}) {
  const outDir = path.join(OUT, tag);
  fs.rmSync(outDir, { recursive: true, force: true });
  const take = await runTake({
    url: scenario.url,
    expect: scenario.expect,
    steps: scenario.steps,
    viewport: { width: 1280, height: 720 },
    outDir,
    headless,
  });
  const video = analyzeVideo(take.videoPath);
  const cal = calibrate(take.log, video);
  const lat = latencies(take.log, video, cal);
  const lastPts = video.pts[video.pts.length - 1];
  return {
    tag,
    scenario: scenario.name,
    headless,
    videoPath: take.videoPath,
    browserVersion: take.log.browserVersion,
    playwright: take.log.playwright,
    stepStatus: take.log.steps.map((s) => ({ label: s.label, status: s.status, error: s.error })),
    stream: video.stream,
    cadence: { ...video.cadence, deltaStats: roundStats(video.cadence.deltaStats) },
    duplicateFrames: video.duplicates,
    videoEndPts: lastPts,
    epoch: take.log.epoch,
    calibration: cal,
    latencies: lat,
    _video: video,
    _log: take.log,
  };
}

// ── TTS analysis ─────────────────────────────────────────────────────────────

function speechToken() {
  if (process.env.SPEECH_TOKEN) return process.env.SPEECH_TOKEN;
  const sub = process.env.SPEECH_AZ_SUBSCRIPTION ? ` --subscription "${process.env.SPEECH_AZ_SUBSCRIPTION}"` : "";
  const out = execSync(`az account get-access-token --resource https://cognitiveservices.azure.com${sub} -o json`, {
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(out).accessToken;
}

/** Cross-correlation lag (samples) of b relative to a over the first `n` samples. */
function xcorrLag(a, b, maxLag, n) {
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length || i >= a.length) continue;
      s += a[i] * b[j];
    }
    if (s > best.score) best = { lag, score: s };
  }
  return best.lag;
}

async function ttsAnalysis() {
  const endpoint = process.env.SPEECH_ENDPOINT;
  if (!endpoint) return { skipped: "SPEECH_ENDPOINT not set" };
  const auth = { type: "bearer", token: speechToken() };
  const voice = process.env.SPEECH_VOICE || "en-US-AvaMultilingualNeural";
  const dir = path.join(OUT, "tts");
  fs.mkdirSync(dir, { recursive: true });

  const wav = await synthesize({ text: NARRATION, voice, endpoint, auth, format: "wav", outPath: path.join(dir, "narration.wav") });
  const mp3 = await synthesize({ text: NARRATION, voice, endpoint, auth, format: "mp3", outPath: path.join(dir, "narration.mp3") });
  const voiceProbe = {};
  for (const v of ["en-US-Harper:MAI-Voice-2", "en-US-AndrewMultilingualNeural", "en-US-JennyNeural"]) {
    try {
      const r = await synthesize({ text: NARRATION, voice: v, endpoint, auth, format: "wav", outPath: path.join(dir, `probe-${v.replace(/[^a-z0-9]+/gi, "_")}.wav`) });
      voiceProbe[v] = { wordBoundaries: r.words.length, audioDurationMs: r.audioDurationMs };
    } catch (e) {
      voiceProbe[v] = { error: e.message.slice(0, 200) };
    }
  }

  const pcm = wavSamples(fs.readFileSync(wav.audioPath));
  const sr = pcm.sampleRate;
  const words = wav.words.filter((w) => w.boundaryType === "WordBoundary");
  const sampleDurationMs = (pcm.samples.length / sr) * 1000;
  const onsetSample = firstOnset(pcm.samples);
  const onsets = energyOnsets(pcm.samples, sr);
  // Match each energy onset (after a pause) to the nearest word start.
  const onsetMatches = onsets.map((t) => {
    const nearest = words.reduce((b, w) => (Math.abs(w.audioOffsetMs - t) < Math.abs(b.audioOffsetMs - t) ? w : b));
    return { onsetMs: round(t), word: nearest.text, wordMs: nearest.audioOffsetMs, deltaMs: round(t - nearest.audioOffsetMs) };
  });
  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    gaps.push(words[i].audioOffsetMs - (words[i - 1].audioOffsetMs + words[i - 1].durationMs));
  }

  // MP3: probe declared start/padding and measure the decoded lag vs PCM.
  const mp3Wav = path.join(dir, "narration.mp3.wav");
  toWav(mp3.audioPath, mp3Wav);
  const mp3Pcm = wavSamples(fs.readFileSync(mp3Wav));
  const lagSamples = xcorrLag(pcm.samples, mp3Pcm.samples, Math.round(sr * 0.1), Math.min(pcm.samples.length, sr * 2));
  const mp3Probe = audioStart(mp3.audioPath);

  return {
    voice,
    endpointHost: new URL(endpoint).host.replace(/^[^.]+/, "<resource>"),
    format: "riff-24khz-16bit-mono-pcm",
    sampleRate: sr,
    sdkAudioDurationMs: wav.audioDurationMs,
    sampleDurationMs: round(sampleDurationMs),
    wordCount: words.length,
    allBoundaryTypes: [...new Set(wav.words.map((w) => w.boundaryType))],
    tickGranularity: tickGranularity(wav.words.flatMap((w) => [w.audioOffsetTicks, w.durationTicks])),
    tickGranularityMs: tickGranularity(wav.words.flatMap((w) => [w.audioOffsetTicks, w.durationTicks])) / 10_000,
    firstWordMs: words[0]?.audioOffsetMs,
    firstAudibleSampleMs: round((onsetSample / sr) * 1000),
    leadingSilenceMs: round((onsetSample / sr) * 1000),
    firstWordVsAudibleMs: round((onsetSample / sr) * 1000 - words[0]?.audioOffsetMs),
    onsetMatches,
    onsetDeltaStats: roundStats(stats(onsetMatches.map((m) => m.deltaMs))),
    interWordGapStats: roundStats(stats(gaps)),
    lastWordEndMs: round(words.at(-1).audioOffsetMs + words.at(-1).durationMs),
    trailingSilenceMs: round(sampleDurationMs - (words.at(-1).audioOffsetMs + words.at(-1).durationMs)),
    words: words.map((w) => ({ text: w.text, plainOffset: w.plainOffset, ms: w.audioOffsetMs, durMs: w.durationMs })),
    mp3: {
      sdkAudioDurationMs: mp3.audioDurationMs,
      ffprobeStartTime: mp3Probe.start_time,
      ffprobeDuration: mp3Probe.duration,
      decodedSamples: mp3Pcm.samples.length,
      pcmSamples: pcm.samples.length,
      lagVsPcmSamples: lagSamples,
      lagVsPcmMs: round((lagSamples / sr) * 1000),
      sameWordTimings: JSON.stringify(mp3.words.map((w) => w.audioOffsetTicks)) === JSON.stringify(wav.words.map((w) => w.audioOffsetTicks)),
    },
    voiceProbe,
    audioPath: wav.audioPath,
  };
}

// ── Retime ───────────────────────────────────────────────────────────────────

function measureLanding(videoPath, targets) {
  const v = analyzeVideo(videoPath);
  return targets.map((t) => {
    let ref = frameAtOrBefore(v.pts, t.predictedMs - 80);
    while (ref > 0 && v.flags[ref]) ref--;
    const until = frameAtOrBefore(v.pts, t.predictedMs + 1500);
    const idx = firstChangedFrame(v.frames, v.flags, ref, ref + 1, DIFF_THRESHOLD, until + 1);
    const landed = idx >= 0 ? v.pts[idx] : null;
    return {
      label: t.label,
      wordMs: t.wordMs,
      targetMs: round(t.targetExactMs),
      plannedMs: round(t.predictedMs),
      landedMs: landed,
      errorVsWordMs: landed != null ? round(landed - t.targetExactMs) : null,
      errorVsPlanMs: landed != null ? round(landed - t.predictedMs) : null,
    };
  });
}

function retime(take, tts, mode) {
  const cal = take.calibration;
  const words = tts?.words;
  const wordMs = (cue) => {
    if (!words) return { open: 600, type: 2100, scroll: 4300 }[cue];
    const w = words.find((x) => x.text.toLowerCase() === cue);
    return w.ms;
  };
  const byLabel = Object.fromEntries(take.latencies.map((l) => [l.label, l]));
  const anchorsRaw = Object.entries(CUES).map(([label, cue]) => {
    const l = byLabel[label];
    const srcMs = mode === "visible" ? l.visiblePts : l.dispatchPts;
    return { label, cue, srcMs, wordMs: wordMs(cue) };
  });
  // Narration starts so the first cue needs a visible freeze (proves the
  // freeze path); later cues then exercise freeze or drop as needed.
  const leadMs = Math.ceil((anchorsRaw[0].srcMs + 1000 - anchorsRaw[0].wordMs) / 40) * 40;
  const anchors = anchorsRaw.map((a) => ({ label: a.label, srcMs: a.srcMs, targetMs: leadMs + a.wordMs }));
  const plan = planRetime({ anchors, fps: FPS, sourceDurationMs: take.videoEndPts + 40, dropMarginMs: 600 });
  const filter = retimeFilter(plan.segments, FPS);
  const outPath = path.join(OUT, `retime-${mode}.mp4`);
  const inputs = ["-i", take.videoPath];
  let audioMap = [];
  let full = filter;
  if (tts?.audioPath) {
    inputs.push("-i", tts.audioPath);
    full += `;[1:a]adelay=${leadMs}:all=1[aout]`;
    audioMap = ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"];
  }
  ffmpeg([...inputs, "-filter_complex", full, "-map", "[vout]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), ...audioMap, outPath]);
  const landings = measureLanding(
    outPath,
    plan.landings.map((l, i) => ({ ...l, wordMs: anchorsRaw[i].wordMs, targetExactMs: leadMs + anchorsRaw[i].wordMs })),
  );
  let audio = null;
  if (tts?.audioPath) {
    const outWav = path.join(OUT, `retime-${mode}.wav`);
    toWav(outPath, outWav);
    const pcm = wavSamples(fs.readFileSync(outWav));
    const firstMs = (firstOnset(pcm.samples) / pcm.sampleRate) * 1000;
    audio = {
      leadMs,
      expectedFirstAudibleMs: round(leadMs + tts.firstAudibleSampleMs),
      measuredFirstAudibleMs: round(firstMs),
      errorMs: round(firstMs - (leadMs + tts.firstAudibleSampleMs)),
      container: audioStart(outPath),
    };
  }
  const outStream = probeStream(outPath);
  return {
    mode,
    leadMs,
    segments: plan.segments.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "number" ? round(v) : v]))),
    plannedOutputMs: round(plan.outputDurationMs),
    outputStream: { codec: outStream.codec_name, r_frame_rate: outStream.r_frame_rate, duration: outStream.duration ?? outStream.format?.duration },
    landings,
    audio,
    filter,
    outPath,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function summarizeTake(t) {
  const c = t.calibration;
  console.log(`\n[${t.tag}] ${t.scenario} headless=${t.headless} ${t.stream.codec_name} tb=${t.stream.time_base} r=${t.stream.r_frame_rate} ${t.cadence.mode} frames=${t.cadence.frames} dupes=${t.duplicateFrames}`);
  console.log(`  markers logged=${c.loggedMarkers} detected=${c.detectedRuns} matched=${c.matched}`);
  console.log(`  onset offset (ack) steady: mean=${c.onOffsetAckSteady.mean} std=${c.onOffsetAckSteady.std} min=${c.onOffsetAckSteady.min} max=${c.onOffsetAckSteady.max}; first=${round(c.pairs[0]?.onOffsetAck)}`);
  console.log(`  fit slope=${c.fit.slope} residual std=${c.fit.residual.std}`);
  for (const l of t.latencies) {
    console.log(`  ${l.label.padEnd(12)} d->in=${l.dispatchToInputEffect} d->post=${l.dispatchToPostcondition} d->vis=${l.dispatchToVisible} in->vis=${l.inputEffectToVisible} post->vis=${l.postconditionToVisible}`);
  }
}

const results = { generatedAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version, takes: [] };

if (!flag("--skip-tts")) {
  try {
    results.tts = await ttsAnalysis();
    console.log("TTS:", JSON.stringify({ ...results.tts, words: undefined, onsetMatches: undefined }, null, 1));
  } catch (e) {
    results.tts = { error: e.message };
    console.log("TTS failed:", e.message);
  }
}

const takes = [];
for (let i = 0; i < REPEAT; i++) takes.push(await recordAndAnalyze(fixtureScenario(), `fixture-headless-${i + 1}`));
if (flag("--headful")) takes.push(await recordAndAnalyze(fixtureScenario(), "fixture-headful", { headless: false }));
if (!flag("--skip-public")) {
  try {
    takes.push(await recordAndAnalyze(publicScenario(), "public-headless"));
  } catch (e) {
    results.publicError = e.message;
  }
}
takes.forEach(summarizeTake);

const base = takes[0];
const tts = results.tts && !results.tts.error && !results.tts.skipped ? results.tts : null;
results.retime = ["dispatch", "visible"].map((mode) => retime(base, tts, mode));
for (const r of results.retime) {
  console.log(`\nretime(${r.mode}) lead=${r.leadMs}`);
  for (const l of r.landings) console.log(`  ${l.label.padEnd(8)} target=${l.targetMs} planned=${l.plannedMs} landed=${l.landedMs} err(word)=${l.errorVsWordMs} err(plan)=${l.errorVsPlanMs}`);
  if (r.audio) console.log(`  audio first audible expected=${r.audio.expectedFirstAudibleMs} measured=${r.audio.measuredFirstAudibleMs} err=${r.audio.errorMs}`);
}

results.takes = takes.map(({ _video, _log, ...rest }) => rest);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nresults: ${path.join(OUT, "results.json")}`);
