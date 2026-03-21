/**
 * End-to-end integration test: InfluxDB data → Processor → Redis → Verification
 * Tests that data flows correctly and normalized channel names are stored
 * 
 * Run with: npm test -- processor-to-redis
 */

const processor = require('../../controllers/processor');
const redisStorage = require('../../controllers/redis');
const { log, error } = require('../../../shared');

describe('Processor to Redis Integration Test', () => {
  const testSourceId = 999; // Use a test source ID
  let redisConnected = false;

  beforeAll(async () => {
    // Connect to Redis
    try {
      redisConnected = await redisStorage.connect();
      if (!redisConnected) {
        throw new Error('Failed to connect to Redis');
      }
      log('[Test] Connected to Redis');
    } catch (err) {
      error('[Test] Failed to connect to Redis:', err.message);
      throw err;
    }
  });

  afterAll(async () => {
    // Clean up: Remove test data from Redis
    try {
      // Test data is stored under source_name 'TEST'
      const channels = await redisStorage.getChannels('TEST');
      if (channels.length > 0) {
        log(`[Test] Cleaning up ${channels.length} test channels from Redis`);
        // Redis will auto-clean based on retention, but we can manually delete keys
        // For now, just log - retention policy will handle it
      }
    } catch (err) {
      error('[Test] Error during cleanup:', err.message);
    }
  });

  beforeEach(() => {
    // Clear processor state for test source
    processor.clearState(testSourceId);
  });

  test('should normalize channel names and store in Redis', async () => {
    // Simulate InfluxDB data point (lowercase channel names)
    const influxDataPoint = {
      source_id: testSourceId,
      timestamp: Date.now(),
      data: {
        source: 'TEST',
        source_name: 'TEST',
        lat: 39.123456,
        lng: 9.123456,
        hdg: 180.5,
        cog: 181.2,
        sog: 12.5,
        cwa: 45.0,
        twa: 30.0,
        bsp: 15.3,
        tws: 20.0,
        twd: 180.0,
        accel: 0.5,
        ang_rate: 2.3,
        custom_field: 'test_value',
        another_custom: 123
      }
    };

    // Step 1: Process data through processor
    log('[Test] Step 1: Processing InfluxDB data point...');
    const processed = processor.process(influxDataPoint);
    
    expect(processed).not.toBeNull();
    expect(processed.source_id).toBe(testSourceId);
    expect(processed.timestamp).toBe(influxDataPoint.timestamp);
    expect(processed.data).toBeDefined();

    // Step 2: Verify processor normalized channel names
    log('[Test] Step 2: Verifying normalized channel names...');
    const processedData = processed.data;
    
    // Should have normalized names
    expect(processedData.Lat).toBe(influxDataPoint.data.lat);
    expect(processedData.Lng).toBe(influxDataPoint.data.lng);
    expect(processedData.Hdg).toBe(influxDataPoint.data.hdg);
    expect(processedData.Cog).toBe(influxDataPoint.data.cog);
    expect(processedData.Sog).toBe(influxDataPoint.data.sog);
    expect(processedData.Cwa).toBe(influxDataPoint.data.cwa);
    expect(processedData.Twa).toBe(influxDataPoint.data.twa);
    expect(processedData.Bsp).toBe(influxDataPoint.data.bsp);
    expect(processedData.Tws).toBe(influxDataPoint.data.tws);
    expect(processedData.Twd).toBe(influxDataPoint.data.twd);
    expect(processedData.Accel_rate_mps2).toBe(influxDataPoint.data.accel);
    expect(processedData.Yaw_rate_dps).toBe(influxDataPoint.data.ang_rate);
    
    // Should NOT have lowercase duplicates
    expect(processedData.lat).toBeUndefined();
    expect(processedData.lng).toBeUndefined();
    expect(processedData.hdg).toBeUndefined();
    expect(processedData.cog).toBeUndefined();
    expect(processedData.sog).toBeUndefined();
    
    // Custom fields should be preserved as-is
    expect(processedData.custom_field).toBe('test_value');
    expect(processedData.another_custom).toBe(123);
    
    // Should have computed channels
    expect(processedData.TACK).toBeDefined();
    expect(processedData.POINTOFSAIL).toBeDefined();
    expect(processedData.MANEUVER_TYPE).toBeDefined();

    // Step 3: Extract source_name from processed data
    const source_name = processedData.source_name;
    expect(source_name).toBeDefined();
    expect(typeof source_name).toBe('string');
    log(`[Test] Source name: ${source_name}`);
    
    // Step 4: Store processed data in Redis (simulating stream.js behavior)
    log('[Test] Step 4: Storing processed data in Redis...');
    const channelsToStore = Object.keys(processedData).filter(k => k !== 'timestamp' && k !== 'Datetime');
    
    let storedCount = 0;
    let errorCount = 0;
    
    for (const channel of channelsToStore) {
      const value = processedData[channel];
      
      if (value !== undefined && value !== null) {
        try {
          await redisStorage.store(source_name, channel, processed.timestamp, value);
          storedCount++;
        } catch (err) {
          errorCount++;
          error(`[Test] Error storing channel ${channel}:`, err.message);
        }
      }
    }
    
    expect(errorCount).toBe(0);
    expect(storedCount).toBeGreaterThan(0);
    log(`[Test] Stored ${storedCount} channels to Redis`);
    
    // Wait a bit for data to be flushed
    await new Promise(resolve => setTimeout(resolve, 200));

    // Step 5: Retrieve channels from Redis
    log('[Test] Step 5: Retrieving channels from Redis...');
    const storedChannels = await redisStorage.getChannels(source_name);
    
    expect(storedChannels.length).toBeGreaterThan(0);
    log(`[Test] Found ${storedChannels.length} channels in Redis`);

    // Step 6: Verify normalized channel names are in Redis
    log('[Test] Step 6: Verifying normalized channel names in Redis...');
    const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa', 'Twa', 'Bsp', 'Tws', 'Twd', 'Accel_rate_mps2', 'Yaw_rate_dps'];
    const lowercaseChannels = ['lat', 'lng', 'hdg', 'cog', 'sog', 'cwa', 'twa', 'bsp', 'tws', 'twd'];
    
    // Check normalized channels exist
    for (const channel of normalizedChannels) {
      expect(storedChannels).toContain(channel);
    }
    
    // Check lowercase channels do NOT exist
    for (const channel of lowercaseChannels) {
      expect(storedChannels).not.toContain(channel);
    }
    
    // Check computed channels exist
    expect(storedChannels).toContain('TACK');
    expect(storedChannels).toContain('POINTOFSAIL');
    expect(storedChannels).toContain('MANEUVER_TYPE');
    
    // Check custom fields are preserved
    expect(storedChannels).toContain('custom_field');
    expect(storedChannels).toContain('another_custom');

    // Step 7: Retrieve actual data from Redis and verify values
    log('[Test] Step 7: Retrieving data from Redis and verifying values...');
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Test a few key channels
    const testChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa'];
    
    for (const channel of testChannels) {
      const dataPoints = await redisStorage.query(source_name, channel, oneHourAgo, now);
      
      expect(dataPoints.length).toBeGreaterThan(0);
      
      // Find our test data point
      const testPoint = dataPoints.find(p => p.timestamp === processed.timestamp);
      expect(testPoint).toBeDefined();
      
      // Verify value matches
      const expectedValue = processedData[channel];
      expect(testPoint.value).toBe(expectedValue);
      
      log(`[Test] ✅ Channel ${channel}: value ${testPoint.value} matches expected ${expectedValue}`);
    }
  }, 30000); // 30 second timeout

  test('should handle multiple data points with state machine', async () => {
    const baseTime = Date.now();
    
    // First data point: CWA negative (port tack)
    const point1 = {
      source_id: testSourceId,
      timestamp: baseTime,
      data: { 
        source_name: 'TEST',
        cwa: -30 
      }
    };
    
    const processed1 = processor.process(point1);
    expect(processed1).not.toBeNull();
    expect(processed1.data.TACK).toBe('port');
    const source_name1 = processed1.data.source_name;
    expect(source_name1).toBeDefined();
    
    // Store in Redis
    await redisStorage.store(source_name1, 'Cwa', processed1.timestamp, processed1.data.Cwa);
    await redisStorage.store(source_name1, 'TACK', processed1.timestamp, processed1.data.TACK);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Second data point: CWA positive (stbd tack) - should detect tack
    const point2 = {
      source_id: testSourceId,
      timestamp: baseTime + 1000,
      data: { 
        source_name: 'TEST',
        cwa: 30 
      }
    };
    
    const processed2 = processor.process(point2);
    expect(processed2).not.toBeNull();
    expect(processed2.data.TACK).toBe('stbd');
    expect(processed2.data.MANEUVER_TYPE).toBe('T'); // Tack detected
    const source_name2 = processed2.data.source_name;
    expect(source_name2).toBeDefined();
    
    // Store in Redis
    await redisStorage.store(source_name2, 'Cwa', processed2.timestamp, processed2.data.Cwa);
    await redisStorage.store(source_name2, 'TACK', processed2.timestamp, processed2.data.TACK);
    await redisStorage.store(source_name2, 'MANEUVER_TYPE', processed2.timestamp, processed2.data.MANEUVER_TYPE);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify in Redis
    const channels = await redisStorage.getChannels(source_name1);
    expect(channels).toContain('Cwa');
    expect(channels).toContain('TACK');
    expect(channels).toContain('MANEUVER_TYPE');
    
    // Verify values
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const cwaData = await redisStorage.query(source_name1, 'Cwa', oneHourAgo, now);
    expect(cwaData.length).toBeGreaterThanOrEqual(2);
    
    const tackData = await redisStorage.query(source_name1, 'TACK', oneHourAgo, now);
    expect(tackData.length).toBeGreaterThanOrEqual(2);
    const tack1 = tackData.find(p => p.timestamp === point1.timestamp);
    const tack2 = tackData.find(p => p.timestamp === point2.timestamp);
    expect(tack1).toBeDefined();
    expect(tack2).toBeDefined();
    expect(tack1.value).toBe('port');
    expect(tack2.value).toBe('stbd');
    
    const maneuverData = await redisStorage.query(source_name1, 'MANEUVER_TYPE', oneHourAgo, now);
    expect(maneuverData.length).toBeGreaterThanOrEqual(1); // At least second point has maneuver
    const maneuver = maneuverData.find(p => p.timestamp === point2.timestamp);
    expect(maneuver).toBeDefined();
    expect(maneuver.value).toBe('T');
  }, 30000);

  test('should preserve all data including non-normalized channels', async () => {
    const testDataPoint = {
      source_id: testSourceId,
      timestamp: Date.now(),
      data: {
        source_name: 'TEST',
        lat: 39.12,
        lng: 9.18,
        custom_sensor_1: 42.5,
        custom_sensor_2: 'sensor_value',
        SystemTime_DaySeconds: 12345,
        period: 0.5
      }
    };
    
    const processed = processor.process(testDataPoint);
    expect(processed).not.toBeNull();
    
    const source_name = processed.data.source_name;
    expect(source_name).toBeDefined();
    
    // Store all channels
    const channelsToStore = Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime');
    
    for (const channel of channelsToStore) {
      const value = processed.data[channel];
      if (value !== undefined && value !== null) {
        await redisStorage.store(source_name, channel, processed.timestamp, value);
      }
    }
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify all channels are in Redis
    const storedChannels = await redisStorage.getChannels(source_name);
    
    // Normalized channels
    expect(storedChannels).toContain('Lat');
    expect(storedChannels).toContain('Lng');
    
    // Custom channels preserved
    expect(storedChannels).toContain('custom_sensor_1');
    expect(storedChannels).toContain('custom_sensor_2');
    expect(storedChannels).toContain('SystemTime_DaySeconds');
    expect(storedChannels).toContain('period');
    
    // Verify values
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const latData = await redisStorage.query(source_name, 'Lat', oneHourAgo, now);
    const latPoint = latData.find(p => p.timestamp === processed.timestamp);
    expect(latPoint).toBeDefined();
    expect(latPoint.value).toBe(39.12);
    
    const customData = await redisStorage.query(source_name, 'custom_sensor_1', oneHourAgo, now);
    const customPoint = customData.find(p => p.timestamp === processed.timestamp);
    expect(customPoint).toBeDefined();
    expect(customPoint.value).toBe(42.5);
  }, 30000);
});

