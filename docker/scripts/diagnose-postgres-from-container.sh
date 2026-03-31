#!/usr/bin/env bash
# Run on the Docker host (e.g. the VM), with hunico-node up:
#   bash docker/scripts/diagnose-postgres-from-container.sh
#
# Helps when /api/ready shows: postgres fail — "Connection terminated due to connection timeout"

set -u

echo "============================================"
echo "  Postgres from hunico-node (diagnostic)"
echo "============================================"
echo

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx hunico-node; then
  echo "[ERROR] hunico-node is not running"
  exit 1
fi

docker exec hunico-node sh -c '
  echo "--- Env (no secrets) ---"
  echo "DB_HOST=${DB_HOST:-<unset>}"
  echo "DB_PORT=${DB_PORT:-5432}"
  echo "DB_NAME=${DB_NAME:-<unset>}"
  echo "DB_USER=${DB_USER:-<unset>}"
  echo "DB_SSL=${DB_SSL:-<unset>}"
  echo
  H="${DB_HOST:?DB_HOST unset}"
  P="${DB_PORT:-5432}"
  echo "--- Resolve DB_HOST ---"
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$H" 2>&1 || echo "(getent failed — try: apt install libc-bin)"
  else
    echo "(no getent)"
  fi
  echo
  echo "--- TCP to ${H}:${P} (2s) ---"
  if command -v nc >/dev/null 2>&1; then
    if nc -zvw2 "$H" "$P" 2>&1; then
      echo "Result: port appears open from container"
    else
      echo "Result: NOT reachable — fix host listen_addresses, pg_hba, firewall, or DB_HOST"
    fi
  elif command -v bash >/dev/null 2>&1; then
    if timeout 2 bash -c "echo >/dev/tcp/${H}/${P}" 2>/dev/null; then
      echo "Result: bash /dev/tcp connect ok"
    else
      echo "Result: bash /dev/tcp failed (host must resolve; Postgres must accept TCP)"
    fi
  else
    echo "Trying Node net.connect (no nc/bash tcp)..."
    node -e "const n=require(\"net\");const s=n.connect({host:process.env.DB_HOST,port:+process.env.DB_PORT||5432},()=>{console.log(\"Result: TCP OK\");process.exit(0)});s.on(\"error\",e=>{console.log(\"Result: TCP FAIL\",e.message);process.exit(1)});setTimeout(()=>{console.log(\"Result: TCP timeout\");process.exit(1)},8000);"
  fi
'

echo
echo "On the VM host (run these on the host, not inside Docker):"
echo "  1) sudo ss -tlnp | grep 5432"
echo "     If you see ONLY 127.0.0.1:5432 — Postgres rejects Docker traffic."
echo "     Fix: postgresql.conf → listen_addresses = '*'  (or at least the docker bridge IP)"
echo "     Then: sudo systemctl reload postgresql   (or SELECT pg_reload_conf();)"
echo "  2) pg_hba.conf — add e.g.:"
echo "     host  all  all  172.16.0.0/12  scram-sha-256"
echo "     (use md5 instead of scram-sha-256 if your cluster still uses md5 passwords)"
echo "  3) sudo ufw status — allow 5432/tcp from Docker if ufw is active"
echo "  4) DB_HOST=host.docker.internal needs compose extra_hosts: host.docker.internal:host-gateway"
echo
