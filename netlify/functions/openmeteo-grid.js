// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points with near-surface PM2.5 by letting Open-Meteo auto-select the best model.

function clamp(v, lo, hi) {
  v = Number.isFinite(+v) ? +v : lo;
  return Math.max(lo, Math.min(hi, v));
}
function safeNum(v, fb = undefined) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function geo({ features, error, warning }, status = 200) {
  const body = { type: "FeatureCollection", features: features || [] };
  if (error) body.error = error;
  if (warning) body.warning = warning;
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=900",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  // Handle CORS preflight just in case
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    };
  }

  try {
    const q = event.queryStringParameters || {};

    // BBox (minY/minX/maxY/maxX)
    const lat1 = parseFloat(q.lat1 ?? 5);
    const lon1 = parseFloat(q.lon1 ?? 70);
    const lat2 = parseFloat(q.lat2 ?? 55);
    const lon2 = parseFloat(q.lon2 ?? 140);

    // Grid spacing in degrees (smaller = denser)
    const step = clamp(parseFloat(q.step ?? 0.5), 0.25, 2);

    // Build grid safely
    const lats = [];
    const lons = [];
    const MAX_POINTS = 400;

    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (lats.length >= MAX_POINTS) break;
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
      if (lats.length >= MAX_POINTS) break;
    }

    if (lats.length >= MAX_POINTS) {
      return geo({ features: [], warning: `Grid too dense (${lats.length}+ points). Increase step or zoom in.` });
    }
    if (lats.length === 0) return geo({ features: [] });

    // Correct host for Open-Meteo air quality
    const url =
      "https://air-quality-api.open-meteo.com/v1/air-quality" +
      `?latitude=${lats.join(",")}` +
      `&longitude=${lons.join(",")}` +
      `&hourly=pm2_5` +
      `&forecast_hours=1`;

    console.log(`Fetching Open-Meteo hourly data for ${lats.length} points...`);
    const r = await fetch(url);
    if (!r.ok) {
      const errorText = await r.text().catch(() => "");
      console.error("Open-Meteo fetch failed:", r.status, r.statusText, errorText);
      return geo({ features: [], error: `Open-Meteo API Error: ${r.status} ${r.statusText}` }, 502);
    }

    const j = await r.json();
    const features = [];

    // Defensive parsing
    const latArr = Array.isArray(j?.latitude) ? j.latitude : (j?.latitude != null ? [j.latitude] : []);
    const lonArr = Array.isArray(j?.longitude) ? j.longitude : (j?.longitude != null ? [j.longitude] : []);
    const timeArr = Array.isArray(j?.hourly?.time) ? j.hourly.time : [];
    const series = j?.hourly?.pm2_5;

    if (!latArr.length || !lonArr.length || !Array.isArray(series)) {
      return geo({ features: [], warning: "No hourly PM2.5 data returned for this bbox." });
    }

    const is2D = Array.isArray(series[0]); // [[loc0_t0, loc0_t1,...], [loc1_t0,...], ...]
    const time0 = timeArr?.[0] ?? null;

    const n = Math.min(latArr.length, lonArr.length, is2D ? series.length : series.length);
    for (let i = 0; i < n; i++) {
      const lat = safeNum(latArr[i]);
      const lon = safeNum(lonArr[i]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      let pm = null;
      if (is2D) {
        pm = safeNum(series[i]?.[0], null); // first timestep
      } else {
        // If 1D, try per-location value when lengths align; otherwise take first value as a fallback.
        pm = (series.length === n) ? safeNum(series[i], null) : safeNum(series[0], null);
      }

      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          pm25: pm,
          time: time0,
          source: "Open-Meteo (auto-selected model)"
        }
      });
    }

    return geo({ features });
  } catch (e) {
    console.error("Open-Meteo function error:", e);
    return geo({ features: [], error: String(e?.message || "An unknown error occurred.") }, 500);
  }
};
