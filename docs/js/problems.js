// What went wrong lately, kept on this device so it can be looked at (Settings → Is everything working?) and
// copied into a report: the area, the time and the error's own words. Never the conversation, a message's text
// or a key.
import { VERSION } from './version.js';

const KEY = 'assistant.problems';
const MAX = 60;
const SAME_WITHIN_MS = 60_000;

const read = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};
const write = problems => {
  try {
    localStorage.setItem(KEY, JSON.stringify(problems.slice(-MAX)));
  } catch {
    // Storage full or blocked: the list is a convenience.
  }
};

// `area`: where it happened ("ai", "sync", "voice", "reminders", "app"); `message`: the error's words.
export function report(area, message) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) return;
  const problems = read();
  const last = problems.at(-1);
  if (last && last.area === area && last.message === text && Date.now() - last.at < SAME_WITHIN_MS) {
    last.count = (last.count ?? 1) + 1;
    last.at = Date.now();
  } else {
    problems.push({ at: Date.now(), area, message: text, count: 1 });
  }
  write(problems);
}

export const list = () => read().slice().reverse(); // newest first
export const since = ms => read().filter(p => p.at >= ms).length;
export function clear() {
  write([]);
}

// The list as text, for pasting into a bug report.
export function describe() {
  const where = window.Capacitor?.isNativePlatform?.() ? 'Android app' : navigator.userAgent.replace(/^.*?\) /, '').slice(0, 60);
  const lines = list().map(p => `${new Date(p.at).toLocaleString()}  ${p.area}: ${p.message}${p.count > 1 ? ` (×${p.count})` : ''}`);
  return `LightMoon ${VERSION} · ${where}\n${lines.length ? lines.join('\n') : 'No problems recorded.'}`;
}

// Errors nobody caught, from anywhere in the app.
export function install() {
  addEventListener('error', event => report('app', event.message || String(event.error ?? 'error')));
  addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    report('app', reason?.message ?? (typeof reason === 'string' ? reason : 'A background step failed'));
  });
}
