/**
 * Unit tests for middleware/concurrency_limiter.js (no DuckDB / HTTP).
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  HeavyQueryLimiter,
  parseMaxConcurrentFromEnv,
  buildHeavyQueryRetryPayload,
  resetHeavyQueryLimiterForTests,
  getHeavyQueryLimiter,
} = require('../../middleware/concurrency_limiter');

describe('parseMaxConcurrentFromEnv', () => {
  let savedHeavy;

  beforeEach(() => {
    savedHeavy = process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT;
  });

  afterEach(() => {
    if (savedHeavy === undefined) {
      delete process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT;
    } else {
      process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT = savedHeavy;
    }
  });

  it('treats unset as unlimited', () => {
    delete process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT;
    assert.equal(parseMaxConcurrentFromEnv(), Infinity);
  });

  it('treats empty and zero as unlimited', () => {
    process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT = '';
    assert.equal(parseMaxConcurrentFromEnv(), Infinity);
    process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT = '0';
    assert.equal(parseMaxConcurrentFromEnv(), Infinity);
  });

  it('parses positive integer', () => {
    process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT = '4';
    assert.equal(parseMaxConcurrentFromEnv(), 4);
  });
});

describe('HeavyQueryLimiter tryAcquire', () => {
  it('unlimited mode allows many tryAcquire', () => {
    const lim = new HeavyQueryLimiter(Infinity);
    for (let i = 0; i < 20; i++) {
      const a = lim.tryAcquire();
      assert.equal(a.ok, true);
      a.release();
    }
  });

  it('K=2: third tryAcquire fails until release', () => {
    const lim = new HeavyQueryLimiter(2);
    const a1 = lim.tryAcquire();
    const a2 = lim.tryAcquire();
    assert.equal(a1.ok, true);
    assert.equal(a2.ok, true);
    const a3 = lim.tryAcquire();
    assert.equal(a3.ok, false);
    assert.ok('retryAfterSeconds' in a3);
    a1.release();
    const a4 = lim.tryAcquire();
    assert.equal(a4.ok, true);
    a4.release();
    a2.release();
  });

  it('double release does not corrupt active count', () => {
    const lim = new HeavyQueryLimiter(1);
    const a = lim.tryAcquire();
    assert.equal(a.ok, true);
    a.release();
    a.release();
    const b = lim.tryAcquire();
    assert.equal(b.ok, true);
    b.release();
  });
});

describe('HeavyQueryLimiter acquire (async)', () => {
  it('K=2: third acquire completes after first release', async () => {
    const lim = new HeavyQueryLimiter(2);
    const order = [];

    const p1 = lim.acquire().then((h) => {
      order.push('a1-in');
      return new Promise((r) => setTimeout(() => {
        order.push('a1-out');
        h.release();
        r();
      }, 20));
    });
    const p2 = lim.acquire().then((h) => {
      order.push('a2-in');
      return new Promise((r) => setTimeout(() => {
        order.push('a2-out');
        h.release();
        r();
      }, 20));
    });
    const p3 = lim.acquire().then((h) => {
      order.push('a3-in');
      h.release();
    });

    await Promise.all([p1, p2, p3]);

    assert.ok(order.indexOf('a3-in') > order.indexOf('a1-out') || order.indexOf('a3-in') > order.indexOf('a2-out'),
      'third worker should start after a slot frees');
  });
});

describe('buildHeavyQueryRetryPayload', () => {
  it('includes 429 and Retry-After value', () => {
    const p = buildHeavyQueryRetryPayload(3);
    assert.equal(p.status, 429);
    assert.equal(p.retryAfterSeconds, 3);
    assert.equal(p.body.success, false);
  });
});

describe('getHeavyQueryLimiter singleton', () => {
  beforeEach(() => {
    resetHeavyQueryLimiterForTests();
  });
  afterEach(() => {
    delete process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT;
    resetHeavyQueryLimiterForTests();
  });

  it('reads env once when first called', () => {
    process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT = '2';
    const a = getHeavyQueryLimiter();
    const b = getHeavyQueryLimiter();
    assert.strictEqual(a, b);
    const x = a.tryAcquire();
    const y = a.tryAcquire();
    const z = a.tryAcquire();
    assert.equal(x.ok, true);
    assert.equal(y.ok, true);
    assert.equal(z.ok, false);
    x.release();
    y.release();
  });
});
