-- ============================================================================
-- Flowie — Phase 4: studio_render_url migration (img2img final, cached once)
--
-- Three distinct images per garment (never conflate):
--   image_url         = original upload photo (sacred, untouched)
--   studioComposite   = Phase 1 local composite (on-device only, NOT synced)
--   studio_render_url = Phase 2/3 img2img final (this column, Supabase-side)
--
-- Flow: upload → Phase 1 composite (local) → Edge Function enhance-garment
-- calls the FLUX.1-schnell Space ONCE (strength 0.3, 4 steps, seed 42),
-- uploads the result to the `wardrobe` bucket as
--   <userId>/<garmentId>-studio.jpg
-- and writes its public URL here. Display precedence in GarmentPhoto:
--   studio_render_url > studioComposite > SVG rendering (fallback).
--
-- Apply once in Supabase dashboard → SQL editor → Run. Client detects a
-- missing column and keeps syncing without it (like render_url), so safe
-- to apply (or skip) at any time. SVG fallback is unaffected either way.
-- ============================================================================

alter table public.wardrobe_items
  add column if not exists studio_render_url text;
