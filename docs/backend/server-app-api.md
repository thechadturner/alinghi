RaceSight Application Server API

Overview
The application server exposes authenticated REST endpoints under the /api namespace. All endpoints require JWT auth (bearer token cookie/header) and CSRF protection for state-changing requests. See Auth and CSRF below.

Base URL
- /api/auth
- /api/users
- /api/classes
- /api/projects
- /api/sources
- /api/datasets
- /api/events
- /api/media
- /api/pages
- /api/data
- /api/targets

Auth
- JWT bearer token stored in cookie or Authorization header
- Endpoints: /api/auth/user, /api/auth/login, /api/auth/register, /api/auth/verify, /api/auth/refresh, /api/auth/logout, /api/auth/forgot-password, /api/auth/reset-password

CSRF
- CSRF tokens are issued by middleware and expected via X-CSRF-Token
- Required for POST/PUT/DELETE

Key Conventions
- class_name validated as simple name
- project_id, dataset_id are integers
- Data field names: original case for display; convert to lowercase for internal data keys in clients

High-Level Endpoints
Users
- GET /api/users/all
- GET /api/users/active?id=...
- GET /api/users/permissions?id=...&project_id=...
- GET /api/users/api_key?id=...
- GET /api/users?id=...
- POST /api/users
- PUT /api/users/update
- PUT /api/users/update/subscription
- PUT /api/users/disable?id=...
- DELETE /api/users?id=...
- User objects: GET/POST/DELETE /api/users/object, plus GET /api/users/object/names

Classes
- GET /api/classes
- GET /api/classes/object?class_name&project_id&object_name

Projects
- GET /api/projects (documented separately in OpenAPI)
- GET /api/projects/users?project_id
- GET /api/projects/type?type
- GET /api/projects/class?project_id
- GET /api/projects/id?project_id
- GET /api/projects/object?class_name&project_id&object_name
- POST /api/projects
- PUT /api/projects
- DELETE /api/projects

Sources
- GET/POST/PUT/DELETE /api/sources

Datasets
- GET /api/datasets/years?class_name&project_id&source_id
- GET /api/datasets/events?class_name&project_id&source_id&year
- GET /api/datasets/info?class_name&project_id&dataset_id
- GET /api/datasets/tags?class_name&project_id&dataset_id
- GET /api/datasets/count?class_name&project_id
- GET /api/datasets/id?class_name&project_id&dataset_id
- GET /api/datasets?class_name&project_id&source_id&year&event
- GET /api/datasets/object?class_name&project_id&dataset_id&parent_name&object_name
- POST /api/datasets
- PUT /api/datasets
- PUT /api/datasets/tags
- PUT /api/datasets/visibility
- DELETE /api/datasets

Events
- GET /api/events?class_name&project_id&dataset_id&event_type
- GET /api/events/info?class_name&project_id&dataset_id&event_type
- GET /api/events/times?class_name&project_id&dataset_id&event_list
- GET /api/events/object?class_name&project_id&event_id&table&desc

Media
- GET /api/media/sources?class_name&project_id&date
- GET /api/media?class_name&project_id&media_source&date

Pages
- GET /api/pages/selection?class_name&project_id&page_type
- GET /api/pages?class_name&project_id&page_type

Data
- GET /api/data/maneuvers-table-data?class_name&project_id&dataset_id&event_type
- GET /api/data/maneuvers-map-data?class_name&project_id&dataset_id&event_type&desc
- GET /api/data/maneuvers-timeseries-data?class_name&project_id&dataset_id&event_type&desc
- GET /api/data/channels?project_id&table_name
- GET /api/data/performance-data?class_name&project_id&dataset_id&event_type&agr_type&channels
- GET /api/data/fleet-performance-data?class_name&project_id&... (fleet-level performance)

Performance and fleet-performance data responses
- Each row includes a `timezone` field (from the dataset). Timestamps/datetime in the response are in UTC. Clients should use the row’s `timezone` (e.g. IANA such as `Australia/Perth`) to convert to local time for display (tooltips, labels, etc.). See frontend `formatDateTime`/`formatDate` in `frontend/utils/global.ts` and the performance/fleet data services that pass `item.timezone` into formatting.

Targets
- GET /api/targets/channels?class_name&project_id
- GET /api/targets?class_name&project_id&isPolar
- GET /api/targets/data?class_name&project_id&name&isPolar
- GET /api/targets/latest?class_name&project_id&isPolar

Health and Readiness
- GET /api/health → { status: 'ok', service: 'app', ... }
- GET /api/ready  → DB connectivity check

Notes
- All state-changing endpoints require CSRF token and auth
- Validation errors are returned with messages per express-validator

