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

if (fails.length) {
  console.error('FAIL: ' + fails.join(', '));
  process.exit(1);
}
console.log('PASS credits cache');
process.exit(0);
