// Text-based judge for generated garment images — replaces visual re-judging.
// Per image: skinPct (person/mannequin leak proxy, strict RGB∧YCbCr test),
// darkPct (garment presence for black items), whitePct (background share),
// garmentRGB (mean of non-white pixels), olivePct (color check for the tee).
// Verdict is garment-type aware: black items need skin<1.5% AND dark>=15%;
// the olive tee needs olivePct>=12% (its fabric false-positives loose skin tests).
// Known limitation: a GRAY mannequin is neither skin nor dark — detector cannot
// see it; visual judgment from round 1 covers that case.
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'out/pollinations';

function isSkin(r, g, b) {
  const rgbish = r > 95 && g > 40 && b > 20 && r > g && g >= b && r - Math.min(g, b) > 15;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycc = y > 60 && cb >= 77 && cb <= 130 && cr >= 133 && cr <= 175;
  return rgbish && ycc; // conjunction: olive/khaki fabric fails ycc and is excluded
}

const files = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();

for (const f of files) {
  try {
    const img = sharp(join(dir, f));
    const { data, info } = await img
      .resize(128, 128, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const total = info.width * info.height;
    let skin = 0, dark = 0, white = 0, olive = 0, gr = 0, gg = 0, gb = 0, gN = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b);
      if (isSkin(r, g, b)) { skin++; continue; }
      if (r > 235 && g > 235 && b > 235) { white++; continue; }
      if (mx < 70) { dark++; continue; }
      if (Math.abs(r - g) < 25 && g - b > 25 && g > 60 && g < 170) olive++;
      gr += r; gg += g; gb += b; gN++;
    }
    const pct = (n) => (100 * n) / total;
    const gMean = gN ? `${Math.round(gr / gN)},${Math.round(gg / gN)},${Math.round(gb / gN)}` : 'n/a';
    const s = pct(skin).toFixed(2), d = pct(dark).toFixed(1), w = pct(white).toFixed(1), o = pct(olive).toFixed(1);
    let verdict;
    if (f.includes('olive')) {
      verdict =
        pct(skin) >= 6 ? 'FAIL(leak)' :
        pct(olive) < 12 ? 'FAIL(drift)' : 'PASS';
    } else {
      verdict =
        pct(skin) >= 1.5 ? 'FAIL(leak)' :
        pct(dark) < 15 ? 'FAIL(missing/weak)' : 'PASS';
    }
    console.log(`${f}  skin=${s}% dark=${d}% white=${w}% olive=${o}% garmentRGB=${gMean}  ${verdict}`);
  } catch (e) {
    console.log(`${f}  ERROR ${e.message}`);
  }
}
