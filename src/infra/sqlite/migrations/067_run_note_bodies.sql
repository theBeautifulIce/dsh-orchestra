-- The existing event ledger owns note order, authority and eviction.
-- This private payload is only read through the scoped note service.
CREATE TABLE run_note_bodies (
  event_seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 256)
);

CREATE INDEX events_run_note_created ON events(run_id, seq DESC)
  WHERE type = 'run.note_created';
