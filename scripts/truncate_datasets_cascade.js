/**
 * Script to truncate datasets tables with CASCADE and reset all affected identity sequences
 * 
 * This script will:
 * 1. Truncate datasets tables in ac40 and ac75 schemas with CASCADE
 *    (which automatically truncates all dependent tables via foreign keys)
 * 2. Reset all identity sequences (sequences) for all affected tables
 * 
 * WARNING: This is a destructive operation that will delete all dataset-related data!
 */

const db = require('../shared/database/connection');

/**
 * Get all sequences for tables that will be affected by truncate cascade
 * Only includes sequences for tables that have foreign keys to datasets or dataset_events
 */
async function getAffectedSequences(schema) {
  try {
    // Find sequences for tables that reference datasets (directly or via dataset_events)
    // This ensures we only reset sequences for tables that were actually truncated
    const query = `
      WITH RECURSIVE dependent_tables AS (
        -- Start with datasets and dataset_events tables
        SELECT 
          t.table_schema,
          t.table_name
        FROM information_schema.tables t
        WHERE t.table_schema = $1 
          AND t.table_name IN ('datasets', 'dataset_events')
        
        UNION ALL
        
        -- Find tables that reference the current table via foreign keys
        SELECT 
          t.table_schema,
          t.table_name
        FROM information_schema.tables t
        INNER JOIN information_schema.table_constraints tc
          ON t.table_schema = tc.table_schema
          AND t.table_name = tc.table_name
        INNER JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        INNER JOIN information_schema.constraint_column_usage ccu
          ON kcu.constraint_name = ccu.constraint_name
          AND kcu.table_schema = ccu.table_schema
        INNER JOIN dependent_tables dt
          ON ccu.table_schema = dt.table_schema
          AND ccu.table_name = dt.table_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND t.table_schema = $1
      )
      SELECT DISTINCT
        n.nspname as sequence_schema,
        seq.relname as sequence_name,
        t.relname as table_name,
        a.attname as column_name
      FROM dependent_tables dt
      INNER JOIN pg_class t ON t.relname = dt.table_name
      INNER JOIN pg_namespace tn ON t.relnamespace = tn.oid AND tn.nspname = dt.table_schema
      INNER JOIN pg_depend d
        ON d.refobjid = t.oid
        AND d.deptype = 'a'  -- 'a' = auto dependency (sequence owned by column)
      INNER JOIN pg_class seq ON d.objid = seq.oid AND seq.relkind = 'S'
      INNER JOIN pg_namespace n ON seq.relnamespace = n.oid AND n.nspname = $1
      INNER JOIN pg_attribute a ON d.refobjsubid = a.attnum AND a.attrelid = t.oid
      ORDER BY sequence_schema, sequence_name;
    `;

    const sequences = await db.getRows(query, [schema]);
    return sequences || [];
  } catch (error) {
    console.error(`Error getting affected sequences for schema ${schema}:`, error.message);
    console.error(`  Falling back to getting all sequences in schema...`);
    // Fallback: get all sequences for the schema (less precise but safer)
    return await getAllSequencesForSchema(schema);
  }
}

/**
 * Get all sequences for a schema (fallback method)
 */
async function getAllSequencesForSchema(schema) {
  try {
    const query = `
      SELECT 
        sequence_schema,
        sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = $1
      ORDER BY sequence_name;
    `;
    const sequences = await db.getRows(query, [schema]);
    return sequences || [];
  } catch (error) {
    console.error(`Error getting all sequences for schema ${schema}:`, error.message);
    return [];
  }
}

/**
 * Reset a sequence to start from 1
 */
async function resetSequence(schema, sequenceName) {
  try {
    const fullSequenceName = `${schema}.${sequenceName}`;
    const query = `ALTER SEQUENCE ${fullSequenceName} RESTART WITH 1;`;
    await db.executeCommand(query);
    console.log(`  ✓ Reset sequence: ${fullSequenceName}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error resetting sequence ${schema}.${sequenceName}:`, error.message);
    return false;
  }
}

/**
 * Truncate datasets table with CASCADE for a specific schema
 */
async function truncateDatasets(schema) {
  try {
    const tableName = `${schema}.datasets`;
    console.log(`\nTruncating ${tableName} with CASCADE...`);
    
    const query = `TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE;`;
    await db.executeCommand(query);
    console.log(`  ✓ Successfully truncated ${tableName} with CASCADE`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error truncating ${schema}.datasets:`, error.message);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(70));
  console.log('TRUNCATE DATASETS CASCADE AND RESET IDENTITIES');
  console.log('='.repeat(70));
  console.log('\nWARNING: This will delete ALL dataset-related data!');
  console.log('This includes:');
  console.log('  - datasets');
  console.log('  - dataset_events');
  console.log('  - dataset_objects');
  console.log('  - dataset_pages');
  console.log('  - dataset_sharing');
  console.log('  - dataset_targets');
  console.log('  - events_aggregate');
  console.log('  - events_cloud');
  console.log('  - events_mapdata');
  console.log('  - events_timeseries');
  console.log('  - maneuver_stats');
  console.log('\nPress Ctrl+C within 5 seconds to cancel...\n');
  
  // Wait 5 seconds
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const schemas = ['ac40', 'ac75'];
  let totalTruncated = 0;
  let totalSequencesReset = 0;
  
  for (const schema of schemas) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Processing schema: ${schema}`);
    console.log('='.repeat(70));
    
    // Check if schema exists
    const schemaCheck = await db.getRows(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [schema]
    );
    
    if (!schemaCheck || schemaCheck.length === 0) {
      console.log(`  ⚠ Schema ${schema} does not exist, skipping...`);
      continue;
    }
    
    // Check if datasets table exists
    const tableCheck = await db.getRows(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'datasets'`,
      [schema]
    );
    
    if (!tableCheck || tableCheck.length === 0) {
      console.log(`  ⚠ Table ${schema}.datasets does not exist, skipping...`);
      continue;
    }
    
    // Truncate datasets with CASCADE
    const truncated = await truncateDatasets(schema);
    if (truncated) {
      totalTruncated++;
    }
    
    // Get sequences for affected tables and reset them
    // Note: RESTART IDENTITY in TRUNCATE resets sequences for the datasets table,
    // but we need to explicitly reset sequences for all dependent tables that get truncated via CASCADE
    console.log(`\nFinding and resetting sequences for affected tables...`);
    const sequences = await getAffectedSequences(schema);
    
    if (sequences.length === 0) {
      console.log(`  ℹ No sequences found for affected tables in schema ${schema}`);
    } else {
      // Group by sequence name to avoid resetting the same sequence multiple times
      const uniqueSequences = new Map();
      for (const seq of sequences) {
        const key = `${seq.sequence_schema}.${seq.sequence_name}`;
        if (!uniqueSequences.has(key)) {
          uniqueSequences.set(key, seq);
          console.log(`  Found sequence: ${key} (used by ${seq.table_name}.${seq.column_name})`);
        }
      }
      
      for (const seq of uniqueSequences.values()) {
        const reset = await resetSequence(seq.sequence_schema, seq.sequence_name);
        if (reset) {
          totalSequencesReset++;
        }
      }
    }
  }
  
  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Schemas processed: ${schemas.length}`);
  console.log(`Tables truncated: ${totalTruncated}`);
  console.log(`Sequences reset: ${totalSequencesReset}`);
  console.log('\n✓ Operation completed successfully!');
}

// Run the script
main()
  .then(() => {
    console.log('\nScript finished.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n✗ Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await db.close();
  });
