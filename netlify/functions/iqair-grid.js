// IQAir nearest_city -> GeoJSON points (AQI). Safe for ArcGIS GeoJSONLayer.
// Uses env var IQAIR_API_KEY; falls back to a hard-coded key for local tests.

const HOST = "https://api.airvisual.com/v2/nearest_city";
const API_KEY_FALLBACK = "425836df-81a6-4b30-bafb-e97ceac7401c";

function clamp(v, lo, hi){ v = Number.isFinite(+v) ? +v : lo; return Math.max(lo, Math.min(hi, v)); }
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
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} :: ${text.slice(0,200)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error(`Bad JSON: ${text.slice(0,200)}`); }
  if (j?.status !== "success") throw new Error(`API fail: ${JSON.stringify(j).slice(0,200)}`);

  const d = j.data || {};
  const loc = d?.location?.coordinates;
  const coords = Array.isArray(loc) && loc.length >= 2 ? [Number(loc[0]), Number(loc[1])] : [Number(lon), Number(lat)];
  const pol = d?.current?.pollution || {};

  return {
    coords,
    ts: typeof pol.ts === "string" ? pol.ts : "",
    aqi_us: Number.isFinite(pol.aqius) ? pol.aqius : null,
    main_us: typeof pol.mainus === "string" ? pol.mainus : "",
    aqi_cn: Number.isFinite(pol.aqicn) ? pol.aqicn : null,
    main_cn: typeof pol.maincn === "string" ? pol.maincn : "",
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

    // Defaults over China
    const lat1 = parseFloat(q.lat1 ?? 30);
    const lon1 = parseFloat(q.lon1 ?? 95);
    const lat2 = parseFloat(q.lat2 ?? 42);
    const lon2 = parseFloat(q.lon2 ?? 125);
    const step = clamp(parseFloat(q.step ?? 1.5), 1.0, 5.0);

    // Tiny grid (gentle on rate limits)
    const MAX_POINTS = 12;
    const pts = [];
    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        if (pts.length >= MAX_POINTS) break;
        pts.push([+lon.toFixed(3), +lat.toFixed(3)]);
      }
      if (pts.length >= MAX_POINTS) break;
    }
    if (!pts.length) return geo({ features: [], warning: "Empty extent." });

    const features = [];
    const failures = [];
    const firstErrors = [];
    let oid = 1;

    for (let i = 0; i < pts.length; i++) {
      const [lon, lat] = pts[i];
      try {
        const d = await callIQAir(lat, lon, key);

        // pick which AQI to use for the 'aqi' field (CN inside China, else US)
        const useCn = (d.country || "").toLowerCase().includes("china");
        const aqi = useCn ? (Number.isFinite(d.aqi_cn) ? d.aqi_cn : (Number.isFinite(d.aqi_us) ? d.aqi_us : -1))
                          : (Number.isFinite(d.aqi_us) ? d.aqi_us : (Number.isFinite(d.aqi_cn) ? d.aqi_cn : -1));
        const main = useCn ? (d.main_cn || d.main_us) : (d.main_us || d.main_cn);

        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: d.coords },
          properties: {
            oid: oid++,
            // unified fields the map will use
            aqi,                      // numeric AQI 0–500 (or -1 if unknown)
            aqi_scale: useCn ? "CN" : "US",
            main,                     // main pollutant code (e.g., p2, o3)
            time: d.ts,
            city: d.city, state: d.state, country: d.country,
            // raw fields for completeness
            aqi_us: d.aqi_us, main_us: d.main_us,
            aqi_cn: d.aqi_cn, main_cn: d.main_cn,
            source: "IQAir Nearest City"
          }
        });
      } catch (e) {
        failures.push(`${lat},${lon}: ${e.message}`);
        if (firstErrors.length < 3) firstErrors.push(e.message);
      }
      // ~1 req/sec to be polite
      await new Promise(res => setTimeout(res, 1000));
    }

    // If nothing came back, at least try Beijing so the layer has something
    if (features.length === 0) {
      try {
        const d = await callIQAir(39.9042, 116.4074, key);
        features.push({
          type:"Feature",
          geometry:{ type:"Point", coordinates:d.coords },
          properties:{
            oid: 1,
            aqi: Number.isFinite(d.aqi_cn) ? d.aqi_cn : (Number.isFinite(d.aqi_us) ? d.aqi_us : -1),
            aqi_scale: "CN",
            main: d.main_cn || d.main_us || "",
            time: d.ts,
            city: d.city, state: d.state, country: d.country,
            aqi_us: d.aqi_us, main_us: d.main_us,
            aqi_cn: d.aqi_cn, main_cn: d.main_cn,
            source: "IQAir Nearest City"
          }
        });
      } catch (e) {
        firstErrors.push(`seed: ${e.message}`);
      }
    }

    const warning = failures.length ? `Some calls failed (${failures.length}/${pts.length}). First errors: ${firstErrors.join(" | ")}` : undefined;
    return geo({ features, warning });
  } catch (e) {
    return geo({ features: [], error: e.message || "Unknown error" });
  }
};
