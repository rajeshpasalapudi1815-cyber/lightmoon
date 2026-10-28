// The brain: sends the conversation straight from this device to an OpenAI-compatible chat API
// (Groq by default) and runs any tools the model asks for.
import { aiConfig, messages } from './store.js';
import { buildSystemPrompt } from './prompt.js';
import { TOOLS, runTool } from './tools.js';

const HISTORY_LIMIT = 16;
const MAX_TOOL_ROUNDS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

const BRIEFING_REQUEST = `(Automatic message: I just opened the app. Give me a short spoken briefing, under 70 words. Greet me for the time of day. Mention anything overdue or due today and any upcoming reminders. Nudge one of my goals or ask how it is going. End with one useful suggestion. If you know little about me yet, introduce yourself in one sentence and ask what I am working towards. Do not use tools.)`;

const FRIENDLY_ERRORS = {
  'no-key': "My brain isn't connected yet. Add your API key in settings and I'll be right with you.",
  auth: 'The AI service rejected the API key. Please check it in settings.',
  'rate-limit': "I've hit the free usage limit for the moment. Give me a minute, or try again a bit later.",
  network: "I can't reach the AI service. Please check your internet connection.",
  api: 'The AI service had trouble with that request. Please try again in a moment.',
};

class BrainError extends Error {
  constructor(kind, detail = '', retryable = false) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.kind = kind;
    this.retryable = retryable;
  }
}

export async function chat(text) {
  messages.add('user', text);
  const convo = [systemMessage(), ...recentHistory()];
  const actions = [];
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = await complete(convo, TOOLS);
      if (!reply.tool_calls?.length) return finish(reply.content, actions);

      convo.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        const outcome = runTool(call.function?.name, call.function?.arguments);
        if (outcome.ok) actions.push(outcome.action);
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error }),
        });
      }
    }
    return finish('I went round in circles on that one. Could you put it another way?', actions);
  } catch (err) {
    return failure(err, actions);
  }
}

export async function briefing() {
  const convo = [systemMessage(), ...recentHistory().slice(-6), { role: 'user', content: BRIEFING_REQUEST }];
  try {
    const reply = await complete(convo);
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
  return { reply: FRIENDLY_ERRORS[err.kind] ?? FRIENDLY_ERRORS.api, actions, error: true };
}

// Tries the main model, then the backup model if the main one is rate-limited or failing.
async function complete(convo, tools) {
  const ai = aiConfig();
  if (!ai.ready) throw new BrainError('no-key');
  const models = [...new Set([ai.model, ai.fallbackModel].filter(Boolean))];
  let lastError;
  for (const model of models) {
    try {
      return await request(ai, model, convo, tools);
    } catch (err) {
      lastError = err;
      if (!err.retryable) break;
    }
  }
  throw lastError;
}

async function request(ai, model, convo, tools) {
  const body = { model, messages: convo, temperature: 0.7 };
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
    const retryable = res.status === 429 || res.status >= 500 || detail.includes('tool_use_failed');
    throw new BrainError(kind, `${model} ${res.status} ${detail}`, retryable);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new BrainError('api', `${model} returned no message`, true);
  return message;
}
