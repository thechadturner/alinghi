-- Add Instrument Calibration report page to ac40 dataset reports.
-- Run once per class schema (e.g. ac40). Ensures the Calibration page appears in Dataset Reports sidebar.
-- New projects will get this page automatically via initializeProjectPages. This script adds the page
-- to ac40.pages and optionally to project_pages for existing projects.

-- 1. Insert the Calibration page into ac40.pages (page_id uses sequence default).
INSERT INTO ac40.pages (sort_id, page_type, page_name, description, path_name, icon, permission_level, date_created)
SELECT 100, 'dataset/reports', 'Calibration', 'Instrument Calibration', 'Calibration', NULL, 0, CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM ac40.pages WHERE page_type = 'dataset/reports' AND path_name = 'Calibration');

-- 2. Add the new page to project_pages for all existing projects so it appears in the sidebar.
-- If your project_pages table has is_visible, use the first INSERT. If not, use the second (uncomment and comment the first).
INSERT INTO ac40.project_pages (project_id, page_id, date_modified, is_visible)
SELECT p.project_id, pg.page_id, CURRENT_DATE, 1
FROM admin.projects p
CROSS JOIN ac40.pages pg
WHERE pg.page_type = 'dataset/reports' AND pg.path_name = 'Calibration'
  AND NOT EXISTS (
    SELECT 1 FROM ac40.project_pages pp
    WHERE pp.project_id = p.project_id AND pp.page_id = pg.page_id
  );
-- If the above fails with "column is_visible does not exist", use this instead:
-- INSERT INTO ac40.project_pages (project_id, page_id, date_modified)
-- SELECT p.project_id, pg.page_id, CURRENT_DATE
-- FROM admin.projects p
-- CROSS JOIN ac40.pages pg
-- WHERE pg.page_type = 'dataset/reports' AND pg.path_name = 'Calibration'
--   AND NOT EXISTS (SELECT 1 FROM ac40.project_pages pp WHERE pp.project_id = p.project_id AND pp.page_id = pg.page_id);
