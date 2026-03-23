#!/usr/bin/env node

/**
 * Build script for @solidjs/sync package
 * This builds the syncstore package after npm install or before dev server starts
 * It checks if the dist folder exists to avoid unnecessary rebuilds
 */

import { existsSync, statSync, rmSync, cpSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const syncPath = join(rootDir, 'node_modules', '@solidjs', 'sync');
const distPath = join(syncPath, 'dist', 'index.js');
const packageJsonPath = join(syncPath, 'package.json');

/** @returns {string | null} */
const getPinnedSyncstoreRef = () => {
  try {
    const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const dep = rootPkg.dependencies?.['@solidjs/sync'];
    if (typeof dep === 'string' && dep.includes('#')) {
      return dep.split('#').pop() || null;
    }
  } catch {
    /* ignore */
  }
  return null;
};

// Check if we need to build
const needsBuild = () => {
  if (!existsSync(packageJsonPath)) {
    return false; // Package not installed
  }
  
  if (!existsSync(distPath)) {
    return true; // Dist doesn't exist
  }
  
  // Check if package.json is newer than dist (package was updated)
  try {
    const packageTime = statSync(packageJsonPath).mtime;
    const distTime = statSync(distPath).mtime;
    return packageTime > distTime;
  } catch {
    return true; // If we can't check, rebuild to be safe
  }
};

try {
  if (!existsSync(packageJsonPath)) {
    console.log('@solidjs/sync not found, skipping build');
    process.exit(0);
  }

  if (!needsBuild()) {
    console.log('@solidjs/sync already built, skipping...');
    process.exit(0);
  }

  console.log('Building @solidjs/sync package...');
  const originalCwd = process.cwd();
  
  try {
    process.chdir(syncPath);
    
    // Check if source files exist
    const srcPath = join(syncPath, 'src');
    const hasSourceFiles = existsSync(srcPath) || existsSync(join(syncPath, 'index.ts')) || existsSync(join(syncPath, 'index.js'));
    
    if (!hasSourceFiles) {
      console.log('⚠ @solidjs/sync source files not found in node_modules (npm only installed dist folder).');
      console.log('Cloning repository to get source files...');
      
      // Clone the repo to a temp location to get source files
      const tempRepoPath = join(rootDir, 'temp-syncstore-repo');
      const originalCwdForClone = process.cwd();
      
      try {
        // Remove temp repo if it exists
        if (existsSync(tempRepoPath)) {
          rmSync(tempRepoPath, { recursive: true, force: true });
        }
        
        // Clone the repo (match pinned ref from package.json when present)
        process.chdir(rootDir);
        execSync('git clone https://github.com/thechadturner/syncstore.git temp-syncstore-repo', { stdio: 'inherit' });
        const pinnedRef = getPinnedSyncstoreRef();
        if (pinnedRef) {
          execSync(`git -C temp-syncstore-repo checkout ${pinnedRef}`, { stdio: 'inherit' });
        }

        // Copy source files to the package directory
        const tempSrcPath = join(tempRepoPath, 'src');
        if (existsSync(tempSrcPath)) {
          cpSync(tempSrcPath, srcPath, { recursive: true });
          console.log('✓ Source files copied to package directory');
        }
        
        // Copy other necessary files (vite.config, tsconfig, etc.)
        const filesToCopy = ['vite.config.ts', 'vite.config.js', 'tsconfig.json', 'package.json'];
        for (const file of filesToCopy) {
          const srcFile = join(tempRepoPath, file);
          const destFile = join(syncPath, file);
          if (existsSync(srcFile) && !existsSync(destFile)) {
            cpSync(srcFile, destFile);
          }
        }
        
        // Clean up temp repo
        rmSync(tempRepoPath, { recursive: true, force: true });
        process.chdir(originalCwdForClone);
      } catch (cloneError) {
        console.warn('Failed to clone repository:', cloneError.message);
        console.warn('You may need to manually clone and copy files, or build from a local clone.');
        process.chdir(originalCwdForClone);
        process.exit(0);
      }
    }
    
    // Install dependencies if node_modules doesn't exist
    if (!existsSync(join(syncPath, 'node_modules'))) {
      console.log('Installing @solidjs/sync dependencies...');
      execSync('npm install --legacy-peer-deps', { stdio: 'inherit' });
    }

    // vite-plugin-dts@2 + @microsoft/api-extractor breaks on current Node (Collector.js.js); syncstore pins ^2.0.0
    console.log('Patching vite-plugin-dts for @solidjs/sync library build...');
    execSync('npm install vite-plugin-dts@4.5.4 --save-dev --legacy-peer-deps', { stdio: 'inherit' });
    
    // Build the package
    console.log('Building @solidjs/sync...');
    execSync('npm run build', { stdio: 'inherit' });
    console.log('✓ @solidjs/sync built successfully');
  } finally {
    process.chdir(originalCwd);
  }
} catch (error) {
  console.warn('Warning: Failed to build @solidjs/sync:', error.message);
  console.warn('You may need to build it manually: cd node_modules/@solidjs/sync && npm install && npm run build');
  // Don't exit with error code - allow dev server to start anyway
  process.exit(0);
}
