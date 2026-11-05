// Base de datos SQLite (módulo nativo de Node 22+). Para producción grande se puede migrar a PostgreSQL.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// Hora local del restaurante (Ecuador). Se puede cambiar con la variable TZ.
process.env.TZ = process.env.TZ || 'America/Guayaquil';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'restaurante.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','cajero','mesero','cocina')),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL, price REAL NOT NULL, cost REAL NOT NULL DEFAULT 0,
  to_kitchen INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY, name TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 4, zone TEXT DEFAULT 'Salón', active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, table_id INTEGER REFERENCES tables(id), waiter_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'mesa', customer TEXT, guests INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','pagada','anulada')),
  subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, tax REAL DEFAULT 0, tip REAL DEFAULT 0, total REAL DEFAULT 0,
  created_at TEXT NOT NULL, closed_at TEXT, cashier_id INTEGER REFERENCES users(id), notes TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL, price REAL NOT NULL, qty INTEGER NOT NULL, notes TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo','enviado','listo','entregado','anulado')),
  ticket_id INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','preparando','listo')),
  created_at TEXT NOT NULL, ready_at TEXT, printed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia')),
  amount REAL NOT NULL, received REAL, change REAL, created_at TEXT NOT NULL, cashier_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, party_size INTEGER NOT NULL,
  date TEXT NOT NULL, time TEXT NOT NULL, table_id INTEGER REFERENCES tables(id),
  status TEXT NOT NULL DEFAULT 'confirmada' CHECK (status IN ('pendiente','confirmada','sentada','cancelada','no_show')),
  notes TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_closed ON orders(closed_at);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_res_date ON reservations(date);
`);

// Ajustes por defecto para Ecuador: dólar, IVA 15 % incluido en los precios de la carta.
const DEFAULT_SETTINGS = [['restaurant_name', 'Mi Restaurante'], ['country', 'EC'], ['currency', 'USD'], ['locale', 'es-EC'],
  ['tax_name', 'IVA'], ['tax_rate', '15'], ['tax_included', '1'], ['tax_id', ''], ['address', ''], ['ticket_footer', '¡Gracias por su visita!']];

function seed() {
  // agrega los ajustes que falten sin tocar los que el administrador ya cambió
  const set = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
  DEFAULT_SETTINGS.forEach(r => set.run(...r));
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) return;

  const u = db.prepare('INSERT INTO users(name,pin,role) VALUES (?,?,?)');
  u.run('Administrador', '1234', 'admin');
  u.run('Caja', '1111', 'cajero');
  u.run('Mesero 1', '2222', 'mesero');
  u.run('Cocina', '3333', 'cocina');

  const c = db.prepare('INSERT INTO categories(name,sort) VALUES (?,?)');
  const p = db.prepare('INSERT INTO products(category_id,name,price,cost,to_kitchen) VALUES (?,?,?,?,?)');
  const menu = {
    'Entradas': [['Empanadas (3)', 6, 2], ['Ceviche', 11, 4.5], ['Sopa del día', 5.5, 1.5]],
    'Platos fuertes': [['Lomo saltado', 15, 6], ['Pollo a la plancha', 12, 4], ['Pasta bolognesa', 11, 3.5], ['Hamburguesa clásica', 10, 3.8], ['Pescado frito', 16, 6.5]],
    'Postres': [['Flan', 4.5, 1], ['Tres leches', 5, 1.4], ['Helado', 3.5, 1]],
    'Bebidas': [['Agua', 1.5, 0.4, 0], ['Gaseosa', 2, 0.6, 0], ['Limonada', 3, 0.7, 0], ['Café', 2, 0.4, 0], ['Cerveza', 3.5, 1.2, 0]],
  };
  let s = 0;
  for (const [cat, items] of Object.entries(menu)) {
    const cid = c.run(cat, s++).lastInsertRowid;
    for (const [name, price, cost, kitchen = 1] of items) p.run(cid, name, price, cost, kitchen);
  }
  const t = db.prepare('INSERT INTO tables(name,seats,zone) VALUES (?,?,?)');
  for (let i = 1; i <= 10; i++) t.run(`Mesa ${i}`, i % 3 === 0 ? 6 : 4, i <= 7 ? 'Salón' : 'Terraza');
}
seed();

const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, getSettings, tx };
