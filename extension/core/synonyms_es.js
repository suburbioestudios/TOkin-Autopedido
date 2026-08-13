// Diccionario de conceptos -> sinonimos (normalizados: minusculas, sin acentos).
// Portado de server/synonyms_es.py.
export const SYNONYM_GROUPS = {
  cliente: [
    "cliente", "nombre y apellido", "nombre y apellidos", "nombre", "apellido",
    "razon social", "razonsocial", "cuenta", "comprador", "empresa", "negocio",
    "denominacion", "titular", "nombre del cliente", "nombre cliente",
  ],
  direccion: [
    "direccion", "domicilio", "calle", "calle y numero", "calle y nro",
    "direccion de entrega", "domicilio de entrega", "envio a", "entregar en",
    "direccion de envio", "lugar de entrega", "punto de entrega", "dato de entrega",
  ],
  localidad: ["localidad", "ciudad", "poblacion", "partido", "distrito", "municipio"],
  provincia: ["provincia", "region", "estado", "departamento"],
  codigo_postal: ["codigo postal", "cp", "cod postal", "zip", "codigo zip"],
  telefono: [
    "telefono", "tel", "celular", "cel", "movil", "whatsapp", "contacto",
    "telefono de contacto", "numero de telefono", "telefono de entrega",
  ],
  email: [
    "email", "e-mail", "mail", "correo", "correo electronico", "email de contacto",
  ],
  fecha: [
    "fecha", "fecha de entrega", "fecha de pedido", "dia de entrega",
    "fecha despacho", "fecha de despacho", "fecha prevista", "entrega",
  ],
  fecha_pedido: ["fecha de pedido", "fecha pedido", "dia del pedido"],
  horario: [
    "horario", "hora", "horario de entrega", "franja horaria", "hora de entrega",
  ],
  comentarios: [
    "comentarios", "observaciones", "notas", "referencias", "comentario",
    "nota", "detalle", "informacion adicional",
  ],
  vendedor: [
    "vendedor", "vendedora", "agente", "representante", "vendedor asignado",
    "ejecutivo de cuenta",
  ],
  condicion_pago: [
    "condicion de pago", "condiciones de pago", "forma de pago", "medio de pago",
    "tipo de pago", "pago", "plazo de pago", "cuenta corriente",
  ],
  nro_pedido: [
    "numero de pedido", "nro pedido", "n de pedido", "pedido nro", "numero pedido",
    "orden de compra", "nro de orden", "oc", "referencia de pedido",
  ],
  nro_documento: [
    "numero de documento", "nro documento", "documento", "dni", "cuit", "cuil",
    "nro de factura", "numero de factura", "factura",
  ],
  sku: [
    "sku", "codigo", "cod", "codigo de articulo", "codigo articulo", "codigo producto",
    "cod producto", "articulo", "producto codigo", "id producto", "codigo interno",
    "codigo de producto", "codigo de barras", "barras", "gtin", "ean", "upc",
  ],
  producto: [
    "producto", "descripcion", "descripcion del producto", "articulo", "descripcion articulo",
    "nombre del producto", "nombre producto", "productos", "detalle", "descripcion corta",
    "titulo", "item", "concepto",
  ],
  cantidad: [
    "cantidad", "cant", "unidades", "uds", "qty", "cantidad por caja", "paquetes",
    "bultos", "cajas", "numero de cajas", "total cajas",
  ],
  precio: [
    "precio", "precio unitario", "precio venta", "costo", "importe unitario",
    "p.u.", "precio sin iva", "precio neto",
  ],
  importe: [
    "importe", "importe total", "total", "subtotal", "total linea", "total por linea",
    "importe x linea", "monto", "valor total",
  ],
  porcentaje_descuento: [
    "descuento", "porcentaje de descuento", "dcto", "bonificacion", "boni",
    "descuento 1", "descuento 2",
  ],
  marca: ["marca", "fabrica", "fabricante", "linea", "rubro"],
  medida: [
    "unidad de medida", "um", "u.m", "u.m.", "medida", "presentacion", "formato", "unidad",
    "bulto", "bultos", "display", "disp", "pack", "packs", "paquete", "envase",
  ],
};

// Conceptos especiales para detectar lineas de pedido.
export const QTY_CONCEPTS = new Set(["cantidad", "medida"]);
export const SKU_CONCEPTS = new Set(["sku", "nro_pedido"]);
export const PRICE_CONCEPTS = new Set(["precio", "importe"]);
export const PRODUCT_CONCEPTS = new Set([
  "sku", "producto", "cantidad", "medida", "precio", "importe", "marca", "porcentaje_descuento",
]);

export const CURRENCY_SYMBOLS = ["$", "usd", "ars", "u$s", "s/"];
