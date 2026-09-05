import { cn } from "../lib/utils";

/** Brand mark: hanger + spark. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-6 w-6", className)} aria-hidden>
      <path
        d="M12 7.6 C12 6.4 13.9 6.6 13.9 5 A1.9 1.9 0 1 0 10.1 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 7.6 L3.8 15.4 C2.9 16.3 3.5 17.8 4.7 17.8 H19.3 C20.5 17.8 21.1 16.3 20.2 15.4 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M19.6 1.6 L20.3 3.4 L22.1 4.1 L20.3 4.8 L19.6 6.6 L18.9 4.8 L17.1 4.1 L18.9 3.4 Z"
        fill="var(--acc)"
        stroke="none"
      />
    </svg>
  );
}
