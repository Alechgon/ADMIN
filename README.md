# SOSER · Panel Administrador (App Web)

Panel de administrador para ver y gestionar todos los casos que suben los encargados desde la app "Agregar Caso". Solo para ti.

## Qué hace
- **Ve todos los reportes** de todas las hojas de encargados del Sheet (quién lo subió, RBD, establecimiento, dirección, comuna, institución, supervisor, técnico, descripción, fecha, GPS y verificadores).
- **Prioriza por gravedad en 4 niveles** según criticidad de la licitación (Crítico, Alto, Medio, Bajo), cotejando palabras clave en categoría y descripción: fuga de gas, cables pelados, SEC, filtración, sin agua caliente, etc. Gas y Electricidad nunca bajan de "Alto".
- **KPIs**: total y conteo por nivel de gravedad, y chips por categoría (Gas, Electricidad, Filtraciones, Infraestructura, Equipos, Otro) con cantidad.
- **Filtros**: por categoría, por gravedad y buscador libre (RBD, establecimiento, texto, encargado, comuna).
- **Detalle** de cada caso con enlace a **Google Maps** por el GPS y a los **verificadores** en Drive.
- **Derivar / Visar**: escribes a quién derivas y queda en las columnas "Derivado a" y "Visado" del Sheet, para que tu otra app lo tome.
- **Notificaciones del navegador**: te pide permiso y, con el panel abierto, avisa cuando entra un caso nuevo (prioriza los graves). Refresca solo cada 60 s.

## Conexión
Usa el **mismo Apps Script** del Sheet (la misma URL /exec). Al abrir el panel, pega esa URL una vez y queda guardada en el dispositivo.

> Importante: debes tener instalada la versión v2 del `AppsScript_SOSER.gs` (la que incluye modo admin y la acción de derivar). Si no, actualízala: pega el .gs nuevo, ejecuta `primeraVez`, e Implementar ▸ Gestionar implementaciones ▸ Nueva versión.

## Publicar
Sube `index.html`, `admin.js`, `.nojekyll` a un repo (puede ser otro repo distinto al de la app de terreno) → Settings ▸ Pages ▸ main ▸ /(root). Ábrelo en HTTPS.

## Límite honesto de las notificaciones
Las notificaciones funcionan **con el panel abierto** (en el navegador del computador o del celular). El aviso con la app totalmente cerrada (push real tipo app nativa) requiere un servidor y no es posible en una web estática; eso quedaría para cuando lo pases a APK, como planeas.
