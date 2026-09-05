import { store } from '../store/index.js';
import { planById } from '../plans.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-plan monthly AI credit allowance. `< 0` means unlimited. */
export function monthlyCredits(planId) {
  const plan = planById(planId);
  if (!plan) return 0;
  if (plan.monthlyCredits < 0) return Infinity;
  return plan.monthlyCredits || 0;
}

function norm(sub) {
  sub.credits = sub.credits || {};
  sub.credits.balance = sub.credits.balance || 0;
  sub.credits.granted = sub.credits.granted || 0; // used this month
  sub.credits.resetAt = sub.credits.resetAt || Date.now();
  return sub.credits;
}

/** Roll over the monthly allowance if the window lapsed. */
export function maybeResetCredits(email) {
  const all = store.subscribers.all();
  const sub = all[email];
  if (!sub) return;
  const c = norm(sub);
  if (Date.now() - c.resetAt >= MONTH_MS) {
    c.resetAt = Date.now();
    c.granted = 0;
    c.balance = monthlyCredits(sub.planId);
    all[email] = sub;
    store.subscribers.save(all);
  }
}

export function creditBalance(email) {
  maybeResetCredits(email);
  const all = store.subscribers.all();
  const sub = all[email];
  if (!sub) return { balance: 0, monthly: 0, nextReset: Date.now(), usedThisMonth: 0, unlimited: false };
  const c = norm(sub);
  return {
    balance: c.balance,
    monthly: monthlyCredits(sub.planId),
    nextReset: c.resetAt + MONTH_MS,
    usedThisMonth: c.granted,
    unlimited: monthlyCredits(sub.planId) === Infinity,
  };
}

/** Deduct one credit; returns false when exhausted. Any active plan with an
 *  unlimited allowance always succeeds. */
export function consumeAiCredit(email) {
  maybeResetCredits(email);
  const all = store.subscribers.all();
  const sub = all[email];
  if (!sub) return false;
  if (monthlyCredits(sub.planId) === Infinity) return true;
  const c = norm(sub);
  if (c.balance <= 0) return false;
  c.balance -= 1;
  c.granted += 1;
  all[email] = sub;
  store.subscribers.save(all);
  return true;
}

/** Add purchased credits (LTC top-up or manual grant). */
export function grantCreditTopup(email, amount) {
  const all = store.subscribers.all();
  const sub = all[email] || { email, planId: null, botSlots: 0, ssids: [], targetServers: [], since: null };
  const c = norm(sub);
  c.balance += amount;
  all[email] = sub;
  store.subscribers.save(all);
  return c.balance;
}
