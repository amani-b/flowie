import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Calendar, ChevronLeft, ChevronRight, Clock, Trash2 } from "lucide-react";
import { useAppStore } from "../store/appStore";
import {
  useLooks,
  useScheduleDateKeys,
  useScheduleMap,
} from "../store/selectors";
import { cn, timeAgo } from "../lib/utils";
import type { SavedLook } from "../types";
import OutfitBoard from "../components/OutfitBoard";
import Sheet from "../components/Sheet";
import { OCCASION_META } from "../lib/utils";

/**
 * Calendar view for scheduling outfits.
 * Shows a week-at-a-glance with the ability to:
 * - View what's scheduled for each day
 * - Assign an outfit to a date
 * - See worn history (derived from past schedules)
 */

type CalendarViewMode = "week" | "month" | "history";

function getWeekDates(baseDate: Date = new Date()): Date[] {
  const dates: Date[] = [];
  const startOfWeek = new Date(baseDate);
  // Start from Monday
  const day = startOfWeek.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  startOfWeek.setDate(startOfWeek.getDate() + diff);
  startOfWeek.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function getMonthDates(baseDate: Date = new Date()): Date[] {
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  
  // Start from Monday of the week containing the 1st
  const startDay = firstDayOfMonth.getDay();
  const startDate = new Date(firstDayOfMonth);
  startDate.setDate(startDate.getDate() + (startDay === 0 ? -6 : 1 - startDay));
  
  const dates: Date[] = [];
  for (let i = 0; i < 42; i++) { // 6 weeks x 7 days
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function formatDateKey(date: Date): string {
  return date.toISOString().split("T")[0];
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface ScheduleSheetProps {
  date: Date;
  scheduledLook: SavedLook | null;
  availableLooks: SavedLook[];
  onAssign: (lookId: string) => void;
  onClear: () => void;
  onClose: () => void;
}

function ScheduleSheet({
  date,
  scheduledLook,
  availableLooks,
  onAssign,
  onClear,
  onClose,
}: ScheduleSheetProps) {
  const [selectedId, setSelectedId] = useState<string | null>(scheduledLook?.id ?? null);

  const displayDate = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <Sheet open={!!date} onClose={onClose} title={displayDate}>
      <div className="space-y-4">
        {scheduledLook && (
          <div className="card rounded-[20px] p-4">
            <p className="label-micro mb-2">Currently scheduled</p>
            <OutfitBoard outfit={scheduledLook.outfit} className="mx-auto max-w-[240px]" />
            <p className="mt-2 text-center text-[13px] font-extrabold">{scheduledLook.name}</p>
            <p className="text-center text-[11px] font-bold text-mut">
              {OCCASION_META[scheduledLook.occasion].label} · {timeAgo(scheduledLook.createdAt)}
            </p>
          </div>
        )}

        <div>
          <p className="label-micro mb-2">Choose an outfit</p>
          {availableLooks.length === 0 ? (
            <p className="rounded-[14px] border border-line bg-card px-4 py-3 text-center text-[12.5px] font-medium text-mut">
              No saved looks yet. Style something in the Studio first.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {availableLooks.map((look) => (
                <button
                  key={look.id}
                  onClick={() => setSelectedId(look.id)}
                  className={cn(
                    "rounded-[14px] border p-2 text-left transition active:scale-98",
                    selectedId === look.id
                      ? "border-acc bg-accsoft"
                      : "border-line bg-card hover:border-linestrong"
                  )}
                >
                  <OutfitBoard outfit={look.outfit} compact staticBoard />
                  <p className="mt-1 truncate text-[11px] font-extrabold">{look.name}</p>
                  <p className="text-[11px] font-bold text-mut">
                    {OCCASION_META[look.occasion].label}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => {
              if (selectedId && selectedId !== scheduledLook?.id) {
                onAssign(selectedId);
                onClose();
              } else {
                onClose();
              }
            }}
            disabled={!selectedId || !availableLooks.length}
            className="flex-1 rounded-full bg-acc py-3 text-[13px] font-extrabold text-accink transition disabled:opacity-50 active:scale-98"
          >
            {scheduledLook && selectedId === scheduledLook.id ? "Keep as is" : "Schedule this"}
          </button>
          {scheduledLook && (
            <button
              onClick={() => {
                onClear();
                onClose();
              }}
              className="flex items-center justify-center gap-2 rounded-full border border-line px-4 py-3 text-[13px] font-extrabold text-mut transition active:scale-98"
            >
              <Trash2 className="h-4 w-4" /> Clear
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

// Group schedules by month for history view
function groupSchedulesByMonth(schedules: Array<{ date: Date; look: SavedLook }>) {
  const groups = new Map<string, Array<{ date: Date; look: SavedLook }>>();
  schedules.forEach((item) => {
    const key = item.date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  });
  return Array.from(groups.entries());
}

export default function CalendarView() {
  const scheduleLook = useAppStore((s) => s.scheduleLook);
  const clearSchedule = useAppStore((s) => s.clearSchedule);
  const setTab = useAppStore((s) => s.setTab);

  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const weekDates = getWeekDates(new Date(Date.now() + weekOffset * 7 * 86_400_000));
  const monthDates = getMonthDates(new Date(new Date().setMonth(new Date().getMonth() + monthOffset)));
  const today = formatDateKey(new Date());

  /**
   * date key -> look ID, derived inside the store selector.
   *
   * This replaces a `useMemo` over two whole-array subscriptions
   * (`s.looks`, `s.schedules`), which re-derived and re-rendered the entire
   * calendar on ANY look mutation anywhere in the app. The selector compares
   * by value, so a store write that does not change which look sits on which
   * day is a no-op.
   */
  const scheduleMap = useScheduleMap();

  // Records by id, for resolving the IDs the selectors hand back. `useLooks`
  // shallow-compares by element reference, so this only changes when a look
  // record itself is replaced.
  const looks = useLooks();
  const looksById = useMemo(() => new Map(looks.map((l) => [l.id, l])), [looks]);

  const getLookForDate = (dateKey: string) => {
    const id = scheduleMap[dateKey];
    return (id ? looksById.get(id) : null) ?? null;
  };

  const handleAssign = (dateKey: string, lookId: string) => {
    scheduleLook(dateKey, lookId);
  };

  const handleClear = (dateKey: string) => {
    clearSchedule(dateKey);
  };

  // Every scheduled day key, newest first — a list of primitives, so an
  // unrelated mutation cannot invalidate it.
  const scheduleDateKeys = useScheduleDateKeys();
  const bookedDays = useMemo(() => new Set(scheduleDateKeys), [scheduleDateKeys]);

  // History: past schedules only (today or earlier), reverse chronological.
  // Derived from the primitive day keys + the id map, so it too is memo-stable
  // against unrelated store writes.
  const historyItems = useMemo(() => {
    const now = new Date();
    now.setHours(23, 59, 59, 999); // Include today
    const items: Array<{ date: Date; look: SavedLook }> = [];
    for (const key of scheduleDateKeys) {
      const schDate = new Date(key);
      if (schDate > now) continue;
      const look = looksById.get(scheduleMap[key] ?? "");
      if (look) items.push({ date: schDate, look });
    }
    items.sort((a, b) => b.date.getTime() - a.date.getTime());
    return groupSchedulesByMonth(items);
  }, [scheduleDateKeys, scheduleMap, looksById]);

  const hasAnySchedules = scheduleDateKeys.length > 0;

  return (
    <div className="px-4 pb-44 pt-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="label-micro">Plan ahead</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Calendar</h1>
        </div>
        <span className="mb-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-extrabold text-mut">
          {viewMode === "week" 
            ? `Week of ${weekDates[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
            : viewMode === "month"
            ? `${MONTH_NAMES[new Date().getMonth()]} ${new Date().getFullYear()}`
            : `${historyItems.reduce((sum, [, items]) => sum + items.length, 0)} worn`}
        </span>
      </header>

      {/* View mode toggle */}
      <div
        role="group"
        aria-label="Calendar view"
        className="mt-4 flex rounded-[14px] border border-line bg-bgdeep p-1"
      >
        {(["week", "month", "history"] as CalendarViewMode[]).map((mode) => {
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              aria-pressed={active}
              className={cn(
                "flex flex-1 items-center justify-center rounded-[10px] px-3 py-2 text-[12.5px] font-extrabold transition-all",
                active ? "bg-card text-ink shadow-sm" : "text-mut hover:text-ink"
              )}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Week navigation */}
      {viewMode === "week" && (
        <>
          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setWeekOffset((o) => o - 1)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-card text-mut transition active:scale-95"
              aria-label="Previous week"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={() => setWeekOffset(0)}
              className="rounded-full border border-line bg-card px-3 py-1.5 text-[11px] font-extrabold text-mut transition active:scale-95"
            >
              Today
            </button>
            <button
              onClick={() => setWeekOffset((o) => o + 1)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-card text-mut transition active:scale-95"
              aria-label="Next week"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          {/* Week grid */}
          <div className="mt-4 grid grid-cols-7 gap-1.5">
            {weekDates.map((d) => {
              const key = formatDateKey(d);
              const isToday = key === today;
              const scheduledLook = getLookForDate(key);
              return (
                <button
                  key={key}
                  onClick={() => setSelectedDate(d)}
                  className={cn(
                    "flex flex-col items-center rounded-[14px] border p-2 transition active:scale-95",
                    isToday
                      ? "border-acc bg-accsoft"
                      : scheduledLook
                        ? "border-acc/40 bg-card"
                        : "border-line bg-card"
                  )}
                >
                  <span
                    className={cn(
                      "text-[11px] font-extrabold",
                      isToday ? "text-acc" : "text-mut"
                    )}
                  >
                    {DAY_NAMES[d.getDay() === 0 ? 6 : d.getDay() - 1]}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-extrabold",
                      isToday
                        ? "bg-acc text-accink"
                        : scheduledLook
                          ? "bg-accsoft text-acc"
                          : "text-ink"
                    )}
                  >
                    {d.getDate()}
                  </span>
                  {scheduledLook && (
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-acc" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Month view */}
      {viewMode === "month" && (
        <>
          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setMonthOffset((o) => o - 1)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-card text-mut transition active:scale-95"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={() => setMonthOffset(0)}
              className="rounded-full border border-line bg-card px-3 py-1.5 text-[11px] font-extrabold text-mut transition active:scale-95"
            >
              Today
            </button>
            <button
              onClick={() => setMonthOffset((o) => o + 1)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-card text-mut transition active:scale-95"
              aria-label="Next month"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          {/* Month grid header */}
          <div className="mt-4 grid grid-cols-7 gap-1">
            {DAY_NAMES.map((name) => (
              <div key={name} className="text-center text-[11px] font-extrabold text-mut">
                {name}
              </div>
            ))}
          </div>

          {/* Month grid */}
          <div className="mt-1 grid grid-cols-7 gap-1">
            {monthDates.map((d, idx) => {
              const key = formatDateKey(d);
              const isToday = key === today;
              const isInMonth = d.getMonth() === new Date().getMonth() + monthOffset;
              const scheduledLook = getLookForDate(key);
              return (
                <button
                  key={idx}
                  onClick={() => setSelectedDate(d)}
                  className={cn(
                    "relative flex aspect-square flex-col items-center justify-start rounded-[10px] border p-1 transition active:scale-95",
                    !isInMonth ? "opacity-40" : "",
                    isToday
                      ? "border-acc bg-accsoft"
                      : scheduledLook
                        ? "border-acc/40 bg-card"
                        : "border-line bg-card"
                  )}
                >
                  <span
                    className={cn(
                      "text-[11px] font-extrabold",
                      isToday ? "text-acc" : isInMonth ? "text-ink" : "text-mut"
                    )}
                  >
                    {d.getDate()}
                  </span>
                  {scheduledLook && (
                    <span className="absolute bottom-1 h-1.5 w-1.5 rounded-full bg-acc" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* History view */}
      {viewMode === "history" && (
        <div className="mt-4 space-y-4">
          {historyItems.length === 0 ? (
            <div className="card flex flex-col items-center rounded-[20px] px-6 py-10 text-center">
              <Clock className="mb-2 h-10 w-10 text-mut opacity-50" />
              <p className="text-[14px] font-extrabold">No worn history yet</p>
              <p className="mt-1 max-w-[240px] text-[12px] font-medium text-mut">
                Schedule outfits for today or earlier to see them here.
              </p>
            </div>
          ) : (
            historyItems.map(([monthLabel, items]) => (
              <div key={monthLabel}>
                <p className="mb-2 label-micro text-mut">{monthLabel}</p>
                <div className="space-y-2">
                  {items.map(({ date, look }) => (
                    <motion.div
                      key={date.toISOString() + look.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="card flex items-center gap-3 rounded-[16px] p-2.5"
                    >
                      <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-[10px] bg-accsoft">
                        <span className="text-[11px] font-extrabold text-acc">
                          {DAY_NAMES[date.getDay() === 0 ? 6 : date.getDay() - 1]}
                        </span>
                        <span className="text-[13px] font-extrabold text-acc">
                          {date.getDate()}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] font-extrabold">{look.name}</p>
                        <p className="text-[11px] font-bold text-mut">
                          {OCCASION_META[look.occasion].label}
                        </p>
                      </div>
                      <div className="w-20 shrink-0">
                        <OutfitBoard outfit={look.outfit} compact staticBoard />
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Scheduled looks preview (week view only) */}
      {viewMode === "week" && (
        <div className="mt-5">
          <div className="mb-2.5 flex items-center justify-between px-1">
            <p className="label-micro">This week's lineup</p>
            {hasAnySchedules && (
              <span className="text-[11px] font-extrabold text-mut">
                {weekDates.filter((d) => bookedDays.has(formatDateKey(d))).length} / 7 days planned
              </span>
            )}
          </div>

          {!hasAnySchedules ? (
            <div className="card flex flex-col items-center rounded-[20px] px-6 py-10 text-center">
              <Calendar className="mb-2 h-10 w-10 text-mut opacity-50" />
              <p className="text-[14px] font-extrabold">Nothing scheduled yet</p>
              <p className="mt-1 max-w-[240px] text-[12px] font-medium text-mut">
                Tap a day above to assign an outfit from your lookbook.
              </p>
              <button
                onClick={() => setTab("looks")}
                className="mt-3 rounded-full border border-line px-4 py-2 text-[12px] font-extrabold text-mut transition active:scale-95"
              >
                Browse looks
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {weekDates.map((d) => {
                const key = formatDateKey(d);
                const look = getLookForDate(key);
                if (!look) return null;
                return (
                  <motion.div
                    key={key}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="card flex items-center gap-3 rounded-[16px] p-2.5"
                  >
                    <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-[10px] bg-accsoft">
                      <span className="text-[11px] font-extrabold text-acc">
                        {DAY_NAMES[d.getDay() === 0 ? 6 : d.getDay() - 1]}
                      </span>
                      <span className="text-[13px] font-extrabold text-acc">
                        {d.getDate()}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-extrabold">{look.name}</p>
                      <p className="text-[11px] font-bold text-mut">
                        {OCCASION_META[look.occasion].label}
                      </p>
                    </div>
                    <div className="w-20 shrink-0">
                      <OutfitBoard outfit={look.outfit} compact staticBoard />
                    </div>
                    <button
                      onClick={() => handleClear(key)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mut transition hover:bg-dangersoft hover:text-danger active:scale-95"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Detail sheet */}
      {selectedDate && (
        <ScheduleSheet
          date={selectedDate}
          scheduledLook={getLookForDate(formatDateKey(selectedDate))}
          availableLooks={looks}
          onAssign={(lookId) => handleAssign(formatDateKey(selectedDate), lookId)}
          onClear={() => handleClear(formatDateKey(selectedDate))}
          onClose={() => setSelectedDate(null)}
        />
      )}
    </div>
  );
}
