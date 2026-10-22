# 🧾 Lector de Boletas

Aplicación web para registrar boletas y facturas chilenas:

1. Subes un archivo (JPG, PNG o PDF) o tomas una foto con el celular.
2. Claude (API de Anthropic, modelo `claude-haiku-5-5`) extrae **fecha, empresa, RUT emisor, tipo de documento, folio, neto, IVA y total**.
3. Revisas y corriges los datos. La app avisa si el RUT tiene un dígito verificador inválido, si neto + IVA no cuadra con el total, o si falta algún dato.
4. Al guardar, se agrega una fila a la planilla **Boletas** y se guarda una copia del archivo en la carpeta **Lector de Boletas/Archivos** de Google Drive.

**Sitio:** https://maxitohappy.github.io/lector-boletas/

## Arquitectura

- `index.html`, `app.js`, `estilos.css`: frontend estático publicado en GitHub Pages. Reduce las fotos a 1600 px en el navegador antes de enviarlas.
- `backend/Code.gs`: Google Apps Script publicado como aplicación web. Llama a la API de Anthropic con la clave guardada en las Propiedades del script, crea la carpeta y la planilla en Drive y guarda los registros.
- `config.js`: URL del backend. Es pública, no es un secreto.

La clave de Anthropic nunca está en este repositorio ni en el navegador. El backend tiene un tope diario de lecturas (`LIMITE_DIARIO`, 100 por defecto) para que nadie agote los créditos.

## Configuración del backend

Ver [backend/LEEME.md](backend/LEEME.md).
