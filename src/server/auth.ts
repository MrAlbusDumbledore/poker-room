import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from './db.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sid';
export const SESSION_DAYS = 30;

export interface User {
  id: string;
  username: string;
  displayName: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------- Пароли ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---------- Проверка ввода ----------

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function validateRegistration(username: unknown, password: unknown, displayName: unknown) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new AuthError('Логин: 3–20 символов, латиница, цифры и _');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    throw new AuthError('Пароль: минимум 6 символов');
  }
  const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : username;
  if (name.length > 24) throw new AuthError('Имя за столом: не длиннее 24 символов');
  return { username, password, displayName: name };
}

// ---------- Пользователи ----------

type UserRow = { id: string; username: string; display_name: string; password_hash: string };

const toUser = (r: UserRow): User => ({ id: r.id, username: r.username, displayName: r.display_name });

export async function createUser(db: DB, username: string, password: string, displayName: string): Promise<User> {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) throw new AuthError('Такой логин уже занят', 409);
  const id = randomUUID();
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    username,
    displayName,
    hash,
    Date.now(),
  );
  return { id, username, displayName };
}

export async function checkCredentials(db: DB, username: string, password: string): Promise<User> {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  // Хэшируем даже для несуществующего логина, чтобы по времени ответа нельзя было угадать логины.
  const ok = row ? await verifyPassword(password, row.password_hash) : (await hashPassword(password), false);
  if (!row || !ok) throw new AuthError('Неверный логин или пароль', 401);
  return toUser(row);
}

export function getUser(db: DB, id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUsers(db: DB, ids: string[]): Map<string, User> {
  const out = new Map<string, User>();
  if (!ids.length) return out;
  const rows = db
    .prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as UserRow[];
  for (const r of rows) out.set(r.id, toUser(r));
  return out;
}

export function searchUsers(db: DB, q: string, excludeId: string): User[] {
  const like = `%${q.toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM users WHERE id != ? AND (ulower(username) LIKE ? ESCAPE '\\' OR ulower(display_name) LIKE ? ESCAPE '\\')
       ORDER BY username LIMIT 20`,
    )
    .all(excludeId, like, like) as UserRow[];
  return rows.map(toUser);
}

// ---------- Сессии ----------

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function createSession(db: DB, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    now,
    now + SESSION_DAYS * 86400_000,
  );
  return token;
}

export function userBySession(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function deleteSession(db: DB, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

// ---------- Ограничение попыток входа ----------

const attempts = new Map<string, { count: number; until: number }>();

/** Не больше 10 неудачных попыток за 15 минут на пару «IP + логин». */
export function checkRateLimit(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.count >= 10) {
    throw new AuthError('Слишком много попыток входа, попробуйте через 15 минут', 429);
  }
}

export function recordFailure(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { count: 1, until: now + 15 * 60_000 });
  else a.count++;
}

export function clearFailures(key: string) {
  attempts.delete(key);
}
