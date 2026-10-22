/**
 * Backend de "Lector de Boletas" (Google Apps Script, cuenta dueña de la carpeta en Drive).
 *
 * - Lee boletas/facturas (JPG, PNG o PDF) con Claude (API de Anthropic). La clave queda oculta
 *   en las Propiedades del script; nunca llega al navegador ni a GitHub.
 * - Guarda los datos en la planilla "Boletas" y una copia del archivo en la carpeta
 *   "Lector de Boletas/Archivos" de Google Drive.
 *
 * Propiedades del script (Configuración del proyecto > Propiedades del script):
 *   ANTHROPIC_API_KEY  (obligatoria)
 *   MODELO             (opcional, por defecto claude-haiku-5-5)
 *   LIMITE_DIARIO      (opcional, por defecto 100 lecturas por día)
 *   CARPETA_ID, ARCHIVOS_ID, SHEET_ID  (se crean solas al ejecutar `inicializar`)
 */

const NOMBRE_CARPETA = 'Lector de Boletas';
const NOMBRE_PLANILLA = 'Boletas';
const COLUMNAS = ['Fecha registro', 'Fecha boleta', 'Empresa', 'RUT emisor', 'Tipo documento', 'Folio',
  'Neto', 'IVA', 'Total', 'Link archivo', 'Advertencias'];
const MODELO_POR_DEFECTO = 'claude-haiku-5-5';
const LIMITE_POR_DEFECTO = 100;
const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** Ejecutar UNA vez desde el editor: autoriza permisos y crea la carpeta y la planilla en Drive. */
function inicializar() {
  const d = destino_();
  Logger.log('Carpeta: ' + d.carpeta.getUrl());
  Logger.log('Planilla: ' + d.libro.getUrl());
  Logger.log('Clave de Anthropic configurada: ' + (prop_('ANTHROPIC_API_KEY') ? 'sí' : 'NO (agrega ANTHROPIC_API_KEY)'));
}

function prop_(nombre) {
  return PropertiesService.getScriptProperties().getProperty(nombre);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.accion) {
      case 'ping': return json_({ok: true, datos: estado_()});
      case 'ultimas': return json_({ok: true, datos: ultimas_(10)});
      default: return json_({ok: false, error: 'acción desconocida: ' + p.accion});
    }
  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  }
}

function doPost(e) {
  try {
    const cuerpo = JSON.parse(e.postData.contents);
    switch (cuerpo.accion) {
      case 'extraer': return json_({ok: true, datos: extraer_(cuerpo)});
      case 'guardar': return json_({ok: true, datos: guardar_(cuerpo)});
      default: return json_({ok: false, error: 'acción desconocida: ' + cuerpo.accion});
    }
  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  }
}

// ---------------------------------------------------------------- Drive

/** Carpeta, subcarpeta de archivos y planilla; las crea la primera vez (con bloqueo para no duplicar). */
function destino_() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let carpeta = porId_(props.getProperty('CARPETA_ID'), DriveApp.getFolderById);
    if (!carpeta) {
      carpeta = DriveApp.createFolder(NOMBRE_CARPETA);
      props.setProperty('CARPETA_ID', carpeta.getId());
    }
    let archivos = porId_(props.getProperty('ARCHIVOS_ID'), DriveApp.getFolderById);
    if (!archivos) {
      archivos = carpeta.createFolder('Archivos');
      props.setProperty('ARCHIVOS_ID', archivos.getId());
    }
    let libro = porId_(props.getProperty('SHEET_ID'), SpreadsheetApp.openById);
    if (!libro) {
      libro = SpreadsheetApp.create(NOMBRE_PLANILLA);
      DriveApp.getFileById(libro.getId()).moveTo(carpeta);
      const hoja = libro.getSheets()[0];
      hoja.setName(NOMBRE_PLANILLA);
      hoja.appendRow(COLUMNAS);
      hoja.setFrozenRows(1);
      hoja.getRange(1, 1, 1, COLUMNAS.length).setFontWeight('bold').setBackground('#e8eef7');
      hoja.getRange('G:I').setNumberFormat('$#,##0');
      props.setProperty('SHEET_ID', libro.getId());
    }
    // Montos con punto de miles y fechas chilenas.
    if (libro.getSpreadsheetLocale() !== 'es_CL') libro.setSpreadsheetLocale('es_CL');
    return {carpeta: carpeta, archivos: archivos, libro: libro, hoja: libro.getSheetByName(NOMBRE_PLANILLA)};
  } finally {
    lock.releaseLock();
  }
}

function porId_(id, abrir) {
  if (!id) return null;
  try {
    const obj = abrir(id);
    return obj.isTrashed && obj.isTrashed() ? null : obj;
  } catch (err) {
    return null;
  }
}

function estado_() {
  const d = destino_();
  return {
    carpeta_url: d.carpeta.getUrl(),
    planilla_url: d.libro.getUrl(),
    ia: !!prop_('ANTHROPIC_API_KEY'),
    uso_hoy: usoHoy_(),
    limite_diario: limite_(),
  };
}

function ultimas_(n) {
  const hoja = destino_().hoja;
  const total = hoja.getLastRow() - 1;
  if (total <= 0) return [];
  const desde = Math.max(2, hoja.getLastRow() - n + 1);
  const filas = hoja.getRange(desde, 1, hoja.getLastRow() - desde + 1, COLUMNAS.length).getDisplayValues();
  return filas.reverse().map(f => ({
    registro: f[0], fecha: f[1], empresa: f[2], rut: f[3], tipo: f[4], folio: f[5],
    neto: f[6], iva: f[7], total: f[8], link: f[9],
  }));
}

// ---------------------------------------------------------------- Lectura con Claude

function limite_() {
  return Number(prop_('LIMITE_DIARIO')) || LIMITE_POR_DEFECTO;
}

function claveUso_() {
  return 'USO_' + Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd');
}

function usoHoy_() {
  return Number(prop_(claveUso_())) || 0;
}

/** Suma una lectura al contador del día; falla si se superó el tope. */
function consumirCupo_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const usadas = usoHoy_();
    if (usadas >= limite_()) {
      throw new Error('Se alcanzó el tope de ' + limite_() + ' lecturas por hoy. Intenta mañana.');
    }
    PropertiesService.getScriptProperties().setProperty(claveUso_(), String(usadas + 1));
  } finally {
    lock.releaseLock();
  }
}

/** Las llamadas que la API rechaza (sin saldo, clave inválida) no cuentan para el tope. */
function devolverCupo_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    PropertiesService.getScriptProperties().setProperty(claveUso_(), String(Math.max(0, usoHoy_() - 1)));
  } finally {
    lock.releaseLock();
  }
}

const ESQUEMA = {
  type: 'object',
  properties: {
    es_documento_tributario: {type: 'boolean'},
    fecha: {type: 'string', description: 'Fecha de emisión en formato AAAA-MM-DD, o vacío si no se ve.'},
    empresa: {type: 'string', description: 'Razón social o nombre de fantasía del emisor.'},
    rut_emisor: {type: 'string', description: 'RUT del emisor con guion y dígito verificador, ej. 76.123.456-7.'},
    tipo_documento: {type: 'string', enum: ['Boleta', 'Factura', 'Boleta de honorarios', 'Otro']},
    folio: {type: 'string', description: 'Número de folio o documento.'},
    neto: {type: ['number', 'null']},
    iva: {type: ['number', 'null']},
    total: {type: ['number', 'null']},
    observaciones: {type: 'string', description: 'Dudas de lectura (texto borroso, cifras dudosas), o vacío.'},
  },
  required: ['es_documento_tributario', 'fecha', 'empresa', 'rut_emisor', 'tipo_documento', 'folio',
    'neto', 'iva', 'total', 'observaciones'],
  additionalProperties: false,
};

const INSTRUCCIONES = 'Extrae los datos de este documento tributario chileno (boleta o factura). ' +
  'Los montos están en pesos chilenos: el punto separa miles, así que "$12.990" es 12990. ' +
  'Entrega montos como números enteros sin símbolos. Si la boleta no desglosa neto e IVA, deja neto e iva en null. ' +
  'Si un dato no se ve, deja el texto vacío o null; no lo inventes. ' +
  'Si la imagen no es una boleta ni factura, marca es_documento_tributario en false.';

function extraer_(cuerpo) {
  const clave = prop_('ANTHROPIC_API_KEY');
  if (!clave) throw new Error('Falta configurar ANTHROPIC_API_KEY en las Propiedades del script.');
  validarArchivo_(cuerpo);
  consumirCupo_();

  const bloque = cuerpo.tipo === 'application/pdf'
    ? {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: cuerpo.datos}}
    : {type: 'image', source: {type: 'base64', media_type: cuerpo.tipo, data: cuerpo.datos}};

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {'x-api-key': clave, 'anthropic-version': '2023-06-01'},
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: prop_('MODELO') || MODELO_POR_DEFECTO,
      max_tokens: 4000,
      output_config: {effort: 'low', format: {type: 'json_schema', schema: ESQUEMA}},
      messages: [{role: 'user', content: [bloque, {type: 'text', text: INSTRUCCIONES}]}],
    }),
  });
  const codigo = resp.getResponseCode();
  const r = JSON.parse(resp.getContentText());
  if (codigo !== 200) {
    devolverCupo_();
    throw new Error('Error de la API de Anthropic (' + codigo + '): ' + (r.error && r.error.message || resp.getContentText()));
  }
  if (r.stop_reason === 'refusal') throw new Error('Claude no pudo procesar este documento.');
  const texto = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const datos = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1));
  datos.advertencias = advertencias_(datos);
  datos.uso_hoy = usoHoy_();
  datos.limite_diario = limite_();
  return datos;
}

function validarArchivo_(cuerpo) {
  if (!cuerpo.datos) throw new Error('No llegó el archivo.');
  if (TIPOS_PERMITIDOS.indexOf(cuerpo.tipo) < 0) throw new Error('Formato no permitido: ' + cuerpo.tipo + '. Usa JPG, PNG o PDF.');
  if (cuerpo.datos.length > 14 * 1024 * 1024) throw new Error('El archivo es demasiado grande (máx. ~10 MB).');
}

/** Revisiones simples para que el usuario confirme antes de guardar. */
function advertencias_(d) {
  const a = [];
  if (d.es_documento_tributario === false) a.push('No parece una boleta o factura.');
  if (!d.fecha) a.push('No se leyó la fecha.');
  if (!d.total) a.push('No se leyó el monto total.');
  if (d.neto && d.iva && d.total && Math.abs(d.neto + d.iva - d.total) > 2) {
    a.push('Neto + IVA (' + (d.neto + d.iva) + ') no cuadra con el total (' + d.total + ').');
  }
  if (d.neto && d.iva && Math.abs(d.iva - d.neto * 0.19) > Math.max(2, d.neto * 0.01)) a.push('El IVA no es el 19% del neto.');
  if (d.rut_emisor && !rutValido_(d.rut_emisor)) a.push('El RUT ' + d.rut_emisor + ' no tiene un dígito verificador válido.');
  if (d.observaciones) a.push(d.observaciones);
  return a;
}

function rutValido_(rut) {
  const limpio = String(rut).replace(/[^0-9kK]/g, '').toUpperCase();
  if (limpio.length < 2) return false;
  const cuerpo = limpio.slice(0, -1);
  let suma = 0, factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const dv = 11 - (suma % 11);
  return limpio.slice(-1) === (dv === 11 ? '0' : dv === 10 ? 'K' : String(dv));
}

// ---------------------------------------------------------------- Guardado

function guardar_(cuerpo) {
  const c = cuerpo.campos || {};
  if (!c.fecha || !c.empresa || !numero_(c.total)) throw new Error('Fecha, empresa y monto total son obligatorios.');
  const d = destino_();

  let link = '';
  if (cuerpo.datos) {
    validarArchivo_(cuerpo);
    const ext = {'application/pdf': 'pdf', 'image/png': 'png', 'image/webp': 'webp'}[cuerpo.tipo] || 'jpg';
    const nombre = [c.fecha, c.empresa, c.folio].filter(String).join('_').replace(/[\\/:*?"<>|]/g, '').slice(0, 120) + '.' + ext;
    const blob = Utilities.newBlob(Utilities.base64Decode(cuerpo.datos), cuerpo.tipo, nombre);
    link = d.archivos.createFile(blob).getUrl();
  }

  // El apóstrofo deja el folio como texto para no perder ceros a la izquierda.
  const fila = [new Date(), c.fecha, c.empresa, c.rut || '', c.tipo || '', c.folio ? "'" + c.folio : '',
    numero_(c.neto), numero_(c.iva), numero_(c.total), link, (cuerpo.advertencias || []).join(' | ')];
  d.hoja.appendRow(fila);
  return {planilla_url: d.libro.getUrl(), link_archivo: link};
}

function numero_(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9,-]/g, '').replace(',', '.'));
  return isNaN(n) ? '' : n;
}
