-- ============================================================================
-- Flowie — has_print migration (hybrid recon router signal, wearer-set)
--
-- Hybrid router verdict (Track 2, Sept 2026): TryOffDiff preserves
-- silhouette/color/construction but drops micro-graphics (GUESS side tape
-- omitted); FLUX.2-klein keeps prints legible but invents details on plain
-- garments. The wearer flags print garments (logos/graphics/text) in the
-- Closet detail sheet; the recon-garment Edge Function routes flagged
-- garments to the Klein Space, everything else to TryOffDiff.
--
-- No auto-detection: the analyzer stub cannot see prints. Absent/pre-
-- migration rows read as undefined → default TryOffDiff routing. Toggling
-- the flag clears the cached recon so the other renderer runs on demand.
--
-- Apply once in Supabase dashboard → SQL editor → Run. Client detects a
-- missing column and keeps working without it (like recon_url), so safe
-- to apply (or skip) at any time.
-- ============================================================================

alter table public.wardrobe_items
  add column if not exists has_print boolean not null default false;
