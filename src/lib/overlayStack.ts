/**
 * A LIFO registry of dismissible overlays — currently just the bottom `Sheet`.
 *
 * Why this exists at all: `Sheet` takes `open` / `onClose` as *props*, so the
 * open state lives in whichever screen rendered it (Closet's detail sheet,
 * Studio's picker, and so on). The Android hardware back button is handled
 * centrally, and that handler has no way to see those local states. The
 * alternative — pushing "which sheet is open" through the Zustand store —
 * would mean every screen keeping a global flag in sync with its local
 * boolean, which is exactly the kind of duplicated state that drifts.
 *
 * So overlays announce themselves here while they are open, and the back
 * handler asks for the top one. No React, no Capacitor, no store.
 */

type Close = () => void;

const stack: Close[] = [];

/**
 * Register an open overlay. Returns the unregister function; call it on
 * unmount *and* when the overlay closes.
 */
export function pushOverlay(close: Close): () => void {
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i !== -1) stack.splice(i, 1);
  };
}

export function hasOverlay(): boolean {
  return stack.length > 0;
}

/**
 * Close the most recently opened overlay. Returns false when there is none,
 * so the caller can fall through to the next step of the back chain.
 *
 * The entry is popped *before* `close()` runs: closing typically triggers a
 * re-render that unmounts the overlay and fires its unregister function, which
 * would otherwise splice the stack out from under this call.
 */
export function closeTopOverlay(): boolean {
  const close = stack[stack.length - 1];
  if (!close) return false;
  stack.pop();
  close();
  return true;
}
