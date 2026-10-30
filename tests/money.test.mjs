// Checks docs/js/money.js: spends and bills in bank and company messages are spotted, other messages left alone.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { spendFrom, billFrom, moneyNote } = await import(pathToFileURL(`${repo}/docs/js/money.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

console.log('-- spends');
check('card spend at a shop', () => assert.deepEqual(spendFrom('Rs.450.00 spent on HDFC Bank Card xx1234 at SWIGGY on 2026-10-30. Avl bal Rs 12,000'), { amount: 450, merchant: 'SWIGGY' }));
check('UPI debit to a VPA', () => assert.deepEqual(spendFrom('A/c XX5678 debited by Rs 1,250.50 on 30Oct26 to VPA zomato@icici Ref 123456. -SBI'), { amount: 1250.5, merchant: 'zomato' }));
check('INR wording', () => assert.equal(spendFrom('INR 799 debited from your a/c towards Netflix on 30-10-26').merchant, 'Netflix'));
check('rupee sign', () => assert.equal(spendFrom('₹120 paid to Uber via UPI').amount, 120));
check('amount without a shop', () => assert.deepEqual(spendFrom('Rs 2000 withdrawn from ATM on 30/10. Avl bal Rs 5000'), { amount: 2000, merchant: null }));
check('money received is not a spend', () => assert.equal(spendFrom('Rs 5,000 credited to your a/c XX12 by NEFT from RAVI'), null));
check('a payment request is not a spend', () => assert.equal(spendFrom('Ravi has sent a collect request of Rs 300. Approve in your UPI app'), null));
check('a failed payment is not a spend', () => assert.equal(spendFrom('Your payment of Rs 300 to Swiggy failed'), null));
check('an OTP message is not a spend', () => assert.equal(spendFrom('OTP 482913 for txn of Rs 999 at AMAZON. Do not share'), null));

console.log('-- bills');
check('electricity bill with a date', () => assert.deepEqual(billFrom('Your TSSPDCL electricity bill of Rs 1,240 is due on 05-Nov-2026. Pay now to avoid disconnection.'), { amount: 1240, due: '05-Nov-2026' }));
check('card statement with min amount', () => assert.equal(billFrom('HDFC Card statement: Total due Rs 18,430, min amt Rs 920, payment due by 12th Nov').due, '12th Nov'));
check('plan expiring', () => assert.equal(billFrom('Your Jio plan expires on 3 Nov. Recharge now with Rs 299').due, '3 Nov'));
check('due tomorrow', () => assert.equal(billFrom('Reminder: your EMI of Rs 6,500 is due tomorrow').due, 'tomorrow'));
check('a paid bill is not a bill', () => assert.equal(billFrom('Thank you for your payment of Rs 1,240 towards your electricity bill'), null));
check('a chat about bills is not a bill', () => assert.equal(billFrom('lol the bill at dinner was crazy'), null));

console.log('-- notes');
check('spend note', () => assert.match(moneyNote('Rs.450.00 spent on card at SWIGGY on 30-10'), /SPENT ₹450 at SWIGGY/));
check('bill note', () => assert.match(moneyNote('Your bill of Rs 1,240 is due on 05-Nov'), /BILL ₹1,240 due 05-Nov/));
check('ordinary chat: no note', () => assert.equal(moneyNote('can you send me the report by 5'), ''));

process.exit(failed ? 1 : 0);
