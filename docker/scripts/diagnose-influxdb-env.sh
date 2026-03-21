#!/bin/bash
# Diagnostic script for InfluxDB environment variable issues
# Run this on the production server to diagnose why INFLUX_TOKEN is not being loaded

echo "============================================"
echo "  InfluxDB Environment Variable Diagnostic"
echo "============================================"
echo

# Get the base directory (assumes script is run from project root or docker/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$SCRIPT_DIR" == *"/docker/scripts" ]]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

cd "$PROJECT_ROOT" || exit 1

echo "[INFO] Project root: $PROJECT_ROOT"
echo

# Step 1: Check if .env.production.local exists
echo "============================================"
echo "Step 1: Checking .env.production.local file"
echo "============================================"
if [ -f ".env.production.local" ]; then
    echo "[SUCCESS] .env.production.local exists"
    echo "[INFO] File location: $(pwd)/.env.production.local"
    echo "[INFO] File size: $(stat -f%z .env.production.local 2>/dev/null || stat -c%s .env.production.local 2>/dev/null) bytes"
    echo
    
    # Check for InfluxDB variables
    echo "[INFO] Checking for InfluxDB variables in .env.production.local:"
    if grep -q "^INFLUX_TOKEN=" .env.production.local; then
        TOKEN_LINE=$(grep "^INFLUX_TOKEN=" .env.production.local | head -1)
        TOKEN_LENGTH=${#TOKEN_LINE}
        echo "  ✓ INFLUX_TOKEN: Found (length: $TOKEN_LENGTH chars)"
    else
        echo "  ✗ INFLUX_TOKEN: NOT FOUND"
    fi
    
    if grep -q "^INFLUX_BUCKET=" .env.production.local; then
        BUCKET_VALUE=$(grep "^INFLUX_BUCKET=" .env.production.local | head -1 | cut -d'=' -f2)
        echo "  ✓ INFLUX_BUCKET: Found (value: $BUCKET_VALUE)"
    else
        echo "  ✗ INFLUX_BUCKET: NOT FOUND"
    fi
    
    if grep -q "^INFLUX_HOST=" .env.production.local; then
        HOST_VALUE=$(grep "^INFLUX_HOST=" .env.production.local | head -1 | cut -d'=' -f2)
        echo "  ✓ INFLUX_HOST: Found (value: $HOST_VALUE)"
    else
        echo "  ✗ INFLUX_HOST: NOT FOUND"
    fi
    
    if grep -q "^INFLUX_DATABASE=" .env.production.local; then
        DB_VALUE=$(grep "^INFLUX_DATABASE=" .env.production.local | head -1 | cut -d'=' -f2)
        echo "  ✓ INFLUX_DATABASE: Found (value: $DB_VALUE)"
    else
        echo "  ✗ INFLUX_DATABASE: NOT FOUND"
    fi
else
    echo "[ERROR] .env.production.local does NOT exist"
    echo "[INFO] Expected location: $(pwd)/.env.production.local"
    echo "[INFO] This file should contain INFLUX_TOKEN and INFLUX_BUCKET"
fi
echo

# Step 2: Check docker-compose.yml configuration
echo "============================================"
echo "Step 2: Checking docker-compose.yml configuration"
echo "============================================"
if [ -f "docker-compose.yml" ]; then
    echo "[SUCCESS] docker-compose.yml exists"
    
    # Check if INFLUX_TOKEN is in the environment section (BAD)
    if grep -A 5 "environment:" docker-compose.yml | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
        echo "[ERROR] INFLUX_TOKEN is set in environment: section with empty default"
        echo "[ERROR] This prevents env_file from loading the value!"
        echo "[INFO] Found in docker-compose.yml:"
        grep -B 2 -A 2 "INFLUX_TOKEN=\${INFLUX_TOKEN:-}" docker-compose.yml | head -5
    else
        echo "[SUCCESS] INFLUX_TOKEN is NOT in environment: section (correct)"
    fi
    
    # Check if INFLUX_BUCKET is in the environment section (BAD)
    if grep -A 5 "environment:" docker-compose.yml | grep -q "INFLUX_BUCKET=\${INFLUX_BUCKET:-}"; then
        echo "[ERROR] INFLUX_BUCKET is set in environment: section with empty default"
        echo "[ERROR] This prevents env_file from loading the value!"
    else
        echo "[SUCCESS] INFLUX_BUCKET is NOT in environment: section (correct)"
    fi
    
    # Check if env_file section exists
    if grep -q "env_file:" docker-compose.yml; then
        echo "[SUCCESS] env_file: section exists"
        echo "[INFO] env_file entries:"
        grep -A 3 "env_file:" docker-compose.yml | grep -E "^\s+-" | sed 's/^/  /'
    else
        echo "[ERROR] env_file: section NOT FOUND"
    fi
else
    echo "[WARNING] docker-compose.yml not found in current directory"
    echo "[INFO] Looking for docker-compose.yml in common locations..."
    find . -name "docker-compose.yml" -type f 2>/dev/null | head -3
fi
echo

# Step 3: Check environment variables in running containers
echo "============================================"
echo "Step 3: Checking environment variables in containers"
echo "============================================"

# Check hunico-node container
if docker ps | grep -q hunico-node; then
    echo "[INFO] Checking hunico-node container:"
    
    INFLUX_HOST_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_HOST"' 2>/dev/null)
    INFLUX_TOKEN_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_TOKEN"' 2>/dev/null)
    INFLUX_DATABASE_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_DATABASE"' 2>/dev/null)
    INFLUX_BUCKET_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_BUCKET"' 2>/dev/null)
    
    echo "  INFLUX_HOST: ${INFLUX_HOST_NODE:-<NOT SET>}"
    echo "  INFLUX_DATABASE: ${INFLUX_DATABASE_NODE:-<NOT SET>}"
    echo "  INFLUX_BUCKET: ${INFLUX_BUCKET_NODE:-<NOT SET>}"
    if [ -n "$INFLUX_TOKEN_NODE" ]; then
        TOKEN_PREVIEW="${INFLUX_TOKEN_NODE:0:10}..."
        echo "  INFLUX_TOKEN: SET (starts with: $TOKEN_PREVIEW)"
    else
        echo "  INFLUX_TOKEN: <NOT SET>"
    fi
    
    if [ -z "$INFLUX_TOKEN_NODE" ] || [ -z "$INFLUX_BUCKET_NODE" ]; then
        echo "[ERROR] Missing InfluxDB variables in hunico-node container"
    else
        echo "[SUCCESS] All InfluxDB variables are set in hunico-node container"
    fi
else
    echo "[WARNING] hunico-node container is not running"
fi
echo

# Check hunico-python container
if docker ps | grep -q hunico-python; then
    echo "[INFO] Checking hunico-python container:"
    
    INFLUX_HOST_PYTHON=$(docker exec hunico-python sh -c 'echo "$INFLUX_HOST"' 2>/dev/null)
    INFLUX_TOKEN_PYTHON=$(docker exec hunico-python sh -c 'echo "$INFLUX_TOKEN"' 2>/dev/null)
    INFLUX_DATABASE_PYTHON=$(docker exec hunico-python sh -c 'echo "$INFLUX_DATABASE"' 2>/dev/null)
    INFLUX_BUCKET_PYTHON=$(docker exec hunico-python sh -c 'echo "$INFLUX_BUCKET"' 2>/dev/null)
    
    echo "  INFLUX_HOST: ${INFLUX_HOST_PYTHON:-<NOT SET>}"
    echo "  INFLUX_DATABASE: ${INFLUX_DATABASE_PYTHON:-<NOT SET>}"
    echo "  INFLUX_BUCKET: ${INFLUX_BUCKET_PYTHON:-<NOT SET>}"
    if [ -n "$INFLUX_TOKEN_PYTHON" ]; then
        TOKEN_PREVIEW="${INFLUX_TOKEN_PYTHON:0:10}..."
        echo "  INFLUX_TOKEN: SET (starts with: $TOKEN_PREVIEW)"
    else
        echo "  INFLUX_TOKEN: <NOT SET>"
    fi
    
    if [ -z "$INFLUX_TOKEN_PYTHON" ] || [ -z "$INFLUX_BUCKET_PYTHON" ]; then
        echo "[ERROR] Missing InfluxDB variables in hunico-python container"
    else
        echo "[SUCCESS] All InfluxDB variables are set in hunico-python container"
    fi
else
    echo "[WARNING] hunico-python container is not running"
fi
echo

# Step 4: Check server logs for diagnostic messages
echo "============================================"
echo "Step 4: Checking server logs for InfluxDB errors"
echo "============================================"
if docker ps | grep -q hunico-node; then
    echo "[INFO] Recent logs from hunico-node (filtered for InfluxDB):"
    docker logs hunico-node --tail=100 2>&1 | grep -i "influx" | tail -10 || echo "  No InfluxDB-related log messages found"
else
    echo "[WARNING] hunico-node container is not running"
fi
echo

# Step 5: Test config.js loading (if we can)
echo "============================================"
echo "Step 5: Testing config.js environment loading"
echo "============================================"
if docker ps | grep -q hunico-node; then
    echo "[INFO] Testing if server_file/middleware/config.js can access InfluxDB vars:"
    docker exec hunico-node node -e "
    const path = require('path');
    const configPath = path.join('/app', 'server_file', 'middleware', 'config.js');
    try {
      const env = require(configPath);
      console.log('  INFLUX_HOST:', env.INFLUX_HOST || '<NOT SET>');
      console.log('  INFLUX_DATABASE:', env.INFLUX_DATABASE || '<NOT SET>');
      console.log('  INFLUX_BUCKET:', env.INFLUX_BUCKET || '<NOT SET>');
      console.log('  INFLUX_TOKEN:', env.INFLUX_TOKEN ? 'SET (' + env.INFLUX_TOKEN.substring(0, 10) + '...)' : '<NOT SET>');
    } catch (err) {
      console.log('  Error loading config:', err.message);
    }
    " 2>&1 | sed 's/^/  /'
else
    echo "[WARNING] hunico-node container is not running"
fi
echo

# Summary and recommendations
echo "============================================"
echo "Summary and Recommendations"
echo "============================================"
echo

ISSUES_FOUND=0

if [ ! -f ".env.production.local" ]; then
    echo "[ISSUE $((++ISSUES_FOUND))] .env.production.local file is missing"
    echo "  → Create .env.production.local with INFLUX_TOKEN and INFLUX_BUCKET"
fi

if [ -f "docker-compose.yml" ] && grep -A 5 "environment:" docker-compose.yml | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
    echo "[ISSUE $((++ISSUES_FOUND))] docker-compose.yml has INFLUX_TOKEN in environment: section"
    echo "  → Remove INFLUX_TOKEN and INFLUX_BUCKET from environment: section"
    echo "  → They should only be loaded via env_file:"
fi

if docker ps | grep -q hunico-node; then
    INFLUX_TOKEN_CHECK=$(docker exec hunico-node sh -c 'echo "$INFLUX_TOKEN"' 2>/dev/null)
    if [ -z "$INFLUX_TOKEN_CHECK" ]; then
        echo "[ISSUE $((++ISSUES_FOUND))] INFLUX_TOKEN is not set in hunico-node container"
        echo "  → Restart containers after fixing docker-compose.yml and .env.production.local"
    fi
fi

if [ $ISSUES_FOUND -eq 0 ]; then
    echo "[SUCCESS] No obvious issues found!"
    echo "[INFO] If errors persist, check:"
    echo "  1. Container restart logs: docker logs hunico-node --tail=50"
    echo "  2. Verify .env.production.local is in the same directory as docker-compose.yml"
    echo "  3. Check file permissions on .env.production.local"
else
    echo
    echo "[INFO] Found $ISSUES_FOUND issue(s). Fix them and restart containers:"
    echo "  docker-compose -f docker-compose.yml down"
    echo "  docker-compose -f docker-compose.yml up -d"
fi

echo
echo "============================================"
echo "  Diagnostic Complete"
echo "============================================"
