#!/usr/bin/env node

/**
 * Validate code logic and check for potential runtime issues
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 Validating HuniDB Code Logic...\n');

const issues = [];
const warnings = [];

function checkFile(file, checks) {
  const filePath = resolve(__dirname, '..', file);
  try {
    const content = readFileSync(filePath, 'utf-8');
    checks.forEach(({ name, check, severity = 'error' }) => {
      const result = check(content);
      if (!result.pass) {
        if (severity === 'error') {
          issues.push({ file, name, message: result.message });
        } else {
          warnings.push({ file, name, message: result.message });
        }
      }
    });
  } catch (error) {
    issues.push({ file, name: 'File read', message: error.message });
  }
}

// Check engine.ts
checkFile('src/core/engine.ts', [
  {
    name: 'OPFS fallback logic',
    check: (content) => ({
      pass: content.includes('falling back to memory') || content.includes('fall back'),
      message: 'Should have fallback logic for OPFS failures'
    })
  },
  {
    name: 'Error handling in exec',
    check: (content) => ({
      pass: content.includes('try') && content.includes('catch'),
      message: 'Should have try/catch in exec method'
    })
  },
  {
    name: 'selectObjects usage',
    check: (content) => ({
      pass: content.includes('selectObjects'),
      message: 'Should use selectObjects for query method'
    })
  },
  {
    name: 'selectValue usage',
    check: (content) => ({
      pass: content.includes('selectValue'),
      message: 'Should use selectValue for queryValue method'
    })
  },
]);

// Check connection.ts
checkFile('src/core/connection.ts', [
  {
    name: 'Write serialization',
    check: (content) => ({
      pass: content.includes('writeLock') || content.includes('serialize'),
      message: 'Should serialize writes'
    })
  },
  {
    name: 'Connection state check',
    check: (content) => ({
      pass: content.includes('ensureOpen') || content.includes('isOpen'),
      message: 'Should check connection state before operations'
    })
  },
]);

// Check example HTML
checkFile('examples/basic.html', [
  {
    name: 'Error handling in all handlers',
    check: (content) => {
      // Simple check: count addEventListener and catch blocks
      const handlerCount = (content.match(/addEventListener\(['"]click['"]/g) || []).length;
      const catchCount = (content.match(/catch\s*\(/g) || []).length;
      // btnInit doesn't need db check, others do - so we expect catchCount >= handlerCount - 1
      // But actually all should have try/catch, so catchCount should be >= handlerCount
      const hasEnoughCatch = catchCount >= handlerCount;
      return {
        pass: hasEnoughCatch,
        message: hasEnoughCatch 
          ? `All ${handlerCount} handlers have error handling (${catchCount} catch blocks)`
          : `${handlerCount} handlers but only ${catchCount} catch blocks`
      };
    }
  },
  {
    name: 'Database null check',
    check: (content) => ({
      pass: content.includes('if (!db') || content.includes('db === null'),
      message: 'Should check if db is initialized before use',
      severity: 'warning'
    })
  },
]);

// Check migration.ts
checkFile('src/schema/migration.ts', [
  {
    name: 'Migration validation',
    check: (content) => ({
      pass: content.includes('validateMigrations'),
      message: 'Should validate migrations before running'
    })
  },
  {
    name: 'Transaction wrapping',
    check: (content) => ({
      pass: content.includes('transaction') && content.includes('await'),
      message: 'Should wrap migrations in transactions'
    })
  },
]);

console.log('📋 Validation Results:\n');

if (issues.length === 0 && warnings.length === 0) {
  console.log('✅ No issues found!');
} else {
  if (issues.length > 0) {
    console.log(`❌ Found ${issues.length} issue(s):`);
    issues.forEach(({ file, name, message }) => {
      console.log(`   ${file}: ${name}`);
      console.log(`      ${message}`);
    });
  }
  
  if (warnings.length > 0) {
    console.log(`\n⚠️  Found ${warnings.length} warning(s):`);
    warnings.forEach(({ file, name, message }) => {
      console.log(`   ${file}: ${name}`);
      console.log(`      ${message}`);
    });
  }
}

console.log('\n' + '='.repeat(60));
process.exit(issues.length > 0 ? 1 : 0);

