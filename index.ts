// ============================================================
//  EDGE FUNCTION SUPABASE: vigilar-sismos
// ============================================================
//  Ingesta 24/7 de USGS + EMSC, archivo en PostgreSQL
//  y alertas inteligentes con deduplicación en Telegram.
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

interface SismoItem {
  id: string;
  fuente: string;
  fecha_hora_utc: string;
  t_epoch: number;
  magnitud: number;
  lat: number;
  lon: number;
  profundidad_km: number;
  lugar: string;
  pais: string;
  tsunami?: boolean;
  pager?: string | null;
  felt?: number | null;
  url?: string;
}

// Configuración y criterios de alerta
const CONFIG = {
  CANAL_MAG_MIN: Number(Deno.env.get("CANAL_MAG_MIN") || "5.5"),   // magnitud mínima para publicar en el canal
  CANAL_CON_IMAGEN: true,
  CANAL_CON_MAPA: true,
  WEB_URL: Deno.env.get("WEB_URL") || "",
};

function paisDeLugar(txt: string): string {
  const partes = (txt || "").split(",");
  return partes.length > 1 ? partes[partes.length - 1].trim() : ((txt || "").trim() || "—");
}

function esParaCanal(e: SismoItem): boolean {
  return e.magnitud >= CONFIG.CANAL_MAG_MIN;
}

function cruzarFuentes(e: SismoItem, todos: SismoItem[]): SismoItem | null {
  for (const o of todos) {
    if (o.fuente === e.fuente) continue;
    if (
      Math.abs(o.t_epoch - e.t_epoch) < 15 * 60 * 1000 &&
      Math.abs(o.lat - e.lat) < 0.6 &&
      Math.abs(o.lon - e.lon) < 0.6
    ) {
      return o;
    }
  }
  return null;
}

// Fetch USGS
async function fetchUSGS(): Promise<SismoItem[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];
    const data = await res.json();

    return (data.features || [])
      .filter((f: any) => f.properties.mag != null && f.geometry?.coordinates?.length >= 2)
      .map((f: any) => ({
        id: f.id,
        fuente: "USGS",
        fecha_hora_utc: new Date(f.properties.time).toISOString(),
        t_epoch: f.properties.time,
        magnitud: parseFloat(f.properties.mag),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        profundidad_km: parseFloat(f.geometry.coordinates[2] || "0") || 0,
        lugar: f.properties.place || "—",
        pais: paisDeLugar(f.properties.place),
        tsunami: f.properties.tsunami === 1,
        pager: f.properties.alert || null,
        felt: f.properties.felt || null,
        url: f.properties.url || "",
      }));
  } catch (_e) {
    return [];
  }
}

// Fetch EMSC
async function fetchEMSC(): Promise<SismoItem[]> {
  try {
    const desdeIso = new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 19);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=100&starttime=${desdeIso}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];
    const data = await res.json();

    return (data.features || [])
      .filter((f: any) => f.properties?.mag != null && isFinite(f.properties?.lat) && isFinite(f.properties?.lon))
      .map((f: any) => {
        const p = f.properties;
        const d = new Date(p.time);
        return {
          id: `em-${p.unid || p.source_id}`,
          fuente: "EMSC",
          fecha_hora_utc: d.toISOString(),
          t_epoch: d.getTime(),
          magnitud: parseFloat(p.mag),
          lat: parseFloat(p.lat),
          lon: parseFloat(p.lon),
          profundidad_km: parseFloat(p.depth || "0") || 0,
          lugar: p.flynn_region || "—",
          pais: paisDeLugar(p.flynn_region),
          url: `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid || ""}`,
        };
      });
  } catch (_e) {
    return [];
  }
}

// Telegram Helpers
function urlSatelite(lat: number, lon: number): string {
  const d = 0.55;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lon - d},${lat - d},${lon + d},${lat + d}&bboxSR=4326&size=900,700&format=png&f=image`;
}

function escHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textoTelegram(e: SismoItem, cruce: SismoItem | null): string {
  const emoji = e.magnitud >= 6 ? "🔴" : e.magnitud >= 5 ? "🟠" : e.magnitud >= 4 ? "🟡" : "🟢";
  const fechaObj = new Date(e.t_epoch);
  const horaUTC = fechaObj.toLocaleString("es-MX", {
    timeZone: "UTC",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  });

  let txt = `${emoji} <b>SISMO M ${e.magnitud.toFixed(1)}</b>\n`
          + `📍 ${escHtml(e.lugar)}\n`
          + `🕐 ${horaUTC} UTC\n`
          + `⬇ Profundidad: ${e.profundidad_km.toFixed(0)} km\n`;

  const tsunami = e.tsunami || (cruce && cruce.tsunami);
  const pager = e.pager || (cruce && cruce.pager);
  const felt = e.felt || (cruce && cruce.felt);

  if (tsunami) {
    txt += `\n🌊 <b>INFORMACIÓN DE TSUNAMI</b>\n`
         + `Este sismo ocurrió en una zona donde puede aplicar un aviso de tsunami.\n`
         + `👉 Boletín oficial: https://www.tsunami.gov\n`;
  }
  if (pager) {
    const nivel: Record<string, string> = {
      green: "🟢 Sin impacto significativo esperado",
      yellow: "🟡 Posible impacto local",
      orange: "🟠 Posible impacto regional",
      red: "🔴 Posible impacto extenso",
    };
    if (nivel[pager]) txt += `📉 Impacto estimado (PAGER): ${nivel[pager]}\n`;
  }
  if (felt) {
    txt += `🙋 ${felt} persona(s) reportaron sentirlo\n`;
  }

  if (cruce) {
    txt += `✅ <b>Confirmado por dos redes:</b> ${escHtml(e.fuente)} M ${e.magnitud.toFixed(1)} · ${escHtml(cruce.fuente)} M ${cruce.magnitud.toFixed(1)}\n`;
  } else {
    txt += `ℹ️ Reporte preliminar de ${escHtml(e.fuente)} (aún sin confirmación de otra red)\n`;
  }

  if (CONFIG.WEB_URL) txt += `\n🌍 Verlo en SISMO·MONITOR:\n${CONFIG.WEB_URL}#evento=${encodeURIComponent(e.id)}`;
  return txt;
}

async function enviarTelegram(token: string, canal: string, e: SismoItem, cruce: SismoItem | null): Promise<boolean> {
  if (!token || !canal) return false;
  const texto = textoTelegram(e, cruce);

  // 1) Enviar Foto Satelital con HTML parse_mode
  let enviado = false;
  if (CONFIG.CANAL_CON_IMAGEN) {
    try {
      const resFoto = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: canal,
          photo: urlSatelite(e.lat, e.lon),
          caption: texto,
          parse_mode: "HTML",
        }),
      });
      const dataFoto = await resFoto.json();
      enviado = dataFoto.ok === true;
      if (!enviado) {
        console.warn("sendPhoto falló en Telegram:", dataFoto);
      }
    } catch (err) {
      console.error("Error en sendPhoto:", err);
    }
  }

  // 2) Fallback Texto con HTML parse_mode
  if (!enviado) {
    try {
      const resMsg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: canal,
          text: texto,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
      });
      const dataMsg = await resMsg.json();
      enviado = dataMsg.ok === true;
      if (!enviado) {
        console.error("sendMessage falló en Telegram:", dataMsg);
      }
    } catch (err) {
      console.error("Error en sendMessage:", err);
    }
  }

  // 3) Pin de Ubicación (solo si el mensaje se envió exitosamente)
  if (enviado && CONFIG.CANAL_CON_MAPA) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendLocation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: canal,
          latitude: e.lat,
          longitude: e.lon,
        }),
      });
    } catch (_e) {}
  }

  return enviado;
}

// Manejador Principal
serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://xeongtzcemodcpfdzqws.supabase.co";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const supabaseKey = serviceKey || anonKey!;
  console.log(`[Vigilar-Sismos] Autenticación Supabase usando: ${serviceKey ? "SERVICE_ROLE_KEY" : "ANON_KEY"}`);

  const telegramToken = Deno.env.get("TELEGRAM_TOKEN") || "";
  const telegramCanal = Deno.env.get("TELEGRAM_CANAL") || "@michihub_oficial";

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Ingesta de fuentes en paralelo
  const [usgs, emsc] = await Promise.all([
    fetchUSGS(),
    fetchEMSC(),
  ]);

  const todosEventos = [...usgs, ...emsc];

  if (!todosEventos.length) {
    return new Response(JSON.stringify({ status: "sin_datos", count: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Guardar/actualizar en PostgreSQL
  const registrosParaDB = todosEventos.map((e) => ({
    id: e.id,
    fuente: e.fuente,
    fecha_hora_utc: e.fecha_hora_utc,
    magnitud: e.magnitud,
    lat: e.lat,
    lon: e.lon,
    profundidad_km: e.profundidad_km,
    lugar: e.lugar,
    pais: e.pais,
    tsunami: e.tsunami || false,
    pager: e.pager || null,
    felt: e.felt || null,
    url: e.url || null,
  }));

  const { error: errorUpsert } = await supabase
    .from("sismos")
    .upsert(registrosParaDB, { onConflict: "id", ignoreDuplicates: false });

  if (errorUpsert) {
    console.error("[Vigilar-Sismos] Error en upsert de sismos:", errorUpsert);
  }

  // Obtener alertas publicadas en las últimas 48 horas para deduplicar
  const hace48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const { data: yaPublicados, error: errSelect } = await supabase
    .from("telegram_publicados")
    .select("id, fecha_hora_utc, lat, lon, magnitud")
    .gte("fecha_hora_utc", hace48h);

  if (errSelect) {
    console.error("[Vigilar-Sismos] ERROR al consultar telegram_publicados:", errSelect);
  }

  const listaPub = yaPublicados || [];
  console.log(`[Vigilar-Sismos] Sismos previos en memoria de Telegram (48h): ${listaPub.length}`);

  function yaFuePublicado(e: SismoItem): boolean {
    const eEpoch = e.t_epoch;
    for (const p of listaPub) {
      if (p.id === e.id) return true;
      const pEpoch = new Date(p.fecha_hora_utc).getTime();
      if (
        Math.abs(pEpoch - eEpoch) <= 20 * 60 * 1000 &&
        Math.abs(p.lat - e.lat) <= 0.6 &&
        Math.abs(p.lon - e.lon) <= 0.6
      ) {
        return true;
      }
    }
    return false;
  }

  // Filtrar candidatos para Telegram (últimas 2.5 horas)
  const ahora = Date.now();
  const candidatosCanal = todosEventos
    .filter((e) => ahora - e.t_epoch <= 2.5 * 3600 * 1000)
    .filter(esParaCanal)
    .filter((e) => !yaFuePublicado(e))
    .sort((a, b) => b.magnitud - a.magnitud);

  let enviados = 0;
  const enviadosEnCiclo: SismoItem[] = [];

  for (const e of candidatosCanal) {
    // Evitar enviar duplicados dentro del mismo ciclo
    const duplicadoLocal = enviadosEnCiclo.some(
      (o) =>
        Math.abs(o.t_epoch - e.t_epoch) <= 20 * 60 * 1000 &&
        Math.abs(o.lat - e.lat) <= 0.6 &&
        Math.abs(o.lon - e.lon) <= 0.6
    );
    if (duplicadoLocal) continue;

    if (enviados < 3 && telegramToken && telegramCanal) {
      const cruce = cruzarFuentes(e, todosEventos);
      const exito = await enviarTelegram(telegramToken, telegramCanal, e, cruce);

      if (exito) {
        // Registrar alerta publicada en base de datos con upsert y reintento resiliente
        const { error: errInsert } = await supabase
          .from("telegram_publicados")
          .upsert({
            id: e.id,
            sismo_id: e.id,
            fecha_hora_utc: e.fecha_hora_utc,
            lat: e.lat,
            lon: e.lon,
            magnitud: e.magnitud,
          }, { onConflict: "id" });

        if (errInsert) {
          console.error("[Vigilar-Sismos] ERROR al guardar con sismo_id en telegram_publicados:", errInsert);
          // Reintentar sin referencia foránea por si sismos falló
          const { error: errRetry } = await supabase
            .from("telegram_publicados")
            .upsert({
              id: e.id,
              fecha_hora_utc: e.fecha_hora_utc,
              lat: e.lat,
              lon: e.lon,
              magnitud: e.magnitud,
            }, { onConflict: "id" });
          if (errRetry) {
            console.error("[Vigilar-Sismos] ERROR crítico reintentando telegram_publicados:", errRetry);
          } else {
            console.log(`[Vigilar-Sismos] Alerta guardada en DB (fallback sin sismo_id): ${e.id}`);
          }
        } else {
          console.log(`[Vigilar-Sismos] Alerta guardada exitosamente en DB: ${e.id}`);
        }

        listaPub.push({
          id: e.id,
          fecha_hora_utc: e.fecha_hora_utc,
          lat: e.lat,
          lon: e.lon,
          magnitud: e.magnitud,
        });

        enviadosEnCiclo.push(e);
        enviados++;
      }
    }
  }

  return new Response(
    JSON.stringify({
      status: "ok",
      total_ingestados: todosEventos.length,
      usgs: usgs.length,
      emsc: emsc.length,
      alertas_telegram_enviadas: enviados,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
