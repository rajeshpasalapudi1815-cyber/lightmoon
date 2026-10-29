// Brings a new version of LightMoon in without the user having to close and reopen the app (twice, before). The
// version is read from js/version.js on the server, past the browser's cache, when the app opens, comes back to
// the front and every hour; in a browser the service worker also says when it has installed a new one. The new
// files are then fetched fresh, so the restart is instant and complete, and the app restarts itself at a quiet
// moment, or shows a Restart button while it's in use. Works the same in the Android app (no service worker).
import { VERSION, APP_FILES } from './version.js';

const CHECK_EVERY_MS = 60 * 60_000;
const QUIET_CHECK_MS = 15_000;
const JUST_UPDATED_KEY = 'assistant.updated';

let waiting = null; // the newer version found, or null
let settling = 0;
let fetched = null;
let handlers = { isQuiet: () => true, onReady: () => {} };

export const current = VERSION;
export const waitingVersion = () => waiting;

// `isQuiet()`: nothing is happening that a restart would interrupt; `onReady(version)`: a new version is ready
// but the app is in use, so offer a restart.
export function start(options = {}) {
  handlers = { ...handlers, ...options };
  check();
  setInterval(check, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}

// The version the app has just restarted into, once (for a "you're on the newest version" caption).
export function justUpdated() {
  try {
    const was = localStorage.getItem(JUST_UPDATED_KEY);
    if (!was) return false;
    localStorage.removeItem(JUST_UPDATED_KEY);
    return was !== VERSION;
  } catch {
    return false;
  }
}

// The service worker (or anything else) says a newer version is installed.
export function noticed(version) {
  if (!version || version === VERSION || version === waiting) return;
  waiting = version;
  prepare().then(() => {
    handlers.onReady(version);
    settle();
  });
}

async function check() {
  if (navigator.onLine === false || waiting) return;
  try {
    // no-cache: asks the server whether the file changed (an ETag check), instead of trusting the cached copy.
    const text = await (await fetch('./js/version.js', { cache: 'no-cache' })).text();
    noticed(text.match(/VERSION = '([^']+)'/)?.[1]);
  } catch {
    // Offline, or the server is down: next time.
  }
}

// Fresh copies of every file into the browser's cache, so the restart has everything at once.
function prepare() {
  fetched ??= Promise.all(APP_FILES.map(file => fetch(file, { cache: 'reload' }).catch(() => null)));
  return fetched;
}

function settle() {
  clearTimeout(settling);
  if (handlers.isQuiet()) return restart();
  settling = setTimeout(settle, QUIET_CHECK_MS);
}

export function restart() {
  try {
    localStorage.setItem(JUST_UPDATED_KEY, VERSION);
  } catch {
    // Then no caption afterwards.
  }
  location.reload();
}
