// Looking things up, for the AI's tools: Wikipedia for people, places, things and events, and Wikipedia's
// "In the news" for today's top world headlines. Both answer the browser directly (no key, no LightMoon cloud).
const WIKI = 'https://en.wikipedia.org';
const TIMEOUT_MS = 8000;
const MAX_HEADLINES = 6;

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
  } catch {
    throw new Error("Couldn't reach Wikipedia. Check the internet connection.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status}.`);
  return res.json();
}

const plain = html => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The best Wikipedia article for a question, as a short summary, plus the next-best titles.
export async function lookUp(query) {
  const wanted = String(query ?? '').trim().slice(0, 200);
  if (!wanted) throw new Error('What should I look up?');
  const search = await getJson(`${WIKI}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(wanted)}&srlimit=4&format=json&origin=*`);
  const hits = search?.query?.search ?? [];
  if (!hits.length) return `Wikipedia has nothing on "${wanted}".`;
  const summary = await getJson(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(hits[0].title.replaceAll(' ', '_'))}`);
  const others = hits.slice(1).map(h => h.title);
  const text = summary?.extract || plain(hits[0].snippet);
  return [
    `Wikipedia, "${summary?.title ?? hits[0].title}"${summary?.description ? ` (${summary.description})` : ''}: ${text}`,
    others.length ? `Other matching articles: ${others.join('; ')}.` : '',
  ].filter(Boolean).join('\n');
}

// Today's top world news from Wikipedia's "In the news" (falls back to yesterday's early in the day).
export async function headlines() {
  for (const daysAgo of [0, 1]) {
    const day = new Date(Date.now() - daysAgo * 86_400_000);
    const path = `${day.getUTCFullYear()}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${String(day.getUTCDate()).padStart(2, '0')}`;
    const feed = await getJson(`${WIKI}/api/rest_v1/feed/featured/${path}`);
    const stories = (feed?.news ?? []).map(item => plain(item.story)).filter(Boolean);
    if (stories.length) return `Top world news (Wikipedia, In the news):\n${stories.slice(0, MAX_HEADLINES).map(s => `- ${s}`).join('\n')}`;
  }
  return "Wikipedia's news list is empty right now.";
}
