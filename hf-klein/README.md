---
title: Flowie klein detail spike (FLUX.2-klein-base-4B, ZeroGPU)
emoji: 🔬
colorFrom: blue
colorTo: gray
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zerogpu
---

# Flowie klein detail spike Space (FLUX.2-klein-base-4B, ZeroGPU)

BOUNDED EXPERIMENT (max 1–2 calls): does a small open editor preserve
difficult garment details (GUESS side tape, small logos) that TryOffDiff
drops? If no material gain → stop the renderer search, TryOffDiff stands.
Do not broaden this Space.

## Deploy (2 min, in the browser)

Free accounts host max 2 ZeroGPU Spaces: with tryoff + qwen-vision
occupied, pause or delete ONE first (recommend: the broken 20B qwen-vision
Space — keep its repo, just pause it) to free the slot.

1. Create a new Space: https://huggingface.co/new-spaces
   - SDK: **Gradio**, Hardware: **ZeroGPU**.
   - Visibility: same as the tryoff Space (either works — the harness
     sends the caller token either way).
   - Upload `app.py` + `requirements.txt` from this folder exactly as
     committed (web upload fine). No other files needed.
2. NO license acceptance, NO Space secret: `FLUX.2-klein-base-4B` is
   public Apache-2.0, ungated (verified on the model page Sept 2026 —
   earlier "gated" notes in this folder were wrong and are now fixed).
   Do not add `HF_TOKEN` to the Space for download. `HF_TOKEN` lives
   only in your local `.env`, and only matters if the Space is Private.
3. Wait for the build to go green, then check the BUILD LOG (free, no
   quota): confirm `[klein] loading pipeline…` appears with no
   ImportError. A bad build fails here at zero quota cost — fix files,
   never retry blindly.
4. Skip the manual UI test (it burns a 60 s slot from the same pool).
   Go straight to harness call 1 below — it verifies serving AND is
   the experiment. Copy the Space ID into your backend env first:

```bash
HF_KLEIN_SPACE_ID=<owner>/<space-name>
HF_TOKEN=hf_...   # same read token (one token, shared pool)
```

## Call it (harness — our stack, max 1–2 calls)

```bash
# `references/` is gitignored: point --input at a photo on your own machine.
# Call 1 (the discriminating test — hard case, GUESS tape):
node scripts/recon-harness.mjs \
  --input=references/raw-samples/<guess-shorts>.jpg \
  --slug=guess-shorts --class=lower --out=recon-work/guess-shorts-klein \
  --klein --klein-steps=20 --seed=42
# Call 2 (ONLY if call 1 shows print promise — easy-case regression check):
node scripts/recon-harness.mjs \
  --input=references/raw-samples/<navy-trousers>.jpg \
  --slug=navy-trousers --class=lower --out=recon-work/navy-trousers-klein \
  --klein --klein-steps=20 --seed=42
```

Grade call 1 on: GUESS tape present + legible (exact / partial / missing),
silhouette, color, no invented text. Partial-or-worse → stop, no call 2.

## Quota math (free tier)

- Free account: **5 min/day GPU**, shared across ALL your Spaces.
- This Space reserves **60 s/call**. Budget: 1 klein call + remaining
  tryoff calls ≈ inside the pool. Check https://huggingface.co/settings/billing.
- Classical chroma extraction + composite run caller-side: zero quota.

## API (pinned for callers)

- Endpoint: `/predict` (single Gradio `Blocks` click handler, fn_index 0)
- Inputs: `input_image` (filepath), `prompt` (str, verbatim),
  `seed` (int, default 42), `num_steps` (8–28, default 20)
- Output: PIL image, 1024×1024, unpolished
- Fixed: guidance 4.0, base weights, no prompt rewrite
