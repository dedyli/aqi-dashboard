// netlify/functions/openmeteo-grid.js
// Open-Meteo PM2.5 -> GeoJSON (robust + partial results)
// Always responds 200 so ArcGIS GeoJSONLayer can render.

function clamp(v, lo, hi) { v = Number.isFinite(+v) ? +v : lo; return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fb = undefined) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function geo({ features, error, warning }, status = 200) {
  const body = { type: "FeatureCollection", features: features || [] };
  if (error) body.error = error;
  if (warning) body.warning = warning;
  return {
    statusCode: status, // must be 200 for GeoJSONLayer
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
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
    const MAX_POINTS = 160; // modest; we chunk below

    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (lats.length >= MAX_POINTS) break;
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
      if (lats.length >= MAX_POINTS) break;
    }

    if (lats.length === 0) return geo({ features: [], warning: "Empty extent." });
    let warnings = [];

    const host = "https://air-quality-api.open-meteo.com/v1/air-quality";

    async function fetchBatch(latArr, lonArr) {
      const url =
        host +
        `?latitude=${latArr.join(",")}` +
        `&longitude=${lonArr.join(",")}` +
        `&hourly=pm2_5&forecast_hours=1&timezone=UTC`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`${resp.status} ${resp.statusText} ${t}`.trim());
      }
      return resp.json();
    }

    function toFeatures(j) {
      const out = [];
      const latArr = Array.isArray(j?.latitude) ? j.latitude : (j?.latitude != null ? [j.latitude] : []);
      const lonArr = Array.isArray(j?.longitude) ? j.longitude : (j?.longitude != null ? [j.longitude] : []);
      const timeArr = Array.isArray(j?.hourly?.time) ? j.hourly.time : [];
      const series = j?.hourly?.pm2_5;
      if (!latArr.length || !lonArr.length || !Array.isArray(series)) return out;

      const is2D = Array.isArray(series[0]);
      const time0 = timeArr?.[0] ?? null;
      const n = Math.min(latArr.length, lonArr.length, is2D ? series.length : series.length);

      for (let i = 0; i < n; i++) {
        const lat = safeNum(latArr[i]);
        const lon = safeNum(lonArr[i]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        let pm = null;
        if (is2D) pm = safeNum(series[i]?.[0], null);
        else pm = (series.length === n) ? safeNum(series[i], null) : safeNum(series[0], null);

        out.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: { pm25: pm, time: time0, source: "Open-Meteo (auto-selected)" }
        });
      }
      return out;
    }

    // Chunk + retry logic
    const features = [];
    const BATCH_MAX = 10;

    for (let i = 0; i < lats.length; i += BATCH_MAX) {
      const latChunk = lats.slice(i, i + BATCH_MAX);
      const lonChunk = lons.slice(i, i + BATCH_MAX);

      // 1) try full chunk
      try {
        const j = await fetchBatch(latChunk, lonChunk);
        features.push(...toFeatures(j));
        continue;
      } catch (e1) {
        warnings.push(`Batch ${i / BATCH_MAX + 1}: ${e1.message}`);
      }

      // 2) try smaller halves
      try {
        for (let off = 0; off < latChunk.length; off += 5) {
          const la = latChunk.slice(off, off + 5);
          const lo = lonChunk.slice(off, off + 5);
          if (!la.length) continue;
          try {
            const j = await fetchBatch(la, lo);
            features.push(...toFeatures(j));
          } catch (e2) {
            // 3) last resort: per-point
            for (let k = 0; k < la.length; k++) {
              try {
                const j = await fetchBatch([la[k]], [lo[k]]);
                features.push(...toFeatures(j));
              } catch (e3) {
                warnings.push(`Point ${la[k]},${lo[k]} failed: ${e3.message}`);
              }
            }
          }
        }
      } catch (e) {
        warnings.push(`Reducer error: ${e.message}`);
      }
    }

    // Always 200; include warnings so the UI can keep working.
    if (!features.length) {
      return geo({ features: [], warning: warnings.join(" | ") || "No data returned for this extent." });
    }
    return geo({ features, warning: warnings.length ? warnings.join(" | ") : undefined });
  } catch (e) {
    // Still 200 for GeoJSONLayer; embed the error message.
    return geo({ features: [], error: `Server error: ${e.message}` });
  }
};

