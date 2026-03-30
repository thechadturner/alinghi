'use strict';

/**
 * Limits concurrent "heavy" file/duckdb operations (e.g. POST /api/channel-values).
 * FILE_HEAVY_QUERY_MAX_CONCURRENT: unset, empty, or 0 = unlimited (default, backward compatible).
 * Positive integer = max in-flight acquisitions.
 *
 * Not wired into routes yet; use getHeavyQueryLimiter() from controllers when ready.
 */

function parseMaxConcurrentFromEnv() {
  const raw = process.env.FILE_HEAVY_QUERY_MAX_CONCURRENT;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return Infinity;
  }
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return Infinity;
  }
  return n;
}

class HeavyQueryLimiter {
  /**
   * @param {number} maxConcurrent Infinity means no limit
   */
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waitQueue = [];
  }

  /**
   * Non-blocking: if at cap, caller should respond with 429 and Retry-After.
   * @returns {{ ok: true, release: () => void } | { ok: false, retryAfterSeconds: number }}
   */
  tryAcquire() {
    if (this.maxConcurrent === Infinity) {
      return { ok: true, release: () => {} };
    }
    if (this.active < this.maxConcurrent) {
      this.active++;
      return { ok: true, release: this._makeRelease() };
    }
    return { ok: false, retryAfterSeconds: 1 };
  }

  /**
   * Blocking: wait for a slot (for use inside async handlers).
   * @returns {Promise<{ release: () => void }>}
   */
  async acquire() {
    if (this.maxConcurrent === Infinity) {
      return { release: () => {} };
    }
    if (this.active < this.maxConcurrent) {
      this.active++;
      return { release: this._makeRelease() };
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.active++;
        resolve({ release: this._makeRelease() });
      });
    });
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this._drain();
    };
  }

  _drain() {
    while (this.waitQueue.length > 0 && this.active < this.maxConcurrent) {
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }
}

let singleton = null;

function getHeavyQueryLimiter() {
  if (!singleton) {
    singleton = new HeavyQueryLimiter(parseMaxConcurrentFromEnv());
  }
  return singleton;
}

function resetHeavyQueryLimiterForTests() {
  singleton = null;
}

/**
 * Suggested shape for Express responses when tryAcquire returns ok: false.
 * @param {number} retryAfterSeconds
 */
function buildHeavyQueryRetryPayload(retryAfterSeconds = 1) {
  return {
    status: 429,
    retryAfterSeconds,
    body: {
      success: false,
      message: 'Too many concurrent heavy queries; retry after Retry-After',
    },
  };
}

module.exports = {
  HeavyQueryLimiter,
  getHeavyQueryLimiter,
  resetHeavyQueryLimiterForTests,
  parseMaxConcurrentFromEnv,
  buildHeavyQueryRetryPayload,
};
