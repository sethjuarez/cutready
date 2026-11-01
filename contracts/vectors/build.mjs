// Builds contracts/vectors.tsp from readable fixtures. The emitted TypeSpec is
// committed; `npm run check` fails if it drifts from this builder.
//
// Expected outputs are the canonical desktop save form:
// - rows always carry `id`, `locked`, all six `locks`, and `screenshot` (null if unset);
// - sketches always carry `locked` and `description` (null if unset);
// - narration always carries `duration_ms` (null if unknown);
// - empty collections and unset optional values are omitted;
// - unknown fields on sketches and rows are preserved;
// - storyboards always carry `description` and `locked`, sections omit an empty
//   `description`; older storyboard shapes are covered by the upgrade vectors;
// - chat artifacts omit a blank `summary` and empty `tool_uses`.
// Floats are non-integral binary fractions so every runtime prints them identically.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
// Rows without an id get the one decode assigns to a legacy row at that position.
const withIds = (rows) => rows.map((r, i) => ("id" in r ? r : { id: `row-${i + 1}`, ...r }));
const sketch = (rows, extra = {}) => ({
  title: "Contract sketch",
  locked: false,
  description: null,
  rows: withIds(rows),
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
lockedFixtureWithSpare.rows.push(row({ id: "row-4", time: "0:40", narrative: "Spare.", demo_actions: "Wrap up." }));

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

// A CmdError as vectors pin it: `code` plus typed `details`. `message` is
// human-readable text each runtime words for itself, so adapters omit it.
const cmdError = (code, details) => (details ? { code, details } : { code });

// One plain row per entry, with the entry's fields merged in; an entry without
// an `id` stays without one.
const idFixture = (entries) => ({
  ...sketch([]),
  rows: entries.map((fields, i) => ({ ...row({ time: `0:${i + 1}0`, narrative: `Row ${i + 1}.`, demo_actions: "" }), ...fields })),
});

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
          id: "row-1",
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
  {
    name: "existing row ids are kept",
    input: { sketch: idFixture([{ id: "intro" }, { id: "6f1c0d2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f" }]) },
    expected: idFixture([{ id: "intro" }, { id: "6f1c0d2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f" }]),
  },
  {
    name: "rows without an id get their one-based position",
    input: { sketch: idFixture([{ id: "intro" }, {}, {}]) },
    expected: idFixture([{ id: "intro" }, { id: "row-2" }, { id: "row-3" }]),
  },
  {
    name: "empty and null row ids count as missing",
    input: { sketch: idFixture([{ id: "" }, { id: null }]) },
    expected: idFixture([{ id: "row-1" }, { id: "row-2" }]),
  },
  {
    name: "an assigned id skips ids already in use",
    input: { sketch: idFixture([{ id: "row-2" }, {}, { id: "row-2-2" }]) },
    expected: idFixture([{ id: "row-2" }, { id: "row-2-3" }, { id: "row-2-2" }]),
  },
  {
    name: "duplicate row ids are rejected",
    input: { sketch: idFixture([{ id: "intro" }, { id: "body" }, { id: "intro" }]) },
    expectedError: cmdError("duplicate_row_id", { row_index: 2, row_id: "intro" }),
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
    expectedError: cmdError("locked_cell", { row_index: 1, field: "narrative" }),
  },
  {
    name: "locked cell accepts an unchanged value",
    input: { sketch: lockedFixture, update: updateRow(1, { narrative: "Locked narration." }), now: NOW },
    expected: edited(lockedFixture, () => {}),
  },
  {
    name: "locked row rejects a change",
    input: { sketch: lockedFixture, update: updateRow(2, { time: "0:45" }), now: NOW },
    expectedError: cmdError("locked_row", { row_index: 2 }),
  },
  {
    name: "locked sketch rejects every edit",
    input: { sketch: { ...unlockedFixture, locked: true }, update: updateRow(0, { narrative: "First." }), now: NOW },
    expectedError: cmdError("locked_document"),
  },
  {
    name: "row index outside the table is rejected",
    input: { sketch: lockedFixture, update: updateRow(3, { narrative: "Missing." }), now: NOW },
    expectedError: cmdError("row_not_found", { row_index: 3 }),
  },
  {
    name: "locked sketch takes precedence over a missing row",
    input: { sketch: { ...unlockedFixture, locked: true }, update: updateRow(9, { narrative: "Missing." }), now: NOW },
    expectedError: cmdError("locked_document"),
  },
  {
    name: "row lock takes precedence over a cell lock",
    input: { sketch: precedenceFixture, update: updateRow(0, { narrative: "Changed." }), now: NOW },
    expectedError: cmdError("locked_row", { row_index: 0 }),
  },
  {
    name: "locked cells are checked in column order",
    input: { sketch: precedenceFixture, update: updateRow(1, { time: "0:25", narrative: "Changed." }), now: NOW },
    expectedError: cmdError("locked_cell", { row_index: 1, field: "time" }),
  },
  {
    name: "locked cell rejects a differently composed value",
    input: { sketch: composedFixture, update: updateRow(0, { time: "A\u030a 0:10" }), now: NOW },
    expectedError: cmdError("locked_cell", { row_index: 0, field: "time" }),
  },
  {
    name: "locked row rejects a differently composed value",
    input: { sketch: composedFixture, update: updateRow(1, { narrative: "Cafe\u0301." }), now: NOW },
    expectedError: cmdError("locked_row", { row_index: 1 }),
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
    expectedError: cmdError("locked_row", { row_index: 2 }),
  },
  {
    name: "reorder that changes a locked cell is rejected",
    input: { sketch: lockedFixture, order: [1, 0, 2], now: NOW },
    expectedError: cmdError("locked_cell", { row_index: 1, field: "narrative" }),
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
    expectedError: cmdError("locked_cell", { row_index: 1, field: "narrative" }),
  },
  {
    name: "screenshot lock also guards the visual",
    input: { sketch: screenshotLockFixture, order: [1, 0], now: NOW },
    expectedError: cmdError("locked_cell", { row_index: 0, field: "screenshot" }),
  },
  {
    name: "visual lock also guards the screenshot",
    input: { sketch: visualLockFixture, order: [1, 0], now: NOW },
    expectedError: cmdError("locked_cell", { row_index: 0, field: "visual" }),
  },
  {
    name: "locked row protects fields a runtime does not model",
    input: { sketch: hiddenFieldFixture, order: [1, 0], now: NOW },
    expectedError: cmdError("locked_row", { row_index: 0 }),
  },
  {
    name: "locked sketch takes precedence over an invalid order",
    input: { sketch: { ...unlockedFixture, locked: true }, order: [0, 0], now: NOW },
    expectedError: cmdError("locked_document"),
  },
  {
    name: "reorder that is not a permutation is rejected",
    input: { sketch: unlockedFixture, order: [0, 0], now: NOW },
    expectedError: cmdError("invalid_reorder"),
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

// Storyboards always carry `description` ("" if unset) and `locked`; sections
// omit an empty `description`; legacy top-level `sketches` is never written.
const storyboard = (items, extra = {}) => ({
  title: "Contract storyboard",
  description: "",
  locked: false,
  items,
  created_at: CREATED,
  updated_at: UPDATED,
  ...extra,
});
const sketchRef = (path) => ({ type: "sketch_ref", path });
const section = (title, sketches, extra = {}) => ({ type: "section", title, ...extra, sketches });

const desktopStoryboard = storyboard(
  [
    sketchRef("intro.sk"),
    section("Setup", ["flows/login.sk", "flows/workspace.sk"], { description: "Get signed in." }),
    section("Wrap-up", []),
    sketchRef("outro.sk"),
  ],
  {
    description: "End-to-end launch demo.",
    locked: true,
    metadata: { fields: { audience: "partners" } },
    future_storyboard_field: { owner: "ios", tags: ["a", "b"] },
  },
);

const storyboardRoundTripVectors = [
  {
    name: "canonical desktop storyboard is unchanged",
    input: { storyboard: desktopStoryboard },
    expected: desktopStoryboard,
  },
  {
    name: "timestamps are saved as UTC",
    input: {
      storyboard: storyboard([], {
        created_at: "2026-06-28T22:00:00+02:00",
        updated_at: "2026-06-28T20:20:00.123456789Z",
      }),
    },
    expected: storyboard([], { updated_at: "2026-06-28T20:20:00.123456789Z" }),
  },
];

// Older shapes are upgraded once, when a runtime reads the file, and saved canonically.
const storyboardUpgradeVectors = [
  {
    name: "canonical storyboard is already current",
    input: { storyboard: desktopStoryboard },
    expected: desktopStoryboard,
  },
  {
    name: "legacy sketches list becomes sketch references",
    input: {
      storyboard: {
        title: "Legacy",
        sketches: ["intro.sk", "outro.sk"],
        created_at: CREATED,
        updated_at: UPDATED,
      },
    },
    expected: storyboard([sketchRef("intro.sk"), sketchRef("outro.sk")], { title: "Legacy" }),
  },
  {
    name: "items win over a legacy sketches list, which is dropped",
    input: {
      storyboard: { ...storyboard([sketchRef("intro.sk")]), sketches: ["stale.sk"] },
    },
    expected: storyboard([sketchRef("intro.sk")]),
  },
  {
    name: "null items fall back to the legacy sketches list",
    input: {
      storyboard: { ...storyboard(null), sketches: ["intro.sk"] },
    },
    expected: storyboard([sketchRef("intro.sk")]),
  },
  {
    name: "missing items and sketches become an empty sequence",
    input: {
      storyboard: { title: "Empty", created_at: CREATED, updated_at: UPDATED },
    },
    expected: storyboard([], { title: "Empty" }),
  },
  {
    name: "null and empty optional values take canonical defaults",
    input: {
      storyboard: storyboard(
        [section("Setup", ["intro.sk"], { description: null }), section("Empty", [], { description: "" })],
        { description: null, locked: null, metadata: { fields: {} } },
      ),
    },
    expected: storyboard([section("Setup", ["intro.sk"]), section("Empty", [])]),
  },
  {
    name: "sketch item type becomes sketch_ref",
    input: {
      storyboard: storyboard([{ type: "sketch", path: "intro.sk" }]),
    },
    expected: storyboard([sketchRef("intro.sk")]),
  },
  {
    name: "section without sketches becomes an empty section",
    input: {
      storyboard: storyboard([{ type: "section", title: "Later" }]),
    },
    expected: storyboard([section("Later", [])]),
  },
];

// Chat artifacts omit a blank `summary` and empty `tool_uses`. Promotion keeps
// what the user saw: message text, tool names and targets, and who answered.
const STARTED = "2026-06-30T18:00:00Z";
const ada = { name: "Ada Lovelace", email: "ada@example.com" };
const grace = { name: "Grace Hopper" };
const chatArtifact = (turns, extra = {}) => ({
  title: "Plan the launch demo",
  author: ada,
  promoted_by: grace,
  promoted_at: NOW,
  source: { session_id: "chat-1", started_at: STARTED },
  turns,
  updated_at: NOW,
  ...extra,
});
const userTurn = (text, extra = {}) => ({ role: "user", text, ...extra });
const assistantTurn = (text, extra = {}) => ({ role: "assistant", text, ...extra });

const desktopChatArtifact = chatArtifact(
  [
    userTurn("Draft an intro sketch for the launch demo.\n[References: @note:launch-brief.md]"),
    assistantTurn("I read the brief and drafted **Intro** with three rows.", {
      tool_uses: [
        { name: "read_note", target: "launch-brief.md" },
        { name: "write_sketch", target: "intro.sk" },
        { name: "list_project_files" },
      ],
      agent: "planner",
      model: "gpt-5.4",
      future_turn_field: { confidence: 0.75 },
    }),
  ],
  {
    summary: "Agreed on a three-row intro.",
    future_chat_field: { reviewers: ["grace"] },
  },
);

const chatArtifactRoundTripVectors = [
  {
    name: "canonical chat artifact is unchanged",
    input: { artifact: desktopChatArtifact },
    expected: desktopChatArtifact,
  },
  {
    name: "minimal chat artifact is unchanged",
    input: {
      artifact: chatArtifact([userTurn("Hello."), assistantTurn("Hi.")], {
        author: grace,
        source: { session_id: "chat-2" },
      }),
    },
    expected: chatArtifact([userTurn("Hello."), assistantTurn("Hi.")], {
      author: grace,
      source: { session_id: "chat-2" },
    }),
  },
  {
    name: "null, blank, and empty optional values are omitted",
    input: {
      artifact: chatArtifact(
        [
          userTurn("Hello.", { tool_uses: null, agent: null, model: null }),
          assistantTurn("Hi.", { tool_uses: [] }),
          assistantTurn("Saved.", { tool_uses: [{ name: "write_note", target: null }] }),
        ],
        {
          summary: "  \n",
          author: { name: "Ada Lovelace", email: null },
          source: { session_id: "chat-1", started_at: null },
        },
      ),
    },
    expected: chatArtifact(
      [userTurn("Hello."), assistantTurn("Hi."), assistantTurn("Saved.", { tool_uses: [{ name: "write_note" }] })],
      { author: { name: "Ada Lovelace" }, source: { session_id: "chat-1" } },
    ),
  },
];

const toolCall = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const runDetails = (agent_id, model) => ({
  provider: "foundry",
  model,
  execution_engine: "prompty",
  agent_id,
  run_id: "run-1",
  elapsed_ms: 1250,
});
const transcript = (messages, extra = {}) => ({ session_id: "chat-1", created_at: STARTED, messages, ...extra });
const promotion = (extra = {}) => ({
  title: "Plan the launch demo",
  author: ada,
  promoted_by: grace,
  promoted_at: NOW,
  ...extra,
});
const fourTurns = transcript([
  { role: "user", content: "One" },
  { role: "assistant", content: "Two" },
  { role: "user", content: "Three" },
  { role: "assistant", content: "Four" },
]);

const chatArtifactPromoteVectors = [
  {
    name: "agent run is curated into turns",
    input: {
      session: transcript([
        { role: "system", content: "You are the planner." },
        { role: "user", content: "  Draft an intro sketch for the launch demo.\n[References: @note:launch-brief.md]  " },
        {
          role: "assistant",
          content: "Let me read the brief first.",
          tool_calls: [toolCall("call-1", "read_note", { path: "launch-brief.md" })],
          cutready: { workingNotes: { drafts: ["Private draft"], thinking: "Private reasoning" } },
        },
        { role: "tool", tool_call_id: "call-1", content: "# Launch brief\nPrivate numbers." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            toolCall("call-2", "write_sketch", { path: "intro.sk", title: "Intro", rows: [] }),
            toolCall("call-3", "fetch_url", { url: "https://example.com/launch" }),
          ],
        },
        { role: "tool", tool_call_id: "call-2", content: "Saved intro.sk" },
        { role: "tool", tool_call_id: "call-3", content: "<html></html>" },
        {
          role: "assistant",
          content: "I drafted **Intro** with three rows.",
          cutready: { runDetails: runDetails("planner", "gpt-5.4") },
        },
        { role: "user", content: "Thanks!" },
        { role: "assistant", content: "Anytime.", cutready: { runDetails: runDetails("writer", "gpt-5.4-mini") } },
      ]),
      request: promotion({ summary: "  Agreed on a three-row intro.\n" }),
    },
    expected: chatArtifact(
      [
        userTurn("Draft an intro sketch for the launch demo.\n[References: @note:launch-brief.md]"),
        assistantTurn("Let me read the brief first.\n\nI drafted **Intro** with three rows.", {
          tool_uses: [
            { name: "read_note", target: "launch-brief.md" },
            { name: "write_sketch", target: "intro.sk" },
            { name: "fetch_url", target: "https://example.com/launch" },
          ],
          agent: "planner",
          model: "gpt-5.4",
        }),
        userTurn("Thanks!"),
        assistantTurn("Anytime.", { agent: "writer", model: "gpt-5.4-mini" }),
      ],
      { summary: "Agreed on a three-row intro." },
    ),
  },
  {
    name: "images, pending, and empty messages are dropped before folding",
    input: {
      session: transcript([
        {
          role: "user",
          content: [
            { type: "text", text: "What is on this slide?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "text", text: "Keep it short." },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "A launch timeline." }] },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }] },
        { role: "assistant", content: "It shows three milestones." },
        { role: "user", content: "   " },
        { role: "assistant", content: "" },
        { role: "user", content: "Queued question", pending: true },
        { role: "developer", content: "Unknown roles are dropped." },
      ]),
      request: promotion(),
    },
    expected: chatArtifact([
      userTurn("What is on this slide?\nKeep it short."),
      assistantTurn("A launch timeline.\n\nIt shows three milestones."),
    ]),
  },
  {
    name: "tool targets come from path or url arguments",
    input: {
      session: transcript([
        { role: "user", content: "Tidy the project." },
        {
          role: "assistant",
          content: "Working on it.",
          tool_calls: [
            toolCall("c1", "list_project_files", {}),
            toolCall("c2", "read_sketch", { path: "  ", url: " https://example.com/spec " }),
            toolCall("c3", "write_note", "{not json"),
            toolCall("c4", "read_note", { path: 42 }),
            { id: "c5", type: "function", function: { name: "read_storyboard" } },
            { id: "c6", type: "function", function: { name: "  ", arguments: "{}" } },
            toolCall("c7", "write_sketch", { path: " flows/login.sk " }),
          ],
        },
      ]),
      request: promotion(),
    },
    expected: chatArtifact([
      userTurn("Tidy the project."),
      assistantTurn("Working on it.", {
        tool_uses: [
          { name: "list_project_files" },
          { name: "read_sketch", target: "https://example.com/spec" },
          { name: "write_note" },
          { name: "read_note" },
          { name: "read_storyboard" },
          { name: "write_sketch", target: "flows/login.sk" },
        ],
      }),
    ]),
  },
  {
    name: "selected turns keep transcript order and ignore bad indices",
    input: { session: fourTurns, request: promotion({ selected_turns: [3, 0, 3, 9] }) },
    expected: chatArtifact([userTurn("One"), assistantTurn("Four")]),
  },
  {
    name: "omitted selection keeps every turn",
    input: { session: fourTurns, request: promotion() },
    expected: chatArtifact([userTurn("One"), assistantTurn("Two"), userTurn("Three"), assistantTurn("Four")]),
  },
  {
    name: "unknown session start and blank summary are omitted",
    input: {
      session: { session_id: "chat-9", messages: [{ role: "user", content: "Hello." }] },
      request: promotion({ title: "  Quick question  ", summary: " \n " }),
    },
    expected: chatArtifact([userTurn("Hello.")], {
      title: "Quick question",
      source: { session_id: "chat-9" },
    }),
  },
];

// TypeSpec strings interpret backslash escapes, so JSON's own escapes are doubled.
// EditService.applySketchOps. Rows are addressed by the ids decode assigns
// (`row-1`, `row-2`, ...). Every rejection reports the failing op's index.
const opError = (op_index, code, details = {}) => cmdError(code, { ...details, op_index });
const allLocks = () => ({ time: true, narrative: true, demo_actions: true, screenshot: true, visual: true, design_plan: true });
const newRow = (fields = {}) => row({ id: "new-row", time: "0:05", narrative: "New.", demo_actions: "Wave.", ...fields });

const applySketchOpsVectors = [
  {
    name: "set_title keeps unknown document fields",
    input: { sketch: lockedFixture, ops: [{ kind: "set_title", title: "Renamed" }], now: NOW },
    expected: edited(lockedFixture, (s) => {
      s.title = "Renamed";
    }),
  },
  {
    name: "set_description replaces and clears the description",
    input: {
      sketch: desktopSketch,
      ops: [
        { kind: "set_description", description: { root: { children: [] } } },
        { kind: "set_description", description: null },
      ],
      now: NOW,
    },
    expected: edited(desktopSketch, (s) => {
      s.description = null;
    }),
  },
  {
    name: "set_metadata replaces the metadata",
    input: { sketch: desktopSketch, ops: [{ kind: "set_metadata", metadata: { fields: { audience: "admins", length: "short" } } }], now: NOW },
    expected: edited(desktopSketch, (s) => {
      s.metadata = { fields: { audience: "admins", length: "short" } };
    }),
  },
  {
    name: "set_row_text edits the row with that id and recomputes duration",
    input: { sketch: lockedFixture, ops: [{ kind: "set_row_text", row_id: "row-1", time: "0:15", narrative: "Open CutReady." }], now: NOW },
    expected: edited(lockedFixture, (s) => {
      s.rows[0].time = "0:15";
      s.rows[0].duration_seconds = 15;
      s.rows[0].narrative = "Open CutReady.";
    }),
  },
  {
    name: "ops address rows by id after a reorder in the same batch",
    input: {
      sketch: unlockedFixture,
      ops: [
        { kind: "reorder_rows", row_ids: ["row-2", "row-1"] },
        { kind: "set_row_text", row_id: "row-1", narrative: "First, now last." },
      ],
      now: NOW,
    },
    expected: edited(unlockedFixture, (s) => {
      s.rows = [s.rows[1], s.rows[0]];
      s.rows[1].narrative = "First, now last.";
    }),
  },
  {
    name: "set_row_text on a locked cell is rejected",
    input: { sketch: lockedFixture, ops: [{ kind: "set_row_text", row_id: "row-2", narrative: "Changed." }], now: NOW },
    expectedError: opError(0, "locked_cell", { row_index: 1, field: "narrative" }),
  },
  {
    name: "set_row_text on a locked row is rejected",
    input: { sketch: lockedFixture, ops: [{ kind: "set_row_text", row_id: "row-3", time: "0:45" }], now: NOW },
    expectedError: opError(0, "locked_row", { row_index: 2 }),
  },
  {
    name: "unknown row id is rejected",
    input: { sketch: lockedFixture, ops: [{ kind: "set_row_text", row_id: "missing", narrative: "Gone." }], now: NOW },
    expectedError: opError(0, "row_not_found", { row_id: "missing" }),
  },
  {
    name: "set_screenshot and set_visual set and clear asset references",
    input: {
      sketch: unlockedFixture,
      ops: [
        { kind: "set_screenshot", row_id: "row-1", screenshot: "screenshots/first.png" },
        { kind: "set_screenshot", row_id: "row-2", screenshot: null },
        { kind: "set_visual", row_id: "row-1", visual: ".cutready/visuals/first.json" },
      ],
      now: NOW,
    },
    expected: edited(unlockedFixture, (s) => {
      s.rows[0].screenshot = "screenshots/first.png";
      s.rows[0].visual = ".cutready/visuals/first.json";
      s.rows[1].screenshot = null;
    }),
  },
  {
    name: "set_visual on a row with a locked screenshot is rejected",
    input: { sketch: screenshotLockFixture, ops: [{ kind: "set_visual", row_id: "row-1", visual: null }], now: NOW },
    expectedError: opError(0, "locked_cell", { row_index: 0, field: "screenshot" }),
  },
  {
    name: "insert_row with a null anchor inserts first, unlocked",
    input: { sketch: unlockedFixture, ops: [{ kind: "insert_row", after_row_id: null, row: { ...newRow(), locked: true, locks: allLocks() } }], now: NOW },
    expected: edited(unlockedFixture, (s) => {
      s.rows.unshift(newRow());
    }),
  },
  {
    name: "inserted row without an id gets one as in decode",
    input: { sketch: unlockedFixture, ops: [{ kind: "insert_row", after_row_id: "row-1", row: (({ id: _id, ...r }) => r)(newRow()) }], now: NOW },
    expected: edited(unlockedFixture, (s) => {
      s.rows.splice(1, 0, newRow({ id: "row-2-2" }));
    }),
  },
  {
    name: "insert_row after an unknown row is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "insert_row", after_row_id: "missing", row: newRow() }], now: NOW },
    expectedError: opError(0, "row_not_found", { row_id: "missing" }),
  },
  {
    name: "insert_row with a taken id is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "insert_row", after_row_id: "row-2", row: newRow({ id: "row-1" }) }], now: NOW },
    expectedError: opError(0, "duplicate_row_id", { row_index: 2, row_id: "row-1" }),
  },
  {
    name: "insert_row while a row is locked is rejected",
    input: { sketch: lockedFixture, ops: [{ kind: "insert_row", after_row_id: "row-3", row: newRow() }], now: NOW },
    expectedError: opError(0, "locked_row_count"),
  },
  {
    name: "delete_row removes the row with that id",
    input: { sketch: unlockedFixture, ops: [{ kind: "delete_row", row_id: "row-1" }], now: NOW },
    expected: edited(unlockedFixture, (s) => {
      s.rows.shift();
    }),
  },
  {
    name: "delete_row while a row is locked is rejected",
    input: { sketch: lockedFixture, ops: [{ kind: "delete_row", row_id: "row-1" }], now: NOW },
    expectedError: opError(0, "locked_row_count"),
  },
  {
    name: "reorder_rows around locked rows keeps locks in place",
    input: { sketch: lockedFixtureWithSpare, ops: [{ kind: "reorder_rows", row_ids: ["row-4", "row-2", "row-3", "row-1"] }], now: NOW },
    expected: edited(lockedFixtureWithSpare, (s) => {
      s.rows = [s.rows[3], s.rows[1], s.rows[2], s.rows[0]];
    }),
  },
  {
    name: "reorder_rows that misses a row is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "reorder_rows", row_ids: ["row-2", "missing"] }], now: NOW },
    expectedError: opError(0, "invalid_reorder"),
  },
  {
    name: "update_row replaces the row and keeps its lock state",
    input: {
      sketch: lockedFixture,
      ops: [{ kind: "update_row", row: { ...row({ id: "row-1", time: "0:12", duration_seconds: 12, narrative: "Rewritten.", demo_actions: "Click.", design_plan: "Plan." }), locked: true, newer_field: 1 } }],
      now: NOW,
    },
    expected: edited(lockedFixture, (s) => {
      s.rows[0] = { ...row({ id: "row-1", time: "0:12", duration_seconds: 12, narrative: "Rewritten.", demo_actions: "Click.", design_plan: "Plan." }), newer_field: 1 };
    }),
  },
  {
    name: "update_row on a locked row is rejected",
    input: { sketch: lockedFixture, ops: [{ kind: "update_row", row: { ...lockedFixture.rows[2], narrative: "Changed." } }], now: NOW },
    expectedError: opError(0, "locked_row", { row_index: 2 }),
  },
  {
    name: "replace_rows keeps lock state with each position",
    input: { sketch: unlockedFixture, ops: [{ kind: "replace_rows", rows: [newRow({ locked: true })] }], now: NOW },
    expected: edited(unlockedFixture, (s) => {
      s.rows = [newRow()];
    }),
  },
  {
    name: "set_lock locks a cell and a whole row",
    input: {
      sketch: unlockedFixture,
      ops: [
        { kind: "set_lock", row_id: "row-1", field: "narrative", locked: true },
        { kind: "set_lock", row_id: "row-2", locked: true },
      ],
      now: NOW,
    },
    expected: edited(unlockedFixture, (s) => {
      s.rows[0].locks.narrative = true;
      s.rows[1].locked = true;
      s.rows[1].locks = allLocks();
    }),
  },
  {
    name: "set_lock unlocks a locked sketch and everything in it",
    input: { sketch: lockedFixture, ops: [{ kind: "set_lock", locked: true }, { kind: "set_lock", locked: false }], now: NOW },
    expected: edited(lockedFixture, (s) => {
      for (const r of s.rows) {
        r.locked = false;
        r.locks = noLocks();
      }
    }),
  },
  {
    name: "a cell lock without a row is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "set_lock", field: "time", locked: true }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "content edits after locking the sketch in the same batch are rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "set_lock", locked: true }, { kind: "set_title", title: "Too late" }], now: NOW },
    expectedError: opError(1, "locked_document"),
  },
  {
    name: "a rejected op fails the whole batch",
    input: {
      sketch: lockedFixture,
      ops: [
        { kind: "set_title", title: "Not kept" },
        { kind: "set_row_text", row_id: "row-2", narrative: "Changed." },
      ],
      now: NOW,
    },
    expectedError: opError(1, "locked_cell", { row_index: 1, field: "narrative" }),
  },
  {
    name: "locked sketch rejects content edits",
    input: { sketch: { ...unlockedFixture, locked: true }, ops: [{ kind: "set_metadata", metadata: { fields: {} } }], now: NOW },
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "an op of an unknown kind is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "set_title", title: "Kept?" }, { kind: "set_mood", mood: "calm" }], now: NOW },
    expectedError: opError(1, "invalid_op"),
  },
  {
    name: "an earlier rejected op wins over a later malformed one",
    input: { sketch: { ...unlockedFixture, locked: true }, ops: [{ kind: "set_title", title: "Locked" }, { kind: "set_mood", mood: "calm" }], now: NOW },
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "an empty batch leaves the document unchanged",
    input: { sketch: unlockedFixture, ops: [], now: NOW },
    expected: unlockedFixture,
  },
  {
    name: "touch marks a locked sketch edited",
    input: { sketch: { ...unlockedFixture, locked: true }, ops: [{ kind: "touch" }], now: NOW },
    expected: edited({ ...unlockedFixture, locked: true }, () => {}),
  },
  {
    name: "replace_sketch ignores locks and keeps the given updated_at",
    input: { sketch: { ...unlockedFixture, locked: true }, ops: [{ kind: "replace_sketch", sketch: lockedFixture }], now: NOW },
    expected: lockedFixture,
  },
  {
    name: "an edit after a replacement sets updated_at",
    input: { sketch: unlockedFixture, ops: [{ kind: "replace_sketch", sketch: desktopSketch }, { kind: "set_title", title: "Replaced" }], now: NOW },
    expected: edited(desktopSketch, (s) => {
      s.title = "Replaced";
    }),
  },
  {
    name: "touch after a locked replacement still sets updated_at",
    input: { sketch: unlockedFixture, ops: [{ kind: "replace_sketch", sketch: lockedFixture }, { kind: "touch" }], now: NOW },
    expected: edited(lockedFixture, () => {}),
  },
  {
    name: "a storyboard op on a sketch is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "remove_storyboard_item", index: 0 }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "a note op on a sketch is rejected",
    input: { sketch: unlockedFixture, ops: [{ kind: "write_note", content: "# No" }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
];

// EditService.applyStoryboardOps. The storyboard keeps `description` as a
// string; item ops address items by position, as the desktop commands do.
const openStoryboard = storyboard([sketchRef("intro.sk"), section("Setup", ["flows/login.sk"])], {
  future_storyboard_field: { owner: "ios" },
});
const lockedStoryboard = { ...openStoryboard, locked: true };

const applyStoryboardOpsVectors = [
  {
    name: "set_title, set_description and set_metadata keep unknown fields",
    input: {
      storyboard: openStoryboard,
      ops: [
        { kind: "set_title", title: "Launch" },
        { kind: "set_description", description: "Partners first." },
        { kind: "set_metadata", metadata: { fields: { audience: "partners" } } },
      ],
      now: NOW,
    },
    expected: edited(openStoryboard, (s) => {
      s.title = "Launch";
      s.description = "Partners first.";
      s.metadata = { fields: { audience: "partners" } };
    }),
  },
  {
    name: "set_description null clears the description",
    input: { storyboard: { ...openStoryboard, description: "Old." }, ops: [{ kind: "set_description", description: null }], now: NOW },
    expected: edited(openStoryboard, () => {}),
  },
  {
    name: "a non-string description is rejected",
    input: { storyboard: openStoryboard, ops: [{ kind: "set_description", description: { root: {} } }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "insert_storyboard_item inserts at an index and appends past the end",
    input: {
      storyboard: openStoryboard,
      ops: [
        { kind: "insert_storyboard_item", index: 0, item: sketchRef("cold-open.sk") },
        { kind: "insert_storyboard_item", index: null, item: section("Wrap-up", [], { description: "Close." }) },
        { kind: "insert_storyboard_item", index: 99, item: sketchRef("outro.sk") },
      ],
      now: NOW,
    },
    expected: edited(openStoryboard, (s) => {
      s.items = [sketchRef("cold-open.sk"), ...s.items, section("Wrap-up", [], { description: "Close." }), sketchRef("outro.sk")];
    }),
  },
  {
    name: "remove_storyboard_item removes the item at an index",
    input: { storyboard: openStoryboard, ops: [{ kind: "remove_storyboard_item", index: 0 }], now: NOW },
    expected: edited(openStoryboard, (s) => {
      s.items.shift();
    }),
  },
  {
    name: "remove_storyboard_item past the end is rejected",
    input: { storyboard: openStoryboard, ops: [{ kind: "remove_storyboard_item", index: 2 }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "set_storyboard_items replaces the items",
    input: { storyboard: openStoryboard, ops: [{ kind: "set_storyboard_items", items: [openStoryboard.items[1], openStoryboard.items[0]] }], now: NOW },
    expected: edited(openStoryboard, (s) => {
      s.items = [s.items[1], s.items[0]];
    }),
  },
  {
    name: "a locked storyboard rejects content edits",
    input: { storyboard: lockedStoryboard, ops: [{ kind: "insert_storyboard_item", index: null, item: sketchRef("x.sk") }], now: NOW },
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "touch follows the storyboard lock",
    input: { storyboard: lockedStoryboard, ops: [{ kind: "touch" }], now: NOW },
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "touch marks an open storyboard edited",
    input: { storyboard: openStoryboard, ops: [{ kind: "touch" }], now: NOW },
    expected: edited(openStoryboard, () => {}),
  },
  {
    name: "set_lock unlocks a locked storyboard for later ops",
    input: { storyboard: lockedStoryboard, ops: [{ kind: "set_lock", locked: false }, { kind: "set_title", title: "Open" }], now: NOW },
    expected: edited(openStoryboard, (s) => {
      s.title = "Open";
    }),
  },
  {
    name: "a storyboard has no rows to lock",
    input: { storyboard: openStoryboard, ops: [{ kind: "set_lock", row_id: "row-1", locked: true }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "a row op on a storyboard is rejected",
    input: { storyboard: openStoryboard, ops: [{ kind: "delete_row", row_id: "row-1" }], now: NOW },
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "replace_storyboard ignores locks and keeps the given updated_at",
    input: { storyboard: lockedStoryboard, ops: [{ kind: "replace_storyboard", storyboard: desktopStoryboard }], now: NOW },
    expected: desktopStoryboard,
  },
  {
    name: "touch after an open replacement sets updated_at",
    input: { storyboard: lockedStoryboard, ops: [{ kind: "replace_storyboard", storyboard: openStoryboard }, { kind: "touch" }], now: NOW },
    expected: edited(openStoryboard, () => {}),
  },
  {
    name: "touch after a locked replacement is rejected",
    input: { storyboard: openStoryboard, ops: [{ kind: "replace_storyboard", storyboard: lockedStoryboard }, { kind: "touch" }], now: NOW },
    expectedError: opError(1, "locked_document"),
  },
  {
    name: "an empty batch leaves the storyboard unchanged",
    input: { storyboard: lockedStoryboard, ops: [], now: NOW },
    expected: lockedStoryboard,
  },
];

const documentVersion = (name, content) => ({
  name,
  input: { content },
  expected: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
});

const documentVersionVectors = [
  documentVersion("empty document", ""),
  documentVersion("ascii", '{"title":"Intro"}\n'),
  documentVersion("utf-8 bytes, not code units", "Caf\u00e9 \u{1f3ac}\r\n"),
];

const sha = (content) => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

// EditService.editDocument. Sketch and storyboard bytes depend on serde's
// exact output, so content-changing writes for them are pinned by the
// golden-seeded cases below; these pin the version gate, creates, the no-op
// path and notes, whose bytes are the content itself.
const onDisk = JSON.stringify(unlockedFixture);
const lockedOnDisk = JSON.stringify({ ...unlockedFixture, locked: true });
const boardOnDisk = JSON.stringify(lockedStoryboard);
const noteOnDisk = "# Plan\n\nShip it.\n";
const editDocument = (kind, content, expected_version, ops, note_locked = false) => ({
  request: { kind, content, expected_version, ops, now: NOW, note_locked },
});
const noteEdit = (content, note_locked = false, note_lock_changed = false) => ({
  content,
  version: sha(content),
  note_locked,
  note_lock_changed,
});
const editDocumentVectors = [
  {
    name: "an empty batch returns the file unchanged",
    input: editDocument("sketch", onDisk, sha(onDisk), []),
    expected: { content: onDisk, version: sha(onDisk) },
  },
  {
    name: "a stale version reports the current one before any op runs",
    input: editDocument("sketch", onDisk, sha("{}"), [{ kind: "set_mood" }]),
    expectedError: cmdError("stale_document", { current_version: sha(onDisk) }),
  },
  {
    name: "a current version still enforces the edit policy",
    input: editDocument("sketch", lockedOnDisk, sha(lockedOnDisk), [{ kind: "set_title", title: "No" }]),
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "a storyboard follows the storyboard policy",
    input: editDocument("storyboard", boardOnDisk, sha(boardOnDisk), [{ kind: "touch" }]),
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "an op for another kind is rejected",
    input: editDocument("storyboard", boardOnDisk, sha(boardOnDisk), [{ kind: "replace_sketch", sketch: unlockedFixture }]),
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "expecting no file when one exists is stale",
    input: editDocument("note", noteOnDisk, null, [{ kind: "replace_note", content: "# New" }]),
    expectedError: cmdError("stale_document", { current_version: sha(noteOnDisk) }),
  },
  {
    name: "expecting a file that is gone is stale",
    input: editDocument("note", null, sha(noteOnDisk), [{ kind: "write_note", content: "# New" }]),
    expectedError: cmdError("stale_document"),
  },
  {
    name: "a missing file must start with its replacement",
    input: editDocument("note", null, null, [{ kind: "write_note", content: "# New" }]),
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "a missing note is created by replace_note",
    input: editDocument("note", null, null, [{ kind: "replace_note", content: "" }]),
    expected: noteEdit(""),
  },
  {
    name: "write_note replaces an open note's content",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "write_note", content: "# Plan\n\nShip it today.\n" }]),
    expected: noteEdit("# Plan\n\nShip it today.\n"),
  },
  {
    name: "write_note on a locked note is rejected",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "write_note", content: "# No" }], true),
    expectedError: opError(0, "locked_document"),
  },
  {
    name: "replace_note ignores the note's lock",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "replace_note", content: "# Imported" }], true),
    expected: noteEdit("# Imported", true),
  },
  {
    name: "set_lock changes the note's lock and leaves its content",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "set_lock", locked: true }]),
    expected: noteEdit(noteOnDisk, true, true),
  },
  {
    name: "setting a note's lock to its current state changes nothing",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "set_lock", locked: true }], true),
    expected: noteEdit(noteOnDisk, true),
  },
  {
    name: "an empty batch on a locked note reports its lock",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [], true),
    expected: noteEdit(noteOnDisk, true),
  },
  {
    name: "a lock toggled back to where it was hasn't changed",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "set_lock", locked: true }, { kind: "set_lock", locked: false }]),
    expected: noteEdit(noteOnDisk),
  },
  {
    name: "a note batch can't both lock and edit content",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "set_lock", locked: false }, { kind: "write_note", content: "# Both" }], true),
    expectedError: opError(1, "invalid_op"),
  },
  {
    name: "a note has no rows to lock",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "set_lock", row_id: "row-1", locked: true }]),
    expectedError: opError(0, "invalid_op"),
  },
  {
    name: "a note can't be touched",
    input: editDocument("note", noteOnDisk, sha(noteOnDisk), [{ kind: "touch" }]),
    expectedError: opError(0, "invalid_op"),
  },
];

// EditService.undoDocument. As with editDocument, merged sketch and
// storyboard bytes are pinned by cutready-core unit tests; these pin the exact
// fast path, creates and deletes, notes, conflicts and the lock guard.
// Conflict versions hash an entity's compact JSON with keys sorted.
const canonical = (value) =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}"
      : JSON.stringify(value);
const entityVersion = (value) => sha(canonical(value));
const rowContent = ({ locked: _l, locks: _k, ...rest }) => rest;
const undo = (kind, content, writes, note_locked = false) => ({
  request: { kind, content, writes, note_locked, now: NOW },
});
const write = (before, after) => ({ before, after });
const undone = (content) => ({ content, version: content === null ? null : sha(content) });
const sk = (doc) => JSON.stringify(doc);
const renamedRow = (doc, i, narrative) => edited(doc, (d) => { d.rows[i].narrative = narrative; });
const ranAfter = renamedRow(unlockedFixture, 0, "Run's words.");
const theirsAfter = renamedRow(ranAfter, 0, "Someone else's words.");
const lockedAfterRun = edited(ranAfter, (d) => { d.rows[0].locked = true; });
const threeRows = sketch([
  row({ id: "a", time: "0:10", narrative: "A.", demo_actions: "" }),
  row({ id: "b", time: "0:20", narrative: "B.", demo_actions: "" }),
  row({ id: "c", time: "0:30", narrative: "C.", demo_actions: "" }),
]);
const runOrder = edited(threeRows, (d) => { d.rows = [d.rows[2], d.rows[0], d.rows[1]]; });
const theirOrder = edited(threeRows, (d) => { d.rows = [d.rows[1], d.rows[2], d.rows[0]]; });
const renamedBoard = { ...openStoryboard, title: "Run's title", updated_at: NOW };
const lockedRenamedBoard = { ...renamedBoard, locked: true };
const undoDocumentVectors = [
  {
    name: "no writes leaves the file as it is",
    input: undo("sketch", sk(unlockedFixture), []),
    expected: undone(sk(unlockedFixture)),
  },
  {
    name: "untouched since the run, the result is the exact bytes the run started from",
    input: undo("sketch", sk(theirsAfter), [write(JSON.stringify(unlockedFixture, null, 1), sk(ranAfter)), write(sk(ranAfter), sk(theirsAfter))]),
    expected: undone(JSON.stringify(unlockedFixture, null, 1)),
  },
  {
    name: "a document the run created is deleted",
    input: undo("note", noteOnDisk, [write(null, noteOnDisk)]),
    expected: undone(null),
  },
  {
    name: "a sketch the run created and locked is still deleted",
    input: undo("sketch", sk({ ...unlockedFixture, locked: true }), [write(null, sk(unlockedFixture)), write(sk(unlockedFixture), sk({ ...unlockedFixture, locked: true }))]),
    expected: undone(null),
  },
  {
    name: "a document the run deleted is restored",
    input: undo("note", null, [write(noteOnDisk, null)]),
    expected: undone(noteOnDisk),
  },
  {
    name: "a note already back at its before value is left alone",
    input: undo("note", noteOnDisk, [write(noteOnDisk, "# Run\n")]),
    expected: undone(noteOnDisk),
  },
  {
    name: "a note changed since the run conflicts as a whole",
    input: undo("note", "# Theirs\n", [write(noteOnDisk, "# Run\n")]),
    expectedError: cmdError("undo_conflict", {
      conflicts: [{ path: "", expected_version: sha("# Run\n"), current_version: sha("# Theirs\n") }],
    }),
  },
  {
    name: "a created note that changed since conflicts",
    input: undo("note", "# Theirs\n", [write(null, "# Run\n")]),
    expectedError: cmdError("undo_conflict", {
      conflicts: [{ path: "", expected_version: sha("# Run\n"), current_version: sha("# Theirs\n") }],
    }),
  },
  {
    name: "a locked note can't be undone",
    input: undo("note", "# Run\n", [write(noteOnDisk, "# Run\n")], true),
    expectedError: cmdError("locked_document"),
  },
  {
    name: "a row changed again since the run conflicts with both versions",
    input: undo("sketch", sk(theirsAfter), [write(sk(unlockedFixture), sk(ranAfter))]),
    expectedError: cmdError("undo_conflict", {
      conflicts: [{
        path: "/rows/row-1",
        expected_version: entityVersion(rowContent(ranAfter.rows[0])),
        current_version: entityVersion(rowContent(theirsAfter.rows[0])),
      }],
    }),
  },
  {
    name: "a row someone else locked since blocks restoring its content",
    input: undo("sketch", sk(lockedAfterRun), [write(sk(unlockedFixture), sk(ranAfter))]),
    expectedError: cmdError("locked_row", { row_index: 0 }),
  },
  {
    name: "rows reordered again since the run conflict on their order",
    input: undo("sketch", sk(theirOrder), [write(sk(threeRows), sk(runOrder))]),
    expectedError: cmdError("undo_conflict", {
      conflicts: [{ path: "/rows", expected_version: entityVersion(["c", "a", "b"]), current_version: entityVersion(["b", "c", "a"]) }],
    }),
  },
  {
    name: "a reorder already reverted is left alone",
    input: undo("sketch", sk(threeRows), [write(sk(threeRows), sk(runOrder))]),
    expected: undone(sk(threeRows)),
  },
  {
    name: "a storyboard someone else locked since can't change",
    input: undo("storyboard", sk(lockedRenamedBoard), [write(sk(openStoryboard), sk(renamedBoard))]),
    expectedError: cmdError("locked_document"),
  },
  {
    name: "a top-level field changed again since the run conflicts",
    input: undo("storyboard", sk({ ...renamedBoard, title: "Theirs" }), [write(sk(openStoryboard), sk(renamedBoard))]),
    expectedError: cmdError("undo_conflict", {
      conflicts: [{ path: "/title", expected_version: entityVersion("Run's title"), current_version: entityVersion("Theirs") }],
    }),
  },
  {
    name: "a document gone since the run conflicts",
    input: undo("sketch", null, [write(sk(unlockedFixture), sk(ranAfter))]),
    expectedError: cmdError("undo_conflict", { conflicts: [{ path: "", expected_version: sha(sk(ranAfter)) }] }),
  },
];

// Golden-seeded EditService vectors. The 4.3 golden files
// (crates/cutready-core/tests/golden) pin the bytes every desktop edit writes;
// src-tauri/src/engine/document_goldens.rs applies each edit. Each case below
// replays the same edit as EditService ops on the golden input:
// - editDocument: the input bytes plus the ops give the expected file's exact
//   bytes and their version;
// - undoDocument: undoing that write on the expected bytes gives back the input;
// - applySketchOps / applyStoryboardOps: the parsed input plus the ops give the
//   parsed expected document. Typra re-serializes vectors through JSON, which
//   can't tell `1.0` from `1`, so documents holding an integral float (the
//   `scale: 1.0` keyframe in sketch.sk) are pinned by editDocument bytes only;
// - documentVersion: the version of every golden document used here. The
//   version is SHA-256 over the file's bytes (`edit_ops::document_version`), the
//   same `sha` the hand-written vectors use, so no core logic is copied.
//
// Golden cases left out, because they aren't one EditService call on one
// existing document:
// - sketch_create, storyboard_create: create a new file from `Sketch::new` /
//   `Storyboard::new` defaults, not an edit;
// - sketch_read_migrates_inline_visual, storyboard_read_upgrades_legacy: read
//   migrations (the first also writes a visual file); `StoryboardDocument.upgrade`
//   covers the second shape;
// - sketch_save_roundtrip: no op, and sketch.sk holds an integral float (see above);
//   `editDocument` returns an empty batch's bytes unchanged, so it can't pin it;
// - note_save, note_lock, note_unlock: note save and the `.cutready/locks.json`
//   lock store, which hosts keep outside the document;
// - storyboard_lock_cascades_to_sketches: locks the storyboard and every sketch
//   it references, across files;
// - agent_*: agent tool writes stamped with the wall clock (masked in the goldens).
const goldenDir = path.join(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
  "crates/cutready-core/tests/golden",
);
const goldenText = (rel) => readFileSync(path.join(goldenDir, rel), "utf8");
const GOLDEN_NOW = "2026-01-02T03:04:05Z";
const goldenSketch = JSON.parse(goldenText("inputs/sketch.sk"));
const goldenRowIds = goldenSketch.rows.map((_, i) => `row-${i + 1}`);
const integralFloat = /:\s*-?\d+\.0+(?:[eE][+-]?\d+)?\s*[,}\]\n]/;

const goldenCases = [
  { name: "sketch_update_title", input: "sketch.sk", ops: [{ kind: "set_title", title: "Intro — revised" }] },
  { name: "sketch_update_description", input: "sketch.sk", ops: [{ kind: "set_description", description: { type: "doc", content: [] } }] },
  { name: "sketch_update_metadata", input: "sketch.sk", ops: [{ kind: "set_metadata", metadata: { fields: { audience: "customers" } } }] },
  {
    name: "sketch_update_rows",
    input: "sketch.sk",
    // The editor sends every row without lock state; positions keep their locks.
    ops: [{
      kind: "replace_rows",
      rows: goldenSketch.rows.map((r, i) => {
        const next = { ...clone(r), id: goldenRowIds[i], locked: false, locks: noLocks() };
        if (i === 0) next.narrative = "Welcome back to **Contoso**.";
        if (i === 1) next.demo_actions = "Click the **Orders** tab";
        return next;
      }),
    }],
  },
  {
    name: "sketch_update_row_text",
    input: "sketch.sk",
    ops: [
      { kind: "set_row_text", row_id: "row-1", time: "1:05", narrative: "Welcome, partners." },
      // An unchanged time keeps the row's duration.
      { kind: "set_row_text", row_id: "row-2", time: "~30s", demo_actions: "Click **Orders** twice" },
    ],
  },
  {
    name: "sketch_reorder_rows",
    input: "sketch.sk",
    ops: [{ kind: "set_lock", locked: false }, { kind: "reorder_rows", row_ids: ["row-3", "row-1", "row-2"] }],
  },
  { name: "sketch_lock", input: "sketch.sk", ops: [{ kind: "set_lock", locked: true }] },
  { name: "sketch_unlock", input: "sketch.sk", ops: [{ kind: "set_lock", locked: false }] },
  {
    name: "sketch_row_lock",
    input: "sketch.sk",
    ops: [{ kind: "set_lock", row_id: "row-1", locked: true }, { kind: "set_lock", row_id: "row-3", locked: false }],
  },
  {
    name: "sketch_cell_lock",
    input: "sketch.sk",
    ops: [
      { kind: "set_lock", row_id: "row-1", field: "demo_actions", locked: true },
      { kind: "set_lock", row_id: "row-2", field: "narrative", locked: false },
    ],
  },
  { name: "sketch_save_nulls_roundtrip", input: "sketch-nulls.sk", ops: [] },
  {
    name: "storyboard_update",
    input: "storyboard.sb",
    ops: [
      { kind: "set_title", title: "Contoso demo — final" },
      { kind: "set_description", description: "Customer walkthrough" },
      { kind: "set_metadata", metadata: { fields: {} } },
    ],
  },
  { name: "storyboard_add_sketch_at_position", input: "storyboard.sb", ops: [{ kind: "insert_storyboard_item", index: 1, item: sketchRef("setup.sk") }] },
  { name: "storyboard_add_sketch_append", input: "storyboard.sb", ops: [{ kind: "insert_storyboard_item", index: null, item: sketchRef("appendix.sk") }] },
  { name: "storyboard_remove_sketch", input: "storyboard.sb", ops: [{ kind: "remove_storyboard_item", index: 0 }] },
  {
    name: "storyboard_add_section",
    input: "storyboard.sb",
    ops: [
      { kind: "insert_storyboard_item", index: 0, item: section("Opening", [], { description: "" }) },
      { kind: "insert_storyboard_item", index: null, item: section("Appendix", [], { description: "Extra material" }) },
    ],
  },
  {
    name: "storyboard_reorder_items",
    input: "storyboard.sb",
    ops: [{ kind: "set_storyboard_items", items: JSON.parse(goldenText("inputs/storyboard.sb")).items.reverse() }],
  },
  { name: "storyboard_save_roundtrip", input: "storyboard.sb", ops: [] },
].map((c) => {
  const kind = c.input.endsWith(".sb") ? "storyboard" : "sketch";
  const inputPath = `inputs/${c.input}`;
  const expectedPath = `expected/${c.name}/${kind === "sketch" ? "intro.sk" : "demo.sb"}`;
  return { ...c, kind, inputPath, expectedPath, before: goldenText(inputPath), after: goldenText(expectedPath) };
});

for (const c of goldenCases) {
  const vectorName = `golden_${c.name}`;
  if (!integralFloat.test(c.before) && !integralFloat.test(c.after)) {
    const vectors = c.kind === "sketch" ? applySketchOpsVectors : applyStoryboardOpsVectors;
    vectors.push({
      name: vectorName,
      input: { [c.kind]: JSON.parse(c.before), ops: c.ops, now: GOLDEN_NOW },
      expected: JSON.parse(c.after),
    });
  }
  // An empty batch returns the bytes on disk, so only real edits pin bytes.
  if (c.ops.length === 0) continue;
  editDocumentVectors.push({
    name: vectorName,
    input: { request: { kind: c.kind, content: c.before, expected_version: sha(c.before), ops: c.ops, now: GOLDEN_NOW, note_locked: false } },
    expected: { content: c.after, version: sha(c.after) },
  });
  undoDocumentVectors.push({
    name: `${vectorName}_undo`,
    input: undo(c.kind, c.after, [write(c.before, c.after)]),
    expected: undone(c.before),
  });
}

for (const rel of [...new Set(goldenCases.flatMap((c) => [c.inputPath, c.expectedPath]))].sort()) {
  documentVersionVectors.push({ name: `golden_${rel}`, input: { content: goldenText(rel) }, expected: sha(goldenText(rel)) });
}

const tspConst = (name, vectors) =>
  `const ${name} = """\n${JSON.stringify(vectors, null, 2).replaceAll("\\", "\\\\")}\n""";\n`;

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
    tspConst("ApplySketchOpsVectors", applySketchOpsVectors),
    tspConst("DocumentVersionVectors", documentVersionVectors),
    tspConst("ApplyStoryboardOpsVectors", applyStoryboardOpsVectors),
    tspConst("EditDocumentVectors", editDocumentVectors),
    tspConst("UndoDocumentVectors", undoDocumentVectors),
    tspConst("StoryboardRoundTripVectors", storyboardRoundTripVectors),
    tspConst("StoryboardUpgradeVectors", storyboardUpgradeVectors),
    tspConst("ChatArtifactRoundTripVectors", chatArtifactRoundTripVectors),
    tspConst("ChatArtifactPromoteVectors", chatArtifactPromoteVectors),
  ].join("\n"),
);
