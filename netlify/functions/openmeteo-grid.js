// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points of current PM2.5 using Open-Meteo Air Quality API
// Query params: ?lat1=..&lon1=..&lat2=..&lon2=..&step=0.5
// Defaults roughly to East Asia if no bbox is passed.

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
      "Cache-Control": "public, max-age=900", // Cache for 15 minutes
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

/**
 * [Corrected] Processes the hourly data format from Open-Meteo.
 * The API returns a single object with arrays of values.
 * @param {object} data - The JSON response from the Open-Meteo API.
 * @returns {Array} - An array of GeoJSON features.
 */
function processHourlyFormat(data) {
    const features = [];
    // Check for the correct hourly response structure for multiple locations
    if (data && data.hourly && Array.isArray(data.latitude) && Array.isArray(data.hourly.pm2_5)) {
        const numLocations = data.latitude.length;
        const time = data.hourly.time ? data.hourly.time[0] : null; // Get the first time entry

        for (let i = 0; i < numLocations; i++) {
            // hourly.pm2_5 is an array of arrays, so get the first value from the inner array
            const pm = data.hourly.pm2_5[i] ? safeNum(data.hourly.pm2_5[i][0], null) : null;
            const lat = safeNum(data.latitude[i]);
            const lon = safeNum(data.longitude[i]);

            if (!isFinite(lat) || !isFinite(lon)) continue;

            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lon, lat] },
                properties: {
                    pm25: pm,
                    time: time,
                    source: "Open-Meteo (CAMS model, hourly)"
                }
            });
        }
    }
    return features;
}


// --- Main Serverless Handler ---
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

    // [CORRECTED] Build a simple lat/lon grid inside the bbox with a robust safety check
    const lats = [];
    const lons = [];
    const MAX_POINTS = 400; // Define a constant for the limit

    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        // Check the limit on *every iteration* to prevent a crash
        if (lats.length >= MAX_POINTS) {
          break; // Exit the inner loop
        }
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
      if (lats.length >= MAX_POINTS) {
        break; // Exit the outer loop
      }
    }

    // Return a warning if the limit was reached, instead of crashing.
    if (lats.length >= MAX_POINTS) {
      return geo({ features: [], warning: `Grid too dense (${lats.length}+ points). Increase step or zoom in.` });
    }
    
    if (lats.length === 0) {
        return geo({ features: [] });
    }

    // Query Open-Meteo - `current` data is preferred for speed.
    const url =
      "https://api.open-meteo.com/v1/air-quality" +
      `?latitude=${lats.join(",")}` +
      `&longitude=${lons.join(",")}` +
      `&current=pm2_5` +
      `&domains=cams_global`;

    console.log(`Fetching Open-Meteo data for ${lats.length} points...`);
    const r = await fetch(url);
    
    // Fallback to hourly if the 'current' endpoint fails or is unavailable
    if (!r.ok) {
      console.log(`'current' endpoint failed (${r.status}). Falling back to 'hourly'.`);
      const urlHourly =
        "https://api.open-meteo.com/v1/air-quality" +
        `?latitude=${lats.join(",")}` +
        `&longitude=${lons.join(",")}` +
        `&hourly=pm2_5` +
        `&forecast_hours=1` +
        `&domains=cams_global`;
      
      const r2 = await fetch(urlHourly);
      if (!r2.ok) {
        return geo({ features: [], error: `Open-Meteo fallback failed: ${r2.status} ${r2.statusText}` }, 502);
      }
      const j2 = await r2.json();
      const features = processHourlyFormat(j2);
      return geo({ features });
    }
    
    const j = await r.json();
    let features = [];

    // [CORRECTED] Process the response for 'current' data.
    // The API returns a single object where each property is an array of values.
    if (j && j.current && Array.isArray(j.latitude) && Array.isArray(j.current.pm2_5)) {
        const numLocations = j.latitude.length;
        const pmValues = j.current.pm2_5;
        const time = j.current.time;

        for (let i = 0; i < numLocations; i++) {
            const lat = safeNum(j.latitude[i]);
            const lon = safeNum(j.longitude[i]);
            const pm = safeNum(pmValues[i], null);

            if (!isFinite(lat) || !isFinite(lon)) continue;

            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lon, lat] },
                properties: {
                    pm25: pm,
                    time: time || null,
                    source: "Open-Meteo (CAMS model, current)"
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