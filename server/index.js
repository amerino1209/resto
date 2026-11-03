const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { db, getSettings, tx } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- utilidades ----------
const pad = n => String(n).padStart(2, '0');
function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const today = () => now().slice(0, 10);
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const h = fn => (req, res) => {
  try { const r = fn(req, res); if (r !== undefined) res.json(r); }
  catch (e) { if (!(e instanceof HttpError)) console.error(e); res.status(e.status || 500).json({ error: e.message }); }
};
const notify = (event, payload = {}) => io.emit(event, payload);

// ---------- autenticación por PIN ----------
function userFromToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1`).get(token) || null;
}
const auth = (...roles) => (req, res, next) => {
  const user = userFromToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: 'Sesión no válida' });
  if (roles.length && user.role !== 'admin' && !roles.includes(user.role)) return res.status(403).json({ error: 'Sin permiso para esta acción' });
  req.user = user; next();
};

app.post('/api/login', h(req => {
  const user = db.prepare('SELECT id,name,role FROM users WHERE pin=? AND active=1').get(String(req.body.pin || ''));
  if (!user) fail(401, 'PIN incorrecto');
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,created_at) VALUES (?,?,?)').run(token, user.id, now());
  return { token, user };
}));
app.post('/api/logout', auth(), h(req => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.headers.authorization.replace('Bearer ', ''));
  return { ok: true };
}));
app.get('/api/me', auth(), h(req => req.user));

app.get('/api/bootstrap', auth(), h(() => ({
  settings: getSettings(),
  categories: db.prepare('SELECT * FROM categories ORDER BY sort,name').all(),
  products: db.prepare('SELECT * FROM products ORDER BY name').all(),
  tables: db.prepare('SELECT * FROM tables WHERE active=1 ORDER BY id').all(),
})));

// ---------- pedidos ----------
function computeTotals(order, discount = order.discount || 0, tip = order.tip || 0) {
  const s = getSettings();
  const rate = Number(s.tax_rate || 0) / 100;
  const subtotal = round2(db.prepare(`SELECT COALESCE(SUM(price*qty),0) t FROM order_items WHERE order_id=? AND status<>'anulado'`).get(order.id).t);
  const base = Math.max(0, subtotal - discount);
  let tax, total;
  if (s.tax_included === '1') { tax = round2(base - base / (1 + rate)); total = round2(base + Number(tip)); }
  else { tax = round2(base * rate); total = round2(base + tax + Number(tip)); }
  return { subtotal, discount: round2(discount), tax, tip: round2(tip), total };
}
function loadOrder(id) {
  const o = db.prepare(`SELECT o.*, t.name table_name, u.name waiter_name FROM orders o
    LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.waiter_id WHERE o.id=?`).get(id);
  if (!o) fail(404, 'Pedido no encontrado');
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.payments = db.prepare('SELECT * FROM payments WHERE order_id=?').all(id);
  if (o.status === 'abierta') Object.assign(o, computeTotals(o));
  return o;
}

app.get('/api/tables/status', auth(), h(() => {
  const tables = db.prepare('SELECT * FROM tables WHERE active=1 ORDER BY id').all();
  const open = db.prepare(`SELECT o.id,o.table_id,o.guests,o.created_at,u.name waiter_name,
      (SELECT COALESCE(SUM(price*qty),0) FROM order_items i WHERE i.order_id=o.id AND i.status<>'anulado') amount,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id AND i.status='nuevo') unsent,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id AND i.status='listo') ready
    FROM orders o LEFT JOIN users u ON u.id=o.waiter_id WHERE o.status='abierta' AND o.table_id IS NOT NULL`).all();
  const res = db.prepare(`SELECT * FROM reservations WHERE date=? AND status IN ('pendiente','confirmada') AND table_id IS NOT NULL ORDER BY time`).all(today());
  return tables.map(t => ({ ...t, order: open.find(o => o.table_id === t.id) || null, reservation: res.find(r => r.table_id === t.id) || null }));
}));

app.get('/api/orders', auth(), h(req => {
  const status = req.query.status || 'abierta';
  const ids = db.prepare('SELECT id FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 200').all(status);
  return ids.map(r => loadOrder(r.id));
}));
app.get('/api/orders/:id', auth(), h(req => loadOrder(req.params.id)));

app.post('/api/orders', auth('mesero', 'cajero'), h(req => {
  const { table_id = null, kind = 'mesa', customer = null, guests = 1 } = req.body;
  if (table_id) {
    const existing = db.prepare(`SELECT id FROM orders WHERE table_id=? AND status='abierta'`).get(table_id);
    if (existing) return loadOrder(existing.id);
  }
  const id = db.prepare('INSERT INTO orders(table_id,waiter_id,kind,customer,guests,created_at) VALUES (?,?,?,?,?,?)')
    .run(table_id, req.user.id, table_id ? 'mesa' : kind, customer, guests, now()).lastInsertRowid;
  notify('orders');
  return loadOrder(id);
}));
app.patch('/api/orders/:id', auth('mesero', 'cajero'), h(req => {
  const o = loadOrder(req.params.id);
  if (o.status !== 'abierta') fail(400, 'El pedido ya está cerrado');
  const f = { ...o, ...req.body };
  if (f.table_id && f.table_id !== o.table_id) {
    const busy = db.prepare(`SELECT id FROM orders WHERE table_id=? AND status='abierta' AND id<>?`).get(f.table_id, o.id);
    if (busy) fail(400, 'Esa mesa ya tiene un pedido abierto');
  }
  db.prepare('UPDATE orders SET table_id=?,guests=?,customer=?,notes=? WHERE id=?').run(f.table_id, f.guests, f.customer, f.notes, o.id);
  notify('orders'); notify('tickets');
  return loadOrder(o.id);
}));

app.post('/api/orders/:id/items', auth('mesero', 'cajero'), h(req => {
  const o = loadOrder(req.params.id);
  if (o.status !== 'abierta') fail(400, 'El pedido ya está cerrado');
  const getP = db.prepare('SELECT * FROM products WHERE id=? AND active=1');
  const ins = db.prepare('INSERT INTO order_items(order_id,product_id,name,price,qty,notes,created_at) VALUES (?,?,?,?,?,?,?)');
  tx(() => {
    for (const it of req.body.items || []) {
      const p = getP.get(it.product_id);
      if (!p) fail(400, 'Producto no disponible');
      const qty = Math.max(1, parseInt(it.qty) || 1);
      ins.run(o.id, p.id, p.name, p.price, qty, it.notes || null, now());
    }
  });
  notify('orders');
  return loadOrder(o.id);
}));
app.patch('/api/items/:id', auth('mesero', 'cajero'), h(req => {
  const it = db.prepare('SELECT * FROM order_items WHERE id=?').get(req.params.id);
  if (!it) fail(404, 'Ítem no encontrado');
  if (req.body.status === 'entregado') db.prepare(`UPDATE order_items SET status='entregado' WHERE id=?`).run(it.id);
  else {
    if (it.status !== 'nuevo') fail(400, 'Solo se pueden editar ítems que aún no se enviaron a cocina');
    db.prepare('UPDATE order_items SET qty=?,notes=? WHERE id=?').run(Math.max(1, parseInt(req.body.qty ?? it.qty)), req.body.notes ?? it.notes, it.id);
  }
  notify('orders');
  return loadOrder(it.order_id);
}));
app.delete('/api/items/:id', auth('mesero', 'cajero'), h(req => {
  const it = db.prepare('SELECT * FROM order_items WHERE id=?').get(req.params.id);
  if (!it) fail(404, 'Ítem no encontrado');
  if (it.status === 'nuevo') db.prepare('DELETE FROM order_items WHERE id=?').run(it.id);
  else {
    if (req.user.role === 'mesero') fail(403, 'Para anular un plato ya enviado a cocina pide autorización a caja');
    db.prepare(`UPDATE order_items SET status='anulado' WHERE id=?`).run(it.id);
    notify('tickets');
  }
  notify('orders');
  return loadOrder(it.order_id);
}));

// Enviar a cocina: crea una comanda con los ítems nuevos
app.post('/api/orders/:id/send', auth('mesero', 'cajero'), h(req => {
  const o = loadOrder(req.params.id);
  const pending = db.prepare(`SELECT i.id, COALESCE(p.to_kitchen,1) to_kitchen FROM order_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.order_id=? AND i.status='nuevo'`).all(o.id);
  if (!pending.length) fail(400, 'No hay ítems nuevos para enviar');
  let ticketId = null;
  tx(() => {
    const kitchen = pending.filter(i => i.to_kitchen);
    if (kitchen.length) {
      ticketId = db.prepare('INSERT INTO tickets(order_id,created_at) VALUES (?,?)').run(o.id, now()).lastInsertRowid;
      const up = db.prepare(`UPDATE order_items SET status='enviado', ticket_id=? WHERE id=?`);
      kitchen.forEach(i => up.run(ticketId, i.id));
    }
    // bebidas y productos que no pasan por cocina quedan listos de inmediato
    const up2 = db.prepare(`UPDATE order_items SET status='listo' WHERE id=?`);
    pending.filter(i => !i.to_kitchen).forEach(i => up2.run(i.id));
  });
  notify('orders');
  if (ticketId) notify('tickets', { new: ticketId });
  return loadOrder(o.id);
}));

app.post('/api/orders/:id/pay', auth('cajero'), h(req => {
  const o = loadOrder(req.params.id);
  if (o.status !== 'abierta') fail(400, 'El pedido ya está cerrado');
  if (o.items.some(i => i.status === 'nuevo')) fail(400, 'Hay ítems sin enviar a cocina. Envíalos o elimínalos antes de cobrar');
  const t = computeTotals(o, Number(req.body.discount) || 0, Number(req.body.tip) || 0);
  const payments = req.body.payments || [];
  const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
  if (t.subtotal <= 0) fail(400, 'El pedido está vacío');
  if (paid + 0.001 < t.total) fail(400, `Falta cobrar ${round2(t.total - paid)}`);
  tx(() => {
    const ins = db.prepare('INSERT INTO payments(order_id,method,amount,received,change,created_at,cashier_id) VALUES (?,?,?,?,?,?,?)');
    let remaining = t.total;
    for (const p of payments) {
      if (!['efectivo', 'tarjeta', 'transferencia'].includes(p.method)) fail(400, 'Método de pago inválido');
      const amount = round2(Math.min(Number(p.amount), remaining));
      if (amount <= 0) continue;
      const received = p.method === 'efectivo' ? Number(p.received || p.amount) : amount;
      ins.run(o.id, p.method, amount, received, round2(received - amount), now(), req.user.id);
      remaining = round2(remaining - amount);
    }
    db.prepare(`UPDATE orders SET status='pagada',subtotal=?,discount=?,tax=?,tip=?,total=?,closed_at=?,cashier_id=? WHERE id=?`)
      .run(t.subtotal, t.discount, t.tax, t.tip, t.total, now(), req.user.id, o.id);
    db.prepare(`UPDATE order_items SET status='entregado' WHERE order_id=? AND status IN ('enviado','listo')`).run(o.id);
  });
  notify('orders'); notify('tickets');
  return loadOrder(o.id);
}));
app.post('/api/orders/:id/cancel', auth('cajero'), h(req => {
  const o = loadOrder(req.params.id);
  if (o.status !== 'abierta') fail(400, 'El pedido ya está cerrado');
  db.prepare(`UPDATE orders SET status='anulada', closed_at=?, notes=COALESCE(notes,'')||? WHERE id=?`).run(now(), ` [Anulada: ${req.body.reason || 'sin motivo'}]`, o.id);
  db.prepare(`UPDATE order_items SET status='anulado' WHERE order_id=?`).run(o.id);
  notify('orders'); notify('tickets');
  return { ok: true };
}));

// ---------- cocina ----------
app.get('/api/kitchen/tickets', auth('cocina', 'cajero', 'mesero'), h(() => {
  const since = now(new Date(Date.now() - 30 * 60000));
  const tickets = db.prepare(`SELECT k.*, o.table_id, o.kind, o.customer, o.notes order_notes, t.name table_name, u.name waiter_name
    FROM tickets k JOIN orders o ON o.id=k.order_id LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.waiter_id
    WHERE k.status IN ('pendiente','preparando') OR (k.status='listo' AND k.ready_at>=?) ORDER BY k.created_at`).all(since);
  const items = db.prepare('SELECT id,name,qty,notes,status FROM order_items WHERE ticket_id=?');
  return tickets.map(k => ({ ...k, items: items.all(k.id) }));
}));
app.patch('/api/tickets/:id', auth('cocina'), h(req => {
  const k = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!k) fail(404, 'Comanda no encontrada');
  const status = req.body.status;
  if (!['pendiente', 'preparando', 'listo'].includes(status)) fail(400, 'Estado inválido');
  db.prepare('UPDATE tickets SET status=?, ready_at=? WHERE id=?').run(status, status === 'listo' ? now() : null, k.id);
  if (status === 'listo') db.prepare(`UPDATE order_items SET status='listo' WHERE ticket_id=? AND status='enviado'`).run(k.id);
  else db.prepare(`UPDATE order_items SET status='enviado' WHERE ticket_id=? AND status='listo'`).run(k.id);
  const info = db.prepare(`SELECT t.name table_name, o.customer, o.waiter_id FROM orders o LEFT JOIN tables t ON t.id=o.table_id WHERE o.id=?`).get(k.order_id);
  notify('tickets'); notify('orders');
  if (status === 'listo') notify('ticket:ready', { ticket: k.id, ...info });
  return { ok: true };
}));
app.post('/api/tickets/:id/printed', auth('cocina'), h(req => {
  db.prepare('UPDATE tickets SET printed=1 WHERE id=?').run(req.params.id);
  return { ok: true };
}));

// ---------- reservas ----------
app.get('/api/reservations', auth(), h(req => {
  const from = req.query.from || today(), to = req.query.to || from;
  return db.prepare(`SELECT r.*, t.name table_name FROM reservations r LEFT JOIN tables t ON t.id=r.table_id WHERE date BETWEEN ? AND ? ORDER BY date,time`).all(from, to);
}));
function validateReservation(r, id = 0) {
  if (!r.name || !r.date || !r.time || !(r.party_size > 0)) fail(400, 'Nombre, fecha, hora y número de personas son obligatorios');
  if (r.table_id) {
    // evita dos reservas activas en la misma mesa con menos de 2 horas de diferencia
    const clash = db.prepare(`SELECT name,time FROM reservations WHERE table_id=? AND date=? AND id<>? AND status IN ('pendiente','confirmada','sentada')
      AND ABS((CAST(substr(time,1,2) AS INTEGER)*60+CAST(substr(time,4,2) AS INTEGER)) - ?) < 120`)
      .get(r.table_id, r.date, id, parseInt(r.time.slice(0, 2)) * 60 + parseInt(r.time.slice(3, 5)));
    if (clash) fail(400, `La mesa ya está reservada a las ${clash.time} (${clash.name})`);
  }
}
app.post('/api/reservations', auth('cajero', 'mesero'), h(req => {
  const r = { status: 'confirmada', ...req.body };
  r.table_id = r.table_id || null;
  validateReservation(r);
  const id = db.prepare('INSERT INTO reservations(name,phone,party_size,date,time,table_id,status,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(r.name, r.phone || null, r.party_size, r.date, r.time, r.table_id, r.status, r.notes || null, now()).lastInsertRowid;
  notify('reservations'); notify('orders');
  return db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
}));
app.patch('/api/reservations/:id', auth('cajero', 'mesero'), h(req => {
  const cur = db.prepare('SELECT * FROM reservations WHERE id=?').get(req.params.id);
  if (!cur) fail(404, 'Reserva no encontrada');
  const r = { ...cur, ...req.body };
  r.table_id = r.table_id || null;
  if (['pendiente', 'confirmada'].includes(r.status)) validateReservation(r, cur.id);
  db.prepare('UPDATE reservations SET name=?,phone=?,party_size=?,date=?,time=?,table_id=?,status=?,notes=? WHERE id=?')
    .run(r.name, r.phone, r.party_size, r.date, r.time, r.table_id, r.status, r.notes, cur.id);
  notify('reservations'); notify('orders');
  return db.prepare('SELECT * FROM reservations WHERE id=?').get(cur.id);
}));
// Sentar la reserva: marca la llegada y abre el pedido en la mesa
app.post('/api/reservations/:id/seat', auth('cajero', 'mesero'), h(req => {
  const r = db.prepare('SELECT * FROM reservations WHERE id=?').get(req.params.id);
  if (!r) fail(404, 'Reserva no encontrada');
  const tableId = req.body.table_id || r.table_id;
  if (!tableId) fail(400, 'Asigna una mesa para sentar a los clientes');
  if (db.prepare(`SELECT id FROM orders WHERE table_id=? AND status='abierta'`).get(tableId)) fail(400, 'La mesa está ocupada');
  const id = tx(() => {
    db.prepare(`UPDATE reservations SET status='sentada', table_id=? WHERE id=?`).run(tableId, r.id);
    return db.prepare('INSERT INTO orders(table_id,waiter_id,customer,guests,created_at,notes) VALUES (?,?,?,?,?,?)')
      .run(tableId, req.user.id, r.name, r.party_size, now(), `Reserva #${r.id}`).lastInsertRowid;
  });
  notify('reservations'); notify('orders');
  return loadOrder(id);
}));

// ---------- reportes ----------
function range(req) {
  const from = req.query.from || today(), to = req.query.to || from;
  return [from + ' 00:00:00', to + ' 23:59:59', from, to];
}
app.get('/api/reports/summary', auth('cajero'), h(req => {
  const [a, b] = range(req);
  const W = `o.status='pagada' AND o.closed_at BETWEEN ? AND ?`;
  const totals = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) total, COALESCE(SUM(subtotal),0) subtotal, COALESCE(SUM(discount),0) discount,
      COALESCE(SUM(tax),0) tax, COALESCE(SUM(tip),0) tip, COALESCE(SUM(guests),0) guests FROM orders o WHERE ${W}`).get(a, b);
  totals.avg_ticket = totals.orders ? round2((totals.total - totals.tip) / totals.orders) : 0;
  totals.avg_per_guest = totals.guests ? round2((totals.total - totals.tip) / totals.guests) : 0;
  totals.cancelled = db.prepare(`SELECT COUNT(*) c FROM orders WHERE status='anulada' AND closed_at BETWEEN ? AND ?`).get(a, b).c;
  return {
    totals,
    by_method: db.prepare(`SELECT p.method, COUNT(*) n, SUM(p.amount) amount FROM payments p JOIN orders o ON o.id=p.order_id WHERE ${W} GROUP BY p.method`).all(a, b),
    by_day: db.prepare(`SELECT substr(closed_at,1,10) day, COUNT(*) orders, SUM(total-tip) sales FROM orders o WHERE ${W} GROUP BY day ORDER BY day`).all(a, b),
    by_hour: db.prepare(`SELECT CAST(substr(created_at,12,2) AS INTEGER) hour, COUNT(*) orders, SUM(total-tip) sales FROM orders o WHERE ${W} GROUP BY hour ORDER BY hour`).all(a, b),
    by_waiter: db.prepare(`SELECT COALESCE(u.name,'—') waiter, COUNT(*) orders, SUM(o.total-o.tip) sales, SUM(o.tip) tips FROM orders o LEFT JOIN users u ON u.id=o.waiter_id WHERE ${W} GROUP BY o.waiter_id ORDER BY sales DESC`).all(a, b),
    by_category: db.prepare(`SELECT COALESCE(c.name,'Sin categoría') category, SUM(i.qty) qty, SUM(i.qty*i.price) sales FROM order_items i JOIN orders o ON o.id=i.order_id
      LEFT JOIN products p ON p.id=i.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE ${W} AND i.status<>'anulado' GROUP BY c.id ORDER BY sales DESC`).all(a, b),
  };
}));

// Rotación de platos + ingeniería de menú (popularidad vs. margen)
app.get('/api/reports/dishes', auth('cajero'), h(req => {
  const [a, b, from, to] = range(req);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const rows = db.prepare(`SELECT p.id, p.name, c.name category, p.price, p.cost, p.active,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN i.qty END),0) qty,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN i.qty*i.price END),0) sales,
      COUNT(DISTINCT o.id) orders, MAX(o.closed_at) last_sold
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN order_items i ON i.product_id=p.id AND i.status<>'anulado'
    LEFT JOIN orders o ON o.id=i.order_id AND o.status='pagada' AND o.closed_at BETWEEN ? AND ?
    GROUP BY p.id ORDER BY qty DESC, p.name`).all(a, b);
  const sold = rows.filter(r => r.qty > 0);
  const totalQty = sold.reduce((s, r) => s + r.qty, 0);
  const totalMargin = sold.reduce((s, r) => s + r.qty * (r.price - r.cost), 0);
  // Umbrales clásicos de ingeniería de menú (Kasavana & Smith)
  const popThreshold = rows.length ? (1 / rows.length) * 0.7 : 0;
  const avgMargin = totalQty ? totalMargin / totalQty : 0;
  const dishes = rows.map(r => {
    const share = totalQty ? r.qty / totalQty : 0;
    const unitMargin = round2(r.price - r.cost);
    let klass = 'Sin ventas';
    if (r.qty > 0) {
      const popular = share >= popThreshold, profitable = unitMargin >= avgMargin;
      klass = popular && profitable ? 'Estrella' : popular ? 'Caballo de batalla' : profitable ? 'Rompecabezas' : 'Perro';
    }
    return { ...r, sales: round2(r.sales), share: round2(share * 100), per_day: round2(r.qty / days), unit_margin: unitMargin,
      margin_total: round2(r.qty * unitMargin), margin_pct: r.price ? round2(unitMargin / r.price * 100) : 0, class: klass };
  });
  return { days, total_qty: totalQty, avg_margin: round2(avgMargin), pop_threshold_pct: round2(popThreshold * 100), dishes };
}));
app.get('/api/reports/reservations', auth('cajero'), h(req => {
  const [, , from, to] = range(req);
  const by_status = db.prepare(`SELECT status, COUNT(*) n, SUM(party_size) people FROM reservations WHERE date BETWEEN ? AND ? GROUP BY status`).all(from, to);
  const total = by_status.reduce((s, r) => s + r.n, 0);
  const g = s => (by_status.find(r => r.status === s) || { n: 0 }).n;
  return {
    total, by_status,
    show_rate: total ? round2(g('sentada') / Math.max(1, total - g('cancelada') - g('pendiente') - g('confirmada')) * 100) : 0,
    no_show_rate: total ? round2(g('no_show') / total * 100) : 0,
    by_weekday: db.prepare(`SELECT CAST(strftime('%w',date) AS INTEGER) dow, COUNT(*) n, SUM(party_size) people FROM reservations WHERE date BETWEEN ? AND ? AND status<>'cancelada' GROUP BY dow`).all(from, to),
  };
}));
app.get('/api/reports/sales.csv', auth('cajero'), (req, res) => {
  const [a, b] = range(req);
  const rows = db.prepare(`SELECT o.id, o.closed_at, COALESCE(t.name, o.kind) mesa, u.name mesero, o.guests, o.subtotal, o.discount, o.tax, o.tip, o.total,
      (SELECT GROUP_CONCAT(method||':'||amount,' | ') FROM payments p WHERE p.order_id=o.id) pagos
    FROM orders o LEFT JOIN tables t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.waiter_id
    WHERE o.status='pagada' AND o.closed_at BETWEEN ? AND ? ORDER BY o.closed_at`).all(a, b);
  const cols = ['id', 'closed_at', 'mesa', 'mesero', 'guests', 'subtotal', 'discount', 'tax', 'tip', 'total', 'pagos'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ventas_${req.query.from || today()}_${req.query.to || today()}.csv"`);
  res.send('﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
});

// ---------- administración ----------
function crud(name, table, fields) {
  app.get(`/api/admin/${name}`, auth(), h(() => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
  app.post(`/api/admin/${name}`, auth('admin'), h(req => {
    const vals = fields.map(f => req.body[f] ?? null);
    const id = db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
    notify('catalog');
    return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  }));
  app.patch(`/api/admin/${name}/:id`, auth('admin'), h(req => {
    const cur = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    if (!cur) fail(404, 'No encontrado');
    const r = { ...cur, ...req.body };
    db.prepare(`UPDATE ${table} SET ${fields.map(f => f + '=?').join(',')} WHERE id=?`).run(...fields.map(f => r[f] ?? null), cur.id);
    notify('catalog');
    return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(cur.id);
  }));
}
crud('categories', 'categories', ['name', 'sort']);
crud('products', 'products', ['category_id', 'name', 'price', 'cost', 'to_kitchen', 'active']);
crud('tables', 'tables', ['name', 'seats', 'zone', 'active']);
app.get('/api/admin/users', auth('admin'), h(() => db.prepare('SELECT id,name,role,active FROM users ORDER BY id').all()));
app.post('/api/admin/users', auth('admin'), h(req => {
  const { name, pin, role } = req.body;
  if (!name || !/^\d{4,6}$/.test(pin || '')) fail(400, 'Nombre y PIN de 4 a 6 dígitos son obligatorios');
  try { return { id: Number(db.prepare('INSERT INTO users(name,pin,role) VALUES (?,?,?)').run(name, pin, role).lastInsertRowid) }; }
  catch { fail(400, 'Ese PIN ya está en uso'); }
}));
app.patch('/api/admin/users/:id', auth('admin'), h(req => {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) fail(404, 'Usuario no encontrado');
  const r = { ...cur, ...req.body };
  if (req.body.pin !== undefined && !/^\d{4,6}$/.test(r.pin)) fail(400, 'El PIN debe tener de 4 a 6 dígitos');
  try { db.prepare('UPDATE users SET name=?,pin=?,role=?,active=? WHERE id=?').run(r.name, r.pin, r.role, r.active, cur.id); }
  catch { fail(400, 'Ese PIN ya está en uso'); }
  if (!r.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(cur.id);
  return { ok: true };
}));
app.put('/api/admin/settings', auth('admin'), h(req => {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(req.body)) up.run(k, String(v));
  notify('catalog');
  return getSettings();
}));

// ---------- tiempo real ----------
io.use((socket, next) => userFromToken(socket.handshake.auth?.token) ? next() : next(new Error('auth')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Restaurante listo en http://localhost:${PORT}`));
