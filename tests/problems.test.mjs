// The problem log (docs/js/problems.js) and the version check (docs/js/updates.js reads docs/js/version.js).
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), key: i => [...mem.keys()][i], get length() { return mem.size; } };
globalThis.window = {};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Edge/140' }, configurable: true });
const load = file => import(pathToFileURL(path.join(repo, 'docs', 'js', file)).href);
const problems = await load('problems.js');
const { VERSION, APP_FILES } = await load('version.js');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

check('a problem is kept, newest first', () => {
  problems.report('ai', 'Rate limit reached');
  problems.report('sync', 'HTTP 503');
  assert.deepEqual(problems.list().map(p => p.area), ['sync', 'ai']);
});
check('the same problem again within a minute is counted, not repeated', () => {
  problems.report('sync', 'HTTP 503');
  assert.equal(problems.list().length, 2);
  assert.equal(problems.list()[0].count, 2);
});
check('long messages are cut, empty ones ignored', () => {
  problems.report('app', 'x'.repeat(500));
  assert.equal(problems.list()[0].message.length, 200);
  problems.report('app', '   ');
  assert.equal(problems.list().length, 3);
});
check('the report text names the version and lists them', () => {
  const text = problems.describe();
  assert.ok(text.startsWith(`LightMoon ${VERSION}`), text.split('\n')[0]);
  assert.match(text, /sync: HTTP 503 \(×2\)/);
});
check('only the last 60 are kept', () => {
  for (let i = 0; i < 70; i++) problems.report('app', `problem ${i}`);
  assert.equal(problems.list().length, 60);
  assert.equal(problems.list()[0].message, 'problem 69');
});
check('clear empties it', () => {
  problems.clear();
  assert.deepEqual(problems.list(), []);
  assert.match(problems.describe(), /No problems recorded/);
});
check('since() counts recent ones', () => {
  problems.report('voice', 'synthesis-failed');
  assert.equal(problems.since(Date.now() - 1000), 1);
  assert.equal(problems.since(Date.now() + 1000), 0);
});
check('the updater can read the version from version.js as served', () => {
  const text = readFileSync(path.join(repo, 'docs', 'js', 'version.js'), 'utf8');
  assert.equal(text.match(/VERSION = '([^']+)'/)?.[1], VERSION);
  assert.match(VERSION, /^v\d+$/);
});
check('every app file in the cache list exists', () => {
  for (const file of APP_FILES) {
    const target = file === './' ? './index.html' : file;
    assert.ok(readFileSync(path.join(repo, 'docs', target)).length > 0, file);
  }
});
check('every script in docs/js is in the cache list', () => {
  const scripts = readdirSync(path.join(repo, 'docs', 'js')).filter(name => name.endsWith('.js')).map(name => `./js/${name}`);
  for (const script of scripts) assert.ok(APP_FILES.includes(script), `${script} is missing from APP_FILES`);
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
