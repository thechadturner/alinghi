-- Alinghi: rename PostgreSQL class schema gp50 -> ac40 and align admin.classes.
-- Run once on existing databases that still use schema "gp50".
-- (Strings "gp50"/"GP50" here are intentional: they match legacy schema and class_name rows.)
-- Fresh installs should use schema ac40 from the start (see production_backup_empty.sql).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'gp50') THEN
    ALTER SCHEMA gp50 RENAME TO ac40;
  END IF;
END $$;

UPDATE admin.classes
SET class_name = 'AC40'
WHERE UPPER(TRIM(class_name)) = 'GP50';
