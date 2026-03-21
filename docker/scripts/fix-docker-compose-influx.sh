#!/bin/bash
# Fix docker-compose.yml on production server by removing INFLUX_TOKEN and INFLUX_BUCKET from environment section

cd /home/racesight/hunico || exit 1

if [ ! -f "docker-compose.yml" ]; then
    echo "[ERROR] docker-compose.yml not found in /home/racesight/hunico"
    exit 1
fi

echo "============================================"
echo "  Fixing docker-compose.yml"
echo "============================================"
echo

# Create backup
BACKUP_FILE="docker-compose.yml.backup.$(date +%Y%m%d_%H%M%S)"
cp docker-compose.yml "$BACKUP_FILE"
echo "[INFO] Created backup: $BACKUP_FILE"
echo

# Check if fix is needed
if ! grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
    echo "[INFO] docker-compose.yml already fixed - INFLUX_TOKEN not in environment section"
    echo "[INFO] No changes needed"
    exit 0
fi

echo "[INFO] Removing INFLUX_TOKEN and INFLUX_BUCKET from environment section..."

# Use sed to remove the problematic lines
# This removes lines containing INFLUX_TOKEN=${INFLUX_TOKEN:-} or INFLUX_BUCKET=${INFLUX_BUCKET:-}
# but only within the node service's environment section

# Create a temporary file
TEMP_FILE=$(mktemp)

# Process the file: remove INFLUX_TOKEN and INFLUX_BUCKET lines from node service environment section
awk '
/^  node:/ { in_node_service=1; in_environment=0; print; next }
/^  [a-z]/ && in_node_service { in_node_service=0; in_environment=0 }
in_node_service && /environment:/ { in_environment=1; print; next }
in_environment && /INFLUX_TOKEN=\${INFLUX_TOKEN:-}/ { next }
in_environment && /INFLUX_BUCKET=\${INFLUX_BUCKET:-}/ { next }
in_environment && /^[[:space:]]*- [A-Z_]+=/ && !/^[[:space:]]*- INFLUX/ { in_environment=0 }
{ print }
' docker-compose.yml > "$TEMP_FILE"

# Verify the fix worked
if grep -A 50 "node:" "$TEMP_FILE" | grep -A 50 "environment:" | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
    echo "[ERROR] Fix failed - INFLUX_TOKEN still present"
    rm "$TEMP_FILE"
    exit 1
fi

# Replace the original file
mv "$TEMP_FILE" docker-compose.yml

echo "[SUCCESS] Removed INFLUX_TOKEN and INFLUX_BUCKET from environment section"
echo
echo "[INFO] Verifying fix..."
if grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
    echo "[ERROR] Verification failed - INFLUX_TOKEN still present"
    exit 1
else
    echo "[SUCCESS] Verification passed - INFLUX_TOKEN removed"
fi

echo
echo "============================================"
echo "  Next Steps"
echo "============================================"
echo
echo "1. Restart containers to apply changes:"
echo "   docker-compose -f docker-compose.yml down"
echo "   docker-compose -f docker-compose.yml up -d"
echo
echo "2. Verify INFLUX_TOKEN is now loaded:"
echo "   docker exec hunico-node sh -c 'echo \"INFLUX_TOKEN=\${INFLUX_TOKEN:+SET}\${INFLUX_TOKEN:-NOT_SET}\"'"
echo
echo "3. If something goes wrong, restore from backup:"
echo "   cp $BACKUP_FILE docker-compose.yml"
