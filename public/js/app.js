import { api } from './api.js';
import { h, mount, toast, fmt, plural } from './dom.js';
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
      state.config?.inviteRequired
        ? field('Код приглашения', h('input.input', { name: 'inviteCode', required: true, autocapitalize: 'none' }), 'Спроси у того, кто позвал тебя играть')
        : null,
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
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } }, h('h1', {}, 'Столы'), h('a.btn.primary.small', { href: '#/new' }, 'Новый стол')),
      list,
    ),
    tabbar('lobby'),
  );
  const load = async () => {
    try {
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
            person(u, h('button.btn.ghost.small', { 'aria-label': `Удалить ${u.displayName} из друзей`, onclick: () => confirm(`Удалить ${u.displayName} из друзей?`) && act(() => api('POST', `/api/friends/${u.id}/remove`, {})) }, 'Удалить')),
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

// ---------- Профиль ----------

function profileScreen() {
  mount(
    root,
    h(
      'main.page',
      {},
      h('h1', {}, state.user.displayName),
      h('p.lede', {}, '@' + state.user.username),
      h('p.hint', {}, 'Друзья находят тебя по логину. Чтобы позвать человека за стол, открой стол и отправь ему ссылку из меню.'),
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
