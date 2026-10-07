# AGENTS.md

Guía para agentes que trabajan en **Tokin AutoPedido**, la extensión de Chrome
(MV3) que carga pedidos de Excel/PDF/DOCX en el carrito de
`https://tokintienda.com.ar/store`. 100% local: los datos del pedido nunca salen
de la PC del usuario. Uso interno, solo para usuarios autorizados.

## Estructura

- `extension/` — la extensión en sí (cargar descomprimida desde Chrome:
  `chrome://extensions` → Modo desarrollador → "Cargar descomprimida" →
  seleccionar esta carpeta).
  - `content.js` (~4800 líneas, el 100% de la lógica) — script de contenido que
    corre en `https://tokintienda.com.ar/store/*`.
  - `manifest.json` — la VERSIÓN vive acá. Se sube SOLO cuando el usuario lo pide
    (está podrido de decenas de versiones).
  - `background.js`, `popup/` — orquestación (offscreen, watchdog, reporte).
- `tools/` — script de prueba con Playwright contra la tienda REAL (nunca
  envían el pedido: guard que bloquea "Realizar pedido"). No van al usuario.
  - `tools/dry_run.mjs` — el harness principal (login + parseo + carga + checkout
    en seco). Cuenta de prueba: `druettaf@gmail.com` / `Tresd650`.
  - `tools/_*.mjs` — probes/a tornillos de diagnóstico (de un solo uso).

## Datos duros de la tienda (medidos, no suposiciones)

- El input de cantidad usa `data-id="quantity-selector-input"` + `input[type=number]`.
  Antibusea con un **debounce de 1000 ms ANTES de mandar `updateCart`** al
  server, y cualquier re-render (respuesta de otra mutación en vuelo, refetch
  `getCart`) **resetea el input al valor previo y CANCELA el updateCart
  pendiente**. Leer el input a los ~700 ms es óptimismo del DOM: la extensión
  podía decir "4 verificado" con el server en 1.
- Selectores del carrito: `article[data-id=cart-product-card]`,
  `[data-id^=unit-size-ARC-]` (código del ítem), `[data-id=navbar-minicart-button]`
  (abrir drawer), `[data-id=minicart-close-drawer-button]`,
  `[data-id=go-to-checkout-buton]` ("Revisar pedido"), `[data-id=next-step-button]`,
  `[data-id=place-order-button]`.
- Login: la tienda redirige `/store/login` → `/store/home`; botones de modo
  `[data-id=login-with-password]` / `login-with-key`, pasos
  `[data-id=email-next-buton]` y `[data-id=password-next-button]`.
- `/store/checkout/payment` **NO lista los productos** (solo "Resumen"). La única
  página con las filas + cantidad es `/store/checkout/cart` (o el drawer). Por
  eso la foto de cantidades se toma en una y se compara en la otra.

## Regla de oro

**La cantidad se verifica contra el estado sincronizado con el server, nunca
contra la lectura óptima del DOM.** `tokCartSetQty` (content.js) espera el
debounce completo + respuesta antes de confirmar; los veredictos salen de ese
valor, y el pre-checkout (`tokCorregirCarrito`) corrige las cantidades y saca
del carrito lo que no corresponde (unidad equivocada o ítem ajeno) antes de
confirmar.

## Validación

- Sintaxis: `node --check extension/content.js` (y `background.js`).
- Corrida en seco contra la tienda real:
  `node tools/dry_run.mjs --full --limit N --no-checkout --pdf "<ruta-al-pdf>"`
  (el checkout real lo bloquea el guard; el reporte final queda en
  `tools/_dry_run_report.json`).
- Reproducción de la carrera de cantidad (agregar y escribir sin esperar el add):
  `node tools/_qty_race_probe.mjs`. Debe terminar con el carrito en la cantidad
  correcta tras el reload.
- SDK del store (ingeniería inversa) descargado en `%TEMP%\opencode\tokjs`.

## Convenciones

- Comentarios extensos EN ESPAÑOL en content.js, con el `// vX.Y.Z:` que motivó
  cada cambio. Mantenerlos.
- No agregar código sin el comentario de motivo; no borrar historia útil.
- No committear salvo que el usuario lo pida explícitamente.
- Entorno: Windows / PowerShell (sin `&&`; encadenar con `;` y `if ($?)`).