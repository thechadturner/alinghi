# Video Upload Bypass and Med-Res-Only Playback

This document describes the optional **video upload bypass** (no server-side ffmpeg) and **med_res-only playback** mode. Use this when you process videos on the client before upload and want to save VM space and avoid long server-side encoding.

## Why This Exists

- **Large files**: Uploading multi-GB videos and then running ffmpeg on the server is slow and resource-heavy.
- **Client-side processing**: You may already encode to a single resolution (e.g. “med” quality) on the client before upload.
- **VM space**: Storing Raw + low_res + med_res + high_res uses a lot of disk; with bypass, only one file (med_res) is stored.

## Two Modes

| Mode | Server behavior | Stored files | Player behavior |
|------|-----------------|--------------|------------------|
| **Normal** | Upload → Raw → ffmpeg → low_res, med_res, high_res | Raw + 3 renditions | Quality selector; can switch High/Med/Low; auto-downgrade on stall |
| **Bypass** | Upload → med_res only (no Raw, no ffmpeg) | Single file in med_res | Only med_res; no quality switching; no resolution badge |

## Environment Variables

### Server (server_admin)

| Variable | Values | Effect |
|----------|--------|--------|
| `SKIP_VIDEO_FFMPEG` | `true` = bypass, unset/false = normal | When `true`, uploaded video is moved directly to the med_res path. No Raw copy, no ffmpeg, no low_res/high_res. |

- Read from `.env` / `.env.local` or `process.env` (e.g. in Docker `environment:` or `env_file:`).
- See [docs/system/DOCKER_ENV_VARIABLES.md](../system/DOCKER_ENV_VARIABLES.md) for how env is loaded at runtime.

### Frontend

| Variable | Values | Effect |
|----------|--------|--------|
| `VITE_MEDIA_MED_RES_ONLY` | `true` = med_res only | Player uses med_res only: default quality is med_res, no quality downgrade on stall, resolution badge hidden. |

- Must be set at **build time** (Vite embeds `import.meta.env.VITE_*` in the bundle).
- Set in `.env` (e.g. `VITE_MEDIA_MED_RES_ONLY=true`) and rebuild or run dev so the frontend sees it.

## Enabling “Bypass + Med-Res Only”

Use both together when you only have a single med_res file and no server-side encoding:

1. **Server**  
   In `.env` (or process env for server_admin):
   ```bash
   SKIP_VIDEO_FFMPEG=true
   ```
   Restart the admin server (or the Node container) so it picks up the value.

2. **Frontend**  
   In `.env`:
   ```bash
   VITE_MEDIA_MED_RES_ONLY=true
   ```
   Rebuild the frontend or restart the dev server.

## Backend Behavior (server_admin)

- **Code**: [server_admin/controllers/uploads.js](../../server_admin/controllers/uploads.js) (`uploadVideo`).
- **Normal path** (when `SKIP_VIDEO_FFMPEG` is not `true`):
  1. Move uploaded file to `Raw/<project_id>/<class>/<date>/<media_source>/<fileName>`.
  2. Create media DB record (async) with `file_name` template containing `{res}`.
  3. Run `processVideoMulti` (ffmpeg) to produce low_res, med_res, high_res under `Media/System/...`.
  4. On completion, broadcast SSE `process_complete` with all three renditions.

- **Bypass path** (when `SKIP_VIDEO_FFMPEG=true`):
  1. Build path: `Media/System/<project_id>/<class>/<date>/<media_source>/med_res/<fileName>`.
  2. Create that directory if needed; **move** the upload temp file directly there (no Raw, no other copies).
  3. Create media DB record (async) with same `file_name` template (`{res}`); playback will request `med_res` and get this file.
  4. Optionally write metadata JSON next to the file (for compatibility).
  5. Immediately update batch state and broadcast `process_complete` with a single rendition (`med_res`). No ffmpeg, no fallback timer.

All ffmpeg and multi-resolution logic remains in the codebase (e.g. [server_admin/middleware/media.js](../../server_admin/middleware/media.js)); it is simply not used when the bypass is enabled.

## Frontend Behavior

- **Config**: [frontend/config/env.js](../../frontend/config/env.js) exposes `config.MEDIA_MED_RES_ONLY` from `VITE_MEDIA_MED_RES_ONLY`.
- **Player**: [frontend/components/charts/Video.tsx](../../frontend/components/charts/Video.tsx):
  - When `MEDIA_MED_RES_ONLY` is true:
    - Initial quality is `med_res` (not `high_res`).
    - The performance monitor does **not** downgrade quality on stall/buffer (no high → med → low).
    - The resolution badge (High/Med/Low) is hidden.

Playback still uses the same media URL helper (`getMediaUrl(fileName, quality)` with `quality === 'med_res'`); no API or URL shape changes.

## Storage Summary

- **Normal**: Upload temp → Raw; ffmpeg reads Raw and writes low_res, med_res, high_res; original in Raw can be deleted after processing (current implementation may keep or delete; see media.js).
- **Bypass**: Upload temp → **only** `Media/System/.../med_res/<fileName>`. No Raw, no low_res, no high_res. Single file on disk for that upload.

## Reverting to Server-Side Processing

- Set `SKIP_VIDEO_FFMPEG` to false or remove it, and restart the admin server.
- Set `VITE_MEDIA_MED_RES_ONLY` to false or remove it, and rebuild/restart the frontend.

No code or schema changes are required; behavior is fully controlled by these environment variables.
