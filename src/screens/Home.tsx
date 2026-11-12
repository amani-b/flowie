import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  LocateFixed,
  MapPin,
  RefreshCw,
  Sparkles,
  Sun,
  Thermometer,
  Wand2,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "../store/appStore";
import { useGarmentCount, useLookCount, useRecentLooks } from "../store/selectors";
import { BUCKET_META, cn, firstName, formatTemp, greeting, timeAgo, todayLabel } from "../lib/utils";
import type { Garment, WeatherIconKind } from "../types";
import OutfitBoard from "../components/OutfitBoard";
import Sheet from "../components/Sheet";
import { WeatherSkeleton } from "../components/Skeletons";
import { geminiReady } from "../services/stylist";
import { CITIES, clearWeatherLoc, getWeatherLoc, setWeatherLoc, type CityOption } from "../services/weather";

const WX_ICON: Record<WeatherIconKind, LucideIcon> = {
  sun: Sun,
  partly: CloudSun,
  cloud: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
};

const BUCKET_TINT: Record<string, string> = {
  cold: "var(--cool-soft)",
  cool: "var(--cool-soft)",
  mild: "var(--acc-soft)",
  warm: "var(--amber-soft)",
  hot: "var(--amber-soft)",
};

function outfitPieces(o: Record<string, Garment | undefined>): Garment[] {
  return ["dress", "top", "bottom", "outer", "shoes", "accessory"]
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

export default function Home() {
  const weather = useAppStore((s) => s.weather);
  const units = useAppStore((s) => s.units);
  // Narrow selectors: Home renders counts and a 6-item carousel, so it does not
  // need to re-render when some other garment or the 20th look changes.
  const garmentCount = useGarmentCount();
  const lookCount = useLookCount();
  const recentLooks = useRecentLooks(6);
  const today = useAppStore((s) => s.today);
  const refreshWeather = useAppStore((s) => s.refreshWeather);
  const generateToday = useAppStore((s) => s.generateToday);
  const restoreSamples = useAppStore((s) => s.restoreSamples);
  const setTab = useAppStore((s) => s.setTab);
  const user = useAppStore((s) => s.user);
  const [locOpen, setLocOpen] = useState(false);
  const [locName, setLocName] = useState<string | null>(() => getWeatherLoc()?.name ?? null);

  const pickCity = (city: CityOption) => {
    setWeatherLoc(city);
    setLocName(city.name);
    setLocOpen(false);
    void refreshWeather();
  };

  const useMyLocation = () => {
    clearWeatherLoc();
    setLocName(null);
    setLocOpen(false);
    void refreshWeather();
  };

  useEffect(() => {
    if (weather.status === "idle") void refreshWeather();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-generate today's outfit on first load if we have garments but no outfit yet
  useEffect(() => {
    if (garmentCount > 0 && !today && weather.status !== "loading") {
      void generateToday("casual");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [garmentCount, today, weather.status]);

  const wx = weather.data;
  const WxIcon = wx ? WX_ICON[wx.icon] : Sun;
  const todayPieces = today ? outfitPieces(today.outfit as Record<string, Garment | undefined>) : [];

  return (
    <div className="space-y-4 px-4 pb-44 pt-4">
      {/* editorial header */}
      <motion.header
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-end justify-between"
      >
        <div>
          <p className="label-micro">{todayLabel()}</p>
          <h1 className="font-display text-[27px] font-extrabold leading-tight tracking-tight">
            {greeting()}, {firstName(user?.name ?? "stylist")}
          </h1>
        </div>
        <span className="mb-1 flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-extrabold tracking-[0.12em] text-mut">
          <Sparkles className="h-3 w-3 text-acc" />
          {geminiReady ? "SMART" : "OFFLINE"}
        </span>
      </motion.header>

      {/* weather board */}
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="card relative overflow-hidden rounded-[24px] p-5"
      >
        {wx && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(90% 120% at 85% 0%, ${BUCKET_TINT[wx.bucket]} 0%, transparent 60%)`,
            }}
          />
        )}
        <div className="relative">
          {weather.status === "loading" && !wx ? (
            <WeatherSkeleton />
          ) : weather.status === "error" && !wx ? (
            <div className="flex flex-col items-start gap-3">
              <div className="flex items-center gap-2 text-danger">
                <AlertTriangle className="h-5 w-5" />
                <span className="text-[14px] font-extrabold">Weather unreachable</span>
              </div>
              <p className="text-[12.5px] font-medium text-mut">
                Check your connection — styling still works with the mild-weather default.
              </p>
              <button
                onClick={() => void refreshWeather()}
                className="rounded-full bg-acc px-4 py-2 text-[12.5px] font-extrabold text-accink transition active:scale-95"
              >
                Retry
              </button>
            </div>
          ) : wx ? (
            <>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setLocOpen(true)}
                  aria-label="Change weather location"
                  className="flex items-center gap-1.5 rounded-full text-[11px] font-extrabold text-mut transition active:scale-95"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  {locName ?? wx.location}
                  <ChevronDown className="h-3 w-3 opacity-70" />
                </button>
                <div className="flex items-center gap-1.5">
                  {wx.source === "live" ? (
                    <span className="flex items-center gap-1.5 rounded-full bg-accsoft px-2.5 py-1 text-[11px] font-extrabold tracking-[0.14em] text-acc">
                      <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-acc" />
                      LIVE
                    </span>
                  ) : (
                    <span className="rounded-full bg-ambersoft px-2.5 py-1 text-[11px] font-extrabold tracking-[0.14em] text-amber">
                      OFFLINE
                    </span>
                  )}
                  <button
                    onClick={() => void refreshWeather()}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-line text-mut transition active:scale-90"
                    aria-label="Refresh weather"
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", weather.status === "loading" && "animate-spin")}
                    />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-end gap-4">
                <span className="tnum font-display text-[68px] font-extrabold leading-[0.85] tracking-tight">
                  {formatTemp(wx.tempC, units)}
                </span>
                <div className="mb-1 flex items-center gap-2.5">
                  <WxIcon className="h-9 w-9 text-amber" strokeWidth={1.8} />
                  <div>
                    <p className="text-[15px] font-extrabold leading-tight">{wx.label}</p>
                    <p className="text-[11.5px] font-bold text-mut">
                      feels {formatTemp(wx.feelsC, units)} · {BUCKET_META[wx.bucket].label.toLowerCase()} bucket
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-1.5">
                <span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-mut">
                  <Thermometer className="h-3.5 w-3.5" />
                  H {formatTemp(wx.highC, units)} · L {formatTemp(wx.lowC, units)}
                </span>
                <span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-mut">
                  <Droplets className="h-3.5 w-3.5" />
                  {wx.humidity}%
                </span>
                <span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-mut">
                  <Wind className="h-3.5 w-3.5" />
                  {wx.windKph} km/h
                </span>
                {wx.isRain && (
                  <span className="rounded-full bg-coolsoft px-2.5 py-1 text-[11px] font-extrabold text-cool">
                    Rain gear advised
                  </span>
                )}
              </div>
            </>
          ) : (
            <WeatherSkeleton />
          )}
        </div>
      </motion.section>

      {/* today's look */}
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="card rounded-[24px] p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="label-micro">Today's look</p>
        </div>

        {garmentCount === 0 ? (
          <div className="py-2 text-center">
            <p className="mt-1 text-[15px] font-extrabold">The rail is empty</p>
            <p className="mx-auto mt-1 max-w-[255px] text-[12.5px] font-medium leading-relaxed text-mut">
              No pieces in your closet yet. Start from scratch, or borrow the
              demo wardrobe to watch the stylist work.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                onClick={restoreSamples}
                className="rounded-full bg-acc px-4.5 py-2.5 text-[12.5px] font-extrabold text-accink transition active:scale-95"
              >
                Load sample closet
              </button>
              <button
                onClick={() => setTab("closet")}
                className="rounded-full border border-line px-4.5 py-2.5 text-[12.5px] font-extrabold text-mut transition active:scale-95"
              >
                Add pieces
              </button>
            </div>
          </div>
        ) : !today ? (
          <div className="py-1">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-extrabold">Nothing pinned for today</p>
              <p className="mt-1 text-[12.5px] font-medium leading-relaxed text-mut">
                The sky has been read — now pick a plan and let the studio
                dress you for it.
              </p>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <button
                  onClick={() => setTab("studio")}
                  className="flex items-center gap-1.5 rounded-full bg-acc px-4 py-2.5 text-[12.5px] font-extrabold text-accink transition active:scale-95"
                >
                  <Wand2 className="h-3.5 w-3.5" /> Open the studio
                </button>
                {lookCount > 0 && (
                  <button
                    onClick={() => setTab("looks")}
                    className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2.5 text-[12.5px] font-extrabold text-mut transition active:scale-95"
                  >
                    Browse lookbook <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <OutfitBoard
              outfit={today.outfit}
              animateKey={todayPieces.map((p) => p.id).join(".")}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-semibold leading-relaxed">{today.rationale}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {todayPieces.map((g) => (
                  <span
                    key={g.id}
                    className="flex items-center gap-1.5 rounded-full border border-line px-2 py-1 text-[11px] font-extrabold"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-linestrong"
                      style={{ background: g.color }}
                    />
                    {g.name}
                  </span>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => void generateToday(today.occasion)}
                  className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-acc px-4 text-[12.5px] font-extrabold text-accink transition active:scale-95"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  New idea
                </button>
                <button
                  onClick={() => setTab("studio")}
                  className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-4 text-[12.5px] font-extrabold text-mut transition active:scale-95"
                >
                  Studio
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </motion.section>

      {/* stat strip */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.16 }}
        className="flex items-center gap-2 px-1"
      >
        <span className="text-[11.5px] font-extrabold text-mut">
          <span className="text-ink">{garmentCount}</span> pieces
        </span>
        <span className="h-1 w-1 rounded-full bg-linestrong" />
        <span className="text-[11.5px] font-extrabold text-mut">
          <span className="text-ink">{lookCount}</span> saved looks
        </span>
        <span className="h-1 w-1 rounded-full bg-linestrong" />
        <span className="text-[11.5px] font-extrabold text-mut">
          dressing for{" "}
          <span className="text-ink">
            {wx ? BUCKET_META[wx.bucket].label.toLowerCase() : "…"}
          </span>
        </span>
      </motion.div>

      {/* recent looks */}
      {lookCount > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="mb-2.5 flex items-center justify-between px-1">
            <p className="label-micro">Recent looks</p>
            <button
              onClick={() => setTab("looks")}
              className="flex items-center gap-1 text-[11.5px] font-extrabold text-acc transition active:scale-95"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
            {recentLooks.map((look) => (
              <button
                key={look.id}
                onClick={() => setTab("looks")}
                className="card w-[132px] shrink-0 rounded-[18px] p-2 text-left transition active:scale-95"
              >
                <OutfitBoard outfit={look.outfit} compact staticBoard />
                <p className="mt-1 truncate px-0.5 text-[11px] font-extrabold">{look.name}</p>
                <p className="px-0.5 text-[11px] font-bold text-mut">{timeAgo(look.createdAt)}</p>
              </button>
            ))}
          </div>
        </motion.section>
      )}

      {/* weather location picker */}
      <Sheet open={locOpen} onClose={() => setLocOpen(false)} title="Weather location">
        <div className="mt-1 space-y-1.5">
          <button
            onClick={useMyLocation}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-[14px] border px-3.5 py-2.5 text-left text-[13px] font-extrabold transition active:scale-[0.98]",
              !locName ? "border-acc bg-accsoft" : "border-line"
            )}
          >
            <LocateFixed className="h-4 w-4 shrink-0 text-acc" />
            <span className="flex-1">Use my location</span>
            {!locName && <Check className="h-4 w-4 text-acc" strokeWidth={3} />}
          </button>
          {CITIES.map((city) => (
            <button
              key={city.name}
              onClick={() => pickCity(city)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-[14px] border px-3.5 py-2.5 text-left text-[13px] font-extrabold transition active:scale-[0.98]",
                locName === city.name ? "border-acc bg-accsoft" : "border-line"
              )}
            >
              <MapPin className="h-4 w-4 shrink-0 text-mut" />
              <span className="flex-1">{city.name}</span>
              {locName === city.name && <Check className="h-4 w-4 text-acc" strokeWidth={3} />}
            </button>
          ))}
          <p className="px-1 pt-1 text-[11px] font-semibold leading-relaxed text-mut">
            Your area uses the phone's location when granted — otherwise the
            default city. Picks are remembered on this device.
          </p>
        </div>
      </Sheet>
    </div>
  );
}
