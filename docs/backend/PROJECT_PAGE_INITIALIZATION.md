# Project Page Initialization

## Overview

When a new project is created, the system automatically initializes default pages to ensure the sidebar menus are populated and functional. This document explains how this works and what needs to be configured.

## How It Works

### Automatic Initialization

When a project is created via `POST /api/projects`, the system:

1. Creates the project in `admin.projects`
2. Adds the creator as an administrator in `admin.user_projects`
3. **Automatically initializes default pages** by:
   - Adding all pages with `permission_level <= 2` to `{class_name}.project_pages`
   - Adding all explore pages to `{class_name}.user_pages` for the creating user

### Database Tables Involved

1. **`{class_name}.pages`** - Master list of available pages for a class
   - Contains page definitions with `page_type`, `page_name`, `permission_level`, etc.
   - Must be populated for each class before projects can use pages

2. **`{class_name}.project_pages`** - Links pages to projects
   - Determines which pages are available for a project
   - Used for project-level pages (reports, etc.)

3. **`{class_name}.user_pages`** - Links pages to users within a project
   - Determines which pages a user can see
   - Used for user-specific pages (dataset/explore, day/explore, etc.)

## Configuration for New Classes

### Step 1: Populate the `pages` Table

For each new class (e.g., `gp50`, `ac75`), you must populate the `{class_name}.pages` table with available pages:

```sql
INSERT INTO {class_name}.pages (page_id, sort_id, page_type, page_name, description, path_name, icon, permission_level)
VALUES 
  (1, 1, 'dataset/explore', 'TIME SERIES', 'Time Series Chart', 'TimeSeries', 'chart-line', 1),
  (2, 2, 'dataset/explore', 'SCATTER', 'Scatter Plot', 'Scatter', 'chart-scatter', 1),
  (3, 3, 'dataset/explore', 'POLAR ROSE', 'Polar Rose Chart', 'PolarRose', 'chart-pie', 1),
  (4, 4, 'dataset/explore', 'PROBABILITY', 'Probability Chart', 'Probability', 'chart-bar', 1),
  (5, 5, 'dataset/explore', 'TABLE', 'Data Table', 'Table', 'table', 1),
  (6, 6, 'dataset/explore', 'GRID', 'Grid View', 'Grid', 'grid', 1),
  (7, 7, 'dataset/explore', 'PARALLEL', 'Parallel Coordinates', 'Parallel', 'chart-line', 1),
  (8, 8, 'dataset/explore', 'VIDEO', 'Video Player', 'Video', 'video', 1),
  (9, 9, 'dataset/explore', 'BOAT', 'Boat View', 'Boat', 'ship', 1),
  (10, 10, 'dataset/explore', 'MAP', 'Map View', 'Map', 'map', 1),
  (11, 11, 'dataset/explore', 'MANEUVERS', 'Maneuvers', 'Maneuvers', 'route', 1),
  (12, 12, 'dataset/reports', 'PERFORMANCE', 'Performance Report', 'Performance', 'chart-bar', 2),
  (13, 13, 'project/reports', 'SUMMARY', 'Project Summary', 'Summary', 'file-text', 2);
```

### Step 2: Permission Levels

- **Level 0-1**: Basic pages available to all projects (explore pages, basic reports)
- **Level 2**: Standard pages (standard reports, summaries)
- **Level 3+**: Premium pages (advanced features, premium reports)

The initialization function uses `permission_level <= 2` as the default, which includes basic and standard pages.

### Step 3: Page Types

Pages are categorized by `page_type`:

- **`dataset/explore`**: Pages shown when viewing a specific dataset
- **`day/explore`**: Pages shown when viewing a specific date (fleet mode)
- **`project/explore`**: Pages shown at project level
- **`dataset/reports`**: Report pages for datasets
- **`day/reports`**: Report pages for days
- **`project/reports`**: Report pages for projects
- **`live/explore`**: Pages for live data viewing

## Manual Fix for Existing Projects

If you have an existing project that doesn't have pages initialized, you can run this SQL:

```sql
-- Replace {class_name} and {project_id} with actual values
-- Replace {user_id} with the project creator's user_id

-- 1. Add all pages with permission_level <= 2 to project_pages
INSERT INTO {class_name}.project_pages (project_id, page_id, date_modified)
SELECT {project_id}, page_id, CURRENT_DATE
FROM {class_name}.pages
WHERE permission_level <= 2
ON CONFLICT (project_id, page_id) DO NOTHING;

-- 2. Add explore pages to user_pages for the creator
INSERT INTO {class_name}.user_pages (user_id, page_id, date_modified)
SELECT {user_id}, page_id, CURRENT_DATE
FROM {class_name}.pages
WHERE permission_level <= 2 
  AND page_type LIKE '%explore%'
ON CONFLICT (user_id, page_id) DO NOTHING;
```

## Troubleshooting

### Issue: Sidebar shows no menus when viewing a dataset

**Symptoms:**
- Console shows: `⚠️ No dataset explore pages found`
- Sidebar is empty

**Causes:**
1. `{class_name}.pages` table is empty or missing pages
2. `{class_name}.project_pages` has no entries for the project
3. `{class_name}.user_pages` has no entries for the user

**Solution:**
1. Check if pages exist: `SELECT * FROM {class_name}.pages WHERE permission_level <= 2`
2. Check project_pages: `SELECT * FROM {class_name}.project_pages WHERE project_id = {project_id}`
3. Check user_pages: `SELECT * FROM {class_name}.user_pages WHERE user_id = {user_id}`
4. If missing, run the manual fix SQL above

### Issue: Some pages are missing

**Causes:**
- Pages have `permission_level > 2` and weren't included
- Pages weren't added to the `pages` table

**Solution:**
- Either lower the `permission_level` for those pages, or
- Manually add them to `project_pages` and `user_pages` as needed

## Code Reference

The initialization logic is in:
- `server_app/controllers/projects.js` - `initializeProjectPages()` function
- Called automatically from `addProject()` after project creation

