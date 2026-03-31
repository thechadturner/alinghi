const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');

/**
 * PostgreSQL connectivity via existing shared pool (same SSL/env as the app).
 * @param {*} db - shared database singleton (shared/database/connection)
 * @returns {Promise<{ ok: boolean; detail: string; message?: string }>}
 */
async function checkPostgres(db) {
  try {
    const val = await db.getValue('SELECT 1 as value');
    if (val === 1) {
      return { ok: true, detail: 'connected' };
    }
    return { ok: false, detail: 'unexpected_result' };
  } catch (err) {
    return { ok: false, detail: 'error', message: err?.message || String(err) };
  }
}

/**
 * Verify a bind-mounted directory exists, is a directory, and is readable + writable.
 * Empty / missing env → skipped (does not fail readiness — for local dev without mounts).
 * @param {string | undefined} dirPath
 * @param {'data' | 'media'} label
 * @returns {Promise<{ ok: boolean; skipped: boolean; label: string; path: string | null; detail: string; message?: string }>}
 */
async function checkStorageMount(dirPath, label) {
  if (dirPath == null || String(dirPath).trim() === '') {
    return {
      ok: true,
      skipped: true,
      label,
      path: null,
      detail: 'not_configured'
    };
  }
  const resolved = path.resolve(String(dirPath));
  try {
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) {
      return {
        ok: false,
        skipped: false,
        label,
        path: resolved,
        detail: 'not_a_directory'
      };
    }
    await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK);
    return {
      ok: true,
      skipped: false,
      label,
      path: resolved,
      detail: 'readable_writable'
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      label,
      path: resolved,
      detail: err.code || 'error',
      message: err.message
    };
  }
}

/**
 * Full readiness: Postgres + optional data/media mounts.
 * @param {*} db - shared database singleton
 * @param {Record<string, string | undefined>} config - merged env (DATA_DIRECTORY, MEDIA_DIRECTORY)
 * @returns {Promise<{ ok: boolean; postgres: object; data: object; media: object }>}
 */
async function getReadinessReport(db, config) {
  const postgres = await checkPostgres(db);
  const data = await checkStorageMount(config.DATA_DIRECTORY, 'data');
  const media = await checkStorageMount(config.MEDIA_DIRECTORY, 'media');

  const storageFail =
    (!data.skipped && !data.ok) ||
    (!media.skipped && !media.ok);

  const ok = postgres.ok && !storageFail;

  return {
    ok,
    postgres,
    data,
    media
  };
}

module.exports = {
  checkPostgres,
  checkStorageMount,
  getReadinessReport
};
