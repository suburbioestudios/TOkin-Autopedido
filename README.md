# TOkin-Autopedido

Lista de usuarios autorizados y distribución de la extensión **Tokin AutoPedido**.

## Qué es

La extensión de Chrome **Tokin AutoPedido** rellena automáticamente el
formulario de pedido de `tokintienda.com.ar/store` a partir de un archivo
Excel/CSV/PDF/DOCX. Funciona 100% en el navegador: los datos del pedido nunca
salen de la PC del usuario.

## Lista de usuarios (`allowed_users.json`)

- La extensión lee este archivo desde
  `raw.githubusercontent.com/suburbioestudios/TOkin-Autopedido/main/allowed_users.json`
  y cachea la lista 24 h en cada PC.
- Solo los emails listados pueden usar la herramienta. Sin internet y sin copia
  guardada, el acceso se deniega.
- **Para agregar/quitar colegas**: editar este archivo (ícono de edición → commit
  en `main`). La extensión solo lee; no sube datos.

## Instalación de la extensión

1. **Code → Download ZIP** y descomprimirlo.
2. `chrome://extensions` → activar **Modo desarrollador** → **Cargar descomprimida**.
3. Seleccionar la carpeta `extension`.
4. Iniciar sesión en `https://tokintienda.com.ar/store` con un email autorizado y
   usar el popup para cargar el pedido.
