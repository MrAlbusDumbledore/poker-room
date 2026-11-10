import { Card } from './cards.js';
import { bestHoldem, bestOmaha, HandValue } from './evaluator.js';

/** NLH — безлимитный холдем, PLO5 — пот-лимитная Омаха на 5 картах. */
export type Variant = 'NLH' | 'PLO5';
export const HOLE_CARDS: Record<Variant, number> = { NLH: 2, PLO5: 5 };
export const VARIANT_NAMES: Record<Variant, string> = {
  NLH: 'Безлимитный холдем',
  PLO5: 'Пот-лимит Омаха (5 карт)',
};

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface HandSeatInput {
  id: string;
  seat: number;
  stack: number;
}

export interface HandOptions {
  variant: Variant;
  smallBlind: number;
  bigBlind: number;
  /** Номер места баттона; игрок на этом месте должен участвовать в раздаче. */
  buttonSeat: number;
  /** Колода в порядке выдачи карт. */
  deck: Card[];
}

export interface HandPlayer {
  id: string;
  seat: number;
  startStack: number;
  stack: number;
  hole: Card[];
  /** Поставлено на текущей улице. */
  committed: number;
  /** Поставлено за всю раздачу. */
  totalCommitted: number;
  folded: boolean;
  allIn: boolean;
  /** Действовал ли игрок после последнего полного рейза. */
  hasActed: boolean;
}

export interface ActionInput {
  type: ActionType;
  /** Для bet/raise — итоговая сумма ставки на улице («рейз до»). */
  amount?: number;
}

export interface LegalActions {
  playerId: string;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Сколько фишек нужно доложить для колла (с учётом стека). */
  callAmount: number;
  canRaise: boolean;
  /** true — это первая ставка на улице («Ставка»), иначе «Рейз». */
  isBet: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface PotAward {
  amount: number;
  eligible: string[];
  winners: string[];
  shares: Record<string, number>;
}

export interface HandResult {
  showdown: boolean;
  pots: PotAward[];
  /** Сколько фишек каждый игрок забрал из банка. */
  collected: Record<string, number>;
  /** Изменение стека за раздачу. */
  net: Record<string, number>;
  /** Комбинации игроков, дошедших до вскрытия. */
  hands: Record<string, { name: string; cards: Card[] }>;
}

export type HandEvent =
  | { kind: 'blind'; playerId: string; blind: 'small' | 'big'; amount: number }
  | { kind: 'action'; playerId: string; action: ActionType; added: number; total: number; allIn: boolean }
  | { kind: 'street'; street: Street; board: Card[] }
  | { kind: 'award'; playerId: string; amount: number; potIndex: number; hand?: string };

export class HandError extends Error {}

export class Hand {
  readonly variant: Variant;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly players: HandPlayer[];
  readonly buttonIndex: number;
  readonly sbIndex: number;
  readonly bbIndex: number;

  board: Card[] = [];
  street: Street = 'preflop';
  currentBet = 0;
  lastRaiseSize = 0;
  /** Индекс игрока, чей ход; -1 если ход ничей. */
  toAct = -1;
  events: HandEvent[] = [];
  result: HandResult | null = null;

  private readonly deck: Card[];
  private deckPos = 0;

  constructor(seats: HandSeatInput[], opts: HandOptions) {
    const { variant, smallBlind, bigBlind } = opts;
    if (!(smallBlind > 0 && bigBlind >= smallBlind)) throw new HandError('Некорректные блайнды');
    const ps = seats.filter((s) => s.stack > 0).sort((a, b) => a.seat - b.seat);
    if (ps.length < 2) throw new HandError('Для раздачи нужно минимум 2 игрока с фишками');
    if (new Set(ps.map((p) => p.id)).size !== ps.length) throw new HandError('Игрок не может сидеть на двух местах');
    const need = ps.length * HOLE_CARDS[variant] + 8;
    if (opts.deck.length < need) throw new HandError('В колоде не хватает карт');

    this.variant = variant;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.deck = opts.deck.slice();
    this.players = ps.map((s) => ({
      id: s.id,
      seat: s.seat,
      startStack: s.stack,
      stack: s.stack,
      hole: [],
      committed: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false,
      hasActed: false,
    }));

    const n = this.players.length;
    this.buttonIndex = this.players.findIndex((p) => p.seat === opts.buttonSeat);
    if (this.buttonIndex < 0) throw new HandError('На месте баттона нет игрока');
    // Хедз-ап: баттон ставит малый блайнд и действует первым до флопа.
    this.sbIndex = n === 2 ? this.buttonIndex : (this.buttonIndex + 1) % n;
    this.bbIndex = (this.sbIndex + 1) % n;

    // Раздача по одной карте по кругу, начиная слева от баттона.
    for (let r = 0; r < HOLE_CARDS[variant]; r++) {
      for (let k = 0; k < n; k++) this.players[(this.sbIndex + k) % n].hole.push(this.draw());
    }

    this.postBlind(this.sbIndex, smallBlind, 'small');
    this.postBlind(this.bbIndex, bigBlind, 'big');
    this.currentBet = bigBlind;
    this.lastRaiseSize = bigBlind;

    const first = n === 2 ? this.sbIndex : (this.bbIndex + 1) % n;
    this.progress(first);
  }

  // ---------- Публичное API ----------

  get isComplete(): boolean {
    return this.street === 'complete';
  }

  get pot(): number {
    return this.players.reduce((s, p) => s + p.totalCommitted, 0);
  }

  get activePlayerId(): string | null {
    return this.toAct >= 0 ? this.players[this.toAct].id : null;
  }

  player(id: string): HandPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  getLegalActions(): LegalActions | null {
    if (this.toAct < 0) return null;
    const p = this.players[this.toAct];
    const toCall = Math.max(0, this.currentBet - p.committed);
    const maxTotal = p.committed + p.stack;

    // Сколько максимум может поставить кто-то из соперников, кто ещё способен отвечать.
    const opponents = this.players.filter((o) => o !== p && !o.folded && !o.allIn);
    const maxOpp = opponents.reduce((m, o) => Math.max(m, o.committed + o.stack), 0);

    let canRaise = !p.hasActed && opponents.length > 0 && maxTotal > this.currentBet;
    let minRaiseTo = 0;
    let maxRaiseTo = 0;
    if (canRaise) {
      const potLimitTo = this.currentBet + this.pot + toCall;
      const capTo = this.variant === 'NLH' ? maxTotal : Math.min(maxTotal, potLimitTo);
      const fullMin = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.lastRaiseSize;
      minRaiseTo = Math.min(fullMin, capTo); // меньше минимума — только олл-ин
      maxRaiseTo = Math.max(minRaiseTo, Math.min(capTo, maxOpp));
      if (maxRaiseTo <= this.currentBet) canRaise = false;
    }

    return {
      playerId: p.id,
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: Math.min(toCall, p.stack),
      canRaise,
      isBet: this.currentBet === 0,
      minRaiseTo: canRaise ? minRaiseTo : 0,
      maxRaiseTo: canRaise ? maxRaiseTo : 0,
    };
  }

  act(playerId: string, input: ActionInput): void {
    if (this.isComplete || this.toAct < 0) throw new HandError('Раздача уже завершена');
    const p = this.players[this.toAct];
    if (p.id !== playerId) throw new HandError('Сейчас не ваш ход');
    const legal = this.getLegalActions()!;
    const idx = this.toAct;

    switch (input.type) {
      case 'fold':
        p.folded = true;
        this.log(p, 'fold', 0);
        break;
      case 'check':
        if (!legal.canCheck) throw new HandError('Нельзя чекнуть — нужно уравнять ставку');
        this.log(p, 'check', 0);
        break;
      case 'call': {
        if (!legal.canCall) throw new HandError('Нечего коллировать');
        this.log(p, 'call', this.put(p, legal.callAmount));
        break;
      }
      case 'allin': {
        if (legal.canRaise) this.raiseTo(p, legal.maxRaiseTo, legal.isBet ? 'bet' : 'raise');
        else if (legal.canCall) this.log(p, 'call', this.put(p, legal.callAmount));
        else this.log(p, 'check', 0);
        break;
      }
      case 'bet':
      case 'raise': {
        if (!legal.canRaise) throw new HandError('Повышать сейчас нельзя');
        const to = input.amount;
        if (to === undefined || !Number.isInteger(to)) throw new HandError('Укажите сумму ставки целым числом');
        if (to < legal.minRaiseTo || to > legal.maxRaiseTo) {
          throw new HandError(`Ставка должна быть от ${legal.minRaiseTo} до ${legal.maxRaiseTo}`);
        }
        this.raiseTo(p, to, legal.isBet ? 'bet' : 'raise');
        break;
      }
      default:
        throw new HandError('Неизвестное действие');
    }

    p.hasActed = true;
    this.progress((idx + 1) % this.players.length);
  }

  // ---------- Внутренняя логика ----------

  private draw(): Card {
    const c = this.deck[this.deckPos++];
    if (!c) throw new HandError('Колода закончилась');
    return c;
  }

  private put(p: HandPlayer, amount: number): number {
    const x = Math.min(amount, p.stack);
    p.stack -= x;
    p.committed += x;
    p.totalCommitted += x;
    if (p.stack === 0) p.allIn = true;
    return x;
  }

  private postBlind(i: number, amount: number, blind: 'small' | 'big') {
    const p = this.players[i];
    const x = this.put(p, amount);
    this.events.push({ kind: 'blind', playerId: p.id, blind, amount: x });
  }

  private raiseTo(p: HandPlayer, to: number, action: ActionType) {
    const raiseSize = to - this.currentBet;
    const added = this.put(p, to - p.committed);
    if (raiseSize >= this.lastRaiseSize) {
      // Полный рейз переоткрывает торговлю для всех остальных.
      this.lastRaiseSize = raiseSize;
      for (const o of this.players) if (o !== p && !o.folded && !o.allIn) o.hasActed = false;
    }
    // Неполный олл-ин торговлю не переоткрывает: уже действовавшие могут только коллировать или сбросить.
    this.currentBet = Math.max(this.currentBet, p.committed);
    this.log(p, p.allIn ? 'allin' : action, added);
  }

  private log(p: HandPlayer, action: ActionType, added: number) {
    this.events.push({ kind: 'action', playerId: p.id, action, added, total: p.committed, allIn: p.allIn });
  }

  private live(): HandPlayer[] {
    return this.players.filter((p) => !p.folded);
  }

  private needsAction(p: HandPlayer): boolean {
    return !p.folded && !p.allIn && (!p.hasActed || p.committed < this.currentBet);
  }

  private roundComplete(): boolean {
    const actors = this.live().filter((p) => !p.allIn);
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].committed >= this.currentBet) return true;
    return actors.every((p) => !this.needsAction(p));
  }

  private progress(from: number) {
    if (this.live().length === 1) return this.finishUncontested();
    if (!this.roundComplete()) {
      const n = this.players.length;
      for (let k = 0; k < n; k++) {
        const i = (from + k) % n;
        if (this.needsAction(this.players[i])) {
          this.toAct = i;
          return;
        }
      }
    }
    this.endStreet();
  }

  private endStreet() {
    this.toAct = -1;
    for (;;) {
      for (const p of this.players) {
        p.committed = 0;
        p.hasActed = false;
      }
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;

      if (this.street === 'river') return this.finishShowdown();
      this.dealNextStreet();

      const actors = this.live().filter((p) => !p.allIn);
      if (actors.length >= 2) {
        // Постфлоп первым действует первый живой игрок слева от баттона.
        this.progress((this.buttonIndex + 1) % this.players.length);
        return;
      }
      // Торговаться некому — докладываем стол до ривера.
    }
  }

  private dealNextStreet() {
    this.draw(); // сжигаем карту
    if (this.street === 'preflop') {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.street = 'flop';
    } else if (this.street === 'flop') {
      this.board.push(this.draw());
      this.street = 'turn';
    } else {
      this.board.push(this.draw());
      this.street = 'river';
    }
    this.events.push({ kind: 'street', street: this.street, board: this.board.slice() });
  }

  private finishUncontested() {
    const winner = this.live()[0];
    const amount = this.pot;
    winner.stack += amount;
    this.events.push({ kind: 'award', playerId: winner.id, amount, potIndex: 0 });
    this.complete({
      showdown: false,
      pots: [{ amount, eligible: [winner.id], winners: [winner.id], shares: { [winner.id]: amount } }],
      collected: { [winner.id]: amount },
      hands: {},
    });
  }

  /** Основной банк и сайд-поты по уровням вложений. */
  buildPots(): { amount: number; eligible: string[] }[] {
    const live = this.live();
    const levels = [...new Set(live.map((p) => p.totalCommitted))].filter((x) => x > 0).sort((a, b) => a - b);
    const pots: { amount: number; eligible: string[] }[] = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of this.players) amount += Math.min(p.totalCommitted, level) - Math.min(p.totalCommitted, prev);
      const eligible = live.filter((p) => p.totalCommitted >= level).map((p) => p.id);
      const last = pots[pots.length - 1];
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    const leftover = this.pot - pots.reduce((s, x) => s + x.amount, 0);
    if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  private finishShowdown() {
    const values = new Map<string, HandValue>();
    for (const p of this.live()) {
      values.set(p.id, this.variant === 'NLH' ? bestHoldem(p.hole, this.board) : bestOmaha(p.hole, this.board));
    }
    const n = this.players.length;
    // Порядок для лишней фишки при делёжке: первый слева от баттона.
    const order = (id: string) => (this.players.findIndex((p) => p.id === id) - this.buttonIndex - 1 + n) % n;

    const collected: Record<string, number> = {};
    const pots: PotAward[] = this.buildPots().map((pot, potIndex) => {
      const best = Math.max(...pot.eligible.map((id) => values.get(id)!.score));
      const winners = pot.eligible.filter((id) => values.get(id)!.score === best).sort((a, b) => order(a) - order(b));
      const base = Math.floor(pot.amount / winners.length);
      let rest = pot.amount - base * winners.length;
      const shares: Record<string, number> = {};
      for (const w of winners) {
        const share = base + (rest-- > 0 ? 1 : 0);
        shares[w] = share;
        collected[w] = (collected[w] ?? 0) + share;
        this.player(w)!.stack += share;
        this.events.push({ kind: 'award', playerId: w, amount: share, potIndex, hand: values.get(w)!.name });
      }
      return { ...pot, winners, shares };
    });

    const hands: HandResult['hands'] = {};
    for (const [id, v] of values) hands[id] = { name: v.name, cards: v.cards };
    this.complete({ showdown: true, pots, collected, hands });
  }

  private complete(r: Omit<HandResult, 'net'>) {
    this.toAct = -1;
    this.street = 'complete';
    const net: Record<string, number> = {};
    for (const p of this.players) net[p.id] = p.stack - p.startStack;
    this.result = { ...r, net };
  }

  /** Состояние раздачи глазами конкретного игрока: чужие карты скрыты до вскрытия. */
  viewFor(viewerId: string | null) {
    const shown = this.result?.showdown ? new Set(Object.keys(this.result.hands)) : new Set<string>();
    return {
      variant: this.variant,
      street: this.street,
      board: this.board.slice(),
      pot: this.pot,
      currentBet: this.currentBet,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      buttonSeat: this.players[this.buttonIndex].seat,
      activePlayerId: this.activePlayerId,
      players: this.players.map((p) => ({
        id: p.id,
        seat: p.seat,
        stack: p.stack,
        committed: p.committed,
        folded: p.folded,
        allIn: p.allIn,
        cardCount: p.hole.length,
        hole: p.id === viewerId || shown.has(p.id) ? p.hole.slice() : null,
      })),
      legal: this.activePlayerId === viewerId ? this.getLegalActions() : null,
      result: this.result,
    };
  }
}
