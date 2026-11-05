# Sistema de ventas de restaurante

Aplicación web instalable (PWA) para computadora, tablet y celular. Un solo servidor atiende a todos los roles en tiempo real.

| Rol | Pantalla | Qué hace |
|---|---|---|
| Mesero | Mesas → Pedido | Abre mesas o pedidos para llevar, toma la orden desde el celular, agrega notas ("sin cebolla"), envía a cocina, recibe aviso cuando los platos están listos, cambia de mesa, imprime pre-cuenta. |
| Cocina | Cocina | Ve las comandas en tiempo real con temporizador (amarillo a los 12 min, rojo a los 20), las marca "Preparando" y "Listo", e imprime cada comanda (automática o manual). |
| Caja | Caja | Cobra cuentas abiertas: descuento, propina sugerida, pago en efectivo/tarjeta/transferencia, cuenta dividida, cálculo de cambio, ticket impreso, anulación con motivo y cierre de caja del día. |
| Caja / Mesero | Reservas | Agenda por día con vista de la semana, asigna mesa (evita choques de menos de 2 horas), confirma, marca "No vino" o "Sienta" a los clientes abriendo el pedido directamente. |
| Caja / Admin | Reportes | Ventas por día, por hora, por categoría, por método de pago y por mesero; rotación de platos (unidades, por día, participación, margen) con ingeniería de menú (Estrella, Caballo de batalla, Rompecabezas, Perro); estadísticas de reservas y no-shows; exportación a CSV. |
| Admin | Administración | Productos (precio, costo, si pasa por cocina), categorías, mesas y zonas, usuarios con PIN, y ajustes (nombre, moneda, impuesto, datos del ticket). |

## Cómo correrlo

Requiere **Node.js 22.13 o superior** (usa la base de datos SQLite que trae Node, sin instalaciones nativas).

```bash
npm install
npm start            # http://localhost:3000
npm run demo         # opcional: 30 días de ventas de ejemplo para ver los reportes
```

PIN de demostración (cámbialos en Administración → Usuarios): admin `1234`, caja `1111`, mesero `2222`, cocina `3333`.

Los datos quedan en `data/restaurante.db` (configurable con la variable `DATA_DIR`). Para respaldar, copia ese archivo.

## Configuración para Ecuador

Viene configurado de fábrica para Ecuador: dólares (`$17,00`), **IVA 15 % incluido** en los precios de la carta, hora de `America/Guayaquil` y RUC en el ticket. Caja y tickets muestran el desglose *Base imponible 15 %* + *IVA 15 %*. Todo se puede cambiar en Administración → Ajustes (por ejemplo, si prefieres que el IVA se sume al cobrar).

> Los tickets y pre-cuentas son comprobantes internos. La factura electrónica autorizada por el SRI es un paso posterior (ver "Próximos pasos").

## Usarlo en el restaurante

1. Instala el servidor en una computadora del local (o en la nube) y conecta todos los dispositivos a la misma red.
2. En cada celular o tablet abre `http://IP-DEL-SERVIDOR:3000` y usa "Agregar a pantalla de inicio" para instalarlo como app.
3. **Impresora de cocina:** conecta una impresora térmica de 80 mm a la computadora de cocina y déjala como predeterminada. Para que las comandas salgan sin el cuadro de diálogo, abre Chrome así:
   - Windows: `chrome.exe --kiosk-printing --app=http://localhost:3000`
   - Linux/Mac: `google-chrome --kiosk-printing --app=http://localhost:3000`

   Luego activa "Imprimir comandas automáticamente" en la pantalla de Cocina.
4. Para acceso desde fuera del local, publícalo detrás de HTTPS (por ejemplo Railway, Render o un VPS con Caddy). La instalación como app en celulares exige HTTPS fuera de `localhost`.

## Arquitectura

- `server/index.js`: API REST (Express) + tiempo real (Socket.IO). Autenticación por PIN con token y permisos por rol.
- `server/db.js`: esquema SQLite y datos iniciales. Migrable a PostgreSQL si el negocio crece a varias sucursales.
- `server/demo.js`: generador de datos de ejemplo.
- `public/`: interfaz (HTML, CSS y JavaScript sin paso de compilación), manifest y service worker de la PWA.

## Próximos pasos sugeridos

- Facturación electrónica con el SRI (comprobantes XML firmados con el certificado del RUC, directamente o mediante un proveedor autorizado).
- Inventario y recetas (descontar insumos por plato vendido).
- Impresión directa ESC/POS por red para varias estaciones (cocina, barra).
- Varias sucursales y respaldos automáticos en la nube.
