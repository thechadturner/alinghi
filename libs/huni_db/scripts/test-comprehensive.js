#!/usr/bin/env node

/**
 * Comprehensive test script that validates code logic
 * and creates a test report
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Comprehensive HuniDB Testing\n');
console.log('=' .repeat(60));

const results = {
  passed: [],
  failed: [],
  warnings: [],
};

function test(name, condition, details = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    results.passed.push(name);
    if (details) console.log(`   ${details}`);
  } else {
    console.log(`❌ ${name}`);
    results.failed.push(name);
    if (details) console.log(`   ${details}`);
  }
}

function warn(name, message) {
  console.log(`⚠️  ${name}`);
  results.warnings.push({ name, message });
  if (message) console.log(`   ${message}`);
}

// Test 1: Code Structure
console.log('\n📁 Code Structure Tests');
const sourceFiles = {
  'src/index.ts': 'Main entry point',
  'src/core/engine.ts': 'SQLite engine wrapper',
  'src/core/connection.ts': 'Connection manager',
  'src/core/adapter.ts': 'Storage adapter',
  'src/schema/dsl.ts': 'Schema DSL',
  'src/schema/migration.ts': 'Migration system',
  'src/query/builder.ts': 'Query builder',
  'src/utils/errors.ts': 'Error handling',
  'src/utils/logger.ts': 'Logging system',
};

for (const [file, desc] of Object.entries(sourceFiles)) {
  const filePath = resolve(__dirname, '..', file);
  try {
    const content = readFileSync(filePath, 'utf-8');
    test(`${file} exists`, content.length > 0, `${desc} (${content.length} bytes)`);
  } catch (error) {
    test(`${file} exists`, false, `Missing: ${error.message}`);
  }
}

// Test 2: Example HTML
console.log('\n📄 Example HTML Tests');
const examplePath = resolve(__dirname, '..', 'examples/basic.html');
const exampleContent = readFileSync(examplePath, 'utf-8');

test('Example HTML exists', exampleContent.length > 0);
test('Imports HuniDB correctly', exampleContent.includes("from '@hunico/hunidb'"));
test('Has all required buttons', 
  ['btnInit', 'btnMigrate', 'btnInsert', 'btnQuery', 'btnUpdate', 'btnTransaction', 'btnDelete'].every(
    id => exampleContent.includes(`id="${id}"`)
  )
);
test('Has error handling', exampleContent.includes('catch (error)'));
test('Has output area', exampleContent.includes('id="output"'));

// Test 3: Migration Example
console.log('\n🔄 Migration Tests');
const migrationDefined = exampleContent.includes('version: 1') && 
                         exampleContent.includes('up: async') &&
                         exampleContent.includes('down: async');
test('Migration example is complete', migrationDefined);

// Test 4: Error Handling
console.log('\n🛡️  Error Handling Tests');
const enginePath = resolve(__dirname, '..', 'src/core/engine.ts');
const engineContent = readFileSync(enginePath, 'utf-8');

test('Engine has try/catch blocks', engineContent.includes('try {') && engineContent.includes('catch'));
test('Engine has OPFS fallback', engineContent.includes('falling back to memory'));
test('Connection has error handling', 
  readFileSync(resolve(__dirname, '..', 'src/core/connection.ts'), 'utf-8').includes('catch')
);

// Test 5: API Completeness
console.log('\n🔌 API Completeness Tests');
const indexPath = resolve(__dirname, '..', 'src/index.ts');
const indexContent = readFileSync(indexPath, 'utf-8');

const requiredMethods = [
  'connect',
  'query',
  'queryOne',
  'queryValue',
  'exec',
  'transaction',
  'migrate',
  'getMigrationVersion',
  'getMigrationStatus',
  'getStorageInfo',
  'close',
];

for (const method of requiredMethods) {
  // Check for method definition in Database class or as exported function
  let hasMethod = false;
  if (method === 'connect') {
    hasMethod = indexContent.includes('export async function connect');
  } else {
    // Methods are in Database class - check for async method with generic types
    // Pattern: async query<T or async query( or query<T
    const patterns = [
      `async ${method}<`,
      `async ${method}(`,
      ` ${method}<`,
      ` ${method}(`,
    ];
    hasMethod = patterns.some(pattern => indexContent.includes(pattern));
  }
  test(`Database.${method}() exists`, hasMethod);
}

// Test 6: Type Safety
console.log('\n📘 Type Safety Tests');
test('TypeScript types are exported', indexContent.includes('export type'));
// Check for interfaces in type files
const typesPath = resolve(__dirname, '..', 'src/schema/types.ts');
try {
  const typesContent = readFileSync(typesPath, 'utf-8');
  test('Interfaces are defined', typesContent.includes('interface'));
} catch (error) {
  test('Interfaces are defined', false);
}
test('Type imports are present', indexContent.includes('import type'));

// Test 7: Documentation
console.log('\n📚 Documentation Tests');
const readmePath = resolve(__dirname, '..', 'README.md');
try {
  const readme = readFileSync(readmePath, 'utf-8');
  test('README exists', readme.length > 0);
  test('README has API examples', readme.includes('```typescript'));
  test('README has installation instructions', readme.includes('npm install'));
} catch (error) {
  test('README exists', false);
}

// Test 8: Build Configuration
console.log('\n⚙️  Build Configuration Tests');
const packagePath = resolve(__dirname, '..', 'package.json');
const packageContent = JSON.parse(readFileSync(packagePath, 'utf-8'));

test('Package has build script', packageContent.scripts?.build);
test('Package has test scripts', packageContent.scripts?.test);
test('Package has correct name', packageContent.name === '@hunico/hunidb');
test('Package has SQLite dependency', 
  packageContent.dependencies?.['@sqlite.org/sqlite-wasm']
);

// Test 9: Vite Configuration
console.log('\n🔧 Vite Configuration Tests');
const vitePath = resolve(__dirname, '..', 'vite.config.ts');
try {
  const viteContent = readFileSync(vitePath, 'utf-8');
  test('Vite config exists', viteContent.length > 0);
  test('Vite has dev server config', viteContent.includes('server:'));
  test('Vite has CORS headers', viteContent.includes('Cross-Origin'));
} catch (error) {
  test('Vite config exists', false);
}

// Test 10: Example Completeness
console.log('\n🎯 Example Completeness Tests');
const exampleTests = [
  { name: 'Has initialize handler', check: 'btnInit.*addEventListener' },
  { name: 'Has migrate handler', check: 'btnMigrate.*addEventListener' },
  { name: 'Has insert handler', check: 'btnInsert.*addEventListener' },
  { name: 'Has query handler', check: 'btnQuery.*addEventListener' },
  { name: 'Has transaction handler', check: 'btnTransaction.*addEventListener' },
];

for (const { name, check } of exampleTests) {
  const regex = new RegExp(check, 's');
  test(name, regex.test(exampleContent));
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('\n📊 Test Summary:');
console.log(`   ✅ Passed: ${results.passed.length}`);
console.log(`   ❌ Failed: ${results.failed.length}`);
console.log(`   ⚠️  Warnings: ${results.warnings.length}`);

if (results.failed.length > 0) {
  console.log('\n❌ Failed Tests:');
  results.failed.forEach(test => console.log(`   - ${test}`));
}

if (results.warnings.length > 0) {
  console.log('\n⚠️  Warnings:');
  results.warnings.forEach(({ name, message }) => {
    console.log(`   - ${name}`);
    if (message) console.log(`     ${message}`);
  });
}

const successRate = (results.passed.length / (results.passed.length + results.failed.length)) * 100;
console.log(`\n📈 Success Rate: ${successRate.toFixed(1)}%`);

if (results.failed.length === 0) {
  console.log('\n🎉 All automated tests passed!');
  console.log('💡 Next: Test in browser at http://localhost:5174/basic.html');
  process.exit(0);
} else {
  console.log('\n⚠️  Some tests failed. Please review and fix.');
  process.exit(1);
}

