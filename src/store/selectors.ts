/**
 * Narrow store selectors.
 *
 * Why this exists: screens subscribed to WHOLE COLLECTIONS —
 * `useAppStore((s) => s.garments)` — so every mutation of any garment
 * re-rendered every consumer (RC-2). With a recon batch in flight that is a
 * store write per stage event per garment, and each one re-rendered the whole
 * grid. Phase 3 replaces those with the hooks below.
 *
 * The rule these hooks encode, in preference order:
 *   1. select a PRIMITIVE or a single record → zustand's default `Object.is`
 *      comparison is already correct and cheapest;
 *   2. select a DERIVED LIST → return ids or a shallow-compared projection, not
 *      the live array, so a no-op mutation cannot produce a new reference and
 *      re-render everything;
 *   3. never return a freshly-built array/object without a comparator.
 *
 * `useShallow` is imported from zustand rather than hand-rolled so the
 * equality semantics stay the library's. Note it does a ONE-level comparison,
 * which is why every hook below returns a flat array (ids, or a list of
 * primitives) and never an array of objects built on the fly.
 */

import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store/appStore";
import type { Garment, SavedLook } from "../types";

/**
 * The garment collection, SELECTED BY IDENTITY rather than by mutation.
 *
 * The problem this solves: `useAppStore((s) => s.garments)` returns a new array
 * reference on every `set()`, so any single garment's status tick re-rendered
 * every consumer of the list (RC-2). `flushPendingWrites`/`applyReconPatch`
 * write per garment, per stage — so with a batch in flight that is many
 * re-renders of the whole grid for one tile's change.
 *
 * Why this one hook returns the array anyway: Studio and Closet genuinely
 * reduce + filter the WHOLE collection (colour-matching over every garment,
 * category buckets for the manual picker, the closet grid itself). Returning
 * ids would just force every consumer to re-`find` on each render. So the fix
 * is not "narrow the data" but "make no-op mutations not count": `useShallow`
 * compares the array one level deep, i.e. by element reference. A patch to
 * garment X builds a new object for X only, so the array differs → re-render;
 * a store write that leaves garments untouched (weather, toasts, generation
 * status) produces the same element references → no re-render. That is
 * precisely the re-render storm we are removing, removed.
 *
 * Phase 3's actual requirement is that a tile renders from ITS own record —
 * see `useGarment(id)` — and `GarmentCard` is memoised on that. Consumers of
 * this hook are the screens that must see all of them.
 */
export function useGarments(): Garment[] {
  return useAppStore(useShallow((s) => s.garments));
}

/**
 * The look collection, same identity-comparison rationale as `useGarments`.
 * Looks.tsx filters every look against the search query, so it needs the set.
 */
export function useLooks(): SavedLook[] {
  return useAppStore(useShallow((s) => s.looks));
}

/**
 * One garment by id. The single most useful selector: a tile, a detail sheet
 * or a reconciliation reads the record it actually renders, so an unrelated
 * garment's mutation cannot re-render it.
 *
 * The equality is the store's default (`Object.is` on the record reference),
 * which is exactly right — `applyReconPatch` and the other patches build new
 * record objects only for the garment they touch.
 */
export function useGarment(id: string | null | undefined): Garment | undefined {
  return useAppStore((s) => (id ? s.garments.find((g) => g.id === id) : undefined));
}

/** Garment ids only. A list of primitives shallow-compares correctly. */
export function useGarmentIds(): string[] {
  return useAppStore(useShallow((s) => s.garments.map((g) => g.id)));
}

/** Look ids only. */
export function useLookIds(): string[] {
  return useAppStore(useShallow((s) => s.looks.map((l) => l.id)));
}

/** Schedule ids only. */
export function useScheduleIds(): string[] {
  return useAppStore(useShallow((s) => s.schedules.map((sc) => sc.id)));
}

/** How many garments the closet holds — cheap, and enough for empty states. */
export function useGarmentCount(): number {
  return useAppStore((s) => s.garments.length);
}

/** How many looks are saved. */
export function useLookCount(): number {
  return useAppStore((s) => s.looks.length);
}

/**
 * The most recent `n` looks, for the Home carousel.
 *
 * Narrower than `s.looks` on purpose: Home shows six, so a mutation to the
 * twentieth look must not re-render it. `useShallow` compares the array
 * one level deep, i.e. by element reference — and look objects only get a new
 * reference when that specific look changes, so this is both correct and
 * cheap. (`slice` returns a new array each call, which is exactly what the
 * shallow comparator exists to absorb.)
 */
export function useRecentLooks(n: number): SavedLook[] {
  return useAppStore(useShallow((s) => s.looks.slice(0, n)));
}

/**
 * Looks by id. Callers that render look objects can resolve the subset they
 * actually display, instead of subscribing to the whole collection.
 */
export function useLookById(id: string | null | undefined): SavedLook | undefined {
  return useAppStore((s) => (id ? s.looks.find((l) => l.id === id) : undefined));
}

/** Whether a given set of onboarded user ids covers the current user. */
export function useIsOnboarded(): boolean {
  return useAppStore((s) => {
    const u = s.user;
    return !!u && s.onboardedUsers.includes(u.id);
  });
}

/**
 * date key (YYYY-MM-DD) -> the look scheduled on it.
 *
 * Calendar previously held two whole-array subscriptions (`s.looks`,
 * `s.schedules`) and re-derived `scheduleMap` from both in a `useMemo`, so it
 * re-rendered on ANY look or schedule mutation — including a look renamed
 * three screens away. The map is derived here inside the selector instead, and
 * `useShallow` compares it by value: a rebuild that produces the same
 * date -> look-id pairs is a no-op even though the Map object is new.
 *
 * The value type is deliberately `string | undefined` (the look ID) rather
 * than `SavedLook`: `useShallow` only compares one level, and comparing a
 * nested object graph by reference would silently miss renamed looks. Ids are
 * primitives, so the comparison is exact. Callers resolve the record with
 * `useLookById`.
 */
export function useScheduleMap(): Record<string, string | undefined> {
  return useAppStore(
    useShallow((s) => {
      const byId = new Map(s.looks.map((l) => [l.id, l]));
      const out: Record<string, string | undefined> = {};
      for (const sch of s.schedules) {
        if (byId.has(sch.outfitId)) out[sch.scheduledDate] = sch.outfitId;
      }
      return out;
    })
  );
}

/**
 * `YYYY-MM-DD` keys of every scheduled day, newest first.
 *
 * A list of primitives, so `useShallow` is exact. Calendar only needs to know
 * WHICH days are booked to draw the dots and decide whether to show the empty
 * state; the look behind each key is resolved per-day at render.
 */
export function useScheduleDateKeys(): string[] {
  return useAppStore(
    useShallow((s) =>
      s.schedules
        .map((sch) => sch.scheduledDate)
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    )
  );
}

/** The day keys that are booked, as a Set for O(1) membership in the grid. */
export function useScheduledDateSet(): Set<string> {
  return useAppStore(
    useShallow((s) => new Set(s.schedules.map((sch) => sch.scheduledDate)))
  );
}

/**
 * The look id scheduled on a specific date, if any — for the day cell that
 * resolves its own preview. Primitive equality, so untouched days never
 * re-render.
 */
export function useLookIdForDate(dateKey: string): string | undefined {
  return useAppStore((s) => s.schedules.find((sc) => sc.scheduledDate === dateKey)?.outfitId);
}
