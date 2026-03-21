#!/bin/bash
# Post-deployment verification - run this on production server after deployment
# Usage: ssh to server, cd /home/racesight/racesight, bash servers/docker/scripts/post-deploy-check.sh

echo "============================================"
echo "  Post-Deployment InfluxDB Check"
echo "============================================"
echo

cd /home/racesight/racesight || exit 1

echo "[1] Checking files existence..."
ls -la docker-compose.yml 2>/dev/null && echo "  ✓ docker-compose.yml exists" || echo "  ✗ docker-compose.yml NOT FOUND"
ls -la .env.production 2>/dev/null && echo "  ✓ .env.production exists" || echo "  ✗ .env.production NOT FOUND"
ls -la .env.production.local 2>/dev/null && echo "  ✓ .env.production.local exists" || echo "  ✗ .env.production.local NOT FOUND"
echo

echo "[2] Checking docker-compose.yml configuration..."
if grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}" docker-compose.yml 2>/dev/null; then
    echo "  ✗ PROBLEM: INFLUX_TOKEN found in environment section"
    echo "    This prevents env_file from loading the value!"
    grep -A 2 -B 2 "INFLUX_TOKEN=\${INFLUX_TOKEN:-}" docker-compose.yml
else
    echo "  ✓ INFLUX_TOKEN NOT in environment section (correct)"
fi

if grep -q "env_file:" docker-compose.yml 2>/dev/null; then
    echo "  ✓ env_file section exists"
    echo "    env_file entries:"
    grep -A 3 "env_file:" docker-compose.yml | grep -E "^\s+-" | head -4
else
    echo "  ✗ env_file section NOT FOUND"
fi
echo

echo "[3] Checking .env.production.local content..."
if [ -f ".env.production.local" ]; then
    if grep -q "^INFLUX_TOKEN=" .env.production.local 2>/dev/null; then
        echo "  ✓ INFLUX_TOKEN found in .env.production.local"
    else
        echo "  ✗ INFLUX_TOKEN NOT found in .env.production.local"
    fi
    
    if grep -q "^INFLUX_BUCKET=" .env.production.local 2>/dev/null; then
        echo "  ✓ INFLUX_BUCKET found in .env.production.local"
    else
        echo "  ✗ INFLUX_BUCKET NOT found in .env.production.local"
    fi
    
    if grep -q "^INFLUX_HOST=" .env.production.local 2>/dev/null; then
        echo "  ✓ INFLUX_HOST found in .env.production.local"
    else
        echo "  ✗ INFLUX_HOST NOT found in .env.production.local"
    fi
else
    echo "  ✗ .env.production.local file NOT FOUND"
fi
echo

echo "[4] Checking container status..."
if docker ps | grep -q hunico-node; then
    echo "  ✓ hunico-node is running"
    
    echo
    echo "[5] Checking environment variables IN container..."
    echo "  Testing hunico-node:"
    INFLUX_HOST=$(docker exec hunico-node sh -c 'echo "$INFLUX_HOST"' 2>/dev/null)
    INFLUX_TOKEN=$(docker exec hunico-node sh -c 'echo "$INFLUX_TOKEN"' 2>/dev/null)
    INFLUX_BUCKET=$(docker exec hunico-node sh -c 'echo "$INFLUX_BUCKET"' 2>/dev/null)
    NODE_ENV=$(docker exec hunico-node sh -c 'echo "$NODE_ENV"' 2>/dev/null)
    
    echo "    NODE_ENV: ${NODE_ENV:-NOT_SET}"
    echo "    INFLUX_HOST: ${INFLUX_HOST:-NOT_SET}"
    echo "    INFLUX_BUCKET: ${INFLUX_BUCKET:-NOT_SET}"
    
    if [ -n "$INFLUX_TOKEN" ]; then
        echo "    INFLUX_TOKEN: SET (${INFLUX_TOKEN:0:10}...)"
    else
        echo "    INFLUX_TOKEN: NOT_SET ❌"
    fi
    
    if [ -z "$INFLUX_TOKEN" ]; then
        echo
        echo "  ❌ CRITICAL: INFLUX_TOKEN is NOT set in container!"
        echo
        echo "  Possible causes:"
        echo "    1. docker-compose.yml has INFLUX_TOKEN in environment: section (check step 2)"
        echo "    2. .env.production.local doesn't exist or missing INFLUX_TOKEN (check step 3)"
        echo "    3. Containers need to be recreated (not just restarted)"
        echo
        echo "  Fix: Run the following commands:"
        echo "    docker-compose -f docker-compose.yml down"
        echo "    docker-compose -f docker-compose.yml up -d"
    else
        echo
        echo "  ✓ INFLUX_TOKEN is SET correctly!"
    fi
else
    echo "  ✗ hunico-node is NOT running"
    echo "  Start it with: docker-compose -f docker-compose.yml up -d"
fi
echo

echo "============================================"
echo "  Diagnostic Complete"
echo "============================================"
