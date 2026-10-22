// Lector de Boletas: sube/fotografía una boleta, la lee Claude (vía backend Apps Script) y la guarda en Drive.
const MAX_LADO = 1600;          // px; las fotos se reducen para ahorrar tokens y acelerar la subida
const MAX_PDF = 10 * 1024 * 1024;

const $ = id => document.getElementById(id);
let actual = null;              // {tipo, datos (base64), advertencias}

async function llamar(accion, cuerpo) {
  const opciones = cuerpo
    ? {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify({accion, ...cuerpo})}
    : {method: 'GET'};
  const url = cuerpo ? BACKEND_URL : BACKEND_URL + '?accion=' + accion;
  const r = await fetch(url, opciones);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Error desconocido');
  return j.datos;
}

function mensaje(texto, tipo) {
  const m = $('mensaje');
  m.hidden = !texto;
  m.className = 'mensaje ' + (tipo || '');
  m.innerHTML = texto || '';
}

function escapar(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

const pesos = n => (n === '' || n === null || n === undefined || isNaN(Number(n))) ? '' :
  '$' + Number(n).toLocaleString('es-CL');

// ------------------------------------------------------------ Archivo → base64

function leerComoBase64(archivo) {
  return new Promise((ok, mal) => {
    const lector = new FileReader();
    lector.onload = () => ok(String(lector.result).split(',')[1]);
    lector.onerror = () => mal(lector.error);
    lector.readAsDataURL(archivo);
  });
}

async function reducirImagen(archivo) {
  const bitmap = await createImageBitmap(archivo, {imageOrientation: 'from-image'});
  const escala = Math.min(1, MAX_LADO / Math.max(bitmap.width, bitmap.height));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(bitmap.width * escala);
  lienzo.height = Math.round(bitmap.height * escala);
  lienzo.getContext('2d').drawImage(bitmap, 0, 0, lienzo.width, lienzo.height);
  return lienzo.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function prepararArchivo(archivo) {
  const esPdf = archivo.type === 'application/pdf' || /\.pdf$/i.test(archivo.name);
  if (esPdf) {
    if (archivo.size > MAX_PDF) throw new Error('El PDF supera 10 MB.');
    return {tipo: 'application/pdf', datos: await leerComoBase64(archivo)};
  }
  if (!archivo.type.startsWith('image/')) throw new Error('Formato no permitido. Usa JPG, PNG o PDF.');
  return {tipo: 'image/jpeg', datos: await reducirImagen(archivo)};
}

// ------------------------------------------------------------ Flujo

async function procesar(archivo) {
  if (!archivo) return;
  mensaje('');
  $('paso-revisar').hidden = true;
  const vista = $('vista');
  vista.hidden = false;
  try {
    actual = await prepararArchivo(archivo);
  } catch (e) {
    vista.hidden = true;
    return mensaje('No se pudo abrir el archivo: ' + escapar(e.message), 'error');
  }
  vista.innerHTML = actual.tipo === 'application/pdf'
    ? `<div class="pdf">📄 ${escapar(archivo.name)}</div>`
    : `<img alt="Boleta" src="data:image/jpeg;base64,${actual.datos}">`;

  $('leyendo').hidden = false;
  try {
    const d = await llamar('extraer', {tipo: actual.tipo, datos: actual.datos});
    actual.advertencias = d.advertencias || [];
    llenarFormulario(d);
  } catch (e) {
    mensaje('No se pudo leer la boleta: ' + escapar(e.message), 'error');
  } finally {
    $('leyendo').hidden = true;
  }
}

function llenarFormulario(d) {
  const f = $('formulario');
  f.fecha.value = /^\d{4}-\d{2}-\d{2}$/.test(d.fecha) ? d.fecha : '';
  f.empresa.value = d.empresa || '';
  f.rut.value = d.rut_emisor || '';
  f.tipo.value = d.tipo_documento || 'Boleta';
  f.folio.value = d.folio || '';
  f.neto.value = d.neto ?? '';
  f.iva.value = d.iva ?? '';
  f.total.value = d.total ?? '';
  $('advertencias').innerHTML = (d.advertencias || []).map(a => `<li>⚠️ ${escapar(a)}</li>`).join('');
  $('paso-revisar').hidden = false;
  $('paso-revisar').scrollIntoView({behavior: 'smooth'});
}

function limpiar() {
  actual = null;
  $('formulario').reset();
  $('paso-revisar').hidden = true;
  $('vista').hidden = true;
  $('vista').innerHTML = '';
  $('camara').value = '';
  $('archivo').value = '';
}

async function guardar(ev) {
  ev.preventDefault();
  const f = $('formulario');
  const campos = Object.fromEntries(new FormData(f).entries());
  const boton = $('guardar');
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  try {
    const r = await llamar('guardar', {campos, tipo: actual?.tipo, datos: actual?.datos, advertencias: actual?.advertencias});
    mensaje(`✅ Boleta de <b>${escapar(campos.empresa)}</b> por <b>${pesos(campos.total)}</b> guardada. ` +
      `<a href="${escapar(r.planilla_url)}" target="_blank" rel="noopener">Ver planilla</a>`, 'ok');
    limpiar();
    cargarUltimas();
  } catch (e) {
    mensaje('No se pudo guardar: ' + escapar(e.message), 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = '💾 Guardar en Drive';
  }
}

async function cargarUltimas() {
  try {
    const filas = await llamar('ultimas');
    $('ultimas').innerHTML = filas.length ? filas.map(b => `<tr>
        <td>${escapar(b.fecha)}</td><td>${escapar(b.empresa)}</td><td>${escapar(b.rut)}</td>
        <td>${escapar(b.folio)}</td><td class="num">${escapar(b.total)}</td>
        <td>${b.link ? `<a href="${escapar(b.link)}" target="_blank" rel="noopener">Ver</a>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="6" class="vacio">Sin datos aún</td></tr>';
  } catch (e) {
    /* la tabla es secundaria; el estado ya informa si el backend falla */
  }
}

async function iniciar() {
  try {
    const e = await llamar('ping');
    if (!e.ia) avisoEstado('⚠️ Backend sin clave de Anthropic configurada.');
    for (const [id, url] of [['link-planilla', e.planilla_url], ['link-carpeta', e.carpeta_url]]) {
      $(id).href = url;
      $(id).hidden = false;
    }
    cargarUltimas();
  } catch (err) {
    avisoEstado('⚠️ No se pudo conectar con el backend: ' + err.message);
  }
}

// La línea de estado solo aparece cuando hay un problema.
function avisoEstado(texto) {
  $('estado').textContent = texto;
  $('estado').hidden = false;
}

$('camara').addEventListener('change', e => procesar(e.target.files[0]));
$('archivo').addEventListener('change', e => procesar(e.target.files[0]));
$('formulario').addEventListener('submit', guardar);
$('cancelar').addEventListener('click', () => { limpiar(); mensaje(''); });

const zona = $('zona');
zona.addEventListener('dragover', e => { e.preventDefault(); zona.classList.add('encima'); });
zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
zona.addEventListener('drop', e => {
  e.preventDefault();
  zona.classList.remove('encima');
  procesar(e.dataTransfer.files[0]);
});

iniciar();
