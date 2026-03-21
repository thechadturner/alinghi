#!/bin/bash
# Copy schema from one class to another
# Usage: ./copy_schema.sh <source_schema> <target_schema> <database> <username>
# Example: ./copy_schema.sh ac75 sailgp hunico postgres
#
# This script copies a schema definition from one class schema to another.
# The source schema file is: database/hunico_database_emptry.sql
# For complete schema documentation, see: docs/database/database-schema.md

if [ $# -ne 4 ]; then
    echo "Usage: $0 <source_schema> <target_schema> <database> <username>"
    echo "Example: $0 ac75 sailgp hunico postgres"
    exit 1
fi

SOURCE_SCHEMA=$1
TARGET_SCHEMA=$2
DATABASE=$3
USERNAME=$4

echo "Copying schema from $SOURCE_SCHEMA to $TARGET_SCHEMA in database $DATABASE..."

pg_dump -U "$USERNAME" -d "$DATABASE" -n "$SOURCE_SCHEMA" --schema-only \
  | sed "s/\b$SOURCE_SCHEMA\b/$TARGET_SCHEMA/g" \
  | psql -U "$USERNAME" -d "$DATABASE"

if [ $? -eq 0 ]; then
    echo "Schema copied successfully!"
else
    echo "Error copying schema. Please check the error messages above."
    exit 1
fi

# Alternative PowerShell version (for reference):
# pg_dump -U postgres -d hunico -n ac75 --schema-only |
#   % { $_ -replace '\bac75\b', 'sailgp' } |
#   psql -U postgres -d hunico
#
# Alternative file-based approach (for reference):
# (Get-Content hunico_database_emptry.sql) -replace '\bac75\b','sailgp' | Set-Content sailgp_empty.sql


