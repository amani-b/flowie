-- ============================================================================
-- FitFlow AI — Supabase schema (Phase 1)
-- Run this in the Supabase SQL editor (or via `supabase db push`).
--
-- Tables: profiles, wardrobe_items, outfits, schedules
-- Security: RLS enabled on every table with explicit per-operation policies.
--           Every row is owned by exactly one auth user; nobody can read,
--           write, update or delete anyone else's rows.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. profiles — one row per auth user (auto-provisioned on signup)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  avatar_url    text,
  avatar_config jsonb not null default '{}'::jsonb,   -- skin tone, body shape, hair…
  body_metrics  jsonb,                                -- {heightCm, weightKg, chestCm, …}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "profiles_delete_own"
  on public.profiles for delete
  using (auth.uid() = user_id);

-- Auto-create a profile row whenever a new user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep updated_at honest.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. wardrobe_items — the closet
--    Spec columns: id, user_id, image_url, category, color, season,
--    formality_level, tags[], created_at — plus additive styling metadata.
-- ----------------------------------------------------------------------------
create table if not exists public.wardrobe_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  image_url       text,                                  -- Storage object URL (bucket: wardrobe)
  category        text not null check (category in
                    ('top', 'bottom', 'dress', 'outerwear', 'shoes', 'accessory')),
  color           text not null,                         -- hex, e.g. '#3A4A63' (primary/dominant)
  colors          text[] not null default '{}',          -- Array of hex values, ordered by prominence
  pattern         text not null default 'solid' check (pattern in
                    ('solid', 'striped', 'colorblock', 'other')),
  color_family    text not null default 'neutral' check (color_family in
                    ('neutral', 'warm', 'cool', 'earth', 'accent')),
  warmth          int  not null default 2 check (warmth between 1 and 3),
  name            text not null default 'Untitled piece',
  season          text[] not null default '{}',          -- e.g. {spring, summer}
  formality_level int  not null default 1 check (formality_level between 1 and 3),
  tags            text[] not null default '{}',
  created_at      timestamptz not null default now()
);

create index if not exists wardrobe_items_user_idx
  on public.wardrobe_items (user_id, created_at desc);

alter table public.wardrobe_items enable row level security;

create policy "wardrobe_select_own"
  on public.wardrobe_items for select
  using (auth.uid() = user_id);

create policy "wardrobe_insert_own"
  on public.wardrobe_items for insert
  with check (auth.uid() = user_id);

create policy "wardrobe_update_own"
  on public.wardrobe_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "wardrobe_delete_own"
  on public.wardrobe_items for delete
  using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 3. outfits — saved looks (references wardrobe items by id)
-- ----------------------------------------------------------------------------
create table if not exists public.outfits (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  item_ids     uuid[] not null default '{}',             -- wardrobe_items.id members
  weather_tags text[] not null default '{}',             -- e.g. {mild, dry}
  occasion     text not null default 'casual' check (occasion in
                 ('casual', 'work', 'date', 'gym', 'party')),
  rationale    text,                                     -- stylist commentary
  tags         text[] not null default '{}',             -- e.g. {workwear, summer}
  created_at   timestamptz not null default now()
);

-- Additive migration for tags column (safe to run multiple times)
alter table public.outfits add column if not exists tags text[] not null default '{}';

create index if not exists outfits_user_idx
  on public.outfits (user_id, created_at desc);

alter table public.outfits enable row level security;

create policy "outfits_select_own"
  on public.outfits for select
  using (auth.uid() = user_id);

create policy "outfits_insert_own"
  on public.outfits for insert
  with check (auth.uid() = user_id);

create policy "outfits_update_own"
  on public.outfits for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "outfits_delete_own"
  on public.outfits for delete
  using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4. schedules — which outfit is pinned to which day
-- ----------------------------------------------------------------------------
create table if not exists public.schedules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  outfit_id      uuid not null references public.outfits (id) on delete cascade,
  scheduled_date date not null,
  created_at     timestamptz not null default now(),
  unique (user_id, outfit_id, scheduled_date)
);

create index if not exists schedules_user_date_idx
  on public.schedules (user_id, scheduled_date);

alter table public.schedules enable row level security;

create policy "schedules_select_own"
  on public.schedules for select
  using (auth.uid() = user_id);

create policy "schedules_insert_own"
  on public.schedules for insert
  with check (auth.uid() = user_id);

create policy "schedules_update_own"
  on public.schedules for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "schedules_delete_own"
  on public.schedules for delete
  using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 5. Storage buckets — garment photos + avatar renders.
--    Objects live under a folder named after the owner's user id, and only
--    that user may write or delete inside their own folder.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wardrobe', 'wardrobe', true),
       ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- wardrobe bucket
create policy "wardrobe_objects_public_read"
  on storage.objects for select
  using (bucket_id = 'wardrobe');

create policy "wardrobe_objects_owner_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "wardrobe_objects_owner_update"
  on storage.objects for update
  using (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "wardrobe_objects_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- avatars bucket
create policy "avatars_objects_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars_objects_owner_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_objects_owner_update"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_objects_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- Done. Enable Email provider under Authentication → Providers, and add
-- Google OAuth there to light up the "Continue with Google" button.
-- ============================================================================
