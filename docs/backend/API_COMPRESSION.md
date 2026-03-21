# API Response Compression

## Overview

All API servers use optimized compression middleware to reduce response sizes and improve performance. Compression is automatically applied to JSON responses and other text-based content types.

## Configuration

All servers use the following standardized compression configuration:

```javascript
app.use(compression({
  level: 6,                    // Compression level (0-9): 6 provides good balance
  threshold: 1024,            // Only compress responses larger than 1KB
  filter: (req, res) => {
    // Skip compression for video endpoints and when explicitly disabled
    if (req.headers['x-no-compression'] || req.path.startsWith('/api/video')) {
      return false;
    }
    // Compress JSON, text, and other compressible content types
    const contentType = res.getHeader('content-type') || '';
    return /json|text|javascript|css|xml|html|svg/i.test(contentType);
  }
}));
```

## Compression Settings

### Compression Level (6)
- **Range**: 0-9
- **Current**: 6
- **Rationale**: Provides optimal balance between compression ratio and CPU usage
  - Level 0-3: Fast compression, lower ratio
  - Level 4-6: Balanced (recommended for most applications)
  - Level 7-9: Higher compression, more CPU intensive

### Threshold (1024 bytes)
- **Purpose**: Only compress responses larger than 1KB
- **Rationale**: 
  - Small responses don't benefit significantly from compression
  - Avoids CPU overhead for tiny responses
  - Reduces latency for small API calls

### Content Type Filter
Compression is applied to:
- ✅ `application/json`
- ✅ `text/*` (text/plain, text/html, text/css, etc.)
- ✅ `application/javascript`
- ✅ `application/xml`
- ✅ `image/svg+xml`

Compression is **NOT** applied to:
- ❌ `image/*` (png, jpg, gif, etc. - already compressed)
- ❌ `video/*` (mp4, webm, etc. - already compressed)
- ❌ `application/octet-stream` (binary data)
- ❌ Video streaming endpoints (`/api/video/*`)

## Servers with Compression

1. **server_app** (`server_app/server.js`)
   - Compresses all JSON API responses
   - Optimized for REST API endpoints

2. **server_admin** (`server_admin/server.js`)
   - Compresses admin API responses
   - Handles upload progress and logging endpoints

3. **server_file** (`server_file/server.js`)
   - Compresses file metadata responses
   - Optimized for channel data endpoints

4. **server_media** (`server_media/server.js`)
   - Compresses health check and metadata responses
   - **Excludes** video streaming endpoints (handled by filter)

## Usage

### Automatic Compression
Compression is automatic for all eligible responses. No code changes needed.

### Disabling Compression
To disable compression for a specific request, set the `x-no-compression` header:

```javascript
fetch('/api/endpoint', {
  headers: {
    'x-no-compression': 'true'
  }
});
```

### Client Support
Clients should include `Accept-Encoding` header:

```javascript
fetch('/api/endpoint', {
  headers: {
    'Accept-Encoding': 'gzip, deflate, br'
  }
});
```

Modern browsers automatically include this header.

## Performance Impact

### Typical Compression Ratios
- **JSON responses**: 60-80% size reduction
- **Text responses**: 70-90% size reduction
- **Large datasets**: 50-70% size reduction

### Example
A 100KB JSON response typically compresses to:
- **Compressed**: ~30-40KB (60-70% reduction)
- **Transfer time**: 60-70% faster on slow connections
- **CPU overhead**: Minimal (~1-2ms per response)

## Monitoring

### Check Compression Headers
```bash
curl -H "Accept-Encoding: gzip, deflate, br" \
     -v http://localhost:8069/api/projects \
     | grep -i "content-encoding"
```

Expected output:
```
< content-encoding: gzip
< vary: Accept-Encoding
```

### Verify Compression Ratio
```bash
# Uncompressed size
curl -H "x-no-compression: true" \
     http://localhost:8069/api/projects \
     -o uncompressed.json

# Compressed size
curl -H "Accept-Encoding: gzip" \
     http://localhost:8069/api/projects \
     -o compressed.json.gz

# Compare sizes
ls -lh uncompressed.json compressed.json.gz
```

## Testing

Compression is tested in `src/__tests__/integration/compression/compression.test.ts`:

```bash
npm run test:integration
```

Tests verify:
- ✅ Large JSON responses are compressed
- ✅ Small responses (< 1KB) are not compressed
- ✅ Content type filtering works correctly
- ✅ Compression headers are set properly
- ✅ Compression ratio is significant (> 50% for JSON)

## Troubleshooting

### Compression Not Working

1. **Check Accept-Encoding header**:
   ```bash
   curl -H "Accept-Encoding: gzip" -v http://localhost:8069/api/health
   ```

2. **Verify response size**:
   - Responses < 1KB are not compressed (by design)
   - Check `content-length` header

3. **Check content type**:
   - Only compressible types are compressed
   - Verify `content-type` header is set correctly

4. **Verify middleware order**:
   - Compression should be after `express.json()` but before routes
   - Check server configuration

### High CPU Usage

If compression causes high CPU usage:
1. Reduce compression level (try 4 instead of 6)
2. Increase threshold (try 2048 instead of 1024)
3. Monitor compression ratio vs CPU usage

### Large Response Sizes

If responses are still large after compression:
1. Check if compression is actually applied (`content-encoding` header)
2. Verify response is compressible (JSON, text, etc.)
3. Consider optimizing response data structure
4. Check for already-compressed data in response

## Best Practices

1. **Always include Accept-Encoding**: Clients should request compression
2. **Monitor compression ratios**: Track actual size reduction
3. **Tune threshold**: Adjust based on your typical response sizes
4. **Don't compress already-compressed data**: Images, videos, etc.
5. **Test compression**: Verify it's working in production

## Future Improvements

### Brotli Support
Currently using gzip (via compression middleware). For better compression:
- Consider `express-compression` package for brotli support
- Brotli provides 15-20% better compression than gzip
- Requires additional CPU but better for static assets

### Dynamic Compression Level
- Adjust compression level based on response size
- Use higher levels for very large responses
- Use lower levels for frequently-accessed endpoints

### Compression Caching
- Cache compressed responses for static data
- Reduce CPU usage for repeated requests
- Consider Redis or in-memory cache

