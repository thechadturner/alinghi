/**
 * Check recent streaming logs from database
 */

const db = require('../../shared/database/connection');

async function checkLogs() {
  try {
    // Get recent StreamController logs
    const sql = `
      SELECT datetime, log_level, message 
      FROM admin.log_activity 
      WHERE (
        message LIKE '%StreamController%' 
        OR message LIKE '%streaming%' 
        OR message LIKE '%InfluxDB%' 
        OR message LIKE '%auto-discovery%' 
        OR message LIKE '%proactive%'
        OR message LIKE '%streamingStarted%'
        OR message LIKE '%influxDBStreamingEnabled%'
        OR message LIKE '%autoDiscoveryAttempted%'
        OR message LIKE '%Reset autoDiscoveryAttempted%'
        OR message LIKE '%Starting auto-discovery%'
        OR message LIKE '%Auto-discovery skipped%'
      )
      AND datetime > NOW() - INTERVAL '1 hour'
      ORDER BY datetime DESC 
      LIMIT 100
    `;
    
    const results = await db.getRows(sql, []) || [];
    
    console.log('='.repeat(80));
    console.log('Recent Streaming Logs (last 1 hour)');
    console.log('='.repeat(80));
    console.log('');
    
    if (!results || results.length === 0) {
      console.log('No recent logs found');
    } else {
      results.forEach((log) => {
        const time = new Date(log.datetime).toLocaleTimeString();
        const level = (log.log_level || 'info').toUpperCase().padEnd(6);
        const msg = (log.message || '').substring(0, 250);
        console.log(`[${time}] [${level}] ${msg}`);
      });
    }
    
    console.log('');
    console.log('='.repeat(80));
    console.log('Checking for errors...');
    console.log('='.repeat(80));
    console.log('');
    
    // Check for errors
    const errorSql = `
      SELECT datetime, log_level, message 
      FROM admin.log_activity 
      WHERE (
        (message LIKE '%Error%' OR message LIKE '%error%' OR message LIKE '%Failed%' OR message LIKE '%failed%')
        AND (message LIKE '%stream%' OR message LIKE '%Stream%' OR message LIKE '%Influx%')
      )
      AND datetime > NOW() - INTERVAL '1 hour'
      ORDER BY datetime DESC 
      LIMIT 20
    `;
    
    const errors = await db.getRows(errorSql, []) || [];
    
    if (!errors || errors.length === 0) {
      console.log('No errors found in last 10 minutes');
    } else {
      errors.forEach((log) => {
        const time = new Date(log.datetime).toLocaleTimeString();
        const level = (log.log_level || 'info').toUpperCase().padEnd(6);
        const msg = (log.message || '').substring(0, 300);
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
