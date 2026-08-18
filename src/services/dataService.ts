import { supabase } from "./supabaseClient";
import type { Database } from "../types/database";
import type {
  AccessoryKind,
  Category,
  ColorFamily,
  Formality,
  Garment,
  Occasion,
  Outfit,
  SavedLook,
  Warmth,
} from "../types";

/**
 * Cloud sync layer (Supabase). Every call is a no-op when `supabase` is
 * null (mock mode) — the store stays the source of truth on-device and
 * these functions mirror writes to Postgres under RLS when configured.
 *
 * Row shapes follow the tables in /supabase/schema.sql.
 */

type WardrobeRow = Database["public"]["Tables"]["wardrobe_items"]["Row"];
type WardrobeInsert = Database["public"]["Tables"]["wardrobe_items"]["Insert"];
type OutfitRow = Database["public"]["Tables"]["outfits"]["Row"];
type OutfitInsert = Database["public"]["Tables"]["outfits"]["Insert"];

const CATEGORIES: Category[] = ["top", "bottom", "dress", "outerwear", "shoes", "accessory"];
const FAMILIES: ColorFamily[] = ["neutral", "warm", "cool", "earth", "accent"];
const OCCASIONS: Occasion[] = ["casual", "work", "date", "gym", "party"];
const KINDS: AccessoryKind[] = ["scarf", "cap", "bag"];

const clampWarmth = (n: number): Warmth =>
  n <= 1 ? 1 : n >= 3 ? 3 : 2;
const clampFormality = (n: number): Formality =>
  n <= 1 ? 1 : n >= 3 ? 3 : 2;

/* ---------------------------- row → model --------------------------- */

function rowToGarment(r: WardrobeRow): Garment {
  const category: Category = CATEGORIES.includes(r.category as Category)
    ? (r.category as Category)
    : "top";
  const tags = r.tags ?? [];
  const kind = tags.find((t): t is AccessoryKind =>
    KINDS.includes(t as AccessoryKind)
  );
  return {
    id: r.id,
    name: r.name,
    category,
    color: r.color,
    colorFamily: FAMILIES.includes(r.color_family as ColorFamily)
      ? (r.color_family as ColorFamily)
      : "neutral",
    warmth: clampWarmth(r.warmth),
    formality: clampFormality(r.formality_level),
    kind,
    photo: r.image_url ?? undefined,
    createdAt: new Date(r.created_at).getTime(),
  };
}

function garmentToInsert(userId: string, g: Garment): WardrobeInsert {
  const tags: string[] = g.kind ? [g.kind] : [];
  return {
    id: g.id.startsWith("g-") ? undefined : g.id, // local ids aren't uuids → let Postgres mint one
    user_id: userId,
    image_url: g.photo ?? null,
    category: g.category,
    color: g.color,
    color_family: g.colorFamily,
    warmth: g.warmth,
    name: g.name,
    season: [],
    formality_level: g.formality,
    tags,
  };
}

function outfitPieces(o: Outfit): Garment[] {
  return ["dress", "top", "bottom", "outer", "shoes", "accessory"]
    .map((k) => (o as Record<string, Garment | undefined>)[k])
    .filter((g): g is Garment => Boolean(g));
}

function rowToLook(r: OutfitRow, garments: Garment[]): SavedLook {
  const byId = new Map(garments.map((g) => [g.id, g]));
  const pickPiece = (cat: Category) =>
    r.item_ids
      .map((id) => byId.get(id))
      .find((g): g is Garment => !!g && g.category === cat);
  const outfit: Outfit = {
    top: pickPiece("top"),
    bottom: pickPiece("bottom"),
    dress: pickPiece("dress"),
    outer: pickPiece("outerwear"),
    shoes: pickPiece("shoes"),
    accessory: pickPiece("accessory"),
  };
  return {
    id: r.id,
    name: r.name,
    occasion: OCCASIONS.includes(r.occasion as Occasion)
      ? (r.occasion as Occasion)
      : "casual",
    outfit,
    rationale: r.rationale ?? "",
    engine: "heuristic",
    weatherTags: r.weather_tags ?? [],
    createdAt: new Date(r.created_at).getTime(),
  };
}

function lookToInsert(userId: string, look: SavedLook): OutfitInsert {
  return {
    id: look.id.startsWith("look-") ? undefined : look.id,
    user_id: userId,
    name: look.name,
    item_ids: outfitPieces(look.outfit).map((g) => g.id),
    weather_tags: look.weatherTags ?? [],
    occasion: look.occasion,
    rationale: look.rationale || null,
  };
}

/* ------------------------------ fetch ------------------------------- */

export async function fetchUserData(
  userId: string
): Promise<{ garments: Garment[]; looks: SavedLook[] }> {
  if (!supabase) return { garments: [], looks: [] };

  const [wRes, oRes] = await Promise.all([
    supabase
      .from("wardrobe_items")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabase
      .from("outfits")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
  ]);
  if (wRes.error) throw new Error(wRes.error.message);
  if (oRes.error) throw new Error(oRes.error.message);

  const garments = ((wRes.data as WardrobeRow[]) ?? []).map(rowToGarment);
  const looks = ((oRes.data as OutfitRow[]) ?? []).map((r) => rowToLook(r, garments));
  return { garments, looks };
}

/* ------------------------------ writes ------------------------------ */

/** Insert one garment; resolves the Postgres id (differs from local id). */
export async function insertGarmentRow(
  userId: string,
  g: Garment
): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("wardrobe_items")
    .insert(garmentToInsert(userId, g))
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null)?.id ?? null;
}

export async function deleteGarmentRow(id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("wardrobe_items").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function insertOutfitRow(
  userId: string,
  look: SavedLook
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("outfits").insert(lookToInsert(userId, look));
  if (error) throw new Error(error.message);
}

export async function deleteOutfitRow(id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("outfits").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
