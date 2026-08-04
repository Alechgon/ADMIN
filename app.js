/* ============================================================
   SOSER · Panel de Casos (Admin) — App Web v1
   ------------------------------------------------------------
   Contraparte de la app de encargados. Lee la misma planilla vía
   /exec (?admin=1), muestra KPIs, mapa de densidad (Leaflet),
   listas por fecha, ficha de establecimiento y detalle de caso
   (visar / derivar / solucionar). Notificaciones de emergencia.
   Sin frameworks. Requiere Apps Script v4.
   ============================================================ */
'use strict';

const COL = { RBD: 0, NOM: 1, DIR: 2, COM: 3, SUP: 4, INST: 5, TEC: 6 };
const LOGO_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F49A0F"/><stop offset="0.5" stop-color="#E8A30C"/><stop offset="1" stop-color="#7DB61C"/></linearGradient></defs><path d="M50 12 C30 12 20 30 28 48 C34 62 50 64 50 64 C50 64 66 62 72 48 C80 30 70 12 50 12 Z" fill="url(#sg)"/><path d="M50 20 C44 30 56 40 50 52 C46 44 54 34 50 20 Z" fill="#2E7D32" opacity="0.85"/></svg>`;
const LS_CFG = 'soser_admin_cfg';
const DEFAULT_EXEC = 'https://script.google.com/macros/s/AKfycby4ULsjxSZ2HCb_pnYvlr5MvjwssIZIAG4HTLqh9gBIz7zqfYYogY7pPtL8SGj71ZZGVg/exec';
const LS_SEEN = 'soser_admin_seen_emerg';
const CFG_PIN = '123456789';
const POLL_MS = 45000;            // refresco automático
const SANTIAGO = { lat: -33.4569, lon: -70.6483, zoom: 12 };

let CFG = loadCfg();
let ALL = [];                     // todos los reportes (admin)
let TECNICOS = [];                // lista de técnicos desde el Sheet
let pollTimer = null;
let currentView = 'home';         // vista actual (para saber si repintar)

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const content = $('#content'), navwrap = $('#navwrap'), overlays = $('#overlays');
const btnBack = $('#btnBack'), btnNext = $('#btnNext');
$('#logoSlot').innerHTML = LOGO_SVG;

/* ----------------------- utilidades ----------------------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(m, ms = 2200) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
function norm(s) { return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function loadCfg() { try { const c = JSON.parse(localStorage.getItem(LS_CFG)); return (c && c.sheetUrl) ? c : { sheetUrl: DEFAULT_EXEC }; } catch { return { sheetUrl: DEFAULT_EXEC }; } }
function saveCfg(c) { localStorage.setItem(LS_CFG, JSON.stringify(c)); CFG = c; }
function loadSeen() { try { return new Set(JSON.parse(localStorage.getItem(LS_SEEN)) || []); } catch { return new Set(); } }
function saveSeen(set) { localStorage.setItem(LS_SEEN, JSON.stringify([...set])); }
function showNav(show) { navwrap.classList.toggle('hidden', !show); }
function tsOf(r) { const t = Date.parse(r.timestamp); if (!isNaN(t)) return t; const p = parseFechaCL(r.fecha); return p || 0; }
function parseFechaCL(f) { if (!f) return 0; const m = String(f).match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (!m) return 0; return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime(); }

/* estado del caso, con emergencia como categoría */
function esEmergencia(r) { return norm(r.categoria) === 'emergencia'; }
function estadoDe(r) {
  const v = (r.visado || '').toString().trim().toLowerCase();
  const d = (r.derivadoA || '').toString().trim();
  if (v.startsWith('eliminado')) return { k: 'pend', t: 'Eliminado', del: true };
  if (v.includes('solucion') || v.includes('final')) return { k: 'fin', t: 'Solucionado' };
  if (d) return { k: 'der', t: 'Derivado' };
  if (v) return { k: 'vis', t: 'Visado' };
  return { k: 'pend', t: 'No visado' };
}
function isBorrado(r) { return (r.visado || '').toString().toLowerCase().startsWith('eliminado'); }
function activos(list) { return list.filter(r => !isBorrado(r)); }

/* ------------- Google Drive: links embebibles ------------- */
function driveIdFrom(url) {
  if (!url) return '';
  let m = String(url).match(/\/file\/d\/([-\w]{20,})/); if (m) return m[1];
  m = String(url).match(/[?&]id=([-\w]{20,})/); if (m) return m[1];
  m = String(url).match(/googleusercontent\.com\/d\/([-\w]{20,})/); if (m) return m[1];
  return '';
}
function driveImgSources(id) { return [`https://lh3.googleusercontent.com/d/${id}=w1600`, `https://drive.google.com/thumbnail?id=${id}&sz=w1600`]; }
function driveVideoPreview(id) { return `https://drive.google.com/file/d/${id}/preview`; }
function driveOpenUrl(id) { return `https://drive.google.com/file/d/${id}/view`; }
function driveThumb(id) { return `https://drive.google.com/thumbnail?id=${id}&sz=w200`; }

/* parsea columna de verificadores (encargado o técnico) */
function verifList(raw) {
  const out = [];
  if (!raw) return out;
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    const um = line.match(/(https?:\/\/[^\s]+)/); const url = um ? um[1] : '';
    if (!url) continue;
    const type = /(^|\b)video\b/i.test(line) || /\.webm/i.test(line) ? 'video' : 'photo';
    const nm = (line.split('->')[0].split(':').slice(1).join(':').trim()) || line.split(':')[0].trim();
    out.push({ name: nm, url, driveId: driveIdFrom(url), type });
  }
  return out;
}

/* --------------------- índice de establecimientos --------------------- */
const ESTS = (() => {
  const seen = new Set(), out = [];
  for (const r of BBDD) {
    const key = String(r[COL.RBD]) + '|' + norm(r[COL.NOM]);
    if (seen.has(key)) continue; seen.add(key);
    out.push({ rbd: String(r[COL.RBD]), nom: r[COL.NOM], dir: r[COL.DIR], com: r[COL.COM], sup: r[COL.SUP], tec: r[COL.TEC], inst: r[COL.INST] });
  }
  return out;
})();
function estByRbd(rbd) { return ESTS.find(e => e.rbd === String(rbd)); }
/* Ruta del establecimiento: la comuna real de la BBDD (SANTIAGO / ESTACION CENTRAL).
   Sirve para saber a quién derivar. Se deriva del RBD, no del texto del caso. */
function rutaDe(rbdOrRec) {
  const rbd = typeof rbdOrRec === 'object' ? (rbdOrRec.rbd) : rbdOrRec;
  const e = estByRbd(rbd);
  if (!e) return '';
  const com = (e.com || '').toString().trim().toUpperCase();
  if (com.includes('SANTIAGO')) return 'Santiago';
  if (com.includes('ESTACION') || com.includes('ESTACIÓN')) return 'Estación Central';
  return e.com || '';
}
function supervisorDe(rbd) { const e = estByRbd(rbd); return e ? (e.sup || '') : ''; }
function dirDe(rbd) { const e = estByRbd(rbd); return e ? (e.dir || '') : ''; }
function coordOf(rbd) {
  const c = (typeof COORDS !== 'undefined') && COORDS[String(rbd)];
  if (c && SERVER_COORDS[String(rbd)]) return SERVER_COORDS[String(rbd)]; // server manda si existe
  if (SERVER_COORDS[String(rbd)]) return SERVER_COORDS[String(rbd)];
  return c || null;
}
let SERVER_COORDS = {};   // coords geocodificadas por el Apps Script (más exactas)

/* casos activos por establecimiento (para orbes / pines) */
function casesByRbd(list) {
  const map = {};
  for (const r of list) {
    if (isBorrado(r)) continue;
    const k = String(r.rbd || '').trim(); if (!k) continue;
    (map[k] = map[k] || []).push(r);
  }
  return map;
}
/* nivel de color por cantidad + emergencia */
function levelFor(cases) {
  const act = cases.filter(r => estadoDe(r).k !== 'fin');
  const emerg = cases.some(r => esEmergencia(r) && estadoDe(r).k !== 'fin');
  if (emerg) return { cls: 'r', color: '#CE4257', n: act.length || cases.length };
  // todos los casos solucionados -> verde, tamaño de 1 caso
  if (!act.length) return { cls: 'done', color: '#5E8E13', n: 1 };
  if (act.length >= 6) return { cls: 'p', color: '#7B2FBE', n: act.length }; // convergencia -> morado
  if (act.length >= 3) return { cls: 'o', color: '#F49A0F', n: act.length };
  return { cls: 'y', color: '#F2C230', n: act.length };
}

/* ============================ RED ============================ */
async function fetchAdmin() {
  if (!CFG.sheetUrl) return null;
  try {
    const res = await fetch(CFG.sheetUrl + '?admin=1&t=' + Date.now());
    const d = await res.json();
    if (d && d.ok && Array.isArray(d.reportes)) { if (Array.isArray(d.tecnicos)) TECNICOS = d.tecnicos; return d.reportes; }
    return null;
  } catch (e) { return null; }
}
async function fetchTecnicos() {
  if (!CFG.sheetUrl) return null;
  try { const r = await fetch(CFG.sheetUrl + '?tecnicos=1&t=' + Date.now()); const d = await r.json(); if (d && d.ok) return d.tecnicos || []; } catch (e) {}
  return null;
}
async function fetchCoords(withGeo) {
  if (!CFG.sheetUrl) return null;
  try { const r = await fetch(CFG.sheetUrl + '?coords=1' + (withGeo ? '&geo=1' : '') + '&t=' + Date.now()); const d = await r.json(); if (d && d.ok && d.coords) { SERVER_COORDS = d.coords; return d.coords; } } catch (e) {}
  return null;
}
async function postAction(payload) {
  try { const res = await fetch(CFG.sheetUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }); return await res.json().catch(() => ({ ok: true })); }
  catch (e) { return { ok: false, error: String(e) }; }
}

/* ---------------- refresco + notificaciones ---------------- */
async function refreshData(silent) {
  const data = await fetchAdmin();
  if (!data) { if (!silent) toast('No se pudo actualizar. Revisa la URL /exec.', 3000); return false; }
  const prev = ALL;
  ALL = data;
  detectNewEmergencies(prev, ALL);
  return true;
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const ok = await refreshData(true);
    if (ok && typeof rerenderCurrent === 'function') rerenderCurrent();
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* Notificaciones tipo B (funciona con la app abierta / en otra pestaña) */
function detectNewEmergencies(prev, next) {
  const seen = loadSeen();
  const prevIds = new Set(prev.map(r => r.encargado + '|' + r.id));
  const nuevos = activos(next).filter(r => esEmergencia(r) && estadoDe(r).k !== 'fin')
    .filter(r => { const key = r.encargado + '|' + r.id; return !prevIds.has(key) && !seen.has(key); });
  for (const r of nuevos) {
    notifyEmergency(r);
    seen.add(r.encargado + '|' + r.id);
  }
  if (nuevos.length) saveSeen(seen);
}
function notifyEmergency(r) {
  const est = r.establecimiento || (estByRbd(r.rbd) || {}).nom || 'Establecimiento';
  const body = `${est} · RBD ${r.rbd}\n${r.descripcion || ''}`.slice(0, 140);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('🚨 Emergencia SOSER', { body, tag: 'soser-' + r.id, renotify: true, icon: 'icon-192.png', badge: 'icon-192.png' });
      n.onclick = () => { window.focus(); openCase(r); n.close(); };
    } catch (e) { /* Safari: notifica vía SW abajo */ pushViaSW(est, body, r); }
  } else {
    pushViaSW(est, body, r);
  }
}
function pushViaSW(title, body, r) {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification('🚨 Emergencia SOSER', { body, tag: 'soser-' + r.id, data: { encargado: r.encargado, id: r.id }, icon: 'icon-192.png' })).catch(() => {});
  }
}
async function askNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) {} }
}

/* ---- Web Push (opción A): suscribirse al servidor del celular/VPS ---- */
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function subscribePush() {
  const base = CFG.pushUrl ? CFG.pushUrl.replace(/\/$/, '') : '';
  try {
    if (!base) { toast('Pega primero la URL del servidor', 3000); return false; }
    if (!('serviceWorker' in navigator)) { toast('Tu navegador no soporta Service Worker', 3000); return false; }
    if (!('PushManager' in window)) { toast('Tu navegador no soporta Push. Instala la app en pantalla de inicio e intenta de nuevo.', 5000); return false; }
    await askNotifPermission();
    if (Notification.permission !== 'granted') { toast('Debes permitir notificaciones primero', 3000); return false; }
    let reg;
    try {
      await navigator.serviceWorker.register('sw.js');
      reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout SW')), 8000))
      ]);
    } catch (e) { toast('Error SW: ' + e.message, 4000); return false; }
    let key;
    try {
      const kr = await fetch(base + '/vapidPublicKey', { mode: 'cors' });
      const kd = await kr.json(); key = kd.key;
    } catch (e) { toast('No se pudo conectar al servidor. Revisa que Termux siga corriendo y que la URL del tunel sea correcta.', 5000); return false; }
    if (!key) { toast('El servidor no devolvio la clave VAPID', 3000); return false; }
    let sub;
    try {
      sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    } catch (e) { toast('Error push: ' + e.message, 5000); return false; }
    try {
      const res = await fetch(base + '/subscribe', {
        method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), sheetUrl: CFG.sheetUrl })
      });
      const d = await res.json().catch(() => ({}));
      if (d && d.ok !== false) { saveCfg(Object.assign({}, CFG, { pushOn: true, pushUrl: base })); return true; }
      toast('El servidor rechazo la suscripcion', 3000); return false;
    } catch (e) { toast('Error enviando suscripcion: ' + e.message, 4000); return false; }
  } catch (e) { toast('Error: ' + e.message, 4000); return false; }
}

/* ============================ HOME ============================ */
function renderHome() {
  currentView = 'home';
  $('#btnHome').classList.add('hidden'); showNav(false); $('#modeLabel').textContent = 'Panel';
  const cfgOk = !!CFG.sheetUrl;
  $('#liveDot').classList.toggle('hidden', !cfgOk);

  const act = activos(ALL);
  const total = act.filter(r => estadoDe(r).k !== 'fin').length;
  const derivados = act.filter(r => estadoDe(r).k === 'der').length;
  const nEncargados = new Set(ALL.map(r => r.encargado).filter(Boolean)).size;
  const emergAll = act.filter(esEmergencia);
  const emergActivas = emergAll.filter(r => estadoDe(r).k !== 'fin').length;

  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto">
    <div class="hero"><div class="mark">${LOGO_SVG}</div><h1>Panel de Casos</h1>
      <p>${cfgOk ? 'Administración · SOSER' : 'Configura la conexión para comenzar'}</p></div>
    <div class="kpi-list">
      <button class="kpi-btn generales" id="kGen"><div class="kic">📊</div>
        <div class="kmain"><div class="kname">Generales</div><div class="ksub">Mapa de densidad · casos activos</div></div>
        <div class="knum" id="nGen">${total}</div></button>
      <button class="kpi-btn derivados" id="kDer"><div class="kic">↗️</div>
        <div class="kmain"><div class="kname">Derivados</div><div class="ksub">Por técnico · tiempos</div></div>
        <div class="knum" id="nDer">${derivados}</div></button>
      <button class="kpi-btn novis" id="kNo"><div class="kic">👷</div>
        <div class="kmain"><div class="kname">Encargados</div><div class="ksub">Casos por encargado</div></div>
        <div class="knum" id="nNo">${nEncargados}</div></button>
      <button class="kpi-btn bitacora" id="kBit"><div class="kic">📗</div>
        <div class="kmain"><div class="kname">Bitácora</div><div class="ksub">Establecimientos atendidos · verificadores</div></div>
        <div class="knum" id="nBit">${new Set(act.filter(r => estadoDe(r).k === 'fin').map(r => r.rbd)).size}</div></button>
      <button class="kpi-btn emerg ${emergActivas ? 'active' : ''}" id="kEm">
        <div class="flame-wrap">${flamesHTML()}</div><div class="emerg-glow"></div>
        <div class="kic">🚨</div>
        <div class="kmain"><div class="kname">Emergencias</div><div class="ksub">${emergActivas ? emergActivas + ' activa(s) · atención' : emergAll.length + ' histórica(s)'}</div></div>
        <div class="knum" id="nEm">${emergActivas}</div></button>
    </div>
    <div class="cfg-fab" id="aCfg" title="Configuración" role="button" tabindex="0">⚙️</div>
    ${cfgOk ? '' : '<div class="cfg-warn">Configura primero (⚙️) la <b>URL /exec</b> de tu planilla.</div>'}
    <p class="note" style="text-align:center;margin-bottom:16px">Última actualización: ${new Date().toLocaleTimeString('es-CL')}</p>
  </div></div>`;

  $('#kGen').onclick = () => cfgOk ? renderGenerales() : needCfg();
  $('#kDer').onclick = () => cfgOk ? renderDerivados() : needCfg();
  $('#kNo').onclick = () => cfgOk ? renderLista('novis') : needCfg();
  $('#kBit').onclick = () => cfgOk ? renderBitacora() : needCfg();
  $('#kEm').onclick = () => cfgOk ? renderEmergencias() : needCfg();
  $('#aCfg').onclick = () => askPin(renderConfig);

  if (cfgOk && !ALL.length) { refreshData(false).then(() => { if (currentView === 'home') renderHome(); }); }
}
function needCfg() { toast('Primero configura la URL /exec'); askPin(renderConfig); }
function flamesHTML() {
  // llamas + brasas posicionadas a lo ancho del botón
  let h = '';
  const xs = [12, 26, 42, 58, 74, 88];
  xs.forEach((x, i) => { h += `<div class="flame ${i % 3 === 0 ? 'f2' : i % 3 === 1 ? 'f3' : ''}" style="left:${x}%"></div>`; });
  for (let i = 0; i < 6; i++) h += `<div class="flame ember" style="left:${10 + i * 15}%;animation-delay:${i * .4}s"></div>`;
  return h;
}

/* rerender del KPI en vivo (bump al cambiar) */
function rerenderCurrent() {
  if (currentView === 'home') { updateHomeNumbers(); }
  else if (currentView === 'generales') renderGenerales(true);
  else if (currentView === 'derivados') renderDerivados(true);
  else if (currentView === 'emergencias') renderEmergencias(true);
  else if (currentView === 'lista') renderLista(listaTipo, true);
  else if (currentView === 'establecimiento' && curEst) openEstablecimiento(curEst, true);
}
function bumpNum(id, val) {
  const el = $('#' + id); if (!el) return;
  if (el.textContent !== String(val)) { el.textContent = val; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}
function updateHomeNumbers() {
  const act = activos(ALL);
  bumpNum('nGen', act.filter(r => estadoDe(r).k !== 'fin').length);
  bumpNum('nDer', act.filter(r => estadoDe(r).k === 'der').length);
  bumpNum('nNo', act.filter(r => estadoDe(r).k === 'pend').length);
  const emergActivas = act.filter(r => esEmergencia(r) && estadoDe(r).k !== 'fin').length;
  bumpNum('nEm', emergActivas);
  const kEm = $('#kEm'); if (kEm) kEm.classList.toggle('active', emergActivas > 0);
}

/* ---------------------------- PIN ---------------------------- */
function askPin(onOk) {
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; let entered = '';
  content.innerHTML = `<div class="screen"><div style="flex:1;display:flex;align-items:center;justify-content:center">
    <div class="card" style="max-width:340px;width:100%">
      <div class="eyebrow"><b>Configuración</b></div>
      <h2 class="q" style="text-align:center;margin-bottom:4px">Ingresa la clave</h2>
      <div class="pin-dots" id="pinDots">${'<i></i>'.repeat(9)}</div>
      <div class="pin-grid" id="pinGrid">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pin-key" data-k="${n}">${n}</button>`).join('')}
        <button class="pin-key" data-k="del">⌫</button><button class="pin-key" data-k="0">0</button><button class="pin-key" data-k="ok" style="background:var(--grad);color:#fff">✓</button>
      </div>
    </div></div></div>`;
  const dots = () => $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < entered.length));
  const check = () => { if (entered === CFG_PIN) onOk(); else { toast('Clave incorrecta'); entered = ''; dots(); } };
  $$('#pinGrid .pin-key').forEach(b => b.onclick = () => { const k = b.dataset.k; if (k === 'del') entered = entered.slice(0, -1); else if (k === 'ok') return check(); else if (entered.length < 9) entered += k; dots(); if (entered.length === 9) check(); });
}

/* --------------------------- CONFIG -------------------------- */
function renderConfig() {
  showNav(true); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto"><div class="card">
    <div class="eyebrow"><b>Configuración</b></div><h2 class="q">Conexión</h2>
    <div class="banner">Pega la URL de tu <b>Apps Script v4</b> (termina en <code>/exec</code>). Es la misma planilla que usan los encargados.</div>
    <div class="field-block"><label class="fld">URL del Apps Script (/exec)</label><input type="url" id="cfgUrl" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(CFG.sheetUrl || '')}"></div>
    <div class="field-block"><label class="fld">Notificaciones de emergencia</label>
      <button class="btn blue" id="btnNotif" style="width:100%">${('Notification' in window && Notification.permission === 'granted') ? '✓ Permiso concedido' : 'Activar notificaciones'}</button>
      <p class="note">Con la app abierta (aunque sea en otra pestaña) recibes aviso al llegar una emergencia. Para avisos con la app <b>cerrada</b>, configura tu servidor de push abajo (guía en el README).</p>
    </div>
    <div class="field-block"><label class="fld">Servidor de push (opcional · app cerrada)</label>
      <input type="url" id="cfgPush" placeholder="https://tu-celular-o-vps:8080" value="${esc(CFG.pushUrl || '')}">
      <button class="btn blue" id="btnPush" style="width:100%;margin-top:8px">${CFG.pushOn ? '✓ Suscrito a push' : 'Suscribirse al servidor'}</button>
      <p class="note">Pega la URL de tu push server (Termux en tu celular o un VPS). Al suscribirte, recibirás emergencias aunque la app esté cerrada.</p>
    </div>
    <div class="field-block"><label class="fld">Técnicos (para derivar)</label>
      <div id="tecBox"><div class="loading"><span class="spinner"></span></div></div>
      <div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="tecNew" placeholder="Nombre del técnico"><button class="btn accent" id="tecAdd" style="flex:0 0 auto;min-width:80px">Agregar</button></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="eyebrow"><b>Reporte</b></div><h2 class="q">Exportar a Excel</h2>
    <div class="banner">Genera un Excel con todos los casos del período: resumen con KPIs + una hoja por establecimiento. Incluye estado, encargado, fechas, técnico, comentarios y links de verificadores.</div>
    <div style="display:flex;gap:10px">
      <div class="field-block" style="flex:1"><label class="fld">Desde</label><input type="date" id="repDesde"></div>
      <div class="field-block" style="flex:1"><label class="fld">Hasta</label><input type="date" id="repHasta"></div>
    </div>
    <button class="btn green" id="btnReporte" style="width:100%">📊 Generar y descargar Excel</button>
    <p class="note" id="repNote">El rango filtra por fecha de subida del caso. Déjalo vacío para incluir todo.</p>
  </div></div></div>`;
  // restaurar navwrap si fue modificado por openCase
  navwrap.querySelector('.inner').innerHTML = `<button class="btn ghost" id="btnBack">‹</button><button class="btn accent" id="btnNext">Continuar</button>`;
  $('#btnBack').onclick = renderHome; $('#btnNext').textContent = 'Guardar'; $('#btnNext').disabled = false; $('#btnNext').className = 'btn accent';
  $('#btnNext').onclick = () => {
    const url = $('#cfgUrl').value.trim();
    if (url && !/^https:\/\/script\.google\.com\/.*\/exec$/.test(url)) { if (!confirm('La URL no parece /exec. ¿Guardar igual?')) return; }
    const push = $('#cfgPush').value.trim();
    saveCfg(Object.assign({}, CFG, { sheetUrl: url, pushUrl: push })); toast('Configuración guardada');
    refreshData(false).then(() => { fetchCoords(true); renderHome(); startPolling(); });
  };
  $('#btnNotif').onclick = async () => { await askNotifPermission(); renderConfig(); };
  $('#btnPush').onclick = async () => {
    const push = $('#cfgPush').value.trim();
    if (!push) { toast('Pega primero la URL del servidor'); return; }
    saveCfg(Object.assign({}, CFG, { pushUrl: push }));
    $('#btnPush').innerHTML = '<span class="spinner"></span>';
    const ok = await subscribePush();
    toast(ok ? 'Suscrito ✓ recibirás push aunque cierres la app' : 'No se pudo suscribir (revisa el servidor)', 3200);
    renderConfig();
  };
  $('#tecAdd').onclick = async () => {
    const n = $('#tecNew').value.trim(); if (!n) { toast('Escribe un nombre'); return; }
    $('#tecAdd').innerHTML = '<span class="spinner"></span>';
    const r = await postAction({ accion: 'tecnicoAdd', nombre: n });
    if (r && r.ok) { TECNICOS = r.tecnicos || TECNICOS; toast('Técnico agregado'); } else toast('No se pudo agregar');
    renderConfig();
  };
  // reporte: rango por defecto = mes actual
  const _now = new Date();
  const _ini = new Date(_now.getFullYear(), _now.getMonth(), 1);
  if ($('#repDesde')) $('#repDesde').value = _ini.toISOString().slice(0, 10);
  if ($('#repHasta')) $('#repHasta').value = _now.toISOString().slice(0, 10);
  const btnRep = $('#btnReporte');
  if (btnRep) btnRep.onclick = () => generarReporteExcel($('#repDesde').value, $('#repHasta').value);
  paintTecnicos();
}

/* ============================================================
   REPORTE EXCEL — resumen con KPIs + una hoja por establecimiento
   ============================================================ */
function ensureXLSX() {
  return new Promise(resolve => {
    if (window.XLSX) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
}
function fechaEnRango(r, desde, hasta) {
  const ts = tsOf(r);
  if (!ts) return true;
  if (desde) { const d = new Date(desde + 'T00:00:00').getTime(); if (ts < d) return false; }
  if (hasta) { const h = new Date(hasta + 'T23:59:59').getTime(); if (ts > h) return false; }
  return true;
}
function linksVerif(txt) {
  if (!txt) return '';
  const urls = String(txt).split('\n').map(l => (l.match(/(https?:\/\/[^\s]+)/) || [])[1]).filter(Boolean);
  return urls.join(' | ');
}
async function generarReporteExcel(desde, hasta) {
  const btn = $('#btnReporte'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generando…'; }
  try {
    await ensureXLSX();
    if (!window.XLSX) { toast('No se pudo cargar el generador de Excel'); if (btn) { btn.disabled = false; btn.textContent = '📊 Generar y descargar Excel'; } return; }
    const casos = ALL.filter(r => !isBorrado(r) && fechaEnRango(r, desde, hasta));
    if (!casos.length) { toast('No hay casos en ese rango'); if (btn) { btn.disabled = false; btn.textContent = '📊 Generar y descargar Excel'; } return; }

    const esSol = r => estadoDe(r).k === 'fin';
    const estadoTxt = r => esSol(r) ? 'Solucionado' : 'No solucionado';
    const wb = XLSX.utils.book_new();

    // ---------- Hoja RESUMEN ----------
    const totalCasos = casos.length;
    const solucionados = casos.filter(esSol).length;
    const noSol = totalCasos - solucionados;
    const emergencias = casos.filter(esEmergencia).length;
    const nEst = new Set(casos.map(r => r.rbd)).size;
    const nEnc = new Set(casos.map(r => r.encargado).filter(Boolean)).size;
    const porTec = {};
    casos.filter(esSol).forEach(r => { const t = (r.solucionadoPor || r.derivadoA || 'Sin asignar').trim(); porTec[t] = (porTec[t] || 0) + 1; });

    const resumen = [
      ['REPORTE SOSER · PROGRAMA DE ALIMENTACIÓN ESCOLAR'],
      ['Período', (desde || 'inicio') + ' a ' + (hasta || 'hoy')],
      ['Generado', new Date().toLocaleString('es-CL')],
      [],
      ['INDICADORES GENERALES'],
      ['Total de casos', totalCasos],
      ['Casos solucionados', solucionados],
      ['Casos no solucionados', noSol],
      ['% resolución', totalCasos ? Math.round(solucionados / totalCasos * 100) + '%' : '0%'],
      ['Emergencias', emergencias],
      ['Establecimientos involucrados', nEst],
      ['Encargados que reportaron', nEnc],
      [],
      ['CASOS SOLUCIONADOS POR TÉCNICO'],
      ['Técnico', 'Casos solucionados']
    ];
    Object.keys(porTec).sort((a, b) => porTec[b] - porTec[a]).forEach(t => resumen.push([t, porTec[t]]));

    const wsR = XLSX.utils.aoa_to_sheet(resumen);
    wsR['!cols'] = [{ wch: 40 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, wsR, 'Resumen');

    // ---------- Una hoja por establecimiento ----------
    const byEst = {};
    for (const r of casos) { const k = String(r.rbd); (byEst[k] = byEst[k] || []).push(r); }
    const cols = ['ID', 'Fecha subida', 'Categoría', 'Descripción', 'Estado', 'Encargado', 'Derivado a', 'Solucionado por', 'Fecha solución', 'Tiempo resolución', 'Criticidad', 'Comentario técnico', 'Verificadores encargado', 'Verificadores técnico'];
    const usados = {};
    Object.keys(byEst).sort((a, b) => byEst[b].length - byEst[a].length).forEach(rbd => {
      const grupo = byEst[rbd].slice().sort((a, b) => tsOf(b) - tsOf(a));
      const nom = grupo[0].establecimiento || (estByRbd(rbd) || {}).nom || ('RBD ' + rbd);
      const filas = [cols];
      grupo.forEach(r => filas.push([
        r.id || '', r.fecha || '', r.categoria || '', r.descripcion || '',
        estadoTxt(r), r.encargado || '', r.derivadoA || '', r.solucionadoPor || '',
        r.fechaSolucionado || '', r.tiempoResolucion || '', r.criticidad || '',
        r.comentarioTecnico || '', linksVerif(r.verificadores), linksVerif(r.verificadoresTecnico)
      ]));
      const ws = XLSX.utils.aoa_to_sheet(filas);
      ws['!cols'] = [{ wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 34 }, { wch: 15 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 15 }, { wch: 10 }, { wch: 34 }, { wch: 40 }, { wch: 40 }];
      // nombre de hoja: RBD + nombre corto, sin caracteres inválidos, máx 31
      let sheetName = (rbd + ' ' + nom).replace(/[\\/?*\[\]:]/g, '').substring(0, 31).trim();
      while (usados[sheetName]) sheetName = sheetName.substring(0, 28) + Math.floor(Math.random() * 90 + 10);
      usados[sheetName] = true;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const nombreArch = `Reporte_SOSER_${(desde || 'inicio')}_a_${(hasta || 'hoy')}.xlsx`;
    XLSX.writeFile(wb, nombreArch);
    toast('Reporte generado ✓');
  } catch (e) {
    toast('Error al generar: ' + e.message, 3500);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Generar y descargar Excel'; }
  }
}
async function paintTecnicos() {
  const box = $('#tecBox'); if (!box) return;
  if (!TECNICOS.length) { const t = await fetchTecnicos(); if (t) TECNICOS = t; }
  if (!TECNICOS.length) { box.innerHTML = `<p class="note">Aún no hay técnicos. Agrega el primero abajo.</p>`; return; }
  box.innerHTML = TECNICOS.map(t => `<div class="tec-item"><span class="tn">${esc(t)}</span><button class="trm" data-t="${esc(t)}" title="Quitar">🗑️</button></div>`).join('');
  $$('#tecBox .trm').forEach(b => b.onclick = async () => {
    if (!confirm('¿Quitar a ' + b.dataset.t + ' de la lista?')) return;
    const r = await postAction({ accion: 'tecnicoDel', nombre: b.dataset.t });
    if (r && r.ok) { TECNICOS = r.tecnicos || TECNICOS; toast('Técnico quitado'); }
    paintTecnicos();
  });
}

/* ============================================================
   GENERALES — mapa de densidad + lista + buscador
   ============================================================ */
let genSub = 'lista';   // 'lista' | 'mapa'
let mapObj = null, mapLayer = null;
let genKpi = null;      // null | 'act' | 'der' | 'novis' — filtro por KPI en la lista

function renderGenerales(keep) {
  currentView = 'generales';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Generales';
  if (!keep) { genSub = 'lista'; genKpi = null; mapPicked = []; }

  const act = activos(ALL);
  const total = act.filter(r => estadoDe(r).k !== 'fin').length;
  const pendientes = act.filter(r => { const k = estadoDe(r).k; return k === 'pend' || k === 'vis' || k === 'der'; }).length;
  const solucionados = act.filter(r => estadoDe(r).k === 'fin').length;
  const esMapa = genSub === 'mapa';

  content.innerHTML = `<div class="screen">
    ${esMapa ? `<div class="search-wrap" id="mapSearchWrap">
      <span class="ic-lead">🔎</span>
      <input type="text" id="mapQ" placeholder="Buscar establecimiento o RBD…" autocomplete="off">
      <button class="clearbtn hidden" id="mapClr">✕</button>
      <div class="suggest hidden" id="mapSug"></div>
    </div>` : `<div class="search-wrap" id="genSearchWrap">
      <span class="ic-lead">🔎</span>
      <input type="text" id="genQ" placeholder="Buscar establecimiento o RBD…" autocomplete="off">
      <button class="clearbtn hidden" id="genClr">✕</button>
      <div class="suggest hidden" id="genSug"></div>
    </div>`}
    <div class="seg">
      <button data-s="lista" class="${genSub === 'lista' ? 'sel' : ''}">Casos por fecha</button>
      <button data-s="mapa" class="${genSub === 'mapa' ? 'sel' : ''}">Densidad de casos</button>
    </div>
    ${esMapa ? `<div id="mapPicked"></div>
      <div class="quad-row">
        ${[1,2,3,4].map(q => `<button class="qchip ${quadFilter.includes(q) ? 'on' : ''}" data-q="${q}">${q}/4</button>`).join('')}
        <label class="chk-solo"><input type="checkbox" id="chkSoloCasos" ${showOnlyCases ? 'checked' : ''}> Solo con casos</label>
      </div>` : ''}
    ${esMapa ? '' : `<div class="mkpis">
      <button class="mkpi ${genKpi === 'act' ? 'ksel' : ''}" data-k="act"><div class="bar"></div><div class="n">${total}</div><div class="l">Activos</div></button>
      <button class="mkpi b ${genKpi === 'pend' ? 'ksel' : ''}" data-k="pend"><div class="bar"></div><div class="n">${pendientes}</div><div class="l">Pendientes</div></button>
      <button class="mkpi g ${genKpi === 'fin' ? 'ksel' : ''}" data-k="fin"><div class="bar"></div><div class="n">${solucionados}</div><div class="l">Solucionados</div></button>
    </div>`}
    ${!esMapa && genKpi ? `<div class="kpi-filter-note">Filtrando: <b>${genKpi === 'act' ? 'activos' : (genKpi === 'pend' ? 'pendientes' : 'solucionados')}</b> · <span id="clrGenKpi" style="text-decoration:underline;cursor:pointer">quitar</span></div>` : ''}
    <div id="genBody" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">${esMapa ? `<div class="mapwrap" id="mapwrap"><div id="map"></div>${mapLegend()}</div>${mapDistPanel()}` : `<div class="caselist" id="genList"></div>`}</div>
  </div>`;

  $$('.seg button').forEach(b => b.onclick = () => { genSub = b.dataset.s; genKpi = null; mapPicked = []; renderGenerales(true); });
  $$('.mkpi[data-k]').forEach(k => k.onclick = () => {
    genKpi = (genKpi === k.dataset.k) ? null : k.dataset.k; renderGenerales(true);
  });
  const cg = $('#clrGenKpi'); if (cg) cg.onclick = () => { genKpi = null; renderGenerales(true); };
  if (esMapa) {
    setTimeout(() => { const chk = $('#chkSoloCasos'); if (chk) chk.onchange = () => { showOnlyCases = chk.checked; if (mapObj && !mapPicked.length) drawDensity(mapObj, mapLayer); }; }, 50);
    setTimeout(() => {
      $$('.qchip[data-q]').forEach(b => b.onclick = () => {
        const q = +b.dataset.q;
        if (quadFilter.includes(q)) { if (quadFilter.length > 1) quadFilter = quadFilter.filter(x => x !== q); }
        else quadFilter.push(q);
        $$('.qchip[data-q]').forEach(x => x.classList.toggle('on', quadFilter.includes(+x.dataset.q)));
        if (mapObj && !mapPicked.length) drawDensity(mapObj, mapLayer);
      });
    }, 55);
    setTimeout(() => { initMap('map'); bindMapSearch(); refreshMapView(); }, 60);
  } else {
    bindEstSearch('genQ', 'genSug', 'genClr');
    paintGenList();
  }
}
function paintGenList() {
  const box = $('#genList'); if (!box) return;
  let list = activos(ALL).slice();
  if (genKpi === 'act') list = list.filter(r => estadoDe(r).k !== 'fin');
  else if (genKpi === 'pend') list = list.filter(r => { const k = estadoDe(r).k; return k === 'pend' || k === 'vis' || k === 'der'; });
  else if (genKpi === 'fin') list = list.filter(r => estadoDe(r).k === 'fin');
  list.sort((a, b) => tsOf(b) - tsOf(a));
  box.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>${genKpi ? 'Sin casos en este filtro.' : 'Sin casos aún.'}</p></div>`;
  bindCaseCards(box, list);
}

/* tarjeta de caso reutilizable */
function caseCardHTML(r) {
  const st = estadoDe(r); const em = esEmergencia(r);
  const est = r.establecimiento || (estByRbd(r.rbd) || {}).nom || '—';
  const nver = verifList(r.verificadores).length + verifList(r.verificadoresTecnico).length;
  return `<div class="case ${em ? 'em' : ''}" data-id="${esc(r.id)}" data-enc="${esc(r.encargado)}">
    <div class="cid">${esc(r.id)}</div>
    <div class="cbody">
      <div class="ctitle">${esc(est)} · RBD ${esc(r.rbd)}</div>
      <div class="cdesc">${esc(r.descripcion || '')}</div>
      <div class="cmeta"><span>${em ? '🚨 ' : ''}${esc(r.categoria || '')}</span><span>${esc(r.fecha || '')}</span><span>👷 ${esc(r.encargado || '')}</span><span class="cstate ${em && st.k !== 'fin' ? 'em' : st.k}">${st.t}</span>${r.derivadoA ? `<span>↗ ${esc(r.derivadoA)}</span>` : ''}</div>
    </div>
    <div class="cside">
      ${em && st.k !== 'fin' ? `<div class="cflame">${miniFlame()}</div>` : ''}
      ${nver ? `<button class="cverif" data-verif="1"><span class="vic">📎</span>${nver}</button>` : ''}
    </div>
  </div>`;
}
function miniFlame() { return `<svg viewBox="0 0 24 24" width="26" height="26"><defs><linearGradient id="mf" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff5722"/><stop offset=".6" stop-color="#ff9d2f"/><stop offset="1" stop-color="#ffd24a"/></linearGradient></defs><path d="M12 2c1 3-2 4-2 7 0-1-1-2-2-2 .5 2-2 3-2 6a6 6 0 0012 0c0-4-3-5-3-8 0 2-1 3-2 3 1-4-1-6 1-9z" fill="url(#mf)"><animate attributeName="opacity" values="1;.75;1" dur="1.4s" repeatCount="indefinite"/></path></svg>`; }
function bindCaseCards(box, list) {
  $$('.case', box).forEach(c => {
    const r = list.find(x => String(x.id) === c.dataset.id && x.encargado === c.dataset.enc);
    c.onclick = e => {
      if (e.target.closest('.cverif')) { openViewer([...verifList(r.verificadores), ...verifList(r.verificadoresTecnico)]); return; }
      openCase(r);
    };
  });
}

/* -------- buscador de establecimientos con esferas -------- */
function bindEstSearch(inpId, sugId, clrId) {
  const inp = $('#' + inpId), sug = $('#' + sugId), clr = $('#' + clrId);
  if (!inp) return;
  const byRbd = casesByRbd(ALL);
  let hl = -1, cur = [];
  const paint = () => {
    const v = norm(inp.value.trim()); clr.classList.toggle('hidden', !inp.value);
    if (!v) { sug.classList.add('hidden'); return; }
    cur = ESTS.filter(e => norm(e.nom).includes(v) || e.rbd.includes(v))
      .sort((a, b) => (byRbd[b.rbd] || []).length - (byRbd[a.rbd] || []).length || a.nom.localeCompare(b.nom))
      .slice(0, 20);
    if (!cur.length) { sug.innerHTML = `<div class="sopt"><div class="stxt">Sin coincidencias</div></div>`; sug.classList.remove('hidden'); return; }
    sug.innerHTML = cur.map((e, i) => {
      const cs = byRbd[e.rbd] || [];
      return `<div class="sopt" data-i="${i}"><div class="stxt">${esc(e.nom)}<small>RBD ${esc(e.rbd)} · ${esc(e.com)}</small></div>${orbsHTML(cs)}</div>`;
    }).join('');
    sug.classList.remove('hidden'); hl = -1;
    $$('#' + sugId + ' .sopt[data-i]').forEach(d => d.onclick = () => openEstablecimiento(cur[+d.dataset.i]));
  };
  inp.addEventListener('input', paint);
  inp.addEventListener('keydown', e => {
    const it = $$('#' + sugId + ' .sopt[data-i]'); if (!it.length) return;
    if (e.key === 'ArrowDown') hl = Math.min(hl + 1, it.length - 1);
    else if (e.key === 'ArrowUp') hl = Math.max(hl - 1, 0);
    else if (e.key === 'Enter' && hl >= 0) { openEstablecimiento(cur[hl]); return; }
    else return;
    it.forEach((d, i) => d.classList.toggle('hl', i === hl)); e.preventDefault();
  });
  clr.onclick = () => { inp.value = ''; clr.classList.add('hidden'); sug.classList.add('hidden'); inp.focus(); };
}
/* esferas: gris si todo solucionado, colores si hay activos; máx 4 + contador */
function orbsHTML(cases) {
  if (!cases.length) return `<div class="orbs"><span class="orb g"></span><span class="orbcount">0</span></div>`;
  const lvl = levelFor(cases);
  const act = cases.filter(r => estadoDe(r).k !== 'fin').length;
  const dots = Math.min(4, cases.length);
  let cls = lvl.cls;
  let html = '';
  for (let i = 0; i < dots; i++) html += `<span class="orb ${act ? cls : 'g'}"></span>`;
  html += `<span class="orbcount">${cases.length}</span>`;
  return `<div class="orbs">${html}</div>`;
}

/* ============================================================
   MAPA (Leaflet) — círculos en metros que escalan con el zoom
   ============================================================ */
function mapLegend() {
  return `<div class="map-legend">
    <div class="li"><span class="dot" style="background:#F2C230"></span>1–2 casos</div>
    <div class="li"><span class="dot" style="background:#F49A0F"></span>3–5 casos</div>
    <div class="li"><span class="dot" style="background:#7B2FBE"></span>6+ convergencia</div>
    <div class="li"><span class="dot" style="background:#CE4257"></span>Emergencia</div>
    <div class="li"><span class="dot" style="background:#C4C4BE"></span>Sin casos activos</div>
  </div>`;
}
function initMap(elId, opts) {
  opts = opts || {};
  const el = document.getElementById(elId); if (!el || typeof L === 'undefined') return null;
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([SANTIAGO.lat, SANTIAGO.lon], opts.zoom || SANTIAGO.zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  if (opts.single) drawSingle(map, layer, opts.single);
  else drawDensity(map, layer);
  if (!opts.single && !opts.noStore) { mapObj = map; mapLayer = layer; }
  setTimeout(() => map.invalidateSize(), 120);
  return map;
}
/* radio en metros -> escala solo con el zoom. Base 90m + 45m por caso, tope 900m. */
function radiusMeters(n) { return Math.min(1400, 200 + n * 120); }  // más notorio
function pinIconHTML(lvl) {
  const c = lvl.color || '#888';
  return `<div style="display:flex;flex-direction:column;align-items:center;cursor:pointer">
    <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 9.8 14 22 14 22S28 23.8 28 14C28 6.27 21.73 0 14 0z" fill="${c}" stroke="white" stroke-width="1.5"/>
      <circle cx="14" cy="14" r="5" fill="white" opacity="0.9"/>
    </svg>
  </div>`;
}
let showOnlyCases = false;
let quadFilter = [1, 2, 3, 4];   // cuadrantes visibles (por defecto todos)

/* Divide los establecimientos en 4 cuadrantes equilibrados usando las medianas
   de latitud y longitud, así cada cuadrante tiene ~la misma cantidad de puntos.
   Cuadrantes: 1=NO, 2=NE, 3=SO, 4=SE (según medianas). */
function quadBounds() {
  const lats = [], lons = [];
  for (const e of ESTS) { const co = coordOf(e.rbd); if (co) { lats.push(co.lat); lons.push(co.lon); } }
  if (!lats.length) return null;
  lats.sort((a, b) => a - b); lons.sort((a, b) => a - b);
  const mid = arr => arr[Math.floor(arr.length / 2)];
  return { latMid: mid(lats), lonMid: mid(lons) };
}
function quadOf(co, qb) {
  if (!qb || !co) return 0;
  const norte = co.lat >= qb.latMid;   // lat mayor = más al norte
  const este = co.lon >= qb.lonMid;    // lon mayor (menos negativa) = más al este
  if (norte && !este) return 1;  // NO
  if (norte && este) return 2;   // NE
  if (!norte && !este) return 3; // SO
  return 4;                      // SE
}
function drawDensity(map, layer) {
  layer.clearLayers();
  const byRbd = casesByRbd(ALL);
  const bounds = [];
  const qb = quadBounds();
  const enQuad = co => quadFilter.length === 4 || quadFilter.includes(quadOf(co, qb));
  // todos los establecimientos base (pines grises sin casos)
  if (!showOnlyCases) {
    for (const est of ESTS) {
      const co = coordOf(est.rbd); if (!co) continue;
      if (byRbd[est.rbd]) continue; // los con casos se dibujan abajo
      if (!enQuad(co)) continue;
      const icon = L.divIcon({ className: '', html: pinIconHTML({color:'#AAAAAA'}), iconSize: [28,36], iconAnchor: [14,36] });
      const mk = L.marker([co.lat, co.lon], { icon, zIndexOffset: 0 }).addTo(layer);
      mk.bindPopup(gmapsPopup(est, est.rbd, co, null), { maxWidth: 260, autoPan: true });
      mk.on('popupopen', e => bindPopup(e, est.rbd));
      bounds.push([co.lat, co.lon]);
    }
  }
  // establecimientos con casos
  for (const rbd in byRbd) {
    const cs = byRbd[rbd]; const co = coordOf(rbd); if (!co) continue;
    if (!enQuad(co)) continue;
    const lvl = levelFor(cs);
    const n = lvl.n || cs.length;
    const estObj = estByRbd(rbd) || {};
    const est = estObj.nom || cs[0].establecimiento || 'Establecimiento';
    const act = cs.filter(r => estadoDe(r).k !== 'fin').length;
    const emerg = cs.some(r => esEmergencia(r) && estadoDe(r).k !== 'fin');
    // círculo de área
    L.circle([co.lat, co.lon], {
      radius: radiusMeters(n), color: lvl.color, fillColor: lvl.color,
      weight: 3, opacity: 1, fillOpacity: 0.35
    }).addTo(layer);
    // pin con ícono de ubicación
    const icon = L.divIcon({ className: '', html: pinIconHTML(lvl), iconSize: [28,36], iconAnchor: [14,36] });
    const mk = L.marker([co.lat, co.lon], { icon, zIndexOffset: 100 }).addTo(layer);
    mk.bindPopup(gmapsPopup(estObj, rbd, co, { color: lvl.color, act, total: cs.length, emerg }), { maxWidth: 260, autoPan: true });
    mk.on('popupopen', e => bindPopup(e, rbd));
    bounds.push([co.lat, co.lon]);
  }
  if (bounds.length) { try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 }); } catch (e) {} }
}
/* Popup tipo Google Maps: nombre, dirección, ruta, link a Maps y ver establecimiento */
function gmapsPopup(estObj, rbd, co, info) {
  const nom = estObj.nom || 'Establecimiento';
  const dirVis = dirCompleta(rbd, estObj.dir).replace(', Región Metropolitana, Chile', '');
  const ruta = rutaDe(rbd);
  const gmaps = mapsUrl(rbd, estObj.dir, nom);   // mismo criterio que el detalle del caso
  const casesTxt = info ? `<div class="popup-cases" style="color:${info.color}">${info.emerg ? '🚨 Emergencia activa · ' : ''}${info.act} activo(s) · ${info.total} total</div>` : '';
  return `<div class="gmp">
    <div class="gmp-nom">${esc(nom)}</div>
    <div class="gmp-meta">RBD ${esc(rbd)}${ruta ? ' · ' + esc(ruta) : ''}</div>
    ${dirVis ? `<div class="gmp-dir">📍 ${esc(dirVis)}</div>` : ''}
    ${casesTxt}
    <div class="gmp-actions">
      <a href="${gmaps}" target="_blank" rel="noopener" class="gmp-btn maps">🗺️ ${isAppleDevice() ? 'Apple Maps' : 'Google Maps'}</a>
      <a href="#" data-rbd="${esc(rbd)}" class="gmp-btn open popup-open">Ver establecimiento ›</a>
    </div>
  </div>`;
}
function bindPopup(e, rbd) {
  const el = e.popup.getElement();
  const a = el ? el.querySelector('.popup-open') : null;
  if (a) a.onclick = ev => { ev.preventDefault(); const e2 = estByRbd(rbd); if (e2) openEstablecimiento(e2); };
}
function drawSingle(map, layer, rbd) {
  layer.clearLayers();
  const co = coordOf(rbd); const estObj = estByRbd(rbd) || {}; const est = estObj.nom || 'Establecimiento';
  if (!co) return;
  const cs = (casesByRbd(ALL)[rbd]) || [];
  const lvl = levelFor(cs); const n = lvl.n || cs.length;
  L.circle([co.lat, co.lon], { radius: radiusMeters(Math.max(n,1)), color: lvl.color, fillColor: lvl.color, weight: 3, opacity: 1, fillOpacity: 0.35 }).addTo(layer);
  const icon = L.divIcon({ className: '', html: pinIconHTML(lvl), iconSize: [28,36], iconAnchor: [14,36] });
  const mk = L.marker([co.lat, co.lon], { icon }).addTo(layer);
  mk.bindPopup(`<b>${esc(est)}</b><br>RBD ${esc(rbd)}<div class="popup-cases" style="color:${lvl.color}">${n} caso(s) activo(s)</div>`).openPopup();
  map.setView([co.lat, co.lon], 16);
}
/* Mapa a pantalla completa: REMOVIDO (daba pantalla en blanco).
   El mapa ya ocupa toda el área disponible en la vista de densidad. */

/* ============================================================
   MAPA: buscador de establecimiento + distancia por ruta (OSRM)
   ============================================================ */
/* Factor de tráfico urbano: OSRM calcula con flujo libre; en Santiago el trayecto
   real en horario normal toma bastante más. 1.45 es un ajuste conservador. */
const TRAFICO_URBANO = 1.45;
let mapPicked = [];          // 1 o 2 establecimientos elegidos en el mapa
let mapDistances = {};       // caché en memoria { "rbdA-rbdB": {km,min} }

function mapDistPanel() { return `<div id="mapDistPanel"></div>`; }

function bindMapSearch() {
  const inp = $('#mapQ'), sug = $('#mapSug'), clr = $('#mapClr');
  if (!inp) return;
  const paint = () => {
    const v = norm(inp.value.trim()); if (clr) clr.classList.toggle('hidden', !inp.value);
    if (!v) { sug.classList.add('hidden'); return; }
    const cur = ESTS.filter(e => norm(e.nom).includes(v) || String(e.rbd).includes(v)).slice(0, 20);
    sug.innerHTML = cur.length ? cur.map(e => {
      const n = (casesByRbd(ALL)[e.rbd] || []).length;
      const badge = n ? `<small style="color:var(--orange-d)">${n} caso(s)</small>` : `<small>sin casos</small>`;
      return `<div class="sopt" data-rbd="${esc(e.rbd)}"><div class="stxt">${esc(e.nom)}<small>RBD ${esc(e.rbd)} · ${esc(e.com)}</small></div>${badge}</div>`;
    }).join('') : `<div class="sopt"><div class="stxt">Sin coincidencias</div></div>`;
    sug.classList.remove('hidden');
    $$('#mapSug .sopt[data-rbd]').forEach(d => d.onclick = () => {
      const e = estByRbd(d.dataset.rbd);
      if (e && !mapPicked.some(p => p.rbd === e.rbd)) {
        if (mapPicked.length >= 2) mapPicked = [mapPicked[mapPicked.length - 1]];
        mapPicked.push(e);
      }
      inp.value = ''; sug.classList.add('hidden'); if (clr) clr.classList.add('hidden');
      refreshMapView();
    });
  };
  inp.addEventListener('input', paint);
  inp.addEventListener('focus', paint);
  if (clr) clr.onclick = () => { inp.value = ''; sug.classList.add('hidden'); clr.classList.add('hidden'); inp.focus(); };
}
function paintMapPicked() {
  const box = $('#mapPicked'); if (!box) return;
  if (!mapPicked.length) { box.innerHTML = ''; return; }
  box.innerHTML = mapPicked.map((e, i) => `<div class="picked-chip">
      <span class="pc-dot" style="background:${i === 0 ? '#F49A0F' : '#1769AA'}"></span>
      <span class="pc-nom">${esc(e.nom)}</span>
      <button class="pc-rm" data-i="${i}">✕</button>
    </div>`).join('') +
    (mapPicked.length === 1 ? `<a href="#" id="addSecond" class="add-second">+ Agregar otro establecimiento para medir distancia</a>` : '') +
    `<a href="#" id="clearPicked" class="add-second" style="color:var(--muted)">Ver todos los establecimientos</a>`;
  $$('#mapPicked .pc-rm').forEach(b => b.onclick = () => { mapPicked.splice(+b.dataset.i, 1); refreshMapView(); });
  const a2 = $('#addSecond'); if (a2) a2.onclick = ev => { ev.preventDefault(); const inp = $('#mapQ'); if (inp) inp.focus(); };
  const cp = $('#clearPicked'); if (cp) cp.onclick = ev => { ev.preventDefault(); mapPicked = []; refreshMapView(); };
}
function refreshMapView() {
  paintMapPicked();
  if (!mapObj || !mapLayer) return;
  const distPanel = $('#mapDistPanel');
  if (mapPicked.length === 0) { drawDensity(mapObj, mapLayer); if (distPanel) distPanel.innerHTML = ''; return; }
  mapLayer.clearLayers();
  const pts = [];
  mapPicked.forEach((e, i) => {
    const co = coordOf(e.rbd); if (!co) return;
    const cs = casesByRbd(ALL)[e.rbd] || [];
    const lvl = cs.length ? levelFor(cs) : { color: i === 0 ? '#F49A0F' : '#1769AA' };
    L.circle([co.lat, co.lon], { radius: radiusMeters(Math.max(cs.length, 1)), color: lvl.color, fillColor: lvl.color, weight: 3, opacity: 1, fillOpacity: 0.3 }).addTo(mapLayer);
    const icon = L.divIcon({ className: '', html: pinIconHTML(lvl), iconSize: [28, 36], iconAnchor: [14, 36] });
    const mk = L.marker([co.lat, co.lon], { icon, zIndexOffset: 200 }).addTo(mapLayer);
    mk.bindPopup(gmapsPopup(e, e.rbd, co, cs.length ? { color: lvl.color, act: cs.filter(r => estadoDe(r).k !== 'fin').length, total: cs.length, emerg: false } : null), { maxWidth: 260 });
    mk.on('popupopen', ev => bindPopup(ev, e.rbd));
    pts.push([co.lat, co.lon]);
  });
  if (pts.length === 1) { mapObj.setView(pts[0], 15); if (distPanel) distPanel.innerHTML = ''; }
  else if (pts.length === 2) {
    L.polyline(pts, { color: '#333', weight: 3, dashArray: '6 6', opacity: .7 }).addTo(mapLayer);
    try { mapObj.fitBounds(pts, { padding: [60, 60], maxZoom: 15 }); } catch (e) {}
    calcularDistancia(mapPicked[0], mapPicked[1]);
  }
}
async function calcularDistancia(a, b) {
  const panel = $('#mapDistPanel'); if (!panel) return;
  const key = a.rbd + '-' + b.rbd, keyR = b.rbd + '-' + a.rbd;
  const cached = mapDistances[key] || mapDistances[keyR];
  if (cached) { paintDist(a, b, cached); return; }
  panel.innerHTML = `<div class="dist-card"><span class="spinner"></span> Calculando distancia en auto…</div>`;
  const ca = coordOf(a.rbd), cb = coordOf(b.rbd);
  if (!ca || !cb) { panel.innerHTML = `<div class="dist-card err">Sin coordenadas para uno de los establecimientos.</div>`; return; }
  let dist = null;
  try {
    const r = await fetch(CFG.sheetUrl + '?distancia=1&a=' + encodeURIComponent(a.rbd) + '&b=' + encodeURIComponent(b.rbd) + '&t=' + Date.now());
    const d = await r.json();
    if (d && d.ok && d.encontrada) dist = { km: d.km, min: d.min, fuente: 'guardada' };
  } catch (e) {}
  if (!dist) {
    // Ruteo por CALLE real (no línea recta). Se prueban dos servidores públicos gratuitos.
    const servidores = [
      `https://router.project-osrm.org/route/v1/driving/${cb.lon},${cb.lat};${ca.lon},${ca.lat}?overview=false`,
      `https://routing.openstreetmap.de/routed-car/route/v1/driving/${cb.lon},${cb.lat};${ca.lon},${ca.lat}?overview=false`
    ];
    for (const url of servidores) {
      try {
        const r = await fetch(url);
        const d = await r.json();
        if (d && d.routes && d.routes[0]) {
          const km = +(d.routes[0].distance / 1000).toFixed(1);
          const minLibre = d.routes[0].duration / 60;          // OSRM asume flujo libre
          const min = Math.max(1, Math.round(minLibre * TRAFICO_URBANO));  // ajuste a tráfico urbano real
          dist = { km, min, minLibre: Math.round(minLibre), fuente: 'osrm' };
          postAction({ accion: 'guardarDistancia', rbdA: a.rbd, nomA: a.nom, rbdB: b.rbd, nomB: b.nom, km, min });
          break;
        }
      } catch (e) {}
    }
  }
  if (!dist) {
    // último recurso: distancia en línea recta (Haversine), avisando que NO es por calle
    const R = 6371, toRad = x => x * Math.PI / 180;
    const dLat = toRad(cb.lat - ca.lat), dLon = toRad(cb.lon - ca.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(ca.lat)) * Math.cos(toRad(cb.lat)) * Math.sin(dLon / 2) ** 2;
    const kmRecta = +(2 * R * Math.asin(Math.sqrt(h))).toFixed(1);
    dist = { km: kmRecta, min: Math.max(1, Math.round(kmRecta / 25 * 60 * TRAFICO_URBANO)), fuente: 'recta' };
  }
  mapDistances[key] = dist;
  paintDist(a, b, dist);
}
function paintDist(a, b, dist) {
  const panel = $('#mapDistPanel'); if (!panel) return;
  const fuenteTxt = dist.fuente === 'guardada' ? 'Desde tu base de distancias'
    : dist.fuente === 'recta' ? '⚠ Aproximada (línea recta · sin conexión al ruteo por calle)'
    : 'Ruta real por calle · incluye ajuste por tráfico urbano';
  panel.innerHTML = `<div class="dist-card">
    <div class="dc-route"><span>${esc(a.nom)}</span> <span class="dc-arrow">→</span> <span>${esc(b.nom)}</span></div>
    <div class="dc-nums"><b>${dist.km} km</b>${dist.fuente === 'recta' ? '' : ' por calle'} · <b>~${fmtMin(dist.min)}</b> en auto</div>
    <div class="dc-src">${fuenteTxt}</div>
  </div>`;
}

/* ============================================================
   PÁGINA DE ESTABLECIMIENTO — historial + mapa de un pin
   ============================================================ */
let curEst = null, estKpi = null, bitReturn = false, curEstReturn = null;
function openEstablecimiento(est, keep) {
  curEst = est; currentView = 'establecimiento';
  if (!keep) curEstReturn = bitReturn ? 'bitacora' : (currentView === 'generales' ? 'generales' : window._prevView || 'generales');
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Establecimiento';
  const cases = (casesByRbd(ALL)[est.rbd] || []).slice().sort((a, b) => tsOf(b) - tsOf(a));
  const act = cases.filter(r => estadoDe(r).k !== 'fin').length;
  const der = cases.filter(r => estadoDe(r).k === 'der').length;
  const sol = cases.filter(r => estadoDe(r).k === 'fin').length;
  const ruta = rutaDe(est.rbd);
  if (!keep) estKpi = null;

  content.innerHTML = `<div class="screen">
    <div class="sub-nav">
      <button class="der-back" id="estBack">‹ ${bitReturn ? 'Bitácora' : 'Atrás'}</button>
      <button class="der-home" id="estHome">🏠 Inicio</button>
    </div>
    <div class="bubble-head">
      <div class="bh-top"><div class="bh-id">🏫 RBD ${esc(est.rbd)}</div><div class="bh-state">${cases.length} caso(s)</div></div>
      <h3>${esc(est.nom)}</h3>
      <div class="bh-meta"><span>${esc(est.dir || '')}</span>${ruta ? `<span>· 📍 ${esc(ruta)}</span>` : ''}${est.sup ? `<span>· ${esc(est.sup)}</span>` : ''}</div>
    </div>
    <div class="mkpis">
      <button class="mkpi ${estKpi === 'act' ? 'ksel' : ''}" data-ek="act"><div class="bar"></div><div class="n">${act}</div><div class="l">Activos</div></button>
      <button class="mkpi b ${estKpi === 'der' ? 'ksel' : ''}" data-ek="der"><div class="bar"></div><div class="n">${der}</div><div class="l">Derivados</div></button>
      <button class="mkpi g ${estKpi === 'sol' ? 'ksel' : ''}" data-ek="sol"><div class="bar"></div><div class="n">${sol}</div><div class="l">Solucionados</div></button>
    </div>
    ${estKpi ? `<div class="kpi-filter-note">Filtrando: <b>${estKpi === 'act' ? 'activos' : (estKpi === 'der' ? 'derivados' : 'solucionados')}</b> · <span id="clrEstKpi" style="text-decoration:underline;cursor:pointer">quitar</span></div>` : ''}
    <div class="verif-lbl">Historial de casos</div>
    <div class="caselist" id="estList"></div>
  </div>`;
  $('#estBack').onclick = () => { if (curEstReturn === 'bitacora' || bitReturn) { bitReturn = false; renderBitacora(); } else { renderGenerales(); } };
  $('#estHome').onclick = () => { bitReturn = false; renderHome(); };
  const paintEst = () => {
    let list = cases.slice();
    if (estKpi === 'act') list = list.filter(r => estadoDe(r).k !== 'fin');
    else if (estKpi === 'der') list = list.filter(r => estadoDe(r).k === 'der');
    else if (estKpi === 'sol') list = list.filter(r => estadoDe(r).k === 'fin');
    const box = $('#estList');
    box.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>${estKpi ? 'Sin casos en este filtro.' : 'Sin casos registrados.'}</p></div>`;
    bindCaseCards(box, list);
  };
  $$('.mkpi[data-ek]').forEach(k => k.onclick = () => { estKpi = (estKpi === k.dataset.ek) ? null : k.dataset.ek; openEstablecimiento(est, true); });
  const ce = $('#clrEstKpi'); if (ce) ce.onclick = () => { estKpi = null; openEstablecimiento(est, true); };
  paintEst();
}

/* ============================================================
   DETALLE DE CASO — burbuja + Derivar / Solucionar
   Al abrir: marca VISADO automáticamente.
   ============================================================ */
let curCase = null, caseReturn = null;
function openCase(r, from) {
  curCase = r; caseReturn = from || currentView; currentView = 'caso';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Caso ' + r.id;

  const st = estadoDe(r); const em = esEmergencia(r);
  const est = estByRbd(r.rbd) || { nom: r.establecimiento, rbd: r.rbd, dir: r.direccion, com: r.comuna };
  const yaVisado = st.k !== 'pend';
  const vEnc = verifList(r.verificadores), vTec = verifList(r.verificadoresTecnico);
  const ruta = rutaDe(r.rbd);
  const sup = supervisorDe(r.rbd);
  const dir = dirDe(r.rbd) || r.direccion || '';
  const crit = +r.criticidad || 0;

  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto;display:flex;flex-direction:column">
    <div class="bubble-head ${em ? 'em' : ''}">
      <div class="bh-top"><div class="bh-id">${esc(r.id)}</div><div class="bh-state" id="bhState">${st.t}</div></div>
      <h3>${em ? '🚨 ' : ''}${esc(est.nom || r.establecimiento)} · RBD ${esc(r.rbd)}</h3>
      <div class="bh-meta"><span>${esc(r.categoria || '')}</span><span>${esc(r.fecha || '')}</span><span>👷 ${esc(r.encargado || '')}</span></div>
      <div class="bh-desc">${esc(r.descripcion || 'Sin descripción')}</div>
    </div>

    <div class="ruta-card">
      ${ruta ? `<div class="ruta-badge">📍 Ruta: ${esc(ruta)}</div>` : ''}
      <div class="ruta-info">
        ${dir ? `<div><span class="ri-l">Dirección</span>${esc(dir)}</div>` : ''}
        ${sup ? `<div><span class="ri-l">Supervisor</span>${esc(sup)}</div>` : ''}
      </div>
    </div>

    <div class="action-bar">
      <div class="ab-row">
        <div class="ab-field">
          <label class="fld">Derivar a técnico</label>
          <select id="selTec"><option value="">— Selecciona —</option>${TECNICOS.map(t => `<option value="${esc(t)}" ${norm(r.derivadoA) === norm(t) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        </div>
        <button class="btn green ab-solve" id="btnSolve" style="min-width:110px">✓ Solucionado</button>
      </div>
      ${r.derivadoA ? `<p class="note">Actualmente derivado a <b>${esc(r.derivadoA)}</b>.</p>` : ''}
      ${r.fechaSolucionado ? `<p class="note">Solucionado el ${esc(r.fechaSolucionado)}${r.tiempoResolucion ? ' · tiempo ' + esc(r.tiempoResolucion) : ''}.</p>` : ''}

      <label class="fld" style="margin-top:12px">Índice de criticidad</label>
      <div class="crit-row" id="critRow">
        ${[1,2,3,4].map(n => `<button class="crit-box ${crit >= n ? 'on lvl'+crit : ''}" data-c="${n}">${n}</button>`).join('')}
        <span class="crit-lbl" id="critLbl">${critLabel(crit)}</span>
      </div>
    </div>

    ${vEnc.length ? `<div class="verif-lbl">Verificadores del encargado</div>
      <div class="verif-strip" id="vstripEnc">${vEnc.map((m, i) => verifThumbHTML(m, i, 'enc')).join('')}</div>` : ''}

    ${(r.solucionadoPor || r.comentarioTecnico || vTec.length) ? `<div class="tec-box">
      <div class="verif-lbl" style="margin-top:0">Trabajo del técnico${r.solucionadoPor ? ' · ' + esc(r.solucionadoPor) : ''}</div>
      ${r.comentarioTecnico ? `<div class="tec-coment">📝 ${esc(r.comentarioTecnico)}</div>` : ''}
      ${vTec.length ? `<div class="verif-strip" id="vstripTec">${vTec.map((m, i) => verifThumbHTML(m, i, 'tec')).join('')}</div>` : ''}
    </div>` : ''}

    <div class="verif-lbl">Ubicación</div>
    <div class="ubic-card">
      <div class="ub-dir">📍 ${esc(dirCompleta(r.rbd, dir).replace(', Región Metropolitana, Chile', '') || 'Sin dirección registrada')}</div>
      <a href="${mapsUrl(r.rbd, dir, est.nom)}" target="_blank" rel="noopener" class="ub-link">🗺️ Abrir en ${isAppleDevice() ? 'Apple Maps' : 'Google Maps'}</a>
    </div>
  </div></div>`;

  showNav(true);
  btnBack.className = 'btn ghost'; btnBack.textContent = '‹ Atrás';
  btnNext.className = 'btn accent'; btnNext.textContent = 'Guardar y salir'; btnNext.disabled = false;

  navwrap.querySelector('.inner').innerHTML = `
    <button class="btn ghost" id="cBack">‹</button>
    <button class="btn ghost" id="cNoSave" style="flex:1;min-width:0;color:var(--muted)">Atrás sin guardar</button>
    <button class="btn accent" id="cSave" style="flex:1.4">Guardar y salir</button>`;
  $('#cBack').onclick = () => goBackFromCase();
  $('#cNoSave').onclick = () => { toast('Sin cambios'); goBackFromCase(); };
  $('#cSave').onclick = () => { const s = $('#selTec'); saveCase(r, s ? s.value : undefined); };

  $('#btnSolve').onclick = () => openSolveModal(r);
  $$('#critRow .crit-box').forEach(b => b.onclick = () => setCriticidad(r, +b.dataset.c));

  const stripE = $('#vstripEnc');
  if (stripE) $$('.vs', stripE).forEach((el, i) => {
    el.onclick = ev => { if (ev.target.closest('.vdel')) { eliminarVerif(r, 'enc', i, vEnc); return; } openViewer(vEnc, i); };
  });
  const stripT = $('#vstripTec');
  if (stripT) $$('.vs', stripT).forEach((el, i) => {
    el.onclick = ev => { if (ev.target.closest('.vdel')) { eliminarVerif(r, 'tec', i, vTec); return; } openViewer(vTec, i); };
  });

  if (!yaVisado && !isBorrado(r)) autoVisar(r);
}
/* ===== Ubicación (link a Maps) ===== */
function isAppleDevice() { return /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent); }
/* Construye la dirección completa y normalizada de un establecimiento.
   Se usa TANTO para mostrar como para el link de Maps, así siempre coinciden. */
function dirCompleta(rbd, dirFallback) {
  const e = estByRbd(rbd) || {};
  const calle = (e.dir || dirFallback || '').toString().trim();
  const comuna = (e.com || '').toString().trim();
  if (!calle) return '';
  // normaliza abreviaturas frecuentes de la BBDD para que Maps las entienda
  let c = calle
    .replace(/\bPSJE\b\.?/gi, 'Pasaje')
    .replace(/\bAVDA\b\.?/gi, 'Avenida')
    .replace(/\bAVE\b\.?/gi, 'Avenida')
    .replace(/\bESQ\b\.?/gi, 'esquina')
    .replace(/\bPOB\b\.?/gi, 'Población')
    .replace(/\bSC\b\.?\s/gi, '')
    .replace(/\bN[°º]?\s*/gi, '')     // "N° 4867" -> "4867"
    .replace(/\s{2,}/g, ' ')
    .trim();
  return [c, comuna, 'Región Metropolitana, Chile'].filter(Boolean).join(', ');
}
/* Link a Maps: la BÚSQUEDA es la dirección real (para que coincida con la que se muestra).
   Si hay coordenadas conocidas, se usan como centro/ancla del mapa, no como destino. */
function mapsUrl(rbd, dir, nom) {
  const full = dirCompleta(rbd, dir);
  const co = coordOf(rbd);
  const q = encodeURIComponent(full || nom || 'Establecimiento');
  if (isAppleDevice()) {
    return co ? `https://maps.apple.com/?q=${q}&sll=${co.lat},${co.lon}` : `https://maps.apple.com/?q=${q}`;
  }
  // en Google Maps, query = dirección real; center mantiene el mapa en la zona correcta
  return co
    ? `https://www.google.com/maps/search/?api=1&query=${q}&center=${co.lat},${co.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}
/* ===== Criticidad (1 bajo -> 4 crítico) ===== */
function critLabel(n) { return ['Sin definir', 'Bajo', 'Medio', 'Alto', 'Crítico'][n] || 'Sin definir'; }
async function setCriticidad(r, n) {
  const nuevo = (+r.criticidad === n) ? 0 : n;
  r.criticidad = nuevo;
  $$('#critRow .crit-box').forEach(b => { const c = +b.dataset.c; b.className = 'crit-box ' + (nuevo >= c ? 'on lvl' + nuevo : ''); });
  const lbl = $('#critLbl'); if (lbl) lbl.textContent = critLabel(nuevo);
  const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado); if (a) a.criticidad = nuevo;
  postAction({ accion: 'criticidad', encargado: r.encargado, reporteId: r.id, derivadoA: r.derivadoA || '', valor: nuevo });
}
function verifThumbHTML(m, i, origen) {
  const thumb = m.driveId ? driveThumb(m.driveId) : m.url;
  return `<div class="vs" data-i="${i}">${m.type === 'video' ? `<video src="${esc(m.url)}" muted></video><div class="vt">▶ video</div>` : `<img src="${esc(thumb)}" alt="" onerror="this.style.opacity=.3"><div class="vt">foto</div>`}<button class="vdel" title="Eliminar">✕</button></div>`;
}
async function eliminarVerif(r, origen, i, lista) {
  const m = lista[i]; if (!m) return;
  if (!confirm('¿Eliminar este verificador? Se quitará del caso y de la vista de todos.')) return;
  // reconstruir la lista sin el elemento i y reescribir la celda correspondiente
  const nueva = lista.filter((_, k) => k !== i);
  const campo = origen === 'tec' ? 'verificadoresTecnico' : 'verificadores';
  const texto = nueva.map(v => `${v.type}: ${v.name || ''}${v.url ? ' -> ' + v.url : ''}`).join('\n');
  const res = await postAction({ accion: 'editarVerificadores', encargado: r.encargado, reporteId: r.id, campo, valor: texto });
  if (res && res.ok) {
    r[campo] = texto;
    const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado); if (a) a[campo] = texto;
    toast('Verificador eliminado');
    openCase(r, caseReturn);   // repintar el detalle
  } else { toast('No se pudo eliminar'); }
}
async function autoVisar(r) {
  const res = await postAction({ accion: 'visar', encargado: r.encargado, reporteId: r.id });
  if (res && res.ok) {
    r.visado = r.visado || 'VISADO';
    const bh = $('#bhState'); if (bh && estadoDe(r).t) bh.textContent = estadoDe(r).t;
    // reflejar en memoria para KPIs
    const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado); if (a) a.visado = r.visado;
  }
}
async function saveCase(r, tecArg) {
  const selEl = $('#selTec');
  const tec = (typeof tecArg === 'string') ? tecArg : (selEl ? selEl.value : (r.derivadoA || ''));
  const saveBtn = $('#cSave'); if (saveBtn) saveBtn.innerHTML = '<span class="spinner"></span>';
  if (tec && norm(tec) !== norm(r.derivadoA || '')) {
    const res = await postAction({ accion: 'derivar', encargado: r.encargado, reporteId: r.id, derivadoA: tec });
    if (res && res.ok) { r.derivadoA = tec; const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado); if (a) { a.derivadoA = tec; a.visado = a.visado || 'VISADO'; } toast('Caso derivado a ' + tec); }
    else { toast('No se pudo derivar'); const b = $('#cSave'); if (b) b.textContent = 'Guardar y salir'; return; }
  } else { toast('Guardado'); }
  goBackFromCase();
}
/* ===== Solucionar: el admin puede subir verificadores a nombre del técnico ===== */
let solveState = null;
function openSolveModal(r) {
  solveState = { verificadores: [], uploading: 0 };
  const tecDestino = r.derivadoA || ($('#selTec') ? $('#selTec').value : '') || '';
  const ov = document.createElement('div'); ov.className = 'modal-bg'; overlays.appendChild(ov);
  ov.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>Solucionar ${esc(r.id)}</h3><button class="mclose">✕</button></div>
    <div class="modal-body">
      <div class="banner">Puedes adjuntar fotos o videos del trabajo${tecDestino ? ` (se guardan a nombre de <b>${esc(tecDestino)}</b>)` : ''}. También puedes marcar solucionado sin adjuntar.</div>
      <div class="verif-lbl" style="margin-top:0">Comentario de la reparación (opcional)</div>
      <textarea id="svComent" class="sv-textarea" placeholder="Indique qué se hizo, materiales, observaciones…" rows="3"></textarea>
      <div class="verif-lbl">Verificadores (opcional)</div>
      <div class="up-zone" id="svZone"><div class="up-ic">📷</div><div class="up-t">Agregar foto o video</div><div class="up-s">Cámara o galería · los videos se recortan a 15s</div></div>
      <input type="file" id="svInput" accept="image/*,video/*" capture="environment" multiple style="display:none">
      <div class="up-grid" id="svGrid"></div>
      <div class="progress-bar" id="svBar" style="display:none"><div class="fill" id="svFill"></div></div>
    </div>
    <div class="modal-foot" style="flex-direction:column;gap:8px">
      <div id="svHint" class="note" style="width:100%;text-align:center;margin:0;color:var(--orange-d);display:none"></div>
      <div style="display:flex;gap:10px;width:100%">
        <button class="btn ghost" id="svCancel" style="flex:0 0 auto">Cancelar</button>
        <button class="btn green" id="svOk" style="flex:1">✓ Marcar solucionado</button>
      </div>
    </div>
  </div>`;
  const close = () => ov.remove();
  $('.mclose', ov).onclick = close; $('#svCancel', ov).onclick = close;
  const zone = $('#svZone', ov), input = $('#svInput', ov);
  zone.onclick = () => input.click();
  input.onchange = async () => { const files = [...input.files]; input.value = ''; for (const f of files) await handleSolveUpload(f); };
  paintSolveGrid();
  $('#svOk', ov).onclick = () => confirmSolve(r, tecDestino, close);
}
async function handleSolveUpload(file) {
  const isVideo = file.type.startsWith('video');
  const item = { name: file.name, type: isVideo ? 'video' : 'photo', localUrl: URL.createObjectURL(file), progress: 0, url: '', driveId: '' };
  solveState.verificadores.push(item); solveState.uploading++;
  paintSolveGrid(); updateSolveOk();
  try {
    let blob = file;
    if (!isVideo) blob = await compressImage(file, 1920);
    else if (await videoDuration(file) > 15) { toast('Video largo: se recorta a 15s', 2500); blob = await trimVideo(file, 15); }
    const b64 = await blobToB64(blob);
    item.progress = 40; paintSolveGrid();
    const res = await postAction({ accion: 'subirArchivoTecnico', fileName: file.name, mime: blob.type || file.type, data: b64 });
    if (res && res.ok && res.url) { item.url = res.url; item.driveId = driveIdFrom(res.url); item.progress = 100; }
    else { item.error = true; toast('No se pudo subir ' + file.name, 3000); }
  } catch (e) { item.error = true; toast('Error al procesar archivo', 3000); }
  solveState.uploading--; paintSolveGrid(); updateSolveOk();
}
function paintSolveGrid() {
  const grid = $('#svGrid'); if (!grid) return;
  grid.innerHTML = solveState.verificadores.map((m, i) => `<div class="up-thumb">
    ${m.type === 'video' ? `<video src="${m.localUrl}" muted></video>` : `<img src="${m.localUrl}">`}
    ${m.progress < 100 && !m.error ? `<div class="prog">${m.progress > 0 ? m.progress + '%' : '<span class="spinner"></span>'}</div>` : ''}
    ${m.error ? `<div class="prog" style="background:rgba(206,66,87,.8)">✕</div>` : ''}
    ${m.progress === 100 ? `<div class="badge">✓</div>` : ''}
    <button class="rm" data-i="${i}">✕</button>
  </div>`).join('');
  $$('.rm', grid).forEach(b => b.onclick = () => { solveState.verificadores.splice(+b.dataset.i, 1); paintSolveGrid(); updateSolveOk(); });
  const bar = $('#svBar'), fill = $('#svFill');
  if (bar) { if (solveState.uploading > 0) { bar.style.display = 'block'; fill.style.width = '60%'; } else { fill.style.width = '100%'; setTimeout(() => { if (solveState.uploading === 0 && bar) bar.style.display = 'none'; }, 400); } }
}
function updateSolveOk() {
  const btn = $('#svOk'), hint = $('#svHint'); if (!btn) return;
  const s = solveState;
  let motivo = '';
  if (s.uploading > 0) motivo = 'Espera a que terminen de subir los archivos…';
  else if (s.verificadores.some(v => v.error)) motivo = 'Hay archivos con error: elimínalos para continuar.';
  btn.disabled = !!motivo; btn.style.opacity = motivo ? '.55' : '1';
  btn.textContent = s.uploading > 0 ? 'Subiendo…' : '✓ Marcar solucionado';
  if (hint) { hint.style.display = motivo ? 'block' : 'none'; hint.textContent = motivo; }
}
async function confirmSolve(r, tecDestino, close) {
  const s = solveState;
  if (s.uploading > 0) { toast('Espera a que terminen de subir los archivos'); return; }
  const btn = $('#svOk'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Guardando…';
  const verifStr = s.verificadores.filter(v => v.url).map(v => `${v.type}: ${v.name} -> ${v.url}`).join('\n');
  const comentEl = $('#svComent'); const coment = comentEl ? comentEl.value.trim() : '';
  const now = new Date();
  const res = await postAction({
    accion: 'solucionar', encargado: r.encargado, reporteId: r.id,
    fechaSolucion: now.toLocaleString('es-CL'), tsSolucion: now.toISOString(),
    verificadoresTecnico: verifStr || undefined,
    solucionadoPor: tecDestino || undefined,
    comentarioTecnico: coment || undefined
  });
  if (res && res.ok) {
    r.visado = 'SOLUCIONADO'; r.fechaSolucionado = now.toLocaleString('es-CL');
    if (verifStr) r.verificadoresTecnico = (r.verificadoresTecnico ? r.verificadoresTecnico + '\n' : '') + verifStr;
    if (coment) r.comentarioTecnico = coment;
    if (tecDestino) r.solucionadoPor = tecDestino;
    const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado);
    if (a) { a.visado = 'SOLUCIONADO'; a.fechaSolucionado = r.fechaSolucionado; a.verificadoresTecnico = r.verificadoresTecnico; a.comentarioTecnico = r.comentarioTecnico; a.solucionadoPor = r.solucionadoPor; }
    toast('Caso solucionado ✓');
    close(); goBackFromCase();
  } else { toast('No se pudo actualizar'); btn.disabled = false; btn.textContent = '✓ Marcar solucionado'; }
}
/* helpers de media para la subida del admin */
function blobToB64(blob) { return new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result.split(',')[1]); rd.onerror = rej; rd.readAsDataURL(blob); }); }
function compressImage(file, maxSide) {
  return new Promise(resolve => {
    const img = new Image(); img.onload = () => {
      let w = img.width, h = img.height;
      if (Math.max(w, h) > maxSide) { const s = maxSide / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => resolve(b || file), 'image/jpeg', 0.85);
    }; img.onerror = () => resolve(file); img.src = URL.createObjectURL(file);
  });
}
function videoDuration(file) { return new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => res(v.duration || 0); v.onerror = () => res(0); v.src = URL.createObjectURL(file); }); }
function trimVideo(file, seconds) {
  return new Promise(async (resolve) => {
    try {
      const v = document.createElement('video'); v.src = URL.createObjectURL(file); v.muted = true;
      await new Promise(r => { v.onloadedmetadata = r; });
      const stream = v.captureStream ? v.captureStream() : (v.mozCaptureStream && v.mozCaptureStream());
      if (!stream || typeof MediaRecorder === 'undefined') return resolve(file);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      v.play(); rec.start();
      setTimeout(() => { rec.stop(); v.pause(); }, seconds * 1000);
    } catch (e) { resolve(file); }
  });
}
function goBackFromCase() {
  // restaurar navwrap original
  navwrap.querySelector('.inner').innerHTML = `<button class="btn ghost" id="btnBack">‹</button><button class="btn accent" id="btnNext">Continuar</button>`;
  const ret = caseReturn;
  if (ret === 'establecimiento' && curEst) openEstablecimiento(curEst);
  else if (ret === 'derivados') renderDerivados();
  else if (ret === 'emergencias') renderEmergencias();
  else if (ret === 'lista') renderLista(listaTipo);
  else renderGenerales();
}

/* ============================================================
   DERIVADOS — KPIs por técnico + lista
   ============================================================ */
let derTecActivo = null;   // técnico abierto
let derKpi = null;         // filtro KPI dentro del técnico: 'pend' | 'fin'
let derCrit = 0;           // criticidad mínima en la vista de técnico (0 = todas)
let derQuery = '';         // filtro por establecimiento dentro del técnico

function casosDeTecnico(t) {
  return activos(ALL).filter(r => norm(r.derivadoA || '') === norm(t));
}
function renderDerivados(keep) {
  currentView = 'derivados';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Derivados';
  if (!keep) { derTecActivo = null; derKpi = null; derCrit = 0; derQuery = ""; }

  if (derTecActivo) { renderTecnico(derTecActivo); return; }

  const act = activos(ALL);
  const byTec = {};
  for (const r of act) { const t = (r.derivadoA || '').trim(); if (!t) continue; (byTec[t] = byTec[t] || []).push(r); }
  const techNames = [...new Set([...TECNICOS, ...Object.keys(byTec)])].filter(Boolean);

  const cards = techNames.map(t => {
    const cs = byTec[t] || [];
    const total = cs.length;
    const pend = cs.filter(r => estadoDe(r).k !== 'fin').length;
    const sol = cs.filter(r => estadoDe(r).k === 'fin').length;
    return `<button class="tech-card" data-tec="${esc(t)}">
      <div class="tc-name">🔧 ${esc(t)} <span class="tc-arrow">›</span></div>
      <div class="tc-kpis">
        <div class="tc-kpi"><div class="n">${total}</div><div class="l">Casos</div></div>
        <div class="tc-kpi"><div class="n">${pend}</div><div class="l">Pendientes</div></div>
        <div class="tc-kpi g"><div class="n">${sol}</div><div class="l">Solucionados</div></div>
      </div>
    </button>`;
  }).join('');

  content.innerHTML = `<div class="screen">
    <div class="der-head">Toca un técnico para ver sus casos</div>
    <div class="tech-list" id="derBody">${techNames.length ? cards : `<div class="empty"><div class="ic">🔧</div><p>Aún no hay técnicos.</p></div>`}</div>
  </div>`;
  $$('#derBody .tech-card[data-tec]').forEach(b => b.onclick = () => { derTecActivo = b.dataset.tec; derKpi = null; derQuery = ''; renderTecnico(derTecActivo); });
}
function renderTecnico(t) {
  currentView = 'derivados';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = t;
  const cs = casosDeTecnico(t);
  const pend = cs.filter(r => estadoDe(r).k !== 'fin').length;
  const sol = cs.filter(r => estadoDe(r).k === 'fin').length;
  const prom = tiempoPromedio(cs.filter(r => estadoDe(r).k === 'fin'));

  content.innerHTML = `<div class="screen">
    <div class="sub-nav">
      <button class="der-back" id="derBack">‹ Técnicos</button>
      <button class="der-home" id="derHome">🏠 Inicio</button>
    </div>
    <div class="bubble-head"><div class="bh-top"><div class="bh-id">🔧 ${esc(t)}</div><div class="bh-state">${cs.length} caso(s)</div></div></div>
    <div class="search-wrap"><span class="ic-lead">🔎</span>
      <input type="text" id="derQ" placeholder="Filtrar por establecimiento o RBD…" value="${esc(derQuery)}" autocomplete="off">
      <button class="clearbtn ${derQuery ? '' : 'hidden'}" id="derClr">✕</button>
    </div>
    <div class="mkpis">
      <button class="mkpi b ${derKpi === 'pend' ? 'ksel' : ''}" data-dk="pend"><div class="bar"></div><div class="n">${pend}</div><div class="l">Pendientes</div></button>
      <button class="mkpi g ${derKpi === 'fin' ? 'ksel' : ''}" data-dk="fin"><div class="bar"></div><div class="n">${sol}</div><div class="l">Solucionados</div></button>
    </div>
    <div class="fchips">
      <label class="fchip sel-wrap ${derCrit ? 'on r' : ''}">⚠ Criticidad
        <select id="derCritSel">
          <option value="0" ${derCrit === 0 ? 'selected' : ''}>Todas</option>
          ${[4,3,2,1].map(n => `<option value="${n}" ${derCrit === n ? 'selected' : ''}>${n} · ${critLabel(n)}</option>`).join('')}
        </select>
      </label>
      ${derKpi || derCrit ? `<button class="fchip clr" id="derClrAll">✕ Quitar filtros</button>` : ''}
    </div>
    <div class="caselist" id="derList" style="flex:1 1 auto;min-height:0"></div>
    <div class="prom-card">⏱️ Tiempo promedio para cerrar tickets: <b>${sol ? prom : '—'}</b></div>
  </div>`;

  $('#derBack').onclick = () => { derTecActivo = null; renderDerivados(true); };
  $('#derHome').onclick = renderHome;
  $$('.mkpi[data-dk]').forEach(k => k.onclick = () => { derKpi = (derKpi === k.dataset.dk) ? null : k.dataset.dk; renderTecnico(t); });
  const dsel = $('#derCritSel'); if (dsel) dsel.onchange = () => { derCrit = +dsel.value; renderTecnico(t); };
  const dca = $('#derClrAll'); if (dca) dca.onclick = () => { derKpi = null; derCrit = 0; renderTecnico(t); };

  const inp = $('#derQ'), clr = $('#derClr');
  const repaint = () => {
    let list = cs.slice();
    if (derKpi === 'pend') list = list.filter(r => estadoDe(r).k !== 'fin');
    else if (derKpi === 'fin') list = list.filter(r => estadoDe(r).k === 'fin');
    if (derCrit) list = list.filter(r => critDe(r) >= derCrit);
    const q = norm(derQuery.trim());
    if (q) list = list.filter(r => norm(r.establecimiento || '').includes(q) || String(r.rbd).includes(q));
    if (derCrit) list.sort((a, b) => (critDe(b) - critDe(a)) || (tsOf(b) - tsOf(a)));
    else list.sort((a, b) => tsOf(b) - tsOf(a));
    const box = $('#derList');
    box.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>Sin casos en esta vista.</p></div>`;
    bindCaseCards(box, list);
  };
  inp.addEventListener('input', () => { derQuery = inp.value; clr.classList.toggle('hidden', !inp.value); repaint(); });
  clr.onclick = () => { derQuery = ''; inp.value = ''; clr.classList.add('hidden'); repaint(); inp.focus(); };
  repaint();
}
/* promedio de tiempos: parsea "N d N h" / "N h N min" / "N min" a minutos */
function tiempoAminutos(txt) {
  if (!txt) return null; let min = 0;
  let m = String(txt).match(/(\d+)\s*d/); if (m) min += +m[1] * 1440;
  m = String(txt).match(/(\d+)\s*h/); if (m) min += +m[1] * 60;
  m = String(txt).match(/(\d+)\s*min/); if (m) min += +m[1];
  return min || null;
}
function fmtMin(min) { const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), mm = min % 60; if (d) return d + ' d ' + h + ' h'; if (h) return h + ' h ' + mm + ' min'; return mm + ' min'; }
function tiempoPromedio(cases) {
  const vals = cases.map(r => tiempoAminutos(r.tiempoResolucion)).filter(x => x);
  if (!vals.length) return '—';
  return fmtMin(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
}

/* ============================================================
   EMERGENCIAS — misma lógica, segmentado por criticidad
   ============================================================ */
/* ============================================================
   BITÁCORA — establecimientos con casos solucionados + verificador PDF
   ============================================================ */
function renderBitacora() {
  currentView = 'bitacora';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Bitácora';

  // agrupar por establecimiento los casos SOLUCIONADOS
  const byEst = {};
  for (const r of ALL) {
    if (estadoDe(r).k !== 'fin') continue;
    const k = String(r.rbd);
    if (!byEst[k]) byEst[k] = { rbd: r.rbd, nom: r.establecimiento || (estByRbd(r.rbd) || {}).nom || ('RBD ' + r.rbd), casos: [], tecnicos: {} };
    byEst[k].casos.push(r);
    const t = (r.solucionadoPor || r.derivadoA || '').trim();
    if (t) byEst[k].tecnicos[t] = (byEst[k].tecnicos[t] || 0) + 1;
  }
  const ests = Object.values(byEst).sort((a, b) => String(a.nom).localeCompare(String(b.nom)));

  content.innerHTML = `<div class="screen">
    <div class="sub-nav"><button class="der-home" id="bitHome">🏠 Inicio</button></div>
    <div class="enc-title">📗 Bitácora de trabajos</div>
    <div class="der-head">Establecimientos con casos solucionados</div>
    <div class="tech-list" id="bitList">${ests.length ? ests.map(e => {
      const tecs = Object.keys(e.tecnicos);
      const tecTxt = tecs.length ? tecs.join(', ') : '—';
      return `<div class="bit-card">
        <button class="bit-main" data-rbd="${esc(e.rbd)}">
          <div class="tc-name">🏫 ${esc(e.nom)} <span class="tc-arrow">›</span></div>
          <div class="bit-sub">🔧 ${esc(tecTxt)}</div>
          <div class="bit-sol"><span class="bit-num">${e.casos.length}</span> caso(s) solucionado(s)</div>
        </button>
        <button class="bit-verif" data-rbd="${esc(e.rbd)}" data-nom="${esc(e.nom)}" title="Subir verificador">📝<span>Verificador</span></button>
      </div>`;
    }).join('') : `<div class="empty"><div class="ic">📗</div><p>Aún no hay casos solucionados.</p></div>`}</div>
  </div>`;

  $('#bitHome').onclick = renderHome;
  $$('#bitList .bit-main[data-rbd]').forEach(b => b.onclick = () => {
    const e = estByRbd(b.dataset.rbd) || { rbd: b.dataset.rbd, nom: (byEst[b.dataset.rbd] || {}).nom };
    bitReturn = true; curEstReturn = 'bitacora';
    openEstablecimiento(e);
  });
  $$('#bitList .bit-verif[data-rbd]').forEach(b => b.onclick = () => openVerificadorModal(b.dataset.rbd, b.dataset.nom, byEst[b.dataset.rbd]));
}

/* ===== Modal de verificador: sube JPG (con recorte) o PDF; JPG se convierte a PDF ===== */
let verifState = null;
function openVerificadorModal(rbd, nom, grupo) {
  // fecha por defecto: la más reciente de solución del grupo
  let fechaDef = '';
  if (grupo && grupo.casos.length) {
    const fechas = grupo.casos.map(c => c.fechaSolucionado).filter(Boolean);
    fechaDef = fechas[0] || '';
  }
  const hoy = new Date().toISOString().slice(0, 10);
  verifState = { rbd, nom, file: null, isJpg: false, cropper: null };
  const ov = document.createElement('div'); ov.className = 'modal-bg'; overlays.appendChild(ov);
  ov.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>Verificador · ${esc(nom)}</h3><button class="mclose">✕</button></div>
    <div class="modal-body">
      <div class="banner">Sube el acta o comprobante. Si es <b>JPG</b> podrás recortarlo y se guardará como <b>PDF</b>. El archivo quedará como <code>${esc(rbd)}_fecha.pdf</code>.</div>
      <div class="verif-lbl" style="margin-top:0">Fecha del trabajo</div>
      <input type="date" id="vfFecha" class="sv-textarea" style="min-height:auto;padding:10px 13px" value="${hoy}">
      <div class="verif-lbl">Archivo (JPG o PDF)</div>
      <div class="up-zone" id="vfZone"><div class="up-ic">📄</div><div class="up-t">Elegir archivo</div><div class="up-s">JPG (se recorta y convierte a PDF) o PDF directo</div></div>
      <input type="file" id="vfInput" accept="image/jpeg,image/jpg,image/png,application/pdf" style="display:none">
      <div id="vfCropWrap" class="vf-crop-wrap hidden"><img id="vfCropImg" alt=""></div>
      <div id="vfPreview" class="vf-preview hidden"></div>
    </div>
    <div class="modal-foot" style="flex-direction:column;gap:8px">
      <div id="vfHint" class="note" style="width:100%;text-align:center;margin:0;color:var(--orange-d);display:none"></div>
      <div style="display:flex;gap:10px;width:100%">
        <button class="btn ghost" id="vfCancel" style="flex:0 0 auto">Cancelar</button>
        <button class="btn green" id="vfOk" style="flex:1;opacity:.55" disabled>Subir verificador</button>
      </div>
    </div>
  </div>`;
  const close = () => { if (verifState && verifState.cropper) { try { verifState.cropper.destroy(); } catch (e) {} } ov.remove(); };
  $('.mclose', ov).onclick = close; $('#vfCancel', ov).onclick = close;
  const zone = $('#vfZone', ov), input = $('#vfInput', ov);
  zone.onclick = () => input.click();
  input.onchange = () => handleVerifFile(input.files[0]);
  $('#vfOk', ov).onclick = () => subirVerificador(close);
}
async function handleVerifFile(file) {
  if (!file) return;
  verifState.file = file;
  verifState.isJpg = /image\/(jpeg|jpg|png)/i.test(file.type);
  const cropWrap = $('#vfCropWrap'), prev = $('#vfPreview'), ok = $('#vfOk');
  if (verifState.isJpg) {
    // mostrar cropper
    prev.classList.add('hidden');
    cropWrap.classList.remove('hidden');
    const img = $('#vfCropImg');
    img.src = URL.createObjectURL(file);
    await ensureCropper();
    if (verifState.cropper) { try { verifState.cropper.destroy(); } catch (e) {} }
    img.onload = () => {
      verifState.cropper = new Cropper(img, { viewMode: 1, autoCropArea: 1, background: false, responsive: true });
    };
    $('#vfZone').querySelector('.up-t').textContent = '✓ Imagen cargada — ajusta el recorte';
  } else {
    cropWrap.classList.add('hidden');
    prev.classList.remove('hidden');
    prev.innerHTML = `<div class="vf-pdf">📄 ${esc(file.name)} <small>(PDF, se sube tal cual)</small></div>`;
    $('#vfZone').querySelector('.up-t').textContent = '✓ PDF cargado';
  }
  ok.disabled = false; ok.style.opacity = '1';
}
/* Carga perezosa de Cropper.js y jsPDF desde CDN (solo cuando se usan) */
function ensureCropper() {
  return new Promise(resolve => {
    if (window.Cropper) return resolve();
    const css = document.createElement('link'); css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
}
function ensureJsPDF() {
  return new Promise(resolve => {
    if (window.jspdf && window.jspdf.jsPDF) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
}
async function subirVerificador(close) {
  const ok = $('#vfOk'), hint = $('#vfHint');
  const fecha = ($('#vfFecha') ? $('#vfFecha').value : '') || new Date().toISOString().slice(0, 10);
  const fechaTxt = fecha.replace(/-/g, '');
  const nombrePdf = `${verifState.rbd}_${fechaTxt}.pdf`;
  ok.disabled = true; ok.innerHTML = '<span class="spinner"></span> Procesando…';
  try {
    let pdfB64;
    if (verifState.isJpg) {
      // recorta -> canvas -> PDF
      const canvas = verifState.cropper.getCroppedCanvas({ maxWidth: 2000, maxHeight: 2600 });
      const imgData = canvas.toDataURL('image/jpeg', 0.9);
      await ensureJsPDF();
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const ratio = Math.min(pw / canvas.width, ph / canvas.height);
      const w = canvas.width * ratio, h = canvas.height * ratio;
      pdf.addImage(imgData, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
      pdfB64 = pdf.output('datauristring').split(',')[1];
    } else {
      // PDF directo
      pdfB64 = await blobToB64(verifState.file);
    }
    const res = await postAction({
      accion: 'subirVerificadorBitacora',
      rbd: verifState.rbd, fecha: fecha, fileName: nombrePdf,
      mime: 'application/pdf', data: pdfB64
    });
    if (res && res.ok) {
      toast('Verificador guardado ✓');
      close();
    } else {
      hint.style.display = 'block'; hint.textContent = (res && res.error) || 'No se pudo guardar';
      ok.disabled = false; ok.textContent = 'Subir verificador';
    }
  } catch (e) {
    hint.style.display = 'block'; hint.textContent = 'Error al procesar: ' + e.message;
    ok.disabled = false; ok.textContent = 'Subir verificador';
  }
}

function renderEmergencias(keep) {
  currentView = 'emergencias';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Emergencias';
  const list = activos(ALL).filter(esEmergencia).sort((a, b) => tsOf(b) - tsOf(a));
  const activas = list.filter(r => estadoDe(r).k !== 'fin').length;
  const cerradas = list.filter(r => estadoDe(r).k === 'fin').length;
  content.innerHTML = `<div class="screen">
    <div class="mkpis">
      <div class="mkpi r"><div class="bar"></div><div class="n">${activas}</div><div class="l">Activas</div></div>
      <div class="mkpi"><div class="bar"></div><div class="n">${list.length}</div><div class="l">Históricas</div></div>
      <div class="mkpi g"><div class="bar"></div><div class="n">${cerradas}</div><div class="l">Resueltas</div></div>
    </div>
    ${activas ? `<div class="banner" style="background:linear-gradient(120deg,rgba(206,66,87,.12),rgba(206,66,87,.06));border-color:rgba(206,66,87,.3);color:var(--red-d)"><b>${activas} emergencia(s) activa(s)</b> requieren derivación o solución.</div>` : ''}
    <div class="caselist" id="emList">${list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">✅</div><p>Sin emergencias registradas.</p></div>`}</div>
  </div>`;
  bindCaseCards($('#emList'), list);
}

/* ============================================================
   LISTA genérica (No visados)
   ============================================================ */
/* ============================================================
   ENCARGADOS — KPIs, listado por encargado y filtros por estado/criticidad
   ============================================================ */
let listaTipo = 'novis';
let novisEnc = null;          // encargado abierto
let encFiltro = null;         // null | 'fin' | 'noder' | 'pend'
let encCrit = 0;              // 0 = sin filtro, 1..4 = criticidad mínima
let encOrden = 'recientes';  // 'recientes' | 'antiguos'
let encEst = null;           // establecimiento elegido (rbd) dentro del encargado

/* Clasificación pedida:
   - "No derivado" engloba No visados + Visados (aún sin técnico)
   - "Pendientes" son los que ya están derivados a un técnico
   - "Solucionados" los cerrados                                        */
function claseEnc(r) {
  const k = estadoDe(r).k;
  if (k === 'fin') return 'fin';
  if (k === 'der') return 'pend';
  return 'noder';               // 'pend' (no visado) y 'vis' (visado)
}
function critDe(r) { return +r.criticidad || 0; }

function renderLista(tipo, keep) {
  listaTipo = tipo; currentView = 'lista';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  if (!keep) { novisEnc = null; encFiltro = null; encCrit = 0; encOrden = 'recientes'; encEst = null; }
  $('#modeLabel').textContent = novisEnc || 'Encargados';

  const act = activos(ALL);
  const encs = [...new Set(ALL.map(r => r.encargado).filter(Boolean))].sort();

  /* ---------- Pantalla 1: lista de encargados ---------- */
  if (!novisEnc) {
    const total = act.filter(r => estadoDe(r).k !== 'fin').length;
    const noDer = act.filter(r => claseEnc(r) === 'noder').length;
    const sol = act.filter(r => claseEnc(r) === 'fin').length;
    content.innerHTML = `<div class="screen">
      <div class="sub-nav"><button class="der-home" id="encHome0">🏠 Inicio</button></div>
      <div class="mkpis">
        <div class="mkpi"><div class="bar"></div><div class="n">${encs.length}</div><div class="l">Encargados</div></div>
        <div class="mkpi b"><div class="bar"></div><div class="n">${noDer}</div><div class="l">No derivados</div></div>
        <div class="mkpi g"><div class="bar"></div><div class="n">${sol}</div><div class="l">Solucionados</div></div>
      </div>
      <div class="der-head">Toca un encargado para ver sus casos</div>
      <div class="tech-list">${encs.length ? encs.map(e => {
        const cs = ALL.filter(r => r.encargado === e);
        const csAct = act.filter(r => r.encargado === e);
        const pend = csAct.filter(r => claseEnc(r) === 'pend').length;
        const solE = csAct.filter(r => claseEnc(r) === 'fin').length;
        return `<button class="tech-card" data-enc="${esc(e)}">
          <div class="tc-name">👷 ${esc(e)} <span class="tc-arrow">›</span></div>
          <div class="tc-kpis">
            <div class="tc-kpi"><div class="n">${cs.length}</div><div class="l">Subidos</div></div>
            <div class="tc-kpi"><div class="n">${pend}</div><div class="l">Pendientes</div></div>
            <div class="tc-kpi g"><div class="n">${solE}</div><div class="l">Solucionados</div></div>
          </div>
        </button>`;
      }).join('') : `<div class="empty"><div class="ic">👷</div><p>Aún no hay encargados con casos.</p></div>`}</div>
    </div>`;
    $('#encHome0').onclick = renderHome;
    $$('.tech-card[data-enc]').forEach(b => b.onclick = () => { novisEnc = b.dataset.enc; encFiltro = null; encCrit = 0; encEst = null; encOrden = 'recientes'; renderLista('novis', true); });
    return;
  }

  /* ---------- Pantalla 2: casos del encargado ---------- */
  const mios = act.filter(r => r.encargado === novisEnc);
  const nFin = mios.filter(r => claseEnc(r) === 'fin').length;
  const nNoDer = mios.filter(r => claseEnc(r) === 'noder').length;
  const nPend = mios.filter(r => claseEnc(r) === 'pend').length;
  // establecimientos con casos de este encargado (para el desplegable)
  const estsEnc = [];
  const vistos = {};
  for (const r of mios) {
    const k = String(r.rbd);
    if (vistos[k]) continue; vistos[k] = true;
    estsEnc.push({ rbd: r.rbd, nom: r.establecimiento || (estByRbd(r.rbd) || {}).nom || ('RBD ' + r.rbd) });
  }
  estsEnc.sort((a, b) => String(a.nom).localeCompare(String(b.nom)));
  const estSel = encEst ? estsEnc.find(e => String(e.rbd) === String(encEst)) : null;

  content.innerHTML = `<div class="screen">
    <div class="sub-nav">
      <button class="der-back" id="encBack">‹ Encargados</button>
      <button class="der-home" id="encHome">🏠 Inicio</button>
    </div>
    <div class="enc-title">👷 ${esc(novisEnc)}</div>

    <div class="est-select" id="estSelect">
      <span class="es-ic">🏫</span>
      <input type="text" id="estQ" placeholder="Todos los establecimientos" value="${estSel ? esc(estSel.nom) : ''}" autocomplete="off" readonly>
      <button class="es-caret" id="estCaret">▾</button>
      ${estSel ? `<button class="es-clear" id="estClear">✕</button>` : ''}
      <div class="es-menu hidden" id="estMenu"></div>
    </div>

    <div class="fchips">
      <button class="fchip ${encFiltro === 'novis' ? 'on' : ''}" data-f="novis">◻ No visados</button>
      <button class="fchip ${encFiltro === 'fin' ? 'on g' : ''}" data-f="fin">✓ Solucionados <b>${nFin}</b></button>
      <button class="fchip ${encFiltro === 'pend' ? 'on b' : ''}" data-f="pend">↗ Pendientes <b>${nPend}</b></button>
      <label class="fchip sel-wrap ${encCrit ? 'on r' : ''}">⚠
        <select id="encCritSel">
          <option value="0" ${encCrit === 0 ? 'selected' : ''}>Crit.</option>
          ${[4,3,2,1].map(n => `<option value="${n}" ${encCrit === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
      <button class="ord-mini" id="ordMini" title="Orden">${encOrden === 'recientes' ? '↓ Recientes' : '↑ Antiguos'}</button>
    </div>

    <div class="caselist" id="lista" style="flex:1 1 auto;min-height:0"></div>
  </div>`;

  $('#encBack').onclick = () => { novisEnc = null; renderLista('novis', true); };
  $('#encHome').onclick = renderHome;
  $$('.fchip[data-f]').forEach(b => b.onclick = () => { encFiltro = (encFiltro === b.dataset.f) ? null : b.dataset.f; renderLista('novis', true); });
  const sel = $('#encCritSel'); if (sel) sel.onchange = () => { encCrit = +sel.value; renderLista('novis', true); };
  $('#ordMini').onclick = () => { encOrden = encOrden === 'recientes' ? 'antiguos' : 'recientes'; renderLista('novis', true); };

  // desplegable de establecimientos
  const menu = $('#estMenu'), estQ = $('#estQ');
  const abrirMenu = () => {
    const q = norm(estQ.value.trim());
    const filtered = estsEnc.filter(e => !q || norm(e.nom).includes(q) || String(e.rbd).includes(q));
    menu.innerHTML = `<div class="es-opt" data-rbd=""><b>Todos los establecimientos</b></div>` +
      filtered.map(e => `<div class="es-opt" data-rbd="${esc(e.rbd)}">${esc(e.nom)}<small>RBD ${esc(e.rbd)}</small></div>`).join('');
    menu.classList.remove('hidden');
    $$('.es-opt', menu).forEach(o => o.onclick = () => { encEst = o.dataset.rbd || null; renderLista('novis', true); });
  };
  $('#estCaret').onclick = () => { estQ.removeAttribute('readonly'); estQ.value = ''; abrirMenu(); estQ.focus(); };
  estQ.onclick = () => { estQ.removeAttribute('readonly'); estQ.value = ''; abrirMenu(); };
  estQ.oninput = abrirMenu;
  const ec = $('#estClear'); if (ec) ec.onclick = () => { encEst = null; renderLista('novis', true); };
  document.addEventListener('click', e => { if (!e.target.closest('#estSelect')) menu.classList.add('hidden'); }, { once: true });

  // aplicar filtros
  let list = mios.slice();
  if (encEst) list = list.filter(r => String(r.rbd) === String(encEst));
  if (encFiltro === 'novis') list = list.filter(r => estadoDe(r).k === 'pend');
  else if (encFiltro === 'fin') list = list.filter(r => claseEnc(r) === 'fin');
  else if (encFiltro === 'pend') list = list.filter(r => claseEnc(r) === 'pend');
  if (encCrit) list = list.filter(r => critDe(r) >= encCrit);
  if (encCrit) list.sort((a, b) => (critDe(b) - critDe(a)) || (tsOf(b) - tsOf(a)));
  else list.sort((a, b) => encOrden === 'recientes' ? tsOf(b) - tsOf(a) : tsOf(a) - tsOf(b));

  const box = $('#lista');
  box.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>Sin casos en este filtro.</p></div>`;
  bindCaseCards(box, list);
}

/* ============================================================
   VISOR de verificadores (Drive embebible)
   ============================================================ */
function openViewer(items, start) {
  if (!items || !items.length) { toast('Sin verificadores'); return; }
  let idx = start || 0;
  const ov = document.createElement('div'); ov.className = 'viewer-bg'; overlays.appendChild(ov);
  const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
  const onKey = e => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
  document.addEventListener('keydown', onKey);
  const go = d => { const n = idx + d; if (n < 0 || n >= items.length) return; idx = n; render(); };
  function mediaHTML(it) {
    if (it.type === 'video') {
      if (it.driveId) return `<iframe src="${driveVideoPreview(it.driveId)}" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
      return `<video src="${esc(it.url)}" controls autoplay playsinline></video>`;
    }
    if (it.driveId) {
      const [src, fb] = driveImgSources(it.driveId);
      return `<div class="viewer-load" id="vload"><div class="ring"></div>Cargando…</div>
        <img src="${src}" data-fb="${fb}" data-tries="0" alt="" style="opacity:0"
          onload="this.style.opacity=1;var l=document.getElementById('vload');if(l)l.remove();"
          onerror="if(this.dataset.tries==='0'){this.dataset.tries='1';this.src=this.dataset.fb;}else{this.outerHTML=document.getElementById('vmiss').innerHTML;var l=document.getElementById('vload');if(l)l.remove();}">`;
    }
    return missHTML(it);
  }
  function missHTML(it) { const open = it.driveId ? driveOpenUrl(it.driveId) : it.url; return `<div class="viewer-miss">No se pudo mostrar aquí.<br>${open ? `<a href="${esc(open)}" target="_blank" rel="noopener">Abrir en Drive ↗</a>` : 'Sin link.'}</div>`; }
  function preload(n) { const it = items[n]; if (!it || it.type === 'video' || !it.driveId) return; const im = new Image(); im.src = driveImgSources(it.driveId)[0]; }
  function render() {
    const it = items[idx]; const openUrl = it.driveId ? driveOpenUrl(it.driveId) : it.url;
    ov.innerHTML = `<div class="viewer-top"><span class="vcount">${idx + 1} / ${items.length}</span>${openUrl ? `<a class="vopen" href="${esc(openUrl)}" target="_blank" rel="noopener">Drive ↗</a>` : '<span style="margin-left:auto"></span>'}<button class="vclose">✕</button></div>
      <div class="viewer-stage">${items.length > 1 ? `<button class="viewer-nav prev" ${idx === 0 ? 'disabled' : ''}>‹</button>` : ''}${mediaHTML(it)}${items.length > 1 ? `<button class="viewer-nav next" ${idx === items.length - 1 ? 'disabled' : ''}>›</button>` : ''}</div>
      <div class="viewer-cap">${esc(it.name || '')}</div><template id="vmiss">${missHTML(it)}</template>`;
    $('.vclose', ov).onclick = close;
    const pv = $('.viewer-nav.prev', ov), nx = $('.viewer-nav.next', ov);
    if (pv) pv.onclick = () => go(-1); if (nx) nx.onclick = () => go(1);
    preload(idx + 1); preload(idx - 1);
  }
  let sx = null, sy = null;
  ov.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  ov.addEventListener('touchend', e => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1); }, { passive: true });
  ov.addEventListener('click', e => { if (e.target === ov || e.target.classList.contains('viewer-stage')) close(); });
  render();
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(async function init() {

  if (CFG.sheetUrl) {
    renderHome();
    await refreshData(false);
    fetchCoords(true);
    if (!TECNICOS.length) { const t = await fetchTecnicos(); if (t) TECNICOS = t; }
    renderHome();
    startPolling();
    // registrar service worker (para notificaciones tipo B en Safari/instalada)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      // si el usuario ya activó push, re-asegura la suscripción al abrir
      if (CFG.pushOn && CFG.pushUrl) { navigator.serviceWorker.ready.then(() => subscribePush()).catch(() => {}); }
      // navegar al caso cuando el SW avisa (clic en notificación)
      navigator.serviceWorker.addEventListener('message', ev => {
        const d = ev.data && ev.data.data; if (!d || !d.id) return;
        const r = ALL.find(x => String(x.id) === String(d.id) && x.encargado === d.encargado); if (r) openCase(r);
      });
    }
  } else {
    renderHome();
  }
})();
