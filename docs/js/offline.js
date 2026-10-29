// The offline brain (Android app): a small AI model running on the phone itself (OfflineBrainPlugin.java, llama.cpp),
// used when the big model can't be reached. It gets a short prompt, and instead of full tool calling (which small
// models do badly) it may end its reply with one ACTION line for the few things that matter most offline: a
// reminder, ticking a task off, remembering a fact. Those run through the same tools as always (tools.js).
import { isNativeApp } from './native.js';
import { profile, memories, tasks, messages } from './store.js';
import { runTool } from './tools.js';

const plugin = isNativeApp ? window.Capacitor?.Plugins?.OfflineBrain ?? null : null;
const ACTIONS = ['add_task', 'complete_task', 'remember'];
const ACTION_LINE = /^\s*ACTION\s+([a-z_]+)\s+(\{.*\})\s*$/;
const MAX_TOKENS = 300;

export const offlineAvailable = () => Boolean(plugin);
export const offlineStatus = () => (plugin ? plugin.status().catch(() => null) : Promise.resolve(null));
export const downloadOffline = (wifiOnly = true) => plugin.download({ wifiOnly });
export const removeOffline = () => plugin.remove();
export const stopOffline = () => plugin?.stop().catch(() => {});

function offlinePrompt() {
  const { userName, address, assistantName } = profile();
  const name = userName || 'the user';
  const addressAs = address === 'name' ? userName || 'by their name' : address;
  const now = new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const open = tasks.open().slice(0, 12)
    .map(t => `[${t.id}] ${t.title}${t.remind_at ? ` (reminder ${t.remind_at})` : ''}`).join('; ') || 'none';
  const known = memories.list().slice(0, 15).map(m => m.content).join(' ') || 'nothing yet';
  return `You are ${assistantName}, ${name}'s personal assistant, running offline on their phone: there is no internet, so no weather, news or web. `
    + `Address them as "${addressAs}". Reply in one or two short, warm sentences of plain text; it is read aloud.
It is ${now}. Times you write use the format YYYY-MM-DDTHH:MM.
Open tasks: ${open}.
What you know about them: ${known}
Only when they ask you to do one of these, end your reply with one line exactly like the matching example, and nothing after it:
ACTION add_task {"title": "Call Mom", "remind_at": "YYYY-MM-DDTHH:MM"}
ACTION complete_task {"id": "the task id in brackets above"}
ACTION remember {"content": "Prefers tea in the morning", "category": "preference"}
Never invent tasks or facts. If you can't help offline, say so kindly and that you'll manage it once the internet is back.`;
}

// Streams the reply to onText while keeping ACTION lines out of what's shown and spoken.
function withoutActionLines(onText) {
  let line = '';
  let shown = 0; // how much of the current line has gone out
  const mightBeAction = text => /^\s*A(C(T(I(O(N)?)?)?)?)?$/.test(text) || /^\s*ACTION\b/.test(text);
  return piece => {
    for (const char of piece) {
      line += char;
      if (char === '\n') {
        if (!mightBeAction(line.trimEnd())) onText?.(line.slice(shown));
        line = '';
        shown = 0;
      } else if (!mightBeAction(line)) {
        onText?.(line.slice(shown));
        shown = line.length;
      }
    }
  };
}

// Answers with the offline brain: { reply, actions }, or null when it isn't downloaded (or this isn't the phone app).
export async function answerOffline({ onText } = {}) {
  if (!plugin) return null;
  const status = await offlineStatus();
  if (status?.state !== 'ready') return null;
  const history = messages.recent(6).map(({ role, content }) => ({ role, content: String(content).slice(0, 600) }));
  const stream = withoutActionLines(onText);
  const listener = await plugin.addListener('offlineToken', ({ text }) => stream(text));
  let reply;
  try {
    ({ reply } = await plugin.ask({ messages: [{ role: 'system', content: offlinePrompt() }, ...history], maxTokens: MAX_TOKENS }));
  } catch {
    return null;
  } finally {
    listener.remove();
  }
  const actions = [];
  const lines = String(reply ?? '').split('\n');
  for (const line of lines) {
    const match = ACTION_LINE.exec(line);
    if (!match || !ACTIONS.includes(match[1])) continue;
    const outcome = await runTool(match[1], match[2]);
    if (outcome.ok) actions.push(outcome.action);
  }
  const text = lines.filter(line => !/^\s*ACTION\b/.test(line)).join('\n').trim();
  return { reply: text || (actions.length ? 'Done.' : "I'm offline at the moment, so I can't help with that until the internet is back."), actions };
}
