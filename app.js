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
    out.push({ rbd: String(r[COL.RBD]), nom: r[COL.NOM], dir: r[COL.DIR], com: r[COL.COM], tec: r[COL.TEC], inst: r[COL.INST] });
  }
  return out;
})();
function estByRbd(rbd) { return ESTS.find(e => e.rbd === String(rbd)); }
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
  if (!act.length) return { cls: 'g', color: '#C4C4BE', n: 0 };      // todo solucionado
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
  const noVis = act.filter(r => estadoDe(r).k === 'pend').length;
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
      <button class="kpi-btn novis" id="kNo"><div class="kic">📥</div>
        <div class="kmain"><div class="kname">No visados</div><div class="ksub">Pendientes de revisar</div></div>
        <div class="knum" id="nNo">${noVis}</div></button>
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
  </div></div></div>`;
  btnBack.onclick = renderHome; btnNext.textContent = 'Guardar'; btnNext.disabled = false; btnNext.className = 'btn accent';
  btnNext.onclick = () => {
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
  paintTecnicos();
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

function renderGenerales(keep) {
  currentView = 'generales';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Generales';
  if (!keep) genSub = 'lista';

  const act = activos(ALL);
  const activosNoFin = act.filter(r => estadoDe(r).k !== 'fin');
  const total = activosNoFin.length;
  const derivados = act.filter(r => estadoDe(r).k === 'der').length;
  const noVis = act.filter(r => estadoDe(r).k === 'pend').length;

  content.innerHTML = `<div class="screen">
    <div class="search-wrap" id="genSearchWrap">
      <span class="ic-lead">🔎</span>
      <input type="text" id="genQ" placeholder="Buscar establecimiento o RBD…" autocomplete="off">
      <button class="clearbtn hidden" id="genClr">✕</button>
      <div class="suggest hidden" id="genSug"></div>
    </div>
    <div class="seg">
      <button data-s="lista" class="${genSub === 'lista' ? 'sel' : ''}">Casos por fecha</button>
      <button data-s="mapa" class="${genSub === 'mapa' ? 'sel' : ''}">Densidad de casos</button>
    </div>
    <div class="mkpis">
      <div class="mkpi"><div class="bar"></div><div class="n">${total}</div><div class="l">Activos</div></div>
      <div class="mkpi b"><div class="bar"></div><div class="n">${derivados}</div><div class="l">Derivados</div></div>
      <div class="mkpi"><div class="bar"></div><div class="n">${noVis}</div><div class="l">No visados</div></div>
    </div>
    <div id="genBody" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">${genSub === 'mapa' ? `<div class="mapwrap" id="mapwrap"><div id="map"></div>${mapLegend()}<button class="map-fs" id="mapFs" title="Pantalla completa">⛶</button></div>` : `<div class="caselist" id="genList"></div>`}</div>
  </div>`;

  $$('.seg button').forEach(b => b.onclick = () => { genSub = b.dataset.s; renderGenerales(true); });
  bindEstSearch('genQ', 'genSug', 'genClr');
  if (genSub === 'mapa') { setTimeout(() => initMap('map'), 60); $('#mapFs').onclick = openMapFull; }
  else paintGenList();
}
function paintGenList() {
  const box = $('#genList'); if (!box) return;
  const list = activos(ALL).slice().sort((a, b) => tsOf(b) - tsOf(a));
  box.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>Sin casos aún.</p></div>`;
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
    <div class="li"><span class="dot" style="background:#F49A0F"></span>3 o más</div>
    <div class="li"><span class="dot" style="background:#CE4257"></span>Emergencia</div>
    <div class="li"><span class="dot" style="background:#C4C4BE"></span>Solo solucionados</div>
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
function radiusMeters(n) { return Math.min(900, 90 + n * 45); }
function drawDensity(map, layer) {
  layer.clearLayers();
  const byRbd = casesByRbd(ALL);
  const bounds = [];
  for (const rbd in byRbd) {
    const cs = byRbd[rbd]; const co = coordOf(rbd); if (!co) continue;
    const lvl = levelFor(cs);
    const n = lvl.n || cs.length;
    const est = (estByRbd(rbd) || {}).nom || cs[0].establecimiento || 'Establecimiento';
    // círculo de área (metros)
    L.circle([co.lat, co.lon], {
      radius: radiusMeters(n), color: lvl.color, fillColor: lvl.color,
      weight: 1.5, opacity: .9, fillOpacity: .22
    }).addTo(layer);
    // marcador con badge de número
    const cls = lvl.cls === 'g' ? '' : lvl.cls;
    const icon = L.divIcon({ className: '', html: `<div class="pin-badge ${cls}">${est.length > 22 ? est.slice(0, 20) + '…' : est} · ${n}</div>`, iconSize: null, iconAnchor: [0, 0] });
    const mk = L.marker([co.lat, co.lon], { icon }).addTo(layer);
    const act = cs.filter(r => estadoDe(r).k !== 'fin').length;
    const emerg = cs.some(r => esEmergencia(r) && estadoDe(r).k !== 'fin');
    mk.bindPopup(`<b>${esc(est)}</b><br>RBD ${esc(rbd)}<div class="popup-cases" style="color:${lvl.color}">${emerg ? '🚨 Emergencia activa · ' : ''}${act} activo(s) · ${cs.length} total</div><div style="margin-top:6px"><a href="#" data-rbd="${esc(rbd)}" class="popup-open">Ver establecimiento ›</a></div>`);
    mk.on('popupopen', e => { const a = e.popup.getElement().querySelector('.popup-open'); if (a) a.onclick = ev => { ev.preventDefault(); const est2 = estByRbd(rbd); if (est2) openEstablecimiento(est2); }; });
    bounds.push([co.lat, co.lon]);
  }
  if (bounds.length) { try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 }); } catch (e) {} }
}
function drawSingle(map, layer, rbd) {
  layer.clearLayers();
  const co = coordOf(rbd); const est = (estByRbd(rbd) || {}).nom || 'Establecimiento';
  if (!co) return;
  const cs = (casesByRbd(ALL)[rbd]) || [];
  const lvl = levelFor(cs); const n = lvl.n || cs.length;
  L.circle([co.lat, co.lon], { radius: radiusMeters(n || 1), color: lvl.color, fillColor: lvl.color, weight: 1.5, opacity: .9, fillOpacity: .22 }).addTo(layer);
  const cls = lvl.cls === 'g' ? '' : lvl.cls;
  const icon = L.divIcon({ className: '', html: `<div class="pin-badge ${cls}">${esc(est)}${n ? ' · ' + n : ''}</div>`, iconAnchor: [0, 0] });
  L.marker([co.lat, co.lon], { icon }).addTo(layer);
  map.setView([co.lat, co.lon], 16);
}
/* mapa a pantalla completa (landscape o botón) */
let mapFullObj = null;
function openMapFull(single) {
  const ov = document.createElement('div'); ov.className = 'map-full';
  ov.innerHTML = `<div class="mfhead"><b>${single ? esc((estByRbd(single) || {}).nom || 'Mapa') : 'Densidad de casos'}</b><button class="mfclose">✕</button></div>
    <div class="mapwrap"><div id="mapFull"></div>${single ? '' : mapLegend()}</div>`;
  overlays.appendChild(ov);
  $('.mfclose', ov).onclick = () => { if (mapFullObj) { mapFullObj.remove(); mapFullObj = null; } ov.remove(); };
  setTimeout(() => { mapFullObj = initMap('mapFull', { single, noStore: true }); }, 60);
}
/* rotación a horizontal en Generales/mapa -> abre full automático */
let orientationHooked = false;
function hookOrientation() {
  if (orientationHooked) return; orientationHooked = true;
  const check = () => {
    const landscape = window.matchMedia('(orientation:landscape)').matches;
    if (landscape && currentView === 'generales' && genSub === 'mapa' && !mapFullObj) openMapFull();
  };
  window.addEventListener('orientationchange', () => setTimeout(check, 250));
  window.addEventListener('resize', () => setTimeout(check, 250));
}

/* ============================================================
   PÁGINA DE ESTABLECIMIENTO — historial + mapa de un pin
   ============================================================ */
let curEst = null;
function openEstablecimiento(est, keep) {
  curEst = est; currentView = 'establecimiento';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Establecimiento';
  const cases = (casesByRbd(ALL)[est.rbd] || []).slice().sort((a, b) => tsOf(b) - tsOf(a));
  const act = cases.filter(r => estadoDe(r).k !== 'fin').length;
  const der = cases.filter(r => estadoDe(r).k === 'der').length;
  const sol = cases.filter(r => estadoDe(r).k === 'fin').length;

  content.innerHTML = `<div class="screen">
    <div class="bubble-head">
      <div class="bh-top"><div class="bh-id">🏫 RBD ${esc(est.rbd)}</div><div class="bh-state">${cases.length} caso(s)</div></div>
      <h3>${esc(est.nom)}</h3>
      <div class="bh-meta"><span>${esc(est.dir || '')}</span><span>· ${esc(est.com)}</span>${est.tec ? `<span>· 🔧 ${esc(est.tec)}</span>` : ''}</div>
    </div>
    <div class="mkpis">
      <div class="mkpi"><div class="bar"></div><div class="n">${act}</div><div class="l">Activos</div></div>
      <div class="mkpi b"><div class="bar"></div><div class="n">${der}</div><div class="l">Derivados</div></div>
      <div class="mkpi g"><div class="bar"></div><div class="n">${sol}</div><div class="l">Solucionados</div></div>
    </div>
    <div class="mapwrap" id="estMapWrap" style="flex:0 0 190px;margin-bottom:12px"><div id="estMap"></div></div>
    <div class="verif-lbl">Historial de casos</div>
    <div class="caselist" id="estList">${cases.length ? cases.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">📭</div><p>Sin casos registrados.</p></div>`}</div>
  </div>`;
  bindCaseCards($('#estList'), cases);
  setTimeout(() => initMap('estMap', { single: est.rbd, noStore: true }), 80);
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
  const yaVisado = st.k !== 'pend';   // ya tiene algún estado
  const vEnc = verifList(r.verificadores), vTec = verifList(r.verificadoresTecnico);

  content.innerHTML = `<div class="screen"><div style="flex:1;overflow-y:auto;display:flex;flex-direction:column">
    <div class="bubble-head ${em ? 'em' : ''}">
      <div class="bh-top"><div class="bh-id">${esc(r.id)}</div><div class="bh-state" id="bhState">${st.t}</div></div>
      <h3>${em ? '🚨 ' : ''}${esc(est.nom || r.establecimiento)} · RBD ${esc(r.rbd)}</h3>
      <div class="bh-meta"><span>${esc(r.categoria || '')}</span><span>${esc(r.fecha || '')}</span><span>👷 ${esc(r.encargado || '')}</span></div>
      <div class="bh-desc">${esc(r.descripcion || 'Sin descripción')}</div>
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
    </div>

    ${(vEnc.length || vTec.length) ? `<div class="verif-lbl">Verificadores${vTec.length ? ' (encargado + técnico)' : ''}</div>
      <div class="verif-strip" id="vstrip">${[...vEnc, ...vTec].map((m, i) => verifThumbHTML(m, i)).join('')}</div>` : ''}

    <div class="verif-lbl">Ubicación</div>
    <div class="mapwrap" id="caseMapWrap" style="flex:1 1 auto;min-height:180px"><div id="caseMap"></div></div>
  </div></div>`;

  showNav(true);
  btnBack.className = 'btn ghost'; btnBack.textContent = '‹ Atrás';
  btnNext.className = 'btn accent'; btnNext.textContent = 'Guardar y salir'; btnNext.disabled = false;

  // barra inferior: 3 acciones -> reemplazo el contenido del navwrap
  navwrap.querySelector('.inner').innerHTML = `
    <button class="btn ghost" id="cBack">‹</button>
    <button class="btn ghost" id="cNoSave" style="flex:1;min-width:0;color:var(--muted)">Atrás sin guardar</button>
    <button class="btn accent" id="cSave" style="flex:1.4">Guardar y salir</button>`;
  $('#cBack').onclick = () => goBackFromCase();
  $('#cNoSave').onclick = () => { toast('Sin cambios'); goBackFromCase(); };
  $('#cSave').onclick = () => { const s = $('#selTec'); saveCase(r, s ? s.value : undefined); };

  $('#btnSolve').onclick = () => solveCase(r);

  const strip = $('#vstrip');
  if (strip) $$('.vs', strip).forEach((el, i) => el.onclick = () => openViewer([...vEnc, ...vTec], i));

  setTimeout(() => initMap('caseMap', { single: r.rbd, noStore: true }), 80);

  // AUTO-VISADO al abrir (si estaba No visado y no es eliminado)
  if (!yaVisado && !isBorrado(r)) autoVisar(r);
}
function verifThumbHTML(m, i) {
  const thumb = m.driveId ? driveThumb(m.driveId) : m.url;
  return `<div class="vs" data-i="${i}">${m.type === 'video' ? `<video src="${esc(m.url)}" muted></video><div class="vt">▶ video</div>` : `<img src="${esc(thumb)}" alt="" onerror="this.style.opacity=.3"><div class="vt">foto</div>`}</div>`;
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
async function solveCase(r) {
  if (!confirm('¿Marcar el caso ' + r.id + ' como solucionado?')) return;
  const solBtn = $('#btnSolve'); if (solBtn) solBtn.innerHTML = '<span class="spinner"></span>';
  const now = new Date();
  const res = await postAction({ accion: 'solucionar', encargado: r.encargado, reporteId: r.id, fechaSolucion: now.toLocaleString('es-CL'), tsSolucion: now.toISOString() });
  if (res && res.ok) {
    r.visado = 'SOLUCIONADO'; r.fechaSolucionado = now.toLocaleString('es-CL');
    const a = ALL.find(x => x.id === r.id && x.encargado === r.encargado); if (a) { a.visado = 'SOLUCIONADO'; a.fechaSolucionado = r.fechaSolucionado; }
    toast('Caso marcado como solucionado ✓');
    goBackFromCase();
  } else { toast('No se pudo actualizar'); const b = $('#btnSolve'); if (b) b.innerHTML = '✓ Solucionado'; }
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
function renderDerivados(keep) {
  currentView = 'derivados';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome; $('#modeLabel').textContent = 'Derivados';
  const act = activos(ALL);
  const derivados = act.filter(r => estadoDe(r).k === 'der' || (r.derivadoA && estadoDe(r).k === 'fin'));
  // agrupar por técnico
  const byTec = {};
  for (const r of act) {
    const t = (r.derivadoA || '').trim(); if (!t) continue;
    (byTec[t] = byTec[t] || []).push(r);
  }
  const techNames = [...new Set([...TECNICOS, ...Object.keys(byTec)])].filter(Boolean);

  const cards = techNames.map(t => {
    const cs = byTec[t] || [];
    const total = cs.length;
    const sol = cs.filter(r => estadoDe(r).k === 'fin').length;
    const tiempos = cs.filter(r => r.tiempoResolucion).map(r => r.tiempoResolucion);
    const tprom = tiempos.length ? tiempos[0] : '—'; // el primero como muestra; promedio real requiere ms
    return `<div class="tech-card">
      <div class="tc-name">🔧 ${esc(t)}</div>
      <div class="tc-kpis">
        <div class="tc-kpi"><div class="n">${total}</div><div class="l">Casos</div></div>
        <div class="tc-kpi"><div class="n">${sol}</div><div class="l">Solucionados</div></div>
        <div class="tc-kpi time"><div class="n">${sol ? tiempoPromedio(cs) : '—'}</div><div class="l">Tiempo prom.</div></div>
      </div>
    </div>`;
  }).join('');

  content.innerHTML = `<div class="screen">
    <div class="mkpis">
      <div class="mkpi b"><div class="bar"></div><div class="n">${derivados.length}</div><div class="l">Derivados</div></div>
      <div class="mkpi"><div class="bar"></div><div class="n">${techNames.length}</div><div class="l">Técnicos</div></div>
      <div class="mkpi g"><div class="bar"></div><div class="n">${derivados.filter(r => estadoDe(r).k === 'fin').length}</div><div class="l">Cerrados</div></div>
    </div>
    <div class="seg"><button class="sel" data-d="tec">Por técnico</button><button data-d="casos">Casos derivados</button></div>
    <div class="caselist" id="derBody"></div>
  </div>`;
  const body = $('#derBody');
  const paint = (mode) => {
    if (mode === 'casos') {
      const list = derivados.slice().sort((a, b) => tsOf(b) - tsOf(a));
      body.innerHTML = list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">↗️</div><p>Sin casos derivados.</p></div>`;
      bindCaseCards(body, list);
    } else {
      body.innerHTML = techNames.length ? cards : `<div class="empty"><div class="ic">🔧</div><p>Aún no hay técnicos con casos.</p></div>`;
    }
  };
  $$('.seg button').forEach(b => b.onclick = () => { $$('.seg button').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); paint(b.dataset.d); });
  paint('tec');
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
let listaTipo = 'novis';
function renderLista(tipo, keep) {
  listaTipo = tipo; currentView = 'lista';
  showNav(false); $('#btnHome').classList.remove('hidden'); $('#btnHome').onclick = renderHome;
  let list, titulo, ico;
  if (tipo === 'novis') { list = activos(ALL).filter(r => estadoDe(r).k === 'pend'); titulo = 'No visados'; ico = '📥'; }
  else { list = activos(ALL); titulo = 'Casos'; ico = '📋'; }
  $('#modeLabel').textContent = titulo;
  list = list.slice().sort((a, b) => tsOf(b) - tsOf(a));
  content.innerHTML = `<div class="screen">
    <div class="mkpis">
      <div class="mkpi"><div class="bar"></div><div class="n">${list.length}</div><div class="l">${esc(titulo)}</div></div>
      <div class="mkpi b"><div class="bar"></div><div class="n">${list.filter(esEmergencia).length}</div><div class="l">Emergencias</div></div>
      <div class="mkpi g"><div class="bar"></div><div class="n">${new Set(list.map(r => r.rbd)).size}</div><div class="l">Establec.</div></div>
    </div>
    <div class="caselist" id="lista">${list.length ? list.map(caseCardHTML).join('') : `<div class="empty"><div class="ic">${ico}</div><p>Sin casos ${esc(titulo.toLowerCase())}.</p></div>`}</div>
  </div>`;
  bindCaseCards($('#lista'), list);
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
  hookOrientation();
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
