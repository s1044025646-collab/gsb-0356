import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

export function dataDir(): string {
  return process.env.AC_DATA_DIR || DEFAULT_DATA_DIR;
}

export function openDb(dir?: string): Database.Database {
  const d = dir || dataDir();
  fs.mkdirSync(d, { recursive: true });
  const db = new Database(path.join(d, 'ac.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
CREATE TABLE IF NOT EXISTS pattern_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES pattern_sets(id),
  version_no INTEGER NOT NULL,
  compiled INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER,
  total_pattern_len INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (set_id, version_no)
);
CREATE TABLE IF NOT EXISTS patterns (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  pid INTEGER NOT NULL,
  text TEXT NOT NULL,
  len INTEGER NOT NULL,
  PRIMARY KEY (version_id, pid),
  UNIQUE (version_id, text)
);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  state INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  total_chars INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  total_hits INTEGER NOT NULL DEFAULT 0,
  total_fail_steps INTEGER NOT NULL DEFAULT 0,
  explain_count INTEGER NOT NULL DEFAULT 0,
  explain_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chunks (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  chars INTEGER NOT NULL,
  PRIMARY KEY (scan_id, seq)
);
CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  pid INTEGER NOT NULL,
  pattern TEXT NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hits_scan ON hits(scan_id, "end", pid);
CREATE TABLE IF NOT EXISTS explains (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  pos INTEGER NOT NULL,
  char TEXT NOT NULL,
  state_before INTEGER NOT NULL,
  fail_path TEXT NOT NULL,
  state_after INTEGER NOT NULL,
  outputs TEXT NOT NULL,
  PRIMARY KEY (scan_id, pos)
);
`);
  return db;
}
