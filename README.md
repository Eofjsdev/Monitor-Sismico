# 🌍 SISMO·MONITOR

**Panel de monitoreo sísmico mundial en tiempo real** — globo 3D interactivo alimentado por USGS, FUNVISIS (Venezuela) y EMSC, con alertas configurables, modo bilingüe e instalable como app.

**▶ Demo en vivo: https://ehyenmanft.github.io/monitor-sismico/**
**📣 Canal de avisos en Telegram: https://t.me/michihub_oficial**

> Este proyecto nació de la experiencia del terremoto de La Guaira de 2026. Es la herramienta que su autor hubiera querido tener ese día: gratuita, en español, y con los datos sísmicos venezolanos que ninguna app internacional muestra.

---

## ✨ Características

- **Globo 3D interactivo** (Three.js): rotación con mouse, teclado o táctil, zoom con rueda o pellizco, costas reales (Natural Earth) y límites de placas tectónicas (modelo PB2002).
- **Tres fuentes de datos fusionadas** con deduplicación y prioridad (FUNVISIS → USGS → EMSC), actualización automática cada 60 segundos.
- **Marcadores informativos**: color por magnitud, anillos pulsantes para M ≥ 4.5, anillo de profundidad (gris = 70–300 km, azul = > 300 km).
- **Ficha por evento**: magnitud, ubicación, fecha/hora local, coordenadas, profundidad, fuente y enlace al catálogo original.
- **Alertas configurables**: magnitud mínima, radio desde tu ubicación, sirena y notificación del navegador. Con advertencia explícita: los sismos **no se pueden predecir**; esto avisa de eventos ya registrados.
- **Compartir**: enlace profundo por evento (`#evento=id`) y tarjeta PNG generada al vuelo con mini-mapa regional — pensada para WhatsApp.
- **PWA instalable**: funciona como app en Android/iOS, carga instantánea, cascarón disponible sin conexión (los datos siempre vienen frescos de la red, nunca de caché).
- **Bilingüe** español/inglés con un clic. **Modo kiosko** para pantallas de monitoreo.
- **Avisos de tsunami y nivel PAGER** de impacto estimado (USGS), más número de reportes ciudadanos.
- **Tres vistas**: globo 3D, mapa plano con ciudades y fronteras, e imagen satelital.
- **Vista satelital** con seguimiento GPS en tiempo real y capa diaria de la NASA, sin claves de API.
- **Análisis histórico** con gráficas de magnitud y frecuencia hasta 60 días o desde una fecha fija, filtrable por región.
- **Exportación de reportes** del período y región seleccionados en CSV, TXT y GeoJSON.
- **Replay animado**: reproduce la secuencia de sismos sobre el globo, con control de velocidad y búsqueda.
- **Modo trazo**: conecta sismos manualmente para medir alineaciones, con guardado y enlaces compartibles.
- **Canal de Telegram** con validación cruzada entre redes, imagen del epicentro y pin de mapa.
- **Responsive**: interfaz de hojas deslizables y navegación inferior en móvil.

## 🔌 Fuentes de datos

| Fuente | Cobertura | Acceso |
|---|---|---|
| [USGS](https://earthquake.usgs.gov) | Mundial | Feed GeoJSON público |
| [FUNVISIS](http://www.funvisis.gob.ve) | Venezuela | Sin API pública — vía proxy propio (ver abajo) |
| [EMSC](https://www.seismicportal.eu) | Mundial / Caribe / Europa | Servicio FDSN público |

### El problema FUNVISIS

La agencia sismológica venezolana no ofrece API pública: sus datos se sirven en un JSON interno sin CORS, con nombres de campo heredados de una plantilla de mapa (la magnitud viaja en `phone`, la fecha en `postalCode`) y formato que cambia sin aviso. Este proyecto lo resuelve con:

- **`funvisis-proxy.gs`** — Google Apps Script que lee la fuente oficial, la cachea 5 minutos, la normaliza con *validación por contenido* (no confía en nombres de campo) y la sirve como JSON público con respaldo automático en un espejo comunitario.

Ese enfoque es reutilizable para cualquier país cuya agencia sísmica carezca de datos abiertos.

## 🏗 Arquitectura

```
Navegador (index.html — archivo único, sin build)
 ├── USGS  ──────────────── directo (GeoJSON público)
 ├── EMSC  ──────────────── directo (FDSN público)
 └── FUNVISIS ── proxy Apps Script ── funvisis.gob.ve
                     │
        (mismo proyecto de Apps Script)
                     │
 vigilarSismos (trigger cada 5 min) ──► Hoja de cálculo (archivo histórico)
                                    ├─► Canal de Telegram (avisos 24/7)
                                    └─► API del archivo (?archivo=1) ──► web
```

Todo corre en infraestructura gratuita: GitHub Pages + Google Apps Script. Sin servidores, sin claves de API, sin costos.

## 🚀 Despliegue propio

1. Haz fork o descarga este repositorio.
2. *(Opcional, para datos FUNVISIS)* Crea un proyecto en [script.google.com](https://script.google.com), pega `funvisis-proxy.gs`, implementa como aplicación web ("Ejecutar como: yo" / "Acceso: cualquier usuario") y pega la URL `/exec` en la constante `FUNVISIS_PROXY` de `index.html`.
3. Activa GitHub Pages: Settings → Pages → Deploy from branch → `main`.
4. *(Opcional)* Agrega `sismo-archivo-telegram.gs` al mismo proyecto de Apps Script para archivo histórico y alertas por Telegram — instrucciones en los comentarios del archivo.

Al actualizar `index.html`, incrementa `VERSION` en `sw.js` para que las instalaciones PWA se renueven.

## 🗺 Hoja de ruta

- [x] Lectura del archivo histórico desde la web (rangos de 7/30 días)
- [x] Replay animado de enjambres sísmicos
- [ ] Rendimiento en equipos modestos (geometría instanciada)
- [x] Integración de avisos de tsunami y nivel PAGER (USGS)
- [ ] Notificaciones push con la app cerrada
- [ ] Mejoras de accesibilidad

## ⚠️ Aviso importante

Esta herramienta es **informativa**. Los datos llegan con minutos de retraso respecto al evento y ninguna tecnología puede predecir terremotos. Ante una emergencia sísmica, sigue siempre las indicaciones de los organismos oficiales de protección civil.

## 📄 Licencia

MIT — libre para usar, modificar y redistribuir.

---

## 🇬🇧 English summary

**SISMO·MONITOR** is a real-time seismic monitoring dashboard: an interactive 3D globe merging USGS, EMSC and FUNVISIS (Venezuela) data, with configurable alerts, deep links, shareable PNG event cards, tectonic plate context, and installable PWA support — bilingual ES/EN.

Born from the 2026 La Guaira earthquake, it solves a real gap: Venezuela's seismological agency has no public API, so this project includes an open Google Apps Script proxy that normalizes its unstable, undocumented data feed using content-based validation — an approach reusable for any country with closed seismic data. The full stack (GitHub Pages + Apps Script + optional Telegram bot for 24/7 alerts and a Google Sheets historical archive) runs entirely on free infrastructure.

Live demo: **https://ehyenmanft.github.io/monitor-sismico/** · Telegram channel: **https://t.me/michihub_oficial** · License: MIT
