// Sistema de ventas de restaurante: interfaz única (PWA) para caja, meseros, cocina, reservas, reportes y administración.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

const S = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  boot: null, socket: null, view: null, H: {}, cleanup: null,
};

// ---------- utilidades ----------
const pad = n => String(n).padStart(2, '0');
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const parseTs = s => new Date(String(s).replace(' ', 'T'));
const mins = s => Math.max(0, Math.floor((Date.now() - parseTs(s)) / 60000));
const hhmm = s => String(s).slice(11, 16);
const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
function money(n) {
  const cur = S.boot?.settings.currency || 'USD';
  try { return new Intl.NumberFormat('es', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n || 0); }
  catch { return `${cur} ${(+n || 0).toFixed(2)}`; }
}
const round2 = n => Math.round((+n + Number.EPSILON) * 100) / 100;

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg; el.setAttribute('role', 'status');
  $('#toasts').append(el); setTimeout(() => el.remove(), 3500);
}
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { logout(true); throw new Error('Sesión expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Error de servidor'); toast(e.message, 'err'); throw e; }
  return data;
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.16);
    });
  } catch { }
}
function modal(html, handlers = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => {
    if (e.target === bg) return close();
    const a = e.target.closest('[data-a]');
    if (a && handlers[a.dataset.a]) handlers[a.dataset.a](a, close, e);
    else if (a?.dataset.a === 'close') close();
  });
  bg.addEventListener('submit', e => { e.preventDefault(); handlers.submit?.(new FormData(e.target), close, e.target); });
  document.body.append(bg);
  $('input,select,textarea', bg)?.focus();
  return { el: bg, close };
}
const formObj = fd => Object.fromEntries(fd.entries());

// tooltip para gráficos
let tipEl;
document.addEventListener('mousemove', e => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tipEl?.remove(); tipEl = null; return; }
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.append(tipEl); }
  tipEl.textContent = t.dataset.tip;
  const x = Math.min(e.clientX + 12, innerWidth - tipEl.offsetWidth - 8);
  tipEl.style.left = x + 'px'; tipEl.style.top = (e.clientY - 36) + 'px';
});

// ---------- impresión 80 mm ----------
function printHtml(html) {
  $('#print-area').innerHTML = html;
  setTimeout(() => window.print(), 50);
}
function kitchenTicketHtml(k) {
  return `<h1>COMANDA #${k.id}</h1>
    <div class="c big">${esc(k.table_name || k.customer || 'Para llevar')}</div>
    <div class="c">${esc(hhmm(k.created_at))} · ${esc(k.waiter_name || '')}</div><hr>
    ${k.items.map(i => `<div class="big">${i.status === 'anulado' ? '<s>' : ''}${i.qty} x ${esc(i.name)}${i.status === 'anulado' ? '</s> ANULADO' : ''}</div>
      ${i.notes ? `<div>  → ${esc(i.notes)}</div>` : ''}`).join('')}
    ${k.order_notes ? `<hr><div>${esc(k.order_notes)}</div>` : ''}<hr>`;
}
function receiptHtml(o, title = 'CUENTA') {
  const s = S.boot.settings;
  const items = o.items.filter(i => i.status !== 'anulado');
  return `<h1>${esc(s.restaurant_name)}</h1>
    ${s.tax_id ? `<div class="c">${esc(s.tax_id)}</div>` : ''}${s.address ? `<div class="c">${esc(s.address)}</div>` : ''}
    <div class="c">${title} #${o.id} · ${esc(o.table_name || o.customer || 'Para llevar')}</div>
    <div class="c">${esc((o.closed_at || new Date().toLocaleString('es')).toString())}</div><hr>
    ${items.map(i => `<div class="l"><span>${i.qty} ${esc(i.name)}</span><span>${money(i.qty * i.price)}</span></div>`).join('')}<hr>
    <div class="l"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
    ${o.discount ? `<div class="l"><span>Descuento</span><span>-${money(o.discount)}</span></div>` : ''}
    ${+s.tax_rate ? `<div class="l"><span>Impuesto ${s.tax_rate}%${s.tax_included === '1' ? ' (incl.)' : ''}</span><span>${money(o.tax)}</span></div>` : ''}
    ${o.tip ? `<div class="l"><span>Propina</span><span>${money(o.tip)}</span></div>` : ''}
    <div class="l big"><span>TOTAL</span><span>${money(o.total)}</span></div>
    ${(o.payments || []).map(p => `<div class="l"><span>${esc(p.method)}</span><span>${money(p.received || p.amount)}</span></div>${p.change > 0 ? `<div class="l"><span>Cambio</span><span>${money(p.change)}</span></div>` : ''}`).join('')}
    <hr><div class="c">${esc(s.ticket_footer || '')}</div>`;
}

// ---------- sesión ----------
const ROLE_LABEL = { admin: 'Administrador', cajero: 'Caja', mesero: 'Mesero', cocina: 'Cocina' };
const NAV = [
  { r: 'mesas', label: 'Mesas', roles: ['admin', 'cajero', 'mesero'] },
  { r: 'caja', label: 'Caja', roles: ['admin', 'cajero'] },
  { r: 'cocina', label: 'Cocina', roles: ['admin', 'cocina'] },
  { r: 'reservas', label: 'Reservas', roles: ['admin', 'cajero', 'mesero'] },
  { r: 'reportes', label: 'Reportes', roles: ['admin', 'cajero'] },
  { r: 'admin', label: 'Administración', roles: ['admin'] },
];
const HOME = { admin: 'mesas', cajero: 'caja', mesero: 'mesas', cocina: 'cocina' };

function logout(silent) {
  if (!silent && S.token) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } });
  localStorage.removeItem('token'); localStorage.removeItem('user');
  S.token = null; S.user = null; S.socket?.disconnect(); S.socket = null;
  location.hash = ''; render();
}
async function loadBoot() { S.boot = await api('/bootstrap'); document.title = `${S.boot.settings.restaurant_name} · Ventas`; }

function connectSocket() {
  if (S.socket || !window.io) return;
  S.socket = io({ auth: { token: S.token } });
  const refresh = () => S.H.refresh?.();
  ['orders', 'tickets', 'reservations'].forEach(ev => S.socket.on(ev, refresh));
  S.socket.on('tickets', p => S.H.newTicket?.(p));
  S.socket.on('catalog', async () => { await loadBoot(); refresh(); });
  S.socket.on('ticket:ready', p => {
    if (S.user.role === 'mesero' || S.user.role === 'admin' || S.user.role === 'cajero') {
      if (S.user.role !== 'mesero' || p.waiter_id === S.user.id) { toast(`🍽️ Listo para servir: ${p.table_name || p.customer || 'Para llevar'}`, 'ok'); beep(); navigator.vibrate?.(200); }
    }
  });
  S.socket.on('connect', refresh);
}

function renderLogin() {
  let pin = '';
  app.innerHTML = `<div class="login"><div class="card">
    <h1>Ingresar</h1><p class="muted small">Escribe tu PIN de empleado</p>
    <div class="pin-dots">${'<span></span>'.repeat(4)}</div>
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}
      <button data-k="c" aria-label="Borrar">⌫</button><button data-k="0">0</button><button data-k="ok" aria-label="Entrar">✓</button></div>
    <p class="muted small" style="margin-top:16px">Demo: admin 1234 · caja 1111 · mesero 2222 · cocina 3333</p>
  </div></div>`;
  const dots = () => $$('.pin-dots span').forEach((d, i) => d.classList.toggle('on', i < pin.length));
  const submit = async () => {
    if (pin.length < 4) return;
    try {
      const r = await api('/login', { body: { pin } });
      S.token = r.token; S.user = r.user;
      localStorage.setItem('token', r.token); localStorage.setItem('user', JSON.stringify(r.user));
      location.hash = '#/' + HOME[r.user.role]; render();
    } catch { pin = ''; dots(); }
  };
  const press = k => {
    if (k === 'c') pin = pin.slice(0, -1);
    else if (k === 'ok') return submit();
    else if (pin.length < 6) pin += k;
    dots(); if (pin.length === 6) submit();
  };
  app.onclick = e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); };
  document.onkeydown = e => { if (!S.token) { if (/^\d$/.test(e.key)) press(e.key); if (e.key === 'Backspace') press('c'); if (e.key === 'Enter') press('ok'); } };
}

function shell(route) {
  const items = NAV.filter(n => n.roles.includes(S.user.role));
  app.innerHTML = `<header class="topbar">
      <div class="brand">🍽️ <b>${esc(S.boot.settings.restaurant_name)}</b></div>
      <nav class="nav">${items.map(n => `<a href="#/${n.r}" class="${route === n.r ? 'active' : ''}">${n.label}</a>`).join('')}</nav>
      <div class="userchip"><span class="uname small muted">${esc(S.user.name)} · ${ROLE_LABEL[S.user.role]}</span>
        <button class="btn sm" data-a="logout">Salir</button></div>
    </header><main id="view"></main>`;
  return $('#view');
}

// Delegación de eventos: cada vista registra sus acciones en S.H
app.addEventListener('click', e => {
  const a = e.target.closest('[data-a]');
  if (!a || !S.token) return;
  if (a.dataset.a === 'logout') return logout();
  S.H[a.dataset.a]?.(a, e);
});
app.addEventListener('change', e => { const a = e.target.closest('[data-change]'); if (a) S.H[a.dataset.change]?.(a, e); });
app.addEventListener('input', e => { const a = e.target.closest('[data-input]'); if (a) S.H[a.dataset.input]?.(a, e); });
app.addEventListener('submit', e => { const f = e.target.closest('[data-submit]'); if (f) { e.preventDefault(); S.H[f.dataset.submit]?.(f, e); } });

async function render() {
  S.cleanup?.(); S.cleanup = null; S.H = {}; app.onclick = null;
  if (!S.token) return renderLogin();
  try { if (!S.boot) await loadBoot(); } catch { return; }
  connectSocket();
  const [route, arg] = (location.hash.replace(/^#\//, '') || HOME[S.user.role]).split('/');
  const allowed = NAV.find(n => n.r === route)?.roles.includes(S.user.role) || (route === 'pedido' && S.user.role !== 'cocina');
  if (!allowed) { location.hash = '#/' + HOME[S.user.role]; return; }
  const view = shell(route === 'pedido' ? 'mesas' : route);
  ({ mesas: viewTables, pedido: viewOrder, cocina: viewKitchen, caja: viewPos, reservas: viewReservations, reportes: viewReports, admin: viewAdmin })[route](view, arg);
}
window.addEventListener('hashchange', render);

// ======================================================================
// MESAS (mesero / caja)
// ======================================================================
function viewTables(view) {
  const draw = async () => {
    const tables = await api('/tables/status');
    const zones = [...new Set(tables.map(t => t.zone || 'Salón'))];
    const takeaway = (await api('/orders')).filter(o => !o.table_id);
    view.innerHTML = `<div class="spread"><h1>Mesas</h1><button class="btn primary" data-a="takeaway">+ Para llevar</button></div>
      <div class="legend" style="margin-top:10px"><span><i></i>Libre</span><span><i style="border-color:var(--brand);background:var(--brand-soft)"></i>Ocupada</span>
        <span><i style="border-color:var(--ok);background:var(--ok-soft)"></i>Platos listos</span><span><i style="border-color:var(--info);border-style:dashed"></i>Reservada hoy</span></div>
      ${zones.map(z => `<div class="zone-title">${esc(z)}</div><div class="tables">${tables.filter(t => (t.zone || 'Salón') === z).map(t => {
        const o = t.order, cls = o ? (o.ready ? 'ready' : 'busy') : t.reservation ? 'reserved' : '';
        return `<button class="table-card ${cls}" data-a="open" data-id="${t.id}">
          <span class="spread"><span class="tname">${esc(t.name)}</span><span class="muted small">👥 ${t.seats}</span></span>
          ${o ? `<span class="num">${money(o.amount)}</span><span class="small muted">${esc(o.waiter_name || '')} · ${mins(o.created_at)} min</span>
             ${o.ready ? `<span class="badge ok">${o.ready} listo(s)</span>` : ''}${o.unsent ? `<span class="badge warn">${o.unsent} sin enviar</span>` : ''}`
            : t.reservation ? `<span class="badge info">Reserva ${esc(t.reservation.time)}</span><span class="small muted">${esc(t.reservation.name)} · ${t.reservation.party_size} pers.</span>`
            : '<span class="muted small">Libre</span>'}
        </button>`;
      }).join('')}</div>`).join('')}
      ${takeaway.length ? `<div class="zone-title">Para llevar</div><div class="tables">${takeaway.map(o => `<button class="table-card busy" data-a="goorder" data-id="${o.id}">
        <span class="tname">${esc(o.customer || 'Pedido #' + o.id)}</span><span class="num">${money(o.subtotal)}</span><span class="small muted">${mins(o.created_at)} min</span></button>`).join('')}</div>` : ''}`;
  };
  S.H = {
    refresh: draw,
    open: async a => {
      const t = (await api('/tables/status')).find(x => x.id == a.dataset.id);
      if (t.order) return location.hash = '#/pedido/' + t.order.id;
      modal(`<form><h2>Abrir ${esc(t.name)}</h2>
        ${t.reservation ? `<p class="badge info">Reservada a las ${esc(t.reservation.time)} para ${esc(t.reservation.name)}</p>` : ''}
        <label style="margin-top:12px">Comensales<input type="number" name="guests" min="1" value="${t.reservation?.party_size || 2}" required></label>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancelar</button><button class="btn primary">Abrir mesa</button></div></form>`,
        { submit: async (fd, close) => { const o = await api('/orders', { body: { table_id: t.id, guests: +fd.get('guests') } }); close(); location.hash = '#/pedido/' + o.id; } });
    },
    goorder: a => location.hash = '#/pedido/' + a.dataset.id,
    takeaway: () => modal(`<form><h2>Pedido para llevar</h2>
        <label style="margin-top:12px">Nombre del cliente<input name="customer" required placeholder="Ej. Ana · 555-1234"></label>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancelar</button><button class="btn primary">Crear</button></div></form>`,
      { submit: async (fd, close) => { const o = await api('/orders', { body: { kind: 'llevar', customer: fd.get('customer') } }); close(); location.hash = '#/pedido/' + o.id; } }),
  };
  draw();
  const timer = setInterval(draw, 60000); S.cleanup = () => clearInterval(timer);
}

// ======================================================================
// PEDIDO (mesero): menú + comanda
// ======================================================================
const STATUS_BADGE = { nuevo: ['warn', 'Sin enviar'], enviado: ['info', 'En cocina'], listo: ['ok', 'Listo'], entregado: ['', 'Servido'], anulado: ['bad', 'Anulado'] };
function viewOrder(view, id) {
  let order, cat = S.boot.categories[0]?.id, q = '';
  view.classList.add('has-mobile-bar');
  const products = () => S.boot.products.filter(p => p.active && (q ? p.name.toLowerCase().includes(q.toLowerCase()) : p.category_id === cat));
  const draw = async () => {
    order = await api('/orders/' + id);
    if (order.status !== 'abierta') { toast('Este pedido ya fue cerrado'); location.hash = '#/mesas'; return; }
    const qtyBy = {}; order.items.filter(i => i.status === 'nuevo').forEach(i => qtyBy[i.product_id] = (qtyBy[i.product_id] || 0) + i.qty);
    const unsent = order.items.filter(i => i.status === 'nuevo');
    const tables = S.boot.tables;
    view.innerHTML = `<div class="spread" style="margin-bottom:12px">
        <div><a href="#/mesas" class="muted small">← Mesas</a><h1>${esc(order.table_name || order.customer || 'Para llevar')}</h1>
        <span class="muted small">Pedido #${order.id} · ${esc(order.waiter_name || '')} · 👥 ${order.guests} · abierto hace ${mins(order.created_at)} min</span></div>
        <div class="row">${order.table_id ? `<select data-change="move" aria-label="Cambiar de mesa" style="width:auto">${tables.map(t => `<option value="${t.id}" ${t.id === order.table_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
        <button class="btn sm" data-a="precuenta">🧾 Pre-cuenta</button></div></div>
      <div class="order-layout">
        <section>
          <input type="search" placeholder="Buscar plato…" value="${esc(q)}" data-input="search" style="margin-bottom:10px">
          <div class="cats ${q ? 'hidden' : ''}">${S.boot.categories.map(c => `<button data-a="cat" data-id="${c.id}" class="${c.id === cat ? 'on' : ''}">${esc(c.name)}</button>`).join('')}</div>
          <div class="products">${products().map(p => `<button class="product" data-a="add" data-id="${p.id}">
            ${qtyBy[p.id] ? `<span class="qtybubble">${qtyBy[p.id]}</span>` : ''}<span class="pname">${esc(p.name)}</span><span class="pprice num">${money(p.price)}</span></button>`).join('') || '<p class="empty">Sin resultados</p>'}</div>
        </section>
        <aside class="order-side card" id="side">
          <div class="spread"><h2>Comanda</h2><span class="badge">${order.items.filter(i => i.status !== 'anulado').reduce((s, i) => s + i.qty, 0)} ítems</span></div>
          ${order.items.length ? `<ul class="lines">${order.items.map(i => `<li>
              ${i.status === 'nuevo' ? `<span class="stepper"><button data-a="dec" data-id="${i.id}" aria-label="Menos">−</button><span>${i.qty}</span><button data-a="inc" data-id="${i.id}" aria-label="Más">+</button></span>` : `<span class="qty">${i.qty}×</span>`}
              <div class="lname"><div style="${i.status === 'anulado' ? 'text-decoration:line-through' : ''}">${esc(i.name)}</div>
                ${i.notes ? `<div class="note">→ ${esc(i.notes)}</div>` : ''}
                <span class="badge ${STATUS_BADGE[i.status][0]}">${STATUS_BADGE[i.status][1]}</span></div>
              <div style="text-align:right"><div class="num">${money(i.qty * i.price)}</div>
                ${i.status === 'nuevo' ? `<button class="btn ghost sm" data-a="note" data-id="${i.id}">Nota</button><button class="btn ghost sm danger" data-a="del" data-id="${i.id}" aria-label="Quitar">✕</button>` : ''}
                ${i.status === 'listo' ? `<button class="btn sm ok" data-a="served" data-id="${i.id}">Servido</button>` : ''}
                ${['enviado', 'listo'].includes(i.status) && S.user.role !== 'mesero' ? `<button class="btn ghost sm danger" data-a="void" data-id="${i.id}">Anular</button>` : ''}</div>
            </li>`).join('')}</ul>` : '<p class="empty">Toca un plato del menú para agregarlo</p>'}
          <div class="totals"><div class="spread big"><span>Total</span><span class="num">${money(order.total)}</span></div></div>
          <button class="btn primary lg block" style="margin-top:12px" data-a="send" ${unsent.length ? '' : 'disabled'}>Enviar a cocina${unsent.length ? ` (${unsent.reduce((s, i) => s + i.qty, 0)})` : ''}</button>
        </aside>
      </div>
      <div class="mobile-bar"><button class="btn grow" data-a="scrollside">Ver comanda · ${money(order.total)}</button>
        <button class="btn primary grow" data-a="send" ${unsent.length ? '' : 'disabled'}>Enviar${unsent.length ? ` (${unsent.reduce((s, i) => s + i.qty, 0)})` : ''}</button></div>`;
  };
  const item = a => order.items.find(i => i.id == a.dataset.id);
  S.H = {
    refresh: draw,
    cat: a => { cat = +a.dataset.id; draw(); },
    search: a => { q = a.value; clearTimeout(S.searchT); S.searchT = setTimeout(async () => { await draw(); const s = $('[data-input=search]'); s.focus(); s.setSelectionRange(q.length, q.length); }, 250); },
    add: async a => {
      const existing = order.items.find(i => i.status === 'nuevo' && i.product_id == a.dataset.id && !i.notes);
      if (existing) await api('/items/' + existing.id, { method: 'PATCH', body: { qty: existing.qty + 1 } });
      else await api(`/orders/${id}/items`, { body: { items: [{ product_id: +a.dataset.id, qty: 1 }] } });
      navigator.vibrate?.(15); draw();
    },
    inc: async a => { await api('/items/' + a.dataset.id, { method: 'PATCH', body: { qty: item(a).qty + 1 } }); draw(); },
    dec: async a => { const i = item(a); if (i.qty <= 1) await api('/items/' + i.id, { method: 'DELETE' }); else await api('/items/' + i.id, { method: 'PATCH', body: { qty: i.qty - 1 } }); draw(); },
    del: async a => { await api('/items/' + a.dataset.id, { method: 'DELETE' }); draw(); },
    void: async a => { if (confirm('¿Anular este plato? Cocina verá el cambio.')) { await api('/items/' + a.dataset.id, { method: 'DELETE' }); draw(); } },
    served: async a => { await api('/items/' + a.dataset.id, { method: 'PATCH', body: { status: 'entregado' } }); draw(); },
    note: a => {
      const i = item(a);
      modal(`<form><h2>Nota para cocina</h2><p class="muted small">${esc(i.name)}</p>
        <div class="row" style="margin:8px 0">${['Sin cebolla', 'Sin sal', 'Término medio', 'Bien cocido', 'Para compartir', 'Sin picante'].map(t => `<button type="button" class="btn sm" data-a="chip">${t}</button>`).join('')}</div>
        <textarea name="notes" rows="2">${esc(i.notes || '')}</textarea>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancelar</button><button class="btn primary">Guardar</button></div></form>`,
        { chip: (b, c, e) => { const t = $('textarea', e.currentTarget); t.value = t.value ? t.value + ', ' + b.textContent : b.textContent; },
          submit: async (fd, close) => { await api('/items/' + i.id, { method: 'PATCH', body: { notes: fd.get('notes') } }); close(); draw(); } });
    },
    send: async () => { await api(`/orders/${id}/send`, { body: {} }); toast('Comanda enviada a cocina', 'ok'); navigator.vibrate?.(60); draw(); },
    move: async a => { await api('/orders/' + id, { method: 'PATCH', body: { table_id: +a.value } }); toast('Mesa cambiada'); draw(); },
    precuenta: () => printHtml(receiptHtml(order, 'PRE-CUENTA')),
    scrollside: () => $('#side').scrollIntoView({ behavior: 'smooth' }),
  };
  draw();
}

// ======================================================================
// COCINA: pantalla de comandas + impresión automática
// ======================================================================
function viewKitchen(view) {
  let autoPrint = localStorage.getItem('autoPrint') === '1', sound = localStorage.getItem('sound') !== '0', filter = 'activas', known = null;
  const draw = async () => {
    const tickets = await api('/kitchen/tickets');
    const fresh = known ? tickets.filter(t => !known.has(t.id) && t.status === 'pendiente') : [];
    known = new Set(tickets.map(t => t.id));
    if (fresh.length) {
      if (sound) beep();
      if (autoPrint) for (const t of fresh.filter(t => !t.printed)) { printHtml(kitchenTicketHtml(t)); api(`/tickets/${t.id}/printed`, { body: {} }); }
    }
    const shown = tickets.filter(t => filter === 'activas' ? t.status !== 'listo' : t.status === 'listo');
    const count = s => tickets.filter(t => t.status === s).length;
    view.innerHTML = `<div class="spread"><h1>Cocina</h1>
        <div class="row"><label class="row small" style="gap:6px"><input type="checkbox" data-change="auto" ${autoPrint ? 'checked' : ''} style="width:auto;min-height:0"> Imprimir comandas automáticamente</label>
        <label class="row small" style="gap:6px"><input type="checkbox" data-change="sound" ${sound ? 'checked' : ''} style="width:auto;min-height:0"> Sonido</label></div></div>
      <div class="row" style="margin:12px 0"><div class="seg"><button class="${filter === 'activas' ? 'on' : ''}" data-a="filter" data-f="activas">En curso (${count('pendiente') + count('preparando')})</button>
        <button class="${filter === 'listas' ? 'on' : ''}" data-a="filter" data-f="listas">Listas · últimos 30 min (${count('listo')})</button></div></div>
      <div class="kds">${shown.map(t => {
        const m = mins(t.created_at), late = t.status !== 'listo' && m >= 20;
        return `<article class="ticket ${t.status} ${late ? 'late' : ''}">
          <header><div class="spread"><span class="tt">${esc(t.table_name || t.customer || 'Para llevar')}</span><span class="badge ${late ? 'bad' : m >= 12 ? 'warn' : ''}">⏱ ${m} min</span></div>
            <div class="small muted">#${t.id} · ${hhmm(t.created_at)} · ${esc(t.waiter_name || '')}${t.kind === 'llevar' ? ' · <b>PARA LLEVAR</b>' : ''}</div></header>
          <ul>${t.items.map(i => `<li class="${i.status === 'anulado' ? 'anulado' : ''}"><b>${i.qty}×</b> ${esc(i.name)}${i.notes ? `<div class="small" style="color:var(--warn);font-weight:600">→ ${esc(i.notes)}</div>` : ''}</li>`).join('')}</ul>
          ${t.order_notes ? `<div class="small muted" style="padding:0 14px 8px">${esc(t.order_notes)}</div>` : ''}
          <footer><button class="btn sm" data-a="print" data-id="${t.id}" aria-label="Imprimir">🖨️</button>
            ${t.status === 'pendiente' ? `<button class="btn" data-a="st" data-s="preparando" data-id="${t.id}">Preparando</button>` : ''}
            ${t.status !== 'listo' ? `<button class="btn ok" data-a="st" data-s="listo" data-id="${t.id}">Listo ✓</button>` : `<button class="btn" data-a="st" data-s="preparando" data-id="${t.id}">Reabrir</button>`}
          </footer></article>`;
      }).join('') || `<p class="empty">${filter === 'activas' ? 'Sin comandas pendientes 👌' : 'Nada listo en los últimos 30 minutos'}</p>`}</div>`;
    S.tickets = tickets;
  };
  S.H = {
    refresh: draw,
    auto: a => { autoPrint = a.checked; localStorage.setItem('autoPrint', autoPrint ? '1' : '0'); if (autoPrint) toast('Para imprimir sin diálogo, abre Chrome con --kiosk-printing (ver guía)'); },
    sound: a => { sound = a.checked; localStorage.setItem('sound', sound ? '1' : '0'); if (sound) beep(); },
    filter: a => { filter = a.dataset.f; draw(); },
    st: async a => { await api('/tickets/' + a.dataset.id, { method: 'PATCH', body: { status: a.dataset.s } }); draw(); },
    print: a => { const t = S.tickets.find(t => t.id == a.dataset.id); printHtml(kitchenTicketHtml(t)); api(`/tickets/${t.id}/printed`, { body: {} }); },
  };
  draw();
  const timer = setInterval(draw, 30000); S.cleanup = () => clearInterval(timer);
}

// ======================================================================
// CAJA: cobro
// ======================================================================
function viewPos(view, selId) {
  let orders = [], sel = selId ? +selId : null, discount = 0, tip = 0, pays = [];
  const resetPay = () => { discount = 0; tip = 0; pays = [{ method: 'efectivo', amount: '', received: '' }]; };
  resetPay();
  const s = S.boot.settings;
  const totals = o => {
    const rate = +s.tax_rate / 100, base = Math.max(0, o.subtotal - discount);
    const tax = s.tax_included === '1' ? round2(base - base / (1 + rate)) : round2(base * rate);
    return { tax, total: round2(base + (s.tax_included === '1' ? 0 : tax) + +tip) };
  };
  const draw = async () => {
    orders = await api('/orders');
    const today = await api('/reports/summary');
    const o = orders.find(x => x.id === sel);
    if (sel && !o) sel = null;
    let detail = '<div class="card empty">Selecciona un pedido para cobrar</div>';
    if (o) {
      const t = totals(o);
      if (pays.length === 1 && pays[0].amount === '') pays[0].amount = t.total;
      const paid = round2(pays.reduce((a, p) => a + (+p.amount || 0), 0));
      const cash = pays.find(p => p.method === 'efectivo');
      const change = cash && +cash.received > +cash.amount ? round2(+cash.received - +cash.amount) : 0;
      const unsent = o.items.some(i => i.status === 'nuevo');
      detail = `<div class="card">
        <div class="spread"><div><h2>${esc(o.table_name || o.customer || 'Para llevar')}</h2><span class="muted small">Pedido #${o.id} · ${esc(o.waiter_name || '')} · 👥 ${o.guests}</span></div>
          <div class="row"><a class="btn sm" href="#/pedido/${o.id}">Editar</a><button class="btn sm" data-a="pre">🧾 Pre-cuenta</button><button class="btn sm danger" data-a="cancel">Anular</button></div></div>
        ${unsent ? '<p class="badge warn" style="margin-top:8px">Hay ítems sin enviar a cocina</p>' : ''}
        <ul class="lines">${o.items.filter(i => i.status !== 'anulado').map(i => `<li><span class="qty">${i.qty}×</span><span class="lname">${esc(i.name)}</span><span class="num">${money(i.qty * i.price)}</span></li>`).join('')}</ul>
        <div class="form" style="margin-top:8px">
          <label>Descuento<input type="number" min="0" step="0.01" value="${discount || ''}" data-change="disc" placeholder="0.00"></label>
          <label>Propina<input type="number" min="0" step="0.01" value="${tip || ''}" data-change="tip" placeholder="0.00"></label>
        </div>
        <div class="row" style="margin-top:8px"><span class="small muted">Propina sugerida:</span>${[0, 10, 15].map(p => `<button class="btn sm" data-a="tippct" data-p="${p}">${p}%</button>`).join('')}</div>
        <div class="totals" style="margin-top:12px">
          <div class="spread"><span>Subtotal</span><span class="num">${money(o.subtotal)}</span></div>
          ${discount ? `<div class="spread"><span>Descuento</span><span class="num">−${money(discount)}</span></div>` : ''}
          ${+s.tax_rate ? `<div class="spread muted"><span>Impuesto ${s.tax_rate}%${s.tax_included === '1' ? ' incluido' : ''}</span><span class="num">${money(t.tax)}</span></div>` : ''}
          ${tip ? `<div class="spread"><span>Propina</span><span class="num">${money(tip)}</span></div>` : ''}
          <div class="spread big"><span>Total</span><span class="num">${money(t.total)}</span></div>
        </div>
        <h3 style="margin-top:16px">Pago</h3>
        ${pays.map((p, i) => `<div class="pay-row">
          <select data-change="pm" data-i="${i}">${['efectivo', 'tarjeta', 'transferencia'].map(m => `<option ${m === p.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <input type="number" step="0.01" min="0" value="${p.amount}" data-change="pa" data-i="${i}" aria-label="Monto">
          ${pays.length > 1 ? `<button class="btn ghost sm" data-a="rmpay" data-i="${i}" aria-label="Quitar">✕</button>` : '<span></span>'}
          ${p.method === 'efectivo' ? `<label class="small" style="grid-column:2/3">Recibido<input type="number" step="0.01" min="0" value="${p.received}" data-change="pr" data-i="${i}" placeholder="${p.amount}"></label>` : ''}
        </div>`).join('')}
        <div class="row" style="margin-top:8px"><button class="btn sm" data-a="addpay">+ Dividir pago</button>
          ${[...new Set([t.total, Math.ceil(t.total), Math.ceil(t.total / 10) * 10, Math.ceil(t.total / 20) * 20])].filter(v => v > 0).map(v => `<button class="btn sm" data-a="cashq" data-v="${v}">Recibe ${money(v)}</button>`).join('')}</div>
        <div class="spread" style="margin-top:12px"><span>Pagado: <b class="num">${money(paid)}</b>${paid < t.total ? ` · <span style="color:var(--bad)">Falta ${money(t.total - paid)}</span>` : ''}</span>
          ${change ? `<span class="badge ok" style="font-size:15px">Cambio: ${money(change)}</span>` : ''}</div>
        <button class="btn primary lg block" style="margin-top:12px" data-a="pay" ${paid + 0.001 >= t.total && !unsent ? '' : 'disabled'}>Cobrar ${money(t.total)}</button>
      </div>`;
    }
    view.innerHTML = `<div class="spread" style="margin-bottom:12px"><h1>Caja</h1>
        <div class="row small"><span class="badge">Hoy: ${money(today.totals.total - today.totals.tip)} · ${today.totals.orders} cuentas</span>
        ${today.by_method.map(m => `<span class="badge">${esc(m.method)} ${money(m.amount)}</span>`).join('')}<button class="btn sm" data-a="cierre">Cierre de caja</button></div></div>
      <div class="pos-layout"><section><h3 class="muted" style="margin-bottom:8px">Cuentas abiertas (${orders.length})</h3><div class="order-list">
        ${orders.map(x => `<button class="order-item ${x.id === sel ? 'on' : ''}" data-a="sel" data-id="${x.id}"><div class="spread"><b>${esc(x.table_name || x.customer || 'Para llevar')}</b><span class="num">${money(x.total)}</span></div>
          <div class="small muted">#${x.id} · ${esc(x.waiter_name || '')} · ${mins(x.created_at)} min ${x.items.some(i => i.status === 'nuevo') ? '· <span style="color:var(--warn)">sin enviar</span>' : ''}</div></button>`).join('') || '<p class="empty">No hay cuentas abiertas</p>'}
      </div></section><section>${detail}</section></div>`;
  };
  const cur = () => orders.find(x => x.id === sel);
  const setPays = () => { const t = totals(cur()); if (pays.length === 1) pays[0].amount = t.total; draw(); };
  S.H = {
    refresh: draw,
    sel: a => { sel = +a.dataset.id; resetPay(); history.replaceState(null, '', '#/caja/' + sel); draw(); },
    disc: a => { discount = Math.max(0, +a.value || 0); setPays(); },
    tip: a => { tip = Math.max(0, +a.value || 0); setPays(); },
    tippct: a => { tip = round2((cur().subtotal - discount) * a.dataset.p / 100); setPays(); },
    pm: a => { pays[a.dataset.i].method = a.value; draw(); },
    pa: a => { pays[a.dataset.i].amount = +a.value || 0; draw(); },
    pr: a => { pays[a.dataset.i].received = a.value; draw(); },
    cashq: a => { const p = pays.find(p => p.method === 'efectivo') || pays[0]; p.method = 'efectivo'; p.received = a.dataset.v; draw(); },
    addpay: () => {
      const t = totals(cur()), paid = pays.reduce((s, p) => s + (+p.amount || 0), 0);
      if (pays.length === 1 && paid >= t.total) { pays[0].amount = round2(t.total / 2); pays.push({ method: 'tarjeta', amount: round2(t.total - pays[0].amount), received: '' }); }
      else pays.push({ method: 'tarjeta', amount: round2(Math.max(0, t.total - paid)), received: '' });
      draw();
    },
    rmpay: a => { pays.splice(a.dataset.i, 1); draw(); },
    pre: () => { const o = cur(); printHtml(receiptHtml({ ...o, discount, tip, ...totals(o) }, 'PRE-CUENTA')); },
    pay: async () => {
      const o = await api(`/orders/${sel}/pay`, { body: { discount, tip, payments: pays.map(p => ({ ...p, received: p.received || p.amount })) } });
      toast(`Cobrado ${money(o.total)}`, 'ok');
      modal(`<h2>Cuenta cobrada ✓</h2><p class="muted">${esc(o.table_name || o.customer || '')} · ${money(o.total)}</p>
        ${o.payments.filter(p => p.change > 0).map(p => `<p class="badge ok" style="font-size:18px">Cambio: ${money(p.change)}</p>`).join('')}
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-a="close">Cerrar</button><button class="btn primary" data-a="print">🖨️ Imprimir ticket</button></div>`,
        { print: (b, close) => { printHtml(receiptHtml(o, 'TICKET')); close(); } });
      sel = null; resetPay(); history.replaceState(null, '', '#/caja'); draw();
    },
    cancel: () => modal(`<form><h2>Anular cuenta</h2><p class="muted small">La cuenta y sus platos quedarán anulados y no contarán como venta.</p>
        <label>Motivo<input name="reason" required></label>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Volver</button><button class="btn primary">Anular cuenta</button></div></form>`,
      { submit: async (fd, close) => { await api(`/orders/${sel}/cancel`, { body: { reason: fd.get('reason') } }); close(); sel = null; draw(); } }),
    cierre: async () => {
      const r = await api('/reports/summary');
      const html = `<h1>CIERRE DE CAJA</h1><div class="c">${esc(S.boot.settings.restaurant_name)} · ${isoDate()}</div><hr>
        <div class="l"><span>Cuentas</span><span>${r.totals.orders}</span></div><div class="l"><span>Comensales</span><span>${r.totals.guests}</span></div>
        <div class="l"><span>Ventas (sin propina)</span><span>${money(r.totals.total - r.totals.tip)}</span></div>
        <div class="l"><span>Descuentos</span><span>${money(r.totals.discount)}</span></div><div class="l"><span>Impuestos</span><span>${money(r.totals.tax)}</span></div>
        <div class="l"><span>Propinas</span><span>${money(r.totals.tip)}</span></div><div class="l big"><span>TOTAL</span><span>${money(r.totals.total)}</span></div><hr>
        ${r.by_method.map(m => `<div class="l"><span>${esc(m.method)} (${m.n})</span><span>${money(m.amount)}</span></div>`).join('')}<hr>
        <div class="l"><span>Anuladas</span><span>${r.totals.cancelled}</span></div>`;
      modal(`<h2>Cierre de caja de hoy</h2><div class="totals" style="margin-top:12px">
        ${[['Cuentas', r.totals.orders], ['Ventas sin propina', money(r.totals.total - r.totals.tip)], ['Propinas', money(r.totals.tip)], ['Total cobrado', money(r.totals.total)],
          ...r.by_method.map(m => [m.method, money(m.amount)]), ['Cuentas anuladas', r.totals.cancelled]].map(([k, v]) => `<div class="spread"><span>${esc(k)}</span><b class="num">${v}</b></div>`).join('')}</div>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-a="close">Cerrar</button><button class="btn primary" data-a="print">🖨️ Imprimir</button></div>`,
        { print: (b, close) => { printHtml(html); close(); } });
    },
  };
  draw();
}

// ======================================================================
// RESERVAS
// ======================================================================
const RES_ST = { pendiente: ['warn', 'Pendiente'], confirmada: ['info', 'Confirmada'], sentada: ['ok', 'Llegó'], cancelada: ['', 'Cancelada'], no_show: ['bad', 'No vino'] };
function viewReservations(view) {
  let date = isoDate();
  const draw = async () => {
    const [list, week] = await Promise.all([api(`/reservations?from=${date}`), api(`/reservations?from=${date}&to=${addDays(date, 6)}`)]);
    const active = list.filter(r => !['cancelada', 'no_show'].includes(r.status));
    view.innerHTML = `<div class="spread"><h1>Reservas</h1><button class="btn primary" data-a="new">+ Nueva reserva</button></div>
      <div class="row" style="margin:12px 0"><button class="btn sm" data-a="day" data-d="-1" aria-label="Día anterior">‹</button>
        <input type="date" value="${date}" data-change="date" style="width:auto"><button class="btn sm" data-a="day" data-d="1" aria-label="Día siguiente">›</button>
        <button class="btn sm" data-a="today">Hoy</button>
        <span class="muted small">${active.length} reservas · ${active.reduce((s, r) => s + r.party_size, 0)} personas</span></div>
      <div class="row" style="margin-bottom:16px">${Array.from({ length: 7 }, (_, i) => addDays(date, i)).map(d => {
        const n = week.filter(r => r.date === d && !['cancelada', 'no_show'].includes(r.status));
        const dd = new Date(d + 'T12:00:00');
        return `<button class="btn sm ${d === date ? 'primary' : ''}" data-a="goto" data-d="${d}">${DOW[dd.getDay()]} ${dd.getDate()} · ${n.length}</button>`;
      }).join('')}</div>
      <div class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Hora</th><th>Cliente</th><th class="r">Pers.</th><th>Mesa</th><th>Estado</th><th></th></tr></thead><tbody>
      ${list.map(r => `<tr><td class="num"><b>${esc(r.time)}</b></td><td>${esc(r.name)}<div class="small muted">${esc(r.phone || '')}${r.notes ? ' · ' + esc(r.notes) : ''}</div></td>
        <td class="r">${r.party_size}</td><td>${esc(r.table_name || '—')}</td><td><span class="badge ${RES_ST[r.status][0]}">${RES_ST[r.status][1]}</span></td>
        <td><div class="row" style="justify-content:flex-end">
          ${['pendiente', 'confirmada'].includes(r.status) ? `<button class="btn sm ok" data-a="seat" data-id="${r.id}">Sentar</button>` : ''}
          ${r.status === 'pendiente' ? `<button class="btn sm" data-a="st" data-s="confirmada" data-id="${r.id}">Confirmar</button>` : ''}
          ${['pendiente', 'confirmada'].includes(r.status) ? `<button class="btn sm" data-a="st" data-s="no_show" data-id="${r.id}">No vino</button><button class="btn sm danger" data-a="st" data-s="cancelada" data-id="${r.id}">Cancelar</button>` : ''}
          <button class="btn sm ghost" data-a="edit" data-id="${r.id}">Editar</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Sin reservas este día</td></tr>'}
      </tbody></table></div></div>`;
    S.res = list;
  };
  const form = (r = {}) => modal(`<form><h2>${r.id ? 'Editar' : 'Nueva'} reserva</h2><div class="form" style="margin-top:12px">
      <label style="grid-column:1/-1">Nombre<input name="name" required value="${esc(r.name || '')}"></label>
      <label>Teléfono<input name="phone" type="tel" value="${esc(r.phone || '')}"></label>
      <label>Personas<input name="party_size" type="number" min="1" required value="${r.party_size || 2}"></label>
      <label>Fecha<input name="date" type="date" required value="${r.date || date}"></label>
      <label>Hora<input name="time" type="time" required value="${r.time || '20:00'}"></label>
      <label>Mesa<select name="table_id"><option value="">Sin asignar</option>${S.boot.tables.map(t => `<option value="${t.id}" ${t.id === r.table_id ? 'selected' : ''}>${esc(t.name)} (${t.seats})</option>`).join('')}</select></label>
      <label>Estado<select name="status">${['pendiente', 'confirmada'].map(s => `<option value="${s}" ${s === (r.status || 'confirmada') ? 'selected' : ''}>${RES_ST[s][1]}</option>`).join('')}</select></label>
      <label style="grid-column:1/-1">Notas<input name="notes" value="${esc(r.notes || '')}" placeholder="Cumpleaños, silla de bebé…"></label></div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancelar</button><button class="btn primary">Guardar</button></div></form>`,
    { submit: async (fd, close) => {
      const b = formObj(fd); b.party_size = +b.party_size; b.table_id = b.table_id ? +b.table_id : null;
      await api('/reservations' + (r.id ? '/' + r.id : ''), { method: r.id ? 'PATCH' : 'POST', body: b });
      close(); date = b.date; toast('Reserva guardada', 'ok'); draw();
    } });
  S.H = {
    refresh: draw,
    date: a => { date = a.value; draw(); }, day: a => { date = addDays(date, +a.dataset.d); draw(); },
    today: () => { date = isoDate(); draw(); }, goto: a => { date = a.dataset.d; draw(); },
    new: () => form(), edit: a => form(S.res.find(r => r.id == a.dataset.id)),
    st: async a => { await api('/reservations/' + a.dataset.id, { method: 'PATCH', body: { status: a.dataset.s } }); draw(); },
    seat: async a => {
      const r = S.res.find(r => r.id == a.dataset.id);
      if (r.table_id) { const o = await api(`/reservations/${r.id}/seat`, { body: {} }); location.hash = '#/pedido/' + o.id; return; }
      const free = (await api('/tables/status')).filter(t => !t.order);
      modal(`<form><h2>Sentar a ${esc(r.name)}</h2><label style="margin-top:12px">Mesa libre<select name="table_id">${free.map(t => `<option value="${t.id}">${esc(t.name)} (${t.seats})</option>`).join('')}</select></label>
        <div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancelar</button><button class="btn primary">Sentar</button></div></form>`,
        { submit: async (fd, close) => { const o = await api(`/reservations/${r.id}/seat`, { body: { table_id: +fd.get('table_id') } }); close(); location.hash = '#/pedido/' + o.id; } });
    },
  };
  draw();
}

// ======================================================================
// REPORTES + ANALÍTICA DE ROTACIÓN
// ======================================================================
function hbars(rows, label, value, fmt = money) {
  const max = Math.max(...rows.map(value), 0) || 1;
  return `<div class="hbars">${rows.map(r => `<div class="hbar" data-tip="${esc(label(r))}: ${esc(fmt(value(r)))}"><span class="lab">${esc(label(r))}</span>
    <span class="track"><span class="fill" style="display:block;width:${value(r) / max * 100}%"></span></span><span class="num small">${fmt(value(r))}</span></div>`).join('') || '<p class="empty">Sin datos</p>'}</div>`;
}
function vbars(rows, label, value, tip) {
  if (!rows.length) return '<p class="empty">Sin datos</p>';
  const max = Math.max(...rows.map(value)) || 1;
  const every = Math.ceil(rows.length / 12);
  return `<div class="vbars">${rows.map(r => `<div class="col" data-tip="${esc(tip(r))}"><div class="fill" style="height:${value(r) / max * 100}%"></div></div>`).join('')}</div>
    <div class="vbars-x">${rows.map((r, i) => `<span>${i % every === 0 ? esc(label(r)) : ''}</span>`).join('')}</div>`;
}
const CLASS_INFO = {
  'Estrella': ['ok', 'Se vende mucho y deja buen margen. Mantener y destacar.'],
  'Caballo de batalla': ['info', 'Se vende mucho pero deja poco margen. Revisar costo o subir precio.'],
  'Rompecabezas': ['warn', 'Buen margen pero se vende poco. Promocionar o reubicar en la carta.'],
  'Perro': ['bad', 'Se vende poco y deja poco margen. Candidato a salir del menú.'],
  'Sin ventas': ['', 'No se vendió en el periodo.'],
};
function viewReports(view) {
  let from = isoDate(), to = isoDate(), preset = 'hoy', sortKey = 'qty', sortDir = -1, tab = 'ventas';
  const presets = { hoy: [0, 0], ayer: [-1, -1], '7 días': [-6, 0], '30 días': [-29, 0], '90 días': [-89, 0] };
  let data;
  const fetchData = async () => {
    const qs = `?from=${from}&to=${to}`;
    const [sum, dishes, res] = await Promise.all([api('/reports/summary' + qs), api('/reports/dishes' + qs), api('/reports/reservations' + qs)]);
    data = { sum, dishes, res }; draw();
  };
  const draw = () => {
    const { sum, dishes, res } = data, T = sum.totals;
    const fullDays = []; for (let d = from; d <= to; d = addDays(d, 1)) fullDays.push(sum.by_day.find(x => x.day === d) || { day: d, orders: 0, sales: 0 });
    const hours = sum.by_hour.length ? Array.from({ length: Math.max(...sum.by_hour.map(h => h.hour)) - Math.min(...sum.by_hour.map(h => h.hour)) + 1 }, (_, i) => {
      const h = Math.min(...sum.by_hour.map(h => h.hour)) + i; return sum.by_hour.find(x => x.hour === h) || { hour: h, orders: 0, sales: 0 }; }) : [];
    const ds = [...dishes.dishes].sort((a, b) => (typeof a[sortKey] === 'string' ? a[sortKey].localeCompare(b[sortKey]) : a[sortKey] - b[sortKey]) * sortDir);
    const classes = Object.keys(CLASS_INFO).map(k => ({ k, items: dishes.dishes.filter(d => d.class === k) }));
    const th = (k, l, r = true) => `<th class="${r ? 'r' : ''}" data-a="sort" data-k="${k}">${l}${sortKey === k ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
    view.innerHTML = `<div class="spread"><h1>Reportes</h1><a class="btn sm" href="/api/reports/sales.csv?from=${from}&to=${to}" data-a="csv">⬇ Exportar ventas (CSV)</a></div>
      <div class="row" style="margin:12px 0"><div class="seg">${Object.keys(presets).map(p => `<button class="${preset === p ? 'on' : ''}" data-a="preset" data-p="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
        <input type="date" value="${from}" data-change="from" style="width:auto" aria-label="Desde"><span class="muted">a</span><input type="date" value="${to}" data-change="to" style="width:auto" aria-label="Hasta"></div>
      <div class="tabs">${[['ventas', 'Ventas'], ['platos', 'Rotación de platos'], ['reservas', 'Reservas']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-a="tab" data-t="${k}">${l}</button>`).join('')}</div>
      ${tab === 'ventas' ? `
        <div class="kpis">${[['Ventas netas', money(T.total - T.tip)], ['Cuentas', T.orders], ['Ticket promedio', money(T.avg_ticket)], ['Comensales', T.guests], ['Promedio por comensal', money(T.avg_per_guest)], ['Propinas', money(T.tip)], ['Descuentos', money(T.discount)], ['Cuentas anuladas', T.cancelled]]
          .map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
        <div class="grid-2">
          <div class="card"><h3>Ventas por día</h3>${vbars(fullDays, r => String(+r.day.slice(8)), r => r.sales || 0, r => `${r.day}: ${money(r.sales)} · ${r.orders} cuentas`)}</div>
          <div class="card"><h3>Ventas por hora de apertura</h3>${vbars(hours, r => r.hour + 'h', r => r.sales || 0, r => `${r.hour}:00 – ${r.hour}:59 · ${money(r.sales)} · ${r.orders} cuentas`)}</div>
          <div class="card"><h3>Por categoría</h3>${hbars(sum.by_category, r => r.category, r => r.sales)}</div>
          <div class="card"><h3>Por método de pago</h3>${hbars(sum.by_method, r => r.method, r => r.amount)}</div>
          <div class="card"><h3>Por mesero</h3><div class="table-wrap"><table class="data"><thead><tr><th>Mesero</th><th class="r">Cuentas</th><th class="r">Ventas</th><th class="r">Propinas</th></tr></thead><tbody>
            ${sum.by_waiter.map(w => `<tr><td>${esc(w.waiter)}</td><td class="r">${w.orders}</td><td class="r">${money(w.sales)}</td><td class="r">${money(w.tips)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Sin datos</td></tr>'}</tbody></table></div></div>
        </div>` : ''}
      ${tab === 'platos' ? `
        <div class="kpis"><div class="card kpi"><div class="l">Platos vendidos</div><div class="v">${dishes.total_qty}</div></div>
          <div class="card kpi"><div class="l">Días del periodo</div><div class="v">${dishes.days}</div></div>
          <div class="card kpi"><div class="l">Margen promedio por plato</div><div class="v">${money(dishes.avg_margin)}</div></div>
          <div class="card kpi"><div class="l">Sin ventas en el periodo</div><div class="v">${dishes.dishes.filter(d => !d.qty && d.active).length}</div></div></div>
        <div class="grid-2">
          <div class="card"><h3>Más vendidos</h3>${hbars(dishes.dishes.filter(d => d.qty).slice(0, 10), r => r.name, r => r.qty, v => v + ' u.')}</div>
          <div class="card"><h3>Ingeniería de menú</h3><p class="small muted">Cruza popularidad (umbral ${dishes.pop_threshold_pct}% de participación) con margen unitario (promedio ${money(dishes.avg_margin)}).</p>
            <div class="quad">${classes.filter(c => c.k !== 'Sin ventas').map(c => `<div><span class="badge ${CLASS_INFO[c.k][0]}">${c.k} · ${c.items.length}</span>
              <p style="margin:6px 0" class="small muted">${CLASS_INFO[c.k][1]}</p><div class="small">${c.items.map(d => esc(d.name)).join(', ') || '—'}</div></div>`).join('')}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><h3>Rotación por plato</h3><p class="small muted">Toca un encabezado para ordenar. El costo de cada plato se edita en Administración → Productos.</p>
          <div class="table-wrap"><table class="data"><thead><tr>${th('name', 'Plato', false)}${th('category', 'Categoría', false)}${th('qty', 'Unidades')}${th('per_day', 'Por día')}${th('share', '% part.')}${th('sales', 'Ventas')}${th('margin_pct', 'Margen %')}${th('margin_total', 'Margen total')}${th('class', 'Clase', false)}<th>Última venta</th></tr></thead><tbody>
          ${ds.map(d => `<tr><td>${esc(d.name)}${d.active ? '' : ' <span class="badge">inactivo</span>'}</td><td>${esc(d.category || '')}</td><td class="r">${d.qty}</td><td class="r">${d.per_day}</td><td class="r">${d.share}%</td>
            <td class="r">${money(d.sales)}</td><td class="r">${d.margin_pct}%</td><td class="r">${money(d.margin_total)}</td><td><span class="badge ${CLASS_INFO[d.class][0]}">${d.class}</span></td><td class="small muted">${d.last_sold ? esc(d.last_sold.slice(0, 16)) : '—'}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
      ${tab === 'reservas' ? `
        <div class="kpis">${[['Reservas', res.total], ['Personas', res.by_status.filter(s => s.status !== 'cancelada').reduce((a, s) => a + s.people, 0)], ['Llegaron', (res.by_status.find(s => s.status === 'sentada') || { n: 0 }).n], ['Tasa de no-show', res.no_show_rate + '%'], ['Canceladas', (res.by_status.find(s => s.status === 'cancelada') || { n: 0 }).n]]
          .map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
        <div class="grid-2"><div class="card"><h3>Por estado</h3>${hbars(res.by_status, r => RES_ST[r.status][1], r => r.n, v => v)}</div>
          <div class="card"><h3>Por día de la semana</h3>${hbars([1, 2, 3, 4, 5, 6, 0].map(d => res.by_weekday.find(x => x.dow === d) || { dow: d, n: 0, people: 0 }), r => DOW[r.dow], r => r.n, v => v + ' reservas')}</div></div>` : ''}`;
  };
  S.H = {
    refresh: () => { if (from <= isoDate() && to >= isoDate()) fetchData(); },
    preset: a => { preset = a.dataset.p; [from, to] = presets[preset].map(d => addDays(isoDate(), d)); fetchData(); },
    from: a => { from = a.value; if (from > to) to = from; preset = ''; fetchData(); },
    to: a => { to = a.value; if (to < from) from = to; preset = ''; fetchData(); },
    tab: a => { tab = a.dataset.t; draw(); },
    sort: a => { if (sortKey === a.dataset.k) sortDir *= -1; else { sortKey = a.dataset.k; sortDir = -1; } draw(); },
    csv: async (a, e) => {
      e.preventDefault();
      const r = await fetch(a.href, { headers: { Authorization: 'Bearer ' + S.token } });
      const url = URL.createObjectURL(await r.blob());
      Object.assign(document.createElement('a'), { href: url, download: `ventas_${from}_${to}.csv` }).click();
      URL.revokeObjectURL(url);
    },
  };
  fetchData();
}

// ======================================================================
// ADMINISTRACIÓN
// ======================================================================
function viewAdmin(view) {
  let tab = 'productos';
  const draw = async () => {
    await loadBoot();
    const b = S.boot, cat = id => b.categories.find(c => c.id === id)?.name || '—';
    let body = '';
    if (tab === 'productos') body = `<div class="spread"><p class="muted small">El costo se usa para calcular márgenes en la analítica de platos.</p><button class="btn primary" data-a="newp">+ Producto</button></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Producto</th><th>Categoría</th><th class="r">Precio</th><th class="r">Costo</th><th>Cocina</th><th>Estado</th><th></th></tr></thead><tbody>
      ${b.products.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(cat(p.category_id))}</td><td class="r">${money(p.price)}</td><td class="r">${money(p.cost)}</td><td>${p.to_kitchen ? 'Sí' : 'No'}</td>
        <td><span class="badge ${p.active ? 'ok' : ''}">${p.active ? 'Activo' : 'Inactivo'}</span></td><td><button class="btn sm" data-a="editp" data-id="${p.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`;
    if (tab === 'categorias') body = `<div class="spread"><span></span><button class="btn primary" data-a="newc">+ Categoría</button></div>
      <table class="data"><thead><tr><th>Categoría</th><th class="r">Orden</th><th></th></tr></thead><tbody>${b.categories.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${c.sort}</td><td><button class="btn sm" data-a="editc" data-id="${c.id}">Editar</button></td></tr>`).join('')}</tbody></table>`;
    if (tab === 'mesas') { const all = await api('/admin/tables'); S.allTables = all;
      body = `<div class="spread"><span></span><button class="btn primary" data-a="newt">+ Mesa</button></div>
      <table class="data"><thead><tr><th>Mesa</th><th>Zona</th><th class="r">Puestos</th><th>Estado</th><th></th></tr></thead><tbody>${all.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.zone)}</td><td class="r">${t.seats}</td><td>${t.active ? 'Activa' : 'Inactiva'}</td><td><button class="btn sm" data-a="editt" data-id="${t.id}">Editar</button></td></tr>`).join('')}</tbody></table>`; }
    if (tab === 'usuarios') { const users = await api('/admin/users'); S.users = users;
      body = `<div class="spread"><p class="muted small">Cada persona entra con su PIN. Cambia los PIN de demostración antes de usar el sistema.</p><button class="btn primary" data-a="newu">+ Usuario</button></div>
      <table class="data"><thead><tr><th>Nombre</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${ROLE_LABEL[u.role]}</td><td>${u.active ? 'Activo' : 'Inactivo'}</td><td><button class="btn sm" data-a="editu" data-id="${u.id}">Editar</button></td></tr>`).join('')}</tbody></table>`; }
    if (tab === 'ajustes') { const s = b.settings;
      body = `<form data-submit="saveset" class="card" style="max-width:640px"><div class="form">
        <label style="grid-column:1/-1">Nombre del restaurante<input name="restaurant_name" value="${esc(s.restaurant_name)}"></label>
        <label>Identificación fiscal<input name="tax_id" value="${esc(s.tax_id || '')}" placeholder="RUC / NIT / RFC"></label>
        <label>Dirección<input name="address" value="${esc(s.address || '')}"></label>
        <label>Moneda (código ISO)<input name="currency" value="${esc(s.currency)}" maxlength="3" placeholder="USD, MXN, COP, PEN…"></label>
        <label>Impuesto %<input name="tax_rate" type="number" step="0.01" min="0" value="${esc(s.tax_rate)}"></label>
        <label>Precios<select name="tax_included"><option value="1" ${s.tax_included === '1' ? 'selected' : ''}>Incluyen impuesto</option><option value="0" ${s.tax_included !== '1' ? 'selected' : ''}>Impuesto se suma al cobrar</option></select></label>
        <label style="grid-column:1/-1">Pie del ticket<input name="ticket_footer" value="${esc(s.ticket_footer || '')}"></label></div>
        <button class="btn primary" style="margin-top:16px">Guardar ajustes</button></form>`; }
    view.innerHTML = `<h1>Administración</h1><div class="tabs" style="margin-top:12px">${[['productos', 'Productos'], ['categorias', 'Categorías'], ['mesas', 'Mesas'], ['usuarios', 'Usuarios'], ['ajustes', 'Ajustes']]
      .map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-a="tab" data-t="${k}">${l}</button>`).join('')}</div><div class="card">${body}</div>`;
  };
  const save = (path, id) => async (fd, close) => {
    const b = formObj(fd);
    for (const k of ['price', 'cost', 'seats', 'sort', 'category_id']) if (k in b) b[k] = +b[k];
    for (const k of ['active', 'to_kitchen']) if (k in b) b[k] = b[k] === '1' ? 1 : 0;
    await api(`/admin/${path}${id ? '/' + id : ''}`, { method: id ? 'PATCH' : 'POST', body: b });
    close(); toast('Guardado', 'ok'); draw();
  };
  const actions = `<div class="row" style="margin-top:16px;justify-content:flex-end"><button type="button" class="btn" data-a="close">Cancelar</button><button class="btn primary">Guardar</button></div>`;
  const yesno = (name, v, yes = 'Sí', no = 'No') => `<select name="${name}"><option value="1" ${v ? 'selected' : ''}>${yes}</option><option value="0" ${v ? '' : 'selected'}>${no}</option></select>`;
  const prodForm = (p = { active: 1, to_kitchen: 1 }) => modal(`<form><h2>${p.id ? 'Editar' : 'Nuevo'} producto</h2><div class="form" style="margin-top:12px">
    <label style="grid-column:1/-1">Nombre<input name="name" required value="${esc(p.name || '')}"></label>
    <label>Categoría<select name="category_id">${S.boot.categories.map(c => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label>Precio<input name="price" type="number" step="0.01" min="0" required value="${p.price ?? ''}"></label>
    <label>Costo<input name="cost" type="number" step="0.01" min="0" value="${p.cost ?? 0}"></label>
    <label>¿Pasa por cocina?${yesno('to_kitchen', p.to_kitchen, 'Sí, imprime comanda', 'No (bebidas, etc.)')}</label>
    <label>Estado${yesno('active', p.active, 'Activo', 'Inactivo')}</label></div>${actions}</form>`, { submit: save('products', p.id) });
  const catForm = (c = {}) => modal(`<form><h2>${c.id ? 'Editar' : 'Nueva'} categoría</h2><div class="form" style="margin-top:12px">
    <label>Nombre<input name="name" required value="${esc(c.name || '')}"></label><label>Orden<input name="sort" type="number" value="${c.sort ?? S.boot.categories.length}"></label></div>${actions}</form>`, { submit: save('categories', c.id) });
  const tableForm = (t = { active: 1 }) => modal(`<form><h2>${t.id ? 'Editar' : 'Nueva'} mesa</h2><div class="form" style="margin-top:12px">
    <label>Nombre<input name="name" required value="${esc(t.name || '')}"></label><label>Zona<input name="zone" value="${esc(t.zone || 'Salón')}"></label>
    <label>Puestos<input name="seats" type="number" min="1" value="${t.seats || 4}"></label><label>Estado${yesno('active', t.active, 'Activa', 'Inactiva')}</label></div>${actions}</form>`, { submit: save('tables', t.id) });
  const userForm = (u = { active: 1, role: 'mesero' }) => modal(`<form><h2>${u.id ? 'Editar' : 'Nuevo'} usuario</h2><div class="form" style="margin-top:12px">
    <label>Nombre<input name="name" required value="${esc(u.name || '')}"></label>
    <label>Rol<select name="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>PIN (4 a 6 dígitos)<input name="pin" inputmode="numeric" pattern="\\d{4,6}" ${u.id ? 'placeholder="Dejar vacío para no cambiar"' : 'required'}></label>
    <label>Estado${yesno('active', u.active, 'Activo', 'Inactivo')}</label></div>${actions}</form>`,
    { submit: async (fd, close) => { const b = formObj(fd); b.active = b.active === '1' ? 1 : 0; if (!b.pin) delete b.pin;
      await api('/admin/users' + (u.id ? '/' + u.id : ''), { method: u.id ? 'PATCH' : 'POST', body: b }); close(); toast('Guardado', 'ok'); draw(); } });
  S.H = {
    tab: a => { tab = a.dataset.t; draw(); },
    newp: () => prodForm(), editp: a => prodForm(S.boot.products.find(p => p.id == a.dataset.id)),
    newc: () => catForm(), editc: a => catForm(S.boot.categories.find(c => c.id == a.dataset.id)),
    newt: () => tableForm(), editt: a => tableForm(S.allTables.find(t => t.id == a.dataset.id)),
    newu: () => userForm(), editu: a => userForm(S.users.find(u => u.id == a.dataset.id)),
    saveset: async f => { const b = formObj(new FormData(f)); b.currency = b.currency.toUpperCase(); await api('/admin/settings', { method: 'PUT', body: b }); await loadBoot(); toast('Ajustes guardados', 'ok'); render(); },
  };
  draw();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
render();
