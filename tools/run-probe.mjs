/**
 * Self-contained probe runner: starts Vite, drives the device browser over CDP,
 * then tears the server down — all inside ONE process.
 *
 * WHY THIS EXISTS
 * A long-lived background Vite server proved unusable on this host: launched
 * detached (Start-Process, `start /b`, WMI, a scheduled task) it served the
 * first one or two requests and then stopped answering while still holding the
 * port and the process. Debugging that across separate shell invocations costs
 * more time than the gate itself, and the failure mode is silent (a stale
 * process looks healthy). Owning the server in-process removes the whole class
 * of problem: it cannot outlive the run, cannot be stale, and its logs are
 * visible.
 *
 * Usage:
 *   node tools/run-probe.mjs <probe-file.mjs> [--keep] [--port N]
 *
 * The probe file is a `cdp-eval.mjs` body (top-level await + `return`).
 * `window.__phase2Origin` is pre-set so probes can build absolute fixture URLs.
 * On success the probe's JSON value is printed and the exit code is 0; a
 * rejected probe prints its reason and exits non-zero. The device browser and
 * the app page are left alone — only the dev server is owned here.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const probeArg = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(flag("port", "5199"));
const CDP_PORT = flag("cdp", "9222");
const URL_FILTER = flag("filter", `localhost:${PORT}`);

if (!probeArg) {
  console.error("usage: node tools/run-probe.mjs <probe-file.mjs> [--keep] [--port N]");
  process.exit(2);
}
const probeSource = readFileSync(resolve(ROOT, probeArg), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a TCP port until it accepts, or give up. Cheaper than an HTTP probe. */
function waitForPort(port, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((res, rej) => {
    const attempt = () => {
      const s = createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => {
        s.destroy();
        res();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() - started > timeoutMs) rej(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort", "--host"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
);
const viteLog = [];
vite.stdout.on("data", (d) => viteLog.push(d.toString()));
vite.stderr.on("data", (d) => viteLog.push(d.toString()));

/** CDP client over the forwarded device browser socket. */
async function cdpEval(expression, timeoutMs = 20000) {
  // Every CDP round trip is bounded. A dropped `adb forward`/WiFi link leaves
  // the WebSocket open but silent, so an un-timed `Runtime.evaluate` never
  // settles and the probe hangs forever instead of reporting a failure.
  return Promise.race([
    cdpEvalOnce(expression),
    sleep(timeoutMs).then(() => {
      throw new Error(`CDP evaluate timed out after ${timeoutMs}ms (device link lost?)`);
    }),
  ]);
}

async function cdpEvalOnce(expression) {
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(URL_FILTER));
  if (!page) {
    throw new Error(
      `no device page matching "${URL_FILTER}". Open ${URL_FILTER} on the handset first.`
    );
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
  try {
    // `expression` is passed through verbatim. Earlier this helper always
    // wrapped its argument in the probe-body template, which silently mangled
    // ordinary expressions (it made a readiness poll a syntax error and could
    // return the wrapper's value instead of the caller's).
    const out = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(
        out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails)
      );
    }
    return out.result?.value;
  } finally {
    ws.close();
  }
}

/** Evaluate a probe FILE: its body is wrapped in an async IIFE so it can use
 *  top-level `await` and `return`, exactly like cdp-eval.mjs's `@file` form. */
function probeBody(source) {
  return `(async () => {\n${source}\n})()`;
}

let code = 0;
try {
  await waitForPort(PORT);
  // The page must be able to fetch fixtures from this exact origin.
  await cdpEval(`window.__phase2Origin = "http://localhost:${PORT}"; true`);

  // The page is usually opened BEFORE this runner's server exists (the
  // handset has to be navigated to the port first, and the reverse tunnel is
  // cheap while a background Vite is not). Its already-parsed module graph
  // therefore points at a server that is no longer there, and every dynamic
  // `import()` in a probe fails with "Failed to fetch dynamically imported
  // module" — which looks exactly like a broken app. Reload once, now that a
  // server is actually answering, and wait for the app to mount.
  console.error(`# reloading device page at localhost:${PORT}`);
  await cdpEval(`location.reload(); true`);
  // Readiness is "a probe module actually imports", NOT "the root element has
  // children": after a reload the old DOM is still in the document for a
  // moment, so a DOM check passes against a page whose module graph is dead.
  // Polling the real import is the only honest signal.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      ready =
        (await cdpEval(
          `import("/src/store/appStore.ts").then(() => true).catch(() => false)`
        )) === true;
      if (ready) break;
    } catch {
      /* the navigation may still be in flight */
    }
  }
  if (!ready) throw new Error(`device page never imported a module at localhost:${PORT}`);
  // Re-assert the fixture origin: a reload wipes the global.
  await cdpEval(`window.__phase2Origin = "http://localhost:${PORT}"; true`);

  // The probe body itself gets a long budget: it imports photos, waits on real
  // queued jobs and sleeps between phases. Only the short setup polls above
  // use the default.
  const value = await cdpEval(probeBody(probeSource), 10 * 60 * 1000);
  console.log(JSON.stringify(value, null, 2));
} catch (e) {
  code = 1;
  console.error("PROBE FAILED:", e?.message ?? e);
  console.error("--- vite log ---");
  console.error(viteLog.join("").slice(-4000));
} finally {
  if (!args.includes("--keep")) {
    vite.kill();
  } else {
    console.error(`(dev server left running on ${PORT})`);
  }
}
process.exit(code);