// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points with near-surface PM2.5 from Open-Meteo Air Quality.
// Robust to bulk limits by chunking requests.

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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
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

    // Build grid with safety cap
    const lats = [];
    const lons = [];
    const MAX_POINTS = 160; // keep modest; we’ll chunk further below

    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (lats.length >= MAX_POINTS) break;
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
      if (lats.length >= MAX_POINTS) break;
    }

    if (lats.length === 0) return geo({ features: [] });
    if (lats.length >= MAX_POINTS) {
      return geo({ features: [], warning: `Grid too dense (${lats.length}+ pts). Increase step or zoom in.` });
    }

    // Chunk requests to avoid Open-Meteo bulk limits
    const BATCH = 10; // safe batch size
    const features = [];
    const errors = [];

    const host = "https://air-quality-api.open-meteo.com/v1/air-quality";

    for (let i = 0; i < lats.length; i += BATCH) {
      const latChunk = lats.slice(i, i + BATCH);
      const lonChunk = lons.slice(i, i + BATCH);

      const url =
        host +
        `?latitude=${latChunk.join(",")}` +
        `&longitude=${lonChunk.join(",")}` +
        `&hourly=pm2_5` +
        `&forecast_hours=1` +
        `&timezone=UTC`;

      try {
        const r = await fetch(url);
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error("Open-Meteo batch failed:", r.status, r.statusText, txt);
          errors.push(`${r.status} ${r.statusText}`);
          continue;
        }

        const j = await r.json();

        const latArr = Array.isArray(j?.latitude) ? j.latitude : (j?.latitude != null ? [j.latitude] : []);
        const lonArr = Array.isArray(j?.longitude) ? j.longitude : (j?.longitude != null ? [j.longitude] : []);
        const timeArr = Array.isArray(j?.hourly?.time) ? j.hourly.time : [];
        const series = j?.hourly?.pm2_5;

        if (!latArr.length || !lonArr.length || !Array.isArray(series)) {
          errors.push("No hourly pm2_5 in response");
          continue;
        }

        const is2D = Array.isArray(series[0]); // [[loc0_t0,...],[loc1_t0,...],...]
        const time0 = timeArr?.[0] ?? null;
        const n = Math.min(latArr.length, lonArr.length, is2D ? series.length : series.length);

        for (let k = 0; k < n; k++) {
          const lat = safeNum(latArr[k]);
          const lon = safeNum(lonArr[k]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

          let pm = null;
          if (is2D) {
            pm = safeNum(series[k]?.[0], null); // first hour
          } else {
            pm = (series.length === n) ? safeNum(series[k], null) : safeNum(series[0], null);
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
      } catch (err) {
        console.error("Fetch error:", err);
        errors.push(err?.message || "fetch failed");
      }
    }

    if (features.length === 0 && errors.length) {
      return geo({ features: [], error: `Open-Meteo requests failed: ${errors.join(" | ")}` }, 502);
    }

    const warn = errors.length ? `Some batches failed: ${errors.join(" | ")}` : undefined;
    return geo({ features, warning: warn });
  } catch (e) {
    console.error("Open-Meteo function error:", e);
    return geo({ features: [], error: String(e?.message || "Unknown error") }, 500);
  }
};

