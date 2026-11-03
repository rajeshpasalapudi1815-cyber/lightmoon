// Claude as LightMoon's main brain (Settings → AI brain → Claude key), through the official SDK (js/vendor/anthropic.js,
// bundled by scripts/vendor-anthropic.mjs). brain.js keeps the conversation in the OpenAI shape it uses for Groq; this
// turns it into Claude's, streams the reply, and hands it back in the same shape, so the tool loop and Groq as the
// backup work unchanged. The key stays on this device, like the Groq key.

export const CLAUDE_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 16000;

let clientFor = { key: '', client: null };
async function client(apiKey) {
  if (clientFor.key !== apiKey) {
    const { default: Anthropic } = await import('./vendor/anthropic.js'); // only loaded once Claude is used
    // The key is the user's own and never leaves their device except to Anthropic.
    clientFor = { key: apiKey, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 }) };
  }
  return clientFor.client;
}

// The first system message is the stable instructions (cached); any later ones (reminders) follow it.
function systemOf(convo) {
  const [first, ...rest] = convo.filter(m => m.role === 'system').map(m => String(m.content ?? ''));
  const blocks = [];
  if (first) blocks.push({ type: 'text', text: first, cache_control: { type: 'ephemeral' } });
  if (rest.length) blocks.push({ type: 'text', text: rest.join('\n\n') });
  return blocks;
}

// What a reply was written against. Claude only takes its own notes back (thinking blocks) while the instructions and
// tools are the same as when it wrote them; brain.js changes both mid-turn (a tool group loaded), and then they go.
const signature = (convo, tools) => JSON.stringify([convo.find(m => m.role === 'system')?.content ?? '', tools]);

// OpenAI-shaped messages -> Claude's: tool calls become tool_use blocks, tool answers become tool_result blocks in
// one user turn, and Claude's own earlier reply in this turn is sent back as it came (`claude`).
export function toClaudeMessages(convo, sig = null) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of convo) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]);
    } else if (m.role === 'assistant') {
      if (m.claude) {
        const same = sig !== null && m.claude.sig === sig;
        push('assistant', structuredClone(m.claude.content).filter(b => same || !/thinking$/.test(b.type)));
        continue;
      }
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const call of m.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch { /* sent as empty */ }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
      }
      push('assistant', blocks);
    } else {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (text) push('user', [{ type: 'text', text }]);
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(Conversation continues.)' }] });
  return out;
}

export const toClaudeTools = tools => (tools ?? []).map(tool => ({
  name: tool.function.name,
  description: tool.function.description ?? '',
  input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
}));

// Claude's errors in brain.js's terms: { kind, status, detail, waitSeconds }.
function describe(err, Anthropic) {
  const status = err?.status ?? 0;
  const detail = String(err?.message ?? err).slice(0, 400);
  if (Anthropic && err instanceof Anthropic.AuthenticationError) return { kind: 'auth', status, detail };
  if (Anthropic && err instanceof Anthropic.PermissionDeniedError) return { kind: 'auth', status, detail };
  if (Anthropic && err instanceof Anthropic.RateLimitError) {
    return { kind: 'rate-limit', status, detail, waitSeconds: Number(err.headers?.get?.('retry-after')) || null };
  }
  if (Anthropic && err instanceof Anthropic.APIConnectionError) return { kind: 'network', status, detail };
  if (status === 413) return { kind: 'too-large', status, detail };
  return { kind: 'api', status, detail };
}

// Streams one reply. onText gets the words as they come. Returns { role, content, tool_calls?, claude } or throws
// { claudeError: { kind, ... } }.
export async function askClaude(apiKey, convo, tools, onText) {
  const api = await client(apiKey);
  const Anthropic = api.constructor;
  const claudeTools = toClaudeTools(tools);
  const sig = signature(convo, claudeTools);
  try {
    const stream = api.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      // A voice assistant: quick, short answers. Thinking stays off except between tool calls.
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
      system: systemOf(convo),
      messages: toClaudeMessages(convo, sig),
      ...(claudeTools.length && { tools: claudeTools, tool_choice: { type: 'auto' } }),
      // If Claude's safety checks decline a request, the API answers it with a fallback model instead.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    stream.on('text', delta => onText?.(delta));
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw Object.assign(new Error('refusal'), { claudeError: { kind: 'api', status: 200, detail: `refusal: ${message.stop_details?.category ?? ''}` } });
    }
    const content = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const calls = message.content.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
    return { role: 'assistant', content, ...(calls.length && { tool_calls: calls }), claude: { content: message.content, sig } };
  } catch (err) {
    if (err?.claudeError) throw err;
    throw Object.assign(new Error('claude'), { claudeError: describe(err, Anthropic) });
  }
}
