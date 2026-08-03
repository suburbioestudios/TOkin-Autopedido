# TOkin-Autopedido

Distribución de la extensión **Tokin AutoPedido**.

## Qué es

La extensión de Chrome **Tokin AutoPedido** carga automáticamente un pedido en el
carrito de `tokintienda.com.ar/store` a partir de un archivo Excel/CSV/PDF/DOCX.
Funciona 100% en el navegador: los datos del pedido nunca salen de la PC del
usuario.

## Acceso

- El control de acceso vive en el repo separado **`suburbioestudios/tokin-users`**
  (lista de huellas SHA-256 de emails autorizados; los emails no se publican).
- Solo el administrador concede o quita acceso editando `allowed_users.json` allí.
- La extensión lee esa lista, la cachea 24 h en cada PC y deniega el acceso sin
  internet y sin copia guardada.

## Instalación de la extensión

1. **Code → Download ZIP** y descomprimirlo.
2. `chrome://extensions` → activar **Modo desarrollador** → **Cargar descomprimida**.
3. Seleccionar la carpeta `extension`.
4. Iniciar sesión en `https://tokintienda.com.ar/store` con un email autorizado y
   usar el popup para cargar el pedido.

## Uso diario

1. Logueado en el store con un email autorizado, abrir el popup de la extensión.
2. Soltar el archivo del pedido y **Generar mapeo**.
3. Revisar las **Líneas** (solo lectura) y click en **Cargar al carrito**.
4. La extensión busca cada producto, elige Unidad/Display/Bulto según el archivo,
   fija la cantidad y agrega. Al terminar se abre el carrito del store: la
   confirmación final se hace ahí, en el sitio.

## Pruebas (desarrolladores)

- `tools\test_engine.py`: lanza Chrome con la extensión cargada (vía CDP) y
  verifica parseo de XLSX/CSV/DOCX/PDF, líneas de pedido, fingerprint y mapeo.
- `tools\probe_cart_*.py`: pruebas de la carga al carrito en el store real.
