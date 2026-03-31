-- ============================================================================
-- Sync all sequences to max(column) after restore / reset
-- ============================================================================
--
-- Run this after:
--   - pg_restore or any backup restore that loads table data
--   - Manual COPY or INSERT ... SELECT that populates tables without using sequences
--   - Any operation that can leave sequences behind the current max(id) in tables
--
-- What it does:
--   For each sequence in the target schema(s) that is owned by a table column
--   (serial/bigserial), sets the sequence value to COALESCE(MAX(column), 1) so
--   the next nextval() will not collide with existing rows.
--
-- Schemas: Edit the list in the DO block (default: ac40, ac75, admin) or run
-- once per schema.
--
-- Usage: psql -d your_db -f sync_sequences_after_restore.sql
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  seq_full TEXT;
  max_val BIGINT;
  schemas_to_sync TEXT[] := ARRAY['ac40', 'ac75', 'admin'];
  schema_name TEXT;
BEGIN
  FOREACH schema_name IN ARRAY schemas_to_sync
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = schema_name) THEN
      RAISE NOTICE 'Schema % does not exist, skipping.', schema_name;
      CONTINUE;
    END IF;

    RAISE NOTICE '';
    RAISE NOTICE 'Syncing sequences in schema: %', schema_name;

    FOR r IN
      SELECT
        n.nspname::TEXT   AS seq_schema,
        seq.relname::TEXT AS seq_name,
        t.relname::TEXT   AS table_name,
        a.attname::TEXT   AS column_name
      FROM pg_class t
      JOIN pg_namespace tn ON t.relnamespace = tn.oid AND tn.nspname = schema_name
      JOIN pg_depend d ON d.refobjid = t.oid AND d.deptype = 'a'
      JOIN pg_class seq ON d.objid = seq.oid AND seq.relkind = 'S'
      JOIN pg_namespace n ON seq.relnamespace = n.oid AND n.nspname = schema_name
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE t.relkind = 'r'
      ORDER BY n.nspname, seq.relname
    LOOP
      seq_full := quote_ident(r.seq_schema) || '.' || quote_ident(r.seq_name);

      BEGIN
        EXECUTE format(
          'SELECT COALESCE(MAX(%I)::BIGINT, 1) FROM %I.%I',
          r.column_name,
          r.seq_schema,
          r.table_name
        ) INTO max_val;

        EXECUTE format('SELECT setval(%I.%I::regclass, $1)', r.seq_schema, r.seq_name) USING max_val;

        RAISE NOTICE '  % (%.%.%) -> set to %', seq_full, r.seq_schema, r.table_name, r.column_name, max_val;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '  % (%.%.%) -> ERROR: %', seq_full, r.seq_schema, r.table_name, r.column_name, SQLERRM;
      END;
    END LOOP;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Done. Next inserts will use sequence values above existing data.';
END $$;
