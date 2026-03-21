const fs = require('fs');
const csv = require('csv-parser');
const readline = require('readline');
const path = require('path');
const env = require('./config');
const { log, debug } = require('../../shared');
const { extractChannelsFromParquetFiles } = require('./duckdb_utils');

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

// Helper function to detect delimiter in text files
const detectDelimiter = (filePath) => {
  try {
    // Check if file exists and is readable
    if (!fs.existsSync(filePath)) {
      log.warn(`File does not exist for delimiter detection: ${filePath}`);
      return { delimiter: ',', isRegex: false }; // Default to comma
    }
    
    const stats = fs.statSync(filePath);
    if (!stats || stats.size === 0) {
      log.warn(`File is empty, defaulting to comma delimiter`);
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
      log.debug(`Delimiter detection for ${path.basename(filePath)}: ${JSON.stringify(results)}. Selected: ${bestDelimiter.name} (${maxColumns} columns)`);
      
      return { delimiter: bestDelimiter.delimiter, isRegex: bestDelimiter.isRegex };
      
    } catch (readError) {
      if (fd) {
        try { fs.closeSync(fd); } catch (e) { /* ignore */ }
      }
      throw readError;
    }
  } catch (error) {
    log.warn(`Error detecting delimiter, defaulting to comma: ${error.message}`);
    return { delimiter: ',', isRegex: false }; // Default to comma on error
  }
};

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
  
  log.info(`Processing polar file ${path.basename(filePath)} with delimiter: ${delimiterName}`);

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
  log.debug(`Polar file ${path.basename(filePath)} header: ${header.length} columns: ${JSON.stringify(header)}`);
  
  if (dataRows.length > 0) {
    const maxDataRowLength = Math.max(...dataRows.map(row => row.length));
    log.debug(`First data row has ${dataRows[0].length} columns, max: ${maxDataRowLength}. First 15: ${JSON.stringify(dataRows[0].slice(0, 15))}`);
  }

  // Check if data rows have more columns than header (might indicate missing header columns)
  let maxDataRowLength = 0;
  if (dataRows.length > 0) {
    maxDataRowLength = Math.max(...dataRows.map(row => row.length));
  }
  
  // If data rows have more columns than header, pad the header with empty strings
  if (maxDataRowLength > header.length) {
    log.debug(`Data rows have ${maxDataRowLength} columns but header has ${header.length}. Padding header.`);
    while (header.length < maxDataRowLength) {
      header.push(''); // Add empty header columns
    }
  }

  // Derive column count
  // First column (index 0) is TWS with no header, so we have (header.length - 1) / 2 angle/speed pairs
  const columnCount = (header.length - 1) / 2;

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

    fs.createReadStream(filePath)
      .pipe(csv())
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

// Legacy parquet parsing functions removed - now using DuckDB for all parquet operations
// See duckdb_utils.js for extractChannelsFromParquetFiles and queryParquetFiles

/**
 * Normalize channel type variations to canonical types used by the code.
 * 
 * Maps variations like 'str', 'integer', 'float64' to canonical types:
 * - 'string' (from 'str', 'text', 'varchar', etc.)
 * - 'int' (from 'integer', 'int32', 'int64', etc.)
 * - 'float' (from 'float32', 'float64', 'double', etc.)
 * - 'datetime' (from 'date', 'timestamp', etc.)
 * - 'bool' (from 'boolean', 'bool', etc.)
 * - Preserves angle-related suffixes (360, 180, angle)
 * 
 * @param {string} channelType - The channel type string to normalize
 * @returns {string} Normalized channel type string
 */
const normalizeChannelType = (channelType) => {
  if (!channelType || typeof channelType !== 'string') {
    return channelType;
  }

  // Convert to lowercase for case-insensitive matching
  const typeLower = channelType.toLowerCase().trim();

  // Check for angle-related types first (preserve these patterns)
  const hasAngle = typeLower.includes('angle');
  const has360 = typeLower.includes('360');
  const has180 = typeLower.includes('180');

  // If it's an angle type, preserve the angle parts and normalize any base type
  if (hasAngle || has360 || has180) {
    // Extract and normalize base type (everything except angle/360/180)
    let remaining = typeLower;
    ['angle', '360', '180'].forEach(keyword => {
      remaining = remaining.replace(keyword, ' ');
    });
    const baseParts = remaining.split(/\s+/).filter(p => p);
    const baseType = baseParts.length > 0 ? baseParts[0] : 'float'; // Default for angle types

    // Map base types to canonical types
    const typeMapping = {
      'str': 'string', 'text': 'string', 'varchar': 'string', 'char': 'string', 'string': 'string',
      'int': 'int', 'integer': 'int', 'int32': 'int', 'int64': 'int', 'int16': 'int', 'int8': 'int',
      'float': 'float', 'float32': 'float', 'float64': 'float', 'double': 'float', 'real': 'float', 'numeric': 'float', 'number': 'float',
      'datetime': 'datetime', 'date': 'datetime', 'timestamp': 'datetime', 'time': 'datetime',
      'bool': 'bool', 'boolean': 'bool',
    };
    const normalizedBase = typeMapping[baseType] || 'float'; // Default to float for angle types

    // Reconstruct: preserve angle keywords, use normalized base
    const angleParts = [];
    if (hasAngle) angleParts.push('angle');
    if (has360) angleParts.push('360');
    if (has180) angleParts.push('180');

    // For angle types, typically just use angle parts (e.g., 'angle360')
    // But if base type is explicitly non-float, preserve it
    if (normalizedBase !== 'float' && baseParts.length > 0) {
      return normalizedBase + angleParts.join('');
    } else {
      return angleParts.length > 0 ? angleParts.join('') : 'float';
    }
  }

  // For non-angle types, just normalize the base type
  const typeMapping = {
    'str': 'string', 'text': 'string', 'varchar': 'string', 'char': 'string', 'string': 'string',
    'int': 'int', 'integer': 'int', 'int32': 'int', 'int64': 'int', 'int16': 'int', 'int8': 'int',
    'float': 'float', 'float32': 'float', 'float64': 'float', 'double': 'float', 'real': 'float', 'numeric': 'float', 'number': 'float',
    'datetime': 'datetime', 'date': 'datetime', 'timestamp': 'datetime', 'time': 'datetime',
    'bool': 'bool', 'boolean': 'bool',
  };

  return typeMapping[typeLower] || typeLower; // Return normalized or original if not in mapping
};

const extractRelevantFields = (record, channel_list) => {
  const filteredRow = {};
  channel_list.forEach(channel => {
    const { name, type } = channel;
    const normalizedType = normalizeChannelType(type);

    // Always include requested channels, even if missing from record
    if (name in record) {
      const value = record[name];
      
      // Handle null/undefined values based on type
      if (value === null || value === undefined) {
        switch (normalizedType) {
          case 'float':
            filteredRow[name] = null; // Will be filled with 0.0 later
            break;
          case 'int':
            filteredRow[name] = null; // Will be filled with 0 later
            break;
          case 'bool':
            filteredRow[name] = null; // Will be filled with false later
            break;
          case 'string':
            // Use empty string instead of null for string columns to ensure they're preserved
            filteredRow[name] = '';
            break;
          case 'datetime':
            filteredRow[name] = null; // Will be filled with default date later
            break;
          default:
            filteredRow[name] = null;
            break;
        }
      } else {
        switch (normalizedType) {
          case 'float':
            const floatVal = parseFloat(value);
            filteredRow[name] = isNaN(floatVal) ? null : floatVal;
            break;
          case 'int':
            const intVal = parseInt(value, 10);
            filteredRow[name] = isNaN(intVal) ? null : intVal;
            break;
          case 'bool':
            filteredRow[name] = parseBool(value);
            break;
          case 'string':
            // Convert to string, handling various types
            filteredRow[name] = String(value);
            break;
          case 'datetime':  
            filteredRow[name] = getDateTimeString(value);
            break;
          default:
            filteredRow[name] = value;
            break;
        }
      }
    } else {
      // Channel requested but not in record - add with null value
      // This ensures all requested channels are present in the output
      switch (normalizedType) {
        case 'float':
          filteredRow[name] = null;
          break;
        case 'int':
          filteredRow[name] = null;
          break;
        case 'bool':
          filteredRow[name] = null;
          break;
        case 'string':
          // Use empty string instead of null for string columns to ensure they're preserved
          filteredRow[name] = '';
          break;
        case 'datetime':
          filteredRow[name] = null;
          break;
        default:
          filteredRow[name] = null;
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
    lat: ['lat', 'lat_dd','latitude'],
    lon: ['lon', 'lng', 'lng_dd', 'longitude'],
    hdg: ['hdg', 'hdg_deg', 'heading'],
    cog: ['cog', 'cog_deg', 'course', 'cse', 'course over ground'],
    sog: ['sog', 'sog_kts', 'speed over ground'],
    bsp: ['bsp', 'bsp_kts','speed', 'sow', 'stw', 'speed through water', 'boat speed', 'speed through the water', 'speed kts'],
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

const extractDatetimeColumn = async (filePath) => {
  let datetimeValues = [];
  let results = [];

  if (filePath.endsWith('.csv')) {
    results = await parseCSV(filePath, ['Datetime']);
  } else if (filePath.endsWith('.parquet')) {
    // Use DuckDB for parquet files
    const { queryParquetFiles } = require('./duckdb_utils');
    results = await queryParquetFiles([filePath], [{'name': 'ts', 'type': 'float'}, {'name': 'Datetime', 'type': 'datetime'}], null, null, null);
    // Convert ts to Datetime format if Datetime is not present
    results = results.map(row => {
      if (row.Datetime) {
        return { Datetime: row.Datetime };
      } else if (row.ts) {
        // Convert ts (seconds) to Date object
        return { Datetime: new Date(row.ts * 1000) };
      }
      return { Datetime: null };
    }).filter(row => row.Datetime !== null);
  } else if (filePath.endsWith('.txt')) {
    results = await parseTXT(filePath, ['Datetime']);
  }

  datetimeValues = results.map(row => new Date(row.Datetime).getTime()); //datetime

  const medianDatetime = median(datetimeValues);

  return { medianDatetime };
};

/**
 * Groups channels by the prefix of the filename (before the first underscore).
 * Returns an array of objects: { group, channels: [channel1, channel2, ...] }
 */
const groupChannelsByFilename = async (directory, channelNames) => {
  const path = require('path');
  const files = fs.readdirSync(directory).filter(file =>
    file.endsWith('.csv') || file.endsWith('.parquet') || file.endsWith('.txt')
  );
  // Map: group -> Set of channels
  const groupChannelMap = {};

  for (const file of files) {
    const filePath = path.join(directory, file);
    // Log processing start for debugging crashes
    if (env.VITE_VERBOSE === 'true') {
      debug(`[groupChannelsByFilename] Processing file: ${file}`);
    }
    
    // Extract group: characters before the first underscore, or the whole name if no underscore
    const base = path.basename(file, path.extname(file));
    const group = base.includes('_') ? base.split('_')[0] : base;

    let channels = [];
    try {
      if (file.endsWith('.csv')) {
        // CSV channel extraction - keep existing implementation if extractChannelsFromCSV exists
        // Otherwise, skip CSV files for now
        try {
          if (typeof extractChannelsFromCSV === 'function') {
            channels = await extractChannelsFromCSV(filePath);
          }
        } catch (csvErr) {
          // CSV extraction not available or failed
        }
      } else if (file.endsWith('.parquet')) {
        // Use DuckDB for parquet file channel extraction
        channels = await extractChannelsFromParquetFiles([filePath]);
      } else if (file.endsWith('.txt')) {
        // TXT channel extraction - keep existing implementation if extractChannelsFromTXT exists
        // Otherwise, skip TXT files for now
        try {
          if (typeof extractChannelsFromTXT === 'function') {
            channels = await extractChannelsFromTXT(filePath);
          }
        } catch (txtErr) {
          // TXT extraction not available or failed
        }
      }
      // For each channel in channelNames, check if it's in this file
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

  // Convert to array of { group, channels: [...] }
  return Object.entries(groupChannelMap).map(([group, channelsSet]) => ({
    group,
    channels: Array.from(channelsSet)
  }));
};

module.exports = {
  parseCSV,
  getChannelName,
  checkRequiredChannels,
  extractDatetimeColumn,
  csvtoJSON,
  polartoJSON,
  groupChannelsByFilename
};