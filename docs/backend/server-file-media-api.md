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
  - Example: `C:\MyApps\RaceSight\Uploads\Media\System\1\ac75\20240905\youtube\high_res\video1.mp4`
  - Converts to: `/media/System/1/ac75/20240905/youtube/high_res/video1.mp4`
- **Path Format**: Database stores paths with `{res}` placeholder for quality
  - Example: `C:\MyApps\RaceSight\Uploads\Media\System\1\ac75\20240905\youtube\{res}\video1.mp4`
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

