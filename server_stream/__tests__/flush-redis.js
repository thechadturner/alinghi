/**
 * Script to flush Redis database
 */

const redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_DB = process.env.REDIS_DB || 0;

async function flushRedis() {
  const client = new redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    db: REDIS_DB,
    retryStrategy: (times) => {
      if (times > 3) {
        console.error('❌ Failed to connect to Redis after 3 retries');
        process.exit(1);
      }
      return Math.min(times * 50, 2000);
    }
  });

  try {
    console.log(`\n🗑️  Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT} (DB ${REDIS_DB})...`);
    
    await client.ping();
    console.log('✅ Connected to Redis');
    
    // Get count of keys before flush
    const keysBefore = await client.keys('*');
    console.log(`\n📊 Found ${keysBefore.length} keys before flush`);
    
    if (keysBefore.length > 0) {
      // Show some sample keys
      console.log('\n   Sample keys:');
      keysBefore.slice(0, 10).forEach((key, idx) => {
        console.log(`   ${idx + 1}. ${key}`);
      });
      if (keysBefore.length > 10) {
        console.log(`   ... and ${keysBefore.length - 10} more`);
      }
    }
    
    console.log('\n🗑️  Flushing Redis database...');
    await client.flushdb();
    console.log('✅ Redis database flushed successfully');
    
    // Verify flush
    const keysAfter = await client.keys('*');
    console.log(`\n📊 Keys after flush: ${keysAfter.length}`);
    
    if (keysAfter.length === 0) {
      console.log('✅ Redis database is now empty');
    } else {
      console.log('⚠️  Warning: Some keys still exist after flush');
    }
    
    await client.quit();
    console.log('\n✅ Disconnected from Redis');
    console.log('\n✅ Done! Redis has been flushed.');
    
  } catch (err) {
    console.error('\n❌ Error flushing Redis:', err.message);
    await client.quit();
    process.exit(1);
  }
}

flushRedis().catch(console.error);

