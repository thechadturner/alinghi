# Docker Environment Variables - Important Notes

## Critical Understanding

**Environment variables from `.env.production` are loaded at CONTAINER STARTUP, not at BUILD TIME.**

This means:
- ✅ Changing `.env.production` and restarting containers will pick up new values
- ❌ Rebuilding Docker images will NOT pick up new `.env.production` values
- ✅ You must restart containers after updating `.env.production`

## How Docker Compose Loads Environment Variables

1. **Build Time**: Docker images are built from code and dependencies
   - Environment variables are NOT baked into the image
   - The `.env.production` file is NOT copied into the image

2. **Runtime (Container Startup)**: Docker Compose loads environment variables from:
   - `env_file:` entries in `docker-compose.yml`
   - `environment:` section in `docker-compose.yml`
   - System environment variables

3. **Precedence**: System env vars > `environment:` section > `env_file:` entries

## Common Issue: Environment Variables Not Updating

**Symptom**: You update `.env.production` with `DB_NAME=production`, redeploy, but the container still uses the old value.

**Root Causes**:
1. Container wasn't restarted after updating `.env.production`
2. `.env.production` file wasn't uploaded to the VM correctly
3. Docker Compose is using cached environment variables

## Solution

### Step 1: Verify `.env.production` on VM

SSH to your VM and check:
```bash
cd /home/racesight/racesight
cat .env.production | grep DB_NAME
```

Should show: `DB_NAME=production`

### Step 2: Force Restart Containers

```bash
cd /home/racesight/racesight
docker-compose -f docker-compose.yml down
docker-compose -f docker-compose.yml up -d
```

### Step 3: Verify Environment Variables in Container

```bash
docker exec hunico-node sh -c 'echo DB_NAME=$DB_NAME'
```

Should show: `DB_NAME=production`

### Step 4: Check Logs

```bash
docker logs hunico-node --tail=50
```

Look for database connection errors. If you still see a message like `database "<wrong_name>" does not exist`, the container is still using the wrong `DB_NAME` or PostgreSQL has no database matching your setting.

## Updated Deployment Process

The deployment script (`DEPLOY_VM_SERVERS.bat`) has been updated to:
1. **Force rebuild without cache**: `docker-compose build --no-cache`
2. **Always restart containers**: Ensures new environment variables are loaded

## Manual Verification Script

Use the verification script on the VM:
```bash
cd /home/racesight/racesight
bash docker/scripts/check-env-on-vm.sh
```

This will:
- Check if `.env.production` exists and show `DB_NAME`
- Show environment variables in the running container
- Help identify mismatches

## Troubleshooting

### Issue: Container still uses old DB_NAME

**Solution**: Force restart with environment variable check:
```bash
cd /home/racesight/racesight
docker-compose -f docker-compose.yml down
# Verify .env.production has correct value
cat .env.production | grep DB_NAME
# Restart
docker-compose -f docker-compose.yml up -d
# Verify container has correct value
docker exec hunico-node sh -c 'echo DB_NAME=$DB_NAME'
```

### Issue: .env.production not on VM

**Solution**: The deployment script should upload it, but you can manually upload:
```bash
# From your local machine
scp -i <your-key> .env.production racesight@<vm-ip>:/home/racesight/racesight/.env.production
```

### Issue: Environment variable not overriding default

In `docker/compose/production.yml`, the Node service includes:
```yaml
- DB_NAME=${DB_NAME:-production}
```

This means if `DB_NAME` is not set in the environment passed to Compose, it defaults to `production`. Other compose files (for example `node.yml`) may use a different fallback—check the file you deploy with. Make sure:
1. `.env.production` has `DB_NAME=production` (no spaces around `=`)
2. Container is restarted after updating `.env.production`

## Best Practices

1. **Always restart containers** after updating `.env.production`
2. **Verify environment variables** in the container after restart
3. **Check logs** to confirm the application is using the correct database
4. **Use the verification script** to diagnose issues quickly

## InfluxDB Configuration (Required for GP50 Normalization)

The Python service requires InfluxDB environment variables for the normalization scripts (`1_normalization_influx.py`):

**Required Variables:**
- `INFLUX_HOST` - InfluxDB server hostname or IP (e.g., `192.168.0.18` or `influxdb.example.com`)
- `INFLUX_PORT` - InfluxDB port (default: `8086`)
- `INFLUX_DATABASE` - InfluxDB organization/database name (default: `sailgp`)
- `INFLUX_TOKEN` - InfluxDB authentication token (required, no default)
- `INFLUX_BUCKET` - InfluxDB bucket name (required, no default)

**Configuration:**
These variables should be set in `.env.production` or `.env.production.local`:

```bash
INFLUX_HOST=your-influxdb-host
INFLUX_PORT=8086
INFLUX_DATABASE=sailgp
INFLUX_TOKEN=your-influxdb-token
INFLUX_BUCKET=your-influxdb-bucket
```

**Note:** The Python service in `production.yml` and `production-prebuilt.yml` now includes these environment variables. Make sure they are set in your `.env.production.local` file (which is gitignored and contains secrets).

**Verification:**
```bash
# Check InfluxDB variables in Python container
docker exec hunico-python sh -c 'echo INFLUX_HOST=$INFLUX_HOST'
docker exec hunico-python sh -c 'echo INFLUX_TOKEN=$INFLUX_TOKEN'
docker exec hunico-python sh -c 'echo INFLUX_BUCKET=$INFLUX_BUCKET'
```

## Quick Reference

```bash
# Check .env.production on VM
cat /home/racesight/racesight/.env.production | grep DB_NAME

# Check environment variable in container
docker exec hunico-node sh -c 'echo DB_NAME=$DB_NAME'

# Check InfluxDB configuration in Python container
docker exec hunico-python sh -c 'echo INFLUX_HOST=$INFLUX_HOST INFLUX_TOKEN=$INFLUX_TOKEN INFLUX_BUCKET=$INFLUX_BUCKET'

# Restart containers to load new env vars
cd /home/racesight/racesight
docker-compose -f docker-compose.yml down
docker-compose -f docker-compose.yml up -d

# View logs
docker logs hunico-node --tail=100
docker logs hunico-python --tail=100
```
