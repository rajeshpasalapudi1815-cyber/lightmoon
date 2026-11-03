// Checks docs/js/claude.js: LightMoon's conversation and tools turn into Claude's shape the right way.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { toClaudeMessages, toClaudeTools } = await import(pathToFileURL(`${repo}/docs/js/claude.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

const call = { id: 'c1', type: 'function', function: { name: 'add_task', arguments: '{"title":"Gym"}' } };

check('system messages stay out of the messages', () => {
  const out = toClaudeMessages([{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'Hi' }]);
  assert.deepEqual(out, [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
});

check('a tool call and its answer', () => {
  const out = toClaudeMessages([
    { role: 'user', content: 'Add gym' },
    { role: 'assistant', content: 'Adding it.', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[1].content[1], { type: 'tool_use', id: 'c1', name: 'add_task', input: { title: 'Gym' } });
  assert.deepEqual(out[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' }] });
});

check('several tool answers go back in one user turn', () => {
  const out = toClaudeMessages([
    { role: 'user', content: 'Two things' },
    { role: 'assistant', content: null, tool_calls: [call, { ...call, id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a' },
    { role: 'tool', tool_call_id: 'c2', content: 'b' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[2].content.length, 2);
  assert.equal(out[1].content.length, 2); // no empty text block
});

check("Claude's own reply goes back as it came, its notes only if nothing changed", () => {
  const claude = { sig: 'same', content: [{ type: 'thinking', thinking: 'note', signature: 'x' }, { type: 'tool_use', id: 'c1', name: 'add_task', input: {} }] };
  const convo = [{ role: 'user', content: 'Go' }, { role: 'assistant', content: null, tool_calls: [call], claude }];
  assert.equal(toClaudeMessages(convo, 'same')[1].content.length, 2);
  assert.deepEqual(toClaudeMessages(convo, 'changed')[1].content.map(b => b.type), ['tool_use']);
});

check('the conversation starts with the user', () => {
  assert.equal(toClaudeMessages([{ role: 'assistant', content: 'Hello' }])[0].role, 'user');
});

check('tools', () => {
  const tools = toClaudeTools([{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
  assert.deepEqual(tools, [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]);
  assert.deepEqual(toClaudeTools(null), []);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
