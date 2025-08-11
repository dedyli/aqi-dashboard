// netlify/functions/iqair-cities.js
// Calls IQAir 'nearest_city' for a curated set of Chinese cities and returns GeoJSON.
// Requires env var IQAIR_API_KEY (falls back to demo key for testing).

const HOST = "https://api.airvisual.com/v2/nearest_city";
const API_KEY_FALLBACK = "425836df-81a6-4b30-bafb-e97ceac7401c";

const CN_MAJOR = [
  { name:"Beijing",   lat:39.9042, lon:116.4074 },
  { name:"Shanghai",  lat:31.2304, lon:121.4737 },
  { name:"Guangzhou", lat:23.1291, lon:113.2644 },
  { name:"Shenzhen",  lat:22.5431, lon:114.0579 },
  { name:"Chengdu",   lat:30.5728, lon:104.0668 },
  { name:"Chongqing", lat:29.5630, lon:106.5516 },
  { name:"Xi'an",     lat:34.3416, lon:108.9398 },
  { name:"Wuhan",     lat:30.5928, lon:114.3055 },
  { name:"Hangzhou",  lat:30.2741, lon:120.1551 },
  { name:"Nanjing",   lat:32.0603, lon:118.7969 },
  { name:"Tianjin",   lat:39.3434, lon:117.3616 },
  { name:"Shenyang",  lat:41.8057, lon:123.4315 },
  { name:"Harbin",    lat:45.8038, lon:126.5349 },
  { name:"Qingdao",   lat:36.0671, lon:120.3826 },
  { name:"Zhengzhou", lat:34.7473, lon:113.6249 },
  { name:"Changsha",  lat:28.2282, lon:112.9388 },
  { name:"Kunming",   lat:24.8801, lon:102.8329 },
  { name:"Urumqi",    lat:43.8256, lon:87.6168  },
  { name:"Nanning",   lat:22.8170, lon:108.3669 },
  { name:"Xiamen",    lat:24.4798, lon:118.0894 },
  { name:"Suzhou",    lat:31.2983, lon:120.5832 }
];

function headers(status=200){
  return {
    statusCode: status,
    headers: {
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
      "Cache-Control":"public, max-age=60"
    }
  };
}

async function getNearest(lat, lon, key){
  const url = `${HOST}?lat=${lat}&lon=${lon}&key=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  const j = JSON.parse(text);
  if (j?.status !== "success") throw new Error(`API fail: ${text}`);
  const d = j.data || {};
  const pol = d.current?.pollution || {};
  const coords = d.location?.coordinates || [lon, lat];

  const aqi_us = Number.isFinite(pol.aqius) ? pol.aqius : null;
  const aqi_cn = Number.isFinite(pol.aqicn) ? pol.aqicn : null;
  const useCn = (d.country || "").toLowerCase().includes("china");
  const aqi = useCn ? (aqi_cn ?? aqi_us) : (aqi_us ?? aqi_cn);

  return {
    coords: [Number(coords[0]), Number(coords[1])],
    time: typeof pol.ts === "string" ? pol.ts : "",
    aqi: Number.isFinite(aqi) ? aqi : null,
    aqi_scale: useCn ? "CN" : "US",
    main: (useCn ? (pol.maincn || pol.mainus) : (pol.mainus || pol.maincn)) || "",
    city: d.city || "",
    state: d.state || "",
    country: d.country || ""
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { ...headers(204) };
  try {
    const key = process.env.IQAIR_API_KEY || API_KEY_FALLBACK;

    // allow choosing a smaller subset via ?names=Beijing,Shanghai
    const q = event.queryStringParameters || {};
    const preset = (q.preset || "cn_major").toLowerCase();
    let list = CN_MAJOR;

    if (q.names) {
      const wanted = q.names.split(",").map(s=>s.trim().toLowerCase());
      list = CN_MAJOR.filter(c => wanted.includes(c.name.toLowerCase()));
    } else if (preset !== "cn_major") {
      // unknown preset -> still use CN_MAJOR
    }

    const features = [];
    let oid = 1;
    const errors = [];

    for (const city of list) {
      try {
        const d = await getNearest(city.lat, city.lon, key);
        features.push({
          type:"Feature",
          geometry:{ type:"Point", coordinates:d.coords },
          properties:{
            oid: oid++,
            name: city.name,
            aqi: d.aqi,
            aqi_scale: d.aqi_scale,
            main: d.main,
            time: d.time,
            city: d.city || city.name,
            state: d.state || "",
            country: d.country || "China",
            source: "IQAir Nearest City"
          }
        });
      } catch (e) {
        errors.push(`${city.name}: ${e.message}`);
      }
      // polite pace to avoid throttling
      await new Promise(res => setTimeout(res, 700));
    }

    const body = { type:"FeatureCollection", features };
    if (errors.length) body.warning = `Some cities failed: ${errors.slice(0,4).join(" | ")}${errors.length>4?' …':''}`;

    return { ...headers(200), body: JSON.stringify(body) };
  } catch (e) {
    return { ...headers(200), body: JSON.stringify({ type:"FeatureCollection", features: [], error: e.message }) };
  }
};
