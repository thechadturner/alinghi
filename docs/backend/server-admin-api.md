RaceSight Admin Server API

Overview
Admin endpoints manage content (projects, datasets, events, targets, media), personal access tokens (PAT), and uploads. All endpoints require JWT auth and CSRF; some require superuser privileges.

Base URL
- /api/log
- /api/projects
- /api/datasets
- /api/events
- /api/targets
- /api/media
- /api/tokens
- /api/upload

Logging
- POST /api/log/activity { project_id?, dataset_id?, file_name, message, context }
- POST /api/log/message { file_name, message_type, message, context }
- POST /api/log/user-activity { user_id, activity_type, ... }

Projects
- POST /api/projects/object { class_name, project_id, object_name, json }
- POST /api/projects/page { class_name, project_id, page_name }
- DELETE /api/projects/page { class_name, project_id, page_name }

Datasets
- POST /api/datasets/object { class_name, project_id, dataset_id, object_name, json }
- POST /api/datasets/page { class_name, project_id, dataset_id, page_name }
- DELETE /api/datasets/page { class_name, project_id, dataset_id, page_name }

Events
- POST /api/events { class_name, project_id, dataset_id, event_type, start_time, end_time, tags }
- POST /api/events/array { class_name, project_id, dataset_id, events[] }
- POST /api/events/object { class_name, project_id, event_id, table, desc, json }
- POST /api/events/row { class_name, project_id, table, event_id, agr_type, json }
- POST /api/events/rows { class_name, project_id, table, event_id, agr_type, json }
- POST /api/events/aggregates { class_name, project_id, table, json }
- PUT /api/events/row { class_name, project_id, table, event_id, agr_type, column, value }
- PUT /api/events/rows { class_name, project_id, table, event_id, agr_type, json_str }
- DELETE /api/events { class_name, project_id, dataset_id, events[] }
- DELETE /api/events/rows { class_name, project_id, event_id, table }
- DELETE /api/events/by_event_type { class_name, project_id, dataset_id, event_types[] }

Targets
- POST /api/targets { class_name, project_id, name, json, isPolar }
- DELETE /api/targets { class_name, project_id, name }

Media
- POST /api/media { class_name, project_id, start_time, end_time, duration, file_name, media_source, tags, shared }
- PUT /api/media { class_name, project_id, media_id, start_time, end_time }
- DELETE /api/media { class_name, project_id, file_name, media_source }

Tokens (PAT)
- POST /api/tokens { name, scopes[], expires_in_days, ip_allowlist?, project_ids? } (superuser)
- GET /api/tokens → list current user's tokens (metadata)
- DELETE /api/tokens/:id (superuser)

Uploads
- POST /api/upload/data  multipart form-data: files[], class_name, project_id, source_name
- POST /api/upload/target multipart form-data: files[], class_name, project_id
- POST /api/upload/polar  multipart form-data: files[], class_name, project_id
- POST /api/upload/video  multipart form-data: files[], class_name, project_id, date (YYYYMMDD), media_source?

Video upload can run in two modes: normal (ffmpeg produces low/med/high res) or bypass (save directly as med_res only, no ffmpeg). See [VIDEO_UPLOAD_BYPASS_AND_MED_RES_ONLY.md](VIDEO_UPLOAD_BYPASS_AND_MED_RES_ONLY.md) for env vars and behavior.

Progress Streams
- SSE: GET /api/events/upload-progress
- Poll: GET /api/upload/progress?since=<ts>

Health
- GET /api/health, /api/ready

