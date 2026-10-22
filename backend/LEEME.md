# Backend (Google Apps Script)

## Primera configuración (una vez)

1. Abre el proyecto en <https://script.google.com> (proyecto **Lector de Boletas**).
2. ⚙️ **Configuración del proyecto → Propiedades del script → Agregar propiedad**:
   - `ANTHROPIC_API_KEY` = tu clave de <https://console.anthropic.com/settings/keys>
   - Opcionales: `LIMITE_DIARIO` (por defecto 100), `MODELO` (por defecto `claude-haiku-5-5`).
3. En el editor, elige la función **`inicializar`** y pulsa **Ejecutar**. Autoriza los permisos (Google avisa que la
   app no está verificada porque es tuya: *Configuración avanzada → Ir a Lector de Boletas*). Esto crea en tu Drive la
   carpeta **Lector de Boletas** con la planilla **Boletas** y la subcarpeta **Archivos**.

Para probar: abre `URL_DEL_BACKEND?accion=ping`. Debe responder `{"ok":true,...}`.

## Actualizar el código sin cambiar la URL

Requiere `clasp login` y el `.clasp.json` local (no se publica):

```bash
cd backend
clasp push -f
clasp update-deployment <ID de la implementación> -d "descripción"
```

## Acciones

- GET `ping`: estado, enlaces a la carpeta y planilla, uso del día.
- GET `ultimas`: últimas 10 boletas guardadas.
- POST `extraer` (`tipo`, `datos` en base64): lee la boleta con Claude. Descuenta 1 del tope diario.
- POST `guardar` (`campos`, `tipo`, `datos`, `advertencias`): guarda la fila y el archivo.

## Notas

- La URL `/exec` es pública: cualquiera que la tenga puede leer boletas (hasta el tope diario) y ver las últimas 10
  guardadas. No uses esta app para documentos confidenciales sin agregar control de acceso.
- Si borras la carpeta o la planilla, se vuelven a crear solas en la siguiente operación.
