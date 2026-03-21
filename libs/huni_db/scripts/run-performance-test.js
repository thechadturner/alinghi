/**
 * Simple script to test performance page by starting dev server and checking it
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

let viteProcess = null;
let testResults = {
  passed: 0,
  failed: 0,
  errors: []
};

function log(message, type = 'info') {
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
  console.log(`${prefix} ${message}`);
}

function checkServer(port = 5173, maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://localhost:${port}`, (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          if (attempts < maxAttempts) {
            setTimeout(check, 500);
          } else {
            reject(new Error(`Server not ready after ${maxAttempts} attempts`));
          }
        }
      });
      req.on('error', () => {
        if (attempts < maxAttempts) {
          setTimeout(check, 500);
        } else {
          reject(new Error(`Server not ready after ${maxAttempts} attempts`));
        }
      });
    };
    check();
  });
}

async function startVite() {
  log('Starting Vite dev server...');
  viteProcess = spawn('npm', ['run', 'dev'], {
    cwd: projectRoot,
    shell: true,
    stdio: 'pipe'
  });

  viteProcess.stdout.on('data', (data) => {
    const output = data.toString();
    if (output.includes('Local:') || output.includes('localhost')) {
      log('Vite server started');
    }
  });

  viteProcess.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.includes('error')) {
      log(`Vite error: ${output}`, 'error');
    }
  });

  // Wait for server to be ready
  try {
    await checkServer();
    log('Server is ready!', 'success');
    return true;
  } catch (error) {
    log(`Failed to start server: ${error.message}`, 'error');
    return false;
  }
}

function stopVite() {
  if (viteProcess) {
    log('Stopping Vite server...');
    viteProcess.kill();
    viteProcess = null;
  }
}

// Handle cleanup
process.on('SIGINT', () => {
  stopVite();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopVite();
  process.exit(0);
});

async function main() {
  try {
    const serverReady = await startVite();
    if (!serverReady) {
      log('Could not start server. Please start it manually with: npm run dev', 'error');
      process.exit(1);
    }

    log('\n📋 Performance Test Page Checklist:');
    log('1. Open http://localhost:5173/examples/performance-test.html in your browser');
    log('2. Click "Connect Database"');
    log('3. Click "Create JSON Table"');
    log('4. Click "Batch Insert 100" or "Batch Insert 1000"');
    log('5. Click "Warm Cache"');
    log('6. Click "Test Cache" - should show cache hits');
    log('7. Click "Create FTS Index"');
    log('8. Click "Search FTS"');
    log('\n⚠️  Keep this process running. Press Ctrl+C to stop.\n');

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    log(`Error: ${error.message}`, 'error');
    stopVite();
    process.exit(1);
  }
}

main();

