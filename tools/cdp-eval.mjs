// Minimal CDP eval helper (dev-only, not shipped). Usage:
//   node tools/cdp-eval.mjs <url-substring> '<js expression>'
import { readFileSync } from "node:fs";

const [, , filter, exprArg] = process.argv;
// `@path/to/file.js` reads the expression from disk (avoids shell quoting hell).
const isFile = exprArg.startsWith("@");
const expr = isFile ? readFileSync(exprArg.slice(1), "utf8") : exprArg;
// Inline args are expressions; file args are statement bodies (they may use
// top-level await + `return`).
const body = isFile ? `(async () => {\n${expr}\n})()` : `(async () => { return (${expr}); })()`;

const list = await (await fetch("http://localhost:9222/json/list")).json();
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
