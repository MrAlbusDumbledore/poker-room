// Небольшой помощник для построения DOM. Текст всегда вставляется как textContent,
// поэтому имена игроков и любые данные с сервера не могут внедрить HTML.
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren();
  append(root, children);
}

export const fmt = (n) => Number(n).toLocaleString('ru-RU');

let toastTimer;
export function toast(message, bad = false) {
  document.querySelector('.toast')?.remove();
  const el = h('div.toast', { class: bad ? 'bad' : '', role: 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

/** Нижний лист. Возвращает функцию закрытия. */
export function sheet(title, ...content) {
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const panel = h('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', {}, title), ...content);
  const back = h('div.sheet-back', { onclick: (e) => e.target === back && close() }, panel);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  panel.querySelector('input, button:not([disabled])')?.focus();
  return close;
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
