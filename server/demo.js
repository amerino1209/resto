// Genera 30 días de ventas y reservas de ejemplo para probar los reportes: npm run demo
const { db, tx } = require('./db');
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const products = db.prepare('SELECT * FROM products WHERE active=1').all();
const tables = db.prepare('SELECT id FROM tables').all();
const waiters = db.prepare(`SELECT id FROM users WHERE role IN ('mesero','admin')`).all();
// popularidad desigual para que la analítica muestre diferencias
const weight = p => ({ 'Lomo saltado': 9, 'Hamburguesa clásica': 8, 'Gaseosa': 10, 'Limonada': 7, 'Ceviche': 5, 'Pescado frito': 2, 'Sopa del día': 1, 'Tres leches': 4 }[p.name] || 3);
const pool = products.flatMap(p => Array(weight(p)).fill(p));
const pick = a => a[Math.floor(Math.random() * a.length)];
tx(() => {
  for (let d = 30; d >= 1; d--) {
    const day = new Date(); day.setDate(day.getDate() - d);
    const n = 12 + Math.floor(Math.random() * 10) + ([5, 6].includes(day.getDay()) ? 10 : 0);
    for (let k = 0; k < n; k++) {
      const h = Math.random() < 0.45 ? 12 + Math.floor(Math.random() * 3) : 19 + Math.floor(Math.random() * 3);
      const open = new Date(day); open.setHours(h, Math.floor(Math.random() * 60));
      const close = new Date(open.getTime() + (40 + Math.random() * 50) * 60000);
      const guests = 1 + Math.floor(Math.random() * 5);
      const oid = db.prepare(`INSERT INTO orders(table_id,waiter_id,guests,status,created_at,closed_at,cashier_id) VALUES (?,?,?,'pagada',?,?,2)`)
        .run(pick(tables).id, pick(waiters).id, guests, fmt(open), fmt(close)).lastInsertRowid;
      let sub = 0;
      for (let i = 0; i < guests + 1; i++) {
        const p = pick(pool), q = 1 + (Math.random() < 0.2 ? 1 : 0);
        db.prepare(`INSERT INTO order_items(order_id,product_id,name,price,qty,status,created_at) VALUES (?,?,?,?,?,'entregado',?)`).run(oid, p.id, p.name, p.price, q, fmt(open));
        sub += p.price * q;
      }
      const tip = Math.random() < 0.6 ? Math.round(sub * 0.1 * 100) / 100 : 0, total = Math.round((sub + tip) * 100) / 100;
      db.prepare('UPDATE orders SET subtotal=?,tip=?,total=? WHERE id=?').run(sub, tip, total, oid);
      db.prepare('INSERT INTO payments(order_id,method,amount,received,change,created_at,cashier_id) VALUES (?,?,?,?,0,?,2)')
        .run(oid, pick(['efectivo', 'efectivo', 'tarjeta', 'tarjeta', 'transferencia']), total, total, fmt(close));
    }
    for (let r = 0; r < 3 + Math.floor(Math.random() * 4); r++) {
      const date = fmt(day).slice(0, 10);
      db.prepare(`INSERT INTO reservations(name,party_size,date,time,status,created_at) VALUES (?,?,?,?,?,?)`)
        .run(pick(['Ana', 'Luis', 'Carla', 'Pedro', 'Sofía', 'Jorge']) + ' ' + pick(['Gómez', 'Ruiz', 'Paz', 'Vega']), 2 + Math.floor(Math.random() * 5), date,
          pick(['13:00', '13:30', '20:00', '20:30', '21:00']), pick(['sentada', 'sentada', 'sentada', 'sentada', 'no_show', 'cancelada']), fmt(day));
    }
  }
});
console.log('Datos de ejemplo creados');
