// netlify/functions/iqair-grid.js
// Fetches PM2.5 from IQAir nearest_city for a lat/lon grid.

const API_KEY = "425836df-81a6-4b30-bafb-e97ceac7401c";

function clamp(v, lo, hi) { v = Number.isFinite(+v) ? +v : lo; return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fb = undefined) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function geo({ features, error, warning }) {
  const body = { type: "FeatureCollection", features: features || [] };
  if (error) body.error = error;
  if (warning) body.warning = warning;
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
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
    const lat1 = parseFloat(q.lat1 ?? 5);
    const lon1 = parseFloat(q.lon1 ?? 70);
    const lat2 = parseFloat(q.lat2 ?? 55);
    const lon2 = parseFloat(q.lon2 ?? 140);
    const step = clamp(parseFloat(q.step ?? 1), 0.5, 5);

    const lats = [];
    const lons = [];
    const MAX_POINTS = 50; // IQAir free tier is rate-limited

    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (lats.length >= MAX_POINTS) break;
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
      if (lats.length >= MAX_POINTS) break;
    }

    const features = [];
    const warnings = [];

    for (let i = 0; i < lats.length; i++) {
      try {
        const url = `https://api.airvisual.com/v2/nearest_city?lat=${lats[i]}&lon=${lons[i]}&key=${API_KEY}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const j = await r.json();
        const pm = safeNum(j?.data?.current?.pollution?.pm2_5, null);
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lons[i], lats[i]] },
          properties: {
            pm25: pm,
            time: j?.data?.current?.pollution?.ts || null,
            city: j?.data?.city || "",
            country: j?.data?.country || "",
            source: "IQAir Nearest City"
          }
        });
      } catch (err) {
        warnings.push(`Point ${lats[i]},${lons[i]} failed: ${err.message}`);
      }
    }

    return geo({ features, warning: warnings.length ? warnings.join(" | ") : undefined });
  } catch (e) {
    return geo({ features: [], error: e.message });
  }
};
