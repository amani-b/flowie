# Phase 2 review — free img2img end-to-end (Hugging Face path)

Status: **SUCCESS — first free img2img call ran clean, garment preserved.**

## Result (open these two side by side)

- Source (Phase 1 output, untouched): `../phase1-review/photo-1-after.jpg`
- Generated (NEW file): `edit-hf-kontext.png` (507 KB JPEG, 15.6 s)
- Verdict: **same garment** — blue GUESS shorts, side-tape branding and white
  leg logo intact, same color/cut; now on a soft studio backdrop with diffused
  lighting and a contact shadow. No person/mannequin/face/hands. Tape lettering
  is slightly garbled on close zoom (expected diffusion behavior) — "studio
  enough" tuning is Phase 3's job.

## What ran

- `scripts/hf-edit-test.mjs` → `black-forest-labs/FLUX.1-Kontext-dev`,
  `provider=auto` (routed to `fal-ai`), free HF credits, no card.
- Instruction-driven edit (keeps the exact garment, re-lights to studio).
  No strength knob exists on this model class — strength tuning, if wanted,
  becomes a Phase 3 concern.

## Path log (so nobody re-walks it)

1. Cloudflare Workers AI: correct model (`@cf/runwayml/stable-diffusion-v1-5-img2img`)
   but free accounts get 403/5018; post-Jul-2026 CF gates image models behind
   Workers Paid. Script kept at `scripts/cf-img2img-test.mjs` for later.
2. HF classic endpoint `api-inference.huggingface.co`: retired (DNS NXDOMAIN).
3. HF `hf-inference` router: v1.5 "not supported", SDXL-base-1.0 "deprecated".
4. ✅ HF Inference Providers via `@huggingface/inference`, Kontext-dev, `provider=auto`.

## Environment quirk (documented, not hidden)

This machine's Node/Windows build drops lone in-flight fetches (exit 13,
"unsettled top-level await", plus libuv `async.c` assertions). The script
holds the event loop with a 1 s heartbeat until the call settles —
environment-specific workaround, cleared immediately after.

Status: **script ready, one successful-shape run not yet possible — blocked on token scope (your action needed, see below).**

## What was built (portfolio-safe, no secrets in repo)

- `scripts/cf-img2img-test.mjs` — standalone Node script (global `fetch` + repo `sharp` only):
  reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the environment
  (never CLI args, never disk, never logged), sends one Phase 1
  `studio_composite` to Workers AI img2img, saves the output as a NEW file.
- `.env.example` — placeholder lines for both variables, with a warning that
  they must never get a `VITE_` prefix (that would bundle them into client code).
- Defaults: model `@cf/runwayml/stable-diffusion-v1-5-img2img`, strength `0.3`,
  20 steps, fixed seed `42` (reproducible re-runs), prompt/negative-prompt from
  the Phase 2 brief. Override via `--model= --input= --strength= --steps= --seed= --out=`.

## Model finding (tried, so you don't have to)

- `@cf/runwayml/stable-diffusion-v1-5-img2img` — **correct model**: accepts
  `image_b64` + `strength` + `negative_prompt` per the published schema.
- `@cf/stabilityai/stable-diffusion-xl-base-1.0` — **rejected**: its deployed
  REST version returns `Model input is not valid: input tensor 'image' is not
  present` (code 3030), i.e. txt2img-only over REST despite the preview docs
  listing image fields. Stay on v1.5-img2img.

## Blocker: token can access zero accounts

- `tokens/verify` → `active` (token itself is valid).
- `GET /accounts` with this token → **empty list**; `GET /accounts/{id}` → 9109.
- First img2img attempt → HTTP 403, `AiError: This account is not allowed to
  access @cf/runwayml/stable-diffusion-v1-5-img2img` (code 5018) — same root
  cause, not a model problem.

**Fix (2 min, in the Cloudflare dashboard):**
1. Open Workers AI → **Use REST API**.
2. **Create a Workers AI API Token** via the prefilled template (don't hand-roll
   permissions) → copy the new token.
3. Copy the **Account ID** shown on that same page (must be the same account).
4. Re-run: `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/cf-img2img-test.mjs`
5. Open the output in `phase2-review/` and check: same garment (color/shape)?

## Neuron accounting (scripted, pending first success)

The script prints every usage/Neurons signal the response carries. Note: for
binary PNG image output the REST API exposes **no per-call Neurons field** —
expect to read usage from Workers AI dashboard analytics instead. The script
says so explicitly rather than inventing a number.
