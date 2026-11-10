import { createShuffledDeck, ShuffledDeck } from './cards.js';
import { ActionInput, Hand, HandError, Variant } from './hand.js';

export interface TableConfig {
  variant: Variant;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}

export interface SeatState {
  userId: string;
  stack: number;
  sittingOut: boolean;
  /** Игрок нажал «Встать», но ещё участвует в текущей раздаче. */
  leaveAfterHand: boolean;
}

export interface LedgerRow {
  userId: string;
  /** Сколько фишек игрок всего взял за стол (бай-ин + докупки). */
  buyIn: number;
  /** Фишки сейчас: за столом или «замороженные» после ухода. */
  stack: number;
  /** Итог: stack − buyIn. */
  net: number;
  handsPlayed: number;
  status: 'playing' | 'sitting_out' | 'away';
  seat: number | null;
}

/** Раскрытая колода прошлой раздачи — для проверки честности. */
export interface RevealedDeck extends ShuffledDeck {
  handNumber: number;
}

/**
 * Кэш-стол. Правила:
 * - игрок садится с бай-ином в пределах [minBuyIn, maxBuyIn];
 * - если игрок встаёт, его стек сохраняется за ним до закрытия стола,
 *   и при возвращении он садится ровно с этим стеком (без повторной покупки);
 * - докупка возможна между раздачами, но не выше maxBuyIn;
 * - статистика (кто сколько закупил и выиграл) ведётся до закрытия стола.
 */
export class CashTable {
  readonly config: TableConfig;
  readonly seats: (SeatState | null)[];
  /** Стеки игроков, которые встали из-за стола. */
  readonly reserved = new Map<string, number>();
  private readonly ledger = new Map<string, { buyIn: number; handsPlayed: number }>();

  buttonSeat: number | null = null;
  hand: Hand | null = null;
  lastHand: Hand | null = null;
  handNumber = 0;
  closed = false;
  currentCommitment: string | null = null;
  lastRevealedDeck: RevealedDeck | null = null;
  private currentDeck: ShuffledDeck | null = null;

  constructor(config: TableConfig) {
    const { maxSeats, smallBlind, bigBlind, minBuyIn, maxBuyIn } = config;
    if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 9) throw new HandError('Мест за столом: от 2 до 9');
    if (!(smallBlind > 0 && bigBlind >= smallBlind)) throw new HandError('Некорректные блайнды');
    if (!(minBuyIn >= bigBlind && maxBuyIn >= minBuyIn)) throw new HandError('Некорректные границы бай-ина');
    this.config = { ...config };
    this.seats = Array.from({ length: maxSeats }, () => null);
  }

  /**
   * Восстановить стол после перезапуска сервера: все игроки считаются отошедшими,
   * их стеки сохранены и вернутся при посадке. Незавершённая раздача отменяется
   * (стеки берутся на её начало).
   */
  static restore(
    config: TableConfig,
    rows: { userId: string; buyIn: number; stack: number; handsPlayed: number }[],
    handNumber = 0,
  ): CashTable {
    const t = new CashTable(config);
    for (const r of rows) {
      t.ledger.set(r.userId, { buyIn: r.buyIn, handsPlayed: r.handsPlayed });
      if (r.stack > 0) t.reserved.set(r.userId, r.stack);
    }
    t.handNumber = handNumber;
    return t;
  }

  get handInProgress(): boolean {
    return !!this.hand && !this.hand.isComplete;
  }

  seatOf(userId: string): number {
    return this.seats.findIndex((s) => s?.userId === userId);
  }

  private ensureOpen() {
    if (this.closed) throw new HandError('Стол закрыт');
  }

  private inCurrentHand(userId: string): boolean {
    const p = this.hand && !this.hand.isComplete ? this.hand.player(userId) : undefined;
    return !!p && !p.folded;
  }

  /** Сесть за стол. Вернувшийся игрок получает свой сохранённый стек. */
  sit(userId: string, seat: number, buyIn?: number): SeatState {
    this.ensureOpen();
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) throw new HandError('Нет такого места');
    if (this.seats[seat]) throw new HandError('Место занято');
    if (this.seatOf(userId) >= 0) throw new HandError('Вы уже сидите за столом');

    let stack = this.reserved.get(userId) ?? 0;
    if (stack > 0) {
      this.reserved.delete(userId);
    } else {
      this.reserved.delete(userId);
      const { minBuyIn, maxBuyIn } = this.config;
      if (buyIn === undefined || !Number.isInteger(buyIn) || buyIn < minBuyIn || buyIn > maxBuyIn) {
        throw new HandError(`Бай-ин должен быть от ${minBuyIn} до ${maxBuyIn}`);
      }
      stack = buyIn;
      this.addToLedger(userId, buyIn);
    }
    const s: SeatState = { userId, stack, sittingOut: false, leaveAfterHand: false };
    this.seats[seat] = s;
    return s;
  }

  /** Докупить фишки (только между раздачами для этого игрока). */
  addChips(userId: string, amount: number) {
    this.ensureOpen();
    const i = this.seatOf(userId);
    if (i < 0) throw new HandError('Вы не за столом');
    if (this.handInProgress && this.hand!.player(userId)) throw new HandError('Докупка возможна после окончания раздачи');
    if (!Number.isInteger(amount) || amount <= 0) throw new HandError('Сумма докупки должна быть положительной');
    const s = this.seats[i]!;
    if (s.stack + amount > this.config.maxBuyIn) {
      throw new HandError(`Стек не может превышать ${this.config.maxBuyIn}`);
    }
    s.stack += amount;
    this.addToLedger(userId, amount);
  }

  sitOut(userId: string) {
    const i = this.seatOf(userId);
    if (i < 0) throw new HandError('Вы не за столом');
    this.seats[i]!.sittingOut = true; // вступает в силу со следующей раздачи
  }

  sitIn(userId: string) {
    const i = this.seatOf(userId);
    if (i < 0) throw new HandError('Вы не за столом');
    if (this.seats[i]!.stack <= 0) throw new HandError('Сначала докупите фишки');
    this.seats[i]!.sittingOut = false;
  }

  /** Встать из-за стола. Стек сохраняется до закрытия стола. */
  leave(userId: string) {
    const i = this.seatOf(userId);
    if (i < 0) throw new HandError('Вы не за столом');
    if (this.inCurrentHand(userId)) {
      this.seats[i]!.leaveAfterHand = true;
      this.autoFoldLeavers();
      if (this.hand?.isComplete) this.finalizeHand();
      return;
    }
    this.vacate(i);
  }

  private vacate(i: number) {
    const s = this.seats[i]!;
    // Если игрок уже сбросил карты в идущей раздаче, его итоговый стек — в раздаче.
    const inHand = this.handInProgress ? this.hand!.player(s.userId) : undefined;
    this.reserved.set(s.userId, inHand ? inHand.stack : s.stack);
    this.seats[i] = null;
  }

  private eligibleSeats(): number[] {
    return this.seats.flatMap((s, i) => (s && !s.sittingOut && s.stack > 0 ? [i] : []));
  }

  canStartHand(): boolean {
    return !this.closed && !this.handInProgress && this.eligibleSeats().length >= 2;
  }

  /** Начать новую раздачу. deck можно передать для тестов. */
  startHand(deck: ShuffledDeck = createShuffledDeck()): Hand {
    this.ensureOpen();
    if (this.handInProgress) throw new HandError('Раздача уже идёт');
    const eligible = this.eligibleSeats();
    if (eligible.length < 2) throw new HandError('Нужно минимум 2 игрока');

    const prev = this.buttonSeat ?? -1;
    const button = eligible.find((i) => i > prev) ?? eligible[0];
    this.buttonSeat = button;

    this.currentDeck = deck;
    this.currentCommitment = deck.commitment;
    this.handNumber++;
    this.hand = new Hand(
      eligible.map((i) => ({ id: this.seats[i]!.userId, seat: i, stack: this.seats[i]!.stack })),
      { ...this.config, buttonSeat: button, deck: deck.cards },
    );
    if (this.hand.isComplete) this.finalizeHand();
    return this.hand;
  }

  act(userId: string, input: ActionInput) {
    if (!this.handInProgress) throw new HandError('Раздача не идёт');
    this.hand!.act(userId, input);
    this.autoFoldLeavers();
    if (this.hand!.isComplete) this.finalizeHand();
  }

  /** Сбросить карты за игрока, у которого вышло время на ход. */
  timeoutActive(): string | null {
    const id = this.hand?.activePlayerId;
    if (!id) return null;
    const legal = this.hand!.getLegalActions()!;
    this.act(id, { type: legal.canCheck ? 'check' : 'fold' });
    const i = this.seatOf(id);
    if (i >= 0) this.seats[i]!.sittingOut = true;
    return id;
  }

  private autoFoldLeavers() {
    while (this.hand && !this.hand.isComplete) {
      const id = this.hand.activePlayerId;
      const i = id ? this.seatOf(id) : -1;
      if (i < 0 || !this.seats[i]!.leaveAfterHand) return;
      this.hand.act(id!, { type: 'fold' });
    }
  }

  private finalizeHand() {
    const hand = this.hand!;
    for (const p of hand.players) {
      const i = this.seatOf(p.id);
      if (i >= 0) this.seats[i]!.stack = p.stack;
      this.ledger.get(p.id)!.handsPlayed++;
    }
    if (this.currentDeck) this.lastRevealedDeck = { ...this.currentDeck, handNumber: this.handNumber };
    this.currentDeck = null;
    this.currentCommitment = null;
    this.lastHand = hand;
    this.hand = null;

    this.seats.forEach((s, i) => {
      if (!s) return;
      if (s.leaveAfterHand) this.vacate(i);
      else if (s.stack === 0) s.sittingOut = true;
    });
  }

  private addToLedger(userId: string, amount: number) {
    const row = this.ledger.get(userId) ?? { buyIn: 0, handsPlayed: 0 };
    row.buyIn += amount;
    this.ledger.set(userId, row);
  }

  /**
   * Статистика стола. Во время раздачи стеки показываются на её начало,
   * поэтому сумма net по всем игрокам всегда равна нулю.
   */
  stats(): LedgerRow[] {
    return [...this.ledger.entries()].map(([userId, row]) => {
      const seat = this.seatOf(userId);
      const s = seat >= 0 ? this.seats[seat]! : null;
      const stack = s ? s.stack : (this.reserved.get(userId) ?? 0);
      return {
        userId,
        buyIn: row.buyIn,
        stack,
        net: stack - row.buyIn,
        handsPlayed: row.handsPlayed,
        status: s ? (s.sittingOut ? 'sitting_out' : 'playing') : 'away',
        seat: seat >= 0 ? seat : null,
      };
    });
  }

  /** Закрыть стол и получить итоговую таблицу. */
  close(): LedgerRow[] {
    if (this.handInProgress) throw new HandError('Дождитесь окончания раздачи');
    this.closed = true;
    return this.stats();
  }
}
