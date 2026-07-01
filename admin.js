/* ============================================================
   SOSER · Panel Administrador
   Lee todos los reportes del Sheet, prioriza por gravedad
   (4 niveles según licitación), deriva y notifica.
   ============================================================ */
const LOGO_SVG=`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F49A0F"/><stop offset="0.5" stop-color="#E8A30C"/><stop offset="1" stop-color="#7DB61C"/></linearGradient></defs><path d="M50 12 C30 12 20 30 28 48 C34 62 50 64 50 64 C50 64 66 62 72 48 C80 30 70 12 50 12 Z" fill="url(#sg)"/><path d="M50 20 C44 30 56 40 50 52 C46 44 54 34 50 20 Z" fill="#2E7D32" opacity="0.85"/></svg>`;
const LS='soser_admin_cfg', LS_SEEN='soser_admin_seen';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const content=$('#content'),overlays=$('#overlays');
$('#logoSlot').innerHTML=LOGO_SVG;
let CFG=load(LS,{}), REPORTS=[], FILTER={cat:null,sev:null,q:''}, POLL=null, NOTIF=false;

function load(k,d){try{return JSON.parse(localStorage.getItem(k))||d}catch{return d}}
function save(k,v){localStorage.setItem(k,JSON.stringify(v));}
function toast(m,ms=2000){const t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),ms);}
function norm(s){return (s||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}

/* ============================================================ MOTOR DE GRAVEDAD (licitación) */
// Palabras clave por nivel. Basado en criticidad de mantención JUNAEB:
// seguridad inmediata > legal/habilitante > correctivo alto > menor.
const SEV_RULES=[
  {sev:'crit', label:'Crítico', kw:['fuga de gas','fuga gas','olor a gas','escape de gas','cable pelado','cables pelados','cortocircuito','corto circuito','electrocut','chispa','quemado','incendio','fuego','lesion','lesión','accidente','esguince','herido','descarga electrica','descarga eléctrica','sin tapa','tablero expuesto','gas suelto','clausurad']},
  {sev:'alto', label:'Alto', kw:['sec','certificacion','certificación','sin certificar','filtracion','filtración','fuga de agua','fuga agua','anegado','inundaci','sin agua caliente','sin gas','no enciende','no funciona','fuera de servicio','campana','extractor','desgrasadora','plaga','sin energia','sin energía','riesgo']},
  {sev:'medio', label:'Medio', kw:['gotea','goteo','humedad','oxido','óxido','rotur','roto','rota','grieta','filtra','luminaria','ampolleta','enchufe','toma corriente','flexible','sifon','sifón','manilla','llave','deteriorad','mal estado','defectuoso','caido','caído']},
  {sev:'bajo', label:'Bajo', kw:['pintura','basurero','dispensador','jabon','jabón','toalla','malla','mosquitero','menor','estetico','estético','cambio','revision','revisión','mantencion preventiva','mantención preventiva']}
];
const SEV_ORDER={crit:0,alto:1,medio:2,bajo:3};
const SEV_LABEL={crit:'Crítico',alto:'Alto',medio:'Medio',bajo:'Bajo'};
// categorías con piso de gravedad (gas/electricidad nunca bajo)
const CAT_FLOOR={'Gas':'alto','Electricidad':'alto'};

function scoreSeverity(r){
  const text=norm((r.categoria||'')+' '+(r.descripcion||''));
  let best=null;
  for(const rule of SEV_RULES){
    if(rule.kw.some(k=>text.includes(norm(k)))){best=rule.sev;break;}
  }
  // piso por categoría
  const floor=CAT_FLOOR[r.categoria];
  if(floor){ if(best===null||SEV_ORDER[best]>SEV_ORDER[floor]) best=floor; }
  if(best===null) best='medio'; // por defecto medio si no matchea nada
  return best;
}

/* ============================================================ SETUP */
function renderSetup(){
  content.innerHTML=`<div class="setup"><div class="card">
    <h2 style="margin:0 0 6px">Panel Administrador</h2>
    <p style="color:var(--muted);margin:0 0 18px">Conecta el mismo Apps Script del Sheet para ver todos los reportes.</p>
    <div style="margin-bottom:16px"><label class="fld">URL del Apps Script (/exec)</label>
      <input type="url" id="url" placeholder="https://script.google.com/macros/s/.../exec" value="${CFG.url||''}"></div>
    <button class="btn accent" id="save">Conectar</button>
  </div></div>`;
  $('#save').onclick=()=>{
    const url=$('#url').value.trim();
    if(!/^https:\/\/script\.google\.com\/.*\/exec$/.test(url)){ if(!confirm('La URL no parece /exec. ¿Continuar?'))return; }
    CFG={url};save(LS,CFG);loadAll();
  };
}

/* ============================================================ CARGAR DATOS */
async function loadAll(){
  content.innerHTML=`<div class="loading"><div class="spinner" style="border-top-color:var(--orange);width:26px;height:26px"></div><p>Cargando reportes…</p></div>`;
  const data=await fetchAdmin();
  if(!data){ content.innerHTML=`<div class="empty"><div class="ic">⚠️</div><p>No se pudieron cargar los reportes.<br>Revisa la URL y que el Apps Script tenga acceso "Cualquier persona".</p><button class="btn ghost" id="reCfg" style="margin-top:14px">Revisar configuración</button></div>`;$('#reCfg').onclick=renderSetup;return; }
  REPORTS=data.map(r=>({...r, sev:scoreSeverity(r)}));
  // detectar nuevos para notificar
  checkNew(REPORTS);
  renderDashboard();
}
async function fetchAdmin(){
  try{
    const res=await fetch(CFG.url+'?admin=1&t='+Date.now());
    const d=await res.json();
    if(d&&d.ok&&Array.isArray(d.reportes))return d.reportes;
    return null;
  }catch(e){return null;}
}

/* ============================================================ DASHBOARD */
function renderDashboard(){
  const counts={crit:0,alto:0,medio:0,bajo:0};
  REPORTS.forEach(r=>counts[r.sev]++);
  const cats={};
  REPORTS.forEach(r=>{const c=r.categoria||'Otro';cats[c]=(cats[c]||0)+1;});
  const filtered=applyFilter(REPORTS);
  content.innerHTML=`
    <div class="sync"><span class="dot"></span> ${REPORTS.length} reportes · actualizado ${new Date().toLocaleTimeString('es-CL')}</div>
    <div class="kpis">
      <div class="kpi tot"><div class="bar"></div><div class="n">${REPORTS.length}</div><div class="l">Total casos</div></div>
      <div class="kpi crit"><div class="bar"></div><div class="n">${counts.crit}</div><div class="l">Crítico</div></div>
      <div class="kpi alto"><div class="bar"></div><div class="n">${counts.alto}</div><div class="l">Alto</div></div>
      <div class="kpi medio"><div class="bar"></div><div class="n">${counts.medio}</div><div class="l">Medio</div></div>
      <div class="kpi bajo"><div class="bar"></div><div class="n">${counts.bajo}</div><div class="l">Bajo</div></div>
    </div>
    <div class="catbar" id="catbar">
      <div class="catchip ${!FILTER.cat?'sel':''}" data-cat=""><span>Todas</span><span class="cnt">${REPORTS.length}</span></div>
      ${Object.keys(cats).sort((a,b)=>cats[b]-cats[a]).map(c=>`<div class="catchip ${FILTER.cat===c?'sel':''}" data-cat="${c}"><span>${c}</span><span class="cnt">${cats[c]}</span></div>`).join('')}
    </div>
    <div class="filters">
      <input class="search" id="fq" placeholder="Buscar por RBD, establecimiento, texto…" value="${FILTER.q}">
      <select id="fsev">
        <option value="">Toda gravedad</option>
        <option value="crit" ${FILTER.sev==='crit'?'selected':''}>Crítico</option>
        <option value="alto" ${FILTER.sev==='alto'?'selected':''}>Alto</option>
        <option value="medio" ${FILTER.sev==='medio'?'selected':''}>Medio</option>
        <option value="bajo" ${FILTER.sev==='bajo'?'selected':''}>Bajo</option>
      </select>
    </div>
    <div class="cases" id="cases">${renderCases(filtered)}</div>`;
  $$('#catbar .catchip').forEach(c=>c.onclick=()=>{FILTER.cat=c.dataset.cat||null;renderDashboard();});
  $('#fq').oninput=e=>{FILTER.q=e.target.value;$('#cases').innerHTML=renderCases(applyFilter(REPORTS));bindCases();};
  $('#fsev').onchange=e=>{FILTER.sev=e.target.value||null;renderDashboard();};
  bindCases();
}
function applyFilter(list){
  let out=list.slice();
  if(FILTER.cat)out=out.filter(r=>(r.categoria||'Otro')===FILTER.cat);
  if(FILTER.sev)out=out.filter(r=>r.sev===FILTER.sev);
  if(FILTER.q){const q=norm(FILTER.q);out=out.filter(r=>norm((r.rbd||'')+' '+(r.establecimiento||'')+' '+(r.descripcion||'')+' '+(r.encargado||'')+' '+(r.comuna||'')).includes(q));}
  // orden: gravedad, luego más recientes
  out.sort((a,b)=>SEV_ORDER[a.sev]-SEV_ORDER[b.sev] || (b.timestamp||'').localeCompare(a.timestamp||''));
  return out;
}
function renderCases(list){
  if(!list.length)return `<div class="empty"><div class="ic">📭</div><p>Sin casos para este filtro.</p></div>`;
  const seen=load(LS_SEEN,[]);
  return list.map((r,i)=>{
    const isNew=!seen.includes(r.encargado+'|'+r.id);
    return `<div class="case ${r.sev}" data-i="${REPORTS.indexOf(r)}">
      <div class="top">
        <span class="sev ${r.sev}">${SEV_LABEL[r.sev]}</span>
        <span class="cid">${r.id}</span>
        <span class="cat">· ${r.categoria||'—'}</span>
        ${isNew?'<span class="badge new">NUEVO</span>':''}
      </div>
      <div class="est">${r.establecimiento||'—'} · RBD ${r.rbd||'—'}</div>
      <div class="desc">${(r.descripcion||'').slice(0,140)}${(r.descripcion||'').length>140?'…':''}</div>
      <div class="meta">
        <span>📍 <b>${r.comuna||'—'}</b></span>
        <span>👷 <b>${r.tecnico||'—'}</b></span>
        <span>🗓️ ${r.fecha||'—'}</span>
      </div>
      <div class="badges">
        <span class="badge enc">Subió: ${r.encargado||'—'}</span>
        ${r.visado?`<span class="badge vis">✓ Visado: ${r.visado}</span>`:''}
        ${r.derivadoA?`<span class="badge der">↗ Derivado: ${r.derivadoA}</span>`:''}
      </div>
    </div>`;}).join('');
}
function bindCases(){$$('#cases .case').forEach(c=>c.onclick=()=>openDetail(REPORTS[+c.dataset.i]));}

/* ============================================================ DETALLE + DERIVAR */
function openDetail(r){
  // marcar como visto
  const seen=load(LS_SEEN,[]);const key=r.encargado+'|'+r.id;
  if(!seen.includes(key)){seen.push(key);save(LS_SEEN,seen);}
  const links=parseVerif(r.verificadores);
  const gps=(r.gps||'').trim();
  const bg=document.createElement('div');bg.className='modal-bg';
  bg.innerHTML=`<div class="modal">
    <header><span class="sev" style="background:${sevColor(r.sev)};color:${r.sev==='medio'?'#5a4500':'#fff'}">${SEV_LABEL[r.sev]}</span>
      <b>${r.id} · ${r.categoria||''}</b><button class="x" id="mx">✕</button></header>
    <div class="body">
      <div class="dsection">Establecimiento</div>
      <div class="drow"><span>Nombre</span><b>${r.establecimiento||'—'}</b></div>
      <div class="drow"><span>RBD</span><b>${r.rbd||'—'}</b></div>
      <div class="drow"><span>Dirección</span><b>${r.direccion||'—'}</b></div>
      <div class="drow"><span>Comuna</span><b>${r.comuna||'—'}</b></div>
      <div class="drow"><span>Institución</span><b>${r.institucion||'—'}</b></div>
      <div class="drow"><span>Supervisor</span><b>${r.supervisor||'—'}</b></div>
      <div class="drow"><span>Técnico mantención</span><b>${r.tecnico||'—'}</b></div>
      ${gps?`<a class="mapbtn" href="https://www.google.com/maps?q=${encodeURIComponent(gps)}" target="_blank">📍 Ver ubicación en mapa (${gps})</a>`:''}

      <div class="dsection">Caso</div>
      <div class="drow"><span>Categoría</span><b>${r.categoria||'—'}</b></div>
      <div class="drow"><span>Gravedad (auto)</span><b style="color:${sevColor(r.sev)}">${SEV_LABEL[r.sev]}</b></div>
      <div class="drow"><span>Descripción</span><b>${r.descripcion||'—'}</b></div>
      <div class="drow"><span>Fecha</span><b>${r.fecha||'—'}</b></div>
      <div class="drow"><span>Subido por</span><b>${r.encargado||'—'}</b></div>
      <div class="drow"><span>ID reporte</span><b>${r.id}</b></div>

      <div class="dsection">Verificadores</div>
      ${links.length?`<div class="verif-links">${links.map(l=>`<a href="${l.url}" target="_blank">📎 ${l.name}</a>`).join('')}</div>`:'<p style="color:var(--muted);font-size:13px">Sin verificadores adjuntos.</p>'}

      <div class="derive-box">
        <div class="dsection" style="margin-top:0">Gestión</div>
        <div class="drow"><span>Visado actual</span><b>${r.visado||'—'}</b></div>
        <div class="drow"><span>Derivado a</span><b>${r.derivadoA||'—'}</b></div>
        <label class="fld" style="margin-top:12px">Derivar a (persona/equipo que ejecuta)</label>
        <input type="text" id="derivInput" placeholder="Ej: Rodrigo Martínez / Cuadrilla gas" value="${r.derivadoA||''}">
        <div class="btns">
          <button class="btn accent" id="btnDerivar" style="flex:1">↗ Derivar</button>
          <button class="btn dark" id="btnVisar" style="flex:0 0 auto">✓ Visar</button>
        </div>
      </div>
    </div>
  </div>`;
  overlays.appendChild(bg);
  const close=()=>bg.remove();
  bg.onclick=e=>{if(e.target===bg)close();};
  $('#mx',bg).onclick=close;
  $('#btnDerivar',bg).onclick=async()=>{
    const to=$('#derivInput',bg).value.trim();if(!to){toast('Escribe a quién derivar');return;}
    $('#btnDerivar',bg).innerHTML='<span class="spinner"></span>';
    const ok=await sendAction({accion:'derivar',encargado:r.encargado,reporteId:r.id,derivadoA:to,visado:r.visado||'Manuel'});
    if(ok){r.derivadoA=to;r.visado=r.visado||'Manuel';toast('Derivado ✓');close();renderDashboard();}
    else{toast('No se pudo derivar');$('#btnDerivar',bg).textContent='↗ Derivar';}
  };
  $('#btnVisar',bg).onclick=async()=>{
    $('#btnVisar',bg).innerHTML='<span class="spinner"></span>';
    const ok=await sendAction({accion:'visar',encargado:r.encargado,reporteId:r.id,visado:'Manuel'});
    if(ok){r.visado='Manuel';toast('Visado ✓');close();renderDashboard();}
    else{toast('No se pudo visar');$('#btnVisar',bg).textContent='✓ Visar';}
  };
}
function sevColor(s){return{crit:'#C62828',alto:'#EF6C00',medio:'#F9A825',bajo:'#7DB61C'}[s]||'#999';}
function parseVerif(v){
  if(!v)return[];
  return v.toString().split('\n').map(line=>{
    const m=line.match(/^(.*?):\s*(https?:\/\/.+)$/);
    if(m)return{name:m[1].trim(),url:m[2].trim()};
    const u=line.match(/(https?:\/\/\S+)/);
    return u?{name:'verificador',url:u[1]}:null;
  }).filter(Boolean);
}
async function sendAction(payload){
  try{
    await fetch(CFG.url,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload)});
    return true; // no-cors opaco; asumimos éxito
  }catch(e){return false;}
}

/* ============================================================ NOTIFICACIONES */
function initNotif(){
  const btn=$('#btnNotif');
  if(!('Notification' in window)){btn.style.display='none';return;}
  const refresh=()=>{NOTIF=(Notification.permission==='granted');btn.classList.toggle('on',NOTIF);btn.innerHTML=NOTIF?'🔔 Notificaciones ON':'🔔 Notificaciones';};
  refresh();
  btn.onclick=async()=>{
    if(Notification.permission==='granted'){toast('Ya están activas');return;}
    const p=await Notification.requestPermission();refresh();
    if(p==='granted')toast('Notificaciones activadas');else toast('Permiso denegado');
  };
}
function notify(title,body){
  if(NOTIF && Notification.permission==='granted'){
    try{new Notification(title,{body,icon:'',badge:''});}catch(e){}
  }
}
function checkNew(reports){
  const seen=load(LS_SEEN,[]);
  const nuevos=reports.filter(r=>!seen.includes(r.encargado+'|'+r.id));
  if(!nuevos.length)return;
  // notificar los graves primero
  const crit=nuevos.filter(r=>r.sev==='crit');
  const alto=nuevos.filter(r=>r.sev==='alto');
  if(crit.length){notify('⚠️ Caso CRÍTICO nuevo',`${crit[0].categoria} · ${crit[0].establecimiento} (RBD ${crit[0].rbd})`);}
  else if(alto.length){notify('🟠 Caso Alto nuevo',`${alto[0].categoria} · ${alto[0].establecimiento}`);}
  else{notify('Nuevo caso registrado',`${nuevos.length} caso(s) nuevo(s)`);}
}

/* ============================================================ POLLING + REFRESH */
function startPolling(){
  if(POLL)clearInterval(POLL);
  POLL=setInterval(async()=>{
    if(!CFG.url)return;
    const data=await fetchAdmin();
    if(data){
      const mapped=data.map(r=>({...r,sev:scoreSeverity(r)}));
      // detectar nuevos vs REPORTS actuales
      const prevIds=new Set(REPORTS.map(r=>r.encargado+'|'+r.id));
      const nuevos=mapped.filter(r=>!prevIds.has(r.encargado+'|'+r.id));
      REPORTS=mapped;
      if(nuevos.length){checkNew(mapped);renderDashboard();toast(`${nuevos.length} caso(s) nuevo(s)`);}
    }
  },60000); // cada 60 s
}

/* ============================================================ ARRANQUE */
$('#btnRefresh').onclick=()=>{if(CFG.url)loadAll();};
initNotif();
if(CFG.url){loadAll();startPolling();}else{renderSetup();}
