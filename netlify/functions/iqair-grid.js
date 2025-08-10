// netlify/functions/iqair-grid.js
// IQAir nearest_city -> GeoJSON points (PM2.5). Safe for ArcGIS GeoJSONLayer.

const API_KEY_FALLBACK = "425836df-81a6-4b30-bafb-e97ceac7401c"; // used only if env var missing
const HOST = "https://api.airvisual.com/v2/nearest_city";

function clamp(v, lo, hi){ v = Number.isFinite(+v) ? +v : lo; return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fb = null){ const n = Number(v); return Number.isFinite(n) ? n : fb; }
function geo({ features, warning, error }){
  const body = { type:"FeatureCollection", features: features || [] };
  if (warning) body.warning = warning;
  if (error) body.error = error;
  return {
    statusCode: 200, // keep 200 so GeoJSONLayer renders even with partial data
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=60"
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
    const key = process.env.IQAIR_API_KEY || API_KEY_FALLBACK;

    // Extent from query (map bbox). Default roughly around East Asia.
    const lat1 = parseFloat(q.lat1 ?? 20);
    const lon1 = parseFloat(q.lon1 ?? 95);
    const lat2 = parseFloat(q.lat2 ?? 45);
    const lon2 = parseFloat(q.lon2 ?? 125);

    // Step: smaller -> denser grid -> more API calls (watch rate limits)
    const step = clamp(parseFloat(q.step ?? 1.0), 0.5, 3.0);

    // Build grid with cap to avoid rate limits
    const MAX_POINTS = 60;   // keep modest; IQAir free tier is rate-limited
    const pts = [];
    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (pts.length >= MAX_POINTS) break;
        pts.push([+lon.toFixed(3), +lat.toFixed(3)]); // [lon, lat]
      }
      if (pts.length >= MAX_POINTS) break;
    }

    if (pts.length === 0) return geo({ features: [], warning: "Empty extent." });

    const features = [];
    const failures = [];

    // Query sequentially to play nice with rate limits
    for (let i = 0; i < pts.length; i++) {
      const [lon, lat] = pts[i];
      const url = `${HOST}?lat=${lat}&lon=${lon}&key=${encodeURIComponent(key)}`;

      try {
        const r = await fetch(url);
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          failures.push(`${lat},${lon}: ${r.status} ${r.statusText}${txt ? " " + txt : ""}`);
          continue;
        }
        const j = await r.json();

        // Expected shape (simplified):
        // { status: "success", data: { city, state, country, location:{coordinates:[lon,lat]}, current:{pollution:{pm2_5, ts}} } }
        const d = j?.data || {};
        const loc = d?.location?.coordinates;
        const coords = Array.isArray(loc) && loc.length >= 2 ? [safeNum(loc[0]), safeNum(loc[1])] : [lon, lat];

        const pm = safeNum(d?.current?.pollution?.pm2_5);
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords },
          properties: {
            pm25: pm,
            time: d?.current?.pollution?.ts || null,
            city: d?.city || "",
            state: d?.state || "",
            country: d?.country || "",
            source: "IQAir Nearest City"
          }
        });

        // tiny delay to be gentle (optional)
        await new Promise(res => setTimeout(res, 60));
      } catch (err) {
        failures.push(`${lat},${lon}: ${err.message}`);
      }
    }

    return geo({
      features,
      warning: failures.length ? `Some points failed (${failures.length}/${pts.length}).` : undefined
    });
  } catch (e) {
    return geo({ features: [], error: e.message || "Unknown error" });
  }
};
