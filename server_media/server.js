const express = require("express");
const fs = require("fs");
const { pipeline } = require("stream");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const config = require('./middleware/config');
const { installConsoleGate, logAlways, log, error, warn, debug } = require('../shared');

// Install console gate early to wrap all console.* calls
installConsoleGate();

let authenticate;
try {
  const authModule = require('./middleware/auth_jwt');
  authenticate = authModule.authenticate;
  log('Media server starting with authentication enabled');
} catch (error) {
  error('Failed to load authentication middleware:', error.message);
  // Fallback to a simple auth check
  authenticate = (req, res, next) => {
    log('Using fallback authentication');
    next();
  };
}
const app = express();

// CORS configuration consistent with other servers
const allowedOrigins = (config.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Parse cookies for authentication
app.use(cookieParser());

// Compression middleware with optimized settings
// Note: Video streaming endpoints should skip compression (handled by filter)
app.use(compression({
  level: 6, // Compression level (0-9): 6 provides good balance between compression ratio and CPU usage
  threshold: 1024, // Only compress responses larger than 1KB
  filter: (req, res) => {
    // Skip compression for video endpoints (already optimized for streaming)
    if (req.path.startsWith('/api/video')) {
      return false;
    }
    // Compress JSON, text, and other compressible content types
    if (req.headers['x-no-compression']) {
      return false;
    }
    const contentType = res.getHeader('content-type') || '';
    return /json|text|javascript|css|xml|html|svg/i.test(contentType);
  }
}));

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : undefined,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-CSRF-Token",
      "Range",
      "Content-Range",
      "Content-Length",
      "Accept-Ranges"
    ],
    exposedHeaders: [
      "X-CSRF-Token",
      "Content-Range",
      "Content-Length",
      "Accept-Ranges"
    ],
    optionsSuccessStatus: 204,
  })
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'media', uptime: process.uptime(), timestamp: Date.now() });
});

// Readiness (media server has no DB; check filesystem path access)
app.get('/api/ready', (req, res) => {
  try {
    const testPath = path.dirname(__filename);
    fs.accessSync(testPath, fs.constants.R_OK);
    return res.json({ status: 'ready', service: 'media', fs: 'ok', timestamp: Date.now() });
  } catch (err) {
    return res.status(503).json({ status: 'unready', service: 'media', fs: 'error', message: err?.message });
  }
});

// Helper function to convert Windows paths to container paths when running in Docker
function convertPathForContainer(filePath) {
  if (!filePath) return filePath;
  
  // Normalize the path for comparison - replace all backslashes with forward slashes
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  
  // Check if this looks like a Windows path (starts with drive letter like C: or D:)
  // Handle both C:/ and C:\ formats
  const isWindowsPath = /^[A-Za-z]:[\/\\]/.test(filePath);
  
  if (isWindowsPath) {
    const containerMediaDir = '/media';
    
    // Common Windows media directory patterns
    const possibleMediaDirs = [
      config.MEDIA_DIRECTORY || process.env.MEDIA_DIRECTORY,
      'C:/MyApps/Hunico/Uploads/Media',
      'C:\\MyApps\\Hunico\\Uploads\\Media'
    ].filter(Boolean);
    
    // Try each possible media directory
    for (const mediaDir of possibleMediaDirs) {
      const normalizedMediaDir = String(mediaDir).replace(/\\/g, '/');
      
      // If the path starts with the Windows media directory, replace it with container path
      if (normalizedPath.toLowerCase().startsWith(normalizedMediaDir.toLowerCase())) {
        let relativePath = normalizedPath.substring(normalizedMediaDir.length);
        // Remove leading slash if present (path.join will add it)
        if (relativePath.startsWith('/')) {
          relativePath = relativePath.substring(1);
        }
        // Ensure relative path uses forward slashes
        relativePath = relativePath.replace(/\\/g, '/');
        const containerPath = path.join(containerMediaDir, relativePath).replace(/\\/g, '/');
        log(`Converted Windows path to container path: ${filePath} -> ${containerPath}`);
        return containerPath;
      }
    }
    
    // If no match found but it's a Windows path, try extracting just the relative part
    // Pattern: C:/MyApps/Hunico/Uploads/Media/System/... -> /media/System/...
    // Also handle: C:\MyApps\Hunico\Uploads\Media\System\... -> /media/System/...
    const mediaMatch = normalizedPath.match(/[\/\\]Media[\/\\](.+)$/i);
    if (mediaMatch) {
      let relativePath = mediaMatch[1];
      // Ensure relative path uses forward slashes
      relativePath = relativePath.replace(/\\/g, '/');
      const containerPath = path.join(containerMediaDir, relativePath).replace(/\\/g, '/');
      log(`Converted Windows path (extracted): ${filePath} -> ${containerPath}`);
      return containerPath;
    }
  }
  
  // If it's not a Windows path but contains /Media/, try converting anyway (might be URL-encoded)
  const mediaMatch = normalizedPath.match(/[\/\\]Media[\/\\](.+)$/i);
  if (mediaMatch) {
    let relativePath = mediaMatch[1].replace(/\\/g, '/');
    const containerPath = path.join('/media', relativePath).replace(/\\/g, '/');
    log(`Converted path (Media pattern match): ${filePath} -> ${containerPath}`);
    return containerPath;
  }
  
  return filePath;
}

app.get("/api/video", authenticate, (req, res) => {
  log('Video endpoint accessed - authentication passed');
  try {
    // Get video path from query parameter or use default
    let videoPath = req.query.path || 'C:/MyApps/Hunico/Uploads/Media/System/1/gp50/20240829/video1.mp4';
    
    debug(`Original video path from query: ${videoPath}`);
    
    // Convert Windows path to container path if running in Docker
    const originalPath = videoPath;
    videoPath = convertPathForContainer(videoPath);
    
    if (originalPath !== videoPath) {
      log(`Path converted: ${originalPath} -> ${videoPath}`);
    } else {
      debug(`Path not converted (may not be Windows path or already container path): ${videoPath}`);
    }
    
    // Check if file exists
    if (!fs.existsSync(videoPath)) {
      error(`Video file not found: ${videoPath} (original: ${originalPath})`);
      // Try to list what's in the directory to help debug
      try {
        const dirPath = path.dirname(videoPath);
        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath);
          debug(`Directory exists but file not found. Files in ${dirPath}: ${files.slice(0, 5).join(', ')}`);
        } else {
          debug(`Directory does not exist: ${dirPath}`);
        }
      } catch (e) {
        debug(`Could not check directory: ${e.message}`);
      }
      return res.status(404).json({ error: 'Video file not found', path: videoPath, original: originalPath });
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    log(`Serving video: ${videoPath} (${fileSize} bytes) for user: ${req.user?.email || 'unknown'}`);
    log(`Range header: ${range}`);
    debug(`All headers:`, req.headers);

    // Support HEAD requests without opening file descriptors
    if (req.method === 'HEAD') {
      const head = {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      };
      return res.writeHead(200, head).end();
    }

    if (range) {
      log(`Processing range request: ${range}`);
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      log(`Range: ${start} to ${end}, chunk size: ${end - start + 1}`);

      const chunkSize = end - start + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      
      const head = {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
        "Cache-Control": "no-cache"
      };
      
      res.writeHead(206, head);

      // Ensure file descriptor is released on all outcomes
      const onClientAbort = () => {
        debug('Client aborted connection, destroying stream');
        file.destroy();
      };
      res.on('close', onClientAbort);
      res.on('aborted', onClientAbort);

      pipeline(file, res, (err) => {
        res.off('close', onClientAbort);
        res.off('aborted', onClientAbort);
        if (err) {
          // "Premature close" is expected when client aborts (seeking, quality change, etc.)
          // Downgrade to debug level since it's not a real error
          if (err.message === 'Premature close' || err.message.includes('Premature close')) {
            debug('Pipeline: Client aborted range video request (expected behavior)');
          } else {
            error('Pipeline error serving range video:', err.message);
          }
        } else {
          debug('Range pipeline completed successfully');
        }
      });
    } else {
      log(`No range header provided, serving full file`);
      const head = {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      };
      
      res.writeHead(200, head);
      const file = fs.createReadStream(videoPath);

      const onClientAbort = () => {
        debug('Client aborted connection (full file), destroying stream');
        file.destroy();
      };
      res.on('close', onClientAbort);
      res.on('aborted', onClientAbort);

      pipeline(file, res, (err) => {
        res.off('close', onClientAbort);
        res.off('aborted', onClientAbort);
        if (err) {
          // "Premature close" is expected when client aborts (seeking, quality change, etc.)
          // Downgrade to debug level since it's not a real error
          if (err.message === 'Premature close' || err.message.includes('Premature close')) {
            debug('Pipeline: Client aborted full video request (expected behavior)');
          } else {
            error('Pipeline error serving full video:', err.message);
          }
        } else {
          debug('Full file pipeline completed successfully');
        }
      });
    }
  } catch (error) {
    error('Error serving video:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Video info endpoint for debugging
app.get("/api/video/info", authenticate, (req, res) => {
  try {
    let videoPath = req.query.path || 'C:/MyApps/Hunico/Uploads/Media/System/1/gp50/20240829/video1.mp4';
    
    // Convert Windows path to container path if running in Docker
    videoPath = convertPathForContainer(videoPath);
    
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Video file not found', path: videoPath });
    }

    const stat = fs.statSync(videoPath);
    res.json({
      path: videoPath,
      size: stat.size,
      sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
      created: stat.birthtime,
      modified: stat.mtime,
      exists: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Error getting video info', message: error.message });
  }
});

// Listen on all interfaces to accept connections from network IPs
const appHost = '0.0.0.0';
app.listen(config.MEDIA_PORT, appHost, () => {
  const timestamp = new Date().toISOString();
  logAlways(`[${timestamp}] Media server running on ${appHost}:${config.MEDIA_PORT} (accessible from network)`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});