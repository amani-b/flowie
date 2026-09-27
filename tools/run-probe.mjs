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

import { execFileSync, spawn } from "node:child_process";
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
/** `--shots <dir>` captures one PNG per tab after the probe finishes. */
const SHOTS_DIR = flag("shots", null);
/** `--theme light|dark` pins the app theme before measuring. */
const THEME = flag("theme", null);

if (!probeArg) {
  console.error("usage: node tools/run-probe.mjs <probe-file.mjs> [--keep] [--port N]");
  process.exit(2);
}
const probeSource = readFileSync(resolve(ROOT, probeArg), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Never exit non-zero silently. Back-to-back runs can race on the dev-server
 * port, and a bare exit code with no explanation is worse than no run at all —
 * it looks like the harness worked and the app failed.
 */
process.on("unhandledRejection", (e) => {
  console.error("PROBE FAILED (unhandled rejection):", e?.message ?? e);
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  console.error("PROBE FAILED (uncaught exception):", e?.message ?? e);
  process.exit(1);
});

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

/**
 * CDP client over the forwarded device browser socket.
 *
 * One session is opened for the whole run and kept open, rather than
 * connect-evaluate-close per call. Two reasons:
 *  - `Emulation.*` overrides are scoped to the session. Re-connecting per call
 *    silently dropped them, so a probe could never emulate reduced motion.
 *  - Re-fetching `/json/list` and re-handshaking per evaluate is slow enough to
 *    matter once a probe polls in a loop.
 */
let session = null;

async function openSession() {
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(URL_FILTER));
  if (!page) throw new Error(`no device page matching "${URL_FILTER}"`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
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
  session = {
    ws,
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
  };
}

function closeSession() {
  session?.ws.close();
  session = null;
}

/**
 * Every CDP round trip is bounded. A dropped `adb forward`/WiFi link leaves the
 * WebSocket open but silent, so an un-timed call never settles and the probe
 * hangs forever instead of reporting a failure.
 */
async function cdpCall(method, params = {}, timeoutMs = 20000) {
  if (!session) throw new Error("CDP session is not open");
  return Promise.race([
    session.send(method, params),
    sleep(timeoutMs).then(() => {
      throw new Error(`CDP ${method} timed out after ${timeoutMs}ms (device link lost?)`);
    }),
  ]);
}

async function cdpEval(expression, timeoutMs = 20000) {
  // `expression` is passed through verbatim. Earlier this helper always wrapped
  // its argument in the probe-body template, which silently mangled ordinary
  // expressions (it made a readiness poll a syntax error and could return the
  // wrapper's value instead of the caller's).
  const out = await cdpCall(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    timeoutMs
  );
  if (out.exceptionDetails) {
    throw new Error(
      out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails)
    );
  }
  return out.result?.value;
}

/** Evaluate a probe FILE: its body is wrapped in an async IIFE so it can use
 *  top-level `await` and `return`, exactly like cdp-eval.mjs's `@file` form. */
function probeBody(source) {
  return `(async () => {\n${source}\n})()`;
}

const DEVICE_URL = `http://localhost:${PORT}/`;

/**
 * Re-assert the two adb tunnels this harness depends on.
 *
 * The CDP forward is not stable across runs on this host: after a run ends the
 * forwarded port can answer one request and then go silent, which surfaces as
 * a bogus "device link lost". Re-creating the forward is cheap and idempotent,
 * and doing it here means a dropped tunnel costs one retry instead of a
 * debugging session. The reverse tunnel is what lets the handset reach this
 * machine's dev server at `localhost:${PORT}`.
 */
async function ensureTunnels() {
  const adb = (args) => {
    try {
      execFileSync("adb", args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  adb(["forward", "--remove", `tcp:${CDP_PORT}`]);
  if (!adb(["forward", `tcp:${CDP_PORT}`, "localabstract:chrome_devtools_remote"])) {
    throw new Error(
      `could not forward tcp:${CDP_PORT} to the device devtools socket — is the handset attached and authorised?`
    );
  }
  adb(["reverse", "--remove", `tcp:${PORT}`]);
  adb(["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);
  // Give the forward a moment to bind before the first HTTP call.
  await sleep(400);
}

/** The device tab this run is about, if it is already open. */
async function findDevicePage() {
  try {
    const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page" && t.url.includes(URL_FILTER)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Make sure the handset has a tab on the dev origin.
 *
 * Previously this was a manual precondition — the runner told you to open the
 * URL yourself and then failed with "no device page matching …" if you had not.
 * That is a bad handoff to leave in a harness whose whole point is to be
 * re-runnable after a device drop: the recovery step lives in someone's head.
 * Now the runner opens the tab through adb, which is the same thing a human
 * would do and costs one `am start`.
 */
async function ensureDevicePage() {
  if (await findDevicePage()) return;
  console.error(`# no device tab at ${URL_FILTER} — opening one via adb`);
  try {
    execFileSync(
      "adb",
      [
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        DEVICE_URL,
        "com.android.chrome",
      ],
      { stdio: "ignore" }
    );
  } catch (e) {
    throw new Error(
      `could not launch the device browser (is the handset attached?): ${e?.message ?? e}`
    );
  }
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await findDevicePage()) return;
  }
  throw new Error(
    `device browser never opened ${URL_FILTER}. If the CDP endpoint is silent, ` +
      `Chrome may have lost its devtools socket — force-stop and relaunch it, ` +
      `then re-run.`
  );
}

/**
 * Optional screenshot pass (`--shots <dir>`). Walks the five tabs, waits for
 * each to settle, and saves one PNG per tab through `Page.captureScreenshot`.
 *
 * It lives here rather than in a probe because a probe body runs inside the
 * page and cannot reach the CDP session — screenshots are a protocol-level
 * capability, not a DOM one.
 */
async function captureTabScreenshots(dir, theme) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const out = resolve(ROOT, dir);
  mkdirSync(out, { recursive: true });
  await cdpCall("Page.enable");
  const tabs = ["home", "closet", "studio", "looks", "calendar"];
  for (const tab of tabs) {
    await cdpEval(
      `(async () => {
         const m = await import("/src/store/appStore.ts");
         m.useAppStore.getState().setTab(${JSON.stringify(tab)});
         return true;
       })()`
    );
    // Long enough for the screen's own entrance animation to settle.
    await sleep(700);
    const { data } = await cdpCall("Page.captureScreenshot", { format: "png" });
    const file = resolve(out, `${theme}-${tab}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.error(`# shot ${file}`);
  }
}

/**
 * Wait until the page can actually answer an evaluate.
 *
 * `ensureDevicePage` may have just kicked off a navigation via `am start`, and
 * `adb forward`/`/json/list` both report the target as soon as the navigation
 * *starts*. An evaluate issued in that window is delivered to a document that
 * is about to be replaced, so its reply is simply dropped and the call sits
 * until its timeout — which reads as "device link lost" but is really "we
 * asked too early". Short timeout, retried, is the fix.
 */
async function waitForPageStable() {
  for (let i = 0; i < 60; i++) {
    try {
      const state = await cdpEval(`document.readyState`, 3000);
      if (state === "complete" || state === "interactive") return state;
    } catch {
      /* mid-navigation: the context is being torn down, try again */
    }
    await sleep(500);
  }
  throw new Error("device page never reached a stable document state");
}

let code = 0;
try {
  await waitForPort(PORT);
  await ensureTunnels();
  await ensureDevicePage();
  await openSession();
  await waitForPageStable();

  // `--theme light|dark` pins the app theme before anything is measured, so a
  // screenshot run and a probe run can target the same state.
  if (THEME) {
    console.error(`# forcing theme: ${THEME}`);
    await cdpEval(
      `(async () => {
         const m = await import("/src/store/appStore.ts");
         m.useAppStore.getState().setTheme(${JSON.stringify(THEME)});
         return true;
       })()`
    );
  }

  // The page must be able to fetch fixtures from this exact origin.
  await cdpEval(`window.__phase2Origin = "http://localhost:${PORT}"; true`);

  // `--motion reduce|no-preference` emulates the OS animation setting for the
  // whole run (`--reduced-motion` is kept as an alias for `reduce`). Session
  // scoped, so it must be applied after openSession(); it survives the reload.
  // Emulating BOTH states matters: this handset has animation removal switched
  // on at OS level, so without an explicit `no-preference` run the animated
  // state is simply never observed.
  const motion = flag("motion", args.includes("--reduced-motion") ? "reduce" : null);
  if (motion) {
    console.error(`# emulating prefers-reduced-motion: ${motion}`);
    await cdpCall("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: motion }],
    });
  }

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

  // Optional screenshot pass: one PNG per tab, for the device walkthrough.
  if (SHOTS_DIR) {
    await captureTabScreenshots(SHOTS_DIR, THEME);
  }
} catch (e) {
  code = 1;
  console.error("PROBE FAILED:", e?.message ?? e);
  console.error("--- vite log ---");
  console.error(viteLog.join("").slice(-4000));
} finally {
  closeSession();
  if (!args.includes("--keep")) {
    vite.kill();
  } else {
    console.error(`(dev server left running on ${PORT})`);
  }
}
process.exit(code);