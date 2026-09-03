# Tokin AutoPedido

Extensión de Chrome (MV3) **100% en el navegador** (sin servidor, sin Python, sin
APIs externas) que carga pedidos en `https://tokintienda.com.ar/store` desde
archivos **Excel (xlsx/xls), CSV, PDF y DOCX**. Extrae las líneas del pedido y
las **agrega al carrito del store**, eligiendo Unidad/Display/Bulto según el
archivo. Los datos del pedido **nunca salen de tu PC**; solo se consulta una
lista pública de emails autorizados.

## Qué hace

1. Subís un archivo con el pedido: tocá la zona del popup (o arrastrá el archivo
   encima). Se abre el selector de archivos del sistema y el archivo se procesa
   **en tu navegador**.
2. La extensión extrae pares clave-valor (cliente, dirección, fecha, teléfono) y
   **líneas de pedido** (SKU / producto / cantidad / unidad). Formatos: XLSX/XLS
   y CSV con [SheetJS](https://sheetjs.com), DOCX con [mammoth](https://mammoth.in),
   PDF con [pdf.js](https://mozilla.github.io/pdf.js/) (texto y, para escaneados,
   OCR con Tesseract incluyendo rotación automática).
3. **Mapea automáticamente** las claves del archivo a conceptos usando el
   diccionario de sinónimos en español y la **memoria de mapeo** (guardada en
   `chrome.storage.local`, por fingerprint estructural del documento).
4. Revisás las **Líneas** (tabla de solo lectura) y hacés click en
   **Enviar a carrito**.
5. La extensión, sobre la página del store, procesa el pedido en **lote
   resumible**: por cada línea navega directamente al buscador del store
   (`/store/search?q=...`), elige la mejor tarjeta de producto por **gramaje +
   texto + unidad** pedida, selecciona **Unidad/Display/Bulto** según el archivo
   (b/d/u), fija la cantidad y agrega al carrito. La página del store muestra un
   aviso con el avance; el lote se puede **cancelar** en cualquier momento.
6. Al terminar (o cancelar), el popup muestra el **diagnóstico** con el resultado
   de la carga: "Pedido cargado en el carrito: X de Y" (o "Carga cancelada:
   X de Y") más el detalle línea por línea (agregado / encontrado sin stock /
   no encontrado). Si cancelaste, el botón **Enviar a carrito** vuelve a quedar
   disponible para reintentar.
7. El botón **Reanudar** vacía el carrito del store y, si hay una tarea
   pausada/viva, la relanza desde cero (re-carga todo el pedido); si no hay
   tarea, solo deja el formulario limpio.

## Requisitos

- Windows 10/11, Google Chrome.

## Instalación

1. Descargá el código (botón **Code → Download ZIP** de
   https://github.com/suburbioestudios/TOkin-Autopedido y descomprimilo).
2. Abrí `chrome://extensions` en Chrome, activá **Modo desarrollador** y hacé
   click en **Cargar descomprimida**. Seleccioná la carpeta `extension`.
   La extensión aparece como "Tokin AutoPedido".

## Uso diario

1. Iniciá sesión en `https://tokintienda.com.ar/store` con tu usuario autorizado.
2. Click en el icono de la extensión → soltá el archivo (o tocá la zona) →
   revisá las líneas → **Enviar a carrito** → esperá el diagnóstico → confirmá
   en el carrito del store.

> La verificación por WhatsApp/SMS tras el login se hace manualmente en Chrome.

## Acceso exclusivo (lista remota)

- El popup solo habilita la herramienta si el email de la sesión logueada está
  en `allowed_users.json` del repo **`suburbioestudios/tokin-users`** (emails en
  **texto plano**; campo `allowed_emails` o un array plano). Se lee de
  `raw.githubusercontent.com`, se cachea **24 h** y sin internet ni copia guardada
  se deniega el acceso.
- Para **agregar/quitar colegas**, el administrador edita `allowed_users.json`
  en `suburbioestudios/tokin-users` (icono de edición → commit). La extensión
  solo lee la lista; los datos de pedidos nunca se suben.

## Estructura

```
extension/           → extensión de Chrome (MV3)
├─ manifest.json     → permisos: storage/tabs/scripting/offscreen; hosts: tokin + GitHub
├─ background.js     → service worker (orquestación, puente al main world del store)
├─ content.js        → lote resumible de carga al carrito + matcher por gramaje/unidad
├─ offscreen/        → documento oculto: parseo de archivos y ejecución del lote
├─ core/             → motor portado a JS (ES modules)
│  ├─ agent.js       → parseo (xlsx/csv/docx/pdf/ocr), mapeo y fingerprint SHA-256
│  ├─ synonyms_es.js → sinónimos de conceptos en español
│  ├─ normalize.js   → normalización, fechas, cantidades, medida b/d/u
│  ├─ memory.js      → memoria de mapeo en chrome.storage.local
│  └─ access.js      → lista remota tokin-users (emails en claro) + caché 24 h
├─ lib/              → librerías empaquetadas localmente (sin CDN)
└─ popup/            → UI (dropzone, líneas, enviar a carrito, diagnóstico)
```

## Notas técnicas

- **Seguridad**: nada del pedido sale de la PC. El login del store lo hacés vos
  en Chrome; la extensión solo lee `localStorage.currentEmail` para saber quién
  sos. Lo único que se descarga es la lista pública de emails autorizados.
- **Mapeo**: coincidencia por diccionario de sinónimos (contención difusa) y
  memoria por "fingerprint" estructural del documento (headers + claves, sin
  valores), para reutilizarla entre pedidos del mismo tipo.
- **Matcher del store**: la búsqueda por línea se construye como SKU primero y,
  si no hay resultado, por el nombre limpiado (el gramaje se extrae de la línea,
  ej. `18x40g` → `40g`). De los resultados se elige la tarjeta que mejor
  coincide por gramaje + texto + la unidad pedida.
- **Unidades**: el archivo indica `b`/`B` (Bulto), `d`/`D` (Display) o
  `u`/`ud`/`unidad` (Unidad); la extensión elige ese botón de unidad en el store.
- **Lote resumible**: el progreso se guarda en `chrome.storage.local`, de modo
  que el lote sobrevive a la navegación entre búsquedas y se puede cancelar en
  cualquier punto. La cancelación deja un aviso de diagnóstico con lo parcial.
- **React**: las interacciones con la página disparan el setter nativo del
  prototipo + eventos `input/change/blur`, que es lo que requiere Next.js para
  actualizar su estado.
- **CSP del store**: bloquea scripts inline, por eso el puente al main world se
  inyecta con `chrome.scripting.executeScript({world: "MAIN"})` y la
  comunicación con el content script aislado se hace por `window.postMessage`.
- **PDFs escaneados** necesitan OCR (Tesseract local, con rotación automática) y
  **tablas muy irregulares** pueden requerir un renglón manual en el store.
  El PDF es el formato más débil sin Python.

