---
title: Flowie Qwen recon (Image-Edit-2511, ZeroGPU)
emoji: 👕
colorFrom: purple
colorTo: blue
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
pinned: false
license: apache-2.0
hardware: zerogpu
---

# Flowie Qwen recon Space (Qwen-Image-Edit-2511, ZeroGPU)

Spike renderer for the print-fidelity comparison against TryOffDiff.
Garment crop + verbatim reconstruction prompt in, complete empty garment
on solid chroma out (1024×1024). Chroma extraction + studio composite run
caller-side (`scripts/recon-harness.mjs`), never here.

## Why self-hosted

The official `Qwen/Qwen-Image-Edit-2511` Space declares
`@spaces.GPU(duration=180)` and the ZeroGPU scheduler currently refuses its
jobs outright ("requested GPU duration (360s) is larger than the maximum
allowed" — verified Sept 2026, deterministic across attempts, zero quota
burned since the GPU is never claimed). This Space runs the same base
weights at reduced steps (default 8) inside a **60 s** reservation (30 s
jobs schedule reliably; 120 s+ reservations stall — verified Sept 2026), so one
spike call fits the free daily pool next to TryOffDiff (2× 30 s).

No Lightning LoRA: no 2511-specific Lightning adapter exists on the Hub
(`lightx2v/Qwen-Image-Lightning` ships 2509/base-Edit adapters only), so this
Space runs base weights — the spike still answers the print-fidelity
question conservatively (a LoRA would only speed it up, not change fidelity).

## Deploy (2 min, in the browser — frees the old schnell slot)

1. Delete or pause the old FLUX-schnell Space (frees 1 of 2 free ZeroGPU
   slots), then create a new Space: https://huggingface.co/new-spaces
   - SDK: **Gradio**, Hardware: **ZeroGPU**.
   - Copy `app.py` + `requirements.txt` from this folder (web upload fine).
2. No secrets needed (no gated weights, no DashScope — prompt rewrite is
   OFF by design; the caller sends the final prompt verbatim).
3. Wait for the build (20B weights — first build is slow), open the Space,
   run one manual reconstruction (any garment crop + prompt, 4 steps).
4. Copy the Space ID into your backend env:

```bash
HF_QWEN_SPACE_ID=<owner>/<space-name>
HF_TOKEN=hf_...   # same read token as the tryoff Space (one token, shared pool)
```

## Call it (harness — our stack)

```bash
node scripts/recon-harness.mjs --input=<crop-source> --slug=<name> \
  --class=lower --out=recon-work/<name> --qwen --qwen-steps=4 --seed=42
```

With `HF_QWEN_SPACE_ID` set, `--qwen` targets YOUR Space via the stable
`/predict` endpoint (`input_image, prompt, seed, num_steps → PIL`), the
same tryoff-style Gradio protocol — no `@gradio/client` needed. Without it,
`--qwen` falls back to the official Space (currently scheduler-blocked).

## Quota math (free tier)

- Free account: **5 min/day GPU**, shared across ALL your Spaces.
- This Space reserves **60 s/call** (vs 180 s official, 60 s schnell,
  30 s tryoff). Budget: 1 Qwen spike + 4 tryoff calls ≈ 180 s/day.
- Classical chroma extraction + composite run caller-side: zero quota.

## API (pinned for callers — do not rename without updating both)

- Endpoint: `/predict` (single Gradio `Blocks` click handler, fn_index 0)
- Inputs: `input_image` (filepath), `prompt` (str, verbatim),
  `seed` (int, default 42), `num_steps` (4–10, default 8)
- Output: PIL image, 1024×1024, unpolished
- Fixed: guidance 4.0, base weights, no prompt rewrite
