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
