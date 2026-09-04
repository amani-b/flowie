import type { CSSProperties } from "react";
import { useAppStore } from "../store/appStore";
import type { BodyShape, Outfit } from "../types";
import Avatar from "./Avatar";

/**
 * FitAvatar — the mannequin dressed in the user's fit-model settings.
 * Skin tone + body shape come from the onboarding profile and apply purely
 * as a CSS wrapper (custom property + horizontal scale). Avatar.tsx itself
 * is untouched: no shape/path changes, theme default when unset.
 */

export const SKIN_TONES: Array<{ hex: string; label: string }> = [
  { hex: "#F6DCC8", label: "Porcelain" },
  { hex: "#E9B98F", label: "Sand" },
  { hex: "#C68A5B", label: "Honey" },
  { hex: "#8D5A3B", label: "Umber" },
  { hex: "#54341F", label: "Espresso" },
];

export const BODY_SHAPES: Array<{ id: BodyShape; label: string; scale: number }> = [
  { id: "slim", label: "Slim", scale: 0.9 },
  { id: "average", label: "Average", scale: 1 },
  { id: "athletic", label: "Athletic", scale: 1.07 },
  { id: "curvy", label: "Curvy", scale: 1.14 },
];

export function bodyScale(shape: BodyShape | undefined): number {
  return BODY_SHAPES.find((b) => b.id === shape)?.scale ?? 1;
}

export default function FitAvatar({
  outfit,
  className,
  animateKey,
}: {
  outfit: Outfit;
  className?: string;
  animateKey?: string | number;
}) {
  const profile = useAppStore((s) => s.profile);
  const skin = profile?.avatarConfig?.skinTone;
  const scale = bodyScale(profile?.avatarConfig?.bodyShape);
  const style = {
    ...(skin ? ({ "--mannequin": skin } as CSSProperties) : {}),
    ...(scale !== 1
      ? { transform: `scaleX(${scale})`, transformOrigin: "center top" }
      : {}),
  } as CSSProperties;
  return (
    <div className={className} style={style}>
      <Avatar outfit={outfit} animateKey={animateKey} className="w-full" />
    </div>
  );
}
