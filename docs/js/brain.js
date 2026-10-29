// The brain: sends the conversation straight from this device to an OpenAI-compatible chat API
// (Groq by default), streams the reply back as it is written, and runs any tools the model asks for.
import { aiConfig, messages } from './store.js';
import { buildSystemPrompt } from './prompt.js';
import { currentTools, runTool } from './tools.js';
import { weatherSummary } from './weather.js';
import { refresh as refreshLifeLevelling } from './lifelevelling.js';
import { refresh as refreshPhone } from './phone.js';

const HISTORY_LIMIT = 16;
const MAX_TOOL_ROUNDS = 8; // a routine can take several steps
const REQUEST_TIMEOUT_MS = 60_000;

const briefingRequest = weather =>
  '(Automatic message: I just opened the app. Give me a short spoken briefing, under 70 words. Greet me for the time of day. '
  + 'Mention anything overdue or due today and any upcoming reminders. Nudge one of my goals or ask how it is going. '
  + 'If Life Levelling data is in your context, use it: how ready I am today, the top of my plan, and a quest or the boss worth chasing. '
  + 'If phone data is in your context, mention my next meetings today, and any missed calls or messages that look important. '
  + 'End with one useful suggestion. If you know little about me yet, introduce yourself in one sentence and ask what I am working towards. '
  + `Do not use tools.${weather ? ` Today's weather: ${weather} Mention it in a few words if it matters for my day, like rain, heat or cold.` : ''})`;

const FRIENDLY_ERRORS = {
  'no-key': "My brain isn't connected yet. Add your API key in settings and I'll be right with you.",
  auth: 'The AI service rejected the API key. Please check it in settings.',
  'rate-limit': "I've hit the free usage limit for the moment. Give me a minute, or try again a bit later.",
  network: "I can't reach the AI service. Please check your internet connection.",
  api: 'The AI service had trouble with that request. Please try again in a moment.',
};

// Some models (gpt-oss especially) were trained with a web-search tool and occasionally try to call it,
// or garble a tool call; the service then rejects the reply with "tool_use_failed". One retry with this
// reminder almost always fixes it.
const TOOL_REMINDER = 'Reminder: you cannot browse the web. Only call the tools you were given, with valid JSON arguments. For weather, call get_weather; for facts, call look_up.';

class BrainError extends Error {
  constructor(kind, detail = '', { retryable = false, badToolCall = false } = {}) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.kind = kind;
    this.retryable = retryable || badToolCall;
    this.badToolCall = badToolCall;
  }
}

// onText receives the reply piece by piece as it arrives, so the app can show and speak it straight away.
export async function chat(text, { onText } = {}) {
  messages.add('user', text);
  await Promise.all([refreshLifeLevelling(), refreshPhone()]); // quick, and only every minute or two
  const convo = [systemMessage(), ...recentHistory()];
  const actions = [];
  const written = [];
  const emit = delta => {
    written.push(delta);
    onText?.(delta);
  };
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await complete(convo, currentTools(), emit);
      if (!reply.tool_calls?.length) return finish(written.join(''), actions);

      convo.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        const outcome = await runTool(call.function?.name, call.function?.arguments);
        if (outcome.ok) actions.push(outcome.action);
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error }),
        });
      }
      if (written.length) emit(' '); // keep text from before and after the tools apart
    }
    return finish('I went round in circles on that one. Could you put it another way?', actions);
  } catch (err) {
    return failure(err, actions);
  }
}

export async function briefing({ onText } = {}) {
  const [weather] = await Promise.all([weatherSummary().catch(() => null), refreshLifeLevelling({ force: true }), refreshPhone({ force: true })]);
  const convo = [systemMessage(), ...recentHistory().slice(-6), { role: 'user', content: briefingRequest(weather) }];
  try {
    const reply = await complete(convo, null, onText);
    return finish(reply.content, []);
  } catch (err) {
    return failure(err);
  }
}

const systemMessage = () => ({ role: 'system', content: buildSystemPrompt() });
const recentHistory = () => messages.recent(HISTORY_LIMIT).map(({ role, content }) => ({ role, content }));

function finish(content, actions) {
  const reply = String(content ?? '').trim() || (actions.length ? 'Done.' : "I'm not quite sure what to say to that.");
  messages.add('assistant', reply);
  return { reply, actions };
}

function failure(err, actions = []) {
  console.error(`[brain] ${err.message}`);
  return { reply: FRIENDLY_ERRORS[err.kind] ?? FRIENDLY_ERRORS.api, actions, error: true, detail: err.message };
}

// Tries the main model (twice if it garbled a tool call), then the backup model if the main one is
// rate-limited or failing, but never after part of a reply has already been shown and spoken.
async function complete(convo, tools, onText) {
  const ai = aiConfig();
  if (!ai.ready) throw new BrainError('no-key');
  const models = [...new Set([ai.model, ai.fallbackModel].filter(Boolean))];
  let emitted = false;
  const relay = delta => {
    emitted = true;
    onText?.(delta);
  };
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = attempt ? [...convo, { role: 'system', content: TOOL_REMINDER }] : convo;
      try {
        return await request(ai, model, messages, tools, relay);
      } catch (err) {
        lastError = err;
        if (!err.retryable || emitted) throw err;
        if (!err.badToolCall) break; // rate limits and outages: go straight to the backup model
      }
    }
  }
  throw lastError;
}

async function request(ai, model, convo, tools, onText) {
  const body = { model, messages: convo, temperature: 0.7, stream: true };
  if (tools) Object.assign(body, { tools, tool_choice: 'auto' });
  if (model.includes('gpt-oss')) body.reasoning_effort = 'low'; // quicker replies for voice

  let res;
  try {
    res = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ai.apiKey && { Authorization: `Bearer ${ai.apiKey}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BrainError('network', err.message);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate-limit' : 'api';
    throw new BrainError(kind, `${model} ${res.status} ${detail}`, {
      retryable: res.status === 429 || res.status >= 500,
      badToolCall: detail.includes('tool_use_failed'),
    });
  }

  // A few services ignore "stream" and answer in one piece.
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const message = (await res.json()).choices?.[0]?.message;
    if (!message) throw new BrainError('api', `${model} returned no message`, { retryable: true });
    if (message.content) onText(message.content);
    return message;
  }

  try {
    return await readStream(res, model, onText);
  } catch (err) {
    if (err instanceof BrainError) throw err;
    throw new BrainError('network', `${model} stream interrupted: ${err.message}`);
  }
}

// Reads server-sent events: text arrives in small pieces, tool calls arrive in fragments to stitch together.
async function readStream(res, model, onText) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let content = '';
  const calls = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const payload = line.trim().replace(/^data:\s*/, '');
      if (!line.trim().startsWith('data:') || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) {
        // Errors found after the reply has started (like a rejected tool call) arrive inside the stream.
        const { message = '', code = '', type = '' } = chunk.error;
        throw new BrainError('api', `${model} stream error: ${code || type} ${message}`, {
          badToolCall: `${code} ${message}`.includes('tool_use_failed') || /tool call/i.test(message),
        });
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const call = (calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
    }
  }
  const toolCalls = calls.filter(Boolean);
  return { role: 'assistant', content, ...(toolCalls.length && { tool_calls: toolCalls }) };
}
