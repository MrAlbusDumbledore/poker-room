import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Одна строка на пару: from_id отправил заявку to_id; accepted=1 — дружба взаимная.
CREATE TABLE IF NOT EXISTS friendships (
  from_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS poker_tables (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  variant       TEXT NOT NULL,
  max_seats     INTEGER NOT NULL,
  small_blind   INTEGER NOT NULL,
  big_blind     INTEGER NOT NULL,
  min_buy_in    INTEGER NOT NULL,
  max_buy_in    INTEGER NOT NULL,
  action_time   INTEGER NOT NULL,
  hand_number   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);

-- Статистика стола: обновляется после каждой раздачи.
CREATE TABLE IF NOT EXISTS table_ledger (
  table_id      TEXT NOT NULL REFERENCES poker_tables(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  buy_in        INTEGER NOT NULL,
  stack         INTEGER NOT NULL,
  hands_played  INTEGER NOT NULL,
  PRIMARY KEY (table_id, user_id)
);

CREATE TABLE IF NOT EXISTS hand_history (
  table_id      TEXT NOT NULL REFERENCES poker_tables(id) ON DELETE CASCADE,
  hand_number   INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  data          TEXT NOT NULL,
  PRIMARY KEY (table_id, hand_number)
);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Нижний регистр с поддержкой кириллицы (встроенный LOWER в SQLite понимает только латиницу).
  db.function('ulower', { deterministic: true }, (s: unknown) => String(s ?? '').toLowerCase());
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Добавление колонок в уже существующие базы (после обновления сайта). */
function migrate(db: DB) {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(table_ledger)').all() as { name: string }[]).map((c) => c.name),
  );
  // Место за столом и статус «отошёл» — чтобы после перезапуска сервера все остались на своих местах.
  if (!cols.has('seat')) db.exec('ALTER TABLE table_ledger ADD COLUMN seat INTEGER');
  if (!cols.has('sitting_out')) db.exec('ALTER TABLE table_ledger ADD COLUMN sitting_out INTEGER NOT NULL DEFAULT 0');
}

/** Выполнить функцию в транзакции. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
