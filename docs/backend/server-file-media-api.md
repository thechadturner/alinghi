RaceSight File and Media Servers

File Server (Metadata and Raw Channel Access)
Base URL: /api

Auth & CSRF
- Requires JWT auth and CSRF on state-changing routes

Endpoints
- GET /api/classes?project_id
- GET /api/dates?class_name&project_id
- GET /api/sources?class_name&project_id&date
- GET /api/channels?class_name&project_id&date&source_name
- POST /api/channel-values { class_name, project_id, date, source_name, channel_list[], start_ts?, end_ts? }
- POST /api/channel-groups { class_name, project_id, date, source_name, channel_names[] }

Health
- GET /api/health, /api/ready

Automated tests (concurrency / limiter)

- From repo root: `npm run test:server_file` (runs `server_file`’s `npm test`).
- Prerequisites: install dependencies in `server_file` once (`cd server_file && npm install`), same as Docker/VM deploy for that service.
- **Integration** ([`server_file/__tests__/integration/duckdb-concurrency.test.js`](../../server_file/__tests__/integration/duckdb-concurrency.test.js)): builds a small temp Parquet file, then runs **4 and 13 parallel** calls to `queryParquetFiles` (same global DuckDB path as production). Asserts all complete with **consistent row counts**; logs wall-clock time (for tuning). Optional second case uses **`1s` resolution** in parallel and asserts all results share the same length.
- **Unit** ([`server_file/__tests__/unit/concurrency-limiter.test.js`](../../server_file/__tests__/unit/concurrency-limiter.test.js)): [`middleware/concurrency_limiter.js`](../../server_file/middleware/concurrency_limiter.js) — `FILE_HEAVY_QUERY_MAX_CONCURRENT` parsing (`0`/unset = unlimited), `tryAcquire` / `acquire` behavior, and retry payload shape. The limiter is **not** wired into HTTP routes yet; use it when capping heavy `channel-values` traffic.
- The `npm test` script uses Node’s `--test-force-exit` so the process exits cleanly after the DuckDB integration tests (the native addon may otherwise keep the event loop open).
- `queryParquetFiles` clears its internal query timeout timer when a query finishes successfully or fails, so timers do not keep the server (or tests) alive for `DUCKDB_QUERY_TIMEOUT_MS` after each request.
- End-to-end HTTP load (many parallel clients through nginx) is **out of scope** here; use k6 or similar against staging if you need RPS/latency curves.

Media Server (Video Streaming)
Base URL: http://host:8089 (or proxied via /api/media/video)

Endpoints
- GET /api/video?path=absolute_path.mp4
  - Supports Range requests (bytes) for video seeking
  - GET /api/video (HEAD) returns Content-Length
  - Requires JWT authentication via cookies
  - Automatically converts Windows paths to container paths when running in Docker
- GET /api/video/info?path=absolute_path.mp4
  - Returns video file metadata (size, created, modified)
  - Requires JWT authentication

Health
- GET /api/health - Server health check
- GET /api/ready - Readiness check (verifies filesystem access)

Path Handling
- **Windows Paths**: Automatically converted to container paths in Docker
  - Example: `C:\MyApps\RaceSight\Uploads\Media\system\1\ac75\20240905\youtube\high_res\video1.mp4`
  - Converts to: `/media/system/1/ac75/20240905/youtube/high_res/video1.mp4`
- **Path Format**: Database stores paths with `{res}` placeholder for quality
  - Example: `C:\MyApps\RaceSight\Uploads\Media\system\1\ac75\20240905\youtube\{res}\video1.mp4`
  - Frontend replaces `{res}` with `high_res`, `med_res`, or `low_res`

Video Quality Management
- **Default Quality**: `high_res` (highest quality)
- **Quality Selection**: Based on connection performance
  - Starts at `high_res` by default
  - Downgrades to `med_res` if buffering detected (after 5-second grace period)
  - Downgrades to `low_res` if buffering continues
- **Quality Folders**: Videos are stored in resolution-specific folders:
  - `high_res/` - Full resolution (original or high quality)
  - `med_res/` - Medium resolution (1280px width)
  - `low_res/` - Low resolution (640px width, for slow connections)
- **Buffering Detection**: Only triggers during actual playback, not initial load
  - Monitors `readyState` and playback stalling
  - Requires video to be playing (`currentTime > 0`) before detecting buffering

Notes
- Media server enforces auth via shared middleware; falls back if unavailable (development)
- Responses expose Content-Range/Length headers and accept Range requests
- Server binds to `0.0.0.0` to accept connections from any network interface
- In Docker, media directory is mounted at `/media` and paths are automatically converted

