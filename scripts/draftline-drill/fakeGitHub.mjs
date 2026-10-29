// A local stand-in for the GitHub pull request API. Debug builds of CutReady
// send Send-for-review requests here when CUTREADY_GITHUB_API_BASE is set, so
// drills exercise the full flow without touching github.com.
//
// The server runs in its own process: the drill drives the app with blocking
// calls, which would stall an in-process server mid-request.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

export const fakeGitHub = {
  child: null,
  base: null,

  async start() {
    this.child = spawn(process.execPath, [self], { stdio: ["ignore", "pipe", "inherit"] });
    this.base = await new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    return this.base;
  },

  stop() {
    this.child?.kill();
  },

  /** Pull requests opened for `owner/repo`. */
  async opened(owner, repo) {
    const res = await fetch(`${this.base}/_drill/pulls`);
    return (await res.json()).filter((p) => p.owner === owner && p.repo === repo);
  },

  /** Mark a pull request merged so the next Send opens a new one. */
  async close(pull) {
    await fetch(`${this.base}/_drill/close/${pull.number}`, { method: "POST" });
  },
};

function serve() {
  const pulls = [];
  const view = (p) => ({ number: p.number, html_url: `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`, state: p.state });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/_drill/pulls") return reply(200, pulls);
    const closing = url.pathname.match(/^\/_drill\/close\/(\d+)$/);
    if (closing) {
      const pull = pulls.find((p) => p.number === Number(closing[1]));
      if (pull) pull.state = "closed";
      return reply(200, pull ?? null);
    }
    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (!match) return reply(404, { message: "Not Found" });
    const [, owner, repo] = match;
    if (req.method === "GET") {
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      return reply(200, pulls.filter((p) => p.owner === owner && p.repo === repo && p.state === "open"
        && `${owner}:${p.head}` === head && (!base || p.base === base)).map(view));
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const head = String(body.head ?? "").replace(new RegExp(`^${owner}:`), "");
        const pull = { owner, repo, number: pulls.length + 1, state: "open", title: body.title, head, base: body.base, body: body.body };
        pulls.push(pull);
        reply(201, view(pull));
      });
      return undefined;
    }
    return reply(405, { message: "Method Not Allowed" });
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve();