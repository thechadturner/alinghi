/**
 * Registry for raw dataset uploads: per class + profile (training vs racing, format).
 * Extend with new entries (e.g. ac75_*) as pipelines are added.
 *
 * Racing .jsonl files land under: data/raw/{project}/{class}/{YYYYMMDD}/JSONL/
 * (fixed folder; source metadata is expected inside the jsonl lines.)
 */

const path = require('path');
const { parseTrainingDbFile } = require('./files');

/** Reserved raw subfolder name for AC40 race jsonl uploads (no user-selected source). */
const AC40_RACE_JSONL_SOURCE = 'JSONL';

const profiles = {
  'ac40:ac40_training_db': {
    id: 'ac40_training_db',
    allowedExtensions: ['.db'],
    requiresUploadDate: true,
    resolveSourceName(req) {
      const s = req.body?.source_name;
      return typeof s === 'string' ? s.trim() : '';
    },
    async afterRawUpload(ctx) {
      const {
        savedPaths,
        auth_token,
        class_name,
        project_id,
        formattedDate,
        sourceName,
      } = ctx;
      if (!formattedDate || String(formattedDate).trim() === '') {
        throw new Error('Training .db parse: formattedDate is required');
      }
      if (!sourceName || String(sourceName).trim() === '') {
        throw new Error('Training .db parse: sourceName is required');
      }
      const dateForScript = String(formattedDate).replace(/[-/]/g, '');
      for (const savePath of savedPaths) {
        if (!savePath || !String(savePath).toLowerCase().endsWith('.db')) {
          continue;
        }
        const ok = await parseTrainingDbFile(
          auth_token,
          savePath,
          dateForScript,
          project_id,
          class_name,
          sourceName,
        );
        if (!ok) {
          throw new Error(`Training .db parse failed for ${path.basename(savePath)}`);
        }
      }
    },
  },
  'ac40:ac40_race_jsonl': {
    id: 'ac40_race_jsonl',
    allowedExtensions: ['.jsonl'],
    requiresUploadDate: true,
    resolveSourceName() {
      return AC40_RACE_JSONL_SOURCE;
    },
    async afterRawUpload() {
      /* Future: enqueue Python ingest for jsonl → system parquet, etc. */
    },
  },
};

function profileKey(classLower, profileId) {
  return `${String(classLower || '').toLowerCase()}:${String(profileId || '').trim()}`;
}

/**
 * @param {string} classLower
 * @param {string} [profileId]
 * @returns {object | null}
 */
function getProfile(classLower, profileId) {
  if (!profileId || String(profileId).trim() === '') return null;
  return profiles[profileKey(classLower, profileId)] || null;
}

/** Ids allowed in POST body upload_profile (for express-validator). */
const ALLOWED_UPLOAD_PROFILE_IDS = [...new Set(Object.values(profiles).map((p) => p.id))];

/**
 * @param {Express.Multer.File[]} files
 * @param {object} profile
 * @returns {string | null} error message or null if ok
 */
function validateFilesForProfile(files, profile) {
  if (!profile || !Array.isArray(files)) return null;
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!profile.allowedExtensions.includes(ext)) {
      return `File "${f.originalname}" is not allowed for upload profile ${profile.id} (expected: ${profile.allowedExtensions.join(', ')})`;
    }
  }
  return null;
}

module.exports = {
  getProfile,
  validateFilesForProfile,
  ALLOWED_UPLOAD_PROFILE_IDS,
  AC40_RACE_JSONL_SOURCE,
};
