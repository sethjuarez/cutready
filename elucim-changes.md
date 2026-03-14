# Elucim Changes for CutReady Integration

This document captures changes needed in the **elucim** library (`@elucim/core` and `@elucim/dsl`) to make CutReady's framing visual integration work well end-to-end.

---

## 1. Static Frame Capture (`captureFrame`)

**Priority: High — blocks Word export**

CutReady exports sketches to `.docx` via the `docx` library. Word can't play animations, so we need to embed a static image of the visual's **last frame** (the fully-revealed state after all animations complete).

### What's needed

Add a `captureFrame(svgElement, frame, options)` utility to `@elucim/core/export`:

```typescript
export interface CaptureFrameOptions {
  width?: number;    // default: SVG viewBox width
  height?: number;   // default: SVG viewBox height
  format?: 'png' | 'jpeg';  // default: 'png'
  quality?: number;  // JPEG quality 0-1 (default: 0.92)
  scale?: number;    // device pixel ratio (default: 2 for retina)
}

export async function captureFrame(
  svgElement: SVGSVGElement,
  frame: number,
  options?: CaptureFrameOptions
): Promise<Blob>;
```

### Implementation approach

The existing `svgToCanvas()` in `@elucim/core/export` already converts SVG → Canvas. The new function would:

1. Call the `renderFrame(frame)` callback to advance the Scene/Player to the target frame
2. Call `svgToCanvas(svg, width, height)` to rasterize
3. Call `canvas.toBlob(format, quality)` to produce the image

### Usage in CutReady

```typescript
// In exportToWord.ts — for rows with a visual
const blob = await captureFrame(svgRef.current, lastFrame, {
  width: 640, height: 360, format: 'png', scale: 2
});
const buffer = await blob.arrayBuffer();
const image = new ImageRun({ data: new Uint8Array(buffer), ... });
```

---

## 2. Headless / Offscreen Rendering

**Priority: High — needed for frame capture without mounting to DOM**

Currently `DslRenderer` must be mounted in the React tree to render. For Word export, CutReady needs to render a visual offscreen (not visible to the user) just to capture a frame.

### What's needed

A headless render utility that takes an `ElucimDocument` and produces an SVG string or element without React mounting:

```typescript
export function renderToSvgString(
  dsl: ElucimDocument,
  frame: number,
  options?: { width?: number; height?: number }
): string;
```

### Alternative: React portal approach

If headless rendering is too complex, CutReady can:
1. Mount a hidden `<DslRenderer>` in a portal (off-screen div)
2. Wait for render
3. Grab the SVG element ref
4. Call `captureFrame()`
5. Unmount

This is workable but more fragile. A headless API would be cleaner.

---

## 3. `useImperativeHandle` / Ref API on DslRenderer

**Priority: Medium — enables programmatic control**

Currently `DslRenderer` renders autonomously. CutReady would benefit from imperative control:

```typescript
export interface DslRendererRef {
  /** Get the underlying SVG element */
  getSvgElement(): SVGSVGElement | null;
  /** Seek to a specific frame */
  seekToFrame(frame: number): void;
  /** Get total duration in frames */
  getTotalFrames(): number;
  /** Play/pause */
  play(): void;
  pause(): void;
  /** Check if currently playing */
  isPlaying(): boolean;
}
```

### Usage

```tsx
const ref = useRef<DslRendererRef>(null);

// Seek to last frame for Word export thumbnail
ref.current?.seekToFrame(ref.current.getTotalFrames() - 1);

// Grab SVG for capture
const svg = ref.current?.getSvgElement();
```

---

## 4. Thumbnail / Poster Mode

**Priority: Medium — improves table cell rendering**

In CutReady's planning table, visuals appear as tiny thumbnails (160×96px). At that size, animations don't make sense — we just want a static "poster" frame.

### What's needed

A `poster` prop on `DslRenderer`:

```tsx
<DslRenderer
  dsl={doc}
  poster="last"           // "first" | "last" | number (frame index)
  style={{ width: 160, height: 96 }}
/>
```

When `poster` is set:
- Render the scene at the specified frame
- Don't start the animation loop
- Don't show any controls
- Just render a static SVG snapshot

This would save CPU vs running 60fps animations in every table cell.

---

## 5. Compact Scene Dimensions

**Priority: Low — nice to have**

CutReady sketches are about demo planning — visuals tend to be simple diagrams, not full presentations. Consider adding a small scene preset:

```json
{
  "version": "1.0",
  "root": {
    "type": "scene",
    "preset": "card",    // 640×360 with sensible defaults
    "background": "#1a1a2e",
    "children": [...]
  }
}
```

Presets could include:
- `"card"` — 640×360 (16:9 small, good for thumbnails)
- `"slide"` — 1280×720 (presentation)
- `"square"` — 600×600 (social media)

---

## 6. Error Recovery in DslRenderer

**Priority: Low — defensive improvement**

`DslRenderer` currently calls `validate()` and shows errors for invalid DSL. But if an AI generates slightly malformed JSON, it would be nice to:

1. Show a meaningful error message (not just "Invalid DSL")
2. Highlight the specific field/node that failed validation
3. Offer a "raw JSON" view so the user can debug

CutReady wraps `DslRenderer` in an `ErrorBoundary`, but better error reporting from elucim itself would help.

---

## 7. Theme / Color Token Support

**Priority: Low — future polish**

CutReady has light and dark modes. If elucim scenes could reference theme tokens instead of hardcoded colors, visuals would automatically adapt:

```json
{
  "type": "text",
  "text": "Hello",
  "fill": "var(--foreground)",       // theme-aware
  "fontSize": 32
}
```

Or a simpler `theme` prop on `DslRenderer`:

```tsx
<DslRenderer dsl={doc} theme={{ foreground: "#e0e0e0", background: "#1a1a2e", accent: "#4a9eff" }} />
```

---

## Summary — Priority Order

| # | Change | Priority | Blocks |
|---|--------|----------|--------|
| 1 | `captureFrame()` export util | 🔴 High | Word export of visuals |
| 2 | Headless / offscreen rendering | 🔴 High | Frame capture without React mount |
| 3 | `DslRendererRef` imperative API | 🟡 Medium | Programmatic seek/control |
| 4 | `poster` mode (static frame) | 🟡 Medium | Efficient table thumbnails |
| 5 | Compact scene presets | 🟢 Low | Convenience |
| 6 | Better error reporting | 🟢 Low | UX polish |
| 7 | Theme token support | 🟢 Low | Dark mode adaptation |
