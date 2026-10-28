// Weather from Open-Meteo (free, no key). Only the saved place's rough coordinates are sent.
import { settings } from './store.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 30 * 60_000;
const RAIN_LIKELY_PERCENT = 50;

// WMO weather codes, as used by Open-Meteo.
const CONDITIONS = new Map([
  [0, 'clear skies'], [1, 'mostly clear'], [2, 'partly cloudy'], [3, 'overcast'],
  [45, 'foggy'], [48, 'foggy'],
  [51, 'light drizzle'], [53, 'drizzle'], [55, 'heavy drizzle'], [56, 'freezing drizzle'], [57, 'freezing drizzle'],
  [61, 'light rain'], [63, 'rain'], [65, 'heavy rain'], [66, 'freezing rain'], [67, 'freezing rain'],
  [71, 'light snow'], [73, 'snow'], [75, 'heavy snow'], [77, 'snow grains'],
  [80, 'light showers'], [81, 'showers'], [82, 'heavy showers'], [85, 'snow showers'], [86, 'heavy snow showers'],
  [95, 'thunderstorms'], [96, 'thunderstorms with hail'], [99, 'thunderstorms with hail'],
]);

let cached = null; // { key, at, summary }

const round = n => Math.round(n * 100) / 100; // about 1 km: plenty for a forecast, kinder to privacy

export function savedPlace() {
  try {
    return JSON.parse(settings.get('weather_place') || 'null');
  } catch {
    return null;
  }
}

export function savePlace(place) {
  settings.set('weather_place', place ? JSON.stringify(place) : '');
  cached = null;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("I couldn't reach the weather service.");
  }
  if (!res.ok) throw new Error(`The weather service returned an error (${res.status}).`);
  return res.json();
}

export async function findPlace(name) {
  const data = await getJson(`${GEOCODE_URL}?name=${encodeURIComponent(name.trim())}&count=1&language=en&format=json`);
  const hit = data.results?.[0];
  if (!hit) throw new Error(`I couldn't find a place called "${name}".`);
  const label = [...new Set([hit.name, hit.admin1, hit.country].filter(Boolean))].join(', ');
  return { name: label, latitude: round(hit.latitude), longitude: round(hit.longitude) };
}

export function placeFromDevice() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This device can't share its location. Type your city instead."));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ name: 'your location', latitude: round(pos.coords.latitude), longitude: round(pos.coords.longitude) }),
      () => reject(new Error('Location access was denied. Type your city instead.')),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60 * 60_000 },
    );
  });
}

// A short, speakable summary of today's weather, e.g.
// "Hyderabad: 27°C and partly cloudy now; today 22 to 31°C, rain likely from 17:00 (70%)."
export async function weatherSummary(place = savedPlace()) {
  if (!place) return null;
  const key = `${place.latitude},${place.longitude}`;
  if (cached?.key === key && Date.now() - cached.at < CACHE_MS) return cached.summary;

  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: 'auto',
    forecast_days: '1',
    current: 'temperature_2m,weather_code',
    hourly: 'precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
  });
  const data = await getJson(`${FORECAST_URL}?${params}`);
  const describe = code => CONDITIONS.get(code) ?? 'mixed weather';
  const thisHour = data.current.time.slice(0, 13);
  const rainAt = data.hourly.time.findIndex(
    (time, i) => time.slice(0, 13) >= thisHour && data.hourly.precipitation_probability[i] >= RAIN_LIKELY_PERCENT,
  );
  const rain = rainAt >= 0
    ? `rain likely from ${data.hourly.time[rainAt].slice(11, 16)} (${data.hourly.precipitation_probability[rainAt]}%)`
    : 'rain unlikely for the rest of today';
  const summary = `${place.name}: ${Math.round(data.current.temperature_2m)}°C and ${describe(data.current.weather_code)} now; `
    + `today ${Math.round(data.daily.temperature_2m_min[0])} to ${Math.round(data.daily.temperature_2m_max[0])}°C, `
    + `${describe(data.daily.weather_code[0])}, ${rain}.`;
  cached = { key, at: Date.now(), summary };
  return summary;
}
