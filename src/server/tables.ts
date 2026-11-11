import { randomUUID } from 'node:crypto';
import { CashTable, TableConfig } from '../engine/table.js';
import { ActionInput, HandError, Variant, VARIANT_NAMES } from '../engine/hand.js';
import { stakeById } from '../engine/stakes.js';
import { AuthError, getUsers, User } from './auth.js';
import { DB, tx } from './db.js';
import { friendIds } from './friends.js';

export interface TableRow {
  id: string;
  owner_id: string;
  name: string;
  variant: Variant;
  max_seats: number;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  action_time: number;
  hand_number: number;
  status: 'open' | 'closed';
  created_at: number;
  closed_at: number | null;
}

/** Подписчик на стол — одно WebSocket-подключение. */
export interface Subscriber {
  userId: string;
  send(msg: unknown): void;
}

export interface ManagerOptions {
  /** Пауза перед новой раздачей, мс. */
  handDelayMs: number;
  /** Пауза после вскрытия, чтобы все успели посмотреть карты, мс. */
  showdownDelayMs: number;
  /** Только для тестов: время на ход в мс вместо настроек стола. */
  actionTimeOverrideMs?: number;
  /** Множитель паузы на раскладку (в тестах 0, чтобы не ждать). */
  runoutScale: number;
}

export type TableCommand =
  | { t: 'sit'; seat: number; buyIn?: number }
  | { t: 'stand' }
  | { t: 'sit_out' }
  | { t: 'sit_in' }
  | { t: 'add_chips'; amount: number }
  | { t: 'action'; action: ActionInput }
  | { t: 'close' };

/**
 * Темп раскладки стола после олл-ина. Сервер отправляет эти значения в интерфейс,
 * чтобы паузы на сервере и анимация в браузере совпадали.
 */
export const RUNOUT_TIMING = {
  /** Пауза после открытия карт игроков, до первой карты стола. */
  revealMs: 1200,
  /** Между картами флопа. */
  flopCardMs: 350,
  /** Перед тёрном и перед ривером. */
  streetMs: 1800,
  /** После последней карты, до показа итогов. */
  resultMs: 800,
};

/** Сколько длится раскладка в интерфейсе, если на столе было `from` карт. */
export function runoutDuration(from: number | null): number {
  if (from === null || from >= 5) return 0;
  const T = RUNOUT_TIMING;
  let t = T.revealMs;
  let last = t;
  for (let c = from; c < 5; c++) {
    last = t;
    t += c < 2 ? T.flopCardMs : T.streetMs;
  }
  return last + T.resultMs;
}

interface LiveTable {
  row: TableRow;
  table: CashTable;
  subs: Set<Subscriber>;
  actionTimer: NodeJS.Timeout | null;
  actionDeadline: number | null;
  actionFor: string | null;
  nextHandTimer: NodeJS.Timeout | null;
  nextHandAt: number | null;
  savedHand: unknown;
  closing: boolean;
}

export interface CreateTableInput {
  name?: unknown;
  variant?: unknown;
  maxSeats?: unknown;
  stakeId?: unknown;
  minBuyInBB?: unknown;
  maxBuyInBB?: unknown;
  actionTime?: unknown;
}

const int = (v: unknown, def: number) => (v === undefined || v === null || v === '' ? def : Number(v));

export class TableManager {
  private live = new Map<string, LiveTable>();

  constructor(
    private readonly db: DB,
    private readonly opts: ManagerOptions,
  ) {}

  // ---------- Создание и список ----------

  create(owner: User, input: CreateTableInput): TableRow {
    const variant = input.variant === 'PLO5' ? 'PLO5' : input.variant === 'NLH' || input.variant === undefined ? 'NLH' : null;
    if (!variant) throw new AuthError('Неизвестный вид покера');
    const stake = stakeById(String(input.stakeId ?? '10-20'));
    if (!stake) throw new AuthError('Неизвестный уровень блайндов');
    const maxSeats = int(input.maxSeats, 6);
    // В Омахе по 5 карт: на 9 игроков колоды не хватит (45 + 8 карт на стол и сжигание).
    const seatLimit = variant === 'PLO5' ? 8 : 9;
    if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > seatLimit) {
      throw new AuthError(`Мест за столом: от 2 до ${seatLimit}`);
    }
    const minBB = int(input.minBuyInBB, 40);
    const maxBB = int(input.maxBuyInBB, 200);
    if (!Number.isInteger(minBB) || !Number.isInteger(maxBB) || minBB < 1 || maxBB < minBB || maxBB > 1000) {
      throw new AuthError('Бай-ин: от 1 до 1000 больших блайндов, минимум не больше максимума');
    }
    const actionTime = int(input.actionTime, 30);
    if (!Number.isInteger(actionTime) || actionTime < 10 || actionTime > 120) {
      throw new AuthError('Время на ход: от 10 до 120 секунд');
    }
    const name =
      typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : `Стол ${owner.displayName}`;

    const row: TableRow = {
      id: randomUUID(),
      owner_id: owner.id,
      name,
      variant,
      max_seats: maxSeats,
      small_blind: stake.smallBlind,
      big_blind: stake.bigBlind,
      min_buy_in: minBB * stake.bigBlind,
      max_buy_in: maxBB * stake.bigBlind,
      action_time: actionTime,
      hand_number: 0,
      status: 'open',
      created_at: Date.now(),
      closed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO poker_tables (id, owner_id, name, variant, max_seats, small_blind, big_blind,
         min_buy_in, max_buy_in, action_time, hand_number, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
      )
      .run(
        row.id,
        row.owner_id,
        row.name,
        row.variant,
        row.max_seats,
        row.small_blind,
        row.big_blind,
        row.min_buy_in,
        row.max_buy_in,
        row.action_time,
        row.created_at,
      );
    return row;
  }

  getRow(id: string): TableRow | null {
    return (this.db.prepare('SELECT * FROM poker_tables WHERE id = ?').get(id) as TableRow | undefined) ?? null;
  }

  /** Лобби: открытые столы, созданные мной или моими друзьями. */
  lobby(userId: string) {
    const owners = [userId, ...friendIds(this.db, userId)];
    const rows = this.db
      .prepare(
        `SELECT * FROM poker_tables WHERE status = 'open' AND owner_id IN (${owners.map(() => '?').join(',')})
         ORDER BY created_at DESC`,
      )
      .all(...owners) as unknown as TableRow[];
    const users = getUsers(this.db, [...new Set(rows.map((r) => r.owner_id))]);
    return rows.map((r) => {
      const lt = this.live.get(r.id);
      const seated = lt ? lt.table.seats.filter(Boolean).length : 0;
      return { ...summary(r), owner: users.get(r.owner_id) ?? null, seated };
    });
  }

  /** Статистика стола (доступна и после закрытия). */
  stats(id: string) {
    const row = this.getRow(id);
    if (!row) throw new AuthError('Стол не найден', 404);
    const lt = this.live.get(id);
    const rows = lt
      ? lt.table.stats().map((s) => ({ userId: s.userId, buyIn: s.buyIn, stack: s.stack, handsPlayed: s.handsPlayed, status: s.status }))
      : (
          this.db.prepare('SELECT * FROM table_ledger WHERE table_id = ?').all(id) as {
            user_id: string;
            buy_in: number;
            stack: number;
            hands_played: number;
          }[]
        ).map((r) => ({ userId: r.user_id, buyIn: r.buy_in, stack: r.stack, handsPlayed: r.hands_played, status: 'away' as const }));
    const users = getUsers(this.db, rows.map((r) => r.userId));
    return {
      table: summary(row),
      players: rows
        .map((r) => ({ ...r, net: r.stack - r.buyIn, displayName: users.get(r.userId)?.displayName ?? '?' }))
        .sort((a, b) => b.net - a.net),
    };
  }

  // ---------- Живые столы ----------

  private load(id: string): LiveTable {
    const existing = this.live.get(id);
    if (existing) return existing;
    const row = this.getRow(id);
    if (!row) throw new AuthError('Стол не найден', 404);
    if (row.status !== 'open') throw new AuthError('Стол закрыт', 410);
    const ledger = this.db.prepare('SELECT * FROM table_ledger WHERE table_id = ?').all(id) as {
      user_id: string;
      buy_in: number;
      stack: number;
      hands_played: number;
    }[];
    const table = CashTable.restore(
      configOf(row),
      ledger.map((r) => ({ userId: r.user_id, buyIn: r.buy_in, stack: r.stack, handsPlayed: r.hands_played })),
      row.hand_number,
    );
    const lt: LiveTable = {
      row,
      table,
      subs: new Set(),
      actionTimer: null,
      actionDeadline: null,
      actionFor: null,
      nextHandTimer: null,
      nextHandAt: null,
      savedHand: null,
      closing: false,
    };
    this.live.set(id, lt);
    return lt;
  }

  subscribe(id: string, sub: Subscriber) {
    const lt = this.load(id);
    lt.subs.add(sub);
    this.broadcast(lt);
  }

  unsubscribe(id: string, sub: Subscriber) {
    const lt = this.live.get(id);
    if (!lt) return;
    lt.subs.delete(sub);
    this.broadcast(lt);
  }

  command(id: string, user: User, cmd: TableCommand) {
    const lt = this.load(id);
    const t = lt.table;
    switch (cmd.t) {
      case 'sit':
        if (lt.closing) throw new HandError('Стол закрывается');
        t.sit(user.id, Number(cmd.seat), cmd.buyIn === undefined ? undefined : Number(cmd.buyIn));
        break;
      case 'stand':
        t.leave(user.id);
        break;
      case 'sit_out':
        t.sitOut(user.id);
        break;
      case 'sit_in':
        t.sitIn(user.id);
        break;
      case 'add_chips':
        t.addChips(user.id, Number(cmd.amount));
        break;
      case 'action':
        if (!cmd.action || typeof cmd.action !== 'object') throw new HandError('Нет действия');
        t.act(user.id, { type: cmd.action.type, amount: cmd.action.amount === undefined ? undefined : Number(cmd.action.amount) });
        break;
      case 'close':
        if (user.id !== lt.row.owner_id) throw new HandError('Закрыть стол может только его создатель');
        lt.closing = true;
        break;
      default:
        throw new HandError('Неизвестная команда');
    }
    this.afterChange(lt);
  }

  /** Единая точка после любого изменения: сохранить, перепланировать таймеры, разослать состояние. */
  private afterChange(lt: LiveTable) {
    const t = lt.table;
    if (t.lastHand && t.lastHand !== lt.savedHand) {
      this.saveHand(lt);
      lt.savedHand = t.lastHand;
    }
    this.saveLedger(lt);

    if (lt.closing && !t.handInProgress) return this.finishClose(lt);

    // Таймер на ход
    const active = t.hand?.activePlayerId ?? null;
    if (active !== lt.actionFor) {
      if (lt.actionTimer) clearTimeout(lt.actionTimer);
      lt.actionTimer = null;
      lt.actionDeadline = null;
      lt.actionFor = active;
      if (active) {
        const ms = this.opts.actionTimeOverrideMs ?? lt.row.action_time * 1000;
        lt.actionDeadline = Date.now() + ms;
        lt.actionTimer = setTimeout(() => this.onTimeout(lt, active), ms);
      }
    }

    // Автостарт следующей раздачи
    if (!t.handInProgress && t.canStartHand() && !lt.nextHandTimer) {
      const last = t.lastHand;
      const delay = last?.result?.showdown
        ? this.opts.showdownDelayMs + this.opts.runoutScale * runoutDuration(last.runoutFrom)
        : this.opts.handDelayMs;
      lt.nextHandAt = Date.now() + delay;
      lt.nextHandTimer = setTimeout(() => {
        lt.nextHandTimer = null;
        lt.nextHandAt = null;
        if (!lt.table.closed && lt.table.canStartHand() && !lt.closing) lt.table.startHand();
        this.afterChange(lt);
      }, delay);
    } else if ((t.handInProgress || !t.canStartHand()) && lt.nextHandTimer) {
      clearTimeout(lt.nextHandTimer);
      lt.nextHandTimer = null;
      lt.nextHandAt = null;
    }

    this.broadcast(lt);
  }

  private onTimeout(lt: LiveTable, userId: string) {
    lt.actionTimer = null;
    if (lt.table.hand?.activePlayerId !== userId) return;
    lt.actionFor = null;
    lt.table.timeoutActive();
    this.afterChange(lt);
  }

  private finishClose(lt: LiveTable) {
    this.clearTimers(lt);
    lt.table.close();
    this.saveLedger(lt);
    const now = Date.now();
    this.db.prepare("UPDATE poker_tables SET status = 'closed', closed_at = ? WHERE id = ?").run(now, lt.row.id);
    lt.row.status = 'closed';
    lt.row.closed_at = now;
    const final = this.stats(lt.row.id);
    for (const s of lt.subs) s.send({ t: 'closed', stats: final });
    this.live.delete(lt.row.id);
  }

  private clearTimers(lt: LiveTable) {
    if (lt.actionTimer) clearTimeout(lt.actionTimer);
    if (lt.nextHandTimer) clearTimeout(lt.nextHandTimer);
    lt.actionTimer = lt.nextHandTimer = null;
  }

  /** Остановить все таймеры (для корректного завершения сервера и тестов). */
  shutdown() {
    for (const lt of this.live.values()) this.clearTimers(lt);
    this.live.clear();
  }

  // ---------- Сохранение ----------

  private saveLedger(lt: LiveTable) {
    const stats = lt.table.stats();
    tx(this.db, () => {
      const up = this.db.prepare(
        `INSERT INTO table_ledger (table_id, user_id, buy_in, stack, hands_played) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (table_id, user_id) DO UPDATE SET buy_in = excluded.buy_in, stack = excluded.stack,
         hands_played = excluded.hands_played`,
      );
      for (const s of stats) up.run(lt.row.id, s.userId, s.buyIn, s.stack, s.handsPlayed);
      this.db.prepare('UPDATE poker_tables SET hand_number = ? WHERE id = ?').run(lt.table.handNumber, lt.row.id);
    });
  }

  private saveHand(lt: LiveTable) {
    const h = lt.table.lastHand!;
    const deck = lt.table.lastRevealedDeck;
    const data = {
      variant: h.variant,
      smallBlind: h.smallBlind,
      bigBlind: h.bigBlind,
      buttonSeat: h.players[h.buttonIndex].seat,
      board: h.board,
      players: h.players.map((p) => ({ id: p.id, seat: p.seat, startStack: p.startStack, stack: p.stack, hole: p.hole })),
      events: h.events,
      result: h.result,
      deck: deck ? { cards: deck.cards, salt: deck.salt, commitment: deck.commitment } : null,
    };
    this.db
      .prepare('INSERT OR REPLACE INTO hand_history (table_id, hand_number, finished_at, data) VALUES (?, ?, ?, ?)')
      .run(lt.row.id, lt.table.handNumber, Date.now(), JSON.stringify(data));
  }

  // ---------- Состояние для игроков ----------

  private broadcast(lt: LiveTable) {
    for (const s of lt.subs) s.send({ t: 'state', state: this.stateFor(lt, s.userId) });
  }

  /** Состояние стола глазами конкретного игрока: чужие карты не попадают в ответ. */
  stateFor(lt: LiveTable, viewerId: string) {
    const t = lt.table;
    const hand = t.hand;
    const ids = new Set<string>();
    t.seats.forEach((s) => s && ids.add(s.userId));
    for (const r of t.stats()) ids.add(r.userId);
    const users = getUsers(this.db, [...ids]);
    const online = new Set([...lt.subs].map((s) => s.userId));
    const name = (id: string) => users.get(id)?.displayName ?? '?';

    const mySeat = t.seatOf(viewerId);
    const shownHand = hand ?? t.lastHand;
    return {
      table: { ...summary(lt.row), closing: lt.closing },
      me: {
        userId: viewerId,
        seat: mySeat >= 0 ? mySeat : null,
        reservedStack: t.reserved.get(viewerId) ?? null,
        isOwner: viewerId === lt.row.owner_id,
      },
      seats: t.seats.map((s, i) => {
        if (!s) return { seat: i, empty: true as const };
        const hp = hand?.player(s.userId);
        return {
          seat: i,
          empty: false as const,
          userId: s.userId,
          displayName: name(s.userId),
          stack: hp ? hp.stack : s.stack,
          sittingOut: s.sittingOut,
          leaving: s.leaveAfterHand,
          online: online.has(s.userId),
        };
      }),
      handNumber: t.handNumber,
      handInProgress: !!hand,
      hand: shownHand ? shownHand.viewFor(viewerId) : null,
      actionDeadline: lt.actionDeadline,
      nextHandAt: lt.nextHandAt,
      commitment: t.currentCommitment,
      lastDeck: t.lastRevealedDeck,
      serverNow: Date.now(),
      runoutTiming: RUNOUT_TIMING,
      stats: t
        .stats()
        .map((r) => ({ ...r, displayName: name(r.userId) }))
        .sort((a, b) => b.net - a.net),
    };
  }
}

function configOf(row: TableRow): TableConfig {
  return {
    variant: row.variant,
    maxSeats: row.max_seats,
    smallBlind: row.small_blind,
    bigBlind: row.big_blind,
    minBuyIn: row.min_buy_in,
    maxBuyIn: row.max_buy_in,
  };
}

export function summary(r: TableRow) {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    variant: r.variant,
    variantName: VARIANT_NAMES[r.variant],
    maxSeats: r.max_seats,
    smallBlind: r.small_blind,
    bigBlind: r.big_blind,
    minBuyIn: r.min_buy_in,
    maxBuyIn: r.max_buy_in,
    actionTime: r.action_time,
    status: r.status,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}
