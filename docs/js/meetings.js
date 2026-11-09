// A meeting set up by voice ("meeting with Ravi tomorrow at 4"): a Google Calendar event page, filled in, for them to
// check and Save. Google asks there whether to email the guests, so nothing is sent without them.
const compact = stamp => `${stamp.replace(/[-:]/g, '')}00`;

// "YYYY-MM-DDTHH:MM" plus minutes, in local time.
function plus(stamp, minutes) {
  const [date, time] = stamp.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const end = new Date(y, mo - 1, d, h, mi + minutes);
  const two = n => String(n).padStart(2, '0');
  return `${end.getFullYear()}-${two(end.getMonth() + 1)}-${two(end.getDate())}T${two(end.getHours())}:${two(end.getMinutes())}`;
}

export function meetingUrl({ title, at, minutes = 30, guests = [], details = '', account = '', timeZone } = {}) {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${compact(at)}/${compact(plus(at, minutes))}`, ctz: zone });
  if (details) params.set('details', details);
  if (guests.length) params.set('add', guests.join(','));
  if (account) params.set('authuser', account);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
