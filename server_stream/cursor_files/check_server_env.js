/**
 * Check what environment variables the server process can see
 * This simulates what the server sees when it starts
 */

const config = require('../middleware/config');

console.log('='.repeat(80));
console.log('Server Environment Variables Check');
console.log('='.repeat(80));
console.log('');

console.log('From config module (loaded from .env files):');
console.log(`  INFLUX_HOST: ${config.INFLUX_HOST ? '✓ SET' : '✗ NOT SET'}`);
console.log(`  INFLUX_TOKEN: ${config.INFLUX_TOKEN ? '✓ SET (' + config.INFLUX_TOKEN.slice(0, 4) + '...)' : '✗ NOT SET'}`);
console.log(`  INFLUX_DATABASE: ${config.INFLUX_DATABASE ? '✓ SET (' + config.INFLUX_DATABASE + ')' : '✗ NOT SET'}`);
console.log(`  INFLUX_BUCKET: ${config.INFLUX_BUCKET ? '✓ SET (' + config.INFLUX_BUCKET + ')' : '✗ NOT SET'}`);
console.log('');

console.log('From process.env (system/Docker environment):');
console.log(`  INFLUX_HOST: ${process.env.INFLUX_HOST ? '✓ SET' : '✗ NOT SET'}`);
console.log(`  INFLUX_TOKEN: ${process.env.INFLUX_TOKEN ? '✓ SET (' + process.env.INFLUX_TOKEN.slice(0, 4) + '...)' : '✗ NOT SET'}`);
console.log(`  INFLUX_DATABASE: ${process.env.INFLUX_DATABASE ? '✓ SET (' + process.env.INFLUX_DATABASE + ')' : '✗ NOT SET'}`);
console.log(`  INFLUX_BUCKET: ${process.env.INFLUX_BUCKET ? '✓ SET (' + process.env.INFLUX_BUCKET + ')' : '✗ NOT SET'}`);
console.log('');

// Check what the server will actually use
// The stream.js controller uses process.env directly, not config
const influxHost = process.env.INFLUX_HOST;
const influxToken = process.env.INFLUX_TOKEN;
const influxDatabase = process.env.INFLUX_DATABASE;
const influxBucket = process.env.INFLUX_BUCKET;

console.log('='.repeat(80));
console.log('What the server will use (from process.env):');
console.log('='.repeat(80));
console.log(`  INFLUX_HOST: ${influxHost || 'NOT SET'}`);
console.log(`  INFLUX_TOKEN: ${influxToken ? influxToken.slice(0, 4) + '...' : 'NOT SET'}`);
console.log(`  INFLUX_DATABASE: ${influxDatabase || 'NOT SET'}`);
console.log(`  INFLUX_BUCKET: ${influxBucket || 'NOT SET'}`);
console.log('');

if (!influxHost || !influxToken || !influxDatabase || !influxBucket) {
  console.log('❌ PROBLEM: Server will NOT be able to connect to InfluxDB!');
  console.log('');
  console.log('The server uses process.env directly, not the config module.');
  console.log('You need to either:');
  console.log('  1. Set environment variables in the shell before starting the server');
  console.log('  2. Ensure .env files exist and are loaded (check server startup)');
  console.log('  3. Use Docker environment variables if running in Docker');
  console.log('');
  console.log('To fix:');
  console.log('  - Create .env or .env.local in the project root with:');
  console.log('    INFLUX_HOST=your-host');
  console.log('    INFLUX_TOKEN=your-token');
  console.log('    INFLUX_DATABASE=your-org');
  console.log('    INFLUX_BUCKET=your-bucket');
  console.log('  - OR set them as system environment variables');
  console.log('  - OR restart the server after creating .env files');
} else {
  console.log('✓ All required environment variables are set!');
  console.log('  The server should be able to connect to InfluxDB.');
}
