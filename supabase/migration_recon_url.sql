-- ============================================================================
-- Flowie — recon_url migration (garment reconstruction render, cached once)
--
-- One image per garment from the new pipeline (never conflate):
--   image_url = original upload photo (sacred, untouched)
--   recon_url = TryOffDiff reconstruction final (this column)
--   render_url = procedural SVG skeleton (instant, on-device, local only)
--
-- Flow: upload → analyzer stub (full-frame bbox) → Edge Function
-- recon-garment calls the TryOffDiff Space ONCE (class-locked, seed 42)
-- and the client caches the returned PNG data URL here. Display precedence
-- in GarmentPhoto: recon_url > SVG rendering (skeleton).
--
-- Supersedes migration_studio_render_url.sql (studio_render_url, FLUX
-- schnell re-light — retired) and the local-only studioComposite /
-- studioFlatLay fields (segmentation / flat-lay callers — retired).
--
-- Apply once in Supabase dashboard → SQL editor → Run. Client detects a
-- missing column and keeps working without it (like render_url), so safe
-- to apply (or skip) at any time. SVG skeleton is unaffected either way.
-- ============================================================================

alter table public.wardrobe_items
  add column if not exists recon_url text;
