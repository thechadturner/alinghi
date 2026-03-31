/**
 * Optional socket family for node-pg → net.connect (see Pool config `family`).
 * Docker's host.docker.internal often resolves to IPv4 only via host-gateway; Node may try IPv6 first and hang until timeout.
 *
 * DB_PG_FAMILY: 4 | 6 | 0 | auto — empty defaults to IPv4 only when host is host.docker.internal.
 */
function pgSocketFamily(host, mergedEnv) {
  const e = mergedEnv || process.env;
  const raw = String(e.DB_PG_FAMILY || '').trim().toLowerCase();
  if (raw === '4') return 4;
  if (raw === '6') return 6;
  if (raw === '0' || raw === 'auto') return undefined;
  const h = String(host || '').toLowerCase();
  if (h === 'host.docker.internal') return 4;
  return undefined;
}

module.exports = { pgSocketFamily };
