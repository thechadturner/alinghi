const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { validationResult } = require('express-validator');

const env = require('../middleware/config');
const { extractDatetimeColumn, csvtoJSON, plrToJSON, polartoJSON, normalizeFile, parseXML, updateDatasetDateModified, verifyFileComplete } = require('../middleware/files');
const { processVideoMulti, getVideoDuration, computeStartEndFromMetadata } = require('../middleware/media');
const { sendResponse, getAuthToken } = require('../middleware/helpers');
const { logMessage } = require('../middleware/logging');
const db = require('../../server_app/middleware/db');
const { check_permissions } = require('../../server_app/middleware/auth_jwt');
const { log } = require('../../shared');
const { getProfile, validateFilesForProfile } = require('../middleware/upload_raw_profiles');

/** Get dataset timezone for (class_name, project_id, date) for video start/end local→UTC conversion. */
async function getDatasetTimezoneForDate(class_name, project_id, dateStr) {
  if (!class_name || project_id == null || !dateStr) return null;
  const normalized = /^\d{8}$/.test(String(dateStr).trim())
    ? `${String(dateStr).trim().slice(0, 4)}-${String(dateStr).trim().slice(4, 6)}-${String(dateStr).trim().slice(6, 8)}`
    : String(dateStr).trim().replace(/\//g, '-');
  try {
    const sql = `SELECT a.timezone FROM ${class_name}.datasets a INNER JOIN ${class_name}.sources b ON a.source_id = b.source_id WHERE b.project_id = $1 AND a.date = $2::date AND a.timezone IS NOT NULL AND a.timezone != '' LIMIT 1`;
    const rows = await db.GetRows(sql, [project_id, normalized]);
    const tz = rows?.[0]?.timezone;
    return (tz && typeof tz === 'string' && tz.trim() !== '') ? tz.trim() : null;
  } catch {
    return null;
  }
}

// Helper function to sanitize media source names for use in file paths
function sanitizeMediaSource(mediaSource) {
  if (!mediaSource || typeof mediaSource !== 'string') {
    return 'default';
  }
  // Remove illegal characters and replace with underscores
  return mediaSource
    .replace(/[<>:"/\\|?*]/g, '_')  // Replace illegal characters with underscore
    .replace(/\s+/g, '_')          // Replace spaces with underscore
    .replace(/_+/g, '_')           // Replace multiple underscores with single
    .replace(/^_|_$/g, '')         // Remove leading/trailing underscores
    .substring(0, 50) || 'default'; // Limit length and fallback to 'default' (preserves case, e.g. AUS)
}

// Helper function to safely move files across filesystems/devices
// Tries renameSync first (fast), falls back to copy + delete if EXDEV error occurs
function moveFileSync(sourcePath, destPath) {
  try {
    // Try rename first (fastest when source and dest are on same filesystem)
    fs.renameSync(sourcePath, destPath);
  } catch (error) {
    // If EXDEV error (cross-device link not permitted), use copy + delete
    if (error.code === 'EXDEV') {
      // Ensure destination directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      // Copy file to destination
      fs.copyFileSync(sourcePath, destPath);
      // Delete source file
      fs.unlinkSync(sourcePath);
    } else {
      // Re-throw other errors
      throw error;
    }
  }
}

const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath); 
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

// Multer constraints: limit size/count and restrict file types
const uploadFiles = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5 GB per file (video files can be 3GB+)
    files: 50, // Max files per request
  },
  fileFilter: (req, file, cb) => {
    try {
      const ext = path.extname(file.originalname).toLowerCase();
      // Allow .plr files for polar uploads (will be validated in uploadPolars function)
      const allowed = new Set(['.csv', '.txt', '.parquet', '.json', '.jsonl', '.arrow', '.mp4', '.xml', '.plr', '.db']);
      if (!allowed.has(ext)) {
        return cb(new Error(`Invalid file type: ${ext}`));
      }
      cb(null, true);
    } catch (err) {
      cb(err);
    }
  }
});

// Helper function to create targets directly (replaces HTTP fetch)
const addTarget = async (req, class_name, project_id, name, json, isPolar) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/uploads', "function": 'addTarget'}

  let label = 'target';
  if (isPolar == 1) {
    label = 'polar';
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return { success: false, message: 'Missing required parameters' };
  }

  try {
      let result = await check_permissions(req, 'write', project_id)
  
      if (result) {
          let sql = `select target_id "value" from ${class_name}.targets where project_id = $1 and name = $2`
          let params = [project_id, name]

          let result = await db.GetValue(sql, params);

          if (result) {
              sql = `update ${class_name}.targets set name = $2, json = $3::jsonb, date_modified = CURRENT_DATE where target_id = $1`
              params = [result, name, json]

              result = await db.ExecuteCommand(sql, params);

              if (result) {
                return { success: true, message: `Updated ${label} successfully` };
              } else {
                return { success: false, message: `Failed to update ${label}` };
              }
          } else {
              sql = `insert into ${class_name}.targets (project_id, name, json, date_modified, "isPolar") values ($1,$2,$3::jsonb,CURRENT_DATE,$4)`
              params = [project_id, name, json, isPolar]

              result = await db.ExecuteCommand(sql, params);

              if (result) {
                return { success: true, message: `Inserted ${label} successfully` };
              } else {
                return { success: false, message: `Failed to create ${label}` };
              }
          }
      } else {
        return { success: false, message: 'Unauthorized' };
      }
  } catch (error) {
    return { success: false, message: error.message };
  }
};

/**
 * Process normalizations in parallel with a concurrency limit
 * @param {Array} normalizationTasks - Array of tasks with { savePath, date, project_id, class_name, source_name, fileName }
 * @param {number} concurrency - Maximum number of concurrent normalizations (default: 3)
 * @param {Object} auth_token - Authentication token
 * @param {Array} results - Results array to update with normalization outcomes
 * @param {Object} db - Database instance
 * @param {Function} updateDatasetDateModified - Function to update dataset date_modified
 * @param {Function} logMessage - Logging function
 * @param {string} reqIp - Request IP address
 */
const processNormalizationsInParallel = async (
  normalizationTasks, 
  concurrency = 3, 
  auth_token, 
  results, 
  db, 
  updateDatasetDateModified, 
  logMessage, 
  reqIp
) => {
  logMessage(reqIp || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'info', `Processing ${normalizationTasks.length} file(s) in parallel (concurrency: ${concurrency})`, { 
    totalFiles: normalizationTasks.length, 
    concurrency 
  });

  // Process files in batches
  for (let i = 0; i < normalizationTasks.length; i += concurrency) {
    const batch = normalizationTasks.slice(i, i + concurrency);
    const batchNumber = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(normalizationTasks.length / concurrency);
    
    logMessage(reqIp || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'info', `Processing normalization batch ${batchNumber} of ${totalBatches} (${batch.length} file(s))`, { 
      batchNumber, 
      totalBatches, 
      batchSize: batch.length,
      files: batch.map(t => t.fileName)
    });

    // Process batch in parallel using Promise.allSettled for independent error handling
    const batchPromises = batch.map(async (task) => {
      try {
        const result = await normalizeFile(auth_token, task.savePath, task.date, task.project_id, task.class_name, task.source_name);
        
        if (result) {
          // Update dataset date_modified after successful normalization
          // Note: During uploads, datasets may not exist yet. Pass suppressWarning=true
          // to avoid logging warnings, as datasets will be created later and date_modified
          // will be updated then.
          // Get source_id from source_name
          const sourceSql = `SELECT source_id "value" FROM ${task.class_name}.sources WHERE source_name = $1 AND project_id = $2`;
          const source_id = await db.GetValue(sourceSql, [task.source_name, task.project_id]);
          
          if (source_id) {
            // Suppress warning during uploads since datasets don't exist yet
            await updateDatasetDateModified(auth_token, task.class_name, task.project_id, source_id, task.date, true);
          }
          
          return { fileName: task.fileName, success: true, date: task.date };
        } else {
          return { fileName: task.fileName, success: false, message: 'Failed to normalize file' };
        }
      } catch (error) {
        logMessage(reqIp || '0.0.0.0', auth_token?.user_id || '0', task.fileName, 'error', `Error normalizing file: ${error.message}`, { 
          fileName: task.fileName,
          error: error.stack 
        });
        return { fileName: task.fileName, success: false, message: error.message };
      }
    });

    // Wait for all files in batch to complete (success or failure)
    const batchResults = await Promise.allSettled(batchPromises);
    
    // Process results and add to results array
    batchResults.forEach((settledResult, index) => {
      if (settledResult.status === 'fulfilled') {
        results.push(settledResult.value);
      } else {
        // This shouldn't happen since we catch errors in the promise, but handle it just in case
        const task = batch[index];
        logMessage(reqIp || '0.0.0.0', auth_token?.user_id || '0', task?.fileName || 'unknown', 'error', `Unexpected error in normalization batch: ${settledResult.reason}`, { 
          error: settledResult.reason 
        });
        results.push({ fileName: task?.fileName || 'unknown', success: false, message: settledResult.reason?.message || 'Unknown error' });
      }
    });
  }

  logMessage(reqIp || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'info', `Completed parallel normalization processing`, { 
    totalFiles: normalizationTasks.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length
  });
};

const uploadData = async (req, res) => {
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header)

  const info = {"auth_token": auth_token, "location": 'server_admin/uploads', "function": 'uploadData'}

  // Wrap entire function in try-catch to prevent 502 errors
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'Validation errors in uploadData', { errors: errors.array() });
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
    
    const files = req.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'No files provided in uploadData', {});
      return sendResponse(res, info, 400, false, 'No files provided', null);
    }
    if (files.length > 50) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'Too many files in uploadData', { fileCount: files.length });
      return sendResponse(res, info, 413, false, 'Too many files (max 50)', null);
    }
    // Enforce allowed types for data upload
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      if (!['.csv', '.parquet', '.json', '.xml', '.db', '.jsonl'].includes(ext)) {
        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', `Unsupported file type in uploadData: ${ext}`, { fileName: f.originalname });
        return sendResponse(res, info, 415, false, `Unsupported file type for data upload: ${ext}`, null);
      }
    }
    const { class_name, project_id, source_name, skip_normalization, timezone, upload_date, upload_profile } = req.body;

    const parseUploadDateBody = (raw) => {
      if (raw == null || raw === '') return null;
      const s = String(raw).trim();
      const compact = s.replace(/[-/]/g, '');
      if (!/^\d{8}$/.test(compact)) return null;
      const y = compact.slice(0, 4);
      const m = compact.slice(4, 6);
      const d = compact.slice(6, 8);
      const mo = parseInt(m, 10);
      const day = parseInt(d, 10);
      if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
      const date = `${y}-${m}-${d}`;
      return { date, formattedDate: compact };
    };

    const hasDbFile = files.some((f) => path.extname(f.originalname).toLowerCase() === '.db');
    const hasJsonlFile = files.some((f) => path.extname(f.originalname).toLowerCase() === '.jsonl');
    const parsedUploadDate = parseUploadDateBody(upload_date);
    if (hasDbFile && !parsedUploadDate) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'upload_date required for .db uploads', {});
      return sendResponse(res, info, 400, false, 'upload_date is required for .db uploads (YYYYMMDD or YYYY-MM-DD)', null);
    }
    if (hasJsonlFile && !parsedUploadDate) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'upload_date required for .jsonl uploads', {});
      return sendResponse(res, info, 400, false, 'upload_date is required for .jsonl uploads (YYYYMMDD or YYYY-MM-DD)', null);
    }

    // Validate required parameters
    if (!class_name || !project_id || !source_name) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'Missing required parameters in uploadData', { class_name, project_id, source_name });
      return sendResponse(res, info, 400, false, 'Missing required parameters: class_name, project_id, and source_name are required', null);
    }

    const classLowerEarly = String(class_name || '').toLowerCase();
    const activeProfile = getProfile(classLowerEarly, upload_profile);
    if (upload_profile != null && String(upload_profile).trim() !== '' && !activeProfile) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'Unknown upload_profile', { upload_profile, class_name });
      return sendResponse(res, info, 400, false, `Unknown upload_profile for this class: ${upload_profile}`, null);
    }
    if (activeProfile) {
      const profileFileErr = validateFilesForProfile(files, activeProfile);
      if (profileFileErr) {
        return sendResponse(res, info, 400, false, profileFileErr, null);
      }
      if (activeProfile.requiresUploadDate && !parsedUploadDate) {
        return sendResponse(res, info, 400, false, 'upload_date is required for this upload profile (YYYYMMDD or YYYY-MM-DD)', null);
      }
    }

    let pathSourceName = String(source_name || '').trim();
    if (activeProfile) {
      pathSourceName = activeProfile.resolveSourceName(req);
      if (!pathSourceName) {
        return sendResponse(res, info, 400, false, 'source_name could not be resolved for this upload profile', null);
      }
    }

    // Parse skip_normalization flag (can be string "true"/"false" or boolean)
    const shouldSkipNormalization = skip_normalization === true || skip_normalization === 'true' || skip_normalization === '1';

    try {
    let dates = [];
    const results = []; // Array to keep track of each file's operation result
    const xmlFiles = []; // Track XML files for post-processing
    const metadataFiles = ['.json', '.xml']; // File extensions that don't need normalization

    // Create the directory structure base
    let dataDirectory = env.DATA_DIRECTORY || 'C:/MyApps/Hunico/Uploads';
    dataDirectory = path.normalize(dataDirectory).replace(/[\\/]+$/, '');
    const lastSegment = path.basename(dataDirectory).toLowerCase();
    if (lastSegment !== 'data') {
      dataDirectory = path.join(dataDirectory, 'Data');
    }

    // Separate files into data files and metadata files
    const dataFiles = [];
    const metadataFileList = [];
    const fileDateMap = new Map(); // Store extracted dates for each file
    
    for (const file of files) {
      const fileExt = path.extname(file.originalname).toLowerCase();
      if (metadataFiles.includes(fileExt)) {
        metadataFileList.push(file);
      } else {
        dataFiles.push(file);
      }
    }

    // First pass: Extract dates from data files
    let targetDate = null;
    let targetFormattedDate = null;
    
    for (const file of dataFiles) {
      const filePath = path.join(uploadPath, file.originalname);
      const fileName = file.originalname;
      const dataFileExt = path.extname(fileName).toLowerCase();
  
      try {
        if (!fs.existsSync(filePath)) {
          logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'warn', `File does not exist at upload path: ${filePath}`, { filePath });
          continue;
        }
        const stats = fs.statSync(filePath);
        if (!stats || stats.size === 0) {
          logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'warn', `File is empty: ${filePath}`, { filePath, size: stats?.size });
          continue;
        }

        // Verify file is fully downloaded (important for Google Drive files)
        try {
          await verifyFileComplete(filePath, 30000, 500, fileName);
        } catch (verifyError) {
          logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'error', `File verification failed for ${fileName}: ${verifyError.message}`, { 
            filePath, 
            error: verifyError.message 
          });
          throw new Error(`File ${fileName} is not fully downloaded. Please wait for download to complete and try again.`);
        }

        if ((dataFileExt === '.db' || dataFileExt === '.jsonl') && parsedUploadDate) {
          const { date: dbDate, formattedDate: dbFormatted } = parsedUploadDate;
          fileDateMap.set(fileName, { date: dbDate, formattedDate: dbFormatted });
          if (!targetDate) {
            targetDate = dbDate;
            targetFormattedDate = dbFormatted;
          }
          dates.push(dbDate);
          continue;
        }
  
        // Wrap extractDatetimeColumn in additional error handling with timeout
        let medianDatetime;
        try {
          const result = await Promise.race([
            extractDatetimeColumn(filePath),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('extractDatetimeColumn timed out after 60 seconds')), 60000)
            )
          ]);
          medianDatetime = result.medianDatetime;
        } catch (extractError) {
          logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'error', `Error in extractDatetimeColumn: ${extractError.message}`, { 
            project_id, 
            class_name, 
            source_name, 
            filePath,
            error: extractError.stack,
            errorName: extractError.name
          });
          throw extractError; // Re-throw to be caught by outer catch
        }
        
        if (!medianDatetime || isNaN(medianDatetime)) {
          throw new Error(`Invalid medianDatetime returned: ${medianDatetime}`);
        }
        
        const date = new Date(medianDatetime).toISOString().split('T')[0];
        const formattedDate = date.replace(/-/g, '');
        
        // Store date for this file
        fileDateMap.set(fileName, { date, formattedDate });
        
        // Use the first date we encounter for metadata files
        if (!targetDate) {
          targetDate = date;
          targetFormattedDate = formattedDate;
        }
        
        dates.push(date);
      } catch (error) {
        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'error', `Error extracting date from data file: ${error.message}`, { 
          project_id, 
          class_name, 
          source_name, 
          filePath: path.join(uploadPath, file.originalname),
          error: error.stack,
          errorName: error.name
        });
        // Continue processing even if date extraction fails for one file
      }
    }

    // If no dates were extracted from data files, try to extract from XML files
    if (!targetDate && metadataFileList.length > 0 && dataFiles.length === 0) {
      // Try to extract date from XML files' CreationTimeDate
      for (const file of metadataFileList) {
        if (path.extname(file.originalname).toLowerCase() === '.xml') {
          try {
            const filePath = path.join(uploadPath, file.originalname);
            if (fs.existsSync(filePath)) {
              const xmlContent = fs.readFileSync(filePath, 'utf8');
              // Extract CreationTimeDate using regex (simple approach)
              const creationTimeMatch = xmlContent.match(/<CreationTimeDate[^>]*>([^<]+)<\/CreationTimeDate>/i);
              if (creationTimeMatch && creationTimeMatch[1]) {
                const creationTime = creationTimeMatch[1].trim();
                const dateObj = new Date(creationTime);
                if (!isNaN(dateObj.getTime())) {
                  targetDate = dateObj.toISOString().split('T')[0];
                  targetFormattedDate = targetDate.replace(/-/g, '');
                  logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'info', `Extracted date from XML file ${file.originalname}: ${targetDate}`, { targetDate, fileName: file.originalname });
                  break; // Use the first valid date found
                }
              }
            }
          } catch (error) {
            logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'warn', `Error extracting date from XML file ${file.originalname}: ${error.message}`, { error: error.stack });
            // Continue to next XML file
          }
        }
      }
      
      // If still no date found from XML content, try to extract from filename
      // Race course files often have format: YYMMDD_filename.xml (e.g., 260116_race.xml)
      if (!targetDate) {
        for (const file of metadataFileList) {
          if (path.extname(file.originalname).toLowerCase() === '.xml') {
            // Try to extract YYMMDD from beginning of filename
            const filenameMatch = file.originalname.match(/^(\d{6})/);
            if (filenameMatch && filenameMatch[1]) {
              const yymmdd = filenameMatch[1];
              const yy = parseInt(yymmdd.substring(0, 2), 10);
              const mm = yymmdd.substring(2, 4);
              const dd = yymmdd.substring(4, 6);
              
              // Convert YY to YYYY (assume 20xx for years 00-49, 19xx for 50-99)
              const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
              const month = parseInt(mm, 10);
              const day = parseInt(dd, 10);
              
              // Validate month and day
              if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                targetDate = `${fullYear}-${mm}-${dd}`;
                targetFormattedDate = targetDate.replace(/-/g, '');
                logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'info', `Extracted date from XML filename ${file.originalname}: ${targetDate}`, { targetDate, fileName: file.originalname });
                break; // Use the first valid date found
              }
            }
          }
        }
      }
      
      // If still no date found, return error
      if (!targetDate) {
        return sendResponse(res, info, 400, false, 'Cannot process metadata files without data files to determine date, and could not extract date from XML files or filenames', null);
      }
    }

    // If we have metadata files but no data files, and we still don't have a date, use current date as fallback
    if (!targetDate && metadataFileList.length > 0) {
      const now = new Date();
      targetDate = now.toISOString().split('T')[0];
      targetFormattedDate = targetDate.replace(/-/g, '');
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'warn', 'No data files found, using current date for metadata files', { targetDate });
    }

    // Phase 1: Save all files and collect normalization tasks
    const normalizationTasks = []; // Array to collect files that need normalization
    
    for (const file of files) {
      const filePath = path.join(uploadPath, file.originalname);
      const fileName = file.originalname;
      const fileExt = path.extname(fileName).toLowerCase();
      const isMetadataFile = metadataFiles.includes(fileExt);
  
      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        const stats = fs.statSync(filePath);
        if (!stats || stats.size === 0) {
          throw new Error(`File is empty: ${filePath}`);
        }

        // Verify file is fully downloaded before processing (important for Google Drive files)
        // Skip verification for metadata files that were already verified in first pass
        if (!isMetadataFile) {
          try {
            await verifyFileComplete(filePath, 30000, 500, fileName);
          } catch (verifyError) {
            logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'error', `File verification failed for ${fileName} before processing: ${verifyError.message}`, { 
              filePath, 
              error: verifyError.message 
            });
            throw new Error(`File ${fileName} is not fully downloaded. Please wait for download to complete and try again.`);
          }
        }

        // Get date from map if available, otherwise extract or use target date
        let date, formattedDate;
        if (isMetadataFile) {
          // Use the target date determined from data files
          date = targetDate;
          formattedDate = targetFormattedDate;
          } else {
            // Use stored date if available, otherwise extract (shouldn't happen but safety check)
            const storedDate = fileDateMap.get(fileName);
            if ((fileExt === '.db' || fileExt === '.jsonl') && parsedUploadDate) {
              date = parsedUploadDate.date;
              formattedDate = parsedUploadDate.formattedDate;
            } else if (storedDate) {
              date = storedDate.date;
              formattedDate = storedDate.formattedDate;
            } else {
              try {
                const result = await Promise.race([
                  extractDatetimeColumn(filePath),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('extractDatetimeColumn timed out after 60 seconds')), 60000)
                  )
                ]);
                const medianDatetime = result.medianDatetime;
                if (!medianDatetime || isNaN(medianDatetime)) {
                  throw new Error(`Invalid medianDatetime returned: ${medianDatetime}`);
                }
                // Dataset date is stored in local time; use optional timezone so folder path matches dataset date
                if (timezone && typeof timezone === 'string') {
                  try {
                    date = new Date(medianDatetime).toLocaleDateString('en-CA', { timeZone: timezone });
                    formattedDate = date.replace(/-/g, '');
                  } catch (tzErr) {
                    date = new Date(medianDatetime).toISOString().split('T')[0];
                    formattedDate = date.replace(/-/g, '');
                  }
                } else {
                  date = new Date(medianDatetime).toISOString().split('T')[0];
                  formattedDate = date.replace(/-/g, '');
                }
              } catch (extractError) {
                logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'error', `Error extracting date in second pass: ${extractError.message}`, { 
                  project_id, 
                  class_name, 
                  source_name, 
                  filePath,
                  error: extractError.stack,
                  errorName: extractError.name
                });
                throw extractError; // Re-throw to be caught by outer catch
              }
            }
          }
        
        // Build path components
        // For XML files (metadata), save to date directory without source subfolder
        // For data files, save to date/source_name directory
        // Normalize class_name to lowercase for consistent directory structure
        const classLower = String(class_name || '').toLowerCase();
        let pathComponents;
        if (isMetadataFile && fileExt === '.xml') {
          // XML files go to: raw/project_id/class_name/date/
          pathComponents = [
            dataDirectory,
            "raw", 
            String(project_id), 
            classLower,
            String(formattedDate)
          ];
        } else {
          // Data files go to: raw/project_id/class_name/date/source_name/
          pathComponents = [
            dataDirectory,
            "raw", 
            String(project_id), 
            classLower,
            String(formattedDate),
            String(pathSourceName)
          ];
        }
        
        const saveDir = path.join(...pathComponents);
  
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }

        // Save the file to the specified directory (always overwrite if same name exists)
        const savePath = path.join(saveDir, file.originalname);
        const uploadedFileSize = stats.size;
        if (fs.existsSync(savePath)) {
          try {
            const existingFileStats = fs.statSync(savePath);
            logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'info', `Overwriting existing file: ${savePath}`, {
              project_id,
              class_name,
              source_name,
              savePath,
              existingSize: existingFileStats.size,
              newSize: uploadedFileSize,
            });
          } catch (statErr) {
            logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'warn', `Could not stat existing file before overwrite: ${savePath}`, { error: statErr.message });
          }
        }

        moveFileSync(filePath, savePath);

        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'info', `File saved to: ${savePath}`, { project_id, class_name, source_name, savePath });

        // Collect normalization tasks instead of processing immediately
        if (!isMetadataFile) {
          if (shouldSkipNormalization || fileExt === '.db' || fileExt === '.jsonl') {
            // Skip normalization; .db / .jsonl raw profiles are never normalized here
            results.push({ 
              fileName, 
              success: true, 
              date,
              savePath, // Include savePath so frontend can normalize later
              needsNormalization: fileExt !== '.db' && fileExt !== '.jsonl'
            });
          } else {
            // Collect task for parallel processing
            normalizationTasks.push({ 
              savePath, 
              date, 
              project_id, 
              class_name, 
              source_name, 
              fileName 
            });
          }
        } else {
          // Track XML files for post-processing
          if (fileExt === '.xml') {
            xmlFiles.push({ fileName, savePath, saveDir });
          }
          results.push({ fileName, success: true, message: 'Metadata file uploaded (no normalization needed)' });
        }
      } catch (error) {
        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', file.originalname, 'error', `Error processing file: ${error.message}`, { project_id, class_name, source_name, error: error.stack });
        results.push({ fileName, success: false, message: error.message });
      } finally {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }

    // Phase 2: Process normalizations in parallel (3 at a time)
    if (normalizationTasks.length > 0) {
      await processNormalizationsInParallel(
        normalizationTasks,
        3, // concurrency limit
        auth_token,
        results,
        db,
        updateDatasetDateModified,
        logMessage,
        req.ip || '0.0.0.0'
      );
    }

    // Phase 3: Process XML files if class_name is 'ac40'
    // IMPORTANT: This runs regardless of normalization success/failure - XML parsing is independent
    // It runs after all normalizations complete to ensure all files have been processed
    // parseXml always runs when XML files are present (regardless of skip_normalization flag)
    if (xmlFiles.length > 0 && class_name.toLowerCase() === 'ac40') {
      // Use the target date (should be the same for all files in this batch)
      const xmlDate = targetDate || dates[0];
      
      if (xmlDate) {
        // Use the directory where XML files are stored (should be the same for all XML files in a batch)
        const xmlDir = xmlFiles[0].saveDir;
        const formattedXmlDate = xmlDate.replace(/-/g, '');
        
        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'info', `Processing ${xmlFiles.length} XML file(s) for ac40 class (runs regardless of normalization success)`, { xmlDir, date: xmlDate });
        
        // Wrap in try-catch to ensure XML parsing attempt happens even if there were previous errors
        try {
          const parseResult = await parseXML(auth_token, xmlDate, project_id, class_name, xmlDir);
          if (parseResult) {
            logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'success', 'XML parsing completed successfully', { xmlDir });
            // Update dataset date_modified after successful XML parsing
            // Note: During uploads, datasets may not exist yet. Pass suppressWarning=true
            // to avoid logging warnings, as datasets will be created later and date_modified
            // will be updated then.
            // Get source_id from source_name (use first source_name from the batch)
            const sourceSql = `SELECT source_id "value" FROM ${class_name}.sources WHERE source_name = $1 AND project_id = $2`;
            const source_id = await db.GetValue(sourceSql, [source_name, project_id]);
            
            if (source_id) {
              // Suppress warning during uploads since datasets don't exist yet
              await updateDatasetDateModified(auth_token, class_name, project_id, source_id, xmlDate, true);
            }
          } else {
            logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', 'XML parsing failed', { xmlDir });
          }
        } catch (xmlError) {
          // Log error but don't throw - XML parsing errors should not prevent upload response
          logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', `Error parsing XML files: ${xmlError.message}`, { xmlDir, error: xmlError.stack });
        }
      } else {
        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'warn', 'Could not determine date for XML processing - skipping parseXML', { xmlFiles: xmlFiles.map(f => f.fileName) });
      }
    }

    // Check overall results and send the appropriate response
    const allSucceeded = results.every(result => result.success);
    const failedFiles = results.filter(result => !result.success);
    const skippedFiles = results.filter(result => result.skipped === true);

    // Include results in response when:
    // 1. skip_normalization is true (so frontend can normalize later)
    // 2. There are skipped files (so frontend can show appropriate messages)
    let responseData = dates;
    if (shouldSkipNormalization || skippedFiles.length > 0) {
      responseData = {
        dates: dates,
        results: results
      };
    }

    if (allSucceeded) {
      if (activeProfile) {
        const savedPaths = results.filter((r) => r.success && r.savePath).map((r) => r.savePath);
        try {
          await activeProfile.afterRawUpload({
            savedPaths,
            class_name,
            project_id,
            profileId: activeProfile.id,
            req,
            auth_token,
            formattedDate: targetFormattedDate,
            sourceName: pathSourceName,
          });
        } catch (hookErr) {
          logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', `afterRawUpload: ${hookErr.message}`, { error: hookErr.stack });
          return sendResponse(
            res,
            info,
            500,
            false,
            `Post-upload processing failed: ${hookErr.message}`,
            responseData,
            false,
          );
        }
      }
      return sendResponse(res, info, 200, true, 'All files uploaded and processed successfully', responseData, false);
    } else {
      const successCount = results.filter(r => r.success).length;
      const failCount = failedFiles.length;
      const message = `${successCount} file(s) succeeded, ${failCount} file(s) failed: ${JSON.stringify(failedFiles)}`;
      return sendResponse(res, info, 400, false, message, responseData, false);
    }
    } catch (error) {
      // Log error to shared logging system before sending response
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'uploadData', 'error', `Unhandled error in uploadData: ${error.message}`, { 
        error: error.stack,
        errorName: error.name,
        class_name: req.body?.class_name,
        project_id: req.body?.project_id,
        source_name: req.body?.source_name,
        fileCount: req.files?.length || 0
      });
      return sendResponse(res, info, 500, false, `Internal server error: ${error.message}`, null);
    }
  } catch (outerError) {
    // Catch any errors that occur outside the main try block (e.g., in validation)
    logMessage(req.ip || '0.0.0.0', '0', 'uploadData', 'error', `Critical error in uploadData (outer catch): ${outerError.message}`, { 
      error: outerError.stack,
      errorName: outerError.name
    });
    return sendResponse(res, info, 500, false, `Critical server error: ${outerError.message}`, null);
  }
};

const uploadTargets = async (req, res) => {
  const info = {
    auth_token: req.cookies?.auth_token,
    location: 'server_admin/uploads',
    function: 'uploadTargets'
  };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const files = req.files || [];
  if (!Array.isArray(files) || files.length === 0) {
    return sendResponse(res, info, 400, false, 'No files provided', null);
  }
  if (files.length > 50) {
    return sendResponse(res, info, 413, false, 'Too many files (max 50)', null);
  }
  // Enforce allowed types for targets (CSV, TXT, and PLR)
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!['.csv', '.txt', '.plr'].includes(ext)) {
      return sendResponse(res, info, 415, false, `Unsupported file type for targets: ${ext}`, null);
    }
  }
  const { class_name, project_id, date } = req.body;
  const providedDate = typeof date === 'string' ? date.trim() : null; // expected yyyymmdd

  const results = []; // Array to keep track of each file's operation result
  // Batch context to coordinate background processing completions
  const batchCtx = { total: files.length, completed: 0, outputs: [], errors: [] };

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const currentIndex = fileIndex + 1;
      const filePath = path.join(uploadPath, file.originalname);
      const fileName = file.originalname;
      const fileNameWithoutExtension = path.basename(fileName, path.extname(fileName));

      // Log file upload info
      logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'debug', 
        `Processing target file: ${fileName}, size: ${file.size} bytes, path: ${filePath}`, 
        { fileName, fileSize: file.size, filePath });

      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        const stats = fs.statSync(filePath);
        if (!stats || stats.size === 0) {
          throw new Error(`File is empty: ${filePath}`);
        }

        // Log actual file size on disk
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'debug', 
          `Target file on disk: ${fileName}, size: ${stats.size} bytes`, 
          { fileName, diskSize: stats.size });

        // Read first line to verify content
        const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'debug', 
          `Target file first line: ${firstLine.substring(0, 150)}`, 
          { fileName, firstLinePreview: firstLine.substring(0, 150) });

        const output_str = await csvtoJSON(filePath);

        if (output_str != null) {
          const response_json = await addTarget(req,class_name,project_id,fileNameWithoutExtension,output_str,0);

          if (response_json.success) {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', response_json.message, info.function+": "+fileName);
            results.push({ fileName, success: true });
          } else {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', response_json.message, info.function+": "+fileName);
            results.push({ fileName, success: false, message: response_json.message });
          }
        } else {
          logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', 'Failed to parse csv file', info.function+": "+fileName);
          results.push({ fileName, success: false, message: "Failed to parse csv file" });
        }
      } catch (error) {
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Exception during target upload: ${error.message}`, info.function+": "+fileName);
        results.push({ fileName, success: false, message: error.message });
      } finally {
        if (fs.existsSync(filePath)) {
          logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `Removing temporary file: ${filePath}`, info.function+": "+fileName);
          fs.unlinkSync(filePath);
        }
      }
    }

    // Check overall results and send the appropriate response
    const allSucceeded = results.every(result => result.success);
    const failedFiles = results.filter(result => !result.success);

    if (allSucceeded) {
      return sendResponse(res, info, 200, true, 'All files uploaded and processed successfully', null, false);
    } else {
      return sendResponse(res, info, 400, false, `Some files failed: ${JSON.stringify(failedFiles)}`, null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null);
  }
};

const uploadPolars = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_admin/uploads', function: 'uploadPolars' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const files = req.files || [];
  if (!Array.isArray(files) || files.length === 0) {
    return sendResponse(res, info, 400, false, 'No files provided', null);
  }
  if (files.length > 50) {
    return sendResponse(res, info, 413, false, 'Too many files (max 50)', null);
  }
  // Enforce allowed types for polars (CSV, TXT, and PLR)
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!['.csv', '.txt', '.plr'].includes(ext)) {
      return sendResponse(res, info, 415, false, `Unsupported file type for polars: ${ext}`, null);
    }
  }
  const { class_name, project_id } = req.body;

  const results = [];

  try {
    for (const file of files) {
      const filePath = path.join(uploadPath, file.originalname);
      const fileName = file.originalname;
      const fileNameWithoutExtension = path.basename(fileName, path.extname(fileName));

      // Log file upload info - show original filename and extension
      const originalExt = path.extname(fileName).toLowerCase();
      logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 
        `Processing polar file: ${fileName} (extension: ${originalExt}), size: ${file.size} bytes, path: ${filePath}`, 
        { fileName, originalExtension: originalExt, fileSize: file.size, filePath });

      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        const stats = fs.statSync(filePath);
        if (!stats || stats.size === 0) {
          throw new Error(`File is empty: ${filePath}`);
        }

        // Log actual file size on disk
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'debug', 
          `Polar file on disk: ${fileName}, size: ${stats.size} bytes`, 
          { fileName, diskSize: stats.size });

        // Read first line to verify content - show COMPLETE header and first data row
        const fileLines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
        const headerLine = fileLines[0] || '';
        const firstDataLine = fileLines[1] || '';
        
        const headerTabCount = (headerLine.match(/\t/g) || []).length;
        const headerColumns = headerLine.split('\t');
        const dataTabCount = (firstDataLine.match(/\t/g) || []).length;
        const dataColumns = firstDataLine.split('\t');
        
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 
          `COMPLETE HEADER: "${headerLine}"`, 
          { fileName, headerLine, headerTabCount, headerColumnCount: headerColumns.length });
        
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 
          `FIRST DATA ROW: "${firstDataLine}"`, 
          { fileName, firstDataLine, dataTabCount, dataColumnCount: dataColumns.length });
        
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 
          `COLUMN BREAKDOWN - Header has ${headerColumns.length} columns, First data row has ${dataColumns.length} columns`, 
          { 
            fileName,
            headerColumns: headerColumns.map((col, idx) => `[${idx}]: "${col}"`),
            dataColumns: dataColumns.map((col, idx) => `[${idx}]: "${col}"`)
          });

        // Check if file is PLR format and parse directly
        let output_str;
        if (originalExt === '.plr') {
          logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 
            `Detected PLR file format, parsing directly without conversion`, 
            { fileName, extension: originalExt });
          output_str = await plrToJSON(filePath);
        } else {
          output_str = await polartoJSON(filePath);
        }

        if (output_str != null) {
          const response_json = await addTarget(req,class_name,project_id,fileNameWithoutExtension,output_str,1);

          if (response_json.success) {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', response_json.message, info.function+": "+fileName);
            results.push({ fileName, success: true });
          } else {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', response_json.message, info.function+": "+fileName);
            results.push({ fileName, success: false, message: response_json.message });
          }
        } else {
          logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', 'Failed to parse file', info.function+": "+fileName);
          results.push({ fileName, success: false, message: "Failed to parse csv file" });
        }
      } catch (error) {
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Exception during polar upload: ${error.message}`, info.function+": "+fileName);
        results.push({ fileName, success: false, message: error.message });
      } finally {
        if (fs.existsSync(filePath)) {
          logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `Removing temporary file: ${filePath}`, info.function+": "+fileName);
          fs.unlinkSync(filePath);
        }
      }
    }

    // Check overall results and send the appropriate response
    const allSucceeded = results.every(result => result.success);
    const failedFiles = results.filter(result => !result.success);

    if (allSucceeded) {
      return sendResponse(res, info, 200, true, 'All files uploaded and processed successfully', null, false);
    } else {
      return sendResponse(res, info, 400, false, `Some files failed: ${JSON.stringify(failedFiles)}`, null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null);
  }
};

const uploadVideo = async (req, res) => {
  const info = {auth_token: req.cookies?.auth_token,location: 'server_admin/uploads',function: 'uploadVideo'};

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const files = req.files || [];
  if (!Array.isArray(files) || files.length === 0) {
    return sendResponse(res, info, 400, false, 'No files provided', null);
  }
  if (files.length > 50) {
    return sendResponse(res, info, 413, false, 'Too many files (max 50)', null);
  }
  // Enforce allowed types for video (.mp4 only)
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (ext !== '.mp4') {
      return sendResponse(res, info, 415, false, `Unsupported file type for video: ${ext}`, null);
    }
  }
  const { class_name, project_id, date, media_source, timezone: uploadTimezone, use_file_datetime: useFileDatetimeRaw } = req.body;
  const useFileDatetime = useFileDatetimeRaw !== false && useFileDatetimeRaw !== 'false' && useFileDatetimeRaw !== 0 && useFileDatetimeRaw !== '0';

  // Generate unique process_id for this upload batch
  const process_id = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const results = []; // Array to keep track of each file's operation result
  // Batch context to coordinate background processing completions
  const batchCtx = { total: files.length, completed: 0, outputs: [], errors: [], videoReadySent: false, completedFiles: new Set(), process_id };
  // Date used in progress events; validated upstream as YYYYMMDD
  const dbDate = String(date || '').trim();
  let encodingSkipped = false;

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const currentIndex = fileIndex + 1;
      const filePath = path.join(uploadPath, file.originalname);
      const fileName = file.originalname;

      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        // DATA_DIRECTORY should be C:/MyApps/Hunico/Uploads (base path); add Media if not present
        let dataRoot = env?.DATA_DIRECTORY || 'C:/MyApps/Hunico/Uploads';
        dataRoot = path.normalize(dataRoot).replace(/[\\/]+$/, '');
        const lastSegment = path.basename(dataRoot).toLowerCase();
        if (lastSegment !== 'media') {
          dataRoot = path.join(dataRoot, 'Media');
        }
        const classLower = String(class_name || '').toLowerCase();
        const sanitizedMediaSource = sanitizeMediaSource(media_source);
        const subPath = path.join(String(project_id), classLower, date, sanitizedMediaSource);

        const skipFfmpeg = env?.SKIP_VIDEO_FFMPEG === 'true' || process.env.SKIP_VIDEO_FFMPEG === 'true';

        if (skipFfmpeg) {
          encodingSkipped = true;
          // Bypass: save directly to MEDIA_DIRECTORY (not DATA_DIRECTORY) so file lands under Uploads/Media
          let mediaBase = env?.MEDIA_DIRECTORY || 'C:/MyApps/Hunico/Uploads/Media';
          mediaBase = path.normalize(mediaBase).replace(/[\\/]+$/, '');
          const medResDir = path.join(mediaBase, 'system', String(project_id), classLower, date, sanitizedMediaSource, 'med_res');
          const medResPath = path.join(medResDir, fileName);
          if (!fs.existsSync(medResDir)) fs.mkdirSync(medResDir, { recursive: true });
          moveFileSync(filePath, medResPath);
          logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `File saved as med_res (bypass): ${medResPath}`, info.function+": "+fileName);

          setImmediate(async () => {
            try {
              const tz = uploadTimezone || await getDatasetTimezoneForDate(class_name, project_id, dbDate);
              const { startIso, endIso, durationSeconds } = await computeStartEndFromMetadata(medResPath, dbDate, { timezone: tz || undefined, db, useDefaultStartTime: !useFileDatetime });
              const systemBase = path.join(mediaBase, 'system', String(project_id), classLower, date);
              const fileTemplate = path.join(systemBase, sanitizedMediaSource, '{res}', fileName);
              const payload = {
                class_name,
                project_id: Number(project_id),
                date: dbDate,
                start_time: startIso,
                end_time: endIso,
                duration: Number(durationSeconds) || 0,
                file_name: fileTemplate,
                media_source: media_source,
                tags: '{}',
                shared: 0,
                timezone: (uploadTimezone && String(uploadTimezone).trim()) || undefined
              };
              const metadataJson = { filename: fileName, durationSeconds: durationSeconds || 0, startTime: startIso, endTime: endIso };
              const metaPath = path.join(medResDir, path.parse(fileName).name + '.json');
              try { fs.writeFileSync(metaPath, JSON.stringify(metadataJson, null, 2), 'utf8'); } catch {}
              // Internal self-call: loopback works in both dev and prod Docker (same container)
              const adminPort = env.ADMIN_PORT || 8059;
              const mediaApiUrl = `http://127.0.0.1:${adminPort}/api/media`;
              let response = await fetch(mediaApiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: req.headers?.authorization || (req.cookies?.auth_token ? `Bearer ${req.cookies.auth_token}` : ''),
                  'X-CSRF-Token': req.cookies?.csrf_token || ''
                },
                body: JSON.stringify(payload)
              });
              if (response.ok) {
                logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', 'Created media record for uploaded video', info.function+": "+fileName);
              } else {
                let errJson;
                try { errJson = await response.json(); } catch {}
                logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Failed to create media record: ${response.status}`, `${info.function}: ${fileName} ${errJson ? JSON.stringify(errJson) : ''}`);
              }
            } catch (e) {
              logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Media record error: ${e?.message}`, info.function+": "+fileName);
            }
          });

          req.app?.locals?.broadcastProgress?.({
            success: true,
            event: {
              process_id: process_id,
              type: 'video_upload',
              event: 'upload_progress',
              text: `Saving ${fileName} as med_res (${currentIndex}/${files.length})`,
              now: Date.now()
            },
            data: { file: fileName, index: currentIndex, total: files.length, project_id, class_name }
          });

          batchCtx.completedFiles.add(fileName);
          batchCtx.outputs.push({ file: fileName, renditions: [{ name: 'med_res', file: medResPath }] });
          batchCtx.completed += 1;
          if (batchCtx.completed >= batchCtx.total && !batchCtx.videoReadySent) {
            batchCtx.videoReadySent = true;
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 'Broadcasting video_ready event - ALL FILES COMPLETE (bypass)', info.function+": "+fileName);
            const n = batchCtx.outputs.length;
            const errs = batchCtx.errors.length;
            const completeText = errs === 0
              ? `Upload complete: ${n} video${n === 1 ? '' : 's'} saved (encoding skipped)`
              : `Upload complete: ${n} video${n === 1 ? '' : 's'} (${errs} error${errs === 1 ? '' : 's'}; encoding skipped)`;
            req.app?.locals?.broadcastProgress?.({
              success: true,
              event: {
                process_id: process_id,
                type: 'video_upload',
                event: 'process_complete',
                text: completeText,
                now: Date.now()
              },
              data: {
                batch: true,
                class_name,
                project_id,
                date: dbDate,
                outputs: batchCtx.outputs,
                errors: batchCtx.errors
              }
            });
          }
          results.push({ fileName, success: true });
          continue;
        }

        // Normal path: move to raw then run ffmpeg
        const rawDir = path.join(dataRoot, 'raw', subPath);
        if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
        const rawPath = path.join(rawDir, fileName);
        moveFileSync(filePath, rawPath);
        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `File moved to raw: ${rawPath}`, info.function+": "+fileName);

        setImmediate(async () => {
          try {
            const tz = uploadTimezone || await getDatasetTimezoneForDate(class_name, project_id, dbDate);
            const { startIso, endIso, durationSeconds } = await computeStartEndFromMetadata(rawPath, dbDate, { timezone: tz || undefined, db, useDefaultStartTime: !useFileDatetime });
            const systemBase = path.join(dataRoot, 'Media', 'system', String(project_id), classLower, date);
            const fileTemplate = path.join(systemBase, sanitizedMediaSource, '{res}', fileName); // {res} = low_res|med_res|high_res
            
            const payload = {
              class_name,
              project_id: Number(project_id),
              date: dbDate,
              start_time: startIso,
              end_time: endIso,
              duration: Number(durationSeconds) || 0,
              file_name: fileTemplate,
              media_source: media_source,
              tags: '{}',
              shared: 0,
              timezone: (uploadTimezone && String(uploadTimezone).trim()) || undefined
            };
            // Internal self-call: loopback works in both dev and prod Docker (same container)
            const adminPort = env.ADMIN_PORT || 8059;
            const mediaApiUrl = `http://127.0.0.1:${adminPort}/api/media`;
            let response = await fetch(mediaApiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: req.headers?.authorization || (req.cookies?.auth_token ? `Bearer ${req.cookies.auth_token}` : ''),
                'X-CSRF-Token': req.cookies?.csrf_token || ''
              },
              body: JSON.stringify(payload)
            });
            if (response.ok) {
              logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', 'Created media record for uploaded video', info.function+": "+fileName);
            } else {
              let errJson;
              try { errJson = await response.json(); } catch {}
              logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Failed to create media record: ${response.status}`, `${info.function}: ${fileName} ${errJson ? JSON.stringify(errJson) : ''}`);
            }
          } catch (e) {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Media record error: ${e?.message}`, info.function+": "+fileName);
          }
        });

        logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 'Starting video processing', info.function+": "+fileName);
        req.app?.locals?.broadcastProgress?.({
          success: true,
          event: {
            process_id: process_id,
            type: 'video_upload',
            event: 'upload_progress',
            text: `Starting ${fileName} (${currentIndex}/${files.length})`,
            now: Date.now()
          },
          data: {
            file: fileName,
            index: currentIndex,
            total: files.length,
            project_id,
            class_name
          }
        });

        setImmediate(() => {
          try {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `Starting background processing for ${fileName}`, info.function+": "+fileName);
            
            // Fallback timeout to check if processing completed
            const startTime = Date.now();
            // Fallback: if onDone is never called (e.g. crash), notify after 2 hours so UI doesn't hang forever.
            // Must be longer than worst-case ffmpeg encode (large 3GB+ files can take 1h+ for all renditions).
            const FALLBACK_MS = 2 * 60 * 60 * 1000; // 2 hours
            const fallbackTimeout = setTimeout(() => {
              try {
                // Only trigger fallback if this specific file hasn't been completed yet
                if (!batchCtx.completedFiles.has(fileName)) {
                  const elapsed = Date.now() - startTime;
                  logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'warn', `FALLBACK TRIGGERED: onDone not called for ${fileName} within ${FALLBACK_MS / 60000} minutes (elapsed: ${elapsed}ms)`, info.function+": "+fileName);
                  
                  // Mark this file as completed (with fallback)
                  batchCtx.completedFiles.add(fileName);
                  batchCtx.outputs.push({ 
                    file: fileName, 
                    renditions: [
                      { name: 'low_res', file: path.join(dataRoot, 'Media', 'system', String(project_id), classLower, date, sanitizedMediaSource, 'low_res', fileName) },
                      { name: 'med_res', file: path.join(dataRoot, 'Media', 'system', String(project_id), classLower, date, sanitizedMediaSource, 'med_res', fileName) },
                      { name: 'high_res', file: path.join(dataRoot, 'Media', 'system', String(project_id), classLower, date, sanitizedMediaSource, 'high_res', fileName) }
                    ]
                  });
                  batchCtx.completed += 1;
                  
                  if (batchCtx.completed >= batchCtx.total && !batchCtx.videoReadySent) {
                    batchCtx.videoReadySent = true; // Prevent duplicate sends
                    logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 'Fallback: Broadcasting video_ready event', info.function+": "+fileName);
                    req.app?.locals?.broadcastProgress?.({
                      success: true,
                      event: {
                        process_id: process_id,
                        type: 'video_upload',
                        event: 'process_complete',
                        text: `Processed ${batchCtx.outputs.length} video${batchCtx.outputs.length === 1 ? '' : 's'} (${batchCtx.errors.length} error${batchCtx.errors.length === 1 ? '' : 's'})`,
                        now: Date.now()
                      },
                      data: {
                        batch: true,
                        class_name,
                        project_id,
                        date: dbDate,
                        outputs: batchCtx.outputs,
                        errors: batchCtx.errors
                      }
                    });
                  }
                }
              } catch (e) {
                logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Fallback check error: ${e?.message}`, info.function+": "+fileName);
              }
            }, FALLBACK_MS);
            
            processVideoMulti(rawPath, {
              baseOutDir: dataRoot,
              filename: fileName,
              subPath: path.join(String(project_id), classLower, date),
              mediaSource: sanitizedMediaSource,
              onProgress: (p) => {
                req.app?.locals?.broadcastProgress?.({
                  success: true,
                  event: {
                    process_id: process_id,
                    type: 'video_upload',
                    event: 'upload_progress',
                    text: `Processing ${fileName} [${p.stage}] ${typeof p.percent === 'number' ? p.percent.toFixed(0) : ''}% (${currentIndex}/${files.length})`,
                    now: Date.now()
                  },
                  data: {
                    file: fileName,
                    index: currentIndex,
                    total: files.length,
                    stage: p.stage,
                    step: p.step,
                    totalSteps: p.totalSteps,
                    percent: p.percent
                  }
                });
              },
              onDone: (result) => {
                try {
                  // Check if this file has already been completed (prevent duplicates)
                  if (batchCtx.completedFiles.has(fileName)) {
                    logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'warn', `Duplicate onDone callback for ${fileName} - ignoring`, info.function+": "+fileName);
                    return;
                  }
                  
                  clearTimeout(fallbackTimeout); // Cancel fallback since we got the real completion
                  logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'success', 'Completed video processing', info.function+": "+fileName);
                  logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `onDone called for ${fileName} with result:`, info.function+": "+fileName, result);
                  
                  // Mark this file as completed
                  batchCtx.completedFiles.add(fileName);
                  batchCtx.outputs.push({ file: fileName, renditions: result.files });
                  batchCtx.completed += 1;
                  
                  // Only send video_ready when ALL files have completed ALL their stages
                  logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `File ${fileName} completed. Progress: ${batchCtx.completed}/${batchCtx.total}. Outputs: ${batchCtx.outputs.length}, Errors: ${batchCtx.errors.length}`, info.function+": "+fileName);
                  
                  if (batchCtx.completed >= batchCtx.total && !batchCtx.videoReadySent) {
                    batchCtx.videoReadySent = true; // Prevent duplicate sends
                    logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', 'Broadcasting video_ready event - ALL FILES COMPLETE', info.function+": "+fileName);
                    req.app?.locals?.broadcastProgress?.({
                      success: true,
                      event: {
                        process_id: process_id,
                        type: 'video_upload',
                        event: 'process_complete',
                        text: `Processed ${batchCtx.outputs.length} video${batchCtx.outputs.length === 1 ? '' : 's'} (${batchCtx.errors.length} error${batchCtx.errors.length === 1 ? '' : 's'})`,
                        now: Date.now()
                      },
                      data: {
                        batch: true,
                        class_name,
                        project_id,
                        date: dbDate,
                        outputs: batchCtx.outputs,
                        errors: batchCtx.errors
                      }
                    });
                  }
                } catch (e) {
                  logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Error in onDone callback: ${e?.message}`, info.function+": "+fileName);
                }
              },
              onError: (e) => {
                try {
                  // Check if this file has already been processed (prevent duplicates)
                  if (batchCtx.completedFiles.has(fileName)) {
                    logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'warn', `Duplicate onError callback for ${fileName} - ignoring`, info.function+": "+fileName);
                    return;
                  }
                  
                  logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Error processing video: ${e?.error || 'unknown'}`, info.function+": "+fileName);
                  
                  // Mark this file as completed (with error)
                  batchCtx.completedFiles.add(fileName);
                  batchCtx.errors.push({ file: fileName, error: e?.error || 'unknown' });
                  batchCtx.completed += 1;
                  req.app?.locals?.broadcastProgress?.({
                    success: true,
                    event: {
                      process_id: process_id,
                      type: 'video_upload',
                      event: 'upload_progress',
                      text: `Error processing ${fileName}: ${e?.error || 'unknown'}`,
                      now: Date.now()
                    },
                    data: {
                      file: fileName,
                      index: currentIndex,
                      total: files.length,
                      error: e?.error || 'unknown'
                    }
                  });
                  if (batchCtx.completed >= batchCtx.total && !batchCtx.videoReadySent) {
                    batchCtx.videoReadySent = true; // Prevent duplicate sends
                    try { log('[PROGRESS][SEND] video_ready (batch after error)'); } catch {}
                    req.app?.locals?.broadcastProgress?.({
                      success: true,
                      event: {
                        process_id: process_id,
                        type: 'video_upload',
                        event: 'process_complete',
                        text: `Processed ${batchCtx.outputs.length} video${batchCtx.outputs.length === 1 ? '' : 's'} (${batchCtx.errors.length} error${batchCtx.errors.length === 1 ? '' : 's'})`,
                        now: Date.now()
                      },
                      data: {
                        batch: true,
                        class_name,
                        project_id,
                        date: dbDate,
                        outputs: batchCtx.outputs,
                        errors: batchCtx.errors
                      }
                    });
                  }
                } catch {}
              }
            });
          } catch (bgErr) {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'error', `Background processing error for ${fileName}: ${bgErr?.message}`, info.function+": "+fileName);
            req.app?.locals?.broadcastProgress?.({ event: 'video_error', file: fileName, error: bgErr?.message });
          }
        });

        results.push({ fileName, success: true });
      } catch (error) {
        results.push({ fileName, success: false, error: error.message });
      } finally {
        // temp file already moved to raw or cleaned on error path
        try {
          if (fs.existsSync(filePath)) {
            logMessage(req.ip || '0.0.0.0', info.auth_token?.user_id || '0', info.location, 'info', `Removing temporary file: ${filePath}`, info.function+": "+fileName);
            fs.unlinkSync(filePath);
          }
        } catch {}
      }
    }

    // Check overall results and send the appropriate response
    const allSucceeded = results.every(result => result.success);
    const failedFiles = results.filter(result => !result.success);

    if (allSucceeded) {
      return sendResponse(res, info, 200, true, 'All files uploaded and processed successfully', { process_id, encoding_skipped: encodingSkipped }, false);
    } else {
      return sendResponse(res, info, 400, false, `Some files failed: ${JSON.stringify(failedFiles)}`, null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null);
  }
};

const checkFileExists = async (req, res) => {
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header);
  const info = { auth_token, location: 'server_admin/uploads', function: 'checkFileExists' };

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'checkFileExists', 'error', 'Validation errors in checkFileExists', { errors: errors.array() });
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    const { class_name, project_id, source_name, date, file_name, file_size, is_xml } = req.query;

    // Validate required parameters
    if (!class_name || !project_id || !source_name || !date || !file_name || !file_size) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'checkFileExists', 'error', 'Missing required parameters in checkFileExists', { class_name, project_id, source_name, date, file_name, file_size });
      return sendResponse(res, info, 400, false, 'Missing required parameters: class_name, project_id, source_name, date, file_name, and file_size are required', null);
    }

    // Require write permission (upload workflow)
    const hasPermission = await check_permissions(req, 'write', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 403, false, 'Forbidden - write permission required', null);
    }

    // Construct the directory path (same logic as uploadData)
    let dataDirectory = env.DATA_DIRECTORY || 'C:/MyApps/Hunico/Uploads';
    dataDirectory = path.normalize(dataDirectory).replace(/[\\/]+$/, '');
    const lastSegment = path.basename(dataDirectory).toLowerCase();
    if (lastSegment !== 'data') {
      dataDirectory = path.join(dataDirectory, 'Data');
    }

    // Sanitize date (remove dashes/slashes) - expect YYYYMMDD format
    const sanitizedDate = String(date).replace(/[-/]/g, '');
    const classLower = String(class_name || '').toLowerCase();
    const isXml = is_xml === 'true' || is_xml === true;
    const fileExt = path.extname(file_name).toLowerCase();

    // Build path components (same logic as uploadData)
    let pathComponents;
    if (isXml && fileExt === '.xml') {
      // XML files go to: raw/project_id/class_name/date/
      pathComponents = [
        dataDirectory,
        'raw',
        String(project_id),
        classLower,
        String(sanitizedDate)
      ];
    } else {
      // Data files go to: raw/project_id/class_name/date/source_name/
      pathComponents = [
        dataDirectory,
        'raw',
        String(project_id),
        classLower,
        String(sanitizedDate),
        String(source_name)
      ];
    }

    const saveDir = path.join(...pathComponents);
    const savePath = path.join(saveDir, file_name);

    // Check if file exists and size matches
    const expectedSize = parseInt(file_size, 10);
    let exists = false;
    let sizeMatches = false;
    let actualSize = null;

    if (fs.existsSync(savePath)) {
      exists = true;
      try {
        const existingFileStats = fs.statSync(savePath);
        actualSize = existingFileStats.size;
        sizeMatches = existingFileStats.size === expectedSize;
      } catch (statError) {
        logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'checkFileExists', 'warn', `Error getting file stats for ${savePath}`, { error: statError.message });
      }
    }

    const isDuplicate = exists && sizeMatches;

    log(`[checkFileExists] File check result:`, {
      file_name,
      savePath,
      exists,
      expectedSize,
      actualSize,
      sizeMatches,
      isDuplicate
    });

    return sendResponse(res, info, 200, true, 'File check completed', {
      exists,
      sizeMatches,
      isDuplicate,
      savePath,
      expectedSize,
      actualSize
    });
  } catch (error) {
    logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'checkFileExists', 'error', `Error in checkFileExists: ${error.message}`, { error: error.stack });
    return sendResponse(res, info, 500, false, `Error checking file: ${error.message}`, null);
  }
};

const listCsvFiles = async (req, res) => {
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header);
  const info = { auth_token, location: 'server_admin/uploads', function: 'listCsvFiles' };

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'listCsvFiles', 'error', 'Validation errors in listCsvFiles', { errors: errors.array() });
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    const { class_name, project_id, date, source_name } = req.query;

    // Validate required parameters
    if (!class_name || !project_id || !date || !source_name) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'listCsvFiles', 'error', 'Missing required parameters in listCsvFiles', { class_name, project_id, date, source_name });
      return sendResponse(res, info, 400, false, 'Missing required parameters: class_name, project_id, date, and source_name are required', null);
    }

    // Require write permission (upload workflow)
    const hasPermission = await check_permissions(req, 'write', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 403, false, 'Forbidden - write permission required', null);
    }

    // Construct the directory path
    let dataDirectory = env.DATA_DIRECTORY || 'C:/MyApps/Hunico/Uploads';
    dataDirectory = path.normalize(dataDirectory).replace(/[\\/]+$/, '');
    const lastSegment = path.basename(dataDirectory).toLowerCase();
    if (lastSegment !== 'data') {
      dataDirectory = path.join(dataDirectory, 'Data');
    }

    // Sanitize date (remove dashes/slashes)
    const sanitizedDate = String(date).replace(/[-/]/g, '');
    const classLower = String(class_name || '').toLowerCase();

    // Build path: raw/project_id/class_name/date/source_name/
    const dirPath = path.join(
      dataDirectory,
      'raw',
      String(project_id),
      classLower,
      sanitizedDate,
      String(source_name)
    );

    logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'listCsvFiles', 'info', `Listing CSV files in directory: ${dirPath}`, { dirPath, class_name, project_id, date, source_name });

    // Check if directory exists
    if (!fs.existsSync(dirPath)) {
      logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'listCsvFiles', 'warn', `Directory does not exist: ${dirPath}`, { dirPath });
      return sendResponse(res, info, 404, false, `Directory not found: ${dirPath}`, []);
    }

    // Read directory and filter for CSV files
    const files = fs.readdirSync(dirPath).filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ext === '.csv' || ext === '.txt';
    });

    // Build full paths for each file
    const filePaths = files.map(file => path.join(dirPath, file));

    logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'listCsvFiles', 'info', `Found ${filePaths.length} CSV file(s)`, { fileCount: filePaths.length, files });

    return sendResponse(res, info, 200, true, `Found ${filePaths.length} CSV file(s)`, filePaths, false);
  } catch (error) {
    logMessage(req.ip || '0.0.0.0', auth_token?.user_id || '0', 'listCsvFiles', 'error', `Error in listCsvFiles: ${error.message}`, { error: error.stack });
    return sendResponse(res, info, 500, false, `Internal server error: ${error.message}`, null);
  }
};

module.exports = { uploadFiles, uploadData, uploadTargets, uploadPolars, uploadVideo, listCsvFiles, checkFileExists };