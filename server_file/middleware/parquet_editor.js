const parquet = require('@dsnp/parquetjs');
const fs = require('fs');
const path = require('path');
const { log, error, warn } = require('../../shared');

/**
 * Read all rows from a parquet file
 * @param {string} filePath - Path to parquet file
 * @returns {Promise<Array>} Array of row objects
 */
async function readParquetFile(filePath) {
  try {
    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();
    const rows = [];
    
    let record = null;
    while (record = await cursor.next()) {
      rows.push(record);
    }
    
    await reader.close();
    return rows;
  } catch (err) {
    error(`[readParquetFile] Error reading ${filePath}:`, err);
    throw err;
  }
}

/**
 * Convert BigInt values to Number in a row object
 * @param {Object} row - Row object that may contain BigInt values
 * @returns {Object} Row object with BigInt values converted to Number
 */
function convertBigIntToNumber(row) {
  const converted = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') {
      converted[key] = Number(value);
    } else {
      converted[key] = value;
    }
  }
  return converted;
}

/**
 * Write rows to a parquet file
 * @param {string} filePath - Path to parquet file
 * @param {Array} rows - Array of row objects
 * @param {Object} schema - Parquet schema
 * @returns {Promise<void>}
 */
async function writeParquetFile(filePath, rows, schema) {
  try {
    // Create backup of original file
    const backupPath = filePath + '.backup';
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
      log(`[writeParquetFile] Created backup at ${backupPath}`);
    }

    // Remove existing file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Create writer with schema
    const writer = await parquet.ParquetWriter.openFile(schema, filePath);

    // Write all rows (convert BigInt to Number to avoid serialization errors)
    for (const row of rows) {
      const convertedRow = convertBigIntToNumber(row);
      await writer.appendRow(convertedRow);
    }

    await writer.close();
    
    // Remove backup after successful write
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    
    log(`[writeParquetFile] Successfully wrote ${rows.length} rows to ${filePath}`);
  } catch (err) {
    error(`[writeParquetFile] Error writing ${filePath}:`, err);
    
    // Restore from backup if write failed
    const backupPath = filePath + '.backup';
    if (fs.existsSync(backupPath)) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.copyFileSync(backupPath, filePath);
      fs.unlinkSync(backupPath);
      warn(`[writeParquetFile] Restored from backup after write failure`);
    }
    
    throw err;
  }
}

/**
 * Infer schema from existing rows by examining the actual parquet file
 * @param {string} filePath - Path to the original parquet file
 * @param {Array} rows - Array of row objects (used as fallback)
 * @returns {Promise<Object>} Parquet schema fields
 */
async function inferSchemaFromFile(filePath, rows) {
  try {
    // Read the original file's schema
    const reader = await parquet.ParquetReader.openFile(filePath);
    const schema = reader.getSchema();
    await reader.close();
    
    // Convert the schema to the format we need
    const schemaFields = {};
    for (const [fieldName, field] of Object.entries(schema.fields)) {
      schemaFields[fieldName] = {
        type: field.primitiveType || field.originalType || 'UTF8',
        optional: field.optional !== false,
        repetitionType: field.repetitionType
      };
    }
    
    log(`[inferSchemaFromFile] Inferred schema from original file with ${Object.keys(schemaFields).length} fields`);
    return schemaFields;
  } catch (err) {
    warn(`[inferSchemaFromFile] Could not read schema from file, falling back to row inference: ${err.message}`);
    return inferSchemaFromRows(rows);
  }
}

/**
 * Infer schema from existing rows (fallback method)
 * @param {Array} rows - Array of row objects
 * @returns {Object} Parquet schema fields
 */
function inferSchemaFromRows(rows) {
  if (!rows || rows.length === 0) {
    throw new Error('Cannot infer schema from empty rows array');
  }

  const schemaFields = {};
  const sampleRow = rows[0];

  for (const [key, value] of Object.entries(sampleRow)) {
    if (key === 'ts') {
      // Timestamp is always a float
      schemaFields[key] = { type: 'DOUBLE', optional: true };
    } else if (key === 'Datetime') {
      // Datetime is always a string
      schemaFields[key] = { type: 'UTF8', optional: true };
    } else if (typeof value === 'string') {
      schemaFields[key] = { type: 'UTF8', optional: true };
    } else if (typeof value === 'number') {
      // Check if it's an integer or float
      if (Number.isInteger(value)) {
        schemaFields[key] = { type: 'INT64', optional: true };
      } else {
        schemaFields[key] = { type: 'DOUBLE', optional: true };
      }
    } else if (typeof value === 'boolean') {
      schemaFields[key] = { type: 'BOOLEAN', optional: true };
    } else if (value === null || value === undefined) {
      // Default to DOUBLE for null values
      schemaFields[key] = { type: 'DOUBLE', optional: true };
    } else {
      // Default to UTF8 for unknown types
      schemaFields[key] = { type: 'UTF8', optional: true };
    }
  }

  return schemaFields;
}

/**
 * Normalize timestamp value to a number
 * @param {*} value - Timestamp value (can be number, string, bigint)
 * @returns {number|null} Normalized timestamp
 */
function normalizeTimestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return isNaN(value) ? null : value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Edit channel data in parquet files for a given time range
 * @param {Array<string>} filePaths - Array of parquet file paths
 * @param {string} channelName - Name of channel to edit
 * @param {number} startTs - Start timestamp (Unix seconds)
 * @param {number} endTs - End timestamp (Unix seconds)
 * @param {*} channelValue - New value to set for the channel
 * @returns {Promise<Object>} Result object with filesModified, rowsModified, filesProcessed
 */
async function editChannelInParquetFiles(filePaths, channelName, startTs, endTs, channelValue) {
  log(`[editChannelInParquetFiles] Editing channel ${channelName} in ${filePaths.length} files`);
  log(`[editChannelInParquetFiles] Time range: ${startTs} to ${endTs}`);
  log(`[editChannelInParquetFiles] New value: ${channelValue} (type: ${typeof channelValue})`);

  let filesProcessed = 0;
  let filesModified = 0;
  let totalRowsModified = 0;

  for (const filePath of filePaths) {
    try {
      log(`[editChannelInParquetFiles] Processing file: ${path.basename(filePath)}`);
      
      // Read all rows from the file
      const rows = await readParquetFile(filePath);
      
      if (rows.length === 0) {
        log(`[editChannelInParquetFiles] File ${path.basename(filePath)} is empty, skipping`);
        filesProcessed++;
        continue;
      }

      // Check if the channel exists in this file
      const hasChannel = rows.some(row => channelName in row);
      if (!hasChannel) {
        log(`[editChannelInParquetFiles] Channel ${channelName} not found in ${path.basename(filePath)}, skipping`);
        filesProcessed++;
        continue;
      }

      // Modify rows within the time range
      let rowsModifiedInFile = 0;
      const modifiedRows = rows.map(row => {
        const ts = normalizeTimestamp(row.ts);
        
        // Check if this row is within the time range
        if (ts !== null && ts >= startTs && ts <= endTs) {
          // Only modify if the channel exists in this row
          if (channelName in row) {
            row[channelName] = channelValue;
            rowsModifiedInFile++;
          }
        }
        
        return row;
      });

      // Only write back if we modified any rows
      if (rowsModifiedInFile > 0) {
        // Infer schema from the original file to preserve field types
        const schemaFields = await inferSchemaFromFile(filePath, modifiedRows);
        const schema = new parquet.ParquetSchema(schemaFields);

        // Write the modified rows back to the file
        await writeParquetFile(filePath, modifiedRows, schema);
        
        filesModified++;
        totalRowsModified += rowsModifiedInFile;
        log(`[editChannelInParquetFiles] Modified ${rowsModifiedInFile} rows in ${path.basename(filePath)}`);
      } else {
        log(`[editChannelInParquetFiles] No rows modified in ${path.basename(filePath)} (no data in time range)`);
      }

      filesProcessed++;
    } catch (err) {
      error(`[editChannelInParquetFiles] Error processing file ${filePath}:`, err);
      // Continue processing other files even if one fails
      filesProcessed++;
    }
  }

  log(`[editChannelInParquetFiles] Complete: ${filesModified} files modified, ${totalRowsModified} total rows modified`);

  return {
    filesProcessed,
    filesModified,
    rowsModified: totalRowsModified
  };
}

module.exports = {
  editChannelInParquetFiles,
  readParquetFile,
  writeParquetFile,
  inferSchemaFromRows,
  inferSchemaFromFile,
  convertBigIntToNumber
};
