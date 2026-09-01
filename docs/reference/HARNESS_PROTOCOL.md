# CutReady — Out-of-Process Harness Protocol

> _Follow-on design for distributing agent harnesses beyond the compiled app. Documented per issue #251 acceptance criterion 5. No implementation is required in the crate-split PR — this is the forward-looking design the split unlocks._

---

## Where this fits

CutReady drives an agent through the `AgentHarness` seam (issue #248): a single
trait, `run(req) -> result`, with a stable host vocabulary that lives in the
`harness-contract` crate. Issue #251 moved each first-party adapter
(`harness-prompty`, `harness-agentive`, `harness-copilot-sdk`) into its own
workspace crate that depends only on `harness-contract`, never on the app crate,
and feature-gated the two genuinely optional adapters in `src-tauri`.

That crate boundary is the enabler for this document. Once a harness adapter
depends only on a published contract, the transport it uses internally — inline
Rust, a bundled sidecar, or an external process — is an implementation detail
hidden behind the trait. This doc describes the **out-of-process** shape: a
harness added _without recompiling CutReady_, possibly authored by a third party
or in another language.

- Builds on #248 (the `AgentHarness` seam).
- Rides on #251 (the `harness-contract` crate + Cargo workspace).
- Sibling to #249 (the ownership contract governs _provisioning_ per concern;
  this governs _packaging and transport_). They compose.
- Feeds #250 — the capability-provider epic reuses the same contract-crate +
  sidecar pattern for TTS / STT / Vision providers.

## Why a protocol at all

Tauri v2 has no runtime Rust plugin loading
([tauri#8090](https://github.com/tauri-apps/tauri/issues/8090)), and
`abi_stable` native dynamic loading is a rejected non-goal (heavy, unsafe ABI
surface). The portable way to load code CutReady did not compile is the way it
already runs FFmpeg and the Playwright Node sidecar: **a separate process
speaking a defined protocol over stdio.**

## Three deployment shapes

"Sidecar vs in-app" is a false binary — a sidecar is itself a compiled binary,
just bundled as a separate process. There are three shapes:

| Shape | Compiled into CutReady | Where the work runs | Add without rebuilding? |
| --- | --- | --- | --- |
| **1. In-process crate** | the whole adapter (pure Rust, or a direct HTTP-API client) | inside the app process | No — rebuild |
| **2. First-party proxy crate + bundled sidecar** | a thin proxy crate; the sidecar binary ships as a Tauri resource | separate process (e.g. Copilot CLI, a Node/Python worker) | No — rebuild (heavy logic isolated in the sidecar) |
| **3. Generic protocol proxy + external sidecar** | one _generic_ proxy that speaks the wire protocol to **any** conforming sidecar | separate process, supplied externally | Yes — discovered at runtime via a manifest |

Key points:

- **The contract does not care.** `run(req) -> result` looks identical whether
  the impl runs Rust inline or marshals the call over stdio. That is the entire
  point of the seam.
- **Shapes 1 and 2 give per-crate transport freedom** but still require a
  rebuild to add a provider. **Only shape 3 buys runtime pluggability**, because
  it needs a _generic_ proxy plus runtime discovery rather than a bespoke crate
  per provider.
- **`harness-copilot-sdk` is already a shape-2 example today** — a thin adapter
  driving the GitHub Copilot CLI over its JSON-RPC interface. Promoting that CLI
  contract to a documented, versioned wire protocol is exactly what turns
  shape 2 into shape 3.

## The wire protocol (shape 3)

The generic proxy is a host-side `AgentHarness` implementation that spawns a
sidecar and marshals the contract over stdio. The sidecar is any executable that
speaks the protocol; it can be written in any language.

### Transport

- **Framing:** newline-delimited JSON (JSON-RPC 2.0 style) over the sidecar's
  stdin/stdout. `stderr` is reserved for human-readable diagnostics and is
  surfaced in traces, never parsed. This matches the existing FFmpeg and
  Playwright sidecar conventions and needs no extra runtime.
- **On Windows**, the proxy spawns the sidecar with `CREATE_NO_WINDOW`
  (`creation_flags(0x08000000)`), consistent with every other CutReady
  subprocess spawn.
- gRPC or an MCP-style transport are compatible alternatives, but stdio JSON-RPC
  is the baseline because it has zero deployment weight.

### Messages

The protocol mirrors the `AgentHarness` contract one-to-one:

- **`describe`** (host → sidecar, at startup): the sidecar returns its
  `HarnessCapabilities` and `HarnessContract` (see #249) so the host can render
  the settings picker and honor the ownership stances without hardcoding them.
- **`run`** (host → sidecar): carries the `AgentRunRequest` — messages, the
  host-supplied provider/tool/persona contributions the contract says the
  harness `Requires` or `Augments`, and a run id.
- **`event`** (sidecar → host, streamed): each frame maps to one `AgentEvent`
  (token deltas, tool-call requests, tool results, lifecycle transitions). The
  frontend `AgentEvent` shape is the wire contract for these frames.
- **`tool_call` / `tool_result`** (bidirectional): when a harness `Requires`
  host tools, the sidecar emits a `tool_call` and the host executes it under its
  own path-confined tool policy, then returns a `tool_result`. The sidecar never
  touches the filesystem directly for host-owned tools.
- **`steer`** (host → sidecar): mid-run steering input, for harnesses whose
  capabilities advertise `steering`.
- **`cancel`** (host → sidecar): cooperative cancellation for a run id.
- **`result`** (sidecar → host): the terminal `AgentRunResult` for a run id.

### Lifecycle

1. Host reads the sidecar **manifest** (see discovery) and spawns the process.
2. Host sends `describe`; sidecar returns capabilities + contract.
3. Per run: host sends `run`; sidecar streams `event` frames and any
   `tool_call`s; host answers with `tool_result`s; sidecar ends with `result`.
4. Host may `steer` or `cancel` an in-flight run id.
5. On shutdown the host closes stdin; the sidecar drains and exits. The host
   reaps the process tree.

### Discovery (shape 3 only)

An external harness is registered by a small **manifest** (e.g. a JSON file in a
CutReady config directory) naming the sidecar executable, its protocol version,
and a stable harness id. At startup the generic proxy enumerates manifests and
lists each conforming sidecar in the harness picker alongside the compiled-in
adapters. No manifest ⇒ no external harness; the compiled default set is
unchanged.

## Host invariants the protocol can never opt out of

Regardless of transport, these stay enforced on the CutReady side of the seam:

- **Path confinement / project-file safety** — host-owned tool execution runs
  through the app's path-confined executor; a sidecar only ever receives
  `cwd = project_root`, never a broader root.
- **`AgentEvent` shape** — the DTO the frontend consumes is the stable contract
  for `event` frames.
- **Persistence policy** — what a "project" is and what may be written where is
  a host decision; sidecars do not persist into the project folder on their own.
- **Consent and provisioning** — the ownership contract (#249) still decides
  which concerns the host supplies; the protocol only carries what the contract
  already permits.

## Versioning — the passport

- Publish `harness-contract` (and a versioned wire-protocol crate) so an external
  author depends only on the published interface, never on the app.
- The `describe` handshake carries a protocol version; the host refuses a sidecar
  whose major version it does not support rather than mis-marshaling frames.
- The monorepo stays home for first-party adapters (shapes 1–2). The published
  contract crate is the passport for anyone external (shape 3).

## Decision order

1. Extract `harness-contract` as a standalone crate inside a workspace. _(done, #251)_
2. Monorepo for first-party harness crates, compiled and feature-gated. _(done, #251)_
3. Publish the contract + wire protocol when true external / out-of-process
   plugins are wanted. _(this design; no implementation yet)_

Repo topology is not what buys independence; the standalone contract crate is.
Step 3 is deferred until a concrete external-harness need lands.

## Non-goals

- Runtime Rust DLL plugins via Tauri (unsupported).
- `abi_stable` native dynamic loading (rejected — unsafe ABI surface, heavy).
- Moving upstream SDK repos (`agentive`, the Copilot SDK) into the monorepo —
  they stay independent; only the CutReady _adapter_ lives in `crates/harness-*`.
