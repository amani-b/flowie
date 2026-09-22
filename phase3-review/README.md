# Phase 3 checkpoint — VERDICT: NO-GO on generation (ship Phase 1 alone)

## Why there is no 15×5 grid

The grid as specified is not runnable, and running a lookalike would fake the
checkpoint. Three hard facts:

1. **No strength knob exists on any working free path.** Cloudflare's only
   REST img2img model is paid-gated (403/5018); HF retired its classic endpoint
   and unlisted v1.5/SDXL. The one working call (Phase 2, FLUX Kontext) is
   instruction-driven — intensity is words, not a 0.2–0.6 dial.
2. **No 15–20 photo test set exists.** In-scope real photos: photo-1 (good),
   photo-3 (hard). Photo-2 is out of scope by owner decision. The 5 demo
   garments are synthetic SVG clip-art, not camera photos.
3. **Every free generation endpoint is now exhausted or gated** (each verified,
   none assumed):
   | vendor | result |
   |---|---|
   | Cloudflare Workers AI (sd1.5-img2img) | 403/5018 — model requires Workers Paid |
   | Hugging Face Inference Providers (Kontext) | 1 success (Phase 2), then monthly credits depleted |
   | Gemini 2.5-flash-image (existing repo key) | 429, free-tier limit 0 on this key/project |
   | Pollinations kontext (keyless) | needs PUBLIC image URL (data-URL → HTTP 431; tmpfiles.org unresolvable here) + documented person-prior + watermark + public feed |

## The one real data point: `n1-comparison.png` (open it)

Source Phase 1 composite vs the single Kontext edit, side by side:

| criterion | result |
|---|---|
| (a) same garment (shape/color/pattern/logo) | PASS — blue GUESS shorts intact, branding legible |
| (b) more "studio" than Phase 1 alone | PASS — diffused light, fabric sheen, contact shadow |
| (c) no person/face/hands/mannequin | PASS |
| (d) artifacts | minor — side-tape lettering slightly garbled on zoom |

n=1 passing is encouraging but is **not** a production basis: unfunded vendor,
no browsable failure mode, no strength dial to tune with.

## Recommendation (matches the brief's own fallback)

**Ship Phase 1 alone** — segmentation + neutral composite, no generation.
It is verified, deterministic, zero-cost, and has zero person risk.
Optional free upgrade later: deterministic classical polish
(white-balance, gentle detail/contrast) — also zero-cost, zero risk.

## Reopen criteria (any one)

- HF monthly credits reset → run the adapted grid (photos × 3 instruction
  intensities) with real (a)–(d) grading before any app wiring.
- A $ budget appears (CF Workers Paid $5/mo, HF PRO, or Gemini paid tier).
- You supply 10+ real garment photos, making a statistically honest grid
  possible in one funded session.

## Wanted photo set (when you shoot it — measurement, not training)

More photos will **not** make outputs better: we call a frozen third-party
model, so photos are test data, not training data. What they buy is a real
failure-rate estimate — n=1 says nothing about how often logos melt, colors
drift, or a person appears (our own Pollinations audit caught a ~1-in-3 leak
rate; Kontext is input-constrained so risk is lower, but unmeasured).

Shoot 10–15, covering: top, bottom, patterned, dark, light/white,
logo-or-text, straps/zippers/buttons. Per photo: daylight or bright room,
plain contrasting surface (NOT white-on-white or black-on-black), garment
fully inside the frame with a hand's-width margin on all sides (the photo-2
lesson), lay flat, no hangers, no body parts. Drop them in
`references/raw-samples/` named `set2-<category>-<n>.jpg`.
