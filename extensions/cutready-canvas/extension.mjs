// CutReady canvas for the GitHub Copilot app. Wiring only: the canvas lives in
// lib/ (MCP client, discovery, server, actions) and web/ (the panel UI).
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { cutreadyCanvas } from "./lib/canvas.mjs";

let session;
const canvas = cutreadyCanvas({
    toHostError: (error) => {
        const details = error.details === undefined ? "" : ` ${JSON.stringify(error.details)}`;
        return new CanvasError(error.code, `${error.message}${details}`);
    },
    log: (message) => session?.log(message, { level: "error" }),
});

session = await joinSession({ canvases: [createCanvas(canvas.options)] });

const shutdown = () => canvas.dispose().finally(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
