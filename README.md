# TOkin-Autopedido

Distribución de la extensión **Tokin AutoPedido**.

## Qué es

La extensión de Chrome **Tokin AutoPedido** rellena automáticamente el
formulario de pedido de `tokintienda.com.ar/store` a partir de un archivo
Excel/CSV/PDF/DOCX. Funciona 100% en el navegador: los datos del pedido nunca
salen de la PC del usuario.

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
