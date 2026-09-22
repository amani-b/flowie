/**
 * Hand-maintained types for the Supabase schema defined in
 * /supabase/schema.sql. Keeps the client strongly typed without a
 * codegen step. Keep in sync with the SQL by hand.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          user_id: string;
          avatar_url: string | null;
          avatar_config: Json;
          body_metrics: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          avatar_url?: string | null;
          avatar_config?: Json;
          body_metrics?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          avatar_url?: string | null;
          avatar_config?: Json;
          body_metrics?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      wardrobe_items: {
        Row: {
          id: string;
          user_id: string;
          image_url: string | null;
          /** Cached studio rendering (data URL). Added by migration_render_url.sql; absent until applied. */
          render_url?: string | null;
          /** Phase 4 img2img final URL. Added by migration_studio_render_url.sql; absent until applied. */
          studio_render_url?: string | null;
          category: string;
          color: string;
          colors: string[]; // Array of hex values, ordered by prominence
          pattern: string; // solid | striped | colorblock | other
          color_family: string;
          warmth: number;
          name: string;
          season: string[];
          formality_level: number;
          tags: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          image_url?: string | null;
          render_url?: string | null;
          studio_render_url?: string | null;
          category: string;
          color: string;
          colors?: string[]; // Array of hex values
          pattern?: string; // solid | striped | colorblock | other
          color_family?: string;
          warmth?: number;
          name?: string;
          season?: string[];
          formality_level?: number;
          tags?: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          image_url?: string | null;
          render_url?: string | null;
          studio_render_url?: string | null;
          category?: string;
          color?: string;
          colors?: string[];
          pattern?: string;
          color_family?: string;
          warmth?: number;
          name?: string;
          season?: string[];
          formality_level?: number;
          tags?: string[];
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "wardrobe_items_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      outfits: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          item_ids: string[];
          weather_tags: string[];
          occasion: string;
          rationale: string | null;
          tags: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          item_ids?: string[];
          weather_tags?: string[];
          occasion?: string;
          rationale?: string | null;
          tags?: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          item_ids?: string[];
          weather_tags?: string[];
          occasion?: string;
          rationale?: string | null;
          tags?: string[];
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "outfits_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      schedules: {
        Row: {
          id: string;
          user_id: string;
          outfit_id: string;
          scheduled_date: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          outfit_id: string;
          scheduled_date: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          outfit_id?: string;
          scheduled_date?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "schedules_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "schedules_outfit_id_fkey";
            columns: ["outfit_id"];
            isOneToOne: false;
            referencedRelation: "outfits";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
