/**
 * Copy SQLite WASM worker files into static-pwa/assets (Vite publicDir).
 * Ensures /assets/sqlite3.wasm and worker scripts are served in dev and copied to dist.
 */

import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = join(__dirname, '..');
const huniDbDistDir = join(projectRoot, 'libs', 'huni_db', 'dist', 'assets');
const nodeModulesDir = join(projectRoot, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'sqlite-wasm', 'jswasm');
const targetDir = join(projectRoot, 'static-pwa', 'assets');

// Determine source directory - prefer huni_db dist, fallback to node_modules
let sourceDir = null;
if (existsSync(huniDbDistDir)) {
  sourceDir = huniDbDistDir;
  console.log('✓ Using SQLite files from huni_db dist');
} else if (existsSync(nodeModulesDir)) {
  sourceDir = nodeModulesDir;
  console.log('✓ Using SQLite files from node_modules');
} else {
  // Try to find in workspace node_modules
  const workspaceNodeModules = join(projectRoot, 'libs', 'huni_db', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'sqlite-wasm', 'jswasm');
  if (existsSync(workspaceNodeModules)) {
    sourceDir = workspaceNodeModules;
    console.log('✓ Using SQLite files from huni_db workspace node_modules');
  } else {
    console.error('❌ SQLite WASM source directory not found in any location!');
    console.error('   Checked:', huniDbDistDir);
    console.error('   Checked:', nodeModulesDir);
    console.error('   Checked:', workspaceNodeModules);
    console.error('   Please run: npm install');
    process.exit(1);
  }
}

try {

  // Create target directory if it doesn't exist
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    console.log('✓ Created static-pwa/assets directory');
  }

  // Copy all SQLite worker and WASM files (and their source maps if they exist)
  const files = readdirSync(sourceDir);
  // In node_modules, files are named differently - look for sqlite3.wasm and sqlite3-opfs-async-proxy.js
  const sqliteWorkerFiles = files.filter(f => 
    (f.startsWith('sqlite3-') && f.endsWith('.js')) || 
    f === 'sqlite3-opfs-async-proxy.js'
  );
  const sqliteWasmFiles = files.filter(f => f === 'sqlite3.wasm' || f.endsWith('.wasm'));

  let copiedCount = 0;
  
  // Copy worker files from source directory
  for (const file of sqliteWorkerFiles) {
    const sourcePath = join(sourceDir, file);
    const targetPath = join(targetDir, file);
    copyFileSync(sourcePath, targetPath);
    console.log(`✓ Copied ${file}`);
    copiedCount++;
    
    // Also copy source map if it exists
    const mapFile = `${file}.map`;
    const mapSourcePath = join(sourceDir, mapFile);
    const mapTargetPath = join(targetDir, mapFile);
    if (existsSync(mapSourcePath)) {
      copyFileSync(mapSourcePath, mapTargetPath);
      console.log(`✓ Copied ${mapFile}`);
      copiedCount++;
    }
  }
  
  // Copy WASM files - check multiple locations
  if (sqliteWasmFiles.length === 0) {
    // WASM file not in source directory, try to find it in node_modules
    const nodeModulesWasm = join(projectRoot, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'sqlite-wasm', 'jswasm', 'sqlite3.wasm');
    const workspaceWasm = join(projectRoot, 'libs', 'huni_db', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'sqlite-wasm', 'jswasm', 'sqlite3.wasm');
    
    let wasmSource = null;
    if (existsSync(nodeModulesWasm)) {
      wasmSource = nodeModulesWasm;
      console.log('✓ Found sqlite3.wasm in node_modules');
    } else if (existsSync(workspaceWasm)) {
      wasmSource = workspaceWasm;
      console.log('✓ Found sqlite3.wasm in workspace node_modules');
    }
    
    if (wasmSource) {
      const targetPath = join(targetDir, 'sqlite3.wasm');
      copyFileSync(wasmSource, targetPath);
      console.log('✓ Copied sqlite3.wasm');
      copiedCount++;
    } else {
      console.error('❌ sqlite3.wasm not found in any location!');
      console.error('   Checked:', nodeModulesWasm);
      console.error('   Checked:', workspaceWasm);
      console.error('   This will cause SQLite initialization to fail.');
      process.exit(1);
    }
  } else {
    // WASM file found in source directory, copy it
    for (const file of sqliteWasmFiles) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);
      copyFileSync(sourcePath, targetPath);
      console.log(`✓ Copied ${file}`);
      copiedCount++;
    }
  }

  if (copiedCount === 0) {
    console.error('❌ No SQLite files copied!');
    console.error('   Files in source directory:', files);
    console.error('   This will cause SQLite initialization to fail.');
    process.exit(1);
  }

  console.log(`✓ Copied ${copiedCount} SQLite file(s) to static-pwa/assets`);
} catch (error) {
  console.error('❌ Error copying SQLite worker files:', error.message);
  process.exit(1);
}

