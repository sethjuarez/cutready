import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ticksToMs,
  stats,
  linearFit,
  cadence,
  isMarkerColor,
  markerRuns,
  firstChangedFrame,
  frameAtOrBefore,
  quantizeMs,
  planRetime,
  retimeFilter,
  parseWav,
  wavSamples,
  firstOnset,
  energyOnsets,
  tickGranularity,
} from "../lib/timing.js";
import { alignWordsToText, inferSpeechEndpoint, buildPlainSsml } from "../lib/tts.js";

test("ticksToMs converts 100ns ticks", () => {
  assert.equal(ticksToMs(1_500_000), 150);
  assert.equal(ticksToMs(125_000), 12.5);
});

test("stats summarizes values", () => {
  const s = stats([1, 2, 3, 4]);
  assert.equal(s.n, 4);
  assert.equal(s.mean, 2.5);
  assert.equal(s.min, 1);
  assert.equal(s.max, 4);
});

test("linearFit recovers slope and intercept", () => {
  const xs = [0, 100, 200, 300];
  const fit = linearFit(xs, xs.map((x) => 5 + 0.998 * x));
  assert.ok(Math.abs(fit.a - 5) < 1e-9);
  assert.ok(Math.abs(fit.b - 0.998) < 1e-12);
  assert.ok(fit.residuals.every((r) => Math.abs(r) < 1e-9));
});

test("cadence classifies CFR and VFR", () => {
  assert.equal(cadence([0, 40, 80, 120]).mode, "CFR");
  assert.equal(cadence([0, 40, 80, 120]).nominalFps, 25);
  assert.equal(cadence([0, 40, 95, 120]).mode, "VFR");
});

test("isMarkerColor accepts magenta only", () => {
  assert.ok(isMarkerColor([250, 10, 250]));
  assert.ok(!isMarkerColor([250, 250, 250]));
  assert.ok(!isMarkerColor([20, 200, 40]));
});

test("markerRuns collapses consecutive flags with neighbouring PTS", () => {
  const runs = markerRuns([false, true, true, false, true], [0, 40, 80, 120, 160]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { startIndex: 1, endIndex: 2, onPts: 40, prevPts: 0, lastPts: 80, offPts: 120, frames: 2 });
  assert.equal(runs[1].offPts, null);
});

test("firstChangedFrame skips markers and finds the first diff", () => {
  const a = Buffer.alloc(3, 0);
  const b = Buffer.alloc(3, 100);
  const frames = [a, a, b, b];
  assert.equal(firstChangedFrame(frames, [false, false, false, false], 0, 1, 10), 2);
  assert.equal(firstChangedFrame(frames, [false, false, true, false], 0, 1, 10), 3);
  assert.equal(firstChangedFrame(frames, [false, false, false, false], 0, 1, 10, 2), -1);
});

test("frameAtOrBefore binary-searches PTS", () => {
  const pts = [0, 40, 80, 120];
  assert.equal(frameAtOrBefore(pts, -1), -1);
  assert.equal(frameAtOrBefore(pts, 40), 1);
  assert.equal(frameAtOrBefore(pts, 79.9), 1);
  assert.equal(frameAtOrBefore(pts, 500), 3);
});

test("quantizeMs snaps to the frame grid", () => {
  assert.equal(quantizeMs(59, 25), 40);
  assert.equal(quantizeMs(61, 25), 80);
});

test("planRetime freezes when an anchor is early", () => {
  const plan = planRetime({ anchors: [{ srcMs: 1000, targetMs: 1480, label: "a" }], fps: 25, sourceDurationMs: 2000 });
  assert.deepEqual(plan.segments, [
    { kind: "play", srcStart: 0, srcEnd: 1000 },
    { kind: "freeze", srcAt: 960, durMs: 480 },
    { kind: "play", srcStart: 1000, srcEnd: 2000 },
  ]);
  assert.equal(plan.landings[0].predictedMs, 1480);
  assert.equal(plan.outputDurationMs, 2480);
});

test("planRetime drops footage before a late anchor", () => {
  const plan = planRetime({
    anchors: [{ srcMs: 2000, targetMs: 1600, label: "a" }],
    fps: 25,
    sourceDurationMs: 3000,
    dropMarginMs: 200,
  });
  assert.deepEqual(plan.segments, [
    { kind: "play", srcStart: 0, srcEnd: 1400 },
    { kind: "play", srcStart: 1800, srcEnd: 2000 },
    { kind: "play", srcStart: 2000, srcEnd: 3000 },
  ]);
  assert.equal(plan.landings[0].predictedMs, 1600);
});

test("planRetime quantizes targets and rejects impossible drops", () => {
  const plan = planRetime({ anchors: [{ srcMs: 1000, targetMs: 1517 }], fps: 25, sourceDurationMs: 1000 });
  assert.equal(plan.landings[0].predictedMs, 1520);
  assert.throws(
    () => planRetime({ anchors: [{ srcMs: 500, targetMs: 0, label: "x" }], fps: 25, sourceDurationMs: 1000 }),
    /cannot drop/,
  );
  assert.throws(
    () =>
      planRetime({
        anchors: [
          { srcMs: 500, targetMs: 500, label: "a" },
          { srcMs: 400, targetMs: 900, label: "b" },
        ],
        fps: 25,
        sourceDurationMs: 1000,
      }),
    /before the cursor/,
  );
});

test("retimeFilter emits trim/tpad/concat chain", () => {
  const f = retimeFilter(
    [
      { kind: "play", srcStart: 0, srcEnd: 1000 },
      { kind: "freeze", srcAt: 960, durMs: 500 },
    ],
    25,
  );
  assert.match(f, /trim=start=0\.000000:end=1\.000000/);
  assert.match(f, /tpad=stop_mode=clone:stop_duration=0\.460000/);
  assert.match(f, /\[s0\]\[s1\]concat=n=2:v=1:a=0,fps=25\[vout\]$/);
});

function makeWav(samples, sampleRate = 24000, dataSize = samples.length * 2) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

test("parseWav and wavSamples read PCM16", () => {
  const wav = makeWav([0, 0, 1000, -1000]);
  const info = parseWav(wav);
  assert.equal(info.sampleRate, 24000);
  assert.equal(info.dataOffset, 44);
  assert.deepEqual([...wavSamples(wav).samples], [0, 0, 1000, -1000]);
  assert.equal(parseWav(makeWav([1, 2], 24000, 0xffffffff)).dataBytes, 4);
  assert.throws(() => parseWav(Buffer.from("nope")), /RIFF/);
});

test("firstOnset and energyOnsets find speech starts", () => {
  const sr = 1000;
  const samples = new Int16Array(400);
  for (let i = 100; i < 150; i++) samples[i] = 5000;
  for (let i = 300; i < 350; i++) samples[i] = 5000;
  assert.equal(firstOnset(samples), 100);
  assert.deepEqual(energyOnsets(samples, sr, { windowMs: 10, threshold: 300, minGapMs: 60 }), [100, 300]);
});

test("tickGranularity finds the provider grid", () => {
  assert.equal(tickGranularity([1_500_000, 4_375_000, 6_000_000]), 125_000);
});

test("alignWordsToText maps SSML offsets to plain text", () => {
  const words = [
    { text: "Hello", textOffset: 167 },
    { text: "world", textOffset: 173 },
    { text: "<break/>", textOffset: 180 },
  ];
  const aligned = alignWordsToText(words, "Hello world");
  assert.deepEqual(aligned.map((w) => w.plainOffset), [0, 6, null]);
});

test("inferSpeechEndpoint maps Foundry hosts to the cognitiveservices host", () => {
  assert.equal(
    inferSpeechEndpoint("https://seth-foundry-dev.services.ai.azure.com/api/projects/dev-models"),
    "https://seth-foundry-dev.cognitiveservices.azure.com",
  );
});

test("buildPlainSsml escapes narration text", () => {
  assert.match(buildPlainSsml("A & B", "v"), /<voice name='v'>A &amp; B<\/voice>/);
});
