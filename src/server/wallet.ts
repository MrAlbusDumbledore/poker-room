import { AuthError, getUsers } from './auth.js';
import { DB, tx } from './db.js';
import { areFriends } from './friends.js';

/** Стартовый баланс нового игрока. */
export const START_BALANCE = 1_000_000;
/** Максимальная сумма одного перевода и начисления. */
export const MAX_TRANSFER = 1_000_000_000;

export function getBalance(db: DB, userId: string): number {
  const r = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance: number } | undefined;
  return r?.balance ?? 0;
}

/** Списать фишки; если не хватает — ошибка, баланс не меняется. */
export function debit(db: DB, userId: string, amount: number) {
  const r = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(amount, userId, amount);
  if (!r.changes) throw new AuthError(`Не хватает фишек на балансе: нужно ${amount.toLocaleString('ru-RU')}`);
}

export function credit(db: DB, userId: string, amount: number) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
}

function checkAmount(amount: unknown): number {
  const n = Number(amount);
  if (!Number.isInteger(n) || n <= 0) throw new AuthError('Сумма должна быть целым положительным числом');
  if (n > MAX_TRANSFER) throw new AuthError('Слишком большая сумма');
  return n;
}

/** Перевод фишек другу. */
export function transfer(db: DB, fromId: string, toId: string, amount: unknown) {
  const n = checkAmount(amount);
  if (fromId === toId) throw new AuthError('Нельзя перевести фишки самому себе');
  if (!areFriends(db, fromId, toId)) throw new AuthError('Переводить фишки можно только друзьям');
  tx(db, () => {
    debit(db, fromId, n);
    credit(db, toId, n);
    db.prepare('INSERT INTO transfers (from_id, to_id, amount, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(
      fromId,
      toId,
      n,
      'transfer',
      Date.now(),
    );
  });
  return { balance: getBalance(db, fromId) };
}

/** Начисление или списание админом (amount может быть отрицательным). */
export function adminGrant(db: DB, adminId: string, userId: string, amount: unknown) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_TRANSFER) throw new AuthError('Укажите целую сумму, не равную нулю');
  tx(db, () => {
    if (n > 0) credit(db, userId, n);
    else {
      const r = db.prepare('UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?').run(n, userId);
      if (!r.changes) throw new AuthError('Пользователь не найден', 404);
    }
    db.prepare('INSERT INTO transfers (from_id, to_id, amount, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(
      adminId,
      userId,
      n,
      'admin',
      Date.now(),
    );
  });
  return { balance: getBalance(db, userId) };
}

/** Последние переводы игрока: входящие и исходящие. */
export function history(db: DB, userId: string, limit = 30) {
  const rows = db
    .prepare(
      `SELECT from_id, to_id, amount, kind, created_at FROM transfers
       WHERE from_id = ? OR to_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, userId, limit) as { from_id: string; to_id: string; amount: number; kind: string; created_at: number }[];
  const users = getUsers(db, [...new Set(rows.flatMap((r) => [r.from_id, r.to_id]))]);
  return rows.map((r) => {
    const incoming = r.to_id === userId;
    const other = incoming ? r.from_id : r.to_id;
    return {
      kind: r.kind,
      incoming,
      amount: r.amount,
      other: users.get(other)?.displayName ?? '?',
      at: r.created_at,
    };
  });
}

// ---------- Админ ----------

/** Админ — самый первый зарегистрированный аккаунт. */
export function adminId(db: DB): string | null {
  const r = db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined;
  return r?.id ?? null;
}

export function isAdmin(db: DB, userId: string): boolean {
  return adminId(db) === userId;
}

export function listUsers(db: DB) {
  return (
    db.prepare('SELECT id, username, display_name, balance, created_at FROM users ORDER BY created_at, rowid').all() as {
      id: string;
      username: string;
      display_name: string;
      balance: number;
      created_at: number;
    }[]
  ).map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, balance: u.balance, createdAt: u.created_at }));
}
