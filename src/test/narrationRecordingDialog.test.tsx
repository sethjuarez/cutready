import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../hooks/useProjectImage", () => ({
  useProjectImage: () => "",
}));

import { NarrationRecordingDialog } from "../components/NarrationRecordingDialog";

// ── Controllable Web API doubles ────────────────────────────────────────────
let lastRecorder: FakeMediaRecorder | null = null;

class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    lastRecorder = this;
  }
  start() {
    this.state = "recording";
    queueMicrotask(() => this.onstart?.());
  }
  stop() {
    this.state = "inactive";
    // Emit a chunk then stop, mirroring a real recorder.
    this.ondataavailable?.({ data: new Blob(["x"], { type: this.mimeType }) });
    this.onstop?.();
  }
  static isTypeSupported() {
    return true;
  }
}

class FakeAudioContext {
  state = "running";
  createAnalyser() {
    return { fftSize: 2048, getByteTimeDomainData: () => {} } as unknown as AnalyserNode;
  }
  createMediaStreamSource() {
    return { connect: () => {} } as unknown as MediaStreamAudioSourceNode;
  }
  decodeAudioData() {
    return Promise.resolve({
      sampleRate: 48000,
      numberOfChannels: 1,
      length: 4,
      getChannelData: () => new Float32Array([0.5, 0.5, 0.5, 0.5]),
    } as unknown as AudioBuffer);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

function fakeStream() {
  return {
    getAudioTracks: () => [{ readyState: "live" }],
    getTracks: () => [{ stop: () => {} }],
  } as unknown as MediaStream;
}

const baseProps = {
  rowNumber: 1,
  sourceText: "Hello there",
  audio: true,
  mimeType: "audio/webm",
  onCancel: () => {},
};

async function recordATake() {
  const startBtn = await screen.findByRole("button", { name: /start recording/i });
  await userEvent.click(startBtn);
  await waitFor(() => expect(lastRecorder).not.toBeNull());
  // Let the recorder.start() microtask fire onstart → status "recording".
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const stopBtn = await screen.findByRole("button", { name: /^stop$/i });
  await userEvent.click(stopBtn);
  await screen.findByRole("button", { name: /save take/i });
}

describe("NarrationRecordingDialog take retention (#271)", () => {
  beforeEach(() => {
    lastRecorder = null;
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:take";
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(fakeStream()) },
    });
    const makeCtx = (): unknown => new Proxy(function () {}, {
      get: () => makeCtx(),
      apply: () => makeCtx(),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      makeCtx() as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clears the take after a successful save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);

    await recordATake();
    await userEvent.click(screen.getByRole("button", { name: /save take/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // Take consumed: the save button now reads "Saved".
    await screen.findByRole("button", { name: /^saved$/i });
  });

  it("retains the take for retry when the save rejects", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk full"));
    render(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);

    await recordATake();
    await userEvent.click(screen.getByRole("button", { name: /save take/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // The unsaved take must survive: the "Save take" button is still offered and
    // the failure is surfaced in the dialog rather than silently discarding it.
    await screen.findByRole("button", { name: /save take/i });
    expect(screen.getByText(/could not analyze and save narration/i)).toBeTruthy();
  });

  it("keeps the take through a deferred (pending) save until it resolves", async () => {
    let resolveSave: () => void = () => {};
    const onSave = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveSave = r; }));
    render(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);

    await recordATake();
    await userEvent.click(screen.getByRole("button", { name: /save take/i }));

    // While the save is pending, the take is not yet cleared.
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /^saved$/i })).toBeNull();

    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: /^saved$/i });
  });
});

describe("NarrationRecordingDialog late acquisition disposal (#273)", () => {
  // Deferred getUserMedia: resolvers are queued so a test can unmount/close the
  // dialog before delivering the stream, reproducing a late acquisition.
  let pendingGum: Array<(stream: MediaStream) => void>;
  let audioContextsCreated: number;

  function makeTrackedStream() {
    const track = {
      readyState: "live" as MediaStreamTrackState,
      stop: vi.fn(function (this: { readyState: MediaStreamTrackState }) {
        this.readyState = "ended";
      }),
    };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    return { stream, track };
  }

  beforeEach(() => {
    lastRecorder = null;
    pendingGum = [];
    audioContextsCreated = 0;
    class CountingAudioContext extends FakeAudioContext {
      constructor() {
        super();
        audioContextsCreated += 1;
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", CountingAudioContext);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:take";
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => new Promise<MediaStream>((resolve) => pendingGum.push(resolve)),
      },
    });
    const makeCtx = (): unknown => new Proxy(function () {}, {
      get: () => makeCtx(),
      apply: () => makeCtx(),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      makeCtx() as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stops a microphone stream that resolves after the dialog unmounts", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);

    // The prewarm effect starts an acquisition that is still pending.
    await waitFor(() => expect(pendingGum.length).toBeGreaterThan(0));

    // Owner goes away before the stream is delivered.
    unmount();

    const { stream, track } = makeTrackedStream();
    await act(async () => {
      pendingGum[0](stream);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The late stream is released and no audio context is installed.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(audioContextsCreated).toBe(0);
  });

  it("is safe when acquisition resolves after repeated teardown", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount, rerender } = render(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);

    await waitFor(() => expect(pendingGum.length).toBeGreaterThan(0));

    // Multiple teardowns must not throw or double-handle the late stream.
    rerender(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);
    unmount();

    const { stream, track } = makeTrackedStream();
    await act(async () => {
      pendingGum[0](stream);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(audioContextsCreated).toBe(0);
  });
});

describe("NarrationRecordingDialog disposal during context.resume() (#273)", () => {
  // Acquisition succeeds (input ready), but the dialog is torn down while
  // startRecording is awaiting a suspended context's resume(), before the
  // recorder and its timers are built on the now-disposed resources.
  let resumeCalled: boolean;
  let resolveResume: () => void;

  function makeTrackedStream() {
    const track = { readyState: "live" as MediaStreamTrackState, stop: vi.fn() };
    return {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
  }

  beforeEach(() => {
    lastRecorder = null;
    resumeCalled = false;
    resolveResume = () => {};
    class SuspendedAudioContext extends FakeAudioContext {
      state = "suspended";
      resume() {
        resumeCalled = true;
        return new Promise<void>((resolve) => {
          resolveResume = () => {
            this.state = "running";
            resolve();
          };
        });
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:take";
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(makeTrackedStream()) },
    });
    const makeCtx = (): unknown => new Proxy(function () {}, {
      get: () => makeCtx(),
      apply: () => makeCtx(),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      makeCtx() as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not build a recorder when disposed during context.resume()", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<NarrationRecordingDialog {...baseProps} onSave={onSave} />);

    const startBtn = await screen.findByRole("button", { name: /start recording/i });
    await waitFor(() => expect(startBtn).toBeEnabled());
    await userEvent.click(startBtn);

    // The suspended context is now mid-resume; dispose before it settles.
    await waitFor(() => expect(resumeCalled).toBe(true));
    unmount();

    await act(async () => {
      resolveResume();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The recorder must never be constructed on the disposed resources.
    expect(lastRecorder).toBeNull();
  });
});

describe("NarrationRecordingDialog async onstop after disposal (#273)", () => {
  // A recorder whose stop() defers onstop, so a test can bump the acquisition
  // epoch (via close()/cleanupInput) before the async stop settles.
  class DeferredStopRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType: string;
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    constructor(_stream: unknown, opts?: { mimeType?: string }) {
      this.mimeType = opts?.mimeType ?? "audio/webm";
      deferredRecorder = this;
    }
    start() {
      this.state = "recording";
      queueMicrotask(() => this.onstart?.());
    }
    stop() {
      this.state = "inactive";
      // Emit a chunk synchronously (mirrors a real recorder flushing its buffer)
      // but withhold onstop until the test releases it.
      this.ondataavailable?.({ data: new Blob(["x"], { type: this.mimeType }) });
    }
    static isTypeSupported() {
      return true;
    }
  }

  let deferredRecorder: DeferredStopRecorder | null;
  let createUrlSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deferredRecorder = null;
    createUrlSpy = vi.fn(() => "blob:take");
    vi.stubGlobal("MediaRecorder", DeferredStopRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL =
      createUrlSpy as unknown as () => string;
    (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(fakeStream()) },
    });
    const makeCtx = (): unknown => new Proxy(function () {}, {
      get: () => makeCtx(),
      apply: () => makeCtx(),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      makeCtx() as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drops a late onstop without building an object URL after the dialog closes", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<NarrationRecordingDialog {...baseProps} onSave={onSave} onCancel={() => {}} />);

    const startBtn = await screen.findByRole("button", { name: /start recording/i });
    await waitFor(() => expect(startBtn).toBeEnabled());
    await userEvent.click(startBtn);

    // Drive the recorder to a live "recording" state.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await screen.findByRole("button", { name: /^stop$/i });
    await waitFor(() => expect(deferredRecorder).not.toBeNull());

    // Close the dialog: this stops the recorder (deferred onstop still pending)
    // and runs cleanupInput, which bumps the acquisition epoch.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
      await Promise.resolve();
    });
    unmount();

    // The real async onstop now fires against disposed resources.
    await act(async () => {
      deferredRecorder?.onstop?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No object URL is created and no post-disposal state update is attempted.
    expect(createUrlSpy).not.toHaveBeenCalled();
  });

  it("ignores a duplicate late onstop from a superseded recorder", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NarrationRecordingDialog {...baseProps} onSave={onSave} onCancel={() => {}} />);

    // Record take A and stop it (deferred onstop pending).
    const startBtn = await screen.findByRole("button", { name: /start recording/i });
    await waitFor(() => expect(startBtn).toBeEnabled());
    await userEvent.click(startBtn);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const recorderA = deferredRecorder;
    expect(recorderA).not.toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: /^stop$/i }));

    // A's onstop settles normally (epoch unchanged): builds A's take URL.
    await act(async () => {
      recorderA?.onstop?.();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: /save take/i });
    expect(createUrlSpy).toHaveBeenCalledTimes(1);

    // Start take B; a new recorder now owns the shared refs.
    await userEvent.click(await screen.findByRole("button", { name: /record again/i }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const recorderB = deferredRecorder;
    expect(recorderB).not.toBe(recorderA);
    await screen.findByRole("button", { name: /^stop$/i });

    // A stale duplicate onstop from the superseded recorder A must be a no-op:
    // it may not null recorder B's ref, consume its chunks, or build a URL.
    const urlCallsBefore = createUrlSpy.mock.calls.length;
    await act(async () => {
      recorderA?.onstop?.();
      await Promise.resolve();
    });
    expect(createUrlSpy.mock.calls.length).toBe(urlCallsBefore);

    // Recorder B is untouched: its own stop still completes and saves a take.
    await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    await act(async () => {
      recorderB?.onstop?.();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: /save take/i });
    expect(createUrlSpy.mock.calls.length).toBe(urlCallsBefore + 1);
  });
});

