import type { WeatherIconKind, WeatherNow } from "../types";
import { tempBucket } from "../lib/utils";

/**
 * Open-Meteo — free, no API key.
 * Strategy: browser geolocation (short timeout) → default city →
 * fully static fallback so the app never dead-ends offline.
 */

const DEFAULT_LOC = { lat: 40.7128, lon: -74.006, name: "New York" };

export interface CityOption {
  lat: number;
  lon: number;
  name: string;
}

/** Hand-picked presets for the location picker (geolocation first, always). */
export const CITIES: CityOption[] = [
  { lat: 40.7128, lon: -74.006, name: "New York" },
  { lat: 34.0522, lon: -118.2437, name: "Los Angeles" },
  { lat: 51.5074, lon: -0.1278, name: "London" },
  { lat: 48.8566, lon: 2.3522, name: "Paris" },
  { lat: 52.52, lon: 13.405, name: "Berlin" },
  { lat: 6.5244, lon: 3.3792, name: "Lagos" },
  { lat: 35.6762, lon: 139.6503, name: "Tokyo" },
  { lat: -33.8688, lon: 151.2093, name: "Sydney" },
];

const WEATHER_LOC_KEY = "fitflow-weather-loc";

export function getWeatherLoc(): CityOption | null {
  try {
    const raw = localStorage.getItem(WEATHER_LOC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CityOption>;
    if (typeof parsed.lat === "number" && typeof parsed.lon === "number" && parsed.name) {
      return { lat: parsed.lat, lon: parsed.lon, name: parsed.name };
    }
    return null;
  } catch {
    return null;
  }
}

export function setWeatherLoc(city: CityOption): void {
  try {
    localStorage.setItem(WEATHER_LOC_KEY, JSON.stringify(city));
  } catch {
    /* storage full/blocked — geolocation path still works */
  }
}

export function clearWeatherLoc(): void {
  try {
    localStorage.removeItem(WEATHER_LOC_KEY);
  } catch {
    /* noop */
  }
}

const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

function describe(code: number): { label: string; icon: WeatherIconKind; isRain: boolean } {
  if (code === 0) return { label: "Clear sky", icon: "sun", isRain: false };
  if (code === 1) return { label: "Mostly clear", icon: "sun", isRain: false };
  if (code === 2) return { label: "Partly cloudy", icon: "partly", isRain: false };
  if (code === 3) return { label: "Overcast", icon: "cloud", isRain: false };
  if (code === 45 || code === 48) return { label: "Fog", icon: "fog", isRain: false };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: "rain", isRain: true };
  if (code >= 61 && code <= 67) return { label: "Rain", icon: "rain", isRain: true };
  if (SNOW_CODES.has(code)) return { label: "Snow", icon: "snow", isRain: true };
  if (code >= 80 && code <= 82) return { label: "Showers", icon: "rain", isRain: true };
  if (code >= 95) return { label: "Thunderstorm", icon: "storm", isRain: true };
  return { label: "Changeable", icon: "cloud", isRain: RAIN_CODES.has(code) };
}

function getPosition(): Promise<{ lat: number; lon: number; name: string }> {
  // A manually picked city always wins — instant, no permission dance.
  const override = getWeatherLoc();
  if (override) return Promise.resolve(override);
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(DEFAULT_LOC);
      return;
    }
    let settled = false;
    const done = (v: { lat: number; lon: number; name: string }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = window.setTimeout(() => done(DEFAULT_LOC), 4500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        window.clearTimeout(timer);
        done({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          name: "Your area",
        });
      },
      () => {
        window.clearTimeout(timer);
        done(DEFAULT_LOC);
      },
      { timeout: 4000, maximumAge: 600_000 }
    );
  });
}

export async function fetchWeather(): Promise<WeatherNow> {
  try {
    const loc = await getPosition();
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const json = (await res.json()) as {
      current: {
        temperature_2m: number;
        apparent_temperature: number;
        relative_humidity_2m: number;
        weather_code: number;
        wind_speed_10m: number;
      };
      daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
    };
    const c = json.current;
    const meta = describe(c.weather_code);
    const feelsC = Math.round(c.apparent_temperature);
    return {
      tempC: Math.round(c.temperature_2m),
      feelsC,
      highC: Math.round(json.daily.temperature_2m_max[0]),
      lowC: Math.round(json.daily.temperature_2m_min[0]),
      code: c.weather_code,
      label: meta.label,
      icon: meta.icon,
      humidity: Math.round(c.relative_humidity_2m),
      windKph: Math.round(c.wind_speed_10m),
      isRain: meta.isRain,
      bucket: tempBucket(feelsC),
      source: "live",
      location: loc.name,
    };
  } catch {
    // Offline / blocked / API down — deterministic fallback keeps the app usable.
    const feelsC = 16;
    const meta = describe(2);
    return {
      tempC: 18,
      feelsC,
      highC: 20,
      lowC: 11,
      code: 2,
      label: meta.label,
      icon: meta.icon,
      humidity: 58,
      windKph: 14,
      isRain: false,
      bucket: tempBucket(feelsC),
      source: "fallback",
      location: "Offline estimate",
    };
  }
}
