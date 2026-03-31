-- ============================================================================
-- SQL Script: Truncate Datasets CASCADE and Reset Identity Sequences
-- ============================================================================
-- 
-- This script will:
-- 1. Truncate datasets table in ac40 schema with CASCADE
--    (which automatically truncates all dependent tables via foreign keys)
-- 2. Reset all identity sequences (sequences) for all affected tables
-- 
-- WARNING: This is a destructive operation that will delete ALL dataset-related data!
-- 
-- This includes:
--   - datasets
--   - dataset_events
--   - dataset_objects
--   - dataset_pages
--   - dataset_sharing
--   - dataset_targets
--   - events_aggregate
--   - events_cloud
--   - events_mapdata
--   - events_timeseries
--   - maneuver_stats
-- 
-- Usage: Execute this script in pgAdmin or psql
-- ============================================================================

DO $$
DECLARE
    sequence_record RECORD;
    total_sequences_reset INTEGER := 0;
    unique_sequences TEXT[];
    sequence_key TEXT;
BEGIN
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'TRUNCATE DATASETS CASCADE AND RESET IDENTITIES (ac40 schema)';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE '';
    RAISE NOTICE 'WARNING: This will delete ALL dataset-related data in ac40 schema!';
    RAISE NOTICE 'This includes: datasets, dataset_events, dataset_objects, dataset_pages,';
    RAISE NOTICE 'dataset_sharing, dataset_targets, events_aggregate, events_cloud,';
    RAISE NOTICE 'events_mapdata, events_timeseries, maneuver_stats.';
    RAISE NOTICE '';
    RAISE NOTICE 'All identity sequences will be reset.';
    RAISE NOTICE 'This action CANNOT be undone!';
    RAISE NOTICE '';
    
    -- Check if schema exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.schemata s
        WHERE s.schema_name = 'ac40'
    ) THEN
        RAISE NOTICE '  ✗ Schema ac40 does not exist, aborting...';
        RETURN;
    END IF;
    
    -- Check if datasets table exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.tables 
        WHERE table_schema = 'ac40' 
        AND table_name = 'datasets'
    ) THEN
        RAISE NOTICE '  ✗ Table ac40.datasets does not exist, aborting...';
        RETURN;
    END IF;
    
    -- Truncate datasets with CASCADE
    BEGIN
        TRUNCATE TABLE ac40.datasets RESTART IDENTITY CASCADE;
        RAISE NOTICE '  ✓ Successfully truncated ac40.datasets with CASCADE';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '  ✗ Error truncating ac40.datasets: %', SQLERRM;
        RETURN;
    END;
    
    -- Find and reset sequences for affected tables
    RAISE NOTICE '';
    RAISE NOTICE 'Finding and resetting sequences for affected tables...';
    
    -- Get all sequences for tables affected by the truncate cascade
    -- Using the same recursive CTE logic as the JavaScript version
    FOR sequence_record IN
        WITH RECURSIVE dependent_tables AS (
            -- Start with datasets and dataset_events tables
            SELECT 
                t.table_schema,
                t.table_name
            FROM information_schema.tables t
            WHERE t.table_schema = 'ac40' 
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
                AND t.table_schema = 'ac40'
        )
        SELECT DISTINCT
            n.nspname::TEXT as sequence_schema,
            seq.relname::TEXT as sequence_name,
            t.relname::TEXT as table_name,
            a.attname::TEXT as column_name
        FROM dependent_tables dt
        INNER JOIN pg_class t ON t.relname = dt.table_name
        INNER JOIN pg_namespace tn ON t.relnamespace = tn.oid AND tn.nspname = dt.table_schema
        INNER JOIN pg_depend d
            ON d.refobjid = t.oid
            AND d.deptype = 'a'  -- 'a' = auto dependency (sequence owned by column)
        INNER JOIN pg_class seq ON d.objid = seq.oid AND seq.relkind = 'S'
        INNER JOIN pg_namespace n ON seq.relnamespace = n.oid AND n.nspname = 'ac40'
        INNER JOIN pg_attribute a ON d.refobjsubid = a.attnum AND a.attrelid = t.oid
        ORDER BY sequence_schema, sequence_name
    LOOP
        -- Create unique key for sequence (to avoid resetting the same sequence multiple times)
        sequence_key := sequence_record.sequence_schema || '.' || sequence_record.sequence_name;
        
        -- Check if we've already processed this sequence
        IF sequence_key = ANY(unique_sequences) THEN
            CONTINUE;
        END IF;
        
        -- Add to processed list
        unique_sequences := array_append(unique_sequences, sequence_key);
        
        RAISE NOTICE '  Found sequence: % (used by %.%)', 
            sequence_key, 
            sequence_record.table_name, 
            sequence_record.column_name;
        
        -- Reset the sequence
        BEGIN
            EXECUTE format('ALTER SEQUENCE %I.%I RESTART WITH 1', 
                sequence_record.sequence_schema, 
                sequence_record.sequence_name);
            RAISE NOTICE '    ✓ Reset sequence: %', sequence_key;
            total_sequences_reset := total_sequences_reset + 1;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE '    ✗ Error resetting sequence %: %', sequence_key, SQLERRM;
        END;
    END LOOP;
    
    -- If no sequences found with the recursive method, try fallback: get all sequences in schema
    IF array_length(unique_sequences, 1) IS NULL THEN
        RAISE NOTICE '  ℹ No sequences found with recursive method, trying fallback...';
        
        FOR sequence_record IN
            SELECT 
                seq.sequence_schema::TEXT,
                seq.sequence_name::TEXT,
                ''::TEXT as table_name,
                ''::TEXT as column_name
            FROM information_schema.sequences seq
            WHERE seq.sequence_schema = 'ac40'
            ORDER BY seq.sequence_name
        LOOP
            sequence_key := sequence_record.sequence_schema || '.' || sequence_record.sequence_name;
            
            -- Check if we've already processed this sequence
            IF sequence_key = ANY(unique_sequences) THEN
                CONTINUE;
            END IF;
            
            -- Add to processed list
            unique_sequences := array_append(unique_sequences, sequence_key);
            
            RAISE NOTICE '  Found sequence: %', sequence_key;
            
            -- Reset the sequence
            BEGIN
                EXECUTE format('ALTER SEQUENCE %I.%I RESTART WITH 1', 
                    sequence_record.sequence_schema, 
                    sequence_record.sequence_name);
                RAISE NOTICE '    ✓ Reset sequence: %', sequence_key;
                total_sequences_reset := total_sequences_reset + 1;
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE '    ✗ Error resetting sequence %: %', sequence_key, SQLERRM;
            END;
        END LOOP;
    END IF;
    
    -- Summary
    RAISE NOTICE '';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'SUMMARY';
    RAISE NOTICE '============================================================================';
    RAISE NOTICE 'Schema processed: ac40';
    RAISE NOTICE 'Table truncated: ac40.datasets';
    RAISE NOTICE 'Sequences reset: %', total_sequences_reset;
    RAISE NOTICE '';
    RAISE NOTICE '✓ Operation completed successfully!';
    RAISE NOTICE '';
END $$;
