-- Match the priority order used by the decision inbox query.
CREATE INDEX decisions_inbox_priority ON decisions (
  (CASE priority WHEN 'critical' THEN 50 WHEN 'urgent' THEN 40 WHEN 'high' THEN 30 WHEN 'normal' THEN 20 WHEN 'low' THEN 10 ELSE 0 END) DESC,
  created_at,
  decision_id
) WHERE status IN ('pending','acknowledged','blocked_for_human');
