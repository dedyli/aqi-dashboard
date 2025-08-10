// IQAir nearest_city -> GeoJSON points (PM2.5). Safe for ArcGIS GeoJSONLayer.
// Uses env var IQAIR_API_KEY, falls back to a hard-coded key for quick tests.

const API_KEY_FALLBACK = "425836df-81a6-4b30-bafb-e97ceac7401c";
const HOST = "https://api.airvisual.com/v2/nearest_city";

function clamp(v, lo, hi){ v = Number.isFinite(+v) ? +v : lo; return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fb = null){ const n = Number(v); return Number.isFinite(n) ? n : fb; }
function geo({ features, warning, error }){
  const body = { type:"FeatureCollection", features: features || [] };
  if (warning) body.warning = warning;
  if (error) body.error = error;
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "public, max-age=60"
    },
    body: JSON.stringify(body)
  };
}

async function callIQAir(lat, lon, key){
  const url = `${HOST}?lat=${lat}&lon=${lon}&key=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const j = await r.json();
  const d = j?.data || {};
  const loc = d?.location?.coordinates;
  const coords = Array.isArray(loc) && loc.length >= 2 ? [safeNum(loc[0]), safeNum(loc[1])] : [safeNum(lon), safeNum(lat)];
  return {
    coords,
    pm25: safeNum(d?.current?.pollution?.pm2_5),
    ts: d?.current?.pollution?.ts || null,
    city: d?.city || "",
    state: d?.state || "",
    country: d?.country || ""
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
    const key = process.env.IQAIR_API_KEY || API_KEY_FALLBACK;

    // Extent defaults over China
    const lat1 = parseFloat(q.lat1 ?? 30);
    const lon1 = parseFloat(q.lon1 ?? 95);
    const lat2 = parseFloat(q.lat2 ?? 42);
    const lon2 = parseFloat(q.lon2 ?? 125);

    // Step controls density (watch rate limits)
    const step = clamp(parseFloat(q.step ?? 1.0), 0.5, 3.0);

    // Build grid with cap
    const MAX_POINTS = 60;
    const pts = [];
    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (pts.length >= MAX_POINTS) break;
        pts.push([+lon.toFixed(3), +lat.toFixed(3)]); // [lon, lat]
      }
      if (pts.length >= MAX_POINTS) break;
    }
    if (!pts.length) return geo({ features: [], warning: "Empty extent." });

    const features = [];
    const failures = [];
    let oid = 1;

    // Sequential calls (gentle pacing)
    for (let i = 0; i < pts.length; i++) {
      const [lon, lat] = pts[i];
      try {
        const d = await callIQAir(lat, lon, key);
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: d.coords },
          properties: {
            oid: oid++,
            pm25: d.pm25,
            time: d.ts,
            city: d.city,
            state: d.state,
            country: d.country,
            source: "IQAir Nearest City"
          }
        });
      } catch (e) {
        failures.push(`${lat},${lon}: ${e.message}`);
      }
      await new Promise(res => setTimeout(res, 60));
    }

    // Fallback seeds if nothing came back (rare)
    if (features.length === 0) {
      const seeds = [
        [39.9042,116.4074], [31.2304,121.4737], [23.1291,113.2644],
        [22.5431,114.0579], [34.3416,108.9398], [30.5728,104.0668],
        [29.5630,106.5516], [36.0671,120.3826]
      ];
      for (const [lat, lon] of seeds) {
        try {
          const d = await callIQAir(lat, lon, key);
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: d.coords },
            properties: {
              oid: oid++,
              pm25: d.pm25,
              time: d.ts,
              city: d.city,
              state: d.state,
              country: d.country,
              source: "IQAir Nearest City"
            }
          });
          await new Promise(res => setTimeout(res, 60));
        } catch (e) {
          failures.push(`seed ${lat},${lon}: ${e.message}`);
        }
      }
    }

    return geo({
      features,
      warning: failures.length ? `Some calls failed (${failures.length}/${pts.length}).` : undefined
    });
  } catch (e) {
    return geo({ features: [], error: e.message || "Unknown error" });
  }
};
