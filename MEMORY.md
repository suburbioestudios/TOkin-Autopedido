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

- **Versión en manifest:** `2.1.8` (la tanda v2.1.9 está sin commitear y NO
  bumpea el manifest todavía).
- **Rama:** `main`. Último commit pusheado: `fb9717c` (v2.1.7).
- El flujo por lotes está **arreglado en 2.1.8** y el cambio de cuenta de la
  tienda en **2.1.9 (sin commit)**; ver entradas abajo.

## Bitácora

### 2026-10-27 — v2.1.9: el AVISO de cantidades daba falsos positivos y el login del arnés mentía

- **Qué preguntó la usuaria:** durante el proceso vio «elementos con 1 unidad lo
  cual es imposible», líneas que «se van a cero» en la corrección del 2º paso y
  una **caída del total de compra justo al final**.
- **Respuesta medida (los tres casos NO son el mismo problema):**
  1. **Las líneas con 1 unidad son correctas.** En el PDF del pedido la columna
     que parece cantidad es *unidades por bulto* y la de al lado es *bultos*:
     `ARCOR CAR. RELLENOS MIEL 675 G | 6 | b | 1` = 6 caramelos por bulto × **1
     bulto** (el total lo confirma: 1 × $5.790,63 = $34.743,78). Ídem `BAGLEY
     ALF. TRIPLE BLANCO 73 G | 21 | b | 1`. La extensión lee bien el 1; el «6»/«21»
     es el contenido del envase. El diag lo deja explícito: `want=1 quedó=1 Bulto
     — ok sin re-set`.
  2. **Las líneas que van a 0 son quitados deliberados de `tokCorregirCarrito`
     (v2.0.98)**, no una pérdida: (a) el ítem quedó en OTRA unidad (bulto/display
     equivocados → la cantidad no sirve), o (b) el store no deja alcanzar la
     cantidad pedida (tope de stock / «máximo alcanzado» → no se deja nada
     parcial: sale del carrito y se reporta). En la corrida: `#7 AGUILA BAÑO
     REPOSTERO → 12 Unidad` corrijo y el store no lo aceptó → 0.
  3. **La caída del total al final es artefacto del dry-run.** El guard
     `DRY_GUARD` bloquea «Realizar pedido», así que el carrito del lote anterior
     NO se vacía solo como en la operación real; entonces la corrección del 2º
     paso saca esas filas como «ajenas» antes de cada checkout (`ítems fuera del
     carrito antes del checkout: 6/7/15 quitados`) y el total baja. En producción
     ese vaciado lo hace el propio pedido confirmado.
- **Bug real encontrado en el verificador de cantidades (AVISO):**
  `filasDe(exp)` (content.js, `tokVerifyPreCheckout`) caía al match **por nombre**
  cuando la línea tenía código ARC y ninguna fila mostraba ese código; con dos
  caramelos parecidos («RELLENOS MIEL 675 G» vs «MIEL Y MENTA 335 G») la línea
  se pegaba a la fila del OTRO producto y el grupo sumaba 2 contra 1 → AVISO
  falso («#22: el pedido pide 2 Bulto y el carrito muestra 1»). **Fix:** si la
  línea trae ARC y ninguna fila lo muestra, sólo se busca por nombre entre las
  filas **sin código** (o cuando la foto no trae ningún código); si no, se
  cuenta como «no aparece en el carrito». Nunca más la fila de otro ARC.
- **Paso de reescritura previa al checkout DESHABILITADO (`tokCorregirCarrito`):**
  La usuaria observó que, aunque la carga del carrito ya confirma cada cantidad
  contra el servidor (`tokCartSetQty` espera debounce + respuesta), el paso
  `tokCorregirCarrito` antes del checkout volvía a escribir en los inputs, lo
  que provocaba re-renders del store que reseteaban cantidades a 1, quitaban
  items a cero y hacían caer el total al final del checkout. **Fix:** se
  eliminó el llamado a `tokCorregirCarrito` en el flujo de checkout
  (content.js, paso `siguiente`). Se conserva `tokVerifyPreCheckout` como
  **solo lectura** (compara contra la foto del carrito / estado del server, que
  es la fuente de verdad per la regla de oro).
- **Bug del arnés que invalidó la corrida A→B→A (`tools/dry_run.mjs`):** el atajo
  «la tienda ya tiene sesión abierta» miraba el **texto** de la home
  (`/salir|mi cuenta|usuario/i`) y daba falso positivo con la tienda
  deslogueada. La sesión 2 (serhiy) nunca logueó y la tienda respondió cada
  búsqueda con `/store/pre-home-ingreso` (la página de ingreso/elección de
  vendedor, la misma a la que manda el logout): las 19 líneas del lote se
  abandonaron con «tope de búsquedas alcanzado». **Fix:** la única prueba de
  sesión válida es la URL `/store/home` (a donde la tienda manda al loguear; si
  estás deslogueado te deja en `/store` o `/pre-home-ingreso`), tanto en el
  atajo como en la confirmación post-login. También se subió el volcado de
  `[diag]` del arnés de 170 a 1200 caracteres para poder leer el AVISO completo.
- **Bloqueo externo:** la tienda quedó **inaccesible desde esta PC** al cerrar la
  entrada (`ERR_CONNECTION_TIMED_OUT` en `/store` y `/store/search`, y `Error 403
  Web Page Blocked / Attack ID 20000051` del WAF con Playwright headless). No se
  puede re-validar hasta que vuelva; los probes `tools/_store_anon_probe.mjs` y
  `tools/_waf_probe.mjs` quedan para chequearlo.
- **Estado:** los tres cambios (content.js, dry_run.mjs, MEMORY) **sin commit**;
  `extension/manifest.json` sigue en `2.1.8`. `node --check` OK en
  `extension/content.js` y `tools/dry_run.mjs`.

### 2026-10-26 — v2.1.9: segunda cuenta de la tienda no cargaba nada (sesión de carrito vieja)

- **Síntoma:** entrar con una cuenta, cargar un pedido por lotes, cambiar de
  cuenta en la tienda **sin cerrar el navegador** y volver a usar la herramienta:
  la segunda sesión mostraba el pedido de la cuenta anterior («30 de 38 en el
  carrito», lotes ya realizados) con el carrito de la cuenta nueva vacío, y
  terminaba `done` al instante sin cargar ni un solo `item=`.
- **Causa raíz:** `runParse()` (offscreen) no reseteaba la sesión de carrito.
  `state.cartApi`, `state.cart`, `state.cartProgress`, `state.lotChecks`,
  `state.cartIsManual`, `state.manualRun` y `state.checkoutLote` sobrevivían en
  `chrome.storage.session`; `runCart()` veía `nextOrig >= orderTotal` y llamaba
  a `finPedido()` sin despachar ningún bloque. Además, los mensajes tardíos del
  pedido anterior compartían `batchIdx` (ambos pedidos arrancan en 0..18), así
  que no había forma de distinguirlos de los del pedido nuevo.
- **Fix (sin commitear todavía, comentarios `// v2.1.9:`):**
  - `offscreen.js`: `resetCartSession()` se llama desde `runParse()`; identidad
    de sesión `cartRunToken` (persistida/restaurada); `staleRun(msg)` descarta
    `CART_PROGRESS`/`CART_STOP`/`CART_PAUSE`/`CART_DONE`/`CHECKOUT_DONE` de otro
    pedido; `runToken` viaja en `ADD_TO_CART`/`CHECKOUT_BATCH`; `resetState()`
    limpia token, `checkoutLote`, `allAttempted` y el timer;
    `tryRecoverReport`/`restoreSession` solo aplican el reporte si su `runToken`
    es el de la sesión viva.
  - `offscreen.js` (cadena entre lotes): al volver de `/store/home` el content
    script puede tardar en re-inyectarse (tienda lenta) y el `ADD_TO_CART` del
    lote siguiente fallaba con «Presioná F5…» (`Receiving end does not exist`);
    `runCart` lo tomaba como error y la cadena se detenía. Ahora reintenta el
    envío hasta 10 veces cada 3 s **solo** para fallos de conexión; si el lote
    ya está corriendo en el content («Ya hay una carga de carrito en curso») lo
    da por despachado. Pestaña ausente o error real del store no se reintentan.
  - `background.js`: handler `RESET_CART_SESSION` (mata el job por token y marca
    `CART_CANCEL_KEY="stop"` **antes** de borrar job/reporte/checkout, y recién
    después avisa `TOKIN_KILL` a las pestañas); relay del `runToken` en
    `ADD_TO_CART`.
  - `content.js`: `tokProgress` y el job llevan `runToken`; `CART_DONE`/
    `CART_STOP`/`CART_PAUSE`/`CHECKOUT_DONE` lo transportan; `tokCheckoutStart`
    lo persiste y **todos** los `tokCheckoutDone(...)` lo pasan (incluido el
    camino de error interno vía `errRunToken`); el reporte `tokinCartReport`
    guarda `runToken`.
  - `popup.js`: `syncFromJob` considera `parsing`/`parsed` como sesión viva y
    descarta el reporte si su `runToken` no es el de la sesión viva;
    `maybeRestoreRunningTask` valida la propiedad **antes** de aplicar el backup
    (ni a la UI ni como tarea recuperada).
- **Validación (harness `tools/dry_run.mjs`, extendido con `--sesion2=mail:clave
  --vuelta --logout --keep-profile`, 2 bloques de 19 líneas por sesión):**
  - Corrida 1 (`--watch 40`, perfil 3): sesión 1 druettaf `done` con
    `lotChecks={"1":true,"2":true}`; sesión 2 serhiy cargó el bloque 1, hizo su
    checkout y siguió con el bloque 2 (cortada a los 40 min por el límite del
    harness, no por la extensión); sesión 3 druettaf volvió a cargar 2 bloques +
    2 checkouts. El bug de «done al instante» **no reapareció**.
  - Corrida 2 (`--watch 85`, perfil 4): sesiones 1 y 3 `done` con
    `lotChecks={"1":true,"2":true}`; la sesión 2 arrancó de cero (`lotChecks={}`,
    `nextOrig=19`) y se cortó por el watchdog de inmovilidad del harness: la
    línea 4/19 se quedó 5 min esperando la segunda búsqueda del store.
  - Corrida 3 (cuenta B sola, `--watch 120 --stall 20 --line-stall 20`, perfil 7):
    antes del retry se cortó con «Presioná F5…» al despachar el lote 2 (la
    pestaña volvía a `/store/home` y el content script todavía no estaba
    inyectado). **Con el retry: `done`, `lotChecks={"1":true,"2":true}`,
    `nextOrig=38/38`, dos `lote checkout ok=true` y un único `cartRunToken`
    (`1793062964014-877981842`) para los dos lotes.** Evidencia de que el
    reintento tomó el ADD_TO_CART en `/store/home` y siguió con el lote 2.
  - `node --check` OK en `content.js`, `background.js`, `popup.js`,
    `offscreen.js`, `tools/dry_run.mjs`. El checkout del harness NO envía el
    pedido: `DRY_GUARD` bloquea «Realizar pedido» y la extensión marca el lote
    con `__TOKIN_DRY_BLOCKED__`.
  - Corrida 4 (validación final A→B→A con retry): la sesión 1 (druettaf) salió
    `done` con `lotChecks={"1":true,"2":true}`, pero la corrida **quedó
    invalidada por un bug del arnés** (ver la entrada del 2026-10-27): la sesión
    2 no logueó y la tienda mandó todas las búsquedas a `/store/pre-home-ingreso`.
- **Harness:** `clearStoreCart` reintenta el `goto` a `/store/checkout/cart`
  (2×45 s y, como último recurso, `waitUntil:"commit"` + espera del selector de
  filas). La tienda venía colgando ese `DOMContentLoaded` 90 s y la corrida
  moría antes de empezar. `login()` además espera hasta 30 s el campo de email
  y recarga `/store/login` dos veces si el formulario no se hidrata; y si el
  perfil conservado ya viene logueado (`--keep-profile`), lo detecta y sigue sin
  buscar el formulario. Con `--logout` se cierra la sesión del store **también
  antes de la 1ª sesión**, para no arrancar con la cuenta de la corrida anterior.
- **Archivos:** `extension/offscreen/offscreen.js`, `extension/background.js`,
  `extension/content.js`, `extension/popup/popup.js`, `tools/dry_run.mjs`.
  `extension/manifest.json` **sigue en 2.1.8** (no se bumpea hasta que el
  usuario lo pida).

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

- **v2.1.9 (cambio de cuenta):** validación final A→B→A con el retry en curso
  (`diag_sesiones_retry.log`, perfil `tokin-sesion-3x-retry`). Tiene que dar las
  3 sesiones `done` con `lotChecks={"1":true,"2":true}` y 2 checkouts cada una.
- Vaciar los carritos de prueba por cuenta con `--vaciar` (el de serhiy quedó con
  ~28 líneas y el de druettaf con ~25 tras las corridas de 3 sesiones).
- Commitear/pushear la tanda cuando el usuario lo pida (incluye `MEMORY.md`);
  decidir ahí si el manifest pasa a 2.1.9.
- Repasar si quedan otros puntos de mensajería offscreen↔sw↔content con
  `sendResponse` diferido sin `return true` (auditoría rápida ya hecha: no había
  más en el listener del content).
