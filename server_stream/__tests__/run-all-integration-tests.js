/**
 * Test Runner for All Integration Tests
 * Runs all integration tests in sequence and reports results
 */

const { spawn } = require('child_process');
const path = require('path');

const TESTS = [
  {
    name: 'Full Data Flow',
    file: 'test-full-data-flow.js',
    description: 'End-to-end test: InfluxDB → Processor → Redis → API'
  },
  {
    name: 'Query Format Scenarios',
    file: 'test-query-format-scenarios.js',
    description: 'Tests query format fix for various time ranges'
  },
  {
    name: 'Channel Normalization Pipeline',
    file: 'test-channel-normalization-pipeline.js',
    description: 'Tests channel normalization at each stage of the pipeline'
  },
  {
    name: 'Processor → Redis Integration',
    file: 'test-processor-redis.js',
    description: 'Tests processor output stored correctly in Redis'
  }
];

const INTEGRATION_DIR = path.join(__dirname, 'integration');

async function runTest(test) {
  return new Promise((resolve) => {
    const testPath = path.join(INTEGRATION_DIR, test.file);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🧪 Running: ${test.name}`);
    console.log(`   ${test.description}`);
    console.log(`${'='.repeat(60)}\n`);
    
    const startTime = Date.now();
    const proc = spawn('node', [testPath], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true
    });
    
    proc.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`\n✅ ${test.name} passed (${duration}s)`);
        resolve({ name: test.name, passed: true, duration });
      } else {
        console.log(`\n❌ ${test.name} failed (${duration}s)`);
        resolve({ name: test.name, passed: false, duration, exitCode: code });
      }
    });
    
    proc.on('error', (err) => {
      console.error(`\n❌ Error running ${test.name}:`, err.message);
      resolve({ name: test.name, passed: false, error: err.message });
    });
  });
}

async function runAllTests() {
  console.log('🚀 Running All Integration Tests');
  console.log('='.repeat(60));
  console.log(`Found ${TESTS.length} test(s) to run\n`);
  
  const results = [];
  
  for (const test of TESTS) {
    const result = await runTest(test);
    results.push(result);
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Suite Summary');
  console.log('='.repeat(60));
  
  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  
  console.log(`\n✅ Passed: ${passed.length}/${results.length}`);
  passed.forEach(r => {
    console.log(`   - ${r.name} (${r.duration}s)`);
  });
  
  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach(r => {
      console.log(`   - ${r.name}${r.duration ? ` (${r.duration}s)` : ''}${r.exitCode ? ` [exit code: ${r.exitCode}]` : ''}`);
    });
  }
  
  const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0).toFixed(2);
  console.log(`\n⏱️  Total Duration: ${totalDuration}s`);
  
  if (failed.length === 0) {
    console.log('\n✅ All integration tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. Please review the errors above.');
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('❌ Test runner failed:', err);
  process.exit(1);
});

