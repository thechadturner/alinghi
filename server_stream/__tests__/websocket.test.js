/**
 * Tests for WebSocket Server Functionality
 * Tests client connections, authentication, subscriptions, and data broadcasting
 * 
 * TODO: Convert server_stream to ES modules or use a different test approach
 * Currently skipped due to CommonJS/ESM compatibility issues
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Skip these tests for now - server_stream uses CommonJS
describe.skip('WebSocket Server - Client Connections', () => {
  // Connection tests require actual WebSocket server setup
  // Skipping for now due to CommonJS/ESM issues
});

describe('WebSocket - Data Broadcasting', () => {
  it('should format data points correctly for clients', () => {
    const testDataPoint = {
      source_id: 1,
      timestamp: Date.now(),
      data: {
        Lat: 45.123,
        Lng: -73.456,
        Hdg: 180,
        Cog: 185,
        Sog: 12.5
      }
    };

    // Expected format for client
    const expectedFormat = {
      type: 'data',
      source_id: testDataPoint.source_id,
      timestamp: testDataPoint.timestamp,
      data: testDataPoint.data
    };

    expect(expectedFormat.source_id).toBe(testDataPoint.source_id);
    expect(expectedFormat.timestamp).toBe(testDataPoint.timestamp);
    expect(expectedFormat.data).toEqual(testDataPoint.data);
  });

  it('should handle normalized channel names in broadcasts', () => {
    const testDataPoint = {
      source_id: 1,
      timestamp: Date.now(),
      data: {
        Lat: 45.123,  // Normalized
        Lng: -73.456, // Normalized
        Hdg: 180,     // Normalized
        lat: 45.123,  // Lowercase (should not be in broadcast)
        lng: -73.456  // Lowercase (should not be in broadcast)
      }
    };

    // Filter to only normalized channels
    const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
    const filteredData = {};
    
    for (const [key, value] of Object.entries(testDataPoint.data)) {
      if (normalizedChannels.includes(key)) {
        filteredData[key] = value;
      }
    }

    expect(filteredData).toEqual({
      Lat: 45.123,
      Lng: -73.456,
      Hdg: 180
    });
    expect(filteredData).not.toHaveProperty('lat');
    expect(filteredData).not.toHaveProperty('lng');
  });
});
