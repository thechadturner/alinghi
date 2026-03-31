/**
 * Compare specific tables between racesight and production schemas
 * Extracts CREATE TABLE statements for events_aggregate, events_cloud, and pages
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const devSchemaPath = path.join(projectRoot, 'database', 'racesight_backup_empty.sql');
const prodSchemaPath = path.join(projectRoot, 'database', 'production_backup_empty.sql');

console.log('Comparing tables: events_aggregate, events_cloud, pages\n');

// Try to read both files
let devContent, prodContent;

try {
  // Try reading as UTF-8 first
  devContent = fs.readFileSync(devSchemaPath, 'utf8');
} catch (error) {
  try {
    // Try reading as binary and converting
    const buffer = fs.readFileSync(devSchemaPath);
    // Try different encodings
    try {
      devContent = buffer.toString('utf8');
    } catch {
      try {
        devContent = buffer.toString('latin1');
      } catch {
        devContent = buffer.toString('binary');
      }
    }
  } catch (error2) {
    console.error('Error reading dev schema file:', error2.message);
    console.error('File may be in binary PGDMP format. Attempting to extract text...');
    // Try to extract readable text from binary
    const buffer = fs.readFileSync(devSchemaPath);
    devContent = buffer.toString('binary');
  }
}

try {
  prodContent = fs.readFileSync(prodSchemaPath, 'utf8');
} catch (error) {
  console.error('Error reading production schema file:', error.message);
  process.exit(1);
}

// Extract CREATE TABLE statement for a specific table
function extractTableDefinition(content, schema, tableName) {
  // Look for CREATE TABLE schema.table_name
  const pattern = new RegExp(
    `CREATE TABLE\\s+${schema}\\.${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    'i'
  );
  
  const match = content.match(pattern);
  if (match) {
    return {
      found: true,
      definition: match[1].trim(),
      fullMatch: match[0]
    };
  }
  
  return { found: false };
}

// Extract column list from table definition
function extractColumns(definition) {
  const columns = [];
  // Split by comma, but be careful of nested parentheses
  let depth = 0;
  let current = '';
  
  for (let i = 0; i < definition.length; i++) {
    const char = definition[i];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      if (current.trim()) {
        columns.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    columns.push(current.trim());
  }
  
  return columns.map(col => {
    // Extract column name and type
    const parts = col.trim().split(/\s+/);
    const name = parts[0].replace(/"/g, '');
    const type = parts.slice(1).join(' ').toLowerCase();
    return { name, type, full: col.trim() };
  });
}

// Compare two table definitions
function compareTables(devTable, prodTable, tableName) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Comparing: ${tableName}`);
  console.log('='.repeat(80));
  
  if (!devTable.found) {
    console.log(`❌ Table ${tableName} NOT FOUND in racesight (dev) schema`);
    return;
  }
  
  if (!prodTable.found) {
    console.log(`❌ Table ${tableName} NOT FOUND in production schema`);
    console.log(`\nCREATE TABLE statement needed:\n${devTable.fullMatch}`);
    return;
  }
  
  const devColumns = extractColumns(devTable.definition);
  const prodColumns = extractColumns(prodTable.definition);
  
  const devColMap = new Map(devColumns.map(c => [c.name.toLowerCase(), c]));
  const prodColMap = new Map(prodColumns.map(c => [c.name.toLowerCase(), c]));
  
  console.log(`\nDev columns: ${devColumns.length}`);
  console.log(`Prod columns: ${prodColumns.length}`);
  
  // Find columns in dev but not in prod
  const missingInProd = [];
  for (const [name, col] of devColMap) {
    if (!prodColMap.has(name)) {
      missingInProd.push(col);
    }
  }
  
  // Find columns in prod but not in dev
  const extraInProd = [];
  for (const [name, col] of prodColMap) {
    if (!devColMap.has(name)) {
      extraInProd.push(col);
    }
  }
  
  if (missingInProd.length > 0) {
    console.log(`\n⚠️  Columns in dev but MISSING in production (${missingInProd.length}):`);
    missingInProd.forEach(col => {
      console.log(`  - ${col.name} ${col.type}`);
    });
  }
  
  if (extraInProd.length > 0) {
    console.log(`\n⚠️  Columns in production but NOT in dev (${extraInProd.length}):`);
    extraInProd.forEach(col => {
      console.log(`  - ${col.name} ${col.type}`);
    });
  }
  
  if (missingInProd.length === 0 && extraInProd.length === 0) {
    console.log(`\n✅ Tables match - no differences found`);
  } else if (missingInProd.length > 0) {
    console.log(`\n📝 Migration needed: Add ${missingInProd.length} column(s) to production`);
    console.log(`\nSQL to add missing columns:`);
    console.log(`-- Add missing columns to ${tableName}`);
    missingInProd.forEach(col => {
      const colName = col.name.includes(' ') ? `"${col.name}"` : col.name;
      console.log(`ALTER TABLE ac40.${tableName} ADD COLUMN ${colName} ${col.type};`);
    });
  }
}

// Compare the three tables
const tables = ['events_aggregate', 'events_cloud', 'pages'];

for (const tableName of tables) {
  const devTable = extractTableDefinition(devContent, 'ac40', tableName);
  const prodTable = extractTableDefinition(prodContent, 'ac40', tableName);
  compareTables(devTable, prodTable, tableName);
}

console.log(`\n${'='.repeat(80)}`);
console.log('Comparison complete');
console.log('='.repeat(80));
