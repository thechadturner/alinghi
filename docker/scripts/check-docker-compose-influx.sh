#!/bin/bash
# Quick check to see if docker-compose.yml has INFLUX_TOKEN in environment section

echo "Checking docker-compose.yml for InfluxDB configuration issues..."
echo

if [ ! -f "docker-compose.yml" ]; then
    echo "[ERROR] docker-compose.yml not found in current directory"
    echo "[INFO] Run this script from the directory containing docker-compose.yml"
    exit 1
fi

echo "[INFO] Checking docker-compose.yml..."

# Check if INFLUX_TOKEN is in environment section (BAD)
if grep -A 10 "node:" docker-compose.yml | grep -A 10 "environment:" | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
    echo "[ERROR] ❌ INFLUX_TOKEN is set in environment: section with empty default"
    echo "[ERROR] This prevents env_file from loading the value!"
    echo
    echo "[INFO] Found problematic lines:"
    grep -A 10 "node:" docker-compose.yml | grep -A 10 "environment:" | grep -E "INFLUX_TOKEN|INFLUX_BUCKET" | head -5
    echo
    echo "[FIX] Remove these lines from the environment: section:"
    echo "  - INFLUX_TOKEN=\${INFLUX_TOKEN:-}"
    echo "  - INFLUX_BUCKET=\${INFLUX_BUCKET:-}"
    echo
    echo "[INFO] They should only be loaded via env_file: section"
    exit 1
else
    echo "[SUCCESS] ✓ INFLUX_TOKEN is NOT in environment: section (correct)"
fi

# Check if INFLUX_BUCKET is in environment section (BAD)
if grep -A 10 "node:" docker-compose.yml | grep -A 10 "environment:" | grep -q "INFLUX_BUCKET=\${INFLUX_BUCKET:-}"; then
    echo "[ERROR] ❌ INFLUX_BUCKET is set in environment: section with empty default"
    echo "[ERROR] This prevents env_file from loading the value!"
    exit 1
else
    echo "[SUCCESS] ✓ INFLUX_BUCKET is NOT in environment: section (correct)"
fi

# Check if env_file section exists
if grep -q "env_file:" docker-compose.yml; then
    echo "[SUCCESS] ✓ env_file: section exists"
    echo "[INFO] env_file entries:"
    grep -A 3 "env_file:" docker-compose.yml | grep -E "^\s+-" | sed 's/^/  /'
else
    echo "[ERROR] env_file: section NOT FOUND"
    exit 1
fi

echo
echo "[SUCCESS] docker-compose.yml configuration looks correct!"
echo "[INFO] If containers still don't have the variables, try:"
echo "  docker-compose -f docker-compose.yml down"
echo "  docker-compose -f docker-compose.yml up -d"
