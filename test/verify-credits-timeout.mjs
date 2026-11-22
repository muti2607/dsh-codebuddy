// Verifies the credits timeout guard: when an upstream billing endpoint hangs,
// the overview must fail within the helper timeout instead of waiting forever.
// Mocks fetch so it only settles when the passed signal aborts — exactly how a
// real hung socket behaves. Second phase checks a caller's abort still propagates.
import { fetchCreditOverview, invalidateCreditCache } from '../src/credits.js';

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => new Promise((_, reject) => {
  const sig = init && init.signal;
  if (!sig) return; // would hang forever, on purpose
  const bail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (sig.aborted) return bail();
  sig.addEventListener('abort', bail, { once: true });
});

const cred = { access_token: 'timeout-test', domain: 'copilot.tencent.com' };
const product = { endpoint: 'http://127.0.0.1:9', productCode: 'codebuddy', apiDomain: 'copilot.tencent.com' };

// Phase 1: no caller signal — the 4s guard must fire.
invalidateCreditCache();
const started = Date.now();
let result = null;
let threw = null;
try {
  result = await fetchCreditOverview(product, cred);
} catch (e) {
  threw = e;
}
const elapsed = Date.now() - started;

ok('overview does not throw when upstream hangs', threw === null);
ok('overview still returns ok', !!(result && result.ok));
ok('balance half reports the timeout', !!(result && /超时/.test(result.balanceError || '')));
ok('checkin half reports the timeout', !!(result && /超时/.test(result.checkinError || '')));
ok('failed within the 4s guard (<= 7s wall clock)', elapsed <= 7000);
ok('did not return before the guard fired', elapsed >= 3000);

// Phase 2: caller aborts quickly — must stop at once, not wait out the 4s guard.
const cred2 = { access_token: 'timeout-test-2', domain: 'copilot.tencent.com' };
const product2 = { endpoint: 'http://127.0.0.1:10', productCode: 'codebuddy', apiDomain: 'copilot.tencent.com' };
const ac = new AbortController();
invalidateCreditCache();
const started2 = Date.now();
const pending = fetchCreditOverview(product2, cred2, ac.signal);
setTimeout(() => ac.abort(), 50);
let result2 = null;
try {
  result2 = await pending;
} catch (e) {
  result2 = { threw: String(e && e.message) };
}
const elapsed2 = Date.now() - started2;
ok('caller abort stops the request', elapsed2 < 1500);
ok('overview resolves after caller abort', !!(result2 && result2.ok === true));

globalThis.fetch = realFetch;
if (fails.length) {
  console.error('FAIL: ' + fails.join(', ') + ' (phase1 ' + elapsed + 'ms, phase2 ' + elapsed2 + 'ms)');
  process.exit(1);
}
console.log('PASS credits timeout (phase1 ' + elapsed + 'ms, phase2 ' + elapsed2 + 'ms)');
process.exit(0);
