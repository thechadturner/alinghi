#!/usr/bin/env bash
# Run on the VM after docker compose up:
#   - QUICK_RESTART_VM_SERVERS.bat uploads and runs this from /tmp
#   - verify-deployment.sh runs it from the repo path next to this file
# Checks: DATA_DIRECTORY / MEDIA_DIRECTORY mounts in hunico-node, GET /api/ready (Postgres + mounts) on :8069 and :8059,
#         nginx http://nginx:80/api/health then https://nginx:443/api/health from hunico-node (80 is proxied without redirect;
#         443 needs fullchain.pem + privkey.pem on the host ssl mount).

set -u

echo ""
echo "============================================"
echo "  Post-restart connectivity"
echo "============================================"

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx hunico-node; then
  echo "[ERROR] hunico-node is not running"
  exit 1
fi

echo ""
echo "[INFO] Data / media mounts (inside hunico-node)"
mount_fail=0
docker exec hunico-node sh -c '
  fail=0
  for pair in "DATA_DIRECTORY:${DATA_DIRECTORY}" "MEDIA_DIRECTORY:${MEDIA_DIRECTORY}"; do
    name="${pair%%:*}"
    dir="${pair#*:}"
    if [ -z "$dir" ]; then
      echo "  $name: <not set> (skipped)"
      continue
    fi
    if [ ! -e "$dir" ]; then
      echo "  $name: FAIL path does not exist: $dir"
      fail=1
      continue
    fi
    if [ ! -d "$dir" ]; then
      echo "  $name: FAIL not a directory: $dir"
      fail=1
      continue
    fi
    if [ ! -r "$dir" ] || [ ! -w "$dir" ]; then
      echo "  $name: FAIL not readable/writable: $dir"
      fail=1
      continue
    fi
    echo "  $name: OK $dir"
  done
  exit $fail
' || mount_fail=1

if [ "$mount_fail" -ne 0 ]; then
  echo "[ERROR] Data or media mount check failed"
  exit 1
fi

echo ""
echo "[INFO] Postgres + mounts via /api/ready (each port = separate Node process and DB pool):"
echo "       server_app :8069  server_admin :8059"
if ! docker exec hunico-node node -e "
const http = require('http');
function getReady(port) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + '/api/ready', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const proc = port === 8069 ? 'server_app' : 'server_admin';
        try {
          const j = JSON.parse(body);
          const summary = 'postgres=' + (j.postgres && j.postgres.ok ? 'ok' : 'fail') +
            ' data=' + (j.data && j.data.ok ? 'ok' : (j.data && j.data.skipped ? 'skip' : 'fail')) +
            ' media=' + (j.media && j.media.ok ? 'ok' : (j.media && j.media.skipped ? 'skip' : 'fail'));
          console.log(proc + ' :' + port + ' HTTP ' + res.statusCode + ' ' + summary);
          if (res.statusCode !== 200) console.log(body);
        } catch (e) {
          console.log(proc + ' :' + port + ' HTTP ' + res.statusCode + ' (non-JSON): ' + body.slice(0, 200));
        }
        if (res.statusCode !== 200) process.exitCode = 1;
        resolve();
      });
    }).on('error', reject);
  });
}
Promise.all([getReady(8069), getReady(8059)]).catch((e) => {
  console.error('ready check error:', e.message);
  process.exit(1);
});
"; then
  echo "[ERROR] One or more /api/ready checks failed (HTTP != 200 or connection error)"
  exit 1
fi

echo ""
echo "[INFO] Nginx: HTTP :80 then HTTPS :443 /api/health from hunico-node (matches browser TLS path on 443)"
nginx_ok=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec hunico-node node -e "
const http = require('http');
const https = require('https');
const hreq = http.request(
  { hostname: 'nginx', port: 80, path: '/api/health', method: 'GET' },
  (res) => {
    res.resume();
    if (res.statusCode !== 200) {
      console.error('nginx HTTP:80 /api/health ->', res.statusCode);
      process.exit(1);
      return;
    }
    const sreq = https.request(
      {
        hostname: 'nginx',
        port: 443,
        path: '/api/health',
        method: 'GET',
        rejectUnauthorized: false,
        servername: 'localhost',
      },
      (sres) => {
        sres.resume();
        if (sres.statusCode !== 200) {
          console.error('nginx HTTPS:443 /api/health ->', sres.statusCode);
          process.exit(1);
          return;
        }
        process.exit(0);
      }
    );
    sreq.setTimeout(8000, () => { sreq.destroy(); process.exit(1); });
    sreq.on('error', (e) => { console.error('nginx HTTPS:', e.message); process.exit(1); });
    sreq.end();
  }
);
hreq.setTimeout(8000, () => { hreq.destroy(); process.exit(1); });
hreq.on('error', (e) => { console.error('nginx HTTP:80:', e.message); process.exit(1); });
hreq.end();
"; then
    echo "  OK: /api/health via nginx :80 and :443"
    nginx_ok=1
    break
  fi
  if [ "$attempt" -eq 10 ]; then
    break
  fi
  echo "  ... waiting for nginx, attempt $attempt/10 ..."
  sleep 3
done
if [ "$nginx_ok" -ne 1 ]; then
  echo "[ERROR] Nginx probe failed. If HTTP:80 fails: nginx or network. If HTTPS fails: missing or wrong files — fullchain.pem and privkey.pem under ssl/ (see docker/nginx/ssl/INTERNAL_SSL.txt)."
  exit 1
fi

echo ""
echo "[SUCCESS] Connectivity checks passed"
exit 0
