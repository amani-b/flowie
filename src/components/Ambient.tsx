/**
 * Layered ambient background: two slow-drifting colour glows, a fine noise
 * grain and a soft vignette. Sits behind everything.
 *
 * Phase 4 (RC-8) — calmed down:
 *  - travel roughly halved and durations raised (44s/56s), so the glows read
 *    as light rather than as something sliding behind the content;
 *  - the wrapper drops to 0.72 opacity, which also lifts text contrast a touch
 *    against the brightest part of a glow;
 *  - both glow layers carry `data-ambient-glow` so the `prefers-reduced-motion`
 *    block in index.css can freeze them in place instead of collapsing the
 *    animation to 0.01ms (which would snap them to their end offset).
 */
export default function Ambient() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-bg">
      <div className="absolute inset-0 opacity-[0.72]">
        <div
          data-ambient-glow
          className="absolute -top-[20%] -left-[25%] h-[70vmax] w-[70vmax] rounded-full"
          style={{
            background: "radial-gradient(circle, var(--glow-a) 0%, transparent 62%)",
            animation: "drift-a 44s ease-in-out infinite alternate",
          }}
        />
        <div
          data-ambient-glow
          className="absolute -bottom-[25%] -right-[25%] h-[75vmax] w-[75vmax] rounded-full"
          style={{
            background: "radial-gradient(circle, var(--glow-b) 0%, transparent 60%)",
            animation: "drift-b 56s ease-in-out infinite alternate",
          }}
        />
      </div>
      {/* grain */}
      <div
        className="absolute inset-0 opacity-[0.05] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E\")",
        }}
      />
      {/* vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, transparent 55%, var(--bg-deep) 130%)",
          opacity: 0.55,
        }}
      />
    </div>
  );
}
