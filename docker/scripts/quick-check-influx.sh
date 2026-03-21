#!/bin/bash
# Quick check for INFLUX_TOKEN and INFLUX_BUCKET in docker-compose.yml

cd /home/racesight/hunico || exit 1

echo "Checking docker-compose.yml for InfluxDB secrets in environment section..."
echo

# Check node service
echo "=== Node Service ==="
if grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep -q "INFLUX_TOKEN=\${INFLUX_TOKEN:-}"; then
    echo "❌ PROBLEM: INFLUX_TOKEN found in node service environment section"
    grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep "INFLUX_TOKEN"
else
    echo "✓ OK: INFLUX_TOKEN NOT in node service environment section"
fi

if grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep -q "INFLUX_BUCKET=\${INFLUX_BUCKET:-}"; then
    echo "❌ PROBLEM: INFLUX_BUCKET found in node service environment section"
    grep -A 50 "node:" docker-compose.yml | grep -A 50 "environment:" | grep "INFLUX_BUCKET"
else
    echo "✓ OK: INFLUX_BUCKET NOT in node service environment section"
fi

echo
echo "=== Checking env_file section ==="
if grep -A 5 "env_file:" docker-compose.yml | grep -q "\.env\.production\.local"; then
    echo "✓ OK: .env.production.local is in env_file section"
    grep -A 5 "env_file:" docker-compose.yml | grep "\.env\.production"
else
    echo "❌ PROBLEM: .env.production.local NOT found in env_file section"
fi

echo
echo "=== Current container environment ==="
if docker ps | grep -q hunico-node; then
    INFLUX_TOKEN=$(docker exec hunico-node sh -c 'echo "$INFLUX_TOKEN"' 2>/dev/null)
    if [ -n "$INFLUX_TOKEN" ]; then
        echo "✓ INFLUX_TOKEN is SET in container"
    else
        echo "❌ INFLUX_TOKEN is NOT SET in container"
    fi
else
    echo "⚠ hunico-node container not running"
fi
