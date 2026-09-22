-- ============================================================================
-- Flowie — render_url migration (studio renderings live on the record)
--
-- The app caches each garment's studio rendering (an SVG data URL, a few KB)
-- on the garment record next to the original photo, generated once and
-- loaded on every screen without re-rendering. Without this column the app
-- still works: it re-derives the identical rendering deterministically from
-- the garment's own fields — but applying the migration makes the cache
-- roam across devices with the rest of the row.
--
-- Apply once in the Supabase dashboard → SQL editor → Run.
-- The client detects a missing column automatically and keeps syncing
-- without it, so this is safe to apply (or skip) at any time.
-- ============================================================================

alter table public.wardrobe_items
  add column if not exists render_url text;
