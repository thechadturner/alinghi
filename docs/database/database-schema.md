# Database Schema Documentation

This document describes the complete database schema as defined in `database/hunico_database_emptry.sql`.

**Last Updated**: Based on schema dump from `hunico_database_emptry.sql`

## Schema Overview

The database uses a multi-schema architecture with three main schemas:

- **`admin`**: System administration, users, authentication, and project management
- **`ac75`**: AC75 class-specific tables (datasets, events, media, targets, etc.)
- **`gp50`**: GP50 class-specific tables (mirrors ac75 structure)

**Total**: 57 tables, 87 indexes, 5 functions, 6 views

## Schema: `admin`

The admin schema contains system-level tables for user management, authentication, projects, and administrative functions.

### Tables (15 tables)

#### `admin.users`
User accounts and authentication information.
- `user_id` (UUID, PK): Unique user identifier
- `email` (text): User email address
- `password_hash` (text): Hashed password
- `first_name` (text): User's first name
- `last_name` (text): User's last name
- `user_name` (text): Username
- `subscription_type` (text): Subscription level
- `subscription_expires_at` (timestamp): Subscription expiration
- `secret_code` (text): Verification code
- `verification_expires_at` (timestamp): Verification expiration
- `verification_attempts` (integer): Number of verification attempts
- `password_reset_code` (text): Password reset code
- `password_reset_expires_at` (timestamp): Password reset expiration
- `password_reset_attempts` (integer): Password reset attempts
- `created_at` (timestamp): Account creation timestamp
- `updated_at` (timestamp): Last update timestamp
- `tags` (jsonb): Additional user metadata

#### `admin.users_unverified`
Temporary storage for unverified user registrations.
- `user_id` (UUID, PK): Temporary user identifier
- `email` (text): Email address
- `password_hash` (text): Hashed password
- `first_name` (text): First name
- `last_name` (text): Last name
- `secret_code` (text): Verification code
- `expires_at` (timestamp): Expiration timestamp

#### `admin.users_pending`
Users pending approval or activation.
- Similar structure to `users_unverified`

#### `admin.personal_api_tokens`
API authentication tokens for users.
- `token_id` (UUID, PK): Token identifier
- `user_id` (UUID, FK → users.user_id): User who owns the token
- `name` (text): Token name/description
- `token_hash` (text): Hashed token value
- `scopes` (text[]): Array of permission scopes
- `ip_allowlist` (text[]): Allowed IP addresses
- `project_ids` (integer[]): Allowed project IDs
- `created_at` (timestamp): Creation timestamp
- `last_used_at` (timestamp): Last usage timestamp
- `expires_at` (timestamp): Expiration timestamp
- `revoked_at` (timestamp): Revocation timestamp
- `created_by` (UUID): User who created the token

#### `admin.projects`
Project definitions.
- `project_id` (integer, PK): Project identifier
- `project_name` (text): Project name
- `class_id` (integer, FK → classes.class_id): Associated class
- `user_id` (UUID, FK → users.user_id): Project owner
- `date_modified` (date): Last modification date

#### `admin.user_projects`
User-project access permissions (many-to-many).
- `user_id` (UUID, FK → users.user_id): User identifier
- `project_id` (integer, FK → projects.project_id): Project identifier
- `permissions` (text): Permission level

#### `admin.classes`
Class definitions (AC75, GP50, etc.).
- `class_id` (integer, PK): Class identifier
- `class_name` (text): Class name

#### `admin.user_settings`
User preferences and settings.
- `user_id` (UUID, FK → users.user_id): User identifier
- `settings` (jsonb): Settings data

#### `admin.user_subscriptions`
User subscription history.
- `subscription_id` (integer, PK): Subscription identifier
- `user_id` (UUID, FK → users.user_id): User identifier
- `subscription_type` (text): Subscription type
- `start_date` (date): Start date
- `end_date` (date): End date
- `created_at` (timestamp): Creation timestamp

#### `admin.billing_events`
Billing and payment events.
- `event_id` (integer, PK): Event identifier
- `user_id` (UUID, FK → users.user_id): User identifier
- `event_type` (text): Event type
- `amount` (numeric): Amount
- `created_at` (timestamp): Event timestamp

#### `admin.log_activity`
System activity logs.
- `log_id` (integer, PK): Log entry identifier
- `user_id` (UUID): User who performed action
- `action` (text): Action type
- `details` (jsonb): Action details
- `created_at` (timestamp): Log timestamp

#### `admin.user_activity`
User activity tracking.
- `activity_id` (integer, PK): Activity identifier
- `user_id` (UUID, FK → users.user_id): User identifier
- `activity_type` (text): Type of activity
- `details` (jsonb): Activity details
- `created_at` (timestamp): Activity timestamp

#### `admin.token_blacklist`
Revoked JWT tokens.
- `token_id` (text, PK): Token identifier
- `expires_at` (timestamp): Token expiration

#### `admin.user_migrations`
User migration tracking.
- `migration_id` (integer, PK): Migration identifier
- `user_id` (UUID, FK → users.user_id): User identifier
- `migration_type` (text): Migration type
- `status` (text): Migration status
- `created_at` (timestamp): Migration timestamp

#### `admin.user_rules`
User-specific business rules.
- `rule_id` (integer, PK): Rule identifier
- `user_id` (UUID, FK → users.user_id): User identifier
- `rule_name` (text): Rule name
- `rule_data` (jsonb): Rule configuration

### Functions (5 functions)

1. **`admin.cleanup_expired_verifications()`**
   - Returns: TABLE(deleted_unverified integer, expired_verifications integer, expired_password_resets integer)
   - Purpose: Cleans up expired verification records and returns cleanup statistics

2. **`admin.project_updated()`**
   - Returns: TRIGGER
   - Purpose: Trigger function to update `date_modified` on project updates

3. **`admin.truncate_activity_tables()`**
   - Returns: void
   - Purpose: Truncates activity logging tables

4. **`admin.truncate_logs()`**
   - Returns: void
   - Purpose: Truncates log activity table

5. **`admin.validate_password_strength(password text)`**
   - Returns: boolean
   - Purpose: Validates password strength (8+ chars, 1+ upper, 1+ lower, 1+ number, 1+ special char)

### Views (4 views)

1. **`admin.active_personal_api_tokens`**: Active (non-revoked) API tokens
2. **`admin.active_user_subscriptions`**: Currently active user subscriptions
3. **`admin.latest_billing_events`**: Most recent billing events per user
4. **`admin.latest_user_subscriptions`**: Latest subscription status per user

### Indexes (33 indexes)

Key indexes in admin schema:
- User lookups: `idx_users_email`, `idx_users_user_id`
- Project queries: `idx_projects_user_id`, `idx_projects_class_id`
- Permission checks: `idx_user_projects_user_id`, `idx_user_projects_project_id` (CRITICAL - very frequent)
- Token authentication: `idx_personal_api_tokens_hash`, `idx_personal_api_tokens_user`
- Subscription queries: `idx_user_subscriptions_user_id`, `idx_user_subscriptions_active`

## Schema: `ac75` and `gp50`

These schemas have identical structure but separate data. Each contains class-specific tables for datasets, events, media, targets, and user objects.

### Tables (21 tables per schema)

#### Core Data Tables

**`{schema}.datasets`**
Dataset metadata and information.
- `dataset_id` (integer, PK): Dataset identifier
- `source_id` (integer, FK → sources.source_id): Associated source
- `date` (date): Dataset date
- `year_name` (text): Year identifier
- `event_name` (text): Event name
- `report_name` (text): Report name
- `description` (text): Dataset description
- `tags` (jsonb): Additional metadata tags
- `visible` (integer, default 0): Visibility flag
- `shared` (integer, default 0): Sharing flag
- `timezone` (text, default 'Europe/Madrid'): Timezone
- `date_modified` (timestamp, default CURRENT_TIMESTAMP): Last modification

**`{schema}.sources`**
Data sources (boats, teams, etc.).
- `source_id` (integer, PK): Source identifier
- `project_id` (integer, FK → admin.projects.project_id): Associated project
- `source_name` (text): Source name
- `class_name` (text): Class name
- `color` (text): Display color
- `visible` (integer): Visibility flag
- `fleet` (integer): Fleet identifier

**`{schema}.dataset_events`**
Events within datasets (races, maneuvers, etc.).
- `event_id` (integer, PK): Event identifier
- `dataset_id` (integer, FK → datasets.dataset_id): Associated dataset
- `event_type` (text): Event type (tack, gybe, mark, start, finish, etc.)
- `start_time` (timestamp with time zone): Event start time
- `end_time` (timestamp with time zone): Event end time
- `duration` (double precision): Event duration
- `tags` (jsonb): Event metadata (Race_number, Leg_number, etc.)

**`{schema}.events_aggregate`**
Aggregated performance data for events.
- `agr_id` (integer, PK): Aggregate identifier
- `event_id` (integer, FK → dataset_events.event_id): Associated event
- `agr_type` (text): Aggregation type (none, avg, min, max, std, aav)
- Additional columns for aggregated channel data

**`{schema}.events_cloud`**
Cloud/point cloud data for events.
- `cloud_id` (integer, PK): Cloud data identifier
- `event_id` (integer, FK → dataset_events.event_id): Associated event
- Additional columns for cloud data points

**`{schema}.events_mapdata`**
Map visualization data for events.
- `mapdata_id` (integer, PK): Map data identifier
- `event_id` (integer, FK → dataset_events.event_id): Associated event
- `description` (text): Data description
- Additional columns for map coordinates and data

**`{schema}.events_timeseries`**
Time series data for events.
- `timeseries_id` (integer, PK): Time series identifier
- `event_id` (integer, FK → dataset_events.event_id): Associated event
- `description` (text): Data description
- Additional columns for time series data points

**`{schema}.maneuver_stats`**
Statistics for maneuvers.
- `stat_id` (integer, PK): Statistic identifier
- `event_id` (integer, FK → dataset_events.event_id): Associated event
- `vmg_perc_avg` (double precision): Average VMG percentage
- Additional statistical columns

**`{schema}.media`**
Media files (videos, images) associated with projects.
- `media_id` (integer, PK): Media identifier
- `project_id` (integer, FK → admin.projects.project_id): Associated project
- `class_name` (text): Class name
- `start_time` (timestamp): Media start time
- `end_time` (timestamp): Media end time
- `duration` (double precision): Media duration
- `file_name` (text): File name
- `media_source` (text): Media source identifier
- `tags` (jsonb): Media metadata
- `shared` (integer): Sharing flag
- `date` (date): Media date

**`{schema}.targets`**
Performance targets (polar diagrams, etc.).
- `target_id` (integer, PK): Target identifier
- `project_id` (integer, FK → admin.projects.project_id): Associated project
- `class_name` (text): Class name
- `name` (text): Target name
- `isPolar` (integer): Polar target flag
- `json` (jsonb): Target data (coordinates, etc.)
- `date_modified` (date): Last modification date

#### Object Storage Tables

**`{schema}.class_objects`**
Class-level configuration objects (filters, etc.).
- `object_id` (integer, PK): Object identifier
- `object_name` (text): Object name (e.g., 'filters')
- `json` (jsonb): Object data
- `date_modified` (date): Last modification date

**`{schema}.project_objects`**
Project-level configuration objects.
- `object_id` (integer, PK): Object identifier
- `project_id` (integer, FK → admin.projects.project_id): Associated project
- `object_name` (text): Object name
- `json` (jsonb): Object data
- `date` (date): Object date
- `date_modified` (date): Last modification date

**`{schema}.user_objects`**
User-specific objects (chart configurations, etc.).
- `object_id` (integer, PK): Object identifier
- `user_id` (UUID, FK → admin.users.user_id): User identifier
- `project_id` (integer, FK → admin.projects.project_id): Associated project
- `parent_name` (text): Parent component name
- `object_name` (text): Object name
- `json` (jsonb): Object data
- `date_modified` (date): Last modification date

**`{schema}.dataset_objects`**
Dataset-specific objects.
- `object_id` (integer, PK): Object identifier
- `dataset_id` (integer, FK → datasets.dataset_id): Associated dataset
- `parent_name` (text): Parent component name
- `object_name` (text): Object name
- `json` (jsonb): Object data
- `date_modified` (date): Last modification date

#### Page Management Tables

**`{schema}.pages`**
Page definitions.
- `page_id` (integer, PK): Page identifier
- `project_id` (integer, FK → admin.projects.project_id): Associated project
- `page_type` (text): Page type
- `page_name` (text): Page name
- `json` (jsonb): Page configuration
- `date_modified` (date): Last modification date

**`{schema}.project_pages`**
Project-page associations.
- `project_id` (integer, FK → admin.projects.project_id): Project identifier
- `page_id` (integer, FK → pages.page_id): Page identifier
- `date_modified` (date): Last modification date

**`{schema}.user_pages`**
User-page associations.
- `user_id` (UUID, FK → admin.users.user_id): User identifier
- `page_id` (integer, FK → pages.page_id): Page identifier
- `date_modified` (date): Last modification date

**`{schema}.dataset_pages`**
Dataset-page associations.
- `dataset_id` (integer, FK → datasets.dataset_id): Dataset identifier
- `page_id` (integer, FK → pages.page_id): Page identifier
- `date_modified` (date): Last modification date

#### Additional Tables

**`{schema}.comments`**
Comments on datasets.
- `comment_id` (integer, PK): Comment identifier
- `dataset_id` (integer, FK → datasets.dataset_id): Associated dataset
- `user_id` (UUID, FK → admin.users.user_id): Comment author
- `datetime` (timestamp with time zone): Comment timestamp
- `comment` (text): Comment text

**`{schema}.dataset_sharing`**
Dataset sharing configuration.
- `id` (integer, PK): Sharing identifier
- `dataset_id` (integer, FK → datasets.dataset_id): Associated dataset
- `project_id` (integer, FK → admin.projects.project_id): Shared project
- `active` (integer, default 1): Active flag
- `created_at` (timestamp): Creation timestamp
- `updated_at` (timestamp): Update timestamp

**`{schema}.dataset_targets`**
Dataset-target associations.
- `dataset_id` (integer, FK → datasets.dataset_id): Dataset identifier
- `target_id` (integer, FK → targets.target_id): Target identifier
- `tack` (text, NOT NULL): Tack identifier

### Views (1 view per schema)

**`{schema}.fleet_datasets`**: View aggregating fleet dataset information

### Indexes (27 indexes per schema)

Key indexes for performance:

**Datasets:**
- `idx_datasets_source_date` (CRITICAL): `(source_id, date DESC)` - Most common query pattern
- `idx_datasets_source_year_event`: `(source_id, year_name, event_name)` - Year/event filtering

**Dataset Events:**
- `idx_dataset_events_dataset_id` (CRITICAL): `(dataset_id, event_id DESC)` - Event lookups
- `idx_dataset_events_dataset_type` (CRITICAL): `(dataset_id, event_type, start_time)` - Type filtering
- `idx_dataset_events_type_time_range`: `(event_type, start_time, end_time, dataset_id)` - Time range queries
- `idx_dataset_events_search`: `(dataset_id, event_type, start_time, end_time, event_id DESC)` - Complex searches
- `idx_dataset_events_filters`: `(event_type, dataset_id)` - Filter queries

**Events Data:**
- `idx_events_aggregate_event_agr` (CRITICAL): `(event_id, agr_type)` - Performance data queries
- `idx_events_aggregate_event_id`: `(event_id)` - Event lookups
- `idx_events_cloud_event_id` (CRITICAL): `(event_id)` - Cloud data queries
- `indx_events_mapdata_event_id`: `(event_id)` - Map data queries
- `indx_event_ts_event_id`: `(event_id)` - Time series queries
- `idx_maneuver_stats_event_id`: `(event_id)` - Maneuver statistics

**Sources:**
- `idx_sources_project_id`: `(project_id)` - Project source queries
- `idx_sources_project_name`: `(project_id, source_name DESC)` - Sorted source lists

**Media:**
- `idx_media_date_source`: `(start_time::date, media_source)` - Date-based media queries

**Foreign Key Indexes:**
- `fki_project_objects_fk`: `(project_id)` on project_objects
- `fki_project_pages_fk`: `(project_id)` on project_pages
- `fki_sources_fk`: `(project_id)` on sources
- `fki_targets_fk`: `(project_id)` on targets
- `fki_user_objects_fk`: `(user_id)` on user_objects
- `fki_user_pages_fk`: `(user_id)` on user_pages

## Index Summary

### Total Indexes by Schema

- **admin**: 33 indexes
- **ac75**: 27 indexes  
- **gp50**: 27 indexes
- **Total**: 87 indexes

### Index Status

All recommended critical indexes are **implemented** in the schema file (`hunico_database_emptry.sql`). Databases created from this schema will have all indexes pre-created.

For existing databases, run `database/migrations/audit_existing_indexes.sql` to verify which indexes are present.

### Critical Indexes (All Implemented)

These indexes are defined in the schema and are critical for performance:

1. **`idx_datasets_source_date`** - Dataset queries by source and date (CRITICAL)
2. **`idx_dataset_events_dataset_id`** - Event queries by dataset (CRITICAL)
3. **`idx_dataset_events_dataset_type`** - Event type filtering (CRITICAL)
4. **`idx_user_projects_user_id`** - Permission checks (CRITICAL - very frequent)
5. **`idx_events_aggregate_event_agr`** - Performance data queries (CRITICAL)
6. **`idx_events_cloud_event_id`** - Cloud data queries (CRITICAL)

### Index Maintenance

See `docs/database/database-index-recommendations.md` for detailed index recommendations and maintenance procedures.

## Data Field Case Rules (Frontend)

- API returns lowercase keys for data rows
- Config field names should be converted to lowercase for indexing but preserve original case for labels
- See `docs/frontend/` for frontend-specific field naming conventions

## Schema Relationships

### Foreign Key Relationships

**admin schema:**
- `user_projects.user_id` → `users.user_id`
- `user_projects.project_id` → `projects.project_id`
- `projects.class_id` → `classes.class_id`
- `personal_api_tokens.user_id` → `users.user_id`

**ac75/gp50 schemas:**
- `datasets.source_id` → `sources.source_id`
- `sources.project_id` → `admin.projects.project_id`
- `dataset_events.dataset_id` → `datasets.dataset_id`
- `events_aggregate.event_id` → `dataset_events.event_id`
- `events_cloud.event_id` → `dataset_events.event_id`
- `events_mapdata.event_id` → `dataset_events.event_id`
- `events_timeseries.event_id` → `dataset_events.event_id`
- `maneuver_stats.event_id` → `dataset_events.event_id`
- `user_objects.user_id` → `admin.users.user_id`
- `user_objects.project_id` → `admin.projects.project_id`
- `project_objects.project_id` → `admin.projects.project_id`

## Notes

- The schema uses PostgreSQL 17.6
- All timestamps use `timestamp with time zone` for proper timezone handling
- JSONB columns are used for flexible metadata storage (tags, configurations, etc.)
- Sequences are used for auto-incrementing primary keys
- Views provide convenient access patterns for common queries
- Functions handle cleanup and validation tasks

