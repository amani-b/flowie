// The sheet is open with 3 real photos staged and "Review before saving" off.
// Press Auto-Tag and measure whether the sheet clears immediately while the
// closet keeps filling in the background.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countRe = /(\d+)\s*pieces/;
const visible = (re) => {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.offsetParent !== null && re.test(b.textContent || "")
  );
  return el ?? null;
};

const before = document.body.innerText.match(countRe)?.[0] ?? "?";
const staged = /(\d+)\.jpg/.test(document.body.innerText);
const reviewOff = /Off: photos go straight/.test(document.body.innerText);

const btn = visible(/Auto-Tag/);
if (!btn) return { error: "Auto-Tag button not found", body: document.body.innerText.slice(-200) };

const t0 = performance.now();
btn.click();

// Poll: when does the picker UI (Auto-Tag / Add more photos) disappear?
let sheetGoneAt = null;
for (let i = 0; i < 80; i++) {
  await sleep(25);
  if (!visible(/Auto-Tag|Add more photos/)) {
    sheetGoneAt = Math.round(performance.now() - t0);
    break;
  }
}

const samples = [];
for (let i = 0; i < 10; i++) {
  await sleep(1500);
  samples.push({
    t: Math.round(performance.now() - t0),
    count: document.body.innerText.match(countRe)?.[0] ?? "?",
  });
}

return {
  staged,
  reviewOff,
  sheetClosedAfterMs: sheetGoneAt,
  before,
  samples,
  finalCount: document.body.innerText.match(countRe)?.[0] ?? "?",
  toasts: [...document.querySelectorAll("[role=alert],[role=status]")]
    .map((n) => n.textContent.trim().slice(0, 80))
    .filter(Boolean),
};

