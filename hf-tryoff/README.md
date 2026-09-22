---
title: Flowie free flat-lay (TryOffDiffv2-MGT)
emoji: 👗
colorFrom: indigo
colorTo: pink
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
pinned: false
---

# Flowie free flat-lay Space (TryOffDiffv2-MGT, ZeroGPU)

Single-purpose virtual try-off endpoint: garment photo in, canonical
flat-lay out (512×512). Free inside the ZeroGPU quota — ~10 s reserved per
call (vs 60 s for the FLUX-schnell Space), so roughly 6× more garments per
free day.

## Deploy (2 min, mirrors `hf-space/README.md`)

1. Create a Space: Gradio SDK, **ZeroGPU** hardware, public.
2. Upload `app.py`, `model.py`, `requirements.txt` from this folder.
3. Secrets (Settings → Secrets) if the build asks: `HF_TOKEN` (read token —
   needed only when a gated weight page requires acceptance).
4. Accept license pages if prompted at build time:
   - `CompVis/stable-diffusion-v1-4` (UNet base — upstream also pulls this)
   - `google/siglip-base-patch16-512` (image encoder)
   The MGT checkpoint + scheduler config pull from
   `rizavelioglu/tryoffdiff` (public).
5. Wait for the build; open the Space and run one manual generation
   (upload any garment photo, class upper, seed 42) to confirm output.
6. Set `HF_TRYOFF_SPACE_ID` (edge-function secret, e.g.
   `your-user/flowie-garment-tryoff`) — see
   `supabase/functions/flatlay-tryoff/index.ts` header. Same `HF_TOKEN`
   as the schnell Space works (one token, two Spaces, shared ZeroGPU
   quota pool).

## API (pinned for callers — do not rename without updating both)

- Endpoint: `/predict` (single Gradio `Blocks` click handler, fn_index 0)
- Inputs: `input_image` (filepath), `garment_class` (`"upper" | "lower" |
  "dress"`), `seed` (int, default 42)
- Output: PIL image, 512×512, classically polished on CPU
- Fixed: 20 steps, guidance 2.0 (constants in `app.py`, not caller inputs —
  callers cannot accidentally order a 1000-step run)

## Quota + cost notes

- ZeroGPU free tier is shared across ALL your Spaces (schnell + this one).
  Client budgets it: 4 try-off + 4 enhance calls/day max, 60 s pace, manual
  retry only. One call ≈ one reserved slot of the duration in
  `@spaces.GPU(...)` (30 s ceiling here; actual inference is shorter —
  check the Space logs' TIMER lines after the spike).
- If the free pool runs dry mid-day, jobs fail into `failed`/`skipped`
  with the free on-device composite + SVG carrying the UI. Nothing retries
  silently. Resume tomorrow or upgrade to PRO.

## License notice (read before commercial launch)

Upstream TryOffDiff code + weights are **SSPL — academic/research use**
("not available for commercial use unless the FULL source code is
open-sourced"). This Space exists for Flowie's prototype stage. A
commercial launch must either open-source accordingly or swap the engine
(e.g. a permissively-licensed try-off, or the dormant Gemini path in
`src/services/studioFlatlay.ts`). Model + code attribution lives in
`model.py` header and the Space UI citation block — keep them.

## Upstream references

- Demo Space: https://huggingface.co/spaces/rizavelioglu/tryoffdiff
- Weights: https://huggingface.co/rizavelioglu/tryoffdiff
- Code: https://github.com/rizavelioglu/tryoffdiff (SSPL)
- Papers: TryOffDiff (BMVC'25), MGT multi-garment (ICCVW'25)
