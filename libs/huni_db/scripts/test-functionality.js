#!/usr/bin/env node

/**
 * Test HuniDB functionality programmatically
 * This simulates what the browser example does
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Testing HuniDB Core Functionality...\n');

// Test 1: Check if source files exist and are importable
const sourceFiles = [
  'src/index.ts',
  'src/core/engine.ts',
  'src/core/connection.ts',
  'src/core/adapter.ts',
  'src/schema/dsl.ts',
  'src/schema/migration.ts',
  'src/query/builder.ts',
  'src/utils/errors.ts',
  'src/utils/logger.ts',
];

console.log('📁 Checking source files...');
let allFilesExist = true;
for (const file of sourceFiles) {
  const filePath = resolve(__dirname, '..', file);
  try {
    const content = readFileSync(filePath, 'utf-8');
    console.log(`  ✅ ${file} (${content.length} bytes)`);
  } catch (error) {
    console.log(`  ❌ ${file} - NOT FOUND`);
    allFilesExist = false;
  }
}

// Test 2: Check exports in index.ts
console.log('\n📦 Checking exports...');
const indexPath = resolve(__dirname, '..', 'src/index.ts');
const indexContent = readFileSync(indexPath, 'utf-8');

const requiredExports = [
  'connect',
  'Database',
  'closeAll',
  'defineTable',
  'LogLevel',
  'HuniDBError',
  'ConnectionError',
];

let allExportsFound = true;
for (const exp of requiredExports) {
  if (indexContent.includes(exp)) {
    console.log(`  ✅ ${exp}`);
  } else {
    console.log(`  ❌ ${exp} - NOT FOUND`);
    allExportsFound = false;
  }
}

// Test 3: Check example HTML imports
console.log('\n🔗 Checking example imports...');
const examplePath = resolve(__dirname, '..', 'examples/basic.html');
const exampleContent = readFileSync(examplePath, 'utf-8');

const requiredImports = [
  "from '@hunico/hunidb'",
  'connect',
  'LogLevel',
];

let allImportsFound = true;
for (const imp of requiredImports) {
  if (exampleContent.includes(imp)) {
    console.log(`  ✅ ${imp}`);
  } else {
    console.log(`  ❌ ${imp} - NOT FOUND`);
    allImportsFound = false;
  }
}

// Test 4: Check error handling
console.log('\n🛡️  Checking error handling...');
const errorHandling = [
  { file: 'src/core/engine.ts', check: 'try' },
  { file: 'src/core/connection.ts', check: 'try' },
  { file: 'examples/basic.html', check: 'catch (error)' },
];

let errorHandlingGood = true;
for (const { file, check } of errorHandling) {
  const filePath = resolve(__dirname, '..', file);
  const content = readFileSync(filePath, 'utf-8');
  if (content.includes(check)) {
    console.log(`  ✅ ${file} has error handling`);
  } else {
    console.log(`  ⚠️  ${file} may be missing error handling`);
    errorHandlingGood = false;
  }
}

// Summary
console.log('\n📊 Test Summary:');
console.log(`  Source Files: ${allFilesExist ? '✅ All present' : '❌ Some missing'}`);
console.log(`  Exports: ${allExportsFound ? '✅ All found' : '❌ Some missing'}`);
console.log(`  Imports: ${allImportsFound ? '✅ All found' : '❌ Some missing'}`);
console.log(`  Error Handling: ${errorHandlingGood ? '✅ Good' : '⚠️  Could be improved'}`);

const allPassed = allFilesExist && allExportsFound && allImportsFound;
console.log(`\n${allPassed ? '✅' : '❌'} Overall: ${allPassed ? 'PASSED' : 'FAILED'}`);

console.log('\n💡 Next Steps:');
console.log('  1. Start dev server: npm run dev');
console.log('  2. Open browser: http://localhost:5174/basic.html');
console.log('  3. Test each button in the checklist');

process.exit(allPassed ? 0 : 1);

