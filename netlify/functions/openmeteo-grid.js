// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points of current PM2.5 using Open-Meteo Air Quality API
// Query params: ?lat1=..&lon1=..&lat2=..&lon2=..&step=0.5
// Defaults roughly to East Asia if no bbox is passed.

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};

    // BBox (minY/minX/maxY/maxX) — defaults around East Asia
    const lat1 = parseFloat(q.lat1 ?? 5);
    const lon1 = parseFloat(q.lon1 ?? 70);
    const lat2 = parseFloat(q.lat2 ?? 55);
    const lon2 = parseFloat(q.lon2 ?? 140);

    // Grid spacing in degrees (smaller = denser)
    const step = clamp(parseFloat(q.step ?? 0.5), 0.25, 2);

    // Build a simple lat/lon grid inside the bbox
    const lats = [];
    const lons = [];
    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
    }

    // Keep it sane for serverless + browser
    if (lats.length > 400) {
      return geo({ features: [], warning: `Grid too dense (${lats.length} points). Increase step or zoom in.` });
    }

    // Query Open-Meteo (CAMS global domain) for current PM2.5
    const url =
      "https://air-quality-api.open-meteo.com/v1/air-quality" +
      `?latitude=${lats.join(",")}` +
      `&longitude=${lons.join(",")}` +
      `&current=pm2_5` +
      `&domains=cams_global`;

    const r = await fetch(url);
    if (!r.ok) {
      return geo({ features: [], error: `Open-Meteo ${r.status} ${r.statusText}` }, 502);
    }
    const j = await r.json();

    // Open-Meteo returns either:
    //  • { results: [ { latitude, longitude, current: { pm2_5, time } }, ... ] }
    //  • or an array [ { latitude, longitude, current: { ... } }, ... ]
    const list = Array.isArray(j) ? j : (Array.isArray(j.results) ? j.results : []);

    const features = list.map(d => {
      const lat = safeNum(d?.latitude);
      const lon = safeNum(d?.longitude);
      const pm  = safeNum(d?.current?.pm2_5, null);
      const t   = d?.current?.time || null;

      // Skip invalid coords
      if (!isFinite(lat) || !isFinite(lon)) return null;

      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          pm25: pm, // μg/m³
          time: t,
          source: "Open-Meteo (CAMS model)"
        }
      };
    }).filter(Boolean);

    return geo({ features });
  } catch (e) {
    console.error(e);
    return geo({ features: [], error: String(e?.message || e) }, 500);
  }

  // ---- helpers ----
  function clamp(v, lo, hi) {
    v = Number.isFinite(v) ? v : lo;
    return Math.max(lo, Math.min(hi, v));
  }
  function safeNum(v, fallback = undefined) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function geo({ features, error, warning }, status = 200) {
    const body = {
      type: "FeatureCollection",
      features: features || [],
    };
    if (error)   body.error   = error;
    if (warning) body.warning = warning;

    return {
      statusCode: status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Netlify-CDN-Cache-Control": "no-store"
      },
      body: JSON.stringify(body)
    };
  }
};
