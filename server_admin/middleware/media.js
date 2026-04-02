const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const env = require('./config');
const { logMessage } = require('./logging');

const FFPROBE = 'ffprobe';
const FFMPEG = 'ffmpeg';

/**
 * Run ffprobe and return parsed JSON (format + streams).
 * @param {string} filePath
 * @returns {Promise<{ format: { duration?: string, start_time?: string }, streams: Array<{ codec_type?: string }> }>}
 */
function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      filePath
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `ffprobe exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error('ffprobe returned invalid JSON'));
      }
    });
  });
}

async function getFileMetadata(filePath) {
  const stats = await fs.stat(filePath);
  return {
    created: stats.birthtime,
    modified: stats.mtime
  };
}

function getVideoDuration(filePath) {
  return runFfprobe(filePath).then((data) => {
    const d = data?.format?.duration;
    return d != null ? parseFloat(String(d)) : 0;
  }).catch(() => 0);
}

/**
 * Compute start/end ISO datetimes and duration from video file and upload date.
 * - Duration is always taken from the video file (ffprobe format.duration).
 * - End time is always start + duration.
 * When options.useDefaultStartTime is true: start = upload date at 12:00:00 in options.timezone (then UTC).
 * Otherwise: start = file metadata start_time interpreted in options.timezone (then UTC).
 * @param {string} inputPath - Path to video file
 * @param {string} userDate - Date from upload (same as media table date): YYYYMMDD or YYYY-MM-DD
 * @param {{ timezone?: string, db?: object, useDefaultStartTime?: boolean }} [options]
 */
async function computeStartEndFromMetadata(inputPath, userDate, options) {
  const dateStr = String(userDate || '').trim();
  const normalized = dateStr && /^\d{8}$/.test(dateStr)
    ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
    : dateStr ? dateStr.replace(/\//g, '-') : '';

  let meta;
  try {
    meta = await runFfprobe(inputPath);
  } catch (err) {
    try { logMessage('0.0.0.0', '0', 'media.js', 'warn', 'computeStartEndFromMetadata: ffprobe failed', { inputPath, error: err?.message }); } catch { }
    const useDefaultStart = options?.useDefaultStartTime === true;
    if (useDefaultStart && normalized) {
      const durationSeconds = await getVideoDuration(inputPath).catch(() => 0);
      let startDate;
      if (options?.timezone && options?.db) {
        try {
          const sql = `SELECT (($1::date + 43200 * interval '1 second') AT TIME ZONE $2)::timestamptz AS value`;
          const startUtc = await options.db.GetValue(sql, [normalized, options.timezone]);
          if (startUtc != null) startDate = startUtc instanceof Date ? startUtc : new Date(startUtc);
        } catch (e) { }
      }
      if (!startDate) {
        const noonUtc = new Date(`${normalized}T12:00:00.000Z`);
        startDate = isNaN(noonUtc.getTime()) ? new Date() : noonUtc;
      }
      const startIso = startDate.toISOString();
      const endIso = new Date(startDate.getTime() + Math.max(0, durationSeconds) * 1000).toISOString();
      return { startIso, endIso, durationSeconds };
    }
    return { startIso: new Date().toISOString(), endIso: new Date().toISOString(), durationSeconds: 0 };
  }

  const f = meta?.format || {};
  const durationSeconds = parseFloat(f.duration) || 0;
  const startTimeSeconds = parseFloat(f.start_time) || 0;
  const useDefaultStart = options?.useDefaultStartTime === true;
  const secondsFromMidnight = useDefaultStart ? 43200 : startTimeSeconds; // 12:00:00 when not using file time

  if (options?.timezone && options?.db && normalized) {
    try {
      const sql = `SELECT (($1::date + $2 * interval '1 second') AT TIME ZONE $3)::timestamptz AS value`;
      const startUtc = await options.db.GetValue(sql, [normalized, secondsFromMidnight, options.timezone]);
      if (startUtc != null) {
        const startDate = startUtc instanceof Date ? startUtc : new Date(startUtc);
        const startIso = startDate.toISOString();
        const endIso = new Date(startDate.getTime() + Math.max(0, durationSeconds) * 1000).toISOString();
        return { startIso, endIso, durationSeconds };
      }
    } catch (err) {
      try { logMessage('0.0.0.0', '0', 'media.js', 'warn', 'Dataset timezone conversion failed, using UTC fallback', { error: err?.message }); } catch { }
    }
  }

  // Fallback: when useDefaultStartTime was requested, never use file start time – use upload date at 12:00:00 UTC
  if (useDefaultStart && normalized) {
    const noonUtc = new Date(`${normalized}T12:00:00.000Z`);
    if (!isNaN(noonUtc.getTime())) {
      const startIso = noonUtc.toISOString();
      const endIso = new Date(noonUtc.getTime() + Math.max(0, durationSeconds) * 1000).toISOString();
      return { startIso, endIso, durationSeconds };
    }
  }

  let computedStart = new Date(startTimeSeconds * 1000);
  if (isNaN(computedStart.getTime())) computedStart = new Date();
  if (normalized) {
    const userBase = new Date(`${normalized}T00:00:00Z`);
    if (!isNaN(userBase.getTime())) {
      const msOfDay = computedStart.getUTCHours() * 3600000 + computedStart.getUTCMinutes() * 60000 +
        computedStart.getUTCSeconds() * 1000 + computedStart.getUTCMilliseconds();
      computedStart = new Date(userBase.getTime() + msOfDay);
    }
  }
  const startIso = computedStart.toISOString();
  const endIso = new Date(computedStart.getTime() + Math.max(0, durationSeconds) * 1000).toISOString();
  return { startIso, endIso, durationSeconds };
}

function deleteOriginal(filePath) {
  fs.unlink(filePath, (err) => {
    if (err) {
      try { logMessage('0.0.0.0', '0', 'media.js', 'error', `Error deleting file: ${err.message}`, { filePath }); } catch { }
    }
  });
}

/**
 * Run a single ffmpeg encode with progress callbacks.
 * @param {object} opts { inputPath, outputPath, videoOptions: string[], audioOptions: string[], hasAudio, durationSeconds, onProgress }
 */
function runFfmpegEncode(opts) {
  const {
    inputPath,
    outputPath,
    videoOptions,
    audioOptions,
    hasAudio,
    durationSeconds,
    onProgress,
    stageName,
    step,
    totalSteps,
    filename
  } = opts;

  return new Promise((resolve, reject) => {
    const args = ['-i', inputPath, '-y', ...(videoOptions || [])];
    if (hasAudio && audioOptions && audioOptions.length) {
      args.push(...audioOptions);
    } else {
      args.push('-an');
    }
    args.push(outputPath);

    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (typeof durationSeconds === 'number' && durationSeconds > 0 && typeof onProgress === 'function') {
        const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const [, h, m, s, cs] = timeMatch.map(Number);
          const elapsed = h * 3600 + m * 60 + s + cs / 100;
          const percent = Math.min(100, Math.max(0, Math.round((elapsed / durationSeconds) * 100)));
          try { onProgress({ event: 'stage_progress', stage: stageName, step, totalSteps, percent, filename }); } catch { }
        }
      }
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.slice(-500) || `ffmpeg exited with code ${code}`));
      }
      resolve();
    });
  });
}

/**
 * Process a video into multiple resolutions. Uses system ffmpeg/ffprobe (no fluent-ffmpeg).
 */
function processVideoMulti(inputPath, options = {}) {
  const baseOutDir = options.baseOutDir || (env?.MEDIA_DIRECTORY || 'C:/MyApps/Alinghi/uploads/media');
  const filename = options.filename || path.basename(inputPath);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => { };
  const onDone = typeof options.onDone === 'function' ? options.onDone : () => { };
  const onError = typeof options.onError === 'function' ? options.onError : () => { };
  const subPath = options.subPath || '';
  const mediaSource = options.mediaSource || 'default';

  const systemDir = path.join(baseOutDir, 'Media', 'system');
  const outBase = path.join(systemDir, subPath, mediaSource);
  const outLow = path.join(outBase, 'low_res');
  const outMed = path.join(outBase, 'med_res');
  const outHigh = path.join(outBase, 'high_res');
  [systemDir, outLow, outMed, outHigh].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  try { logMessage('0.0.0.0', '0', filename, 'info', 'Starting video processing', { inputPath, baseOutDir, subPath }); } catch { }

  const outputs = [
    {
      name: 'low_res',
      file: path.join(outLow, filename),
      videoOptions: ['-vf', 'scale=640:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '32', '-preset', 'veryfast', '-movflags', 'faststart'],
      audioOptions: ['-c:a', 'aac', '-b:a', '96k']
    },
    {
      name: 'med_res',
      file: path.join(outMed, filename),
      videoOptions: ['-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'faster', '-movflags', 'faststart'],
      audioOptions: ['-c:a', 'aac', '-b:a', '128k']
    },
    {
      name: 'high_res',
      file: path.join(outHigh, filename),
      videoOptions: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'fast', '-movflags', 'faststart'],
      audioOptions: ['-c:a', 'aac', '-b:a', '160k']
    }
  ];

  const totalSteps = outputs.length;

  const writeMetadataFiles = (metadataJson) => {
    if (!metadataJson) return;
    try {
      const baseName = path.parse(filename).name + '.json';
      [outLow, outMed, outHigh].forEach((dir) => {
        const fp = path.join(dir, baseName);
        try { fs.writeFileSync(fp, JSON.stringify(metadataJson, null, 2), 'utf8'); } catch { }
      });
      try { logMessage('0.0.0.0', '0', filename, 'info', 'Wrote metadata json files', {}); } catch { }
    } catch { }
  };

  (async () => {
    let metadataJson = { filename, durationSeconds: 0 };
    let hasAudio = true;

    try {
      const probe = await runFfprobe(inputPath);
      const format = probe?.format || {};
      const durationSeconds = parseFloat(format.duration) || 0;
      const startTimeSeconds = parseFloat(format.start_time) || 0;
      const streams = Array.isArray(probe?.streams) ? probe.streams : [];
      hasAudio = streams.some((s) => (String(s?.codec_type || '').toLowerCase() === 'audio'));

      const computed = await computeStartEndFromMetadata(inputPath, options.overrideDate);
      metadataJson = { filename, durationSeconds: computed.durationSeconds, startTime: computed.startIso, endTime: computed.endIso };
    } catch (e) {
      try { logMessage('0.0.0.0', '0', filename, 'warn', 'ffprobe failed, using defaults', { error: e?.message }); } catch { }
    }

    writeMetadataFiles(metadataJson);
    const durationSeconds = metadataJson.durationSeconds || 0;

    for (let step = 0; step < outputs.length; step += 1) {
      const out = outputs[step];
      try { onProgress({ event: 'stage_start', stage: out.name, step: step + 1, totalSteps, percent: 0, filename }); } catch { }
      try { logMessage('0.0.0.0', '0', filename, 'info', `Stage start: ${out.name}`, { stage: out.name }); } catch { }

      try {
        await runFfmpegEncode({
          inputPath,
          outputPath: out.file,
          videoOptions: out.videoOptions,
          audioOptions: out.audioOptions,
          hasAudio,
          durationSeconds,
          onProgress,
          stageName: out.name,
          step: step + 1,
          totalSteps,
          filename
        });
      } catch (err) {
        try { logMessage('0.0.0.0', '0', filename, 'error', `Stage error: ${out.name} - ${err?.message}`, { stage: out.name, error: err?.message }); } catch { }
        onError({ stage: out.name, error: err?.message });
        return;
      }

      try { onProgress({ event: 'stage_end', stage: out.name, step: step + 1, totalSteps, percent: 100, filename }); } catch { }
      try { logMessage('0.0.0.0', '0', filename, 'success', `Stage complete: ${out.name}`, { stage: out.name }); } catch { }
    }

    try { deleteOriginal(inputPath); } catch { }
    const files = outputs.map((o) => ({ name: o.name, file: o.file }));
    try { logMessage('0.0.0.0', '0', filename, 'success', 'Completed video processing', { files }); } catch { }
    onDone({ success: true, files, metadata: metadataJson });
  })();
}

module.exports = { getFileMetadata, getVideoDuration, deleteOriginal, processVideoMulti, computeStartEndFromMetadata };
