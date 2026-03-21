/**
 * Test script for processor logic
 * Tests normalization, CWA-based maneuver detection, and data processing
 * Run with: node server_stream/__tests__/test-processor.js
 */

const processor = require('../controllers/processor');

console.log('🧪 Testing Processor Logic...\n');

// Test 1: Normalization - lowercase to normalized
console.log('Test 1: Channel Name Normalization');
const test1 = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: {
    lat: 39.12,
    lng: 9.18,
    hdg: 180,
    cog: 180,
    sog: 10.5,
    cwa: 45,
    custom_channel: 123.45
  }
});

if (test1 && test1.data) {
  const data = test1.data;
  console.log('  Input channels:', Object.keys({ lat: 1, lng: 1, hdg: 1, cog: 1, sog: 1, cwa: 1, custom_channel: 1 }));
  console.log('  Output channels:', Object.keys(data).filter(k => k !== 'timestamp' && k !== 'Datetime'));
  console.log('  ✅ Normalized Lat:', data.Lat === 39.12 ? 'PASS' : 'FAIL');
  console.log('  ✅ Normalized Lng:', data.Lng === 9.18 ? 'PASS' : 'FAIL');
  console.log('  ✅ Normalized Hdg:', data.Hdg === 180 ? 'PASS' : 'FAIL');
  console.log('  ✅ Normalized Cog:', data.Cog === 180 ? 'PASS' : 'FAIL');
  console.log('  ✅ Normalized Sog:', data.Sog === 10.5 ? 'PASS' : 'FAIL');
  console.log('  ✅ Normalized Cwa:', data.Cwa === 45 ? 'PASS' : 'FAIL');
  console.log('  ✅ Custom channel preserved:', data.custom_channel === 123.45 ? 'PASS' : 'FAIL');
  console.log('  ✅ No lowercase duplicates:', !data.hasOwnProperty('lat') && !data.hasOwnProperty('lng') ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 1 FAILED: Processor returned null');
}

// Test 2: TACK computation
console.log('\nTest 2: TACK Computation');
const test2a = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: { cwa: 45 }
});
const test2b = processor.process({
  source_id: 1,
  timestamp: Date.now() + 1000,
  data: { cwa: -30 }
});

if (test2a && test2b) {
  console.log('  ✅ CWA > 0 → TACK = STBD:', test2a.data.TACK === 'STBD' ? 'PASS' : 'FAIL');
  console.log('  ✅ CWA < 0 → TACK = PORT:', test2b.data.TACK === 'PORT' ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 2 FAILED: Processor returned null');
}

// Test 3: POINTOFSAIL computation
console.log('\nTest 3: POINTOFSAIL Computation');
const test3a = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: { cwa: 45 } // < 70
});
const test3b = processor.process({
  source_id: 1,
  timestamp: Date.now() + 1000,
  data: { cwa: 90 } // 70-120
});
const test3c = processor.process({
  source_id: 1,
  timestamp: Date.now() + 2000,
  data: { cwa: 135 } // > 120
});

if (test3a && test3b && test3c) {
  console.log('  ✅ CWA < 70 → UPWIND:', test3a.data.POINTOFSAIL === 'UPWIND' ? 'PASS' : 'FAIL');
  console.log('  ✅ CWA 70-120 → REACH:', test3b.data.POINTOFSAIL === 'REACH' ? 'PASS' : 'FAIL');
  console.log('  ✅ CWA > 120 → DOWNWIND:', test3c.data.POINTOFSAIL === 'DOWNWIND' ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 3 FAILED: Processor returned null');
}

// Test 4: Tack detection (CWA sign change: negative to positive)
console.log('\nTest 4: Tack Detection (CWA sign change)');
processor.clearState(1); // Reset state
const test4a = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: { cwa: -30 } // Port
});
const test4b = processor.process({
  source_id: 1,
  timestamp: Date.now() + 1000,
  data: { cwa: 30 } // Stbd (tack!)
});

if (test4a && test4b) {
  console.log('  ✅ First point (no previous):', test4a.data.MANEUVER_TYPE === null ? 'PASS' : 'FAIL');
  console.log('  ✅ Tack detected (CWA -30 → 30):', test4b.data.MANEUVER_TYPE === 'T' ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 4 FAILED: Processor returned null');
}

// Test 5: Gybe detection (CWA sign change: positive to negative)
console.log('\nTest 5: Gybe Detection (CWA sign change)');
processor.clearState(1);
const test5a = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: { cwa: 30 } // Stbd
});
const test5b = processor.process({
  source_id: 1,
  timestamp: Date.now() + 1000,
  data: { cwa: -30 } // Port (gybe!)
});

if (test5a && test5b) {
  console.log('  ✅ First point (no previous):', test5a.data.MANEUVER_TYPE === null ? 'PASS' : 'FAIL');
  console.log('  ✅ Gybe detected (CWA 30 → -30):', test5b.data.MANEUVER_TYPE === 'G' ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 5 FAILED: Processor returned null');
}

// Test 6: Bear away detection (|CWA| < 90 → |CWA| >= 90)
console.log('\nTest 6: Bear Away Detection');
processor.clearState(1);
const test6a = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: { cwa: 60 } // |60| < 90
});
const test6b = processor.process({
  source_id: 1,
  timestamp: Date.now() + 1000,
  data: { cwa: 100 } // |100| >= 90 (bear away!)
});

if (test6a && test6b) {
  console.log('  ✅ First point (no previous):', test6a.data.MANEUVER_TYPE === null ? 'PASS' : 'FAIL');
  console.log('  ✅ Bear away detected (|CWA| 60 → 100):', test6b.data.MANEUVER_TYPE === 'B' ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 6 FAILED: Processor returned null');
}

// Test 7: Round up detection (|CWA| > 90 → |CWA| <= 90)
console.log('\nTest 7: Round Up Detection');
processor.clearState(1);
const test7a = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: { cwa: 120 } // |120| > 90
});
const test7b = processor.process({
  source_id: 1,
  timestamp: Date.now() + 1000,
  data: { cwa: 80 } // |80| <= 90 (round up!)
});

if (test7a && test7b) {
  console.log('  ✅ First point (no previous):', test7a.data.MANEUVER_TYPE === null ? 'PASS' : 'FAIL');
  console.log('  ✅ Round up detected (|CWA| 120 → 80):', test7b.data.MANEUVER_TYPE === 'R' ? 'PASS' : 'FAIL');
} else {
  console.log('  ❌ Test 7 FAILED: Processor returned null');
}

// Test 8: All data passes through
console.log('\nTest 8: All Data Passes Through');
const test8 = processor.process({
  source_id: 1,
  timestamp: Date.now(),
  data: {
    lat: 39.12,
    lng: 9.18,
    hdg: 180,
    cog: 180,
    sog: 10.5,
    cwa: 45,
    custom_field_1: 'value1',
    custom_field_2: 999,
    another_custom: true
  }
});

if (test8 && test8.data) {
  const data = test8.data;
  const hasNormalized = data.Lat && data.Lng && data.Hdg && data.Cog && data.Sog && data.Cwa;
  const hasCustom = data.custom_field_1 && data.custom_field_2 && data.another_custom;
  console.log('  ✅ Normalized channels present:', hasNormalized ? 'PASS' : 'FAIL');
  console.log('  ✅ Custom channels preserved:', hasCustom ? 'PASS' : 'FAIL');
  console.log('  ✅ Total channels:', Object.keys(data).filter(k => k !== 'timestamp' && k !== 'Datetime').length);
} else {
  console.log('  ❌ Test 8 FAILED: Processor returned null');
}

console.log('\n✅ Processor tests complete!\n');

