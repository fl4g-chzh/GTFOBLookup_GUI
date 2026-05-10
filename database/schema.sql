CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  platform TEXT,
  summary TEXT,
  tags_text TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_title ON entries(title);
