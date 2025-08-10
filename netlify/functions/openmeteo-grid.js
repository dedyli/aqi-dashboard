// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points of PM2.5 using Open-Meteo Air Quality API's hourly data.

// --- Helper Functions ---
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

// --- Main Serverless Handler ---
exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};

    // BBox (minY/minX/maxY/maxX)
    const lat1 = parseFloat(q.lat1 ?? 5);
    const lon1 = parseFloat(q.lon1 ?? 70);
    const lat2 = parseFloat(q.lat2 ?? 55);
    const lon2 = parseFloat(q.lon2 ?? 140);

    // Grid spacing in degrees (smaller = denser)
    const step = clamp(parseFloat(q.step ?? 0.5), 0.25, 2);

    // Build a simple lat/lon grid inside the bbox with a robust safety check
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
    
    if (lats.length === 0) {
      return geo({ features: [] });
    }

    // [SIMPLIFIED LOGIC] Directly query the 'hourly' endpoint.
    const url =
      "https://api.open-meteo.com/v1/air-quality" +
      `?latitude=${lats.join(",")}` +
      `&longitude=${lons.join(",")}` +
      `&hourly=pm2_5` +
      `&forecast_hours=1` + // We only need the most recent hour
      `&domains=cams_global`;

    console.log(`Fetching Open-Meteo hourly data for ${lats.length} points...`);
    
    const r = await fetch(url);
    if (!r.ok) {
      // If even the hourly endpoint fails, return a specific error.
      const errorText = await r.text();
      console.error("Open-Meteo hourly fetch failed:", errorText);
      return geo({ features: [], error: `Open-Meteo API Error: ${r.status} ${r.statusText}` }, 502);
    }
    
    const j = await r.json();
    const features = [];

    // Process the hourly response
    if (j && j.hourly && Array.isArray(j.latitude) && Array.isArray(j.hourly.pm2_5)) {
        const numLocations = j.latitude.length;
        const time = j.hourly.time ? j.hourly.time[0] : null;

        for (let i = 0; i < numLocations; i++) {
            const pm = j.hourly.pm2_5[i] ? safeNum(j.hourly.pm2_5[i][0], null) : null;
            const lat = safeNum(j.latitude[i]);
            const lon = safeNum(j.longitude[i]);

            if (!isFinite(lat) || !isFinite(lon)) continue;

            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lon, lat] },
                properties: {
                    pm25: pm,
                    time: time,
                    source: "Open-Meteo (CAMS model)"
                }
            });
        }
    }

    return geo({ features });

  } catch (e) {
    console.error("Open-Meteo function error:", e);
    return geo({ features: [], error: String(e?.message || "An unknown error occurred.") }, 500);
  }
};