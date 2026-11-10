import { AuthError, getUsers, User } from './auth.js';
import type { DB } from './db.js';

type Row = { from_id: string; to_id: string; accepted: number };

export function friendIds(db: DB, me: string): string[] {
  const rows = db
    .prepare('SELECT from_id, to_id FROM friendships WHERE accepted = 1 AND (from_id = ? OR to_id = ?)')
    .all(me, me) as Row[];
  return rows.map((r) => (r.from_id === me ? r.to_id : r.from_id));
}

export function areFriends(db: DB, a: string, b: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM friendships WHERE accepted = 1 AND
       ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`,
    )
    .get(a, b, b, a);
}

export function listFriends(db: DB, me: string) {
  const rows = db.prepare('SELECT * FROM friendships WHERE from_id = ? OR to_id = ?').all(me, me) as Row[];
  const users = getUsers(
    db,
    rows.map((r) => (r.from_id === me ? r.to_id : r.from_id)),
  );
  const pick = (id: string) => users.get(id)!;
  const sort = (xs: User[]) => xs.filter(Boolean).sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    friends: sort(rows.filter((r) => r.accepted).map((r) => pick(r.from_id === me ? r.to_id : r.from_id))),
    incoming: sort(rows.filter((r) => !r.accepted && r.to_id === me).map((r) => pick(r.from_id))),
    outgoing: sort(rows.filter((r) => !r.accepted && r.from_id === me).map((r) => pick(r.to_id))),
  };
}

/** Отправить заявку. Если встречная заявка уже есть — дружба подтверждается сразу. */
export function requestFriend(db: DB, me: string, username: string): 'sent' | 'accepted' {
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | undefined;
  if (!target) throw new AuthError('Пользователь не найден', 404);
  if (target.id === me) throw new AuthError('Нельзя добавить в друзья самого себя');
  const mine = db.prepare('SELECT * FROM friendships WHERE from_id = ? AND to_id = ?').get(me, target.id) as Row | undefined;
  const theirs = db.prepare('SELECT * FROM friendships WHERE from_id = ? AND to_id = ?').get(target.id, me) as
    | Row
    | undefined;
  if (mine?.accepted || theirs?.accepted) throw new AuthError('Вы уже друзья');
  if (mine) throw new AuthError('Заявка уже отправлена');
  if (theirs) {
    db.prepare('UPDATE friendships SET accepted = 1 WHERE from_id = ? AND to_id = ?').run(target.id, me);
    return 'accepted';
  }
  db.prepare('INSERT INTO friendships (from_id, to_id, accepted, created_at) VALUES (?, ?, 0, ?)').run(
    me,
    target.id,
    Date.now(),
  );
  return 'sent';
}

export function acceptFriend(db: DB, me: string, fromId: string) {
  const r = db.prepare('UPDATE friendships SET accepted = 1 WHERE from_id = ? AND to_id = ? AND accepted = 0').run(fromId, me);
  if (!r.changes) throw new AuthError('Заявка не найдена', 404);
}

/** Отклонить заявку, отменить свою или удалить из друзей. */
export function removeFriend(db: DB, me: string, otherId: string) {
  db.prepare('DELETE FROM friendships WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(
    me,
    otherId,
    otherId,
    me,
  );
}
