#!/bin/bash
# Docker Configuration Verification Script
# Run this to verify Docker setup is correct

echo "========================================="
echo "Docker Configuration Verification"
echo "========================================="
echo ""

# Check current directory
echo "1. Checking current directory..."
if [ -f "docker/compose/production.yml" ]; then
    echo "   ✓ Running from workspace root"
    WORKSPACE_ROOT="."
elif [ -f "compose/production.yml" ]; then
    echo "   ✓ Running from docker directory"
    WORKSPACE_ROOT=".."
elif [ -f "production.yml" ]; then
    echo "   ✓ Running from docker/compose directory"
    WORKSPACE_ROOT="../.."
else
    echo "   ✗ ERROR: Cannot find production.yml"
    echo "   Please run from workspace root, docker/, or docker/compose/"
    exit 1
fi
echo ""

# Check directory structure
echo "2. Checking directory structure..."
DIRS_TO_CHECK=(
    "$WORKSPACE_ROOT/server_python"
    "$WORKSPACE_ROOT/server_python/scripts"
    "$WORKSPACE_ROOT/libs/utilities"
    "$WORKSPACE_ROOT/docker/dockerfiles"
    "$WORKSPACE_ROOT/docker/nginx"
    "$WORKSPACE_ROOT/docker/compose"
)

ALL_DIRS_OK=true
for dir in "${DIRS_TO_CHECK[@]}"; do
    if [ -d "$dir" ]; then
        echo "   ✓ $dir exists"
    else
        echo "   ✗ $dir NOT FOUND"
        ALL_DIRS_OK=false
    fi
done
echo ""

# Check for non-existent 'servers' directory
echo "3. Checking for incorrect 'servers' directory..."
if [ -d "$WORKSPACE_ROOT/servers" ]; then
    echo "   ⚠ WARNING: 'servers' directory exists but should not be used"
    echo "   Production.yml should reference '../..' not './servers'"
else
    echo "   ✓ No 'servers' directory (correct)"
fi
echo ""

# Check Dockerfiles
echo "4. Checking Dockerfiles..."
if [ -f "$WORKSPACE_ROOT/docker/dockerfiles/Dockerfile.python" ]; then
    echo "   ✓ Dockerfile.python exists"
    # Check if it references correct paths
    if grep -q "COPY server_python/" "$WORKSPACE_ROOT/docker/dockerfiles/Dockerfile.python"; then
        echo "   ✓ Dockerfile.python uses correct paths (server_python/)"
    else
        echo "   ✗ Dockerfile.python has incorrect paths"
    fi
else
    echo "   ✗ Dockerfile.python NOT FOUND"
fi

if [ -f "$WORKSPACE_ROOT/docker/dockerfiles/Dockerfile.nodejs" ]; then
    echo "   ✓ Dockerfile.nodejs exists"
else
    echo "   ✗ Dockerfile.nodejs NOT FOUND"
fi
echo ""

# Check production.yml
echo "5. Checking production.yml configuration..."
PROD_YML="$WORKSPACE_ROOT/docker/compose/production.yml"
if [ -f "$PROD_YML" ]; then
    echo "   ✓ production.yml exists"
    
    # Check build contexts
    if grep -q "context: \.\./\.\." "$PROD_YML"; then
        echo "   ✓ Build context uses '../..' (correct)"
    elif grep -q "context: \./servers" "$PROD_YML"; then
        echo "   ✗ Build context uses './servers' (INCORRECT - should be '../..')"
    else
        echo "   ? Build context format unclear"
    fi
    
    # Check nginx volumes
    if grep -q "\.\./\.\./docker/nginx" "$PROD_YML"; then
        echo "   ✓ Nginx volumes use correct paths (../../docker/nginx)"
    elif grep -q "\./servers/docker/nginx" "$PROD_YML"; then
        echo "   ✗ Nginx volumes use incorrect paths (./servers/docker/nginx)"
    else
        echo "   ? Nginx volume paths unclear"
    fi
    
    # Check for TZ environment variable
    if grep -q "TZ=" "$PROD_YML"; then
        echo "   ✓ Timezone (TZ) configured"
    else
        echo "   ⚠ WARNING: Timezone (TZ) not configured"
    fi
else
    echo "   ✗ production.yml NOT FOUND"
fi
echo ""

# Check environment files
echo "6. Checking environment files..."
if [ -f "$WORKSPACE_ROOT/.env.production" ]; then
    echo "   ✓ .env.production exists"
    if grep -q "^TZ=" "$WORKSPACE_ROOT/.env.production"; then
        TZ_VALUE=$(grep "^TZ=" "$WORKSPACE_ROOT/.env.production" | cut -d'=' -f2)
        echo "   ✓ TZ configured: $TZ_VALUE"
    else
        echo "   ⚠ WARNING: TZ not set in .env.production"
    fi
else
    echo "   ✗ .env.production NOT FOUND"
fi

if [ -f "$WORKSPACE_ROOT/.env.production.local" ]; then
    echo "   ✓ .env.production.local exists (secrets file)"
else
    echo "   ⚠ WARNING: .env.production.local NOT FOUND (needed for secrets)"
fi
echo ""

# Check normalization script
echo "7. Checking normalization script..."
NORM_SCRIPT="$WORKSPACE_ROOT/server_python/scripts/gp50/1_normalization_influx.py"
if [ -f "$NORM_SCRIPT" ]; then
    echo "   ✓ 1_normalization_influx.py exists"
    
    # Check for event_timezone support
    if grep -q "event_timezone" "$NORM_SCRIPT"; then
        echo "   ✓ Script supports event_timezone parameter"
    else
        echo "   ⚠ WARNING: Script does not support event_timezone parameter"
    fi
else
    echo "   ✗ 1_normalization_influx.py NOT FOUND"
fi
echo ""

# Summary
echo "========================================="
echo "Summary"
echo "========================================="
if [ "$ALL_DIRS_OK" = true ]; then
    echo "✓ Directory structure is correct"
else
    echo "✗ Directory structure has issues"
fi

echo ""
echo "Next steps:"
echo "1. Fix any issues marked with ✗"
echo "2. Review warnings marked with ⚠"
echo "3. Rebuild Docker images: docker-compose -f docker/compose/production.yml build --no-cache"
echo "4. Restart containers: docker-compose -f docker/compose/production.yml up -d"
echo ""
