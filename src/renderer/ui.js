'use strict';
/* 공통 UI 도우미: 아이콘, 요소 생성, 모달, 컨텍스트 메뉴, 토스트 */

const ICONS = {
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  unplug: '<path d="M18 6 6 18M6 6l12 12"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  octagon: '<polygon points="7.9 2 16.1 2 22 7.9 22 16.1 16.1 22 7.9 22 2 16.1 2 7.9"/><path d="M8 12h8"/>',
  terminal: '<path d="m5 17 6-5-6-5"/><path d="M13 19h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowleft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowright: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  prompt: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l5.5-5.5"/><circle cx="12" cy="12" r="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  folderplus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  nic: '<rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M8 19v-4h8v4M7 6V3h10v3M9 10h.01M12 10h.01M15 10h.01"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};

function icon(name, cls = '') {
  const body = ICONS[name] || '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((elm) => {
    if (elm.dataset.iconDone) return;
    elm.insertAdjacentHTML('afterbegin', icon(elm.dataset.icon));
    // 툴바 글자는 좁은 화면에서 숨길 수 있게 span으로 감쌈
    if (elm.classList.contains('tb')) {
      const txt = [...elm.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      for (const n of txt) { const sp = document.createElement('span'); sp.className = 'lbl'; sp.textContent = n.textContent; n.replaceWith(sp); }
    }
    elm.dataset.iconDone = '1';
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** h('div.cls#id', {attrs}, children...) */
function h(tag, attrs, ...children) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const elm = document.createElement(m[1] || 'div');
  (m[2] || '').replace(/([.#])([\w-]+)/g, (_, k, v) => { if (k === '.') elm.classList.add(v); else elm.id = v; });
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') elm.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') elm.innerHTML = v;
    else if (k === 'dataset') Object.assign(elm.dataset, v);
    else if (k === 'value') elm.value = v;
    else if (k === 'checked') elm.checked = !!v;
    else if (v === true) elm.setAttribute(k, '');
    else elm.setAttribute(k, v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    elm.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return elm;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 모달 ----------
const modalStack = [];

function openModal({ title, body, buttons = [], cls = '', onClose, left = [] }) {
  if (typeof hideMenu === 'function') hideMenu();
  const root = $('#modal-root');
  const foot = h('div.modal-foot', h('div.left', left), buttons);
  const box = h('div.modal' + (cls ? '.' + cls.split(' ').join('.') : ''),
    h('div.modal-head', h('h2', title), h('button.icon-btn', { title: '닫기', html: icon('x'), onclick: () => close(null) })),
    h('div.modal-body', body),
    foot,
  );
  const back = h('div.modal-backdrop', box);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    back.remove();
    modalStack.splice(modalStack.indexOf(api), 1);
    if (onClose) onClose(result);
    if (window.App && !modalStack.length) window.App.focusActive();
  }
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.dataset.down = '1'; });
  back.addEventListener('mouseup', (e) => { if (e.target === back && back.dataset.down) close(null); back.dataset.down = ''; });
  const api = { el: box, close, back };
  modalStack.push(api);
  root.append(back);
  hydrateIcons(box);
  setTimeout(() => {
    const f = box.querySelector('[autofocus]') || box.querySelector('.modal-body input:not([type=checkbox]):not([disabled]), .modal-body textarea, .modal-body select');
    if (f) { f.focus(); if (f.select && f.tagName === 'INPUT') f.select(); }
  }, 20);
  return api;
}

document.addEventListener('keydown', (e) => {
  if (!modalStack.length) return;
  const top = modalStack[modalStack.length - 1];
  if (e.key === 'Escape') { e.preventDefault(); top.close(null); }
  if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
    const primary = top.el.querySelector('.modal-foot .btn.primary');
    if (primary) { e.preventDefault(); primary.click(); }
  }
}, true);

function confirmBox(message, { title = '확인', ok = '확인', cancel = '취소', danger = false, detail } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title, cls: 'narrow',
      body: h('div', h('div', { style: 'line-height:1.6;white-space:pre-wrap' }, message), detail || null),
      buttons: [
        h('button.btn', { onclick: () => m.close() }, cancel),
        h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => { result = true; m.close(); } }, ok),
      ],
      onClose: () => resolve(result),
    });
  });
}

function promptBox(message, { title = '입력', value = '', ok = '확인', placeholder = '', password = false } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const inp = h('input.inp', { type: password ? 'password' : 'text', value, placeholder, style: 'width:100%', spellcheck: 'false' });
    const m = openModal({
      title, cls: 'narrow',
      body: h('div', h('div', { style: 'margin-bottom:10px' }, message), inp),
      buttons: [
        h('button.btn', { onclick: () => m.close() }, '취소'),
        h('button.btn.primary', { onclick: () => { result = inp.value; m.close(); } }, ok),
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---------- 컨텍스트 메뉴 ----------
function showMenu(x, y, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('div.ctx-sep')); continue; }
    if (it.info) { menu.append(h('div.ctx-info', it.label)); continue; }
    menu.append(h('div.ctx-item' + (it.danger ? '.danger' : '') + (it.disabled ? '.disabled' : ''), {
      onclick: () => { hideMenu(); it.action && it.action(); },
    }, h('span', it.label), it.key ? h('span.key', it.key) : null));
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
}
function hideMenu() { $('#ctx-menu').hidden = true; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx-menu')) hideMenu(); }, true);
window.addEventListener('blur', hideMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

// ---------- 토스트 ----------
function toast(msg, type = '') {
  const t = h('div.toast' + (type ? '.' + type : ''), msg);
  $('#toast-root').append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, type === 'err' ? 5000 : 2600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
