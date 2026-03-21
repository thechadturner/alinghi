const Redis = require('ioredis');
const config = require('../middleware/config');

/**
 * Script to manually query Redis and check actual data
 */
async function checkRedisData() {
  const redisConfig = {
    host: config.REDIS_HOST || 'localhost',
    port: config.REDIS_PORT || 6379,
    password: config.REDIS_PASSWORD || undefined,
    db: config.REDIS_DB || 0
  };

  console.log(`Connecting to Redis at ${redisConfig.host}:${redisConfig.port}...`);
  
  const client = new Redis(redisConfig);

  try {
    // Wait for connection
    await new Promise((resolve, reject) => {
      client.on('ready', resolve);
      client.on('error', reject);
    });

    console.log('Connected to Redis!\n');

    // Get all keys matching the stream pattern
    const keys = await client.keys('stream:*');
    
    if (keys.length === 0) {
      console.log('No sources found in Redis (no keys matching "stream:*")');
      await client.quit();
      return;
    }

    console.log(`Found ${keys.length} source(s) in Redis:\n`);

    for (const key of keys) {
      const sourceName = key.replace('stream:', '');
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Source: ${sourceName}`);
      console.log(`${'='.repeat(80)}`);

      // Check key type first
      const keyType = await client.type(key);
      if (keyType !== 'zset') {
        console.log(`  Skipping: Key type is "${keyType}", expected "zset"`);
        continue;
      }

      // Get total count
      const count = await client.zcard(key);
      console.log(`Total data points: ${count}`);

      if (count === 0) {
        console.log('  No data points found');
        continue;
      }

      // Get earliest (first) entry
      const earliestResults = await client.zrange(key, 0, 0, 'WITHSCORES');
      let earliestTimestamp = null;
      let earliestData = null;
      
      if (earliestResults.length >= 2) {
        earliestTimestamp = parseFloat(earliestResults[1]);
        try {
          earliestData = JSON.parse(earliestResults[0]);
        } catch (e) {
          earliestData = earliestResults[0];
        }
      }

      // Get latest (last) entry
      const latestResults = await client.zrange(key, -1, -1, 'WITHSCORES');
      let latestTimestamp = null;
      let latestData = null;
      
      if (latestResults.length >= 2) {
        latestTimestamp = parseFloat(latestResults[1]);
        try {
          latestData = JSON.parse(latestResults[0]);
        } catch (e) {
          latestData = latestResults[0];
        }
      }

      console.log(`\nEarliest Entry:`);
      if (earliestTimestamp) {
        console.log(`  Timestamp: ${earliestTimestamp} (${new Date(earliestTimestamp).toISOString()})`);
        console.log(`  Data keys: ${earliestData && typeof earliestData === 'object' ? Object.keys(earliestData).join(', ') : 'N/A'}`);
      } else {
        console.log(`  Not found`);
      }

      console.log(`\nLatest Entry:`);
      if (latestTimestamp) {
        console.log(`  Timestamp: ${latestTimestamp} (${new Date(latestTimestamp).toISOString()})`);
        console.log(`  Data keys: ${latestData && typeof latestData === 'object' ? Object.keys(latestData).join(', ') : 'N/A'}`);
      } else {
        console.log(`  Not found`);
      }

      if (earliestTimestamp && latestTimestamp) {
        const timeDiff = latestTimestamp - earliestTimestamp;
        const timeDiffSeconds = timeDiff / 1000;
        const timeDiffMinutes = timeDiffSeconds / 60;
        const timeDiffHours = timeDiffMinutes / 60;
        
        console.log(`\nTime Range:`);
        console.log(`  Difference: ${timeDiff}ms (${timeDiffSeconds.toFixed(2)}s, ${timeDiffMinutes.toFixed(2)}min, ${timeDiffHours.toFixed(2)}hrs)`);
        
        if (earliestTimestamp === latestTimestamp) {
          console.log(`  ⚠️  WARNING: Earliest and latest timestamps are IDENTICAL!`);
        }
      }

      // Get a few sample entries to see the data
      if (count > 0) {
        console.log(`\nSample Entries (first 3 and last 3):`);
        
        // First 3
        const firstFew = await client.zrange(key, 0, Math.min(2, count - 1), 'WITHSCORES');
        console.log(`  First entries:`);
        for (let i = 0; i < firstFew.length; i += 2) {
          const timestamp = parseFloat(firstFew[i + 1]);
          console.log(`    [${i / 2}] ${new Date(timestamp).toISOString()} (${timestamp})`);
        }

        // Last 3
        const lastFew = await client.zrange(key, Math.max(-3, -count), -1, 'WITHSCORES');
        console.log(`  Last entries:`);
        for (let i = 0; i < lastFew.length; i += 2) {
          const timestamp = parseFloat(lastFew[i + 1]);
          console.log(`    [${count - (lastFew.length / 2) + (i / 2)}] ${new Date(timestamp).toISOString()} (${timestamp})`);
        }
      }

      // Check current time vs latest
      const now = Date.now();
      if (latestTimestamp) {
        const age = now - latestTimestamp;
        const ageSeconds = age / 1000;
        const ageMinutes = ageSeconds / 60;
        console.log(`\nLatest Data Age:`);
        console.log(`  Current time: ${new Date(now).toISOString()}`);
        console.log(`  Latest data: ${new Date(latestTimestamp).toISOString()}`);
        console.log(`  Age: ${ageSeconds.toFixed(2)}s (${ageMinutes.toFixed(2)}min)`);
      }
    }

    await client.quit();
    console.log(`\n${'='.repeat(80)}`);
    console.log('Query complete!');
    
  } catch (err) {
    console.error('Error querying Redis:', err.message);
    console.error(err.stack);
    await client.quit();
    process.exit(1);
  }
}

// Run the check
checkRedisData();

