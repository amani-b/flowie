/** Reusable skeleton blocks (shimmer handled in CSS). */

export function WeatherSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="skeleton h-3 w-32" />
      <div className="flex items-end gap-4">
        <div className="skeleton h-16 w-32 !rounded-2xl" />
        <div className="skeleton mb-1 h-8 w-24" />
      </div>
      <div className="flex gap-2">
        <div className="skeleton h-7 w-20 !rounded-full" />
        <div className="skeleton h-7 w-24 !rounded-full" />
        <div className="skeleton h-7 w-20 !rounded-full" />
      </div>
    </div>
  );
}

export function LookSkeleton() {
  return (
    <div className="flex gap-4" aria-hidden>
      <div className="flex-1 space-y-3">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-4/5" />
        <div className="skeleton h-4 w-3/5" />
        <div className="flex gap-2 pt-2">
          <div className="skeleton h-9 w-32 !rounded-full" />
          <div className="skeleton h-9 w-24 !rounded-full" />
        </div>
      </div>
      <div className="skeleton h-44 w-28 shrink-0 !rounded-3xl" />
    </div>
  );
}

export function StudioSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="mx-auto h-52 w-32">
        <div className="skeleton h-full w-full !rounded-[28px]" />
      </div>
      <div className="mx-auto space-y-2.5">
        <div className="skeleton mx-auto h-4 w-3/4" />
        <div className="skeleton mx-auto h-4 w-1/2" />
      </div>
      <div className="flex justify-center gap-2 pt-1">
        <div className="skeleton h-8 w-28 !rounded-full" />
        <div className="skeleton h-8 w-28 !rounded-full" />
      </div>
    </div>
  );
}
