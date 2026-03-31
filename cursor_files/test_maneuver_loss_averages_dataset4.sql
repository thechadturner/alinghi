-- Test queries from getManeuverLossAverages for dataset_id 4
-- Schema: ac40 (change to your class_name if different)
-- Run in your PostgreSQL client (psql, DBeaver, etc.)

-- ========== RACE-LEVEL AGGREGATES ==========
SELECT e.dataset_id,
  (e.tags->>'Race_number')::int AS race_number,
  NULL::int AS leg_number,
  AVG(CASE WHEN e.event_type = 'TACK' THEN m."Loss_total_tgt" END) AS tack_loss_avg,
  AVG(CASE WHEN e.event_type = 'GYBE' THEN m."Loss_total_tgt" END) AS gybe_loss_avg,
  AVG(CASE WHEN e.event_type = 'ROUNDUP' THEN m."Loss_total_tgt" END) AS roundup_loss_avg,
  AVG(CASE WHEN e.event_type = 'BEARAWAY' THEN m."Loss_total_tgt" END) AS bearaway_loss_avg
FROM ac40.dataset_events e
INNER JOIN ac40.maneuver_stats m ON e.event_id = m.event_id
WHERE e.dataset_id = 4
  AND e.event_type IN ('TACK','GYBE','ROUNDUP','BEARAWAY')
  AND (e.tags->>'GRADE') IS NOT NULL AND (e.tags->>'GRADE') ~ '^[0-9]+$' AND (e.tags->>'GRADE')::int > 1
  AND (e.tags->>'Race_number') IS NOT NULL AND (e.tags->>'Race_number') ~ '^[0-9]+$'
GROUP BY e.dataset_id, (e.tags->>'Race_number');

-- ========== LEG-LEVEL AGGREGATES ==========
SELECT e.dataset_id,
  (e.tags->>'Race_number')::int AS race_number,
  (e.tags->>'Leg_number')::int AS leg_number,
  AVG(CASE WHEN e.event_type = 'TACK' THEN m."Loss_total_tgt" END) AS tack_loss_avg,
  AVG(CASE WHEN e.event_type = 'GYBE' THEN m."Loss_total_tgt" END) AS gybe_loss_avg,
  AVG(CASE WHEN e.event_type = 'ROUNDUP' THEN m."Loss_total_tgt" END) AS roundup_loss_avg,
  AVG(CASE WHEN e.event_type = 'BEARAWAY' THEN m."Loss_total_tgt" END) AS bearaway_loss_avg
FROM ac40.dataset_events e
INNER JOIN ac40.maneuver_stats m ON e.event_id = m.event_id
WHERE e.dataset_id = 4
  AND e.event_type IN ('TACK','GYBE','ROUNDUP','BEARAWAY')
  AND (e.tags->>'GRADE') IS NOT NULL AND (e.tags->>'GRADE') ~ '^[0-9]+$' AND (e.tags->>'GRADE')::int > 1
  AND (e.tags->>'Race_number') IS NOT NULL AND (e.tags->>'Race_number') ~ '^[0-9]+$'
  AND (e.tags->>'Leg_number') IS NOT NULL AND (e.tags->>'Leg_number') ~ '^[0-9]+$'
GROUP BY e.dataset_id, (e.tags->>'Race_number'), (e.tags->>'Leg_number');
