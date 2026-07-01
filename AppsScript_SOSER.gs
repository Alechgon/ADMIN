/*******************************************************************
 * SOSER · Backend "Agregar Caso" — Google Apps Script (v2)
 * -----------------------------------------------------------------
 * NUEVO en v2:
 *  - Columnas "Visado" y "Derivado a" al final de cada hoja de encargado.
 *  - doGet(?encargado=NOMBRE) devuelve en JSON los reportes de ese
 *    encargado (para que la app los muestre aunque se borre el caché,
 *    con su estado Visado y a quién derivaste).
 *
 * Instalar (una sola vez) o ACTUALIZAR:
 *  1. Google Sheet ▸ Extensiones ▸ Apps Script.
 *  2. Borra todo y pega este archivo completo.
 *  3. Selecciona la función "primeraVez" ▸ ▶ Ejecutar (autoriza permisos).
 *  4. Implementar ▸ Gestionar implementaciones ▸ (lápiz para editar) ▸
 *     Versión: Nueva versión ▸ Implementar.  (Así conservas la misma URL /exec.)
 *     - Ejecutar como: Yo.  - Acceso: Cualquier persona.
 *  5. La URL /exec se pega en la app (Configuración).
 *******************************************************************/

var RBD_SEMILLA = [
  // [RBD, Establecimiento, Direccion, Comuna, Supervisor, Institucion, Tecnico]
];

var PREGUNTAS_APP = [
  ['Pantalla','Texto'],
  ['Inicio - título','Gestión de Casos'],
  ['Agregar caso - establecimiento','Indica el establecimiento'],
  ['Categorías','Gas | Electricidad | Filtraciones | Infraestructura | Equipos | Otro'],
  ['Descripción - label','Indique'],
  ['Verificadores','Foto | Video (máx 15s)'],
  ['Regla técnico','Estación Central = Multitécnico · Santiago = Rodrigo Martínez · resto = Por asignar']
];

var HEADERS = ['ID','Fecha','RBD','Establecimiento','Dirección','Comuna','Institución','Supervisor','Técnico','Categoría','Descripción','GPS','Precisión (m)','Verificadores','Timestamp','Visado','Derivado a'];

function primeraVez() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = ss.getSheetByName('Configuración') || ss.insertSheet('Configuración');
  if (cfg.getLastRow() === 0) {
    cfg.getRange(1,1,1,7).setValues([['RBD','Establecimiento','Dirección','Comuna','Supervisor','Institución','Técnico mantención']]);
    cfg.getRange(1,1,1,7).setFontWeight('bold').setBackground('#333333').setFontColor('#ffffff');
    if (RBD_SEMILLA.length) cfg.getRange(2,1,RBD_SEMILLA.length,7).setValues(RBD_SEMILLA);
    cfg.setFrozenRows(1);
    var startRow = Math.max(cfg.getLastRow(), 1) + 3;
    cfg.getRange(startRow,1).setValue('TEXTOS / PREGUNTAS DE LA APP (editables)').setFontWeight('bold');
    cfg.getRange(startRow+1,1,PREGUNTAS_APP.length,2).setValues(PREGUNTAS_APP);
    cfg.getRange(startRow+1,1,1,2).setFontWeight('bold').setBackground('#F49A0F').setFontColor('#ffffff');
  }
  SpreadsheetApp.getUi().alert('Listo. Hoja "Configuración" creada/verificada. Recuerda re-implementar como aplicación web (Nueva versión) para activar la lectura de reportes.');
}

function hojaEncargado(ss, nombre) {
  var sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.appendRow(HEADERS);
    sh.getRange(1,1,1,HEADERS.length).setFontWeight('bold').setBackground('#333333').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  } else {
    // asegurar columnas Visado / Derivado a
    var lastCol = sh.getLastColumn();
    var head = sh.getRange(1,1,1,Math.max(lastCol,HEADERS.length)).getValues()[0];
    if (head.indexOf('Visado') === -1) sh.getRange(1, HEADERS.indexOf('Visado')+1).setValue('Visado').setFontWeight('bold').setBackground('#333333').setFontColor('#ffffff');
    if (head.indexOf('Derivado a') === -1) sh.getRange(1, HEADERS.indexOf('Derivado a')+1).setValue('Derivado a').setFontWeight('bold').setBackground('#333333').setFontColor('#ffffff');
  }
  return sh;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // --- Acción del panel admin: derivar / visar un reporte existente ---
    if (data.accion === 'derivar' || data.accion === 'visar') {
      var shE = ss.getSheetByName(data.encargado);
      if (!shE) return json({ok:false, error:'Hoja de encargado no encontrada'});
      var vals = shE.getRange(1,1,shE.getLastRow(),HEADERS.length).getValues();
      var head = vals[0];
      var cId = head.indexOf('ID'), cVis = head.indexOf('Visado'), cDer = head.indexOf('Derivado a');
      for (var r=1;r<vals.length;r++){
        if (String(vals[r][cId]) === String(data.reporteId)) {
          if (data.accion === 'derivar' && cDer !== -1) shE.getRange(r+1, cDer+1).setValue(data.derivadoA||'');
          if (typeof data.visado !== 'undefined' && cVis !== -1) shE.getRange(r+1, cVis+1).setValue(data.visado||'');
          return json({ok:true, updated:data.reporteId});
        }
      }
      return json({ok:false, error:'Reporte no encontrado'});
    }

    // --- Alta de caso (desde la app de terreno) ---
    var nombreHoja = (data.encargado || 'Sin encargado').substring(0,90);
    var sh = hojaEncargado(ss, nombreHoja);

    var folder = obtenerCarpeta(ss.getId());
    var links = [];
    if (data.media && data.media.length) {
      for (var i=0; i<data.media.length; i++) {
        var m = data.media[i];
        var blob = Utilities.newBlob(Utilities.base64Decode(m.data), m.mime, m.name);
        var file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        links.push(m.name + ': ' + file.getUrl());
      }
    }
    sh.appendRow([
      data.reporteId||'', data.fecha||'', data.rbd||'', data.establecimiento||'',
      data.direccion||'', data.comuna||'', data.institucion||'', data.supervisor||'',
      data.tecnico||'', data.categoria||'', data.descripcion||'',
      data.gps||'', data.gps_acc||'', links.join('\n'), data.timestamp||'',
      '', ''  // Visado, Derivado a (los llenas tú / tu otra app)
    ]);
    return json({ok:true, id:data.reporteId});
  } catch (err) {
    return json({ok:false, error:String(err)});
  }
}

// Nombres de hoja que NO son de encargados
var HOJAS_SISTEMA = ['Configuración','Configuracion'];

function leerHoja(sh, encargado) {
  var out = [];
  if (!sh || sh.getLastRow() < 2) return out;
  var values = sh.getRange(1,1,sh.getLastRow(),HEADERS.length).getValues();
  var head = values[0];
  var idx = {};
  HEADERS.forEach(function(h){ idx[h] = head.indexOf(h); });
  for (var r=1; r<values.length; r++) {
    var row = values[r];
    if (!row[idx['ID']]) continue;
    out.push({
      encargado: encargado, fila: r+1,
      id: row[idx['ID']], fecha: row[idx['Fecha']], rbd: row[idx['RBD']],
      establecimiento: row[idx['Establecimiento']], direccion: row[idx['Dirección']],
      comuna: row[idx['Comuna']], institucion: row[idx['Institución']],
      supervisor: row[idx['Supervisor']], tecnico: row[idx['Técnico']],
      categoria: row[idx['Categoría']], descripcion: row[idx['Descripción']],
      gps: row[idx['GPS']], precision: row[idx['Precisión (m)']],
      verificadores: row[idx['Verificadores']], timestamp: row[idx['Timestamp']],
      visado: row[idx['Visado']] || '', derivadoA: row[idx['Derivado a']] || ''
    });
  }
  return out;
}

// doGet:
//   ?encargado=NOMBRE  -> reportes de ese encargado
//   ?admin=1           -> TODOS los reportes de TODAS las hojas de encargados
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (e && e.parameter && e.parameter.admin) {
      var sheets = ss.getSheets();
      var all = [];
      for (var i=0;i<sheets.length;i++) {
        var name = sheets[i].getName();
        if (HOJAS_SISTEMA.indexOf(name) !== -1) continue;
        all = all.concat(leerHoja(sheets[i], name));
      }
      return json({ok:true, reportes:all});
    }
    var enc = e && e.parameter && e.parameter.encargado;
    if (!enc) return ContentService.createTextOutput('SOSER Casos backend activo. Usa POST desde la app.');
    return json({ok:true, reportes: leerHoja(ss.getSheetByName(enc), enc)});
  } catch (err) {
    return json({ok:false, error:String(err)});
  }
}

function obtenerCarpeta(idHoja) {
  var nombre = 'SOSER_Casos_' + idHoja;
  var it = DriveApp.getFoldersByName(nombre);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(nombre);
}
function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
