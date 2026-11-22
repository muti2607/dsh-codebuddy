// Verifies the credit-overview cache and in-flight de-duplication using object
// identity only, so it never depends on the upstream transport or a real credential.
import { fetchCreditOverview, claimDailyCredit, invalidateCreditCache } from '../src/credits.js';

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };

ok('exports fetchCreditOverview', typeof fetchCreditOverview === 'function');
ok('exports claimDailyCredit', typeof claimDailyCredit === 'function');
ok('exports invalidateCreditCache', typeof invalidateCreditCache === 'function');

if (fails.length) {
  console.error('FAIL: ' + fails.join(', '));
  process.exit(1);
}

// Shape that makes the upstream path fail fast; only object identity is asserted.
const cred = { accessToken: 'invalid-token-for-cache-test', productCode: 'codebuddy', domain: 'copilot.tencent.com' };

const call = async () => {
  try { return await fetchCreditOverview(cred); } catch { return { threw: true }; }
};

invalidateCreditCache();
const a = await call();
const b = await call();
ok('second call reuses the cached reference', a === b);

invalidateCreditCache();
const c = await call();
ok('invalidateCreditCache drops the cached reference', c !== a);

invalidateCreditCache();
const many = await Promise.all([call(), call(), call(), call(), call()]);
ok('concurrent callers share one entry', many.every((x) => x === many[0]));

invalidateCreditCache();
const d = await call();
ok('cache can be repopulated after invalidation', d !== many[0]);

// Stale-while-revalidate: an expired entry must be served immediately from the
// old value while a background refresh runs. Time is advanced through Date.now
// so the 30s TTL boundary is exercised without sleeping.
invalidateCreditCache();
const fresh = await call();

const realNow = Date.now;
const skew = 31_000;
Date.now = () => realNow() + skew;

const staleStart = Date.now();
const stale = await call();
const staleMs = realNow() - (staleStart - skew);
ok('expired entry still returns the previous value', stale === fresh);
ok('expired entry returns immediately (< 500ms)', staleMs < 500);

Date.now = realNow;
// Let the background refresh settle, then the next read must see the new value.
await new Promise((r) => setTimeout(r, 250));
const afterRefresh = await call();
ok('background refresh replaced the cached value', afterRefresh !== fresh);

if (fails.length) {
  console.error('FAIL: ' + fails.join(', '));
  process.exit(1);
}
console.log('PASS credits cache (stale served in ' + staleMs + 'ms)');
process.exit(0);
