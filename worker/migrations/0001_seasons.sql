CREATE TABLE seasons (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  seed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  population INTEGER NOT NULL DEFAULT 0,
  sim_year INTEGER NOT NULL DEFAULT 1,
  last_event_preview TEXT
);

CREATE INDEX idx_seasons_status_updated
ON seasons(status, updated_at DESC);
