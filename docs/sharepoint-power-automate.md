# Marea · SharePoint con Power Automate

Para ver en Marea las carpetas del SharePoint de CaixaBank sin marcador ni pestaña de SharePoint. Funciona igual que el
calendario: un flujo programado deja un archivo en tu OneDrive, el programa de subida del Mac lo sube y Marea lo enseña.

**Qué viaja:** solo nombre, ruta, enlace, si es carpeta y fecha de modificación de lo que hay en las carpetas que elijas.
Nunca el contenido de los documentos. Cada persona solo ve lo suyo.

## Antes de empezar

- En Supabase tiene que estar aplicada la migración `013_sharepoint_subido.sql`.
- En el Mac tiene que estar en marcha el programa de subida del calendario (Ajustes → Calendario de Outlook → «Subida
  desde el Mac»). No hace falta otra clave: el mismo programa sube también este archivo.

## El flujo (sin Premium)

Crea un flujo nuevo en Power Automate: **Flujo de nube programado**, nombre «Marea · SharePoint», cada **30 minutos**.

1. **SharePoint → «Obtener archivos (solo propiedades)»**
   - Dirección del sitio: el sitio de la carpeta (p. ej. *Guasdeetiquetado*). La primera vez te pedirá la conexión:
     entra con tu **cuenta de proveedor externo de CaixaBank**.
   - Nombre de la biblioteca: la biblioteca (normalmente *Documentos*).
   - En «Mostrar todo» (parámetros avanzados):
     - **Limitar entradas a la carpeta:** elige la carpeta con el icono de carpeta (p. ej. *General*).
     - **Incluir elementos anidados:** Sí (trae también lo que hay dentro de las subcarpetas).
   - En «⋯ → Configuración» de la acción: **Paginación** activada y **Umbral** 5000.
2. **Operación de datos → «Seleccionar»**
   - De: `value` de la acción anterior.
   - Mapa (pulsa el icono para escribirlo como texto) y pega:
     ```json
     {
       "nombre": "@{item()?['{FilenameWithExtension}']}",
       "ruta": "@{item()?['{FullPath}']}",
       "esCarpeta": @{item()?['{IsFolder}']},
       "enlace": "@{item()?['{Link}']}",
       "modificado": "@{item()?['Modified']}"
     }
     ```
     (Si tu editor no deja pegarlo así, crea las cinco claves a mano con esas expresiones.)
3. **Operación de datos → «Redactar»**, con este contenido (cambia la dirección del sitio por la tuya y mete como contenido
   dinámico el `Resultado` de «Seleccionar» donde pone `<Resultado de Seleccionar>`):
   ```json
   {
     "generado": "@{utcNow()}",
     "carpetas": [
       {
         "sitio": "https://<tu-dominio>.sharepoint.com/sites/Guasdeetiquetado",
         "carpeta": "General",
         "elementos": <Resultado de Seleccionar>
       }
     ]
   }
   ```
4. **OneDrive para la Empresa (tu cuenta de WPP)**: escribe el archivo **`/Gestor/sharepoint.json`** con las `Salidas` de
   «Redactar», igual que haces en el flujo del calendario con `calendario.json` (mismas acciones, mismo modo de
   sobrescribirlo).

Guarda y pulsa **Probar → Manualmente**. Si todo va bien, en unos minutos (lo que tarde OneDrive en bajar el archivo al Mac y
el programa en subirlo) las carpetas aparecen en Marea → SharePoint → «Carpetas sincronizadas».

### Más de una carpeta

Repite los pasos 1 y 2 por cada carpeta (cada una con su «Obtener archivos» y su «Seleccionar») y añade un bloque más en
`carpetas` del paso 3, separado por comas, con su `sitio`, su `carpeta` y su `elementos`. Mejor pocas carpetas concretas que
una biblioteca entera: el archivo no puede pasar de 5 MB (unos 20.000 elementos).

## Si algo falla

- **El flujo no puede conectar con SharePoint de CaixaBank**: copia el mensaje de error; puede que CaixaBank no deje usar su
  SharePoint desde Power Automate con tu cuenta.
- **En Marea sigue saliendo «Aún no hay carpetas sincronizadas»**: mira el registro del programa de subida del Mac
  (`subida.log`): las líneas «SharePoint: …» dicen si ha subido el archivo o por qué no.
- **«Falta aplicar en Supabase la migración 013»**: aplícala (Supabase → SQL Editor).
