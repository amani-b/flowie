---
title: Flowie garment img2img (FLUX.1-schnell, ZeroGPU)
emoji: 👕
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zerogpu
---

# Flowie garment img2img — FLUX.1-schnell on ZeroGPU

Phase 2/3 model-hosting piece only. Phase 1 (segmentation + studio composite)
and the Phase 3 strength experiment harness are unchanged — the experiment now
targets this Space's `/predict` endpoint instead of Cloudflare.

Supersedes the SDXL-Turbo version: Turbo was fast but rendered studio light
flatter than the 12B FLUX.1-Kontext-dev reference (Image 1). Schnell is the
same FLUX family / 12B backbone class, distilled to 4 steps.

## Deploy (2 min, in the browser) + 2 one-time manual steps

1. Create a new Space: https://huggingface.co/new-spaces
   - SDK: **Gradio**, Hardware: **ZeroGPU** (needs verified email + account
     older than 30 days on free tier; otherwise PRO/Team).
   - Copy `app.py` + `requirements.txt` from this folder into the Space
     (web upload is fine — no git needed).
2. GATED MODEL setup (required — schnell's license):
   - Accept the terms at https://huggingface.co/black-forest-labs/FLUX.1-schnell
     (logged in).
   - Space Settings → Secrets → add `HF_TOKEN` (a read token). The build uses
     it to download weights. Never in code.
3. Wait for the build, open the Space, run one test image.
4. Copy the Space ID (`<owner>/<space-name>`) into your backend env:

```bash
HF_SPACE_ID=<owner>/<space-name>
HF_TOKEN=hf_...   # Inference/Spaces read permission is enough for calls
```

## Call it (Node — our stack)

```bash
npm i @gradio/client
node scripts/space-img2img-test.mjs --space=$HF_SPACE_ID --input=phase1-review/photo-1-after.jpg --strength=0.35 --steps=4
```

Why `@gradio/client` and not `gradio_client`: `gradio_client` is the
**Python** package. This repo's backend/test harness is **Node** (`scripts/*.mjs`),
so the correct same-protocol client is the official JS port `@gradio/client`
(`Client.connect(space, { token })` + `predict("/predict", {...})` +
`handle_file`). A Python `gradio_client` snippet is in
`scripts/space-img2img-test.mjs` header comments for reference only.

## Quota math (free tier)

- Free account: **5 min/day GPU** (unauthenticated: 2 min; PRO: 40 min).
- Quota burns per **reserved slot**, not compute seconds: `@spaces.GPU(duration=60)`
  costs 60 s per call → **~5 garments/day free**, PRO ~40/day.
  The classical `_polish` runs outside the GPU function: zero quota.
- This Space runs **768px / 4 steps** (T5 encode + 4 transformer passes + VAE
  decode ≈ 20–40 s actual GPU); the 60 s slot covers it with headroom.
  Browser clicks burn the same slot as API calls — test sparingly on free.

## Model note

`black-forest-labs/FLUX.1-schnell`, 4 steps, `guidance_scale=0.0`,
`max_sequence_length=256`. Same 12B FLUX backbone class as the Kontext-dev
reference that produced Image 1, so low-strength (0.25–0.45) img2img keeps
fabric weave / tapes / logos instead of smoothing them the way SDXL-Turbo
did; the 16-channel FLUX VAE round-trips detail far better than SDXL's
4-channel VAE. See `app.py` docstring for the full rationale.
`negative_prompt` is accepted for API stability but inert at guidance 0.0.
