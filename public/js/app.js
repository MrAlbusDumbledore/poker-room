import { api } from './api.js';
import { h, mount, toast, fmt, plural, sheet } from './dom.js';
import { tableScreen, statsTable } from './table.js';

const root = document.getElementById('app');
const state = { user: null, config: null, incoming: 0 };
let cleanup = null;

// ---------- Маршрутизация (через #адрес, чтобы ссылки на стол работали везде) ----------

const routes = [
  [/^#\/login$/, loginScreen, false],
  [/^#\/register$/, registerScreen, false],
  [/^#\/friends$/, friendsScreen, true],
  [/^#\/new$/, newTableScreen, true],
  [/^#\/profile$/, profileScreen, true],
  [/^#\/admin$/, adminScreen, true],
  [/^#\/t\/([\w-]+)$/, (m) => tableScreen(root, m[1], state), true],
  [/^#\/t\/([\w-]+)\/stats$/, (m) => statsScreen(m[1]), true],
  [/^#?\/?$/, lobbyScreen, true],
];

async function render() {
  cleanup?.();
  cleanup = null;
  const hash = location.hash || '#/';
  for (const [re, screen, needAuth] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    if (needAuth && !state.user) {
      sessionStorage.setItem('after-login', hash);
      location.hash = '#/login';
      return;
    }
    if (!needAuth && state.user) {
      location.hash = '#/';
      return;
    }
    cleanup = (await screen(m)) ?? null;
    return;
  }
  location.hash = '#/';
}

export const go = (hash) => (location.hash = hash);

function tabbar(active) {
  const tab = (hash, label, key, badge) =>
    h('a', { href: hash, 'aria-current': active === key ? 'page' : undefined }, label, badge ? h('span.badge', {}, badge) : null);
  return h(
    'nav.tabbar',
    { 'aria-label': 'Разделы' },
    tab('#/', 'Столы', 'lobby'),
    tab('#/friends', 'Друзья', 'friends', state.incoming || null),
    tab('#/profile', 'Профиль', 'profile'),
  );
}

function balancePill() {
  return h('a.balance-pill.num', { href: '#/profile', title: 'Баланс фишек' }, fmt(state.user?.balance ?? 0));
}

async function refreshMe() {
  try {
    const me = await api('GET', '/api/me');
    if (me.user) state.user = me.user;
  } catch {}
}

async function refreshIncoming() {
  try {
    const f = await api('GET', '/api/friends');
    state.incoming = f.incoming.length;
  } catch {}
}

// ---------- Вход и регистрация ----------

function brand() {
  return h('div.brand', {}, h('div.mark', { 'aria-hidden': 'true' }, '♠'), h('div', {}, h('b', {}, 'Покер для своих'), h('div.hint', {}, 'Холдем и Омаха на фишки с друзьями')));
}

function authForm({ title, fields, submit, onSubmit, footer }) {
  const err = h('p.error', { role: 'alert' });
  const btn = h('button.btn.primary.block', { type: 'submit' }, submit);
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          await onSubmit(Object.fromEntries(new FormData(form)));
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    fields,
    err,
    btn,
  );
  mount(root, h('main.auth', {}, brand(), h('h1', { style: { fontSize: '1.4rem', margin: '0 0 18px' } }, title), form, h('p.switch', {}, footer)));
}

const field = (label, input, hint) => h('label.field', {}, h('span', {}, label), input, hint ? h('div.hint', {}, hint) : null);

async function afterAuth(user) {
  state.user = user;
  await refreshIncoming();
  const next = sessionStorage.getItem('after-login');
  sessionStorage.removeItem('after-login');
  location.hash = next || '#/';
}

function loginScreen() {
  authForm({
    title: 'Вход',
    submit: 'Войти',
    fields: [
      field('Логин', h('input.input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none' })),
      field('Пароль', h('input.input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    ],
    onSubmit: async (d) => afterAuth((await api('POST', '/api/login', d)).user),
    footer: ['Нет аккаунта? ', h('a', { href: '#/register' }, 'Зарегистрироваться')],
  });
}

function registerScreen() {
  authForm({
    title: 'Регистрация',
    submit: 'Создать аккаунт',
    fields: [
      field('Логин', h('input.input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', pattern: '[a-zA-Z0-9_]{3,20}' }), 'Латиница, цифры и _, от 3 до 20 символов. По логину тебя найдут друзья.'),
      field('Имя за столом', h('input.input', { name: 'displayName', maxLength: 24, placeholder: 'Например, Миша' })),
      field('Пароль', h('input.input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minLength: 6 }), 'Минимум 6 символов'),
      h('p.hint', {}, `После регистрации на балансе будет ${fmt(state.config?.startBalance ?? 1_000_000)} фишек.`),
    ],
    onSubmit: async (d) => afterAuth((await api('POST', '/api/register', d)).user),
    footer: ['Уже есть аккаунт? ', h('a', { href: '#/login' }, 'Войти')],
  });
}

// ---------- Лобби ----------

const shortVariant = (v) => (v === 'PLO5' ? 'Омаха PL5' : 'Холдем NL');

async function lobbyScreen() {
  const list = h('div', {}, h('p.hint', {}, 'Загружаю столы…'));
  mount(
    root,
    h(
      'main.page',
      {},
      h('div.page-head', {}, h('h1', {}, 'Столы'), balancePill(), h('a.btn.primary.small', { href: '#/new' }, 'Новый стол')),
      list,
    ),
    tabbar('lobby'),
  );
  const load = async () => {
    try {
      await refreshMe();
      document.querySelector('.page-head .balance-pill')?.replaceWith(balancePill());
      const { tables } = await api('GET', '/api/tables');
      if (!tables.length) {
        mount(
          list,
          h(
            'div.empty',
            {},
            h('div', {}, 'Пока нет открытых столов.'),
            h('div.hint', {}, 'Здесь появятся твои столы и столы друзей.'),
            h('a.btn.primary', { href: '#/new' }, 'Создать стол'),
          ),
        );
        return;
      }
      mount(
        list,
        h(
          'ul.list',
          {},
          tables.map((t) =>
            h(
              'li',
              {},
              h(
                'a.row',
                { href: `#/t/${t.id}` },
                h(
                  'div.grow',
                  {},
                  h('div.title', {}, t.name),
                  h('div.sub', {}, `${shortVariant(t.variant)}, блайнды ${fmt(t.smallBlind)}/${fmt(t.bigBlind)}`),
                  h('div.pips', { 'aria-label': `Занято ${t.seated} из ${t.maxSeats}` }, Array.from({ length: t.maxSeats }, (_, i) => h('i', { class: i < t.seated ? 'on' : '' }))),
                ),
                h('div.sub', { style: { textAlign: 'right' } }, t.owner?.id === state.user.id ? 'мой' : t.owner?.displayName),
              ),
            ),
          ),
        ),
      );
    } catch (e) {
      mount(list, h('p.error', {}, e.message));
    }
  };
  await load();
  const timer = setInterval(load, 10_000);
  return () => clearInterval(timer);
}

// ---------- Новый стол ----------

function seg(name, options, checked) {
  return h(
    'div.seg',
    { role: 'radiogroup' },
    options.map(([value, label]) =>
      h('label', {}, h('input', { type: 'radio', name, value, checked: String(value) === String(checked) }), h('span', {}, label)),
    ),
  );
}

function newTableScreen() {
  const stakes = state.config.stakes;
  const err = h('p.error', { role: 'alert' });
  const seatsWrap = h('div');
  const renderSeats = (variant, current) => {
    const max = variant === 'PLO5' ? 8 : 9;
    const opts = [];
    for (let n = 2; n <= max; n++) opts.push([n, String(n)]);
    mount(seatsWrap, seg('maxSeats', opts, Math.min(current, max)));
  };
  renderSeats('NLH', 6);

  const form = h(
    'form',
    {
      onchange: (e) => {
        if (e.target.name === 'variant') renderSeats(e.target.value, Number(new FormData(form).get('maxSeats')) || 6);
      },
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const d = Object.fromEntries(new FormData(form));
        try {
          const { table } = await api('POST', '/api/tables', d);
          go(`#/t/${table.id}`);
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    field('Название', h('input.input', { name: 'name', maxLength: 40, placeholder: `Стол ${state.user.displayName}` })),
    h('label.field', {}, h('span', {}, 'Игра'), seg('variant', [['NLH', 'Холдем, безлимит'], ['PLO5', 'Омаха 5 карт, пот-лимит']], 'NLH')),
    h('div.field', {}, h('span', {}, 'Мест за столом'), seatsWrap),
    h('div.field', {}, h('span', {}, 'Блайнды'), seg('stakeId', stakes.map((s) => [s.id, s.label]), stakes[0].id)),
    h('div.field', {}, h('span', {}, 'Бай-ин, в больших блайндах'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
        h('input.input.num', { name: 'minBuyInBB', type: 'number', min: 1, max: 1000, value: 40, 'aria-label': 'Минимум' }),
        h('input.input.num', { name: 'maxBuyInBB', type: 'number', min: 1, max: 1000, value: 200, 'aria-label': 'Максимум' }),
      ),
      h('div.hint', {}, 'Минимум и максимум. При блайндах 10/20 это от 800 до 4 000 фишек.'),
    ),
    h('div.field', {}, h('span', {}, 'Время на ход'), seg('actionTime', [[15, '15 с'], [30, '30 с'], [45, '45 с'], [60, '60 с']], 30)),
    err,
    h('button.btn.primary.block', { type: 'submit' }, 'Создать стол'),
  );
  mount(root, h('main.page', {}, h('h1', {}, 'Новый стол'), form), tabbar('lobby'));
}

// ---------- Друзья ----------

async function friendsScreen() {
  const results = h('div');
  const lists = h('div');
  const person = (u, ...actions) =>
    h('li', {}, h('div.grow', {}, h('div.title', {}, u.displayName), h('div.sub', {}, '@' + u.username)), ...actions);

  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      await load();
    } catch (e) {
      toast(e.message, true);
    }
  };

  const load = async () => {
    const f = await api('GET', '/api/friends');
    state.incoming = f.incoming.length;
    document.querySelector('.tabbar')?.replaceWith(tabbar('friends'));
    mount(
      lists,
      f.incoming.length
        ? [
            h('h2', {}, 'Заявки в друзья'),
            h('ul.list', {}, f.incoming.map((u) =>
              person(
                u,
                h('button.btn.primary.small', { onclick: () => act(() => api('POST', `/api/friends/${u.id}/accept`, {}), `${u.displayName} теперь в друзьях`) }, 'Принять'),
                h('button.btn.ghost.small', { onclick: () => act(() => api('POST', `/api/friends/${u.id}/remove`, {})) }, 'Отклонить'),
              ),
            )),
          ]
        : null,
      h('h2', {}, f.friends.length ? `Друзья: ${f.friends.length}` : 'Друзья'),
      f.friends.length
        ? h('ul.list', {}, f.friends.map((u) =>
            person(u,
              h('button.btn.small', { onclick: () => openTransfer(u, load) }, 'Перевести'),
              h('button.btn.ghost.small', { 'aria-label': `Удалить ${u.displayName} из друзей`, onclick: () => confirm(`Удалить ${u.displayName} из друзей?`) && act(() => api('POST', `/api/friends/${u.id}/remove`, {})) }, 'Удалить')),
          ))
        : h('div.empty', {}, 'Найди друзей по логину или имени через поиск выше.'),
      f.outgoing.length
        ? [
            h('h2', {}, 'Ждут ответа'),
            h('ul.list', {}, f.outgoing.map((u) => person(u, h('button.btn.ghost.small', { onclick: () => act(() => api('POST', `/api/friends/${u.id}/remove`, {})) }, 'Отменить')))),
          ]
        : null,
    );
    return f;
  };

  let known = await load().catch(() => null);
  let searchTimer;
  const input = h('input.input', {
    type: 'search',
    placeholder: 'Логин или имя друга',
    autocapitalize: 'none',
    'aria-label': 'Поиск людей',
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return mount(results);
        const { users } = await api('GET', `/api/users/search?q=${encodeURIComponent(q)}`);
        known = await api('GET', '/api/friends');
        const rel = (u) =>
          known.friends.some((x) => x.id === u.id) ? 'friend' : known.outgoing.some((x) => x.id === u.id) ? 'sent' : known.incoming.some((x) => x.id === u.id) ? 'incoming' : null;
        mount(
          results,
          users.length
            ? h('ul.list', { style: { marginTop: '10px' } }, users.map((u) => {
                const r = rel(u);
                return person(
                  u,
                  r === 'friend'
                    ? h('span.sub', {}, 'в друзьях')
                    : r === 'sent'
                      ? h('span.sub', {}, 'заявка отправлена')
                      : h('button.btn.primary.small', {
                          onclick: () =>
                            act(async () => {
                              const { status } = await api('POST', '/api/friends/request', { username: u.username });
                              input.value = '';
                              mount(results);
                              toast(status === 'accepted' ? `${u.displayName} теперь в друзьях` : `Заявка отправлена: ${u.displayName}`);
                            }),
                        }, r === 'incoming' ? 'Принять' : 'Добавить'),
                );
              }))
            : h('p.hint', {}, 'Никого не нашёл. Проверь логин или попроси друга зарегистрироваться.'),
        );
      }, 250);
    },
  });

  mount(root, h('main.page', {}, h('h1', {}, 'Друзья'), input, results, lists), tabbar('friends'));
}

// ---------- Перевод фишек другу ----------

function openTransfer(friend, onDone) {
  let value = 10_000;
  const err = h('p.error', { role: 'alert' });
  const amount = h('input.input.num', { type: 'number', inputMode: 'numeric', min: 1, value, oninput: () => (value = Number(amount.value)) });
  const presets = h('div.presets', {}, [10_000, 50_000, 100_000, 500_000].map((v) =>
    h('button.btn', { type: 'button', onclick: () => { value = v; amount.value = v; } }, fmt(v))));
  const go = h('button.btn.primary.block', {
    onclick: async () => {
      err.textContent = '';
      go.disabled = true;
      try {
        const r = await api('POST', '/api/wallet/transfer', { to: friend.id, amount: Math.round(value) });
        state.user.balance = r.balance;
        close();
        toast(`Переведено ${fmt(Math.round(value))} фишек: ${friend.displayName}`);
        onDone?.();
      } catch (e) {
        err.textContent = e.message;
      } finally {
        go.disabled = false;
      }
    },
  }, 'Перевести');
  const close = sheet(`Перевести фишки: ${friend.displayName}`, amount, h('div', { style: { marginTop: '10px' } }, presets),
    h('p.hint', {}, `На балансе ${fmt(state.user.balance)}. Фишки сразу появятся у друга.`), err, h('div.actions', {}, go));
}

// ---------- Профиль ----------

async function profileScreen() {
  await refreshMe();
  const hist = h('div', {}, h('p.hint', {}, 'Загружаю…'));
  mount(
    root,
    h(
      'main.page',
      {},
      h('h1', {}, state.user.displayName),
      h('p.lede', {}, '@' + state.user.username, state.user.isAdmin ? ', админ' : ''),
      h('div.wallet-card', {}, h('span', {}, 'Баланс'), h('b.num', {}, fmt(state.user.balance))),
      state.user.isAdmin ? h('a.btn.block', { href: '#/admin', style: { marginTop: '12px' } }, 'Управление игроками') : null,
      h('h2', {}, 'Переводы'),
      hist,
      h('p.hint', { style: { marginTop: '16px' } }, 'Друзья находят тебя по логину. Чтобы позвать человека за стол, открой стол и отправь ему ссылку из меню.'),
      h(
        'button.btn.block',
        {
          style: { marginTop: '20px' },
          onclick: async () => {
            await api('POST', '/api/logout', {});
            state.user = null;
            go('#/login');
          },
        },
        'Выйти из аккаунта',
      ),
    ),
    tabbar('profile'),
  );
  try {
    const w = await api('GET', '/api/wallet');
    mount(
      hist,
      w.history.length
        ? h('ul.list', {}, w.history.map((x) =>
            h('li', {},
              h('div.grow', {},
                h('div.title', {}, x.kind === 'admin' ? (x.incoming ? 'Изменение от админа' : `Админ, игрок: ${x.other}`) : x.incoming ? `Получено, отправитель: ${x.other}` : `Отправлено, получатель: ${x.other}`),
                h('div.sub', {}, new Date(x.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
              ),
              h('b.num', { class: x.incoming === x.amount > 0 ? 'pos' : 'neg' }, (x.incoming === x.amount > 0 ? '+' : '−') + fmt(Math.abs(x.amount))),
            )))
        : h('div.empty', {}, 'Переводов пока не было. Перевести фишки можно во вкладке «Друзья».'),
    );
  } catch (e) {
    mount(hist, h('p.error', {}, e.message));
  }
}

// ---------- Админ ----------

async function adminScreen() {
  await refreshMe();
  if (!state.user.isAdmin) {
    mount(root, h('main.page', {}, h('h1', {}, 'Нет доступа'), h('p.lede', {}, 'Этот раздел только для админа.')), tabbar('profile'));
    return;
  }
  const list = h('div', {}, h('p.hint', {}, 'Загружаю…'));
  mount(root, h('main.page', {}, h('h1', {}, 'Игроки'), h('p.lede', {}, 'Можно начислить или списать фишки. Закрыть любой стол можно из меню стола.'), list), tabbar('profile'));
  const load = async () => {
    const { users } = await api('GET', '/api/admin/users');
    mount(list, h('ul.list', {}, users.map((u) =>
      h('li', {},
        h('div.grow', {}, h('div.title', {}, u.displayName), h('div.sub', {}, '@' + u.username)),
        h('b.num', {}, fmt(u.balance)),
        h('button.btn.small', { onclick: () => grant(u) }, 'Изменить'),
      ))));
  };
  const grant = (u) => {
    let value = 100_000;
    const err = h('p.error', { role: 'alert' });
    const amount = h('input.input.num', { type: 'number', inputMode: 'numeric', value, oninput: () => (value = Number(amount.value)) });
    const run = async (sign) => {
      try {
        await api('POST', `/api/admin/users/${u.id}/chips`, { amount: sign * Math.abs(Math.round(value)) });
        close();
        toast(sign > 0 ? `Начислено ${fmt(Math.abs(value))}: ${u.displayName}` : `Списано ${fmt(Math.abs(value))}: ${u.displayName}`);
        await load();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const close = sheet(`Фишки: ${u.displayName}`, amount, h('p.hint', {}, `Сейчас на балансе ${fmt(u.balance)}.`), err,
      h('div.actions', {}, h('button.btn.primary.block', { onclick: () => run(1) }, 'Начислить'), h('button.btn.block.danger', { onclick: () => run(-1) }, 'Списать')));
  };
  await load().catch((e) => mount(list, h('p.error', {}, e.message)));
}

// ---------- Итоги закрытого стола ----------

async function statsScreen(id) {
  const body = h('div', {}, h('p.hint', {}, 'Загружаю…'));
  mount(root, h('main.page', {}, h('h1', {}, 'Итоги стола'), body), tabbar('lobby'));
  try {
    const s = await api('GET', `/api/tables/${id}/stats`);
    const hands = s.players.reduce((m, p) => Math.max(m, p.handsPlayed), 0);
    mount(
      body,
      h('p.lede', {}, `${s.table.name}: ${shortVariant(s.table.variant)}, ${fmt(s.table.smallBlind)}/${fmt(s.table.bigBlind)}. ${s.table.status === 'closed' ? 'Стол закрыт.' : 'Стол ещё открыт.'}`),
      s.players.length ? statsTable(s.players) : h('div.empty', {}, 'За этим столом никто не играл.'),
      h('p.hint', { style: { marginTop: '12px' } }, `Сыграно до ${hands} ${plural(hands, 'раздачи', 'раздач', 'раздач')} на игрока.`),
      s.table.status === 'open' ? h('a.btn.block', { href: `#/t/${id}`, style: { marginTop: '16px' } }, 'Вернуться за стол') : h('a.btn.block', { href: '#/', style: { marginTop: '16px' } }, 'К списку столов'),
    );
  } catch (e) {
    mount(body, h('p.error', {}, e.message));
  }
}

// ---------- Запуск ----------

(async function boot() {
  try {
    const [me, config] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/config')]);
    state.user = me.user;
    state.config = config;
    if (state.user) await refreshIncoming();
  } catch {
    mount(root, h('main.auth', {}, brand(), h('p.error', {}, 'Сервер недоступен. Обнови страницу через минуту.')));
    return;
  }
  window.addEventListener('hashchange', render);
  render();
})();
