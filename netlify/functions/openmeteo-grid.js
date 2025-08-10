// netlify/functions/openmeteo-grid.js
// Returns GeoJSON points of current PM2.5 using Open-Meteo Air Quality API
// Query params: ?lat1=..&lon1=..&lat2=..&lon2=..&step=0.5
// Defaults roughly to East Asia if no bbox is passed.

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

    // Build a simple lat/lon grid inside the bbox
    const lats = [];
    const lons = [];
    for (let lat = Math.min(lat1, lat2); lat <= Math.max(lat1, lat2) + 1e-9; lat += step) {
      for (let lon = Math.min(lon1, lon2); lon <= Math.max(lon1, lon2) + 1e-9; lon += step) {
        lats.push(+lat.toFixed(3));
        lons.push(+lon.toFixed(3));
      }
    }

    // Keep it sane for serverless + browser
    if (lats.length > 400) {
      return geo({ features: [], warning: `Grid too dense (${lats.length} points). Increase step or zoom in.` });
    }

    // Query Open-Meteo - CORRECTED URL and parameters
    const url =
      "https://api.open-meteo.com/v1/air-quality" +  // Fixed: correct domain
      `?latitude=${lats.join(",")}` +
      `&longitude=${lons.join(",")}` +
      `&current=pm2_5` +  // Try current first
      `&domains=cams_global`;

    console.log(`Fetching Open-Meteo data for ${lats.length} points...`);
    
    const r = await fetch(url);
    if (!r.ok) {
      // If current doesn't work, try hourly
      const urlHourly =
        "https://api.open-meteo.com/v1/air-quality" +
        `?latitude=${lats.join(",")}` +
        `&longitude=${lons.join(",")}` +
        `&hourly=pm2_5` +  // Alternative: hourly data
        `&forecast_hours=1` +  // Just get the first hour
        `&domains=cams_global`;
      
      const r2 = await fetch(urlHourly);
      if (!r2.ok) {
        return geo({ features: [], error: `Open-Meteo ${r2.status} ${r2.statusText}` }, 502);
      }
      const j2 = await r2.json();
      
      // Process hourly format
      const features = processHourlyFormat(j2, lats, lons);
      return geo({ features });
    }
    
    const j = await r.json();

    // Handle different response formats
    let features = [];
    
    // Check if it's a single location response (object with current property)
    if (j.current && !Array.isArray(j)) {
      features = [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [safeNum(j.longitude), safeNum(j.latitude)] },
        properties: {
          pm25: safeNum(j.current.pm2_5, null),
          time: j.current.time || null,
          source: "Open-Meteo (CAMS model)"
        }
      }].filter(f => isFinite(f.geometry.coordinates[0]) && isFinite(f.geometry.coordinates[1]));
    }
    // Check if it's multiple locations (array)
    else if (Array.isArray(j)) {
      features = j.map(d => {
        const lat = safeNum(d?.latitude);
        const lon = safeNum(d?.longitude);
        const pm = safeNum(d?.current?.pm2_5, null);
        const t = d?.current?.time || null;

        if (!isFinite(lat) || !isFinite(lon)) return null;

        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            pm25: pm,
            time: t,
            source: "Open-Meteo (CAMS model)"
          }
        };
      }).filter(Boolean);
    }
    // Handle the old format your code expected
    else if (j.results && Array.isArray(j.results)) {
      features = j.results.map(d => {
        const lat = safeNum(d?.latitude);
        const lon = safeNum(d?.longitude);
        const pm = safeNum(d?.current?.pm2_5, null);
        const t = d?.current?.time || null;

        if (!isFinite(lat) || !isFinite(lon)) return null;

        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            pm25: pm,
            time: t,
            source: "Open-Meteo (CAMS model)"
          }
        };
      }).filter(Boolean);
    }

    return geo({ features });
  } catch (e) {
    console.error("Open-Meteo error:", e);
    return geo({ features: [], error: String(e?.message || e) }, 500);
  }

  // ---- helpers ----
  function clamp(v, lo, hi) {
    v = Number.isFinite(v) ? v : lo;
    return Math.max(lo, Math.min(hi, v));
  }
  
  function safeNum(v, fallback = undefined) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  
  function processHourlyFormat(data, lats, lons) {
    const features = [];
    
    if (Array.isArray(data)) {
      // Multiple locations
      data.forEach((location, idx) => {
        if (location.hourly && location.hourly.pm2_5 && location.hourly.pm2_5.length > 0) {
          features.push({
            type: "Feature",
            geometry: { 
              type: "Point", 
              coordinates: [safeNum(location.longitude), safeNum(location.latitude)] 
            },
            properties: {
              pm25: safeNum(location.hourly.pm2_5[0], null),
              time: location.hourly.time ? location.hourly.time[0] : null,
              source: "Open-Meteo (CAMS model)"
            }
          });
        }
      });
    } else if (data.hourly && data.hourly.pm2_5) {
      // Single location
      if (data.hourly.pm2_5.length > 0) {
        features.push({
          type: "Feature",
          geometry: { 
            type: "Point", 
            coordinates: [safeNum(data.longitude), safeNum(data.latitude)] 
          },
          properties: {
            pm25: safeNum(data.hourly.pm2_5[0], null),
            time: data.hourly.time ? data.hourly.time[0] : null,
            source: "Open-Meteo (CAMS model)"
          }
        });
      }
    }
    
    return features.filter(f => 
      f && isFinite(f.geometry.coordinates[0]) && isFinite(f.geometry.coordinates[1])
    );
  }
  
  function geo({ features, error, warning }, status = 200) {
    const body = {
      type: "FeatureCollection",
      features: features || [],
    };
    if (error)   body.error   = error;
    if (warning) body.warning = warning;

    return {
      statusCode: status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Netlify-CDN-Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",  // Added CORS header
        "Access-Control-Allow-Methods": "GET, OPTIONS"
      },
      body: JSON.stringify(body)
    };
  }
};