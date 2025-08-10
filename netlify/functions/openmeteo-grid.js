// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points of current PM2.5 using Open-Meteo Air Quality API
// Query params: ?lat1=..&lon1=..&lat2=..&lon2=..&step=0.5
// Defaults roughly to East Asia if no bbox is passed.

export async function handler(event) {
  try {
    const q = event.queryStringParameters || {};

    // BBox (minY/minX/maxY/maxX) — defaults around East Asia
    const lat1 = parseFloat(q.lat1 ?? 5);
    const lon1 = parseFloat(q.lon1 ?? 70);
    const lat2 = parseFloat(q.lat2 ?? 55);
    const lon2 = parseFloat(q.lon2 ?? 140);

    // Grid spacing in degrees (smaller = denser = more API compute)
    const step = Math.max(0.25, Math.min(2, parseFloat(q.step ?? 0.5)));

    const lats = [];
    const lons = [];
    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
    }

    // Keep it sane (serverless cold starts + your browser): cap at 400 points
    if (lats.length > 400) {
      return resp(
        { error: `Grid too dense (${lats.length} points). Increase step or zoom in.` },
        400
      );
    }

    // Open-Meteo supports multiple coordinates in one request
    // Use global CAMS domain and ask only for current pm2_5
    const url =
      "https://air-quality-api.open-meteo.com/v1/air-quality" +
      `?latitude=${lats.join(",")}` +
      `&longitude=${lons.join(",")}` +
      `&current=pm2_5` +
      `&domains=cams_global`;

    const r = await fetch(url);
    if (!r.ok) return resp({ error: `Open-Meteo ${r.status} ${r.statusText}` }, 502);
    const j = await r.json();

    // If multiple coords are passed, API returns a list of objects (one per coord). :contentReference[oaicite:1]{index=1}
    const list = Array.isArray(j) ? j : [j];

    const fc = {
      type: "FeatureCollection",
      features: list.map((d) => {
        // Safety: current.pm2_5 might be undefined
        const pm = d?.current?.pm2_5;
        const value = typeof pm === "number" ? pm : null;
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [d.longitude, d.latitude] },
          properties: {
            pm25: value, // μg/m³
            source: "Open-Meteo (CAMS model)",
            time: d?.current?.time || null,
          },
        };
      }),
    };

    return resp(fc);
  } catch (e) {
    console.error(e);
    return resp({ error: String(e?.message || e) }, 500);
  }

  function resp(obj, status = 200) {
    return {
      statusCode: status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Netlify-CDN-Cache-Control": "no-store",
      },
      body: JSON.stringify(obj),
    };
  }
}
