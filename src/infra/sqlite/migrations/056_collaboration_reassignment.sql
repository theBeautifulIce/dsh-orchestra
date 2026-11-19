-- Keep existing request IDs for rework references and retain the withdrawn delivery state.
ALTER TABLE collaboration_requests ADD COLUMN replacement_request_id TEXT REFERENCES collaboration_requests(request_id);
;
CREATE UNIQUE INDEX collaboration_requests_replacement ON collaboration_requests (replacement_request_id)
  WHERE replacement_request_id IS NOT NULL;
;
DROP INDEX collaboration_requests_due;
;
CREATE INDEX collaboration_requests_due ON collaboration_requests (expires_at, request_id)
  WHERE replacement_request_id IS NULL AND status IN ('proposed','authorized','delivered','accepted');
