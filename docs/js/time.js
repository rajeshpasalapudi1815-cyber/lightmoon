// Times are stored as local "YYYY-MM-DDTHH:MM" strings (or "YYYY-MM-DD" for whole days),
// so they sort and compare correctly as plain text.
const pad = n => String(n).padStart(2, '0');

export function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const today = () => localStamp().slice(0, 10);

const isDateOnly = stamp => /^\d{4}-\d{2}-\d{2}$/.test(stamp);
export const toDate = stamp => new Date(isDateOnly(stamp) ? `${stamp}T00:00` : stamp);
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// Accepts what the model sends ("2026-10-30", "2026-10-30T18:00", "2026-10-30 18:00", ISO with an offset).
// Returns a stored-format string, or null if it can't be understood.
export function normalizeTime(input, { requireTime = false } = {}) {
  if (input == null || input === '') return null;
  const text = String(input).trim();
  if (isDateOnly(text)) return requireTime ? `${text}T09:00` : text;
  const date = new Date(text.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : localStamp(date);
}

export function isPast(stamp) {
  if (!stamp) return false;
  return isDateOnly(stamp) ? stamp < today() : stamp < localStamp();
}

export function describeAgo(stamp) {
  const days = Math.round((startOfDay(new Date()) - startOfDay(toDate(stamp))) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function prettyTime(stamp) {
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (!isDateOnly(stamp)) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
  return toDate(stamp).toLocaleString('en-GB', options);
}
