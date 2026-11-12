# FitFlow AI — Project Handoff

> ⚠️ **SUPERSEDED — DO NOT USE AS A HANDOFF.** This file is a stale snapshot
> from the 2026-09-23 session. Its phase numbering ("Phase 2 next"), its
> architecture table (`src/components/Avatar.tsx`), and its persist version
> (`v2`) no longer match the code. It is kept only for historical context and
> is retained in git history if deleted.
>
> The single authoritative engineering specification is
> `docs/ENGINEERING_EXECUTION_SPEC.md`; the single handoff prompt is
> `docs/IMPLEMENTER_HANDOFF.md`. The recon pipeline section below is still
> accurate and is mirrored in the spec.

> Read this first. It tells a fresh session everything needed to continue
> without rebuilding what already exists.

## What this is

FitFlow AI — a mobile-first PWA: smart closet, daily stylist, and outfit
visualizer. It reads live weather (Open-Meteo), composes outfits from the
user's closet (Gemini 2.5 Flash when keyed, on-device heuristic fallback
always), and previews them on a 2D layered mannequin avatar.

**Stack (fixed):** React 18 + TypeScript + Vite 6, Tailwind CSS v4 (tokens
in `src/index.css`, dark class strategy), Zustand + persist, Framer Motion,
lucide-react, Supabase (auth/Postgres/RLS/storage), Open-Meteo, Gemini.

## Build status

- ✅ **Phase 0** — app shell (frosted top bar, bottom nav, draggable drawer,
  ambient layered background, dark/light), 4 tabs (Today / Closet / Studio /
  Lookbook), 2D layered Avatar, heuristic stylist engine, weather service
  with offline fallback, image compression ≤ 1 MB, toasts/sheets/skeletons.
- ✅ **Phase 1** — Supabase typed client (`src/services/supabaseClient.ts`,
  null → mock mode), email auth + Google OAuth pathway, full-screen
  onboarding (avatar step is a deliberate placeholder), complete RLS schema
  (`supabase/schema.sql` — ALREADY APPLIED to the live project), cloud
  hydration + write-through sync (`src/services/dataService.ts`), mock
  dataset (demo user Ava, 12 garments, 3 looks), per-user data ownership
  (`ownerId` — prevents cross-account leakage on shared devices).
- ⏳ **User-side config remaining** (Supabase/Google dashboards, see below).
- 🔜 **Phase 2 (next):** avatar customization lab (skin tone / body shape
  stored in `profiles.avatar_config`), garment photo upload to the
  `wardrobe` storage bucket, schedule/calendar screen (uses `schedules`
  table + `date-fns` already installed), 7-day forecast strip in Today.

## Architecture map

| Path | Responsibility |
|---|---|
| `src/store/appStore.ts` | Single Zustand store: session, shell, data, weather, generation. Persisted (`fitflow-store` v2). All cloud mutations go through here. |
| `src/services/supabaseClient.ts` | Typed client singleton; `isSupabaseConfigured` gates live vs mock. |
| `src/services/authService.ts` | signUp/signIn/Google/demo/session-restore; mock mode simulates full flow on-device. |
| `src/services/dataService.ts` | Row ↔ model mapping for `wardrobe_items`/`outfits`; fetch + insert/delete. |
| `src/services/stylist.ts` | Gemini call + heuristic scoring engine (color harmony, warmth/formality targets, weather rules). |
| `src/services/weather.ts` | Open-Meteo: geolocation → default city → static fallback. |
| `src/components/Avatar.tsx` | Layered mannequin: shoes → bottom/dress → top → outer → accessory. |
| `src/screens/*` | AuthScreen, Onboarding, Home, Closet, Studio, Looks. |
| `src/types/database.ts` | Hand-maintained row types matching `supabase/schema.sql`. |

## Data model quick reference

- `Garment { id, name, category, color, colorFamily, warmth 1-3, formality 1-3, kind?, photo? }`
- `Outfit { top?, bottom?, dress?, outer?, shoes?, accessory? }`
- `SavedLook { id, name, occasion, outfit (snapshot), rationale, engine, weatherTags, createdAt }`
- Local-only ids use prefixes `g-` / `look-`; Postgres mints uuids on insert
  (store updates are local-first, sync failures degrade to toasts).

## Conventions to keep

- Design tokens live in CSS vars (`--acc`, `--surface`, …) mapped to
  Tailwind via `@theme inline`. Type: **Syne** (display) + **Manrope** (body).
- Every external integration branches: no Supabase keys → mock mode; no
  Gemini key / quota hit → heuristic; no network → simulated weather.
- Mutations are optimistic-local with fire-and-forget cloud writes.
- Two-tap confirm for destructive actions; no browser alerts ever.

## Environment for a NEW session

1. `npm install` then `npm i zustand` (only dep not in the base template).
2. Create `.env` (gitignored — never commit it):
   ```
   VITE_SUPABASE_URL=https://sjxbrpjovqtzuquhufav.supabase.co
   VITE_SUPABASE_ANON_KEY=<paste — Supabase dashboard → Project Settings → API>
   VITE_GEMINI_API_KEY=<optional — Google AI Studio>
   ```
   ⚠️ No `/rest/v1` suffix on the URL. Only the **anon** key — never service_role.
3. `npm run dev` / `npm run build`.

## External state (survives any sandbox reset)

- **Supabase project `sjxbrpjovqtzuquhufav`:** schema + RLS + triggers +
  storage buckets applied; email provider on.
- **Still to configure there:** Google provider (Client ID + Secret from
  Google Cloud Console), URL Configuration → Site URL & Redirect URLs
  (add `https://*.preview.qwenlm.io/**` — preview subdomains rotate),
  optionally disable "Confirm email" for faster testing.
- **Google Cloud Console:** OAuth client needs the callback
  `https://sjxbrpjovqtzuquhufav.supabase.co/auth/v1/callback` in Authorized
  redirect URIs; consent screen External + test users (fixes the 403).
- The OAuth wiring checklist is also in-app: Settings drawer → "Google OAuth wiring".

## First message for the next chat

> "Read HANDOFF.md. This is FitFlow AI — Phases 0–1 are done and building.
> Continue with Phase 2: [task]. Don't rebuild existing layers."

---

## Garment reconstruction pipeline (ACTIVE workstream, 2026-09-23)

Single source of truth: original photo → analyzer stub (full-frame bbox,
Qwen3-VL-8B pending) → `recon-garment` Edge Function → renderer by
garment.hasPrint (TryOffDiff default, Klein for print) → recon PNG on
`garment.reconUrl` (+ `recon_url` column) → GarmentPhoto shows recon,
SVG skeleton underneath while pending.

- **Renderer (default):** TryOffDiffv2-MGT via YOUR Space
  `amani-b/garment-flat-lay-flowie` (Gradio SDK, ZeroGPU hw, 30 s reserved).
  Engine source mirrored at `D:\Projects\flowie-app\hf-tryoff\`.
  Easy case (navy trousers) PASS; hard case (GUESS shorts) shape/color PASS,
  micro-print dropped (measured limitation — routed around, not fixed).
- **Renderer (detail):** FLUX.2-klein-base-4B via YOUR Space
  `amani-b/klein-garment-test` (Apache-2.0, public, ~13 GB VRAM, 60 s
  reserved; source at `hf-klein/`). Track 2 verdict (2 bounded calls,
  Sept 2026): GUESS tape legible where TryOffDiff drops it — BUT invents
  drawstring + side stripes on plain navy trousers and shifts color
  saturation. Wearer-set `hasPrint` flag decides (stub analyzer cannot
  detect prints); ready tiles show "· detail render" for Klein builds.
- **Harness:** `scripts/recon-harness.mjs` — saves every intermediate to
  `recon-work/<slug>/` (original, analysis.json, bbox.json, crop.jpg,
  recon-raw.png, chroma.png, final.png, qa.json). `--tryoff` for remote,
  `--klein` for the detail Space (bounded tests only),
  `--selftest` for zero-quota end-to-end (synthetic chroma fixture),
  `--bbox=x,y,w,h` for worn-photo boxes. Backend creds from `.env`:
  `HF_TRYOFF_SPACE_ID`, `HF_KLEIN_SPACE_ID`, `HF_TOKEN` (never hardcoded,
  no `VITE_` prefix).
- **Edge Function:** `supabase/functions/recon-garment/` (replaces retired
  `enhance-garment` + `flatlay-tryoff`). Deploy:
  `supabase functions deploy recon-garment --no-verify-jwt`, secrets
  `HF_TRYOFF_SPACE_ID` + `HF_KLEIN_SPACE_ID` + `HF_TOKEN`. Delete the two
  retired functions from the dashboard.
- **DB:** apply `supabase/migration_recon_url.sql` + new
  `supabase/migration_has_print.sql` once each (dashboard → SQL editor).
  Client works without them (column guards), SVG skeleton unaffected.
  `studio_render_url` (FLUX re-light) is retired — never written; legacy
  values ignored even when present.
- **Quota (free):** 30 s tryoff / 60 s klein reserved per call → ~4 recon/day
  budget client-side (`RECON_DAILY_BUDGET`), shared ZeroGPU pool (5 min/day).
  Check remainder at https://huggingface.co/settings/billing.
- **Retired 2026-09-23:** `studioComposite` (ISNet), `studioEnhance`
  (FLUX-schnell), `studioTryoff` (whole-image caller), `studioFlatlay`
  (Gemini billable), `closetUpgrade` bulk rollout, schnell `hf-space/`,
  old test scripts, `@imgly/*`, `@huggingface/inference|transformers`,
  `puppeteer-core`. Persist v12 scrubs old rendering fields. SVG
  (`studioRender.ts`) stays ONLY as the dumb loading skeleton.
- **Parked:** `hf-qwen/` self-hosted Qwen-Image-Edit-2511
  (`amani-b/flowie-qwen-edit`): 20B bf16 OOMs free ZeroGPU at weight-pack
  time (NVML/CUDACachingAllocator assert — model-loading failure, NOT auth
  or scheduler; verified via Space UI test). Do NOT retry on free tier
  without FP8/smaller weights. Official Qwen Space scheduler-blocked
  (180 s refused).
