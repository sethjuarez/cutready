// Builds contracts/vectors.tsp from readable fixtures. The emitted TypeSpec is
// committed; `npm run check` fails if it drifts from this builder.
//
// Expected outputs are the canonical desktop save form:
// - rows always carry `locked`, all six `locks`, and `screenshot` (null if unset);
// - sketches always carry `locked` and `description` (null if unset);
// - narration always carries `duration_ms` (null if unknown);
// - empty collections and unset optional values are omitted;
// - unknown fields on sketches and rows are preserved.
// Floats are non-integral binary fractions so every runtime prints them identically.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const NOW = "2026-07-01T09:30:00Z";
const CREATED = "2026-06-28T20:00:00Z";
const UPDATED = "2026-06-28T20:20:00Z";

const clone = (value) => structuredClone(value);
const noLocks = () => ({
  time: false,
  narrative: false,
  demo_actions: false,
  screenshot: false,
  visual: false,
  design_plan: false,
});
const row = (fields, locks = {}) => ({
  locked: false,
  locks: { ...noLocks(), ...locks },
  screenshot: null,
  ...fields,
});
const sketch = (rows, extra = {}) => ({
  title: "Contract sketch",
  locked: false,
  description: null,
  rows,
  state: "draft",
  created_at: CREATED,
  updated_at: UPDATED,
  ...extra,
});

const narration = {
  path: ".cutready/narration/row-1.wav",
  source_text: "Open the workspace.",
  source_text_hash: "4f1c2a",
  mime_type: "audio/wav",
  duration_ms: 4200,
  leading_silence_ms: 120,
  trailing_silence_ms: 80,
  silence_threshold_db: -41.5,
  byte_size: 4096,
  recorded_at: "2026-06-28T20:05:00Z",
};
const { duration_ms: _omitted, ...narrationWithoutDuration } = narration;

const desktopRow = row({
  time: "0:20",
  duration_seconds: 20,
  narrative: "Open the workspace.",
  demo_actions: "Click **Open**.",
  screenshot: "screenshots/open.png",
  visual: ".cutready/visuals/abc123def456.json",
  motion_points: [
    { rank: 1, x: 0.5, y: 0.25, label: "Open button" },
    { rank: 2, x: 0.75, y: 0.5 },
  ],
  typing_spots: [
    {
      x: 0.25,
      y: 0.5,
      width: 0.5,
      height: 0.125,
      text: "demo-project",
      start_offset_ms: 300,
      characters_per_second: 18.5,
      show_cursor: true,
      font_family: "mono",
      font_scale: 1.25,
    },
  ],
  motion_plan: {
    kind: "wide_hold_then_push",
    keyframes: [
      { time_ms: 0, scale: 1.25, x: 0.5, y: 0.5, easing: "linear" },
      { time_ms: 1500, scale: 1.75, x: 0.5, y: 0.25, easing: "ease_in_out" },
    ],
    rationale: "Hold wide, then push toward the Open button.",
  },
  design_plan: "Title card with the product name.",
  narration,
  narration_plan: {
    source_text: "Open the workspace.",
    voice: "en-US-Harper:MAI-Voice-2",
    locale: "en-US",
    ssml: "<speak>Open the workspace.</speak>",
    baseline_style: "friendly",
    pronunciation_overrides: { CutReady: "cut ready" },
    beats: [{ text: "Open the workspace.", emphasis: "moderate", style_degree: 1.5, pause_after_ms: 250 }],
    generated_at: "2026-06-28T20:06:00Z",
  },
});

const desktopSketch = sketch([desktopRow], {
  description: { root: { children: [{ type: "paragraph", children: [{ text: "Intro scene" }] }] } },
  metadata: { fields: { audience: "developers" } },
  state: "refined",
});

// Edit fixture: row 0 unlocked (with desktop-only and unknown fields),
// row 1 has a locked narrative cell, row 2 is a locked row.
const lockedFixture = sketch(
  [
    row({
      time: "0:10",
      duration_seconds: 10,
      narrative: "Open the app.",
      demo_actions: "Click Open.",
      screenshot: "screenshots/open.png",
      motion_points: [{ rank: 1, x: 0.5, y: 0.25 }],
      future_row_field: { keep: true },
    }),
    row({ time: "0:20", narrative: "Locked narration.", demo_actions: "Type a name." }, { narrative: true }),
    { ...row({ time: "0:30", narrative: "Locked row.", demo_actions: "Close." }), locked: true },
  ],
  { future_document_field: ["still", "here"] },
);

const unlockedFixture = sketch([
  row({ time: "0:10", narrative: "First.", demo_actions: "Open.", future_row_field: "first" }),
  row({ time: "0:20", narrative: "Second.", demo_actions: "Click.", screenshot: "screenshots/second.png" }),
]);

// Row lock and cell locks on the same row, for precedence checks.
const precedenceFixture = sketch([
  { ...row({ time: "0:10", narrative: "Row lock wins.", demo_actions: "Hold." }, { narrative: true }), locked: true },
  row({ time: "0:20", narrative: "Two locked cells.", demo_actions: "Hold." }, { time: true, narrative: true }),
]);

// Screenshot and visual locks each guard both cells.
const screenshotLockFixture = sketch([
  row({ time: "0:10", narrative: "A.", demo_actions: "", screenshot: "screenshots/shared.png", visual: ".cutready/visuals/one.json" }, { screenshot: true }),
  row({ time: "0:10", narrative: "A.", demo_actions: "", screenshot: "screenshots/shared.png", visual: ".cutready/visuals/two.json" }),
]);
const visualLockFixture = sketch([
  row({ time: "0:10", narrative: "A.", demo_actions: "", screenshot: "screenshots/one.png", visual: ".cutready/visuals/shared.json" }, { visual: true }),
  row({ time: "0:10", narrative: "A.", demo_actions: "", screenshot: "screenshots/two.png", visual: ".cutready/visuals/shared.json" }),
]);

// lockedFixture plus a trailing unlocked row, for reorders that respect locks.
const lockedFixtureWithSpare = clone(lockedFixture);
lockedFixtureWithSpare.rows.push(row({ time: "0:40", narrative: "Spare.", demo_actions: "Wrap up." }));

// Rows that differ only in fields the edit UI never shows.
const hiddenFieldFixture = sketch([
  { ...row({ time: "0:10", narrative: "Same.", demo_actions: "Same.", future_row_field: "a" }), locked: true },
  row({ time: "0:10", narrative: "Same.", demo_actions: "Same.", future_row_field: "b" }),
]);

// A video-import row: its duration came from the scene, not the range label.
const importedFixture = sketch([
  row({ time: "0:05 - 0:19", duration_seconds: 14, narrative: "Imported scene.", demo_actions: "" }),
]);

// Text that only differs by Unicode composition: locks compare it exactly.
const composedFixture = sketch([
  row({ time: "\u00c5 0:10", duration_seconds: 10, narrative: "Time locked.", demo_actions: "" }, { time: true }),
  { ...row({ time: "0:20", narrative: "Caf\u00e9.", demo_actions: "" }), locked: true },
]);

const edited = (base, mutate) => {
  const next = clone(base);
  mutate(next);
  next.updated_at = NOW;
  return next;
};

const roundTripVectors = [
  {
    name: "canonical desktop sketch is unchanged",
    input: { sketch: desktopSketch },
    expected: desktopSketch,
  },
  {
    name: "legacy minimal sketch gains canonical defaults",
    input: {
      sketch: {
        title: "Legacy",
        rows: [
          {
            time: "~30s",
            narrative: "Legacy row.",
            demo_actions: "",
            narration: narrationWithoutDuration,
          },
        ],
        state: "sketch",
        created_at: CREATED,
        updated_at: UPDATED,
      },
    },
    expected: {
      title: "Legacy",
      locked: false,
      description: null,
      rows: [
        row({
          time: "~30s",
          narrative: "Legacy row.",
          demo_actions: "",
          narration: { ...narrationWithoutDuration, duration_ms: null },
        }),
      ],
      state: "draft",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },
  {
    name: "unknown sketch and row fields are preserved",
    input: { sketch: lockedFixture },
    expected: lockedFixture,
  },
  {
    name: "timestamps are saved as UTC",
    input: {
      sketch: sketch(
        [row({ time: "0:05", narrative: "Offset.", demo_actions: "", narration: { ...narration, recorded_at: "2026-06-28T22:05:00.5+02:00" } })],
        { created_at: "2026-06-28T22:00:00+02:00", updated_at: "2026-06-28T20:20:00.123456789Z" },
      ),
    },
    expected: sketch(
      [row({ time: "0:05", narrative: "Offset.", demo_actions: "", narration: { ...narration, recorded_at: "2026-06-28T20:05:00.500Z" } })],
      { created_at: CREATED, updated_at: "2026-06-28T20:20:00.123456789Z" },
    ),
  },
  {
    name: "null and empty optional values are omitted",
    input: {
      sketch: sketch(
        [
          row({
            time: "0:05",
            duration_seconds: null,
            narrative: "Sparse row.",
            demo_actions: "Wait.",
            visual: null,
            design_plan: null,
            motion_points: null,
            typing_spots: [],
            motion_plan: { kind: "subtle_push", keyframes: [], rationale: null },
            narration: { ...narration, duration_ms: null, leading_silence_ms: null, trailing_silence_ms: null, silence_threshold_db: null },
            narration_plan: {
              source_text: "Sparse row.",
              voice: "en-US-Harper:MAI-Voice-2",
              locale: "en-US",
              ssml: "<speak>Sparse row.</speak>",
              baseline_style: null,
              pronunciation_overrides: {},
              beats: [],
              generated_at: "2026-06-28T20:06:00Z",
            },
          }),
        ],
        { metadata: { fields: {} } },
      ),
    },
    expected: sketch([
      row({
        time: "0:05",
        narrative: "Sparse row.",
        demo_actions: "Wait.",
        motion_plan: { kind: "subtle_push" },
        narration: {
          path: narration.path,
          source_text: narration.source_text,
          source_text_hash: narration.source_text_hash,
          mime_type: narration.mime_type,
          duration_ms: null,
          byte_size: narration.byte_size,
          recorded_at: narration.recorded_at,
        },
        narration_plan: {
          source_text: "Sparse row.",
          voice: "en-US-Harper:MAI-Voice-2",
          locale: "en-US",
          ssml: "<speak>Sparse row.</speak>",
          generated_at: "2026-06-28T20:06:00Z",
        },
      }),
    ]),
  },
  {
    name: "null optional fields load as absent",
    input: {
      sketch: sketch(
        [
          {
            ...row({
              time: "0:05",
              narrative: "Null row.",
              demo_actions: "Wait.",
              future_row_field: null,
              typing_spots: null,
              motion_plan: { kind: "subtle_push", keyframes: null },
              narration_plan: {
                source_text: "Null row.",
                voice: "en-US-Harper:MAI-Voice-2",
                locale: "en-US",
                ssml: "<speak>Null row.</speak>",
                pronunciation_overrides: null,
                beats: null,
                generated_at: "2026-06-28T20:06:00Z",
              },
            }),
            locked: null,
            locks: null,
          },
          row(
            { time: "0:10", narrative: "Null cell lock.", demo_actions: "Wait." },
            { time: null, narrative: true, demo_actions: null, screenshot: null, visual: null, design_plan: null },
          ),
        ],
        { locked: null, metadata: null, future_document_field: { kept: null } },
      ),
    },
    expected: sketch([
      row({
        time: "0:05",
        narrative: "Null row.",
        demo_actions: "Wait.",
        future_row_field: null,
        motion_plan: { kind: "subtle_push" },
        narration_plan: {
          source_text: "Null row.",
          voice: "en-US-Harper:MAI-Voice-2",
          locale: "en-US",
          ssml: "<speak>Null row.</speak>",
          generated_at: "2026-06-28T20:06:00Z",
        },
      }),
      row({ time: "0:10", narrative: "Null cell lock.", demo_actions: "Wait." }, { narrative: true }),
    ], { future_document_field: { kept: null } }),
  },
  {
    name: "null metadata fields load as absent",
    input: { sketch: sketch([], { metadata: { fields: null } }) },
    expected: sketch([]),
  },
];

const updateRow = (row_index, cells) => ({ row_index, ...cells });

const updateRowTextVectors = [
  {
    name: "edit time keeps microseconds",
    input: { sketch: unlockedFixture, update: updateRow(1, { demo_actions: "Double-click." }), now: "2026-07-01T09:30:00.123456Z" },
    expected: (() => {
      const next = edited(unlockedFixture, (s) => {
        s.rows[1].demo_actions = "Double-click.";
      });
      next.updated_at = "2026-07-01T09:30:00.123456Z";
      return next;
    })(),
  },
  {
    name: "narrative edit preserves desktop-only and unknown fields",
    input: { sketch: lockedFixture, update: updateRow(0, { narrative: "Open the CutReady app." }), now: NOW },
    expected: edited(lockedFixture, (s) => {
      s.rows[0].narrative = "Open the CutReady app.";
    }),
  },
  {
    name: "time edit recomputes duration_seconds",
    input: { sketch: lockedFixture, update: updateRow(0, { time: "0:15" }), now: NOW },
    expected: edited(lockedFixture, (s) => {
      s.rows[0].time = "0:15";
      s.rows[0].duration_seconds = 15;
    }),
  },
  {
    name: "unparseable time edit removes duration_seconds",
    input: { sketch: lockedFixture, update: updateRow(0, { time: "TBD" }), now: NOW },
    expected: edited(lockedFixture, (s) => {
      s.rows[0].time = "TBD";
      delete s.rows[0].duration_seconds;
    }),
  },
  {
    name: "unchanged time keeps duration_seconds",
    input: {
      sketch: importedFixture,
      update: updateRow(0, { time: "0:05 - 0:19", narrative: "Imported scene, edited." }),
      now: NOW,
    },
    expected: edited(importedFixture, (s) => {
      s.rows[0].narrative = "Imported scene, edited.";
    }),
  },
  {
    name: "unlocked cells on a row with a locked cell are editable",
    input: {
      sketch: lockedFixture,
      update: updateRow(1, { time: "0:25", demo_actions: "Type the project name." }),
      now: NOW,
    },
    expected: edited(lockedFixture, (s) => {
      s.rows[1].time = "0:25";
      s.rows[1].duration_seconds = 25;
      s.rows[1].demo_actions = "Type the project name.";
    }),
  },
  {
    name: "locked cell rejects a change",
    input: { sketch: lockedFixture, update: updateRow(1, { narrative: "Changed." }), now: NOW },
    expectedError: { code: "locked_cell", row_index: 1, field: "narrative" },
  },
  {
    name: "locked cell accepts an unchanged value",
    input: { sketch: lockedFixture, update: updateRow(1, { narrative: "Locked narration." }), now: NOW },
    expected: edited(lockedFixture, () => {}),
  },
  {
    name: "locked row rejects a change",
    input: { sketch: lockedFixture, update: updateRow(2, { time: "0:45" }), now: NOW },
    expectedError: { code: "locked_row", row_index: 2 },
  },
  {
    name: "locked sketch rejects every edit",
    input: { sketch: { ...unlockedFixture, locked: true }, update: updateRow(0, { narrative: "First." }), now: NOW },
    expectedError: { code: "locked_document" },
  },
  {
    name: "row index outside the table is rejected",
    input: { sketch: lockedFixture, update: updateRow(3, { narrative: "Missing." }), now: NOW },
    expectedError: { code: "row_not_found", row_index: 3 },
  },
  {
    name: "locked sketch takes precedence over a missing row",
    input: { sketch: { ...unlockedFixture, locked: true }, update: updateRow(9, { narrative: "Missing." }), now: NOW },
    expectedError: { code: "locked_document" },
  },
  {
    name: "row lock takes precedence over a cell lock",
    input: { sketch: precedenceFixture, update: updateRow(0, { narrative: "Changed." }), now: NOW },
    expectedError: { code: "locked_row", row_index: 0 },
  },
  {
    name: "locked cells are checked in column order",
    input: { sketch: precedenceFixture, update: updateRow(1, { time: "0:25", narrative: "Changed." }), now: NOW },
    expectedError: { code: "locked_cell", row_index: 1, field: "time" },
  },
  {
    name: "locked cell rejects a differently composed value",
    input: { sketch: composedFixture, update: updateRow(0, { time: "A\u030a 0:10" }), now: NOW },
    expectedError: { code: "locked_cell", row_index: 0, field: "time" },
  },
  {
    name: "locked row rejects a differently composed value",
    input: { sketch: composedFixture, update: updateRow(1, { narrative: "Cafe\u0301." }), now: NOW },
    expectedError: { code: "locked_row", row_index: 1 },
  },
];

const reorderRowsVectors = [
  {
    name: "reorder moves whole rows including unknown fields",
    input: { sketch: unlockedFixture, order: [1, 0], now: NOW },
    expected: edited(unlockedFixture, (s) => {
      s.rows = [s.rows[1], s.rows[0]];
    }),
  },
  {
    name: "reorder that changes a locked row is rejected",
    input: { sketch: lockedFixture, order: [2, 1, 0], now: NOW },
    expectedError: { code: "locked_row", row_index: 2 },
  },
  {
    name: "reorder that changes a locked cell is rejected",
    input: { sketch: lockedFixture, order: [1, 0, 2], now: NOW },
    expectedError: { code: "locked_cell", row_index: 1, field: "narrative" },
  },
  {
    name: "reorder around locked rows keeps locks in place",
    input: { sketch: lockedFixtureWithSpare, order: [3, 1, 2, 0], now: NOW },
    expected: edited(lockedFixtureWithSpare, (s) => {
      s.rows = [s.rows[3], s.rows[1], s.rows[2], s.rows[0]];
    }),
  },
  {
    name: "earlier locked cell fires before a later locked row",
    input: { sketch: lockedFixture, order: [0, 2, 1], now: NOW },
    expectedError: { code: "locked_cell", row_index: 1, field: "narrative" },
  },
  {
    name: "screenshot lock also guards the visual",
    input: { sketch: screenshotLockFixture, order: [1, 0], now: NOW },
    expectedError: { code: "locked_cell", row_index: 0, field: "screenshot" },
  },
  {
    name: "visual lock also guards the screenshot",
    input: { sketch: visualLockFixture, order: [1, 0], now: NOW },
    expectedError: { code: "locked_cell", row_index: 0, field: "visual" },
  },
  {
    name: "locked row protects fields a runtime does not model",
    input: { sketch: hiddenFieldFixture, order: [1, 0], now: NOW },
    expectedError: { code: "locked_row", row_index: 0 },
  },
  {
    name: "locked sketch takes precedence over an invalid order",
    input: { sketch: { ...unlockedFixture, locked: true }, order: [0, 0], now: NOW },
    expectedError: { code: "locked_document" },
  },
  {
    name: "reorder that is not a permutation is rejected",
    input: { sketch: unlockedFixture, order: [0, 0], now: NOW },
    expectedError: { code: "invalid_reorder" },
  },
];

const parseDuration = (name, time, expected) => ({ name, input: { time }, expected });

const parseDurationSecondsVectors = [
  parseDuration("clock minutes and seconds", "1:30", 90),
  parseDuration("clock hours, minutes, and seconds", "1:02:03", 3723),
  parseDuration("clock part may be one digit", "0:5", 5),
  parseDuration("clock part of 60 or more is not a clock", "1:60", null),
  parseDuration("approximate seconds", "~25s", 25),
  parseDuration("whitespace, case, and the approximate mark are ignored", "  ~ 45 SEC  ", 45),
  parseDuration("unit pairs are summed", "1h 2m 3s", 3723),
  parseDuration("long unit names", "2 minutes 15 seconds", 135),
  parseDuration("text around unit pairs is ignored", "about 2 min", 120),
  parseDuration("fractional units", "1.25m", 75),
  parseDuration("fractional seconds round half up", "2.5s", 3),
  parseDuration("non-breaking space separates a unit", "5\u00a0s", 5),
  parseDuration("unit followed by a word character does not count", "5sec2", null),
  parseDuration("a unit may not run into the next pair", "5 m5s", 5),
  parseDuration("a unit may be followed by a non-ASCII letter", "5s\u03b1", 5),
  parseDuration("a second fraction is not part of the number", "1.5.5m", 330),
  parseDuration("a fraction needs a leading digit", "5 .5m", 300),
  parseDuration("exponents are not numbers", "1e3s", 3),
  parseDuration("unit pairs are rounded after summing", "0.4s 0.4s", 1),
  parseDuration("bare number of seconds", "90", 90),
  parseDuration("bare fraction rounds half up", "2.5", 3),
  parseDuration("only ASCII digits count", "\u0663\u0660s", null),
  parseDuration("Unicode lowercasing can join a unit to a word", "5s\u212a", null),
  parseDuration("Unicode lowercasing can expand a character", "5 s\u0130", null),
  parseDuration("empty label", "", null),
  parseDuration("label without a duration", "TBD", null),
  parseDuration("largest uint32", "4294967295", 4294967295),
  parseDuration("rounds down to the largest uint32", "4294967295.4", 4294967295),
  parseDuration("too large for uint32", "4294967296", null),
  parseDuration("rounds up past uint32", "4294967295.5", null),
];

const tspConst = (name, vectors) => `const ${name} = """\n${JSON.stringify(vectors, null, 2)}\n""";\n`;

const contractsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
writeFileSync(
  path.join(contractsDir, "vectors.tsp"),
  [
    "// Generated by contracts/vectors/build.mjs. Edit the builder, then run `npm run generate`.",
    "",
    "namespace CutReady.Contracts;",
    "",
    tspConst("RoundTripVectors", roundTripVectors),
    tspConst("UpdateRowTextVectors", updateRowTextVectors),
    tspConst("ReorderRowsVectors", reorderRowsVectors),
    tspConst("ParseDurationSecondsVectors", parseDurationSecondsVectors),
  ].join("\n"),
);
