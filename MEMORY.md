# MEMORY.md — bitácora de trabajo

> **LEER SIEMPRE ANTES DE EMPEZAR.** Este archivo es la memoria del proyecto:
> qué se hizo, dónde quedó y qué falta. Antes de tocar nada, leé esto y el último
> `git log --oneline -10`. Al terminar una tanda de trabajo, ACTUALIZÁ esta
> bitácora (fecha, qué se hizo, versión, estado, próximo paso) y commiteala junto
> con el cambio. Mantené las entradas más nuevas arriba.

## Qué es esto

Tokin AutoPedido: extensión Chrome MV3 que carga pedidos (Excel/PDF/DOCX) en el
carrito de `https://tokintienda.com.ar/store` y confirma el pedido **por bloques
de 19 líneas** lote a lote. 100% local. Detalles de estructura, datos duros de la
tienda y convenciones: ver `AGENTS.md`. Este archivo es solo la **bitácora**.

## Reglas operativas (repaso rápido)

- Windows / PowerShell 5.1: nada de `&&`; encadenar con `;` y `if ($?)`. No hay
  `python`, `py`, `tail`. Usar `node`. Scripts de prueba en `.mjs` (no `.cjs`).
- Flags del harness se parsean con `=`: `--lotes=3` (con `--lotes 3` NO funciona).
- El harness `--full` corre el checkout REAL pero el guard `DRY_GUARD` bloquea el
  click final de «Realizar pedido» (marca `__TOKIN_DRY_BLOCKED__`).
- El PDF default del harness no existe: pasar siempre `--pdf` con uno real (ej.
  `..\PEDIDO ARCOR ADROGUE 19 OCT.pdf`).
- Login de prueba: `druettaf@gmail.com` / `Tresd650`.
- No se suben: `.xlsx` de salida, probes `tools/_*.mjs`, `tools/_dry_run_report.json`.
  Sí se sube: `extension/` y `tools/dry_run.mjs`.
- La versión vive en `extension/manifest.json` y se sube SOLO cuando el usuario
  lo pide. Registrar en la bitácora a qué versión corresponde cada tanda.

## Estado actual

- **Versión en manifest:** `2.1.8` (commit pendiente de esta tanda).
- **Rama:** `main`. Último commit pusheado: `fb9717c` (v2.1.7).
- El flujo por lotes está **roto→arreglado en 2.1.8**: ver entradas abajo.

## Bitácora

### 2026-10-22 — v2.1.8: arreglo del corte de la cadena de lotes (message channel closed)

- **Síntoma:** tras `volver` en `/store/home` (fin del lote 1), el harness marcaba
  `status=error` con `A listener indicated an asynchronous response by returning
  true, but the message channel closed before a response was received`, y la
  cadena **no arrancaba el lote 2**.
- **Causa raíz (content.js, listener de `chrome.runtime.onMessage`):** el caso
  `ADD_TO_CART` disparaba `tokCartStart(...).then(sendResponse)` (asíncrono, la
  carga navega por cada búsqueda) pero terminaba en `break` en vez de
  `return true`. El canal se cerraba antes de la respuesta → el background lo
  propagaba como fallo del bloque → el offscreen cortaba la cadena.
- **Fix:** `return true` en el caso `ADD_TO_CART` de `content.js` (canal abierto
  hasta el `sendResponse` real). Se agregó el comentario `// v2.1.8:` explicando
  el motivo. No había otros `sendResponse` diferidos sin `return true` en ese
  listener (`EMPTY_CART`/`SHOW_PICKER` ya lo tenían; el resto es síncrono).
- **Archivos:** `extension/content.js`, `extension/manifest.json` (2.1.7 → 2.1.8).
- **Validación:** `node --check` OK en `content.js`/`offscreen.js`/`background.js`/
  `popup.js`. Corrida `node tools/dry_run.mjs --full --lotes=3 --limit 40 --pdf
  "..\PEDIDO ARCOR ADROGUE 19 OCT.pdf"`: secuencia limpia
  `lote 1 → lote 2 → lote 3 pedido realizado` (y retomada `1 → 2 → 3`) **sin
  ninguna** ocurrencia de `message channel` / `listener indicated`. Carrito de
  prueba limpiado luego con `--vaciar`.
- **Nota:** el shell cortó por timeout a los 25 min porque el harness siguió
  hasta un 4º lote (`--limit 40`); NO fue un fallo del flujo.

### 2026-10-21 — v2.1.7: no frenar el pedido si un checkout se traba

- Si un bloque no avanza en el checkout, la extensión **espera indefinidamente**
  la confirmación manual (tope 24h), muestra un toast pidiéndola, detecta la
  señal de «pedido realizado», marca el lote OK y sigue con el siguiente.
- `tokConfirmedSignal` / `tokWaitManualConfirm` en `content.js`; el timeout
  general de 12 min queda EXCEPTUADO para el paso `confirmar`.
- `offscreen.js`: `continueAfterCheckout(degraded=true)` ya no frena; en fallo de
  despacho se retrocede `nextOrig`/`retryIdx` para reencolar el bloque.
- Commit `fb9717c`, pusheado a `origin/main`.
- Validado en seco: la extensión llega al checkout real, el guard bloquea el
  click final y `confirmar` detecta la señal del guard y sigue.

### Anteriores

- **v2.1.6** (`0803745`): el popup marca PEDIDO REALIZADO solo con
  `lotChecks=true` explícito y no cancelado (evita falso positivo).
- **tools** (`0b45495`): OCR de pedidos ARCOR (pdf.js + Tesseract) y generador de
  XLSX por bloques de 19.
- **v2.1.5** (`db395a0`): selecciona «Pago contra entrega» en `/checkout/payment`.
- **v2.1.4** (`b260833`): cantidad verificada contra el server (debounce 1000 ms +
  respuesta antes de confirmar) y corrección del carrito antes del checkout.

## Próximo paso / pendientes

- Commitear y pushear esta tanda (v2.1.8 + `MEMORY.md` + sección de memoria en
  `AGENTS.md`).
- Repasar si quedan otros puntos de mensajería offscreen↔sw↔content con
  `sendResponse` diferido sin `return true` (auditoría rápida ya hecha: no había
  más en el listener del content).
