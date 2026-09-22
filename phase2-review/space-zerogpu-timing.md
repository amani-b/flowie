# ZeroGPU timing note — one real end-to-end call

Date: 2026-09-21. Target: same model class as our Space (`stabilityai/sdxl-turbo`,
2 steps, strength 0.3, 512px, seed 42, input `phase1-review/photo-1-after.jpg`).

## What actually ran

Our Space (`hf-space/app.py`) is code-complete but not yet deployed (needs your
2-min deploy: new Space → Gradio SDK → ZeroGPU hardware → paste `app.py` +
`requirements.txt` → set `HF_SPACE_ID`). So the timed call went to the closest
public equivalent — `Manjushri/SDXL-Turbo-Img2Img-CPU`, same SDXL-Turbo model,
same 2-step/0.3-strength regime — via the same `@gradio/client` path our
`scripts/space-img2img-test.mjs` uses (connect with `HF_TOKEN` → `predict` →
download file).

- **Wall total: 81.4 s** (connect 4.0 s + queue/upload/inference/download 77.4 s)
- Output: `space-ref-timing.png` (512×512, pixel stats match source garment:
  means 182/201/216 vs source 181/202/218) — real img2img result, garment preserved.

## Why your Space will be much faster

The reference is **CPU**. Ours is **ZeroGPU (A100-class)**: pure Turbo inference
at 512px/2 steps is ~0.4–0.8 s GPU; expect **~10–30 s wall** (queue + upload
dominate, GPU slice is the small part). Re-run the timer after deploy:

```
node scripts/space-img2img-test.mjs --space=$HF_SPACE_ID --input=phase1-review/photo-1-after.jpg --strength=0.3 --steps=2
```

## Quota → garments/day (free tier) — CORRECTED 2026-09-21

ZeroGPU returns **no per-call GPU-seconds field** (verified: file responses carry
none), so quota is read at https://huggingface.co/settings/billing. Documented
limits: **free = 5 min/day (300 s)**, reset 24 h after first GPU use; PRO = 40 min.

CORRECTION to the earlier estimate: ZeroGPU reserves the full `@spaces.GPU`
`duration` slot per call, not actual compute seconds — proven by a live error:
`You have exceeded your ZeroGPU quota (180s requested vs. 92s left)` with
`duration=120`. So per-call cost = the slot size:

- `duration=120` (original): ~2 calls/day free. Too coarse — fixed the same day.
- `duration=30` (current): **~10 garments/day free** (300/30), PRO ~80/day.
  2-step Turbo at 512px needs ~5–15 s actual GPU, so the 30 s slot has headroom
  without wasting quota. Classical `_polish` runs outside the decorated
  function: zero GPU seconds.
- Browser clicks burn the same slot as API calls — test sparingly on free.

## 2026-09-2x: Turbo SUPERSCEDED by FLUX.1-schnell (quality verdict)

Turbo + classical polish lost to the 12B Kontext reference (Image 1) on
studio-light richness. Space now runs `black-forest-labs/FLUX.1-schnell`
(same FLUX family / 12B class as Kontext-dev) via `FluxImg2ImgPipeline`:
768px, 4 steps, `guidance_scale=0.0`, `max_sequence_length=256`,
`@spaces.GPU(duration=60)` → **~5 garments/day free**, ~40 PRO.
Same `/predict` contract — harness untouched. Recommended grid:
strengths 0.25–0.45 @ 4 steps, seed fixed.
Gated model: license accept + `HF_TOKEN` Space Secret required (see
`hf-space/README.md`). Cost-free, no local weights (nothing downloaded
to this machine — Space-side only).
