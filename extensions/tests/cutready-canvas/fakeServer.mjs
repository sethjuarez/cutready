// A stand-in `cutready-cli mcp` for failure modes the real binary can't be
// made to produce. Usage: node fakeServer.mjs <mode>
//   wrong-version  answers initialize declaring contract 99
//   no-version     answers initialize without a contract version
//   refuse         answers initialize with the -32001 contract mismatch error
//   silent         never answers
//   garbage        writes a non-JSON line
//   die-on-call    handshakes, then exits on the first tools/call
//   huge           answers tools/call with a 4 KB line
//   huge-partial   answers tools/call with 4 KB and no newline
import { createInterface } from "node:readline";

const mode = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (!("id" in message)) return;
    if (mode === "silent") return;
    if (mode === "garbage") {
        process.stdout.write("not json\n");
        return;
    }
    if (message.method === "initialize") {
        if (mode === "refuse") {
            send({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32001, message: "edit contract 99", data: { server: 99, client: 1 } },
            });
            process.exit(0);
        }
        const cutready = mode === "no-version" ? {} : { contractVersion: mode === "wrong-version" ? 99 : 1 };
        send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {}, experimental: { cutready } },
                serverInfo: { name: "fake", version: "0" },
            },
        });
        return;
    }
    if (mode === "die-on-call" && message.method === "tools/call") process.exit(3);
    if (mode === "huge" && message.method === "tools/call") {
        send({ jsonrpc: "2.0", id: message.id, result: { pad: "x".repeat(4096) } });
        return;
    }
    if (mode === "huge-partial" && message.method === "tools/call") {
        process.stdout.write("x".repeat(4096));
        return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: {} });
});
