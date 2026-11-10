import { TableSocket } from './api.js';
import { h, mount, toast, sheet, fmt, plural } from './dom.js';
import { cardEl, slotEl, currentCombo } from './cards.js';

const STREET = { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер', complete: 'Раздача окончена' };

export function statsTable(players, { live = false } = {}) {
  return h(
    'table.stats',
    {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Игрок'), h('th', {}, 'Закупил'), h('th', {}, 'Фишки'), h('th', {}, 'Итог'), h('th', {}, 'Раздач'))),
    h(
      'tbody',
      {},
      players.map((p) =>
        h(
          'tr',
          {},
          h('td', {}, p.displayName, live && p.status === 'away' ? h('div.away', {}, 'встал из-за стола') : null),
          h('td.num', {}, fmt(p.buyIn)),
          h('td.num', {}, fmt(p.stack)),
          h('td.num', { class: p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '' }, (p.net > 0 ? '+' : '') + fmt(p.net)),
          h('td.num', {}, fmt(p.handsPlayed)),
        ),
      ),
    ),
  );
}

/** Положение места на овале: своё место всегда внизу по центру. */
function seatPos(k, n, scale = 1) {
  const a = ((90 + (k * 360) / n) * Math.PI) / 180;
  return { left: `${50 + 41 * scale * Math.cos(a)}%`, top: `${50 + 43 * scale * Math.sin(a)}%` };
}

export function tableScreen(root, tableId, app) {
  let st = null;
  let clockOffset = 0;
  let raise = { open: false, value: 0, key: '' };
  let raf = 0;
  let lastTurnKey = '';

  const top = h('header.game-top');
  const arena = h('div.arena');
  const dock = h('div.dock');
  mount(root, h('main.game', {}, top, arena, dock));
  mount(top, h('a.icon-btn', { href: '#/', 'aria-label': 'К списку столов' }, '‹'), h('div.name', {}, h('b', {}, 'Подключаюсь…')));

  const sock = new TableSocket(tableId, {
    onState: (s) => {
      clockOffset = s.serverNow - Date.now();
      st = s;
      draw();
    },
    onError: (m) => toast(m, true),
    onClosed: (stats, message) => {
      if (stats) {
        toast('Стол закрыт. Вот итоги.');
        location.hash = `#/t/${tableId}/stats`;
      } else {
        mount(root, h('main.page', {}, h('h1', {}, 'Стол недоступен'), h('p.lede', {}, message || 'Стол не найден.'), h('a.btn.block', { href: `#/t/${tableId}/stats` }, 'Посмотреть итоги'), h('a.btn.ghost.block', { href: '#/', style: { marginTop: '8px' } }, 'К списку столов')));
      }
    },
    onStatus: (s) => s === 'offline' && st && toast('Связь потеряна, переподключаюсь…', true),
  });

  const now = () => Date.now() + clockOffset;
  const send = (msg) => sock.send(msg);
  const name = (id) => st.seats.find((s) => !s.empty && s.userId === id)?.displayName ?? st.stats.find((r) => r.userId === id)?.displayName ?? 'Игрок';

  // ---------- Отрисовка ----------

  function draw() {
    const t = st.table;
    const hand = st.hand;
    const legal = hand?.legal ?? null;
    const me = st.me;

    // Сигнал «твой ход»: вибрация на телефоне и заголовок вкладки
    const turnKey = legal ? `${st.handNumber}:${hand.street}:${hand.currentBet}:${hand.pot}` : '';
    if (turnKey && turnKey !== lastTurnKey) navigator.vibrate?.(60);
    lastTurnKey = turnKey;
    document.title = legal ? 'Твой ход — покер' : `${t.name} — покер`;

    // Новое решение — закрываем панель рейза
    if (raise.key !== turnKey) raise = { open: false, value: legal?.minRaiseTo ?? 0, key: turnKey };

    mount(
      top,
      h('a.icon-btn', { href: '#/', 'aria-label': 'К списку столов' }, '‹'),
      h('div.name', {}, h('b', {}, t.name), h('small', {}, `${t.variant === 'PLO5' ? 'Омаха PL5' : 'Холдем NL'}, ${fmt(t.smallBlind)}/${fmt(t.bigBlind)}`, t.closing ? ', закрывается' : '')),
      h('button.icon-btn', { onclick: openStats, 'aria-label': 'Статистика стола' }, '≡'),
      h('button.icon-btn', { onclick: openMenu, 'aria-label': 'Меню стола' }, '⋯'),
    );

    drawArena(hand, me);
    drawDock(hand, legal, me);
    tick();
  }

  function drawArena(hand, me) {
    const n = st.table.maxSeats;
    const base = me.seat ?? 0;
    const inHand = new Map((hand?.players ?? []).map((p) => [p.id, p]));
    const result = hand?.result;
    const live = st.handInProgress;
    const showdown = !!result?.showdown;
    const winners = new Set(result ? Object.keys(result.collected) : []);

    const els = [h('div.felt')];

    for (const s of st.seats) {
      const k = (s.seat - base + n) % n;
      const pos = seatPos(k, n);
      if (s.empty) {
        const canSit = me.seat === null && !st.table.closing;
        els.push(
          h('div.seat', { style: pos },
            h('button.seat-empty', { class: canSit ? 'free' : '', disabled: !canSit, onclick: () => trySit(s.seat), 'aria-label': canSit ? `Сесть на место ${s.seat + 1}` : 'Свободное место' }, canSit ? 'Сесть' : ''),
          ),
        );
        continue;
      }
      const p = inHand.get(s.userId);
      const isMe = s.userId === me.userId;
      const active = live && hand.activePlayerId === s.userId;
      const folded = p?.folded;
      const tag = s.leaving ? 'уходит' : s.sittingOut ? 'отошёл' : !s.online ? 'не в сети' : p?.allIn && live ? 'олл-ин' : folded && live ? 'фолд' : '';

      // Карты над табличкой: у соперников рубашки, на вскрытии — открытые
      let mini = null;
      if (p && !isMe && (!folded || !live)) {
        const open = !!p.hole;
        if (live || open) {
          mini = h(
            'div.mini',
            { class: `${hand.variant === 'PLO5' ? 'omaha' : ''} ${open ? 'show' : ''}` },
            open ? p.hole.map((c) => cardEl(c)) : Array.from({ length: p.cardCount }, () => cardEl(null)),
          );
        }
      }

      let res = null;
      if (result && p && !live) {
        const net = result.net[s.userId] ?? 0;
        const combo = showdown ? result.hands[s.userId]?.name : null;
        if (net || combo) res = h('div.result', { class: net < 0 ? 'lost' : '' }, net > 0 ? `+${fmt(net)}` : net < 0 ? fmt(net) : '', combo ? h('div', {}, combo) : null);
      }

      els.push(
        h(
          'div.seat',
          { class: [active && 'active', folded && live && 'folded', (s.sittingOut || s.leaving) && 'away', isMe && 'me'].filter(Boolean).join(' '), style: pos },
          mini,
          h(
            'div.plate',
            {},
            h('div.who', {}, s.displayName),
            h('div.stack.num', {}, fmt(s.stack)),
            tag ? h('div.tag', {}, tag) : null,
            active ? h('div.timer', { dataset: { timer: '1' } }) : null,
          ),
          res,
        ),
      );

      // Ставка на текущей улице — фишка между игроком и центром
      if (p && live && p.committed > 0) els.push(h('div.bet.num', { style: seatPos(k, n, 0.58) }, fmt(p.committed)));
    }

    // Баттон
    if (hand) {
      const k = (hand.buttonSeat - base + n) % n;
      els.push(h('div.dealer', { style: seatPos(k + 0.22, n, 0.7), 'aria-label': 'Баттон' }, 'D'));
    }

    // Центр: борд, банк, статус
    const board = hand?.board ?? [];
    const win = new Set(showdown ? Object.entries(result.hands).filter(([id]) => winners.has(id)).flatMap(([, v]) => v.cards) : []);
    els.push(
      h(
        'div.center',
        {},
        h('div.board', { 'aria-label': 'Карты на столе' }, Array.from({ length: 5 }, (_, i) => (board[i] ? cardEl(board[i], win.has(board[i]) ? 'win' : '') : slotEl()))),
        hand ? h('div.pot.num', {}, fmt(hand.pot), h('small', {}, live ? STREET[hand.street] : 'банк')) : null,
        h('div.status-line', { dataset: { status: '1' } }),
      ),
    );
    mount(arena, els);
  }

  function drawDock(hand, legal, me) {
    const parts = [];
    const mySeat = me.seat !== null ? st.seats[me.seat] : null;
    const myP = hand?.players.find((p) => p.id === me.userId);

    if (!mySeat) {
      parts.push(
        h('div.waiting', {},
          me.reservedStack
            ? `Твой стек ${fmt(me.reservedStack)} сохранён. Выбери место, чтобы вернуться.`
            : st.table.closing
              ? 'Стол закрывается.'
              : 'Выбери свободное место, чтобы сесть за стол.'),
      );
      mount(dock, parts);
      return;
    }

    // Мои карты; на вскрытии подсвечиваем те, что вошли в выигрышную комбинацию
    const showMine = !!myP?.hole;
    const res = hand?.result;
    const myWin = new Set(res?.showdown && res.collected[me.userId] ? res.hands[me.userId]?.cards ?? [] : []);
    const omaha = (hand?.variant ?? st.table.variant) === 'PLO5';
    parts.push(
      h(
        'div.myhand',
        { class: omaha ? 'omaha' : '' },
        showMine ? myP.hole.map((c) => cardEl(c, myP.folded && st.handInProgress ? 'dim' : myWin.has(c) ? 'win' : '')) : h('span.label', {}, mySeat.sittingOut ? 'Ты отошёл от стола' : 'Ждём следующую раздачу'),
      ),
    );
    const combo = showMine && !myP.folded ? currentCombo(hand.variant, myP.hole, hand.board) : null;
    parts.push(h('div.combo', {}, combo ?? (myP?.folded && st.handInProgress ? 'Ты сбросил карты' : '')));

    if (legal) {
      parts.push(...actionControls(hand, legal, myP));
    } else if (mySeat.sittingOut) {
      parts.push(
        h('div.actions-row', { style: { gridTemplateColumns: mySeat.stack > 0 ? '1fr' : '1fr 1fr' } },
          mySeat.stack > 0 ? h('button.btn.primary', { onclick: () => send({ t: 'sit_in' }) }, 'Вернуться в игру') : [
            h('button.btn.primary', { onclick: openRebuy }, 'Докупить фишки'),
            h('button.btn', { onclick: () => send({ t: 'stand' }) }, 'Встать'),
          ],
        ),
      );
    } else {
      parts.push(h('div.waiting', { 'aria-hidden': 'true' }));
    }
    mount(dock, parts);
  }

  function actionControls(hand, legal, myP) {
    const out = [];
    const maxTotal = myP.committed + myP.stack;
    const toCall = hand.currentBet - myP.committed;

    if (raise.open && legal.canRaise) {
      const { minRaiseTo: min, maxRaiseTo: max } = legal;
      const potBase = hand.pot + Math.max(0, toCall);
      const preset = (f) => Math.round(Math.min(max, Math.max(min, hand.currentBet + f * potBase)));
      const amount = h('input.input.num', {
        type: 'number', inputMode: 'numeric', min, max, step: 1, value: raise.value, 'aria-label': 'Сумма',
        oninput: () => setValue(Number(amount.value), false),
      });
      const range = h('input', { type: 'range', min, max, step: Math.max(1, Math.round(st.table.bigBlind / 2)), value: raise.value, 'aria-label': 'Сумма ставки', oninput: () => setValue(Number(range.value)) });
      const confirm = h('button.btn.primary.block', { style: { marginTop: '10px' }, onclick: () => {
        const v = Math.round(raise.value);
        if (!(v >= min && v <= max)) return toast(`Сумма должна быть от ${fmt(min)} до ${fmt(max)}`, true);
        send({ t: 'action', action: v === maxTotal ? { type: 'allin' } : { type: legal.isBet ? 'bet' : 'raise', amount: v } });
      } });
      const label = () => (Math.round(raise.value) === maxTotal ? `Олл-ин ${fmt(maxTotal)}` : `${legal.isBet ? 'Ставка' : 'Рейз до'} ${fmt(Math.round(raise.value))}`);
      function setValue(v, syncInput = true) {
        raise.value = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
        range.value = raise.value;
        if (syncInput) amount.value = raise.value;
        confirm.textContent = label();
      }
      confirm.textContent = label();
      const step = st.table.bigBlind;
      out.push(
        h('div.raise-panel', {},
          h('div.raise-amount', {},
            h('button.btn', { onclick: () => setValue(raise.value - step), 'aria-label': 'Меньше' }, '−'),
            amount,
            h('button.btn', { onclick: () => setValue(raise.value + step), 'aria-label': 'Больше' }, '+'),
          ),
          range,
          h('div.presets', {},
            h('button.btn', { onclick: () => setValue(preset(0.5)) }, '½ банка'),
            h('button.btn', { onclick: () => setValue(preset(0.75)) }, '¾ банка'),
            h('button.btn', { onclick: () => setValue(preset(1)) }, 'Банк'),
            h('button.btn', { onclick: () => setValue(max) }, max === maxTotal ? 'Олл-ин' : 'Макс'),
          ),
          confirm,
        ),
      );
    }

    const callBtn = legal.canCheck
      ? h('button.btn', { onclick: () => send({ t: 'action', action: { type: 'check' } }) }, 'Чек')
      : h('button.btn.stack', { onclick: () => send({ t: 'action', action: { type: 'call' } }) },
          legal.callAmount >= myP.stack ? 'Олл-ин' : 'Колл', h('small.num', {}, fmt(legal.callAmount)));
    const raiseBtn = legal.canRaise
      ? raise.open
        ? h('button.btn', { onclick: () => { raise.open = false; draw(); } }, 'Скрыть')
        : h('button.btn.primary', { onclick: () => { raise.open = true; raise.value = legal.minRaiseTo; draw(); } }, legal.isBet ? 'Ставка' : 'Рейз')
      : h('button.btn', { disabled: true }, 'Рейз');

    out.push(
      h('div.actions-row', {},
        h('button.btn.danger', { onclick: () => send({ t: 'action', action: { type: 'fold' } }) }, 'Фолд'),
        callBtn,
        raiseBtn,
      ),
    );
    return out;
  }

  // Таймер хода и обратный отсчёт до раздачи — обновляем без перерисовки
  function tick() {
    cancelAnimationFrame(raf);
    const loop = () => {
      if (!st) return;
      const t = now();
      const bar = arena.querySelector('[data-timer]');
      if (bar && st.actionDeadline) {
        const left = Math.max(0, st.actionDeadline - t);
        bar.style.width = `${(left / (st.table.actionTime * 1000)) * 100}%`;
      }
      const text = statusText(t);
      for (const el of document.querySelectorAll('[data-status]')) if (el.textContent !== text) el.textContent = text;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function statusText(t) {
    const hand = st.hand;
    if (st.table.closing) return 'Стол закроется после этой раздачи';
    if (st.handInProgress && hand.activePlayerId) {
      const sec = st.actionDeadline ? Math.ceil(Math.max(0, st.actionDeadline - t) / 1000) : '';
      return hand.activePlayerId === st.me.userId ? `Твой ход, ${sec} с` : `Ходит ${name(hand.activePlayerId)}, ${sec} с`;
    }
    if (st.nextHandAt) {
      const sec = Math.ceil(Math.max(0, st.nextHandAt - t) / 1000);
      return `Следующая раздача через ${sec} с`;
    }
    const ready = st.seats.filter((s) => !s.empty && !s.sittingOut && s.stack > 0).length;
    if (ready < 2) return 'Ждём игроков: нужно минимум двое';
    return '';
  }

  // ---------- Действия и листы ----------

  function trySit(seat) {
    if (st.me.reservedStack) return send({ t: 'sit', seat });
    const { minBuyIn: min, maxBuyIn: max, bigBlind: bb } = st.table;
    let value = Math.min(max, Math.max(min, bb * 100));
    const amount = h('input.input.num', { type: 'number', inputMode: 'numeric', min, max, value, oninput: () => sync(Number(amount.value), false) });
    const range = h('input', { type: 'range', min, max, step: bb, value, style: { width: '100%', margin: '14px 0', accentColor: 'var(--brass)' }, oninput: () => sync(Number(range.value)) });
    const go = h('button.btn.primary.block', { onclick: () => { close(); send({ t: 'sit', seat, buyIn: value }); } });
    function sync(v, setInput = true) {
      value = Math.min(max, Math.max(min, Math.round(v) || min));
      range.value = value;
      if (setInput) amount.value = value;
      go.textContent = `Сесть с ${fmt(value)}`;
    }
    sync(value);
    const close = sheet('Сколько фишек взять за стол', amount, range, h('p.hint', {}, `От ${fmt(min)} до ${fmt(max)}. Если встанешь из-за стола, стек сохранится до его закрытия.`), h('div.actions', {}, go));
  }

  function openRebuy() {
    const seat = st.seats[st.me.seat];
    const max = st.table.maxBuyIn - seat.stack;
    if (max <= 0) return toast('У тебя уже максимальный стек для этого стола');
    let value = Math.min(max, st.table.minBuyIn);
    const amount = h('input.input.num', { type: 'number', inputMode: 'numeric', min: 1, max, value, oninput: () => (value = Number(amount.value)) });
    const close = sheet(
      'Докупить фишки',
      amount,
      h('p.hint', {}, `Сейчас у тебя ${fmt(seat.stack)}. Можно докупить до ${fmt(max)}. Если идёт раздача с твоим участием, докупка будет доступна после неё.`),
      h('div.actions', {}, h('button.btn.primary.block', { onclick: () => { close(); send({ t: 'add_chips', amount: Math.round(value) }); if (seat.sittingOut) setTimeout(() => send({ t: 'sit_in' }), 150); } }, 'Докупить')),
    );
  }

  function openStats() {
    sheet(
      'Статистика стола',
      st.stats.length ? statsTable(st.stats, { live: true }) : h('p.hint', {}, 'Пока никто не садился за стол.'),
      h('p.hint', { style: { marginTop: '12px' } }, `Сыграно ${fmt(st.handNumber)} ${plural(st.handNumber, 'раздача', 'раздачи', 'раздач')}. Во время раздачи стеки показаны на её начало.`),
    );
  }

  function openMenu() {
    const me = st.me;
    const seat = me.seat !== null ? st.seats[me.seat] : null;
    const items = [];
    const item = (label, fn, cls = '') => h('button.btn.block', { class: cls, onclick: () => { close(); fn(); } }, label);

    items.push(item('Скопировать ссылку на стол', async () => {
      const url = `${location.origin}/#/t/${tableId}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Ссылка скопирована. Отправь её друзьям.');
      } catch {
        prompt('Скопируй ссылку', url);
      }
    }));
    items.push(item('Проверить честность колоды', openFairness));
    if (seat) {
      if (seat.stack < st.table.maxBuyIn) items.push(item('Докупить фишки', openRebuy));
      items.push(seat.sittingOut ? item('Вернуться в игру', () => send({ t: 'sit_in' })) : item('Отойти на время', () => send({ t: 'sit_out' })));
      items.push(item('Встать из-за стола', () => send({ t: 'stand' })));
    }
    if (me.isOwner && !st.table.closing) {
      items.push(item('Закрыть стол', () => {
        if (confirm(st.handInProgress ? 'Закрыть стол после текущей раздачи? Итоги сохранятся.' : 'Закрыть стол? Итоги сохранятся.')) send({ t: 'close' });
      }, 'danger'));
    }
    const close = sheet('Стол', h('div.actions', { style: { marginTop: 0 } }, items));
  }

  function openFairness() {
    const d = st.lastDeck;
    const out = h('p.hint');
    const body = [
      h('p.hint', {}, 'Перед каждой раздачей сервер публикует отпечаток перетасованной колоды (SHA-256). После раздачи колода раскрывается, и любой может пересчитать отпечаток и убедиться, что карты не меняли по ходу игры.'),
      st.commitment ? [h('h2', { style: { margin: '14px 0 6px', fontSize: '0.9rem', color: 'var(--muted)' } }, `Текущая раздача №${st.handNumber}`), h('div.mono-hash', {}, st.commitment)] : null,
    ];
    if (d) {
      body.push(
        h('h2', { style: { margin: '16px 0 6px', fontSize: '0.9rem', color: 'var(--muted)' } }, `Прошлая раздача №${d.handNumber}`),
        h('div.mono-hash', {}, d.commitment),
        h('div.deck-row', { 'aria-label': 'Порядок карт в колоде' }, d.cards.map((c) => cardEl(c))),
        h('div.mono-hash', {}, `соль: ${d.salt}`),
        h('button.btn.block', { style: { marginTop: '12px' }, onclick: async () => {
          try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${d.salt}:${d.cards.join('')}`));
            const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
            out.textContent = hex === d.commitment ? 'Отпечаток совпадает: колоду не меняли.' : 'Отпечаток НЕ совпадает!';
            out.style.color = hex === d.commitment ? 'var(--win)' : 'var(--loss)';
          } catch {
            out.textContent = 'Проверка работает только на сайте с HTTPS.';
          }
        } }, 'Пересчитать отпечаток'),
        out,
      );
    } else body.push(h('p.hint', {}, 'Раскрытая колода появится после первой раздачи.'));
    sheet('Честность колоды', body);
  }

  return () => {
    cancelAnimationFrame(raf);
    sock.stop();
    document.title = 'Покер для своих';
    document.querySelector('.sheet-back')?.remove();
  };
}
