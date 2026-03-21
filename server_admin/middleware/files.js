const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const parquet = require('@dsnp/parquetjs');
const readline = require('readline');

// Helper function to calculate median (replaces mathjs median)
const median = (values) => {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

// Helper function to round to specified decimal places (replaces mathjs round)
const round = (value, decimals = 0) => {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

const config = require('./config');
const { postData, putData } = require('../middleware/helpers');
const { logMessage } = require('./logging');
const { error } = require('../../shared');
const db = require('../middleware/db');

// Server-side API endpoints
// Use Docker service name "python" when in Docker, otherwise use localhost
// Python server always uses HTTP for internal communication
const pythonHost = (config.DOCKER_CONTAINER === 'true' || config.NODE_ENV === 'production') 
  ? 'python'  // Docker service name
  : 'localhost';
const pythonPort = config.PYTHON_PORT || '8049';

const apiEndpoints = {
  python: {
    execute_script: `http://${pythonHost}:${pythonPort}/api/execute_script`
  }
};

// Helper function to detect delimiter in text files
const detectDelimiter = (filePath) => {
  try {
    // Check if file exists and is readable
    if (!fs.existsSync(filePath)) {
      logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `File does not exist for delimiter detection: ${filePath}`, { filePath });
      return { delimiter: ',', isRegex: false }; // Default to comma
    }
    
    const stats = fs.statSync(filePath);
    if (!stats || stats.size === 0) {
      logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `File is empty, defaulting to comma delimiter`, { filePath });
      return { delimiter: ',', isRegex: false }; // Default to comma
    }
    
    // Only read first few KB to detect delimiter (more efficient for large files)
    const buffer = Buffer.alloc(8192); // 8KB buffer
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(8192, stats.size), 0);
      fs.closeSync(fd);
      
      if (bytesRead === 0) {
        return { delimiter: ',', isRegex: false }; // Default to comma if no data read
      }
      
      const firstLine = buffer.toString('utf8', 0, bytesRead).split('\n')[0];
      
      if (!firstLine || firstLine.length === 0) {
        return { delimiter: ',', isRegex: false }; // Default to comma if can't detect
      }
      
      // Try multiple delimiters and select the one that produces the maximum number of columns
      const delimiters = [
        { value: '\t', name: 'TAB', isRegex: false },
        { value: ',', name: 'COMMA', isRegex: false },
        { value: ';', name: 'SEMICOLON', isRegex: false },
        { value: /\s+/, name: 'WHITESPACE', isRegex: true } // Multiple spaces/tabs
      ];
      
      let maxColumns = 0;
      let bestDelimiter = { delimiter: '\t', isRegex: false, name: 'TAB' };
      const results = [];
      
      for (const delim of delimiters) {
        let columns;
        if (delim.isRegex) {
          columns = firstLine.split(delim.value).filter(col => col.trim().length > 0).length;
        } else {
          columns = firstLine.split(delim.value).length;
        }
        
        results.push({ name: delim.name, columns });
        
        // Prefer tab/comma over whitespace if they produce equal columns (whitespace is more ambiguous)
        if (columns > maxColumns || 
            (columns === maxColumns && !delim.isRegex && bestDelimiter.isRegex)) {
          maxColumns = columns;
          bestDelimiter = { delimiter: delim.value, isRegex: delim.isRegex, name: delim.name };
        }
      }
      
      // Log delimiter detection results
      logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
        `Delimiter detection results: ${JSON.stringify(results)}. Selected: ${bestDelimiter.name} (${maxColumns} columns)`, 
        { results, selected: bestDelimiter.name, maxColumns });
      
      return { delimiter: bestDelimiter.delimiter, isRegex: bestDelimiter.isRegex };
      
    } catch (readError) {
      if (fd) {
        try { fs.closeSync(fd); } catch (e) { /* ignore */ }
      }
      throw readError;
    }
  } catch (error) {
    logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `Error detecting delimiter, defaulting to comma: ${error.message}`, { filePath, error: error.stack });
    return { delimiter: ',', isRegex: false }; // Default to comma on error
  }
};

/**
 * Verifies that a file is fully downloaded and accessible.
 * This is especially important for files from Google Drive which may still be downloading.
 * 
 * @param {string} filePath - The full path to the file to verify
 * @param {number} maxWaitTime - Maximum time to wait in milliseconds (default: 30000 = 30 seconds)
 * @param {number} checkInterval - Interval between checks in milliseconds (default: 500)
 * @param {string} fileName - Optional file name for logging purposes
 * @returns {Promise<void>} Promise that resolves when file is verified, or rejects if timeout
 */
const verifyFileComplete = async (filePath, maxWaitTime = 30000, checkInterval = 500, fileName = null) => {
  const displayName = fileName || path.basename(filePath);
  const startTime = Date.now();
  let lastSize = 0;
  let stableCount = 0;
  const requiredStableChecks = 3; // File size must be stable for 3 consecutive checks

  logMessage('0.0.0.0', '0', displayName, 'info', `Verifying file completeness: ${displayName}`, { filePath });

  while (Date.now() - startTime < maxWaitTime) {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        continue;
      }

      // Check file size stability
      const stats = fs.statSync(filePath);
      const currentSize = stats.size;

      if (currentSize === 0) {
        // File might still be initializing
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        continue;
      }

      if (currentSize === lastSize) {
        stableCount++;
        if (stableCount >= requiredStableChecks) {
          // Size is stable, now verify we can read the file
          try {
            // Try to read a small portion from the beginning of the file
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(Math.min(1024, currentSize));
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
            fs.closeSync(fd);

            if (bytesRead === 0 && currentSize > 0) {
              // File exists but can't read from it - might still be downloading
              stableCount = 0;
              await new Promise(resolve => setTimeout(resolve, checkInterval));
              continue;
            }

            // Also try to read from the end of the file to ensure it's complete
            if (currentSize > 1024) {
              const endBuffer = Buffer.alloc(1024);
              const endFd = fs.openSync(filePath, 'r');
              const endBytesRead = fs.readSync(endFd, endBuffer, 0, 1024, Math.max(0, currentSize - 1024));
              fs.closeSync(endFd);

              if (endBytesRead === 0 && currentSize > 1024) {
                // Can't read from end - might still be downloading
                stableCount = 0;
                await new Promise(resolve => setTimeout(resolve, checkInterval));
                continue;
              }
            }

            logMessage('0.0.0.0', '0', displayName, 'info', `File verified complete: ${displayName} (${currentSize} bytes)`, { filePath, size: currentSize });
            return; // File is complete and readable
          } catch (readError) {
            logMessage('0.0.0.0', '0', displayName, 'warn', `File read check failed for ${displayName}, retrying...`, { filePath, error: readError.message });
            stableCount = 0; // Reset stability counter
          }
        }
      } else {
        // Size changed, reset stability counter
        stableCount = 0;
        lastSize = currentSize;
        logMessage('0.0.0.0', '0', displayName, 'debug', `File size changed for ${displayName}: ${lastSize} -> ${currentSize} bytes`, { filePath, lastSize, currentSize });
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    } catch (error) {
      // If file doesn't exist or other error, wait and retry
      logMessage('0.0.0.0', '0', displayName, 'debug', `Error checking file ${displayName}, retrying...`, { filePath, error: error.message });
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }

  // If we get here, we timed out
  const error = new Error(`File verification timeout for ${displayName} after ${maxWaitTime}ms. File may still be downloading.`);
  logMessage('0.0.0.0', '0', displayName, 'error', error.message, { filePath, maxWaitTime });
  throw error;
};

// Enhanced CSV parser that handles both CSV and tab-delimited files
// maxRowsToRead: optional parameter to limit how many rows to read (for date extraction, use small sample)
const parseDelimitedFile = (filePath, delimiter = null, maxRowsToRead = null) => {
  return new Promise((resolve, reject) => {
    const results = [];
    let rowCount = 0;
    const maxRows = maxRowsToRead || 100000; // Limit to prevent memory issues
    let stream = null;
    let timeoutId = null;
    let shouldStop = false;
    
    // Add timeout to prevent hanging
    // Use shorter timeout if maxRowsToRead is small (for date extraction)
    const timeoutDuration = maxRowsToRead && maxRowsToRead <= 100 ? 10000 : 60000; // 10s for small samples, 60s for full parsing
    timeoutId = setTimeout(() => {
      shouldStop = true;
      if (stream) {
        try {
          stream.destroy();
        } catch (e) {
          // Ignore destroy errors
        }
      }
      const error = new Error(`CSV parsing timed out after ${timeoutDuration/1000} seconds for file: ${path.basename(filePath)}`);
      logMessage('0.0.0.0', '0', path.basename(filePath), 'error', error.message, { filePath, maxRowsToRead, timeoutDuration });
      reject(error);
    }, timeoutDuration);
    
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        clearTimeout(timeoutId);
        reject(new Error(`File does not exist: ${filePath}`));
        return;
      }
      
      const stats = fs.statSync(filePath);
      if (!stats || stats.size === 0) {
        clearTimeout(timeoutId);
        reject(new Error(`File is empty: ${filePath}`));
        return;
      }
      
      // Auto-detect delimiter if not provided
      if (!delimiter) {
        const delimiterInfo = detectDelimiter(filePath);
        delimiter = delimiterInfo.delimiter;
        // Note: CSV parser handles string delimiters, not regex
        if (delimiterInfo.isRegex) {
          // Fall back to tab if regex delimiter detected
          delimiter = '\t';
          logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', 
            `Regex delimiter detected but CSV parser requires string delimiter. Falling back to TAB.`, 
            { filePath });
        }
      }
      
      stream = fs.createReadStream(filePath)
        .pipe(csv({ separator: delimiter }))
        .on('data', (record) => {
          if (shouldStop) return;
          
          try {
            rowCount++;
            if (rowCount <= maxRows) {
              results.push(record);
            } else if (rowCount === maxRows + 1) {
              logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `CSV file has more than ${maxRows} rows, only processing first ${maxRows} rows`, { filePath, maxRows });
              // Stop reading after maxRows to save memory
              shouldStop = true;
              if (stream) {
                try {
                  stream.destroy();
                } catch (e) {
                  // Ignore destroy errors
                }
              }
            }
          } catch (dataError) {
            logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `Error processing CSV row ${rowCount}: ${dataError.message}`, { filePath, rowCount });
            // Continue processing other rows
          }
        })
        .on('end', () => {
          clearTimeout(timeoutId);
          if (results.length === 0) {
            reject(new Error(`No data rows found in CSV file: ${filePath}`));
          } else {
            logMessage('0.0.0.0', '0', path.basename(filePath), 'info', `Successfully parsed ${results.length} rows from CSV file`, { filePath, rowCount: results.length });
            resolve(results);
          }
        })
        .on('error', (err) => {
          clearTimeout(timeoutId);
          // Don't log error if we intentionally stopped the stream
          if (!shouldStop) {
            logMessage('0.0.0.0', '0', path.basename(filePath), 'error', `Error reading CSV file: ${err.message}`, { filePath, error: err.stack });
          }
          // Resolve with what we have if we stopped intentionally
          if (shouldStop && results.length > 0) {
            resolve(results);
          } else {
            reject(err);
          }
        });
    } catch (err) {
      clearTimeout(timeoutId);
      logMessage('0.0.0.0', '0', path.basename(filePath), 'error', `Error setting up CSV parser: ${err.message}`, { filePath, error: err.stack });
      reject(err);
    }
  });
};

// Original parseCSV function for backward compatibility
const parseCSV = (filePath, channel_list) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (record) => {
        const filteredRow = extractRelevantFields(record, channel_list);
        results.push(filteredRow);
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
};

/**
 * Parse PLR file format directly and convert to JSON
 * PLR format: TWS, twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twaDn, bspDn
 * Output: Same JSON structure as polartoJSON
 * @param {string} filePath - Path to the PLR file
 * @returns {string} - JSON string with polar data
 */
const plrToJSON = async (filePath) => {
  const data = fs.readFileSync(filePath, 'utf8');
  
  // Auto-detect delimiter
  const firstLine = data.split('\n')[0];
  const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.includes(',') ? ',' : '\t');
  
  const delimiterName = delimiter === '\t' ? 'TAB' : 'COMMA';
  logMessage('0.0.0.0', '0', path.basename(filePath), 'info', 
    `Processing PLR file with delimiter: ${delimiterName}`, 
    { delimiter: delimiterName });
  
  // Parse the file
  const lines = data.split('\n')
    .map(row => row.trim())
    .filter(row => row.length > 0);
  
  if (lines.length < 2) {
    throw new Error('.plr file must have at least a header and one data row');
  }
  
  // Parse header row - first column is TWS (no header), rest are column headers
  // Format: TWS, twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twaDn, bspDn
  const headerRow = lines[0].split(delimiter).map(col => col.trim());
  const headerRowLower = headerRow.map(col => col.toLowerCase());
  
  // Log the actual header for debugging
  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
    `PLR file header (raw): ${JSON.stringify(headerRow)}`, 
    { headerRow, headerLength: headerRow.length });
  
  // Skip first column (TWS), parse headers from second column onwards
  const header = headerRowLower.slice(1);
  
  // Find column indices - simple exact match (case-insensitive, trimmed)
  // Format: twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twa4, bsp4, twaDn, bspDn, twa180, bsp180
  const findColumnIndex = (name) => {
    return header.findIndex(col => col === name.toLowerCase());
  };
  
  const twaUpIndex = findColumnIndex('twaup');
  const bspUpIndex = findColumnIndex('bspup');
  const twa1Index = findColumnIndex('twa1');
  const bsp1Index = findColumnIndex('bsp1');
  const twa2Index = findColumnIndex('twa2');
  const bsp2Index = findColumnIndex('bsp2');
  const twa3Index = findColumnIndex('twa3');
  const bsp3Index = findColumnIndex('bsp3');
  const twa4Index = findColumnIndex('twa4');
  const bsp4Index = findColumnIndex('bsp4');
  const twaDnIndex = findColumnIndex('twadn');
  const bspDnIndex = findColumnIndex('bspdn');
  const twa180Index = findColumnIndex('twa180');
  const bsp180Index = findColumnIndex('bsp180');
  
  // If still not found, try inferring from position (common PLR format)
  // Format: TWS, twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twa4, bsp4, twaDn, bspDn, twa180, bsp180
  // If we have at least 11 columns (TWS + 10 data columns), infer positions
  let inferredTwaUpIndex = twaUpIndex;
  let inferredBspUpIndex = bspUpIndex;
  let inferredTwa1Index = twa1Index;
  let inferredBsp1Index = bsp1Index;
  let inferredTwa2Index = twa2Index;
  let inferredBsp2Index = bsp2Index;
  let inferredTwa3Index = twa3Index;
  let inferredBsp3Index = bsp3Index;
  let inferredTwa4Index = twa4Index;
  let inferredBsp4Index = bsp4Index;
  let inferredTwaDnIndex = twaDnIndex;
  let inferredBspDnIndex = bspDnIndex;
  let inferredTwa180Index = twa180Index;
  let inferredBsp180Index = bsp180Index;
  
  if (headerRow.length >= 11) {
    // Infer positions: TWS (0), twaUp (1), bspUp (2), twa1 (3), bsp1 (4), twa2 (5), bsp2 (6), twa3 (7), bsp3 (8), twa4 (9), bsp4 (10), twaDn (11), bspDn (12), twa180 (13), bsp180 (14)
    if (inferredTwaUpIndex === -1) inferredTwaUpIndex = 0; // First column after TWS (index 1 in full row, but 0 in header array)
    if (inferredBspUpIndex === -1) inferredBspUpIndex = 1;
    if (inferredTwa1Index === -1) inferredTwa1Index = 2;
    if (inferredBsp1Index === -1) inferredBsp1Index = 3;
    if (inferredTwa2Index === -1) inferredTwa2Index = 4;
    if (inferredBsp2Index === -1) inferredBsp2Index = 5;
    if (inferredTwa3Index === -1) inferredTwa3Index = 6;
    if (inferredBsp3Index === -1) inferredBsp3Index = 7;
    if (inferredTwa4Index === -1 && headerRow.length >= 13) inferredTwa4Index = 8; // Only infer if file has twa4 column
    if (inferredBsp4Index === -1 && headerRow.length >= 13) inferredBsp4Index = 9;
    if (inferredTwaDnIndex === -1) inferredTwaDnIndex = headerRow.length >= 13 ? 10 : 8; // Adjust based on whether twa4 exists
    if (inferredBspDnIndex === -1) inferredBspDnIndex = headerRow.length >= 13 ? 11 : 9;
    if (inferredTwa180Index === -1 && headerRow.length >= 15) inferredTwa180Index = 12; // Only infer if file has twa180 column
    if (inferredBsp180Index === -1 && headerRow.length >= 15) inferredBsp180Index = 13;
    
    if (twaUpIndex === -1 || bspUpIndex === -1 || twaDnIndex === -1 || bspDnIndex === -1) {
      logMessage('0.0.0.0', '0', path.basename(filePath), 'info', 
        `Column names not found, inferring from position (header has ${headerRow.length} columns)`, 
        { headerLength: headerRow.length, inferredIndices: {
          twaUp: inferredTwaUpIndex, bspUp: inferredBspUpIndex,
          twa4: inferredTwa4Index, bsp4: inferredBsp4Index,
          twaDn: inferredTwaDnIndex, bspDn: inferredBspDnIndex,
          twa180: inferredTwa180Index, bsp180: inferredBsp180Index
        }});
    }
  }
  
  // Use exact positions from header (header is already correct)
  // Header: twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twa4, bsp4, twaDn, bspDn, twa180, bsp180
  // Indices in header array (after slicing): 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  const finalTwaUpIndex = 0;
  const finalBspUpIndex = 1;
  const finalTwa1Index = 2;
  const finalBsp1Index = 3;
  const finalTwa2Index = 4;
  const finalBsp2Index = 5;
  const finalTwa3Index = 6;
  const finalBsp3Index = 7;
  const finalTwa4Index = 8;
  const finalBsp4Index = 9;
  const finalTwaDnIndex = 10;
  const finalBspDnIndex = 11;
  const finalTwa180Index = 12;
  const finalBsp180Index = 13;
  
  // Validate required columns - if still not found, throw error with helpful message
  if (finalTwaUpIndex === -1 || finalBspUpIndex === -1) {
    const availableColumns = headerRow.slice(1).join(', ');
    throw new Error(`Upwind target columns (twaUp, bspUp) not found in .plr file. Available columns: ${availableColumns}`);
  }
  if (finalTwaDnIndex === -1 || finalBspDnIndex === -1) {
    const availableColumns = headerRow.slice(1).join(', ');
    throw new Error(`Downwind target columns (twaDn, bspDn) not found in .plr file. Available columns: ${availableColumns}`);
  }
  
  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
    `PLR file header columns found: twaUp=${finalTwaUpIndex}, bspUp=${finalBspUpIndex}, twa1=${finalTwa1Index}, bsp1=${finalBsp1Index}, twa2=${finalTwa2Index}, bsp2=${finalBsp2Index}, twa3=${finalTwa3Index}, bsp3=${finalBsp3Index}, twa4=${finalTwa4Index}, bsp4=${finalBsp4Index}, twaDn=${finalTwaDnIndex}, bspDn=${finalBspDnIndex}, twa180=${finalTwa180Index}, bsp180=${finalBsp180Index}`, 
    { twaUpIndex: finalTwaUpIndex, bspUpIndex: finalBspUpIndex, twa1Index: finalTwa1Index, bsp1Index: finalBsp1Index, twa2Index: finalTwa2Index, bsp2Index: finalBsp2Index, twa3Index: finalTwa3Index, bsp3Index: finalBsp3Index, twa4Index: finalTwa4Index, bsp4Index: finalBsp4Index, twaDnIndex: finalTwaDnIndex, bspDnIndex: finalBspDnIndex, twa180Index: finalTwa180Index, bsp180Index: finalBsp180Index });
  
  let polar = [];
  
  // Process data rows (skip header row)
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(delimiter).map(col => col.trim());
    
    // TWS is in first column (index 0)
    const tws = parseFloat(row[0]);
    
    if (isNaN(tws)) {
      continue; // Skip rows with invalid TWS
    }
    
    // Row 0: Insert zeros as requested
    polar.push({
      row: 0,
      tws: tws,
      twa: 0,
      bsp: 0,
      vmg: 0,
      tgt: 0
    });
    
    // Row 1: upwind target (twaUp, bspUp) - twa from column 0, bsp from column 1
    if (row.length > 2) {
      const twa = parseFloat(row[1]); // Column 1 = twaUp (angle)
      const bsp = parseFloat(row[2]); // Column 2 = bspUp (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 1,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 1
        });
      }
    }
    
    // Row 2: twa1, bsp1 - twa from column 2, bsp from column 3
    if (row.length > 4) {
      const twa = parseFloat(row[3]); // Column 3 = twa1 (angle)
      const bsp = parseFloat(row[4]); // Column 4 = bsp1 (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 2,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 0
        });
      }
    }
    
    // Row 3: twa2, bsp2 - twa from column 4, bsp from column 5
    if (row.length > 6) {
      const twa = parseFloat(row[5]); // Column 5 = twa2 (angle)
      const bsp = parseFloat(row[6]); // Column 6 = bsp2 (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 3,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 0
        });
      }
    }
    
    // Row 4: twa3, bsp3 - twa from column 6, bsp from column 7
    if (row.length > 8) {
      const twa = parseFloat(row[7]); // Column 7 = twa3 (angle)
      const bsp = parseFloat(row[8]); // Column 8 = bsp3 (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 4,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 0
        });
      }
    }
    
    // Row 5: twa4, bsp4 - twa from column 8, bsp from column 9
    if (row.length > 10) {
      const twa = parseFloat(row[9]); // Column 9 = twa4 (angle)
      const bsp = parseFloat(row[10]); // Column 10 = bsp4 (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 5,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 0
        });
      }
    }
    
    // Row 6: downwind target (twaDn, bspDn) - twa from column 10, bsp from column 11
    if (row.length > 12) {
      const twa = parseFloat(row[11]); // Column 11 = twaDn (angle)
      const bsp = parseFloat(row[12]); // Column 12 = bspDn (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 6,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 1
        });
      }
    }
    
    // Row 7: twa180, bsp180 - twa from column 12, bsp from column 13
    if (row.length > 14) {
      const twa = parseFloat(row[13]); // Column 13 = twa180 (angle)
      const bsp = parseFloat(row[14]); // Column 14 = bsp180 (speed)
      if (!isNaN(twa) && !isNaN(bsp)) {
        const vmg = Math.abs(round(Math.cos(twa * Math.PI / 180) * bsp, 1));
        polar.push({
          row: 7,
          tws: tws,
          twa: twa,
          bsp: bsp,
          vmg: vmg,
          tgt: 0
        });
      }
    }
  }
  
  if (polar.length === 0) {
    throw new Error('No valid polar data extracted from .plr file');
  }
  
  // Convert to JSON
  const output = JSON.stringify(polar);
  logMessage('0.0.0.0', '0', path.basename(filePath), 'info', 
    `PLR file parsed successfully: ${polar.length} data points`, 
    { dataPointCount: polar.length });
  
  return output;
};

const polartoJSON = async (filePath) => {
  const data = fs.readFileSync(filePath, 'utf8');

  // Auto-detect delimiter
  const delimiterInfo = detectDelimiter(filePath);
  const delimiter = delimiterInfo.delimiter;
  const isRegexDelimiter = delimiterInfo.isRegex;
  
  const delimiterName = delimiter === '\t' ? 'TAB' : 
                       delimiter === ',' ? 'COMMA' :
                       delimiter === ';' ? 'SEMICOLON' :
                       isRegexDelimiter ? 'WHITESPACE' : delimiter;
  
  logMessage('0.0.0.0', '0', path.basename(filePath), 'info', 
    `Processing polar file with delimiter: ${delimiterName}`, 
    { delimiter: delimiterName, isRegex: isRegexDelimiter });

  // Parse the file into rows and columns using detected delimiter
  // Filter out empty rows and trim each row
  const rows = data.split('\n')
    .map(row => row.trim())
    .filter(row => row.length > 0)
    .map(row => {
      // Split by delimiter and preserve empty columns (or filter them for regex)
      let cols;
      if (isRegexDelimiter) {
        // For regex delimiters (whitespace), filter out empty strings
        cols = row.split(delimiter).filter(col => col.trim().length > 0);
      } else {
        // For character delimiters, preserve empty columns
        cols = row.split(delimiter);
      }
      return cols;
    });
  
  if (rows.length === 0) {
    throw new Error('File is empty or has no valid rows');
  }
  
  let header = rows[0]; // Assuming the first row is the header
  header = header.map(col => col ? col.trim().toLowerCase() : ''); // Convert header to lowercase, handle empty columns
  const dataRows = rows.slice(1);
  
  // Log header and first data row to see actual column counts
  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
      `Header has ${header.length} columns: ${JSON.stringify(header)}`, 
      { headerLength: header.length, header });
  
  // Check if data rows have more columns than header (might indicate missing header columns)
  let maxDataRowLength = 0;
  if (dataRows.length > 0) {
    maxDataRowLength = Math.max(...dataRows.map(row => row.length));
    logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
        `First data row has ${dataRows[0].length} columns, max across all rows: ${maxDataRowLength}. First 15: ${JSON.stringify(dataRows[0].slice(0, 15))}`, 
        { rowLength: dataRows[0].length, maxRowLength: maxDataRowLength, firstRow: dataRows[0].slice(0, 15) });
    
    // Also log the raw first line to see delimiter
    const firstDataLine = data.split('\n').filter(line => line.trim().length > 0)[1];
    if (firstDataLine) {
      logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
          `First data line (full): ${firstDataLine}`, 
          { firstLine: firstDataLine, lineLength: firstDataLine.length, tabCount: (firstDataLine.match(/\t/g) || []).length });
    }
  }
  
  // If data rows have more columns than header, pad the header with empty strings
  if (maxDataRowLength > header.length) {
    logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
        `Data rows have ${maxDataRowLength} columns but header has ${header.length}. Padding header.`, 
        { headerLength: header.length, maxRowLength: maxDataRowLength });
    while (header.length < maxDataRowLength) {
      header.push(''); // Add empty header columns
    }
  }

  // Derive column count
  // First column (index 0) is TWS with no header, so we have (header.length - 1) / 2 angle/speed pairs
  const columnCount = (header.length - 1) / 2;
  
  // Log header info for debugging
  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
      `Polar file header: ${header.length} columns, calculated columnCount: ${columnCount}, header: ${JSON.stringify(header)}`, 
      { headerLength: header.length, columnCount, header });

  // Determine twsColumn - first column (index 0) is TWS with empty header
  let twsColumn = 0; // Default to first column
  header.forEach((col, index) => {
      if (col && col.includes('tws')) {
        twsColumn = index;
      }
  });

  // Format: (empty/TWS), twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twa4, bsp4, twaDn, bspDn, twa180, bsp180
  // OR old format: tws, *v0, *a0, v1, a1, *v2, *a2, v3, a3, v4, a4, *v5, *a5, v6, a6
  // Column 0: TWS (no header/empty, or "tws" in old format)
  // New format: angle (twa) comes first, then speed (bsp)
  // Old format: speed (v) comes first, then angle (a)
  // Row 0: Column 1: twaUp/*v0 (angle/speed), Column 2: bspUp/*a0 (speed/angle)
  // Row 1: Column 3: twa1/v1 (angle/speed), Column 4: bsp1/a1 (speed/angle)
  // Row 2: Column 5: twa2/*v2 (angle/speed), Column 6: bsp2/*a2 (speed/angle)
  // Row 3: Column 7: twa3/v3 (angle/speed), Column 8: bsp3/a3 (speed/angle)
  // Row 4: Column 9: twa4/v4 (angle/speed), Column 10: bsp4/a4 (speed/angle)
  // Row 5: Column 11: twaDn/*v5 (angle/speed), Column 12: bspDn/*a5 (speed/angle) - downwind
  // Row 6: Column 13: twa180/v6 (angle/speed), Column 14: bsp180/a6 (speed/angle) - 180
  
  // Map header names to row indices and find their column positions
  const columnMap = {
    // New format: twaUp, bspUp, etc. (angle first, then speed)
    'twaup': { rowIndex: 0, type: 'angle' },
    'bspup': { rowIndex: 0, type: 'speed' },
    'twa1': { rowIndex: 1, type: 'angle' },
    'bsp1': { rowIndex: 1, type: 'speed' },
    'twa2': { rowIndex: 2, type: 'angle' },
    'bsp2': { rowIndex: 2, type: 'speed' },
    'twa3': { rowIndex: 3, type: 'angle' },
    'bsp3': { rowIndex: 3, type: 'speed' },
    'twa4': { rowIndex: 4, type: 'angle' },
    'bsp4': { rowIndex: 4, type: 'speed' },
    'twadn': { rowIndex: 5, type: 'angle' },
    'bspdn': { rowIndex: 5, type: 'speed' },
    'twa180': { rowIndex: 6, type: 'angle' },
    'bsp180': { rowIndex: 6, type: 'speed' },
    // Old format: *v0, *a0, v1, a1, etc. (speed first, then angle)
    '*v0': { rowIndex: 0, type: 'speed' },
    '*a0': { rowIndex: 0, type: 'angle' },
    'v1': { rowIndex: 1, type: 'speed' },
    'a1': { rowIndex: 1, type: 'angle' },
    '*v2': { rowIndex: 2, type: 'speed' },
    '*a2': { rowIndex: 2, type: 'angle' },
    'v3': { rowIndex: 3, type: 'speed' },
    'a3': { rowIndex: 3, type: 'angle' },
    'v4': { rowIndex: 4, type: 'speed' },
    'a4': { rowIndex: 4, type: 'angle' },
    '*v5': { rowIndex: 5, type: 'speed' },
    '*a5': { rowIndex: 5, type: 'angle' },
    'v6': { rowIndex: 6, type: 'speed' },
    'a6': { rowIndex: 6, type: 'angle' }
  };

  // Find column indices for each row by searching for header names
  const rowColumnMap = {};
  header.forEach((col, index) => {
    const colLower = col ? col.trim().toLowerCase() : '';
    if (columnMap[colLower]) {
      const { rowIndex, type } = columnMap[colLower];
      if (!rowColumnMap[rowIndex]) {
        rowColumnMap[rowIndex] = {};
      }
      rowColumnMap[rowIndex][type] = index;
    }
  });

  // Log what we found
  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
      `Found column mappings: ${JSON.stringify(rowColumnMap)}`, 
      { rowColumnMap });

  const getColumnIndices = (rowIndex) => {
    const rowCols = rowColumnMap[rowIndex];
    if (!rowCols || rowCols.angle === undefined || rowCols.speed === undefined) {
      return null; // Columns not found for this row
    }
    return {
      angle: rowCols.angle,
      speed: rowCols.speed
    };
  };

  let polar = [];

  // Iterate through data rows
  dataRows.forEach(row => {
      // Process all 7 rows (0-6) - always loop 7 times to ensure we get twa180/bsp180
      // Row 0: upwind, Rows 1-4: twa1-4, Row 5: downwind, Row 6: twa180
      for (let i = 0; i <= 6; i++) {
          let columnIndices = getColumnIndices(i);
          
          // If columns not found in header but we have enough data columns (15), infer position
          // Format: TWS (0), then pairs starting at index 1
          // Row 0: columns 1-2, Row 1: columns 3-4, ..., Row 6: columns 13-14
          if (!columnIndices && row.length >= 15) {
              const baseIndex = 1 + (i * 2);
              if (baseIndex + 1 < row.length) {
                  // Check if we're in old format (has *v0, *a0) or new format
                  const isOldFormat = header.some(col => col && (col.includes('*v0') || col.includes('*a0')));
                  if (isOldFormat) {
                      // Old format: speed (*v) first, then angle (*a)
                      columnIndices = {
                          speed: baseIndex,
                          angle: baseIndex + 1
                      };
                  } else {
                      // New format: angle (twa) first, then speed (bsp)
                      columnIndices = {
                          angle: baseIndex,
                          speed: baseIndex + 1
                      };
                  }
              }
          }
          
          // Skip if we don't have column indices
          if (!columnIndices) {
              continue;
          }
          
          // Check if we have enough columns in this data row
          if (columnIndices.angle >= row.length || columnIndices.speed >= row.length) {
              continue;
          }

          let windspeed = {};

          // Determine if this is a target (upwind or downwind)
          const tgt = (i === 0 || i === 5) ? 1 : 0; // Row 0 (upwind) and Row 5 (downwind) are targets

          const tws = parseFloat(row[twsColumn]);
          const cwaValue = row[columnIndices.angle] ? row[columnIndices.angle].trim() : '';
          const bspValue = row[columnIndices.speed] ? row[columnIndices.speed].trim() : '';
          const cwa = parseFloat(cwaValue);
          const bsp = parseFloat(bspValue);
          
          // Skip if values are invalid
          if (isNaN(tws) || isNaN(cwa) || isNaN(bsp)) {
              // Log for debugging - but only for rows 5 and 6 to avoid spam
              if (i >= 5) {
                  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', 
                      `Row ${i} skipped: invalid values. TWS: ${tws}, CWA: ${cwaValue} (${cwa}), BSP: ${bspValue} (${bsp})`, 
                      { rowIndex: i, tws, cwaValue, cwa, bspValue, bsp });
              }
              continue;
          }

          // Convert degrees to radians: cwa * Math.PI / 180, then calculate cosine
          const vmg = Math.abs(round(Math.cos(cwa * Math.PI / 180) * bsp, 1));

          windspeed["row"] = i;
          windspeed["tws"] = tws;
          windspeed["cwa"] = cwa;
          windspeed["bsp"] = bsp;
          windspeed["vmg"] = vmg;
          windspeed["tgt"] = tgt;
          polar.push(windspeed);
      }
  });

  // Convert to JSON
  const output = JSON.stringify(polar);
  return output;
}

const csvtoJSON = async (filePath) => {
  return new Promise((resolve, reject) => {
    let upwindTargets = [];
    let downwindTargets = [];
    let filterColumn = null;

    logMessage('0.0.0.0', '0', path.basename(filePath), 'info', `Processing file: ${filePath}`, { filePath });

    // Auto-detect delimiter
    const delimiterInfo = detectDelimiter(filePath);
    let delimiter = delimiterInfo.delimiter;
    
    // CSV parser requires string delimiter, not regex
    if (delimiterInfo.isRegex) {
      delimiter = '\t';
      logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', 
        `Regex delimiter detected but CSV parser requires string delimiter. Falling back to TAB.`, 
        { filePath });
    }
    
    const delimiterName = delimiter === '\t' ? 'TAB' : 
                         delimiter === ',' ? 'COMMA' :
                         delimiter === ';' ? 'SEMICOLON' : delimiter;
    
    logMessage('0.0.0.0', '0', path.basename(filePath), 'info', `Detected delimiter: ${delimiterName}`, { delimiter: delimiterName });

    fs.createReadStream(filePath)
      .pipe(csv({ separator: delimiter }))
      .on('headers', (headers) => {
        // Normalize headers to lowercase and search for 'cwa' or 'twa'
        filterColumn = headers.find(header => /cwa|twa/i.test(header.toLowerCase()));
        if (!filterColumn) {
          reject(new Error("No filter column found matching 'cwa' or 'twa'."));
        }
      })
      .on('data', (row) => {
        if (!filterColumn) return; // Skip processing if filterColumn is not found

        const filterValue = Math.abs(parseFloat(row[filterColumn]));
        if (Number.isNaN(filterValue)) return; // Skip invalid rows

        const targets = {};
        Object.keys(row).forEach(key => {
          const trimmedKey = key.trim().toLowerCase(); // Trim spaces and convert key to lowercase
          const value = Number.isNaN(parseFloat(row[key])) ? row[key] : parseFloat(row[key]);
          targets[trimmedKey] = value;
        });

        if (filterValue < 90) {
          upwindTargets.push(targets);
        } else if (filterValue > 90) {
          downwindTargets.push(targets);
        }
      })
      .on('end', () => {
        const finalTargets = {
          UPWIND: upwindTargets,
          DOWNWIND: downwindTargets
        };

        const output = JSON.stringify(finalTargets, null, 2);
        resolve(output);
      })
      .on('error', (err) => {
        reject(err); // Reject the Promise on error
      });
  });
}

const parseParquet = async (filePath, channel_list, start_ts = null, end_ts = null) => {
  const results = [];

  try {
    logMessage('0.0.0.0', '0', path.basename(filePath), 'info', `Reading Parquet file: ${filePath}`, { filePath });

    const reader = await parquet.ParquetReader.openFile(filePath);

    if (typeof channel_list === "string") {
      channel_list = JSON.parse(channel_list); // Try parsing if it's a JSON string
    }

    if (!Array.isArray(channel_list)) {
      throw new Error("channel_list must be a valid JSON array");
    }

    // Get available columns from the file schema
    const availableColumns = Object.keys(reader.schema.fields);
    
    // Build columns to fetch, but exclude 'Datetime' to avoid BigInt conversion errors
    // Prefer 'ts' (numeric) over 'Datetime' (datetime type)
    let columnsToFetch = [];
    
    // Only include 'ts' if it exists and filtering is needed
    if (start_ts !== null && end_ts !== null && availableColumns.includes('ts')) {
      columnsToFetch.push('ts');
    }
    
    // Add requested channels, but skip 'Datetime' unless explicitly requested
    channel_list.forEach(channel => {
      const channelName = channel.name;
      if (availableColumns.includes(channelName)) {
        // Only include Datetime if explicitly requested, but be aware it may cause BigInt issues
        if (channelName === 'Datetime') {
          // Warn but allow if explicitly requested
          columnsToFetch.push(channelName);
        } else {
          columnsToFetch.push(channelName);
        }
      }
    });
    
    // Remove duplicates
    columnsToFetch = columnsToFetch.filter(
      (col, index, arr) => arr.indexOf(col) === index
    );

    const cursor = reader.getCursor(columnsToFetch.length > 0 ? columnsToFetch : undefined);

    let record;

    while ((record = await cursor.next())) {
      try {
        // Handle Datetime column conversion to avoid BigInt errors
        if (record.Datetime !== undefined && record.Datetime !== null) {
          const dtValue = record.Datetime;
          // Convert BigInt, Date objects, or other types to a safe format
          if (typeof dtValue === 'bigint') {
            // Convert BigInt to number (milliseconds since epoch)
            record.Datetime = Number(dtValue);
          } else if (dtValue instanceof Date) {
            record.Datetime = dtValue.getTime();
          } else if (typeof dtValue === 'string') {
            const parsed = new Date(dtValue);
            record.Datetime = isNaN(parsed.getTime()) ? null : parsed.getTime();
          } else if (typeof dtValue === 'number') {
            // Already numeric, keep as is
            record.Datetime = dtValue;
          }
        }
        
        // Handle timestamp filtering - prefer 'ts' over 'Datetime'
        let timestamp = null;
        if (record.ts !== undefined && record.ts !== null) {
          timestamp = record.ts;
        } else if (record.Datetime !== undefined && record.Datetime !== null) {
          timestamp = record.Datetime;
        }
        
        // Skip rows with invalid timestamps when filtering is required
        if (start_ts !== null || end_ts !== null) {
          if (timestamp === null || isNaN(timestamp)) {
            continue; // Skip rows with invalid timestamps when filtering
          }
          if ((start_ts !== null && timestamp < start_ts) || (end_ts !== null && timestamp > end_ts)) {
            continue; // Skip rows outside time range
          }
        }
        
        results.push(extractRelevantFields(record, channel_list));
      } catch (error) {
        // Handle BigInt conversion errors or other record processing errors
        // Log but continue processing other records
        logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `Error processing record in parquet file: ${error.message}`, { filePath, error: error.message });
        continue;
      }
    }

    await reader.close();
  } catch (error) {
    throw error; // Let the real error bubble up instead of masking it
  }

  return results;
};

const readParquet = async (filePath) => {
  const reader = await parquet.ParquetReader.openFile(filePath);
  const schema = Object.keys(reader.schema.fields);
  await reader.close();
  return schema;
};

const extractChannelsFromParquet = async (filePath) => {
  const reader = await parquet.ParquetReader.openFile(filePath);
  const schema = Object.keys(reader.schema.fields);
  await reader.close();
  return schema;
};

const extractRelevantFields = (record, channel_list) => {
  const filteredRow = {};

  channel_list.forEach(channel => {
    const { name, type } = channel;

    if (name in record) {
      switch (type) {
        case 'float':
          filteredRow[name] = parseFloat(record[name]);
          break;
        case 'int':
          filteredRow[name] = parseInt(record[name], 10);
          break;
        case 'bool':
          filteredRow[name] = parseBool(record[name]);
          break;
        case 'datetime':  
          // filteredRow[name] = getDateTimeString(record[name]);
          filteredRow[name] = record[name];
          break;
        default:
          filteredRow[name] = record[name];
          break;
      }
    }
  });

  return filteredRow;
};

const getDateTimeString = (nanoseconds) => {
  const milliseconds = Number(nanoseconds) / 1e6;
  return new Date(milliseconds);
};

const parseBool = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lowerValue = value.toLowerCase().trim();
    if (lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes') {
      return true;
    } else if (lowerValue === 'false' || lowerValue === '0' || lowerValue === 'no') {
      return false;
    }
  }

  return false;
};


const getChannelName = (channels, description) => {
  const descriptionMapping = {
    lat: ['lat', 'lat_dd', 'latitude'],
    lon: ['lon', 'lng', 'lng_dd', 'longitude'],
    hdg: ['hdg', 'hdg_deg', 'heading'],
    cog: ['cog', 'cog_deg', 'course', 'cse'],
    sog: ['sog' ,'sog_kts'],
    bsp: ['bsp', 'bsp_kts','speed', 'sow', 'stw'],
  };

  const potentialChannels = descriptionMapping[description.toLowerCase()] || [];
  const formattedChannels = potentialChannels.flatMap(channel => [
    channel,
    channel.replace(/\s+/g, '-'),
    channel.replace(/\s+/g, '_')
  ]);

  return channels.find(channel => formattedChannels.includes(channel.toLowerCase())) || null;
};

const checkRequiredChannels = (channels) => {
  const requiredChannels = {
    lat: getChannelName(channels, 'lat'),
    lon: getChannelName(channels, 'lon'),
    hdg: getChannelName(channels, 'hdg') || getChannelName(channels, 'cog'),
    bsp: getChannelName(channels, 'bsp') || getChannelName(channels, 'sog')
  };

  const missingChannels = Object.keys(requiredChannels).filter(key => !requiredChannels[key]);
  const allChannelsFound = missingChannels.length === 0;

  return {
    allChannelsFound,
    requiredChannels
  };
};

// Helper function to add timeout to async operations
const withTimeout = (promise, timeoutMs, errorMessage) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
};

const extractDatetimeColumn = async (filePath) => {
  const fileExt = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath, fileExt);
  let results = [];
  
  // FIRST: Try to extract date from filename (much faster and avoids memory issues!)
  // Look for date patterns like: 2025-11-30, 20251130, 2025_11_30, etc.
  logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', `Attempting to extract date from filename: "${fileName}"`, { fileName, filePath });
  
  const datePatterns = [
    /(\d{4}-\d{2}-\d{2})/,           // 2025-11-30 (matches log_AUS_2025-11-30_10Hz.csv)
    /(\d{4}_\d{2}_\d{2})/,           // 2025_11_30
    /(\d{8})/,                        // 20251130
    /(\d{4}\/\d{2}\/\d{2})/,         // 2025/11/30
  ];
  
  for (const pattern of datePatterns) {
    const match = fileName.match(pattern);
    if (match) {
      let dateStr = match[1];
      logMessage('0.0.0.0', '0', path.basename(filePath), 'debug', `Found date pattern match: "${dateStr}"`, { fileName, dateStr, pattern: pattern.toString() });
      
      // Normalize the date string to YYYY-MM-DD format
      if (dateStr.includes('_')) {
        dateStr = dateStr.replace(/_/g, '-');
      } else if (dateStr.includes('/')) {
        dateStr = dateStr.replace(/\//g, '-');
      } else if (dateStr.length === 8 && !dateStr.includes('-')) {
        // Convert YYYYMMDD to YYYY-MM-DD
        dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
      }
      
      // Validate the date
      const dateObj = new Date(dateStr);
      if (!isNaN(dateObj.getTime())) {
        // Return a median datetime (use noon of that date)
        const medianDatetime = new Date(dateStr + 'T12:00:00').getTime();
        logMessage('0.0.0.0', '0', path.basename(filePath), 'info', `Successfully extracted date from filename: ${dateStr}`, { 
          fileName, 
          dateStr, 
          medianDatetime 
        });
        return { medianDatetime };
      } else {
        logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `Date pattern matched but invalid date: "${dateStr}"`, { fileName, dateStr });
      }
    }
  }
  
  logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `No valid date pattern found in filename: "${fileName}"`, { fileName, filePath });
  
  // If no date found in filename, fall back to parsing the file
  logMessage('0.0.0.0', '0', path.basename(filePath), 'warn', `No date found in filename "${fileName}", parsing file to extract date`, { fileName, filePath });
  
  // For date extraction, we only read 100 rows, so use a much shorter timeout (10 seconds for CSV, 30 seconds for parquet)
  const timeoutMs = (fileExt === '.csv' || fileExt === '.txt') ? 10000 : 30000;
  
  try {
    const extractOperation = async () => {
      // Check file extension to determine parser
      if (fileExt === '.parquet') {
        // Try to read 'ts' first (numeric, safer), then fall back to 'Datetime' if needed
        // This avoids BigInt conversion errors with Datetime column
        try {
          // First try with 'ts' column (numeric timestamp)
          const channelListTs = [{'name': 'ts', 'type': 'number'}];
          results = await parseParquet(filePath, channelListTs);
          // If we got results with 'ts', use them
          if (results && results.length > 0 && results[0].ts !== undefined) {
            // Convert ts values to datetime format for consistency
            results = results.map(row => ({ Datetime: new Date(row.ts) }));
          } else {
            // Fall back to Datetime column if ts didn't work
            const channelList = [{'name': 'Datetime', 'type': 'datetime'}];
            results = await parseParquet(filePath, channelList);
          }
        } catch (tsError) {
          // If reading 'ts' fails, try 'Datetime' but handle BigInt errors gracefully
          try {
            const channelList = [{'name': 'Datetime', 'type': 'datetime'}];
            results = await parseParquet(filePath, channelList);
          } catch (datetimeError) {
            // If both fail, throw the original error
            throw new Error(`Failed to extract datetime from parquet file. Tried 'ts' and 'Datetime' columns. ts error: ${tsError.message}, Datetime error: ${datetimeError.message}`);
          }
        }
      } else if (fileExt === '.csv' || fileExt === '.txt') {
        // For CSV/TXT files, parse as delimited and extract Datetime column
        // For large CSV files, we only need a small sample to extract the date
        try {
          // Only read first 10 rows for date extraction (MUCH faster and memory-efficient for large files)
          // We only need a few rows to find the datetime column and get a sample value
          const parsedData = await parseDelimitedFile(filePath, null, 10);
          if (!parsedData || parsedData.length === 0) {
            throw new Error(`No data found in CSV file: ${filePath}`);
          }
          
          // Use all rows we read (max 100)
          const sampleData = parsedData;
          
          results = sampleData
            .filter(row => row && typeof row === 'object' && Object.keys(row).length > 0) // Filter out empty/invalid rows
            .map(row => {
              // Try common datetime column names (case-insensitive)
              const datetimeKeys = Object.keys(row).filter(key => 
                key && (
                  key.toLowerCase() === 'datetime' || 
                  key.toLowerCase() === 'time' ||
                  key.toLowerCase() === 'timestamp' ||
                  key.toLowerCase().includes('datetime') ||
                  key.toLowerCase().includes('timestamp')
                )
              );
              
              if (datetimeKeys.length > 0) {
                return { Datetime: row[datetimeKeys[0]] };
              }
              // If no datetime column found, return first column as fallback
              const keys = Object.keys(row);
              if (keys.length > 0) {
                return { Datetime: row[keys[0]] };
              }
              return null; // Skip empty rows
            })
            .filter(result => result !== null); // Remove null results
          
          if (results.length === 0) {
            throw new Error(`No valid datetime columns found in CSV file: ${filePath}`);
          }
        } catch (csvError) {
          logMessage('0.0.0.0', '0', path.basename(filePath), 'error', `Error parsing CSV file: ${csvError.message}`, { filePath, error: csvError.stack });
          throw new Error(`Failed to extract datetime from CSV file ${path.basename(filePath)}: ${csvError.message}`);
        }
      } else {
        // For other file types, try parquet first, then fall back to CSV
        try {
          const channelList = [{'name': 'Datetime', 'type': 'datetime'}];
          results = await parseParquet(filePath, channelList);
        } catch (parquetError) {
          // If parquet fails, try as CSV
          try {
            const parsedData = await parseDelimitedFile(filePath);
            if (!parsedData || parsedData.length === 0) {
              throw new Error(`No data found in file: ${filePath}`);
            }
            
            // Sample for date extraction
            const sampleSize = Math.min(1000, parsedData.length);
            const sampleData = parsedData.slice(0, sampleSize);
            
            results = sampleData
              .filter(row => row && typeof row === 'object' && Object.keys(row).length > 0)
              .map(row => {
                const datetimeKeys = Object.keys(row).filter(key => 
                  key && (
                    key.toLowerCase() === 'datetime' || 
                    key.toLowerCase() === 'time' ||
                    key.toLowerCase() === 'timestamp' ||
                    key.toLowerCase().includes('datetime') ||
                    key.toLowerCase().includes('timestamp')
                  )
                );
                
                if (datetimeKeys.length > 0) {
                  return { Datetime: row[datetimeKeys[0]] };
                }
                const keys = Object.keys(row);
                if (keys.length > 0) {
                  return { Datetime: row[keys[0]] };
                }
                return null;
              })
              .filter(result => result !== null);
              
            if (results.length === 0) {
              throw new Error(`No valid datetime columns found in file: ${filePath}`);
            }
          } catch (csvError) {
            throw new Error(`Unable to extract datetime from file: ${filePath}. Tried parquet and CSV parsers. ${csvError.message}`);
          }
        }
      }

      if (!results || results.length === 0) {
        throw new Error(`No data extracted from file: ${filePath}`);
      }

      let datetimeValues = results
        .map(row => {
          if (!row || !row.Datetime) {
            return null;
          }
          const dt = row.Datetime;
          try {
            if (dt instanceof Date) {
              return dt.getTime();
            } else if (typeof dt === 'string') {
              const parsed = new Date(dt);
              return isNaN(parsed.getTime()) ? null : parsed.getTime();
            } else if (typeof dt === 'number') {
              return isNaN(dt) ? null : dt;
            }
          } catch (e) {
            return null;
          }
          return null;
        })
        .filter(val => val !== null && !isNaN(val) && isFinite(val));

      if (datetimeValues.length === 0) {
        throw new Error(`No valid datetime values found in file: ${filePath}. Extracted ${results.length} rows but none had valid datetime values.`);
      }

      const medianDatetime = median(datetimeValues);
      if (!medianDatetime || isNaN(medianDatetime)) {
        throw new Error(`Failed to calculate median datetime from file: ${filePath}`);
      }

      return { medianDatetime };
    };
    
    // Execute with timeout
    return await withTimeout(
      extractOperation(),
      timeoutMs,
      `extractDatetimeColumn timed out after ${timeoutMs}ms for file: ${path.basename(filePath)}`
    );
  } catch (error) {
    logMessage('0.0.0.0', '0', path.basename(filePath), 'error', `Error in extractDatetimeColumn: ${error.message}`, { filePath, error: error.stack });
    throw error; // Re-throw to let caller handle it
  }
};

const groupChannelsByFilename = async (directory, channelNames) => {
  const path = require('path');
  const files = fs.readdirSync(directory).filter(file =>
    file.endsWith('.parquet')
  );

  const groupChannelMap = {};

  for (const file of files) {
    const filePath = path.join(directory, file);
    const base = path.basename(file, path.extname(file));
    const group = base.includes('_') ? base.split('_')[0] : base;

    let channels = [];
    try {
      channels = await extractChannelsFromParquet(filePath);

      channelNames.forEach(channel => {
        if (channels.map(c => c.toLowerCase()).includes(channel.toLowerCase())) {
          if (!groupChannelMap[group]) groupChannelMap[group] = new Set();
          groupChannelMap[group].add(channel);
        }
      });
    } catch (err) {
      // Ignore errors for individual files
    }
  }

  return Object.entries(groupChannelMap).map(([group, channelsSet]) => ({
    group,
    channels: Array.from(channelsSet)
  }));
};

const normalizeFile = async (auth_token, filename, date, project_id, class_name, source_name) => {
  const controller = new AbortController();
  const sanitizedDate = date.replace(/[-/]/g, "");

  let parameters = {
      project_id: project_id,
      class_name: class_name,
      dataset_id: 0,
      date: sanitizedDate,
      source_name: source_name,
      file_name: filename
  };

  // Note: The Python service resolves the script path as: scripts/{class_name}/1_normalization_csv.py
  let payload = {
      project_id: project_id,
      class_name: class_name,
      script_name: '1_normalization_csv.py',
      parameters: parameters,
  };

  try {
      let response_json = await postData(auth_token, apiEndpoints.python.execute_script, payload, controller.signal)

      if (response_json.success) {
        logMessage('0.0.0.0', '0', 'normalizeFile', 'info', 'File normalization completed successfully', { filePath: filename });
        return true;
      } else {
        logMessage('0.0.0.0', '0', 'normalizeFile', 'error', 'File normalization failed', { filePath: filename, response: response_json });
        return false;
      }
  } catch (err) {
      if (err.name === 'AbortError') {
          logMessage('0.0.0.0', '0', 'normalizeFile', 'warn', 'File normalization was cancelled', { filePath: filename });
          return false;
      } else {
          error("Error normalizing data:", err);
          logMessage('0.0.0.0', '0', 'normalizeFile', 'error', `Error normalizing data: ${err.message}`, { filePath: filename, error: err.stack });
          // Re-throw the error so the caller gets the actual error message
          throw err;
      }
  }
};

const parseXML = async (auth_token, date, project_id, class_name, file_path) => {
  const controller = new AbortController();
  const sanitizedDate = date.replace(/[-/]/g, "");

  let parameters = {
      project_id: project_id,
      class_name: class_name,
      dataset_id: 0,
      date: sanitizedDate,
      file_path: file_path
  };

  let payload = {
      project_id: project_id,
      class_name: class_name,
      script_name: '1_parseXml.py',
      parameters: parameters,
  };

  try {
      let response_json = await postData(auth_token, apiEndpoints.python.execute_script, payload, controller.signal)

      if (response_json.success) {
        logMessage('0.0.0.0', '0', 'parseXML', 'info', 'Xml parsing completed successfully', { filePath: file_path });
        return true;
      } else {
        logMessage('0.0.0.0', '0', 'parseXML', 'error', 'Xml parsing failed', { filePath: file_path, response: response_json });
        return false;
      }
  } catch (err) {
      if (err.name === 'AbortError') {
          logMessage('0.0.0.0', '0', 'parseXML', 'warn', 'Xml parsing was cancelled', { filePath: file_path });
          return false;
      } else {
          error("Error parsing XML:", err);
          logMessage('0.0.0.0', '0', 'parseXML', 'error', `Error parsing XML: ${err.message}`, { filePath: file_path, error: err.stack });
          // Re-throw the error so the caller gets the actual error message
          throw err;
      }
  }
};

/**
 * Update dataset date_modified for a given source_id and date
 * This should be called after any data modification (normalization, processing, etc.)
 * 
 * Note: During file uploads, datasets may not exist yet. In that case, this function
 * will return false without logging a warning, as the dataset will be created later
 * and date_modified will be updated then.
 */
const updateDatasetDateModified = async (auth_token, class_name, project_id, source_id, date, suppressWarning = false) => {
  try {
    // Get dataset_id from source_id and date
    const sanitizedDate = date.replace(/[-/]/g, "");
    const sql = `SELECT dataset_id "value" FROM ${class_name}.datasets WHERE source_id = $1 AND date = $2 ORDER BY dataset_id DESC LIMIT 1`;
    const dataset_id = await db.GetValue(sql, [source_id, sanitizedDate]);
    
    if (dataset_id) {
      // Construct admin API URL
      const adminHost = (config.DOCKER_CONTAINER === 'true' || config.NODE_ENV === 'production') 
        ? 'admin'  // Docker service name
        : 'localhost';
      const adminPort = config.ADMIN_PORT || 8059;
      const adminApiUrl = `http://${adminHost}:${adminPort}`;
      
      const payload = {
        class_name: class_name,
        project_id: project_id,
        dataset_id: dataset_id
      };
      
      const response = await putData(auth_token, `${adminApiUrl}/api/datasets/date-modified`, payload);
      
      if (response.success) {
        logMessage('0.0.0.0', auth_token?.user_id || '0', 'updateDatasetDateModified', 'info', 'Dataset date_modified updated successfully', { class_name, dataset_id, source_id, date });
        return true;
      } else {
        logMessage('0.0.0.0', auth_token?.user_id || '0', 'updateDatasetDateModified', 'warn', 'Failed to update dataset date_modified', { class_name, dataset_id, source_id, date, response });
        return false;
      }
    } else {
      // Dataset not found - this is expected during uploads before datasets are created
      // Only log as info (not warn) if suppressWarning is true, otherwise log as debug
      if (suppressWarning) {
        logMessage('0.0.0.0', auth_token?.user_id || '0', 'updateDatasetDateModified', 'info', 'Dataset not found yet (expected during uploads, will be updated after dataset creation)', { class_name, source_id, date });
      } else {
        logMessage('0.0.0.0', auth_token?.user_id || '0', 'updateDatasetDateModified', 'debug', 'Dataset not found for source_id and date', { class_name, source_id, date });
      }
      return false;
    }
  } catch (error) {
    logMessage('0.0.0.0', '0', 'updateDatasetDateModified', 'error', `Error updating dataset date_modified: ${error.message}`, { class_name, source_id, date, error: error.stack });
    return false;
  }
};

module.exports = {
  parseCSV,
  parseDelimitedFile,
  detectDelimiter,
  parseParquet,
  readParquet,
  extractChannelsFromParquet,
  getChannelName,
  checkRequiredChannels,
  extractDatetimeColumn,
  csvtoJSON,
  plrToJSON,
  polartoJSON,
  groupChannelsByFilename,
  normalizeFile,
  parseXML,
  updateDatasetDateModified,
  verifyFileComplete
};