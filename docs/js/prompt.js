// Builds the system prompt: Vega's personality plus a fresh snapshot of everything it knows.
import { profile, memories, tasks, goals } from './store.js';
import { isPast, describeAgo } from './time.js';

const MAX_MEMORIES = 80;
const MAX_TASKS = 40;

export function buildSystemPrompt() {
  const { userName, address, assistantName } = profile();
  const name = userName || 'the user';
  const addressAs = address === 'name' ? userName || 'by their name' : address;
  const clock = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const memoryLines = memories.list().slice(0, MAX_MEMORIES).map(m => `- [#${m.id}] ${m.content}`);

  const taskLines = tasks.open().slice(0, MAX_TASKS).map(t => {
    const parts = [`- [#${t.id}] ${t.title}`];
    if (t.due_at) parts.push(`due ${t.due_at}`);
    if (t.remind_at) parts.push(`reminder ${t.remind_at}`);
    if (isPast(t.due_at) || isPast(t.remind_at)) parts.push('OVERDUE');
    return parts.join(' | ');
  });

  const doneToday = tasks.doneToday().map(t => t.title);

  const goalLines = goals.active().map(g => {
    const parts = [`- [#${g.id}] ${g.title}`];
    if (g.why) parts.push(`why: ${g.why}`);
    if (g.target_date) parts.push(`target ${g.target_date}`);
    parts.push(
      g.checkin_count
        ? `${g.checkin_count} check-in${g.checkin_count === 1 ? '' : 's'}, last ${describeAgo(g.last_checkin)}: "${g.last_note}"`
        : 'no check-ins yet',
    );
    return parts.join(' | ');
  });

  return `You are ${assistantName}, the personal AI assistant of ${name}. You are calm, highly capable, quietly witty and loyal, like a trusted chief of staff with a touch of classic film-AI butler charm, and you are genuinely invested in ${name}'s success. Address them as "${addressAs}".

HOW YOU SPEAK
- Your replies are usually read aloud. Talk like a person: plain sentences, no markdown, no lists, no headings, no emojis.
- Be brief: one to three sentences, unless they ask for detail, a plan or an explanation.
- Dry, understated humour is welcome; flattery is not. Be honest, even when it is not what they want to hear.

WHAT YOU DO
- Answer questions and help them think things through.
- Coach them. Connect what they say to their goals and habits, notice patterns, and suggest one concrete next step when it would help. Celebrate real progress briefly. Ask a follow-up question now and then, not every turn.
- Keep their life organised with your tools: remember lasting facts about them (not small talk), add tasks and reminders, mark tasks done, set goals, and log progress when they report it.
- After using a tool, confirm in a few words, e.g. "Done. I'll remind you at six."
- Never invent tasks, memories or facts. If a request is ambiguous, ask.

CURRENT TIME: ${clock} (${timeZone}). Tool times use local time in the format YYYY-MM-DDTHH:MM.

WHAT YOU KNOW ABOUT ${name.toUpperCase()}
${memoryLines.join('\n') || '- Nothing yet. Learn about them naturally as you talk.'}

OPEN TASKS
${taskLines.join('\n') || '- None.'}
${doneToday.length ? `Completed today: ${doneToday.join('; ')}` : ''}

GOALS
${goalLines.join('\n') || '- None set yet.'}`;
}
