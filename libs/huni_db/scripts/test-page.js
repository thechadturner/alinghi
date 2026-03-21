#!/usr/bin/env node

/**
 * Simple script to test the HuniDB example page
 * Checks if the page loads and has all required elements
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const examplePath = resolve(__dirname, '../examples/basic.html');
const html = readFileSync(examplePath, 'utf-8');

console.log('🔍 Testing HuniDB Example Page...\n');

const checks = {
  'Page has title': html.includes('<title>HuniDB Basic Example</title>'),
  'Has initialize button': html.includes('id="btnInit"'),
  'Has migrate button': html.includes('id="btnMigrate"'),
  'Has insert button': html.includes('id="btnInsert"'),
  'Has query button': html.includes('id="btnQuery"'),
  'Has update button': html.includes('id="btnUpdate"'),
  'Has transaction button': html.includes('id="btnTransaction"'),
  'Has stats button': html.includes('id="btnStats"'),
  'Has metrics button': html.includes('id="btnMetrics"'),
  'Has delete button': html.includes('id="btnDelete"'),
  'Has close button': html.includes('id="btnClose"'),
  'Imports HuniDB': html.includes("from '@hunico/hunidb'"),
  'Has output div': html.includes('id="output"'),
  'Has error handling': html.includes('catch (error)'),
  'Has success logging': html.includes('log('),
};

let passed = 0;
let failed = 0;

for (const [check, result] of Object.entries(checks)) {
  if (result) {
    console.log(`✅ ${check}`);
    passed++;
  } else {
    console.log(`❌ ${check}`);
    failed++;
  }
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

// Check for common issues
console.log('\n🔍 Checking for common issues...');

const issues = [];

if (!html.includes('Cross-Origin-Embedder-Policy')) {
  issues.push('⚠️  Page may need COEP headers for OPFS (handled by Vite config)');
}

if (!html.includes('error')) {
  issues.push('⚠️  No error handling found (should have try/catch)');
}

if (html.includes('localhost:3000')) {
  issues.push('⚠️  Hardcoded localhost port found');
}

if (issues.length > 0) {
  issues.forEach(issue => console.log(issue));
} else {
  console.log('✅ No common issues found');
}

console.log('\n✨ Page structure check complete!');
console.log('Next: Test in browser at http://localhost:5174/basic.html');

process.exit(failed > 0 ? 1 : 0);

