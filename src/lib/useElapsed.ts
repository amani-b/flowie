/**
 * Elapsed seconds since `startedAt`, ticking once per second.
 *
 * Used by the background-job UI. Recon reports no percentage, so elapsed time
 * against the known ceiling is the only truthful "progress" signal available —
 * and it doubles as proof a job is still alive rather than wedged.
 *
 * Returns 0 when `startedAt` is undefined (not started yet).
 */

import { useEffect, useState } from "react";

export function useElapsedSeconds(startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    // Reset on change: a second job must not inherit the first one's clock.
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  if (!startedAt) return 0;
  return Math.max(0, Math.round((now - startedAt) / 1000));
}
