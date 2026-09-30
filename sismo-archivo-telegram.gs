/**
 * ============================================================
 *  ARCHIVO SÍSMICO + ALERTAS TELEGRAM — Google Apps Script
 * ============================================================
 *  Vigila cada 5 minutos las fuentes (FUNVISIS + USGS + EMSC), guarda
 *  todo evento nuevo en una hoja de cálculo (tu catálogo histórico
 *  propio) y PUBLICA EN UN CANAL DE TELEGRAM cada sismo relevante,
 *  con vista satelital del epicentro, pin de mapa interactivo,
 *  enlace directo al evento en la web y validación cruzada entre
 *  redes sismológicas (FUNVISIS vs USGS). Funciona 24/7 en los
 *  servidores de Google, sin depender de tu computadora.
 *
 *  ⚠ IMPORTANTE: este archivo se agrega como SEGUNDO archivo
 *  en el MISMO proyecto donde ya está funvisis-proxy.gs
 *  (reutiliza sus funciones obtenerDatos y normalizar).
 *
 *  INSTALACIÓN:
 *  1. Abre tu proyecto del proxy en script.google.com
 *  2. En el panel izquierdo: Archivos → + → Secuencia de comandos
 *     Nómbralo "archivo-telegram" y pega este contenido
 *  3. Crea tu bot de Telegram:
 *       En Telegram, habla con @BotFather → /newbot → te da un TOKEN
 *  4. Crea el CANAL público:
 *       a. Telegram → menú → Nuevo canal → ponle nombre
 *          (ej. "SISMO·MONITOR Venezuela") y hazlo PÚBLICO
 *       b. Elige un enlace/usuario, por ejemplo @michihub_oficial
 *       c. Canal → Administradores → Agregar administrador → busca tu bot
 *          y dale permiso de "Publicar mensajes"  ← IMPRESCINDIBLE
 *  5. Pega TOKEN y TELEGRAM_CANAL abajo en CONFIG y ajusta los criterios
 *  6. Ejecuta ▶ configurarArchivo  → crea la hoja de cálculo
 *  7. Ejecuta ▶ probarCanal        → debe publicarse un sismo de prueba
 *  8. Ejecuta ▶ instalarTrigger    → activa la vigilancia cada 5 min
 *  9. Comparte t.me/tucanal para que la gente se suscriba
 * 10. (Recomendado) Para recibir avisos si algo se rompe, pon tu chat
 *     personal en TELEGRAM_CHAT_ID y ejecuta ▶ probarSalud
 *
 *  Para detener la vigilancia: ejecuta desinstalarTrigger.
 * ============================================================
 */

var CONFIG = {
  // --- Telegram ---
  TELEGRAM_TOKEN: 'PEGA_AQUI_TU_TOKEN',

  // Canal público: los suscriptores reciben cada sismo relevante.
  // Usa @nombredelcanal (si es público) o el id numérico -100xxxxxxxxxx.
  TELEGRAM_CANAL: '@PEGA_AQUI_TU_CANAL',

  // Chat privado (opcional): alertas personales solo para ti.
  // Déjalo vacío si solo quieres publicar en el canal.
  TELEGRAM_CHAT_ID: '',

  // --- Criterios de publicación en el CANAL ---
  CANAL_VEN_MAG_MIN: 2.6,      // sismos dentro de ZONA_LOCAL (ver abajo)
  CANAL_MUNDO_MAG_MIN: 7.0,    // fuera de la zona: solo grandes terremotos.
                               // Se deja en 7.0 (y no en 99) a propósito: un M7+
                               // en la fosa de Puerto Rico o el Atlántico puede
                               // implicar aviso de tsunami para la costa venezolana.
  CANAL_CON_IMAGEN: true,      // adjuntar vista satelital del epicentro
  CANAL_CON_MAPA: true,        // adjuntar pin de mapa interactivo de Telegram

  // --- Criterios de alerta PRIVADA (solo si TELEGRAM_CHAT_ID está definido) ---
  ALERTA_MAG_MIN: 4.0,
  ALERTA_LAT: 10.48,       // tu ubicación (por defecto: Caracas)
  ALERTA_LON: -66.90,
  ALERTA_RADIO_KM: 500,    // 0 = sin filtro de distancia

  // --- Enlace a la web (para los enlaces profundos de cada evento) ---
  WEB_URL: 'https://ehyenmanft.github.io/monitor-sismico/',

  // --- Archivo ---
  ARCHIVAR_TODO: true,     // true: guarda TODOS los eventos en la hoja

  // --- Vigilancia de salud del sistema ---
  // Los avisos de salud van SIEMPRE a tu chat privado, nunca al canal.
  // Necesita TELEGRAM_CHAT_ID; si está vacío, solo quedan en el registro.
  SALUD_ACTIVA: true,
  SALUD_HORAS_FUNVISIS: 12,   // sin ningún evento venezolano en N horas → aviso
  SALUD_HORAS_USGS: 3,        // USGS publica constantemente: 3 h de silencio ya es raro
  SALUD_FALLOS_SEGUIDOS: 3,   // N ciclos seguidos sin poder leer una fuente → aviso
  SALUD_REPETIR_HORAS: 12,    // no repetir el mismo aviso antes de N horas
  RESUMEN_SEMANAL: true       // informe de estado los lunes por la mañana
};

// Zona de cobertura del canal: Venezuela, su mar Caribe y las Antillas cercanas
// (incluye Aruba–Curazao–Bonaire, Trinidad y Tobago, Granada y Barbados).
// Queda fuera: República Dominicana, Puerto Rico, Colombia y el Caribe occidental.
var ZONA_LOCAL = {minlat: 0.5, maxlat: 14.5, minlon: -73.5, maxlon: -59};

// El nido sísmico de Bucaramanga (Colombia) roza el borde oeste del recuadro y
// produce sismos M3–4 casi a diario. Se omiten del canal salvo que sean
// significativos (M 4.5+), magnitud a la que sí se sienten en Táchira y Zulia.
var EXCLUIR_NIDO = {minlat: 6.0, maxlat: 7.6, minlon: -74.2, maxlon: -72.4};
var EXCLUIR_NIDO_BAJO = 4.5;

var URL_USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
var URL_EMSC = 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=100&starttime=';

/* FUNVISIS describe cada sismo respecto a la ciudad más cercana, que a veces
   está fuera de Venezuela (Bucaramanga, Santa Marta, Barbados, Bonaire...).
   Etiquetar todo como "Venezuela" era incorrecto y confunde en el canal. */
var REF_PAIS = {
  'bucaramanga':'Colombia', 'santa marta':'Colombia', 'cucuta':'Colombia',
  'valledupar':'Colombia', 'riohacha':'Colombia', 'maicao':'Colombia',
  'arauca':'Colombia', 'barranquilla':'Colombia',
  'barbados':'Barbados', 'bonaire':'Países Bajos', 'curazao':'Países Bajos',
  'aruba':'Países Bajos', 'trinidad':'Trinidad y Tobago',
  'tobago':'Trinidad y Tobago', 'scarborough':'Trinidad y Tobago',
  'granada':'Granada', 'georgetown':'Guyana'
};
function paisDeLugar_(txt) {
  var t = String(txt || '').toLowerCase();
  for (var ref in REF_PAIS) { if (t.indexOf(ref) !== -1) return REF_PAIS[ref]; }
  return 'Venezuela';
}

/* ================= función principal (la del trigger) ================= */

function vigilarSismos() {
  var tiempoInicio = Date.now();
  var eventos = [];

  // FUNVISIS — reutiliza las funciones del archivo funvisis-proxy.gs
  try {
    var rawFV = obtenerDatos(false);
    var fv = normalizar(rawFV);
    var fvOk = !(rawFV.via && rawFV.via.indexOf('error') === 0);

    if (fvOk && fv.features && fv.features.length) {
      fv.features.forEach(function (f) {
        var p = f.properties;
        var t = convertirFechaVE_(p.date, p.time);
        if (!t || isNaN(t.getTime())) return;
        eventos.push({
          id: 'fv-' + (p.date || '').replace(/[\/\s:]/g, '') + '-' + (p.time || '').replace(/[:\s]/g, '') + '-' + (p.lat || '') + '-' + (p.long || ''),
          fuente: 'FUNVISIS',
          t: t,
          mag: parseFloat(p.value),
          lat: parseFloat(p.lat),
          lon: parseFloat(p.long),
          prof: parseFloat(p.depth) || 0,
          lugar: (function () {
            var l = p.addressFormatted || '—';
            return l + ', ' + paisDeLugar_(l);
          })()
        });
      });
      saludRegistrar_('funvisis', true);
    } else {
      saludRegistrar_('funvisis', false, rawFV.via || 'Sin eventos');
    }
  } catch (err) {
    Logger.log('FUNVISIS falló: ' + err);
    saludRegistrar_('funvisis', false, String(err));
  }

  // USGS
  try {
    var resp = UrlFetchApp.fetch(URL_USGS, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var gj = JSON.parse(resp.getContentText());
      (gj.features || []).forEach(function (f) {
        if (f.properties.mag == null) return;
        eventos.push({
          id: f.id,
          fuente: 'USGS',
          t: new Date(f.properties.time),
          mag: f.properties.mag,
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          prof: f.geometry.coordinates[2] || 0,
          lugar: f.properties.place || '—',
          tsunami: f.properties.tsunami === 1,
          pager: f.properties.alert || null,
          felt: f.properties.felt || null
        });
      });
      saludRegistrar_('usgs', true);
    } else {
      saludRegistrar_('usgs', false, 'HTTP ' + resp.getResponseCode());
    }
  } catch (err) {
    Logger.log('USGS falló: ' + err);
    saludRegistrar_('usgs', false, String(err));
  }

  // EMSC — ventana de 12 horas y límite de 100 para no agotar memoria ni tiempo
  try {
    var desdeIso = Utilities.formatDate(new Date(Date.now() - 12 * 3600000),
                                        'UTC', "yyyy-MM-dd'T'HH:mm:ss");
    var re = UrlFetchApp.fetch(URL_EMSC + desdeIso, { muteHttpExceptions: true });
    if (re.getResponseCode() === 200) {
      var ej = JSON.parse(re.getContentText());
      (ej.features || []).forEach(function (f) {
        var p = f.properties || {};
        if (p.mag == null) return;
        eventos.push({
          id: 'em-' + (p.unid || p.source_id),
          fuente: 'EMSC',
          t: new Date(p.time),
          mag: p.mag,
          lat: p.lat,
          lon: p.lon,
          prof: p.depth || 0,
          lugar: p.flynn_region || '—'
        });
      });
      saludRegistrar_('emsc', true);
    } else if (re.getResponseCode() !== 204) {
      saludRegistrar_('emsc', false, 'HTTP ' + re.getResponseCode());
    }
  } catch (err) {
    Logger.log('EMSC falló: ' + err);
    saludRegistrar_('emsc', false, String(err));
  }

  if (!eventos.length) { Logger.log('Sin datos de ninguna fuente.'); return; }

  var props = PropertiesService.getScriptProperties();
  var primeraVez = props.getProperty('inicializado') !== '1';
  var ahora = Date.now();

  // 1) Memoria de sismos YA publicados en Telegram (deduplicación persistente)
  var publicadosTelegram = [];
  try {
    var rawPub = props.getProperty('telegram_publicados');
    if (rawPub) publicadosTelegram = JSON.parse(rawPub);
  } catch (ePub) {
    publicadosTelegram = [];
  }

  function yaFuePublicadoEnTelegram_(e) {
    var eTime = e.t.getTime();
    for (var i = 0; i < publicadosTelegram.length; i++) {
      var p = publicadosTelegram[i];
      if (p.id === e.id) return true;
      // Mismo sismo físico reportado por otra red o con desfase de minutos
      if (Math.abs(p.t - eTime) <= 20 * 60 * 1000 &&
          Math.abs(p.lat - e.lat) <= 0.6 &&
          Math.abs(p.lon - e.lon) <= 0.6) {
        return true;
      }
    }
    return false;
  }

  function registrarPublicadoTelegram_(e) {
    publicadosTelegram.push({
      id: e.id,
      t: e.t.getTime(),
      lat: e.lat,
      lon: e.lon,
      mag: e.mag,
      enviadoEn: Date.now()
    });
    if (publicadosTelegram.length > 50) {
      publicadosTelegram = publicadosTelegram.slice(publicadosTelegram.length - 50);
    }
    try {
      props.setProperty('telegram_publicados', JSON.stringify(publicadosTelegram));
    } catch (eSave) {}
  }

  // 2) Gestión de IDs vistos para el archivo histórico (Google Sheets)
  var vistos = [];
  try {
    var rawVistos = props.getProperty('ids_vistos');
    if (rawVistos) vistos = JSON.parse(rawVistos);
  } catch (e) {
    vistos = [];
  }
  var setVistos = {};
  vistos.forEach(function (id) { setVistos[id] = true; });

  var nuevos = eventos.filter(function (e) { return !setVistos[e.id]; });

  // Archivar en Google Sheets (solo eventos nuevos)
  if (nuevos.length) {
    var aGuardar = CONFIG.ARCHIVAR_TODO ? nuevos : nuevos.filter(cumpleCriterios_);
    if (aGuardar.length) archivar_(aGuardar);
  }

  // 3) Publicación en Telegram (Canal y Privado)
  if (!primeraVez) {
    // Filtrar candidatos para el canal:
    // - Ocurridos en las últimas 2.5 horas (no alertar por sismos antiguos del feed)
    // - Cumplen magnitud y zona
    // - NO han sido publicados antes (por ninguna red)
    var paraCanal = eventos.filter(function (e) {
      if (ahora - e.t.getTime() > 2.5 * 3600 * 1000) return false;
      if (!esParaCanal_(e)) return false;
      if (yaFuePublicadoEnTelegram_(e)) return false;
      return true;
    }).sort(function (a, b) { return b.mag - a.mag; });

    // Deduplicación dentro de la misma tanda y envío
    var enviadosEnEstaTanda = [];
    paraCanal.forEach(function (e) {
      for (var i = 0; i < enviadosEnEstaTanda.length; i++) {
        var o = enviadosEnEstaTanda[i];
        if (Math.abs(o.t.getTime() - e.t.getTime()) <= 20 * 60 * 1000 &&
            Math.abs(o.lat - e.lat) <= 0.6 && Math.abs(o.lon - e.lon) <= 0.6) {
          return;
        }
      }
      if (enviadosEnEstaTanda.length < 3) {
        publicarEnCanal_(e, cruzarFuentes_(e, eventos));
        registrarPublicadoTelegram_(e);
        enviadosEnEstaTanda.push(e);
      }
    });

    // Alertas Privadas
    if (CONFIG.TELEGRAM_CHAT_ID) {
      var paraPrivado = eventos.filter(function (e) {
        if (ahora - e.t.getTime() > 2.5 * 3600 * 1000) return false;
        if (!cumpleCriterios_(e)) return false;
        if (yaFuePublicadoEnTelegram_(e)) return false;
        return true;
      }).sort(function (a, b) { return b.mag - a.mag; });

      paraPrivado.slice(0, 3).forEach(function (e) {
        enviarTelegram_(e, CONFIG.TELEGRAM_CHAT_ID);
        registrarPublicadoTelegram_(e);
      });
    }
  } else {
    // En la primera ejecución marcamos los eventos existentes como ya conocidos
    eventos.forEach(function (e) {
      if (esParaCanal_(e)) registrarPublicadoTelegram_(e);
    });
  }

  // Actualizar memoria de IDs para la hoja de cálculo (máx 200 IDs)
  nuevos.forEach(function (e) { vistos.push(e.id); });
  if (vistos.length > 200) vistos = vistos.slice(vistos.length - 200);
  try {
    props.setProperty('ids_vistos', JSON.stringify(vistos));
    props.setProperty('inicializado', '1');
  } catch (errStorage) {
    try { props.setProperty('ids_vistos', JSON.stringify(vistos.slice(-60))); } catch (e2) {}
  }

  // registrar el evento más reciente de cada red
  saludUltimoEvento_(eventos);

  Logger.log('Eventos: ' + eventos.length + ' · nuevos: ' + nuevos.length +
             (primeraVez ? ' (primera ejecución: sin alertas)' : ''));

  if (CONFIG.SALUD_ACTIVA && !primeraVez) revisarSalud_();
  if (CONFIG.RESUMEN_SEMANAL) resumenSemanal_();
}

/* ================= criterios y utilidades ================= */

/** ¿Este sismo merece publicarse en el canal? */
function esParaCanal_(e) {
  // ruido diario del nido de Bucaramanga: fuera del canal salvo que sea fuerte
  if (e.mag < EXCLUIR_NIDO_BAJO &&
      e.lat >= EXCLUIR_NIDO.minlat && e.lat <= EXCLUIR_NIDO.maxlat &&
      e.lon >= EXCLUIR_NIDO.minlon && e.lon <= EXCLUIR_NIDO.maxlon) return false;

  var local = e.lat >= ZONA_LOCAL.minlat && e.lat <= ZONA_LOCAL.maxlat &&
              e.lon >= ZONA_LOCAL.minlon && e.lon <= ZONA_LOCAL.maxlon;
  return e.mag >= (local ? CONFIG.CANAL_VEN_MAG_MIN : CONFIG.CANAL_MUNDO_MAG_MIN);
}

/**
 * Validación cruzada: busca el mismo sismo reportado por OTRA red
 * (misma ventana de 10 min y menos de 0.5° de separación).
 * Permite publicar "FUNVISIS M 4.0 · USGS M 4.2", que es la mejor
 * señal de fiabilidad que puede dar el canal.
 */
function cruzarFuentes_(e, todos) {
  for (var i = 0; i < todos.length; i++) {
    var o = todos[i];
    if (o.fuente === e.fuente) continue;
    if (Math.abs(o.t.getTime() - e.t.getTime()) < 10 * 60 * 1000 &&
        Math.abs(o.lat - e.lat) < 0.5 &&
        Math.abs(o.lon - e.lon) < 0.5) return o;
  }
  return null;
}

function cumpleCriterios_(e) {
  if (e.mag < CONFIG.ALERTA_MAG_MIN) return false;
  if (!CONFIG.ALERTA_RADIO_KM) return true;
  return distanciaKm_(CONFIG.ALERTA_LAT, CONFIG.ALERTA_LON, e.lat, e.lon) <= CONFIG.ALERTA_RADIO_KM;
}

function distanciaKm_(lat1, lon1, lat2, lon2) {
  var R = 6371, rad = Math.PI / 180;
  var dLa = (lat2 - lat1) * rad, dLo = (lon2 - lon1) * rad;
  var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
          Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
          Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function convertirFechaVE_(fecha, hora) {
  if (!fecha) return null;
  var str = String(fecha).trim();
  var horaStr = (hora ? String(hora).trim() : '00:00');
  if (horaStr.length === 5) horaStr += ':00';

  // Si ya viene en formato ISO completo
  if (str.indexOf('T') !== -1) {
    var dIso = new Date(str);
    if (!isNaN(dIso.getTime())) return dIso;
  }

  // Formato YYYY-MM-DD o YYYY/MM/DD
  var matchISO = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (matchISO) {
    var m = matchISO[2].length === 1 ? '0' + matchISO[2] : matchISO[2];
    var d = matchISO[3].length === 1 ? '0' + matchISO[3] : matchISO[3];
    return new Date(matchISO[1] + '-' + m + '-' + d + 'T' + horaStr + '-04:00');
  }

  // Formato DD-MM-YYYY o DD/MM/YYYY
  var matchVE = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (matchVE) {
    var d2 = matchVE[1].length === 1 ? '0' + matchVE[1] : matchVE[1];
    var m2 = matchVE[2].length === 1 ? '0' + matchVE[2] : matchVE[2];
    return new Date(matchVE[3] + '-' + m2 + '-' + d2 + 'T' + horaStr + '-04:00');
  }

  var fallback = new Date(str + ' ' + horaStr + ' GMT-0400');
  return isNaN(fallback.getTime()) ? null : fallback;
}

/* ================= archivo en hoja de cálculo ================= */

function archivar_(eventos) {
  var hoja = obtenerHoja_();
  var filas = eventos.map(function (e) {
    return [
      e.id, e.fuente, e.t.toISOString(), e.mag, e.lat, e.lon, e.prof,
      e.lugar, new Date().toISOString()
    ];
  });
  hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);
}

function obtenerHoja_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('spreadsheet_id');
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Archivo Sísmico — SISMO·MONITOR');
    props.setProperty('spreadsheet_id', ss.getId());
    var h = ss.getActiveSheet();
    h.setName('eventos');
    h.appendRow(['id', 'fuente', 'fecha_hora_utc', 'magnitud', 'lat', 'lon',
                 'profundidad_km', 'lugar', 'registrado_en']);
    h.setFrozenRows(1);
  }
  return ss.getSheetByName('eventos') || ss.getActiveSheet();
}

/* ================= Telegram ================= */

/** Vista satelital del epicentro (Esri World Imagery, sin clave de API). */
function urlSatelite_(lat, lon) {
  var d = 0.55; // ~60 km de lado
  return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'
       + '?bbox=' + (lon - d) + ',' + (lat - d) + ',' + (lon + d) + ',' + (lat + d)
       + '&bboxSR=4326&size=900,700&format=png&f=image';
}

function escHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Texto del mensaje, con validación cruzada si existe. */
function textoEvento_(e, cruce) {
  var emoji = e.mag >= 6 ? '🔴' : e.mag >= 5 ? '🟠' : e.mag >= 4 ? '🟡' : '🟢';
  var hora = Utilities.formatDate(e.t, 'America/Caracas', 'dd/MM/yyyy HH:mm');

  var txt = emoji + ' <b>SISMO M ' + e.mag.toFixed(1) + '</b>\n'
          + '📍 ' + escHtml_(e.lugar) + '\n'
          + '🕐 ' + hora + ' (hora de Venezuela)\n'
          + '⬇ Profundidad: ' + e.prof.toFixed(0) + ' km\n';

  // avisos de tsunami e impacto: si el cruce (USGS) los trae, no se pierden
  var tsunami = e.tsunami || (cruce && cruce.tsunami);
  var pager   = e.pager   || (cruce && cruce.pager);
  var felt    = e.felt    || (cruce && cruce.felt);

  if (tsunami) {
    txt += '\n🌊 <b>INFORMACIÓN DE TSUNAMI</b>\n'
         + 'Este sismo ocurrió en una zona donde puede aplicar un aviso de tsunami.\n'
         + '👉 Boletín oficial: https://www.tsunami.gov\n'
         + '<i>Si estás en la costa y el sismo fue fuerte o largo, no esperes avisos: aléjate hacia zonas altas y sigue a Protección Civil.</i>\n';
  }
  if (pager) {
    var nivel = {
      green:  '🟢 Sin impacto significativo esperado',
      yellow: '🟡 Posible impacto local',
      orange: '🟠 Posible impacto regional',
      red:    '🔴 Posible impacto extenso'
    }[pager];
    if (nivel) txt += '📉 Impacto estimado (PAGER): ' + nivel + '\n';
  }
  if (felt) {
    txt += '🙋 ' + felt + ' persona(s) reportaron sentirlo\n';
  }

  // validación cruzada entre redes sismológicas
  if (cruce) {
    txt += '✅ <b>Confirmado por dos redes:</b> '
         + escHtml_(e.fuente) + ' M ' + e.mag.toFixed(1) + ' · '
         + escHtml_(cruce.fuente) + ' M ' + cruce.mag.toFixed(1) + '\n';
    var dif = Math.abs(cruce.mag - e.mag);
    if (dif >= 0.5) {
      txt += '   <i>(diferencia de ' + dif.toFixed(1) + ' entre redes: las magnitudes se recalculan en las horas siguientes)</i>\n';
    }
  } else {
    txt += 'ℹ️ Reporte preliminar de ' + escHtml_(e.fuente) + ' (aún sin confirmación de otra red)\n';
  }

  txt += '\n🌍 Verlo en SISMO·MONITOR:\n' + CONFIG.WEB_URL + '#evento=' + encodeURIComponent(e.id);
  return txt;
}

/** Publica el evento en el canal: imagen satelital + datos + pin de mapa. */
function publicarEnCanal_(e, cruce) {
  var destino = CONFIG.TELEGRAM_CANAL;
  if (!destino || destino.indexOf('PEGA_AQUI') === 0) return;

  var texto = textoEvento_(e, cruce);
  var enviado = false;

  // 1) intento con foto satelital + pie de foto
  if (CONFIG.CANAL_CON_IMAGEN) {
    var r = apiTelegram_('sendPhoto', {
      chat_id: destino,
      photo: urlSatelite_(e.lat, e.lon),
      caption: texto,
      parse_mode: 'HTML'
    });
    enviado = r && r.ok;
    if (!enviado) Logger.log('sendPhoto falló, se envía solo texto: ' + JSON.stringify(r));
  }

  // 2) respaldo: mensaje de texto (si la imagen no se pudo adjuntar)
  if (!enviado) {
    var rMsg = apiTelegram_('sendMessage', {
      chat_id: destino, text: texto,
      parse_mode: 'HTML', disable_web_page_preview: false
    });
    enviado = rMsg && rMsg.ok;
  }

  // 3) pin de mapa interactivo: el suscriptor mide su distancia real al epicentro
  if (enviado && CONFIG.CANAL_CON_MAPA) {
    apiTelegram_('sendLocation', {
      chat_id: destino, latitude: e.lat, longitude: e.lon
    });
  }
}

/** Alerta privada (chat personal), con distancia a tu ubicación. */
function enviarTelegram_(e, destino) {
  destino = destino || CONFIG.TELEGRAM_CHAT_ID;
  if (!destino) return;
  var dist = CONFIG.ALERTA_RADIO_KM
    ? '\n📏 A ' + Math.round(distanciaKm_(CONFIG.ALERTA_LAT, CONFIG.ALERTA_LON, e.lat, e.lon)) + ' km de tu ubicación'
    : '';
  var texto = textoEvento_(e, null).replace('\n\n🌍', dist + '\n\n🌍');
  apiTelegram_('sendMessage', {
    chat_id: destino, text: texto,
    parse_mode: 'HTML', disable_web_page_preview: true
  });
}

/** Llamada a la API de Telegram con registro del resultado. */
function apiTelegram_(metodo, cuerpo) {
  if (CONFIG.TELEGRAM_TOKEN.indexOf('PEGA_AQUI') === 0) return null;
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/' + metodo, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(cuerpo), muteHttpExceptions: true
      });
    var out = JSON.parse(resp.getContentText());
    if (!out.ok) Logger.log('Telegram ' + metodo + ' → ' + resp.getContentText());
    return out;
  } catch (err) {
    Logger.log('Telegram ' + metodo + ' falló: ' + err);
    return null;
  }
}

/* ================= API del archivo histórico ================= */
/**
 * Sirve el catálogo histórico de la hoja de cálculo como JSON.
 * Se invoca desde el doGet de funvisis-proxy.gs con ?archivo=1
 *
 * Parámetros aceptados:
 *   ?archivo=1&dias=30        ventana en días (máximo 90, por defecto 30)
 *   &minmag=2.5               magnitud mínima (opcional)
 *   &fuente=FUNVISIS          filtrar por una fuente (opcional)
 *   &id=<id>                  buscar un evento concreto (para enlaces compartidos)
 *
 * Respuesta compacta (filas como arrays, para reducir el peso):
 *   { source:'archivo', desde:<ISO>, count:n,
 *     cols:['id','fuente','t','mag','lat','lon','prof','lugar'],
 *     rows:[[...], ...] }
 */
function servirArchivo(params) {
  // Envoltorio a prueba de fallos: si algo lanza una excepción, Apps Script
  // devolvería una página HTML de error y el navegador lo reportaría como
  // un problema de CORS. Devolviendo siempre JSON, el fallo es diagnosticable.
  try {
    return servirArchivoInterno_(params);
  } catch (err) {
    return jsonSalida_(JSON.stringify({
      source: 'archivo', error: String(err), count: 0, rows: []
    }));
  }
}

function servirArchivoInterno_(params) {
  var dias   = Math.min(parseInt(params.dias || '30', 10) || 30, 90);
  var minMag = parseFloat(params.minmag || '0') || 0;
  var fuente = (params.fuente || '').toUpperCase();
  var buscarId = params.id || '';

  var clave = 'arch|' + dias + '|' + minMag + '|' + fuente + '|' + buscarId;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(clave);
  if (hit) return jsonSalida_(hit);

  var desde = Date.now() - dias * 86400000;
  var rows = [];

  try {
    var hoja = obtenerHoja_();
    var datos = hoja.getDataRange().getValues();
    // columnas: id, fuente, fecha_hora_utc, magnitud, lat, lon, prof, lugar, registrado_en
    for (var i = 1; i < datos.length; i++) {
      var f = datos[i];
      if (!f[0]) continue;

      if (buscarId) {
        if (String(f[0]) !== buscarId) continue;
      } else {
        var t = new Date(f[2]).getTime();
        if (!t || t < desde) continue;
        if (minMag && Number(f[3]) < minMag) continue;
        if (fuente && String(f[1]).toUpperCase() !== fuente) continue;
      }

      rows.push([
        String(f[0]),                 // id
        String(f[1]),                 // fuente
        new Date(f[2]).getTime(),     // t (epoch ms)
        Number(f[3]),                 // magnitud
        Number(f[4]),                 // lat
        Number(f[5]),                 // lon
        Number(f[6]) || 0,            // profundidad
        String(f[7] || '—')           // lugar
      ]);
      if (rows.length >= 12000) break; // tope de seguridad
    }
  } catch (err) {
    return jsonSalida_(JSON.stringify({
      source: 'archivo', error: String(err), count: 0, rows: []
    }));
  }

  rows.sort(function (a, b) { return b[2] - a[2]; }); // más reciente primero

  var salida = JSON.stringify({
    source: 'archivo',
    desde: new Date(desde).toISOString(),
    count: rows.length,
    cols: ['id', 'fuente', 't', 'mag', 'lat', 'lon', 'prof', 'lugar'],
    rows: rows
  });

  // CacheService admite ~100 KB por clave: cachear solo si cabe
  if (salida.length < 90000) {
    try { cache.put(clave, salida, 300); } catch (e) {}
  }
  return jsonSalida_(salida);
}

function jsonSalida_(texto) {
  return ContentService.createTextOutput(texto)
                       .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Prueba manual del endpoint del archivo (ejecutar desde el editor).
 */
function probarArchivo() {
  var r = JSON.parse(servirArchivo({ dias: '30' }).getContent());
  if (r.error) { Logger.log('❌ ERROR: ' + r.error); return; }
  Logger.log('Eventos en los últimos 30 días: ' + r.count);
  if (r.rows.length) Logger.log('Más reciente: ' + JSON.stringify(r.rows[0]));
  var fv = JSON.parse(servirArchivo({ dias: '30', fuente: 'FUNVISIS' }).getContent());
  Logger.log('De ellos, FUNVISIS: ' + fv.count);

  // salud del sistema: filas totales y estado del activador
  try {
    var hoja = obtenerHoja_();
    Logger.log('Filas totales en la hoja: ' + (hoja.getLastRow() - 1));
  } catch (e) { Logger.log('No se pudo leer la hoja: ' + e); }
  var trg = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'vigilarSismos';
  });
  Logger.log(trg.length ? '✓ Activador instalado (vigilancia activa)'
                        : '❌ SIN ACTIVADOR: ejecuta instalarTrigger');
}


/* ================= vigilancia de salud del sistema =================
 *  Detecta fallos silenciosos: una fuente que deja de responder, o que
 *  responde pero no publica eventos nuevos (formato cambiado, servicio
 *  degradado). Sin esto, un fallo se descubre por casualidad — y con
 *  suscriptores en el canal, el silencio se confunde con "no hay sismos".
 * ================================================================= */

function saludProps_() { return PropertiesService.getScriptProperties(); }

function saludLeer_() {
  try { return JSON.parse(saludProps_().getProperty('salud') || '{}'); }
  catch (e) { return {}; }
}
function saludGuardar_(o) {
  try { saludProps_().setProperty('salud', JSON.stringify(o)); } catch (e) {}
}

/** Anota si una fuente respondió bien o falló en este ciclo. */
function saludRegistrar_(fuente, ok, detalle) {
  var h = saludLeer_();
  h[fuente] = h[fuente] || {};
  if (ok) {
    h[fuente].fallos = 0;
    h[fuente].okEn = Date.now();
  } else {
    h[fuente].fallos = (h[fuente].fallos || 0) + 1;
    h[fuente].error = detalle || '';
  }
  saludGuardar_(h);
}

/** Guarda la hora del evento más reciente visto por cada red. */
function saludUltimoEvento_(eventos) {
  var h = saludLeer_();
  ['FUNVISIS', 'USGS', 'EMSC'].forEach(function (f) {
    var t = 0;
    eventos.forEach(function (e) {
      if (e.fuente === f && e.t.getTime() > t) t = e.t.getTime();
    });
    if (t) {
      var k = f.toLowerCase();
      h[k] = h[k] || {};
      h[k].ultimoEvento = t;
    }
  });
  saludGuardar_(h);
}

/** ¿Ya avisamos de esto hace poco? Evita repetir el mismo aviso cada 5 minutos. */
function saludYaAvisado_(clave) {
  var h = saludLeer_();
  var ult = (h.avisos || {})[clave] || 0;
  if (Date.now() - ult < CONFIG.SALUD_REPETIR_HORAS * 3600000) return true;
  h.avisos = h.avisos || {};
  h.avisos[clave] = Date.now();
  saludGuardar_(h);
  return false;
}

function revisarSalud_() {
  var h = saludLeer_();
  var problemas = [];
  var ahora = Date.now();

  [['funvisis', 'FUNVISIS', CONFIG.SALUD_HORAS_FUNVISIS],
   ['usgs', 'USGS', CONFIG.SALUD_HORAS_USGS],
   ['emsc', 'EMSC', CONFIG.SALUD_HORAS_USGS]].forEach(function (par) {
    var k = par[0], nombre = par[1], horas = par[2];
    var d = h[k] || {};

    // 1) la fuente no responde
    if ((d.fallos || 0) >= CONFIG.SALUD_FALLOS_SEGUIDOS &&
        !saludYaAvisado_('conexion_' + k)) {
      problemas.push('🔌 *' + nombre + ' no responde*\n' +
        d.fallos + ' intentos fallidos seguidos.\n' +
        (d.error ? '`' + String(d.error).substring(0, 120) + '`' : ''));
    }

    // 2) responde pero lleva demasiado tiempo sin publicar nada nuevo
    //    (síntoma típico de un cambio de formato que rompe el parseo)
    if (d.ultimoEvento && (d.fallos || 0) === 0) {
      var horasSin = (ahora - d.ultimoEvento) / 3600000;
      if (horasSin >= horas && !saludYaAvisado_('silencio_' + k)) {
        problemas.push('🔇 *' + nombre + ' lleva ' + Math.round(horasSin) + ' h sin eventos nuevos*\n' +
          'La fuente responde, pero no llegan datos. Puede ser calma real o un cambio de formato.\n' +
          'Comprueba: ' + (k === 'funvisis'
            ? 'http://www.funvisis.gob.ve'
            : 'https://earthquake.usgs.gov'));
      }
    }
  });

  // 3) el archivo dejó de crecer
  try {
    var hoja = obtenerHoja_();
    var filas = hoja.getLastRow() - 1;
    if (h.filasPrev && filas === h.filasPrev.n &&
        ahora - h.filasPrev.t > 6 * 3600000 &&
        !saludYaAvisado_('archivo')) {
      problemas.push('🗄 *El archivo no crece*\n' +
        'Sigue en ' + filas + ' filas desde hace más de 6 horas.');
    }
    if (!h.filasPrev || filas !== h.filasPrev.n) {
      h.filasPrev = { n: filas, t: ahora };
      saludGuardar_(h);
    }
  } catch (e) {
    Logger.log('Salud: no se pudo leer la hoja: ' + e);
  }

  if (problemas.length) avisarSalud_('⚠️ *SISMO·MONITOR — aviso del sistema*\n\n' + problemas.join('\n\n'));
}

/** Los avisos técnicos van a tu chat privado, nunca al canal público. */
function avisarSalud_(texto) {
  Logger.log(texto.replace(/\*/g, ''));
  if (!CONFIG.TELEGRAM_CHAT_ID) return;   // sin chat privado, solo queda en el registro
  apiTelegram_('sendMessage', {
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: texto, parse_mode: 'Markdown', disable_web_page_preview: true
  });
}

/** Informe de estado los lunes por la mañana (hora de Venezuela). */
function resumenSemanal_() {
  var ahora = new Date();
  var loc = Utilities.formatDate(ahora, 'America/Caracas', 'u/HH');  // díaSemana/hora
  if (loc.indexOf('1/08') !== 0) return;                            // lunes, 8 a 9 h
  if (saludYaAvisado_('resumen')) return;

  var h = saludLeer_();
  var lineas = ['📊 *SISMO·MONITOR — estado semanal*', ''];

  try {
    var hoja = obtenerHoja_();
    lineas.push('🗄 Archivo: *' + (hoja.getLastRow() - 1) + '* eventos guardados');
    var r = JSON.parse(servirArchivo({ dias: '7' }).getContent());
    var fv = JSON.parse(servirArchivo({ dias: '7', fuente: 'FUNVISIS' }).getContent());
    lineas.push('📅 Últimos 7 días: *' + r.count + '* eventos (' + fv.count + ' de FUNVISIS)');
  } catch (e) {
    lineas.push('🗄 No se pudo leer el archivo: ' + e);
  }

  ['funvisis', 'usgs', 'emsc'].forEach(function (k) {
    var d = h[k] || {};
    var estado = (d.fallos || 0) > 0 ? '❌ con fallos'
               : d.ultimoEvento ? '✅ activa' : '⚠️ sin datos';
    var desde = d.ultimoEvento
      ? ' · último evento hace ' + Math.round((Date.now() - d.ultimoEvento) / 3600000) + ' h'
      : '';
    lineas.push('📡 ' + k.toUpperCase() + ': ' + estado + desde);
  });

  var trg = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'vigilarSismos';
  });
  lineas.push('⏱ Vigilancia: ' + (trg.length ? '✅ activa cada 5 min' : '❌ SIN ACTIVADOR'));

  avisarSalud_(lineas.join('\n'));
}

/** Comprobación manual del estado (ejecutar desde el editor). */
function probarSalud_() { probarSalud(); }
function probarSalud() {
  var h = saludLeer_();
  Logger.log('Estado guardado: ' + JSON.stringify(h, null, 2));
  ['funvisis', 'usgs', 'emsc'].forEach(function (k) {
    var d = h[k] || {};
    Logger.log(k.toUpperCase() + ' → fallos seguidos: ' + (d.fallos || 0) +
      ' · último evento: ' + (d.ultimoEvento
        ? Math.round((Date.now() - d.ultimoEvento) / 3600000) + ' h atrás'
        : 'nunca'));
  });
  if (!CONFIG.TELEGRAM_CHAT_ID) {
    Logger.log('⚠️ TELEGRAM_CHAT_ID vacío: los avisos de salud solo se escriben aquí, no llegan a Telegram.');
  } else {
    avisarSalud_('🔧 *Prueba del vigilante de salud*\nSi lees esto, los avisos técnicos funcionan.');
    Logger.log('Aviso de prueba enviado a tu chat privado.');
  }
}

/* ================= configuración y pruebas ================= */

function configurarArchivo() {
  var hoja = obtenerHoja_();
  var url = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('spreadsheet_id')
  ).getUrl();
  Logger.log('✓ Archivo listo. Tu catálogo histórico está en:\n' + url);
}

var EVENTO_PRUEBA = {
  id: 'prueba', mag: 4.3, lugar: '12 km al norte de La Guaira, Venezuela',
  t: new Date(), prof: 8.5, fuente: 'FUNVISIS', lat: 10.71, lon: -66.93
};
var CRUCE_PRUEBA = { fuente: 'USGS', mag: 4.5, t: new Date(), lat: 10.72, lon: -66.95,
                     tsunami: true, pager: 'yellow', felt: 143 };

/** Publica un evento de prueba EN EL CANAL (revisa el registro si falla). */
function probarCanal() {
  publicarEnCanal_(EVENTO_PRUEBA, CRUCE_PRUEBA);
  Logger.log('Publicación de prueba enviada al canal ' + CONFIG.TELEGRAM_CANAL +
             '. Si no aparece, revisa arriba la respuesta de Telegram.');
}

/** Envía una alerta de prueba al chat PRIVADO (si lo configuraste). */
function probarTelegram() {
  if (!CONFIG.TELEGRAM_CHAT_ID) {
    Logger.log('TELEGRAM_CHAT_ID está vacío: solo se publica en el canal. Usa probarCanal.');
    return;
  }
  enviarTelegram_(EVENTO_PRUEBA);
  Logger.log('Mensaje privado de prueba enviado. Revisa tu Telegram.');
}

function instalarTrigger() {
  desinstalarTrigger();
  ScriptApp.newTrigger('vigilarSismos').timeBased().everyMinutes(5).create();
  Logger.log('✓ Vigilancia activa: vigilarSismos se ejecutará cada 5 minutos, 24/7.');
}

function desinstalarTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'vigilarSismos') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Vigilancia detenida.');
}
