# SOSER · Panel de Casos (App Admin)

Contraparte de la app de encargados. Lee la **misma planilla** de Google Sheets vía el mismo `/exec`, muestra KPIs en vivo, un **mapa de densidad** de casos por establecimiento, listas por fecha, ficha de cada establecimiento y el **detalle de caso** con visado automático, derivación a técnico y marca de solucionado. Incluye **notificaciones de emergencia** (con la app abierta, y opcionalmente con la app cerrada mediante un pequeño servidor de push).

Sin frameworks. Se sirve como sitio estático (GitHub Pages) y se conecta a Google Apps Script + Sheets + Drive.

---

## 1. Contenido del paquete

```
soser-admin/
├── index.html                 App admin (UI completa, Leaflet por CDN)
├── app.js                     Toda la lógica
├── data.js                    Base de establecimientos (RBD, nombre, dirección, comuna…)
├── coords.js                  Coordenadas por RBD (arranque inmediato del mapa)
├── sw.js                      Service Worker (notificaciones / push)
├── icon-192.png               Ícono para las notificaciones
├── .nojekyll                  Para que GitHub Pages sirva todo tal cual
├── AppsScript_SOSER_v4.gs     Backend unificado (reemplaza tu script actual)
└── push-server/               Servidor de push opcional (Termux / VPS)
    ├── server.js
    └── package.json
```

> El **PIN** para entrar a Configuración es `123456789` (puedes cambiarlo en `app.js`, constante `CFG_PIN`).

---

## 2. Actualizar el backend (Apps Script v4)

Este backend es **retrocompatible**: la app de encargados sigue funcionando igual. Solo agrega hojas y columnas nuevas.

1. Abre tu planilla ▸ **Extensiones ▸ Apps Script**.
2. Reemplaza el contenido por `AppsScript_SOSER_v4.gs`.
3. Ejecuta una vez la función **`primeraVez`** (crea/verifica las hojas `Técnicos` y `Coordenadas`). Autoriza los permisos cuando lo pida.
4. **Implementar ▸ Gestionar implementaciones ▸** (lápiz) ▸ **Nueva versión ▸ Implementar**.
   - Ejecutar como: **Yo**
   - Con acceso: **Cualquier persona**
5. La URL `/exec` **no cambia**. Es la misma que ya usan los encargados.

### Qué agrega v4 al Sheet
- **Hoja `Técnicos`**: lista editable para derivar. Ya trae *Rodrigo Martínez*. Puedes agregar/quitar desde la app (⚙️) o a mano en la hoja. La columna `Activo` con `NO` oculta a un técnico sin borrar su historial.
- **Hoja `Coordenadas`**: caché de geocodificación. Se llena sola llamando `Maps.newGeocoder()` sobre las direcciones reales. Mientras tanto, el mapa ya funciona con `coords.js`.
- **Columnas nuevas** (al final de cada hoja de encargado, no rompen nada):
  - `Verificadores Técnico` — fotos/videos que subirá la futura app del técnico.
  - `Fecha Solucionado` — timestamp de cierre.
  - `Tiempo Resolución` — texto legible (ej. `2 d 4 h`), calculado al marcar solucionado.

---

## 3. Publicar la app (GitHub Pages)

1. Sube el contenido de `soser-admin/` a un repositorio (puede ser el mismo de la otra app, en otra carpeta, o uno nuevo).
2. **Settings ▸ Pages ▸** Deploy from a branch ▸ `main` ▸ `/root` (o la carpeta correspondiente).
3. Abre la URL que te da GitHub. La primera vez: pulsa ⚙️, ingresa el PIN, **pega la URL `/exec`** y guarda.

> **Importante:** las notificaciones y el Service Worker requieren **HTTPS**. GitHub Pages ya sirve por HTTPS, así que funciona. En `localhost` también funciona para pruebas.

---

## 4. Cómo se usa

- **Inicio**: 4 KPIs como botones con su número al costado, actualizándose solos cada 45 s: **Generales** (activos), **Derivados**, **No visados**, **Emergencias**. Si hay una emergencia activa, el botón de Emergencias **se prende en llamas**.
- **Generales**: alterna entre *Casos por fecha* (lista, más reciente arriba) y *Densidad de casos* (mapa). Arriba, buscador de establecimientos con esferas de color según cantidad de casos (gris = todo solucionado). Gira el teléfono a horizontal para ver el mapa a pantalla completa; la ✕ te devuelve.
- **Mapa**: cada establecimiento es un pin con su nombre y el número de casos. El círculo de área crece con la cantidad y cambia de color: amarillo (1–2), naranjo (3+), rojo (emergencia). El radio está en **metros**, así que escala natural al hacer zoom.
- **Establecimiento** (tocando el buscador o un pin): historial completo, estados, verificadores y un mini-mapa con solo ese pin.
- **Detalle de caso** (tocando cualquier caso): se abre como burbuja. **Al abrirlo queda Visado automáticamente** (los encargados lo ven así). Arriba una barra *Derivar a técnico* y un botón *Solucionado*. Abajo, el mapa con el pin. Botones: **Guardar y salir**, **Atrás sin guardar**, **Atrás**.
- **Derivados**: KPIs por técnico (casos, solucionados, tiempo promedio) y lista de casos derivados.
- **Emergencias**: mismas acciones, ordenadas por fecha; se acumulan aunque estén solucionadas (histórico), la más reciente arriba.

---

## 5. Notificaciones de emergencia

### Nivel B — con la app abierta (sin servidor, ya funciona)
Activa el permiso en ⚙️ ▸ *Activar notificaciones*. Con la app abierta (aunque sea en otra pestaña o minimizada) recibes un aviso cuando llega una emergencia nueva; al tocarlo, te lleva al caso. No requiere nada más.

### Nivel A — con la app CERRADA (tu servidor en el celular)
Para recibir emergencias con la app totalmente cerrada necesitas un servidor que envíe el push. Incluí uno listo en `push-server/`. La idea: tu celular (siempre conectado) corre este servidor, que cada 30 s revisa la planilla y, si hay una emergencia nueva, te dispara la notificación.

#### Montarlo en tu celular Android (Termux)
1. Instala **Termux** (desde F-Droid, recomendado, o Play Store).
2. En Termux:
   ```bash
   pkg update && pkg install nodejs
   termux-setup-storage        # permite acceder a archivos
   ```
3. Copia la carpeta `push-server` al celular (por Drive, cable, o `git clone` de tu repo). Entra a ella:
   ```bash
   cd push-server
   npm install
   npm start
   ```
4. La primera vez imprime tu **VAPID public key** y confirma que escucha en el puerto `8080`. **Deja esa terminal abierta.**
5. Para que Android no la suspenda al bloquear la pantalla:
   ```bash
   termux-wake-lock
   ```
   (instala antes `pkg install termux-api` si te lo pide). Ideal: deja el celular cargando.

#### Exponerlo para que la app lo alcance
La app corre en HTTPS (GitHub Pages) y el servidor local del celular está en `http://`. Tienes dos caminos:

- **Mismo teléfono**: si abres la app en el navegador del **mismo** celular que corre el servidor, puedes usar `http://localhost:8080`. (En algunos Android el navegador permite `localhost` sin HTTPS.)
- **Desde cualquier lado (recomendado): un túnel HTTPS.** Instala Cloudflare Tunnel y expón el puerto:
  ```bash
  pkg install cloudflared
  cloudflared tunnel --url http://localhost:8080
  ```
  Te dará una URL pública `https://algo.trycloudflare.com`. **Esa** es la que pegas en la app.

#### Conectar la app al servidor
En la app: ⚙️ ▸ *Servidor de push* ▸ pega la URL (localhost o la del túnel) ▸ **Suscribirse**. Listo: cuando entre una emergencia, recibes el push aunque la app esté cerrada. Toca la notificación y abre el caso.

Prueba el envío en cualquier momento:
```bash
curl -X POST https://TU-URL/test
```

#### Notas
- **iPhone**: Apple solo permite Web Push si **instalas la app en la pantalla de inicio** (Compartir ▸ *Agregar a pantalla de inicio*) y abres esa. El servidor funciona igual.
- El servidor guarda las suscripciones en `subs.json` y los avisos ya enviados en `seen.json` (junto al `server.js`). No necesita base de datos.
- Alternativa al celular: subir `push-server/` a un VPS o a un servicio como Render/Railway; el `PORT` lo toma de la variable de entorno.

---

## 6. Contrato con el backend (referencia)

**GET**
- `?admin=1` → `{ ok, reportes:[...], tecnicos:[...] }` — todos los casos de todas las hojas.
- `?tecnicos=1` → `{ ok, tecnicos:[...] }`
- `?coords=1` (`&geo=1` para geocodificar un lote) → `{ ok, coords:{ rbd:{lat,lon} } }`

**POST** (JSON en el body)
- `{ accion:"visar", encargado, reporteId }`
- `{ accion:"derivar", encargado, reporteId, derivadoA }`
- `{ accion:"solucionar", encargado, reporteId, fechaSolucion, tsSolucion }`
- `{ accion:"tecnicoAdd", nombre }` / `{ accion:"tecnicoDel", nombre }`
- `{ accion:"geocodificarTodo", max }`

La app de encargados sigue usando `subirArchivo`, `borrar`, y el alta de casos sin cambios.

---

## 7. Notas técnicas

- **Coordenadas**: `coords.js` da un arranque inmediato (calle real + dispersión determinística por RBD). Cuando el Apps Script geocodifica las direcciones exactas, esas coordenadas del servidor tienen prioridad automáticamente.
- **Google Drive**: las fotos se muestran vía `lh3.googleusercontent.com/d/ID` (con respaldo a `drive.google.com/thumbnail`), y los videos por iframe `/preview`. Los links `/view` crudos no se pueden incrustar.
- **Estados**: No visado → Visado → Derivado → Solucionado. Un `Visado` que empieza con `ELIMINADO:` marca el caso como borrado lógico y no cuenta en KPIs.
- **Rendimiento**: refresco automático cada 45 s. Todo el peso de cálculo (KPIs, agrupación por RBD) se hace en el navegador; el backend solo lee/escribe.
