/**
 * Check for discovery and connection logs
 */

const db = require('../../shared/database/connection');

async function checkLogs() {
  try {
    const sql = `
      SELECT datetime, log_level, message 
      FROM admin.log_activity 
      WHERE (
        message LIKE '%Proactive discovery state%' 
        OR message LIKE '%Reset autoDiscoveryAttempted%' 
        OR message LIKE '%Starting auto-discovery%' 
        OR message LIKE '%Attempting auto-discovery%' 
        OR message LIKE '%InfluxDB config:%' 
        OR message LIKE '%InfluxDB 2.x is available%' 
        OR message LIKE '%Discovered%' 
        OR message LIKE '%Auto-connected%'
        OR message LIKE '%InfluxDB environment variables not set%'
        OR message LIKE '%InfluxDB 2.x health check failed%'
        OR message LIKE '%No sources found%'
        OR message LIKE '%Starting recent data check%'
        OR message LIKE '%Starting source discovery%'
        OR message LIKE '%Starting InfluxDB health check%'
        OR message LIKE '%Recent data check failed%'
        OR message LIKE '%Source discovery failed%'
        OR message LIKE '%Recent data check (last 30 seconds)%'
      )
      AND datetime > NOW() - INTERVAL '5 minutes'
      ORDER BY datetime DESC 
      LIMIT 50
    `;
    
    const results = await db.getRows(sql, []) || [];
    
    console.log('='.repeat(80));
    console.log('Discovery and Connection Logs (last 30 minutes)');
    console.log('='.repeat(80));
    console.log('');
    
    if (!results || results.length === 0) {
      console.log('No discovery/connection logs found in last 30 minutes');
      console.log('');
      console.log('This could mean:');
      console.log('  1. Server has not been restarted with the new code');
      console.log('  2. Proactive discovery is returning early (check state logs)');
      console.log('  3. Auto-discovery is not being called');
    } else {
      results.forEach((log) => {
        const time = new Date(log.datetime).toLocaleTimeString();
        const level = (log.log_level || 'info').toUpperCase().padEnd(6);
        const msg = (log.message || '').substring(0, 400);
        console.log(`[${time}] [${level}] ${msg}`);
      });
    }
    
  } catch (err) {
    console.error('Error checking logs:', err.message);
    console.error(err.stack);
  } finally {
    process.exit();
  }
}

checkLogs();
