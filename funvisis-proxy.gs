/**
 * ============================================================
 *  PROXY FUNVISIS — Google Apps Script
 * ============================================================
 *  Lee directamente la fuente oficial de FUNVISIS
 *  (http://www.funvisis.gob.ve/maravilla.json) desde el servidor
 *  de Google, la cachea 5 minutos y la sirve como JSON con acceso
 *  público, para que tu dashboard pueda consumirla desde el
 *  navegador sin problemas de CORS ni contenido mixto HTTP/HTTPS.
 *
 *  INSTALACIÓN (5 minutos):
 *  1. Ve a https://script.google.com → Nuevo proyecto
 *  2. Borra el contenido de Code.gs y pega este archivo completo
 *  3. Implementar → Nueva implementación → tipo "Aplicación web"
 *       - Ejecutar como:            Yo
 *       - Quién tiene acceso:       Cualquier usuario
 *  4. Autoriza los permisos cuando lo pida
 *  5. Copia la URL que termina en /exec
 *  6. Pégala en monitor-sismico.html, en la constante FUNVISIS_PROXY
 *
 *  ENDPOINTS:
 *    GET {URL}/exec            → JSON normalizado (mismo formato
 *                                 que espera el dashboard)
 *    GET {URL}/exec?format=raw → JSON original de FUNVISIS sin tocar
 *    GET {URL}/exec?nocache=1  → fuerza lectura fresca (ignora caché)
 *
 *  Si FUNVISIS está caído, intenta automáticamente el espejo
 *  SismosVE y lo indica en el campo "via" de la respuesta.
 * ============================================================
 */

var FUENTE_OFICIAL = 'http://www.funvisis.gob.ve/maravilla.json';
var ESPEJO         = 'https://sismosve.rafnixg.dev/api/sismos';
var CACHE_KEY      = 'funvisis_data_v1';
var CACHE_SEGUNDOS = 300; // 5 min — misma frecuencia con la que FUNVISIS actualiza

function doGet(e) {
  var params  = (e && e.parameter) || {};

  // ── enrutamiento ──────────────────────────────────────────────
  // ?archivo=1  → sirve el catálogo histórico de la hoja de cálculo
  //               (función servirArchivo, en archivo-telegram.gs)
  // sin parámetro → sirve los datos actuales de FUNVISIS (abajo)
  if (params.archivo === '1') {
    return servirArchivo(params);
  }

  var raw     = params.format === 'raw';
  var nocache = params.nocache === '1';

  var payload = obtenerDatos(nocache);

  var body = raw ? payload.data : normalizar(payload);

  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Devuelve {data, via, fetchedAt}. Orden de intento:
 * caché → FUNVISIS oficial → espejo SismosVE.
 */
function obtenerDatos(nocache) {
  var cache = CacheService.getScriptCache();

  if (!nocache) {
    var hit = cache.get(CACHE_KEY);
    if (hit) {
      try { return JSON.parse(hit); } catch (err) { /* caché corrupta: seguir */ }
    }
  }

  var payload = intentarFetch_(FUENTE_OFICIAL, 'funvisis.gob.ve')
             || intentarFetch_(ESPEJO, 'sismosve (espejo)');

  if (!payload) {
    // Último recurso: servir caché aunque haya expirado no es posible con
    // CacheService, así que devolvemos un error explícito y vacío.
    return {
      data: { type: 'sismos', features: [] },
      via: 'error: sin conexión con FUNVISIS ni con el espejo',
      fetchedAt: new Date().toISOString()
    };
  }

  try {
    cache.put(CACHE_KEY, JSON.stringify(payload), CACHE_SEGUNDOS);
  } catch (err) { /* si excede el límite de caché, servimos sin cachear */ }

  return payload;
}

function intentarFetch_(url, etiqueta) {
  try {
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false, // el sitio oficial va por HTTP plano
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SismoMonitor/1.0)',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    if (resp.getResponseCode() !== 200) return null;

    var data = JSON.parse(resp.getContentText());
    if (!data || !data.features || !data.features.length) return null;

    return { data: data, via: etiqueta, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return null;
  }
}

/**
 * Normaliza al formato que consume el dashboard. FUNVISIS montó su
 * monitor sobre una plantilla de mapa y los datos viajan en campos
 * con nombres ajenos: magnitud en "phone", hora en "city", fecha en
 * "postalCode", profundidad en "state"/"phoneFormatted". Por eso
 * aquí no se confía en el nombre del campo: se valida el CONTENIDO.
 */
function esMagnitud_(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) && n > 0 && n < 10; }
function esProfundidad_(v) { var n = parseFloat(String(v)); return isFinite(n) && n >= 0 && n < 800; }
function esFecha_(v) { var s = String(v).trim(); return /^\d{2}-\d{2}-\d{4}/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s); }
function esHora_(v) { return /^\d{1,2}:\d{2}/.test(String(v).trim()); }
function esCoord_(v) { var n = parseFloat(v); return isFinite(n) && n >= -180 && n <= 180; }
function esLugar_(v) { return typeof v === 'string' && /[a-záéíóúñ]/i.test(v) && v.length > 3; }

function pickV_(obj, nombres, valida) {
  for (var i = 0; i < nombres.length; i++) {
    var objetivo = nombres[i].toLowerCase();
    for (var key in obj) {
      if (key.toLowerCase() !== objetivo) continue;
      var v = obj[key];
      if (v == null || v === '') continue;
      if (!valida || valida(v)) return v;
    }
  }
  return null;
}

function normalizar(payload) {
  var feats = (payload.data.features || []).map(function (f) {
    var p = f.properties || {};
    var g = (f.geometry && f.geometry.coordinates) || [null, null];

    var mag   = pickV_(p, ['value', 'mag', 'magnitude', 'magnitud', 'phone'], esMagnitud_);
    var depth = pickV_(p, ['depth', 'profundidad', 'prof', 'state', 'phoneFormatted'], esProfundidad_);
    var lugar = pickV_(p, ['addressFormatted', 'address', 'lugar', 'localizacion',
                           'localización', 'epicentro', 'referencia', 'place', 'macro'], esLugar_);
    var fecha = pickV_(p, ['date', 'fecha', 'fechaLocal', 'fecha_local', 'postalCode'], esFecha_);
    var hora  = pickV_(p, ['time', 'hora', 'horaLocal', 'hora_local', 'city'], esHora_);
    var lat   = pickV_(p, ['lat', 'latitude', 'latitud'], esCoord_);
    var lon   = pickV_(p, ['long', 'lon', 'lng', 'longitude', 'longitud'], esCoord_);

    // fecha combinada tipo "19-07-2026 09:04"
    if (fecha && String(fecha).indexOf(' ') > -1 && !hora) {
      var partes = String(fecha).trim().split(/\s+/);
      fecha = partes[0];
      if (esHora_(partes[1] || '')) hora = partes[1];
    }
    // fecha ISO tipo "2026-07-19T09:04:00" → DD-MM-YYYY + HH:MM
    if (fecha && /^\d{4}-\d{2}-\d{2}/.test(String(fecha))) {
      var iso = String(fecha);
      var d = iso.substr(0, 10).split('-');
      if (!hora && iso.length > 10) hora = iso.substr(11, 5);
      fecha = d[2] + '-' + d[1] + '-' + d[0];
    }

    // último recurso para coordenadas: geometry.coordinates = [lon, lat]
    if ((lat == null || lon == null) && g && g.length >= 2) {
      if (lon == null && esCoord_(g[0])) lon = g[0];
      if (lat == null && esCoord_(g[1])) lat = g[1];
    }

    return {
      type: 'Sismo',
      geometry: { type: 'Point', coordinates: [parseFloat(lon), parseFloat(lat)] },
      properties: {
        value: mag != null ? String(mag).replace(',', '.') : null,
        depth: depth != null ? String(depth) : null,
        addressFormatted: lugar != null ? String(lugar) : null,
        date: fecha != null ? String(fecha) : null,
        time: hora != null ? String(hora) : null,
        lat: lat != null ? String(lat) : null,
        long: lon != null ? String(lon) : null,
        country: pickV_(p, ['country', 'pais', 'país'], null) || 'Venezuela'
      }
    };
  }).filter(function (f) {
    // descartar entradas sin coordenadas o sin magnitud utilizable
    return !isNaN(f.geometry.coordinates[0]) &&
           !isNaN(f.geometry.coordinates[1]) &&
           f.properties.value !== null;
  });

  return {
    type: 'sismos',
    source: 'FUNVISIS',
    via: payload.via,
    fetchedAt: payload.fetchedAt,
    count: feats.length,
    features: feats
  };
}

/**
 * Ejecuta esta función manualmente desde el editor (▶ probarProxy)
 * para verificar la conexión antes de implementar.
 */
function probarProxy() {
  var r = obtenerDatos(true);
  Logger.log('Vía: ' + r.via);
  Logger.log('Eventos: ' + ((r.data.features || []).length));
  if (r.data.features && r.data.features.length) {
    Logger.log('Primer evento: ' + JSON.stringify(r.data.features[0]));
  }
}
