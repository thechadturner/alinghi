const Redis = require('ioredis');
const config = require('../middleware/config');

/**
 * Script to view data from a specific source in Redis
 * Usage: node view_redis_source.js [source_name] [options]
 * 
 * Examples:
 *   node view_redis_source.js NZL
 *   node view_redis_source.js NZL --limit 10
 *   node view_redis_source.js NZL --time-range 1h
 *   node view_redis_source.js NZL --latest
 *   node view_redis_source.js NZL --channels Lat,Lng,Twa,Tws
 */

// Parse command line arguments
const args = process.argv.slice(2);
const sourceName = args[0]?.toUpperCase().trim();

if (!sourceName) {
  console.error('Usage: node view_redis_source.js <source_name> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --limit <n>           Show only first N data points (default: 20)');
  console.error('  --latest              Show only the latest data point');
  console.error('  --time-range <range>  Show data within time range (e.g., 1h, 30m, 2h)');
  console.error('  --channels <list>     Show only specific channels (comma-separated)');
  console.error('  --all                 Show all data points (use with caution for large datasets)');
  console.error('  --metadata            Show metadata for the source');
  console.error('');
  console.error('Examples:');
  console.error('  node view_redis_source.js NZL');
  console.error('  node view_redis_source.js NZL --limit 10');
  console.error('  node view_redis_source.js NZL --latest');
  console.error('  node view_redis_source.js NZL --time-range 1h');
  console.error('  node view_redis_source.js NZL --channels Lat,Lng,Twa');
  process.exit(1);
}

// Parse options
const options = {
  limit: 20,
  latest: false,
  timeRange: null,
  channels: null,
  showAll: false,
  showMetadata: false
};

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (arg === '--latest') {
    options.latest = true;
  } else if (arg === '--time-range' && args[i + 1]) {
    options.timeRange = args[i + 1];
    i++;
  } else if (arg === '--channels' && args[i + 1]) {
    options.channels = args[i + 1].split(',').map(c => c.trim());
    i++;
  } else if (arg === '--all') {
    options.showAll = true;
  } else if (arg === '--metadata') {
    options.showMetadata = true;
  }
}

// Parse time range (e.g., "1h", "30m", "2h")
function parseTimeRange(rangeStr) {
  const match = rangeStr.match(/^(\d+)([hm])$/i);
  if (!match) {
    throw new Error(`Invalid time range format: ${rangeStr}. Use format like "1h" or "30m"`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = Date.now();
  
  if (unit === 'h') {
    return now - (value * 60 * 60 * 1000);
  } else if (unit === 'm') {
    return now - (value * 60 * 1000);
  }
  throw new Error(`Unknown time unit: ${unit}. Use 'h' for hours or 'm' for minutes.`);
}

async function viewSourceData() {
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
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      client.on('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    console.log('Connected to Redis!\n');

    // Normalize source name (uppercase, trimmed)
    const normalizedSourceName = sourceName.toUpperCase().trim();
    const key = `stream:${normalizedSourceName}`;

    // Check if key exists
    const exists = await client.exists(key);
    if (!exists) {
      console.log(`❌ No data found for source "${normalizedSourceName}"`);
      console.log(`   Key "${key}" does not exist in Redis.`);
      console.log('\nAvailable sources:');
      const allKeys = await client.keys('stream:*');
      if (allKeys.length === 0) {
        console.log('   (No sources found in Redis)');
      } else {
        const sources = allKeys.map(k => k.replace('stream:', '')).sort();
        sources.forEach(s => console.log(`   - ${s}`));
      }
      await client.quit();
      return;
    }

    // Check key type
    const keyType = await client.type(key);
    if (keyType !== 'zset') {
      console.log(`❌ Key "${key}" exists but is not a sorted set (type: ${keyType})`);
      await client.quit();
      return;
    }

    // Get total count
    const totalCount = await client.zcard(key);
    console.log(`${'='.repeat(80)}`);
    console.log(`Source: ${normalizedSourceName}`);
    console.log(`Key: ${key}`);
    console.log(`Total data points: ${totalCount}`);
    console.log(`${'='.repeat(80)}\n`);

    if (totalCount === 0) {
      console.log('No data points found.');
      await client.quit();
      return;
    }

    // Show metadata if requested
    if (options.showMetadata) {
      const metaKey = `${key}:meta`;
      const metaExists = await client.exists(metaKey);
      if (metaExists) {
        const metaType = await client.type(metaKey);
        if (metaType === 'hash') {
          const metadata = await client.hgetall(metaKey);
          console.log('Metadata:');
          Object.entries(metadata).forEach(([k, v]) => {
            if (k.includes('timestamp') || k.includes('update')) {
              const ts = parseFloat(v);
              if (!isNaN(ts)) {
                console.log(`  ${k}: ${v} (${new Date(ts).toISOString()})`);
              } else {
                console.log(`  ${k}: ${v}`);
              }
            } else {
              console.log(`  ${k}: ${v}`);
            }
          });
          console.log('');
        }
      } else {
        console.log('No metadata found.\n');
      }
    }

    // Get earliest and latest timestamps
    const earliestResults = await client.zrange(key, 0, 0, 'WITHSCORES');
    const latestResults = await client.zrange(key, -1, -1, 'WITHSCORES');
    
    const earliestTimestamp = earliestResults.length >= 2 ? parseFloat(earliestResults[1]) : null;
    const latestTimestamp = latestResults.length >= 2 ? parseFloat(latestResults[1]) : null;

    if (earliestTimestamp && latestTimestamp) {
      const timeDiff = latestTimestamp - earliestTimestamp;
      const timeDiffSeconds = timeDiff / 1000;
      const timeDiffMinutes = timeDiffSeconds / 60;
      const timeDiffHours = timeDiffMinutes / 60;
      
      console.log('Time Range:');
      console.log(`  Earliest: ${new Date(earliestTimestamp).toISOString()} (${earliestTimestamp})`);
      console.log(`  Latest:   ${new Date(latestTimestamp).toISOString()} (${latestTimestamp})`);
      console.log(`  Span:     ${timeDiffHours.toFixed(2)} hours (${timeDiffMinutes.toFixed(2)} minutes)`);
      
      const now = Date.now();
      const age = now - latestTimestamp;
      const ageSeconds = age / 1000;
      const ageMinutes = ageSeconds / 60;
      console.log(`  Latest data age: ${ageSeconds.toFixed(1)}s (${ageMinutes.toFixed(2)}min)`);
      console.log('');
    }

    // Determine query range
    let minScore = '-inf';
    let maxScore = '+inf';
    let limit = options.limit;

    if (options.latest) {
      // Get only the latest entry
      limit = 1;
      maxScore = '+inf';
    } else if (options.timeRange) {
      // Parse time range
      const minTimestamp = parseTimeRange(options.timeRange);
      minScore = minTimestamp;
      maxScore = '+inf';
      console.log(`Filtering data from last ${options.timeRange} (since ${new Date(minScore).toISOString()})...\n`);
    } else if (options.showAll) {
      limit = totalCount;
      console.log(`Showing all ${totalCount} data points...\n`);
    } else {
      console.log(`Showing first ${limit} data points...\n`);
    }

    // Query data
    const results = await client.zrangebyscore(key, minScore, maxScore, 'WITHSCORES', 'LIMIT', 0, limit);
    
    if (results.length === 0) {
      console.log('No data points found matching the criteria.');
      await client.quit();
      return;
    }

    // Collect all unique channels across all data points
    const allChannels = new Set();
    const dataPoints = [];
    
    for (let i = 0; i < results.length; i += 2) {
      const jsonStr = results[i];
      const timestamp = parseFloat(results[i + 1]);
      
      try {
        const data = JSON.parse(jsonStr);
        dataPoints.push({ timestamp, data });
        
        // Collect channels
        Object.keys(data).forEach(channel => {
          if (channel !== 'timestamp') {
            allChannels.add(channel);
          }
        });
      } catch (e) {
        console.warn(`Warning: Failed to parse JSON at timestamp ${timestamp}:`, e.message);
      }
    }

    // Filter channels if requested
    const channelsToShow = options.channels 
      ? options.channels.filter(c => allChannels.has(c))
      : Array.from(allChannels).sort();

    if (options.channels && options.channels.length > 0) {
      const missingChannels = options.channels.filter(c => !allChannels.has(c));
      if (missingChannels.length > 0) {
        console.log(`⚠️  Warning: Requested channels not found: ${missingChannels.join(', ')}\n`);
      }
    }

    // Display data
    console.log(`Data Points (${dataPoints.length} shown):`);
    console.log(`${'='.repeat(80)}`);
    
    dataPoints.forEach((point, index) => {
      const dateStr = new Date(point.timestamp).toISOString();
      console.log(`\n[${index + 1}] ${dateStr} (${point.timestamp})`);
      console.log('-'.repeat(80));
      
      if (channelsToShow.length === 0) {
        console.log('  (No channels found)');
      } else {
        channelsToShow.forEach(channel => {
          const value = point.data[channel];
          if (value !== undefined) {
            // Format value nicely
            let displayValue = value;
            if (typeof value === 'number') {
              displayValue = Number.isInteger(value) ? value : value.toFixed(4);
            } else if (typeof value === 'string') {
              displayValue = value;
            } else {
              displayValue = JSON.stringify(value);
            }
            console.log(`  ${channel.padEnd(20)}: ${displayValue}`);
          }
        });
      }
    });

    console.log(`\n${'='.repeat(80)}`);
    console.log(`Summary:`);
    console.log(`  Total data points in Redis: ${totalCount}`);
    console.log(`  Data points shown: ${dataPoints.length}`);
    console.log(`  Channels found: ${allChannels.size}`);
    console.log(`  Channels displayed: ${channelsToShow.length}`);
    
    if (dataPoints.length < totalCount && !options.showAll && !options.latest) {
      console.log(`\n💡 Tip: Use --all to show all data points, or --limit <n> to show more`);
    }

    await client.quit();
    console.log('\n✅ Query complete!');
    
  } catch (err) {
    console.error('\n❌ Error querying Redis:', err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    await client.quit();
    process.exit(1);
  }
}

// Run the script
viewSourceData();
