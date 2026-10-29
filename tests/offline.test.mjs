// Logic test for docs/js/offline.js with a fake phone model. Run: npm test
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), key: i => [...mem.keys()][i], get length() { return mem.size; } };
globalThis.document = { hidden: false, addEventListener() {} };
const later = new Date(Date.now() + 2 * 3600_000);
const pad = n => String(n).padStart(2, '0');
const stamp = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
const replyText = `Of course, I'll remind you to call Mom.\nACTION add_task {"title": "Call Mom", "remind_at": "${stamp}"}`;
let listener = null;
const fake = {
  status: async () => ({ state: 'ready', supported: true }),
  addListener: async (_name, fn) => { listener = fn; return { remove() { listener = null; } }; },
  ask: async ({ messages }) => {
    assert.equal(messages[0].role, 'system');
    for (const piece of replyText.match(/.{1,7}/gs)) listener?.({ text: piece }); // streamed in odd-sized pieces
    return { reply: replyText };
  },
  stop: async () => {},
};
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { OfflineBrain: fake } } };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });

const load = file => import(pathToFileURL(path.join(repo, 'docs', 'js', file)).href);
const store = await load('store.js');
const { answerOffline } = await load('offline.js');
store.messages.add('user', 'remind me to call mom in two hours');
let streamed = '';
const out = await answerOffline({ onText: text => { streamed += text; } });
assert.ok(out, 'answered');
assert.equal(out.reply, "Of course, I'll remind you to call Mom.");
assert.ok(!streamed.includes('ACTION'), `ACTION kept out of what is spoken: ${JSON.stringify(streamed)}`);
assert.equal(out.actions.length, 1);
assert.ok(store.tasks.open().some(t => t.title === 'Call Mom' && t.remind_at === stamp), 'the reminder was set');
console.log('ok   offline brain: streamed', JSON.stringify(streamed.trim()), '| action:', out.actions[0].text);
