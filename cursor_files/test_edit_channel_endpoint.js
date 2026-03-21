/**
 * Test script for the edit-channel-data endpoint
 * 
 * This script demonstrates how to use the new endpoint to edit channel data in parquet files.
 * 
 * Usage:
 * 1. Update the configuration below with your actual values
 * 2. Run: node cursor_files/test_edit_channel_endpoint.js
 */

const axios = require('axios');

// Configuration
const config = {
  baseUrl: 'http://localhost:8079/api',
  authToken: 'YOUR_AUTH_TOKEN_HERE', // Replace with actual JWT token
  
  // Request parameters
  project_id: '1',
  class_name: 'ac75',
  date: '20260213', // YYYYMMDD format
  source_name: 'GER',
  channel_name: 'tws', // Channel to edit
  start_ts: 1739404800, // Unix timestamp (start of time range)
  end_ts: 1739408400,   // Unix timestamp (end of time range)
  channel_value: 15.5   // New value to set
};

async function testEditChannelData() {
  try {
    console.log('Testing edit-channel-data endpoint...');
    console.log('Configuration:', JSON.stringify(config, null, 2));
    
    const response = await axios.post(
      `${config.baseUrl}/edit-channel-data`,
      {
        project_id: config.project_id,
        class_name: config.class_name,
        date: config.date,
        source_name: config.source_name,
        channel_name: config.channel_name,
        start_ts: config.start_ts,
        end_ts: config.end_ts,
        channel_value: config.channel_value
      },
      {
        headers: {
          'Authorization': `Bearer ${config.authToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('\nResponse status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));
    
    if (response.data.success) {
      console.log('\n✓ Channel data edited successfully!');
      console.log(`  - Files modified: ${response.data.data.filesModified}`);
      console.log(`  - Rows modified: ${response.data.data.rowsModified}`);
      console.log(`  - Files processed: ${response.data.data.filesProcessed}`);
    } else {
      console.log('\n✗ Failed to edit channel data');
      console.log('Message:', response.data.message);
    }
  } catch (err) {
    console.error('\n✗ Error testing endpoint:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
  }
}

// Run the test
testEditChannelData();
