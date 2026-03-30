/**
 * Integration: concurrent queryParquetFiles calls share the global DuckDB connection
 * in duckdb_utils (same as production). Detects thrown errors / inconsistent row counts.
 *
 * Run from repo: npm run test:server_file
 * (must execute with cwd server_file so middleware paths resolve)
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DuckDBInstance } = require('@duckdb/node-api');

// CI-friendly DuckDB limits (production uses larger defaults from env)
process.env.DUCKDB_MEMORY_LIMIT = process.env.DUCKDB_MEMORY_LIMIT || '256MB';
process.env.DUCKDB_QUERY_TIMEOUT_MS = process.env.DUCKDB_QUERY_TIMEOUT_MS || '120000';

const { queryParquetFiles } = require('../../middleware/duckdb_utils');

const ROW_COUNT = 100;
const CHANNEL_LIST = [
  { name: 'ts', type: 'float' },
  { name: 'Bsp_kts', type: 'float' },
];

/**
 * Build a small Parquet file using an isolated DuckDB instance (not production globals).
 */
async function writeFixtureParquet(targetPath) {
  const normalized = targetPath.replace(/\\/g, '/').replace(/'/g, "''");
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const sql = `
    COPY (
      SELECT i::DOUBLE AS ts, (i::DOUBLE) * 0.1 AS Bsp_kts
      FROM range(${ROW_COUNT}) t(i)
    ) TO '${normalized}' (FORMAT PARQUET)
  `;
  await conn.runAndReadAll(sql);
}

/** 100 rows: ts 0..9 each repeated 10 times; Bsp_kts = 1. Per 1s bucket AVG=1, SUM=10. */
async function writeMultiRowPerBucketParquet(targetPath) {
  const normalized = targetPath.replace(/\\/g, '/').replace(/'/g, "''");
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const sql = `
    COPY (
      SELECT (i / 10)::DOUBLE AS ts, 1.0::DOUBLE AS Bsp_kts
      FROM range(100) t(i)
    ) TO '${normalized}' (FORMAT PARQUET)
  `;
  await conn.runAndReadAll(sql);
}

describe('duckdb_utils queryParquetFiles concurrency', () => {
  let tmpDir;
  let fixturePath;
  let multiRowBucketFixturePath;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'racesight-duckdb-test-'));
    fixturePath = path.join(tmpDir, 'fixture.parquet');
    multiRowBucketFixturePath = path.join(tmpDir, 'multi_bucket.parquet');
    await writeFixtureParquet(fixturePath);
    await writeMultiRowPerBucketParquet(multiRowBucketFixturePath);
    assert.ok(fs.existsSync(fixturePath), 'fixture parquet should exist');
    assert.ok(fs.existsSync(multiRowBucketFixturePath), 'multi-bucket fixture parquet should exist');
  });

  after(() => {
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors on Windows locks
    }
  });

  it('resolves N parallel queryParquetFiles with consistent row counts', async () => {
    const parallel = [4, 13];
    for (const N of parallel) {
      const started = Date.now();
      const tasks = Array.from({ length: N }, () =>
        queryParquetFiles([fixturePath], CHANNEL_LIST, null, null, null)
      );
      const results = await Promise.all(tasks);
      const elapsed = Date.now() - started;
      console.log(`[duckdb-concurrency] N=${N} wall_ms=${elapsed}`);

      assert.equal(results.length, N);
      for (let i = 0; i < N; i++) {
        assert.ok(Array.isArray(results[i]), `result ${i} should be array`);
        assert.equal(
          results[i].length,
          ROW_COUNT,
          `N=${N}: result ${i} row count should be ${ROW_COUNT}`
        );
      }
    }
  });

  it('resolves N parallel calls with 1s resolution (resampled)', async () => {
    const N = 8;
    const tasks = Array.from({ length: N }, () =>
      queryParquetFiles([fixturePath], CHANNEL_LIST, null, null, '1s')
    );
    const results = await Promise.all(tasks);
    assert.equal(results.length, N);
    const firstLen = results[0].length;
    for (let i = 0; i < N; i++) {
      assert.equal(
        results[i].length,
        firstLen,
        `all parallel resampled results should match length (got ${results[i].length} vs ${firstLen})`
      );
    }
  });

  it('resampled bucket_aggregate sum differs from default avg when multiple rows share a bucket', async () => {
    const listAvg = [
      { name: 'ts', type: 'float' },
      { name: 'Bsp_kts', type: 'float' },
    ];
    const listSum = [
      { name: 'ts', type: 'float' },
      { name: 'Bsp_kts', type: 'float', bucket_aggregate: 'sum' },
    ];
    const listSumAbs = [
      { name: 'ts', type: 'float' },
      { name: 'Bsp_kts', type: 'float', bucket_aggregate: 'sum_abs' },
    ];
    const rAvg = await queryParquetFiles([multiRowBucketFixturePath], listAvg, null, null, '1s');
    const rSum = await queryParquetFiles([multiRowBucketFixturePath], listSum, null, null, '1s');
    const rSumAbs = await queryParquetFiles([multiRowBucketFixturePath], listSumAbs, null, null, '1s');
    assert.ok(rAvg.length > 0, 'avg query should return rows');
    assert.equal(rAvg.length, rSum.length, 'avg and sum should same bucket count');
    assert.equal(rSum.length, rSumAbs.length, 'sum and sum_abs should same bucket count');

    const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
    const byTs = (rows) => {
      const m = new Map();
      for (const row of rows) {
        const t = num(row.ts);
        m.set(t, num(row.Bsp_kts));
      }
      return m;
    };
    const mAvg = byTs(rAvg);
    const mSum = byTs(rSum);
    const mSumAbs = byTs(rSumAbs);
    const t0 = [...mAvg.keys()].sort((a, b) => a - b)[0];
    assert.ok(Number.isFinite(t0), 'should have a bucket key');
    assert.equal(mAvg.get(t0), 1, 'AVG of ten 1s should be 1');
    assert.equal(mSum.get(t0), 10, 'SUM of ten 1s should be 10');
    assert.equal(mSumAbs.get(t0), 10, 'SUM(ABS) of ten 1s should be 10');
  });
});
