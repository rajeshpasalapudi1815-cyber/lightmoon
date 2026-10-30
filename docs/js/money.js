// Money in their messages: a bank's "Rs 450 debited ... at SWIGGY" becomes an offer to log the spend in Life
// Levelling, and "your bill of Rs 1,240 is due on 05-Nov" an offer of a reminder before it's due. Only reads the
// words; nothing is logged or set without their yes (the AI asks). phone.js marks messages with these notes.
// tests/money.test.mjs checks it.

const AMOUNT = /(?:rs\.?|inr|₹)\s?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s?(?:rs\b|inr\b|rupees)/i;
const SPENT = /\b(debited|spent|paid|purchase[sd]?|txn of|transaction of|withdrawn|sent|deducted|charged)\b/i;
const INCOMING = /\b(credited to (your|ur) a\/?c|received|refund(ed)?|cashback credited|has been credited)\b/i;
const NOT_DONE = /\b(will be debited|to be debited|due|declined|failed|reversed|request(ed)? (for|of)|collect request|otp)\b/i;
const BILL = /\b(bill|due|payable|outstanding|minimum amount|min\.? amt|emi|premium|renewal|recharge (now|before)|expir\w+)\b/i;
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const DUE_DATE = new RegExp(
  `\\b(?:due|pay|payable|before|by|on|expires?|last date)\\b[^.\\d]{0,20}?`
  + `(\\d{1,2}(?:st|nd|rd|th)?[-/ .](?:\\d{1,2}|(?:${MONTHS})[a-z]*)(?:[-/ .,]+\\d{2,4})?|(?:${MONTHS})[a-z]* \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|today|tomorrow)`,
  'i',
);
// "at SWIGGY", "to Zomato Ltd", "VPA swiggy@icici", "Info: AMAZON", stopping at the usual words after a name.
const MERCHANT = /\b(?:at|to|towards|vpa|info:?)\s+([A-Za-z0-9][\w&@.'*-]*(?: [A-Za-z][\w&.'-]*){0,3}?)(?=\s+(?:on|via|ref|upi|avl|avbl|a\/c|bal|txn|from|dated|is|for)\b|[.,;]|\s*$)/i;

const number = text => Number(String(text).replace(/,/g, ''));
const rupees = n => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// { amount, merchant } for a message saying money went out, else null.
export function spendFrom(text) {
  const words = String(text ?? '');
  if (!SPENT.test(words) || INCOMING.test(words) && !/\bdebited\b/i.test(words) || NOT_DONE.test(words)) return null;
  const match = AMOUNT.exec(words);
  const amount = match && number(match[1] ?? match[2]);
  if (!amount || amount <= 0) return null;
  let merchant = MERCHANT.exec(words)?.[1]?.trim() ?? null;
  if (merchant && /@/.test(merchant)) merchant = merchant.split('@')[0];
  if (merchant && /^(your|ur|a\/?c|account|card|xx\w*|\d+)$/i.test(merchant)) merchant = null;
  return { amount, merchant };
}

// { amount, due } for a bill or renewal reminder, else null. A bank's spend message is not a bill.
export function billFrom(text) {
  const words = String(text ?? '');
  if (!BILL.test(words) || /\b(paid|received|successful(ly)?|thank you for (your )?payment)\b/i.test(words)) return null;
  if (spendFrom(words)) return null;
  const due = DUE_DATE.exec(words)?.[1] ?? null;
  const match = AMOUNT.exec(words);
  const amount = match ? number(match[1] ?? match[2]) : null;
  if (!due && !amount) return null;
  if (!due && !/\b(due|payable|outstanding|expir\w+)\b/i.test(words)) return null;
  return { amount: amount || null, due };
}

// A short note for the AI's view of a message, or ''.
export function moneyNote(text) {
  const spend = spendFrom(text);
  if (spend) return `SPENT ${rupees(spend.amount)}${spend.merchant ? ` at ${spend.merchant}` : ''}: offer once to log it`;
  const bill = billFrom(text);
  if (bill) return `BILL${bill.amount ? ` ${rupees(bill.amount)}` : ''}${bill.due ? ` due ${bill.due}` : ''}: offer once a reminder before it's due`;
  return '';
}
