// Minimal CDP eval helper (dev-only, not shipped). Usage:
//   node tools/cdp-eval.mjs <url-substring> '<js expression>'
//   CDP_PORT=9224 node tools/cdp-eval.mjs <url-substring> @probe.mjs
//
// CDP_PORT exists because 9222 is not guaranteed: the default Chromium
// debugging port collides with any other browser already listening on this
// host, and a hardcoded port silently drives the WRONG browser (it did — it
// attached to an unrelated project's dev server). Overridable per invocation.
import { readFileSync } from "node:fs";

const [, , filter, exprArg] = process.argv;
const PORT = process.env.CDP_PORT ?? "9222";

// `@path/to/file.js` reads the expression from disk (avoids shell quoting hell).
const isFile = exprArg.startsWith("@");
const expr = isFile ? readFileSync(exprArg.slice(1), "utf8") : exprArg;
// Inline args are expressions; file args are statement bodies (they may use
// top-level await + `return`).
const body = isFile ? `(async () => {\n${expr}\n})()` : `(async () => { return (${expr}); })()`;

const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes(filter));
if (!page) {
  console.error("no target matching", filter);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  }
});

await new Promise((r) => ws.addEventListener("open", r, { once: true }));

const out = await send("Runtime.evaluate", {
  expression: body,
  awaitPromise: true,
  returnByValue: true,
});
ws.close();
console.log(JSON.stringify(out.result?.value ?? out, null, 2));
