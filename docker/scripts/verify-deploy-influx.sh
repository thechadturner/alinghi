#!/bin/bash
# Quick verification script to check if InfluxDB env vars are deployed correctly
# Run this on the production server after deployment

cd /home/racesight/hunico || exit 1

echo "============================================"
echo "  Verifying InfluxDB Deployment"
echo "============================================"
echo

# Check 1: docker-compose.yml exists and is correct
echo "1. Checking docker-compose.yml..."
if [ ! -f "docker-compose.yml" ]; then
    echo "   ❌ docker-compose.yml NOT FOUND"
    exit 1
else
    echo "   ✓ docker-compose.yml exists"
    
    # Check if INFLUX_TOKEN is in environment section (BAD)
    if grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
        echo "   ❌ PROBLEM: INFLUX_TOKEN found in environment section"
        echo "   → This prevents env_file from loading the value"
    else
        echo "   ✓ INFLUX_TOKEN NOT in environment section (correct)"
    fi
    
    # Check env_file section
    if grep -q "\.env\.production\.local" docker-compose.yml; then
        echo "   ✓ .env.production.local is in env_file section"
    else
        echo "   ❌ .env.production.local NOT in env_file section"
    fi
fi
echo

# Check 2: .env.production.local exists
echo "2. Checking .env.production.local..."
if [ ! -f ".env.production.local" ]; then
    echo "   ❌ .env.production.local NOT FOUND"
    echo "   → This file must contain INFLUX_TOKEN and INFLUX_BUCKET"
else
    echo "   ✓ .env.production.local exists"
    if grep -q "^INFLUX_TOKEN=" .env.production.local; then
        echo "   ✓ INFLUX_TOKEN found in .env.production.local"
    else
        echo "   ❌ INFLUX_TOKEN NOT found in .env.production.local"
    fi
    if grep -q "^INFLUX_BUCKET=" .env.production.local; then
        echo "   ✓ INFLUX_BUCKET found in .env.production.local"
    else
        echo "   ❌ INFLUX_BUCKET NOT found in .env.production.local"
    fi
fi
echo

# Check 3: Containers are running
echo "3. Checking containers..."
if docker ps | grep -q hunico-node; then
    echo "   ✓ hunico-node is running"
else
    echo "   ❌ hunico-node is NOT running"
    echo "   → Run: docker-compose -f docker-compose.yml up -d"
    exit 1
fi
echo

# Check 4: Environment variables in containers
echo "4. Checking environment variables in containers..."
echo "   hunico-node:"
INFLUX_HOST_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_HOST"' 2>/dev/null)
INFLUX_TOKEN_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_TOKEN"' 2>/dev/null)
INFLUX_BUCKET_NODE=$(docker exec hunico-node sh -c 'echo "$INFLUX_BUCKET"' 2>/dev/null)

if [ -n "$INFLUX_HOST_NODE" ]; then
    echo "      ✓ INFLUX_HOST: $INFLUX_HOST_NODE"
else
    echo "      ❌ INFLUX_HOST: NOT SET"
fi

if [ -n "$INFLUX_TOKEN_NODE" ]; then
    TOKEN_PREVIEW="${INFLUX_TOKEN_NODE:0:10}..."
    echo "      ✓ INFLUX_TOKEN: SET ($TOKEN_PREVIEW)"
else
    echo "      ❌ INFLUX_TOKEN: NOT SET"
fi

if [ -n "$INFLUX_BUCKET_NODE" ]; then
    echo "      ✓ INFLUX_BUCKET: $INFLUX_BUCKET_NODE"
else
    echo "      ❌ INFLUX_BUCKET: NOT SET"
fi
echo

# Summary
echo "============================================"
echo "  Summary"
echo "============================================"

if [ -z "$INFLUX_TOKEN_NODE" ]; then
    echo "❌ INFLUX_TOKEN is NOT loaded in container"
    echo
    echo "Possible causes:"
    echo "  1. docker-compose.yml still has INFLUX_TOKEN in environment section"
    echo "  2. .env.production.local doesn't exist or is missing INFLUX_TOKEN"
    echo "  3. Containers need to be restarted after fixing docker-compose.yml"
    echo
    echo "Fix:"
    echo "  1. Remove INFLUX_TOKEN and INFLUX_BUCKET from environment: section in docker-compose.yml"
    echo "  2. Ensure .env.production.local exists with INFLUX_TOKEN and INFLUX_BUCKET"
    echo "  3. Restart: docker-compose -f docker-compose.yml down && docker-compose -f docker-compose.yml up -d"
    exit 1
else
    echo "✓ INFLUX_TOKEN is loaded correctly!"
    echo "✓ Deployment appears successful"
fi
