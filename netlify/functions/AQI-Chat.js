// netlify/functions/AQI-Chat.js
// UPGRADED: AQI Assistant with two data source tools: Esri Living Atlas and Google AQI.
// Secrets are read from Netlify environment variables.

// --- Google AQI Data & Logic (Copied from google-aqi.js) ---
const GOOGLE_AQI_HOST = "https://airquality.googleapis.com/v1/currentConditions:lookup";
const GOOGLE_AQI_KEY = process.env.GOOGLE_AQI_API_KEY;
const GOOGLE_CITIES = [
    // China (Expanded)
    { name: "Beijing", lat: 39.9042, lon: 116.4074 }, { name: "Shanghai", lat: 31.2304, lon: 121.4737 },
    { name: "Chongqing", lat: 29.5630, lon: 106.5516 }, { name: "Tianjin", lat: 39.3434, lon: 117.3616 },
    { name: "Guangzhou", lat: 23.1291, lon: 113.2644 }, { name: "Shenzhen", lat: 22.5431, lon: 114.0579 },
    { name: "Chengdu", lat: 30.5728, lon: 104.0668 }, { name: "Nanjing", lat: 32.0603, lon: 118.7969 },
    { name: "Wuhan", lat: 30.5928, lon: 114.3055 }, { name: "Hangzhou", lat: 30.2741, lon: 120.1551 },
    { name: "Xi'an", lat: 34.3416, lon: 108.9398 }, { name: "Qingdao", lat: 36.0671, lon: 120.3826 },
    { name: "Dongguan", lat: 23.0488, lon: 113.7505 }, { name: "Shenyang", lat: 41.8057, lon: 123.4315 },
    { name: "Zhengzhou", lat: 34.7473, lon: 113.6249 }, { name: "Changsha", lat: 28.2282, lon: 112.9388 },
    { name: "Harbin", lat: 45.8038, lon: 126.5349 }, { name: "Suzhou", lat: 31.2983, lon: 120.5832 },
    { name: "Foshan", lat: 23.0215, lon: 113.1214 }, { name: "Dalian", lat: 38.9140, lon: 121.6147 },
    { name: "Jinan", lat: 36.6683, lon: 116.9972 }, { name: "Changchun", lat: 43.8171, lon: 125.3235 },
    { name: "Kunming", lat: 25.0422, lon: 102.7065 }, { name: "Xiamen", lat: 24.4798, lon: 118.0894 },
    { name: "Hefei", lat: 31.8206, lon: 117.2272 }, { name: "Shantou", lat: 23.3688, lon: 116.7088 },
    { name: "Ningbo", lat: 29.8683, lon: 121.5439 }, { name: "Shijiazhuang", lat: 38.0428, lon: 114.5149 },
    { name: "Taiyuan", lat: 37.8706, lon: 112.5501 }, { name: "Nanning", lat: 22.8170, lon: 108.3669 },
    { name: "Urumqi", lat: 43.8256, lon: 87.6168 }, { name: "Lanzhou", lat: 36.0611, lon: 103.8343 },
    { name: "Wenzhou", lat: 27.9943, lon: 120.6993 }, { name: "Fuzhou", lat: 26.0745, lon: 119.2965 },
    { name: "Guiyang", lat: 26.5825, lon: 106.7082 }, { name: "Haikou", lat: 20.0458, lon: 110.3417 },
    { name: "Lhasa", lat: 29.6538, lon: 91.1172 }, { name: "Kashgar", lat: 39.4700, lon: 75.9900 },
    { name: "Istanbul", lat: 41.0082, lon: 28.9784 }, { name: "Cairo", lat: 30.0444, lon: 31.2357 },
    { name: "Baghdad", lat: 33.3152, lon: 44.3661 }, { name: "Riyadh", lat: 24.7136, lon: 46.6753 },
    { name: "Tehran", lat: 35.6892, lon: 51.3890 }, { name: "Ankara", lat: 39.9334, lon: 32.8597 },
    { name: "Alexandria", lat: 31.2001, lon: 29.9187 }, { name: "Jeddah", lat: 21.4858, lon: 39.1925 },
    { name: "Amman", lat: 31.9454, lon: 35.9284 }, { name: "Izmir", lat: 38.4237, lon: 27.1428 },
    { name: "Kuwait City", lat: 29.3759, lon: 47.9774 }, { name: "Sanaa", lat: 15.3694, lon: 44.1910 },
    { name: "Dubai", lat: 25.276987, lon: 55.296249 }, { name: "Abu Dhabi", lat: 24.4539, lon: 54.3773 },
    { name: "Aleppo", lat: 36.2021, lon: 37.1343 }, { name: "Damascus", lat: 33.5138, lon: 36.2765 },
    { name: "Beirut", lat: 33.8938, lon: 35.5018 }, { name: "Doha", lat: 25.2854, lon: 51.5310 },
    { name: "Mecca", lat: 21.3891, lon: 39.8579 }, { name: "Medina", lat: 24.4686, lon: 39.6142 },
    { name: "Muscat", lat: 23.5880, lon: 58.3829 }, { name: "Bursa", lat: 40.1885, lon: 29.0610 },
    { name: "Adana", lat: 37.0000, lon: 35.3213 }, { name: "Giza", lat: 30.0081, lon: 31.2109 },
    { name: "Basra", lat: 30.5081, lon: 47.7836 }, { name: "Isfahan", lat: 32.6546, lon: 51.6680 },
    { name: "Mashhad", lat: 36.2970, lon: 59.6062 }, { name: "Shiraz", lat: 29.6109, lon: 52.5375 },
    { name: "Dammam", lat: 26.4207, lon: 50.0888 }, { name: "Manama", lat: 26.2285, lon: 50.5860 },
    { name: "Tel Aviv", lat: 32.0853, lon: 34.7818 }, { name: "Jerusalem", lat: 31.7683, lon: 35.2137 },
    { name: "Sharjah", lat: 25.3463, lon: 55.4209 }, { name: "Gaziantep", lat: 37.0662, lon: 37.3833 },
    { name: "Mosul", lat: 36.3414, lon: 43.1436 }, { name: "Erbil", lat: 36.1911, lon: 44.0094 },
    { name: "Jakarta", lat: -6.2088, lon: 106.8456 }, { name: "Manila", lat: 14.5995, lon: 120.9842 },
    { name: "Bangkok", lat: 13.7563, lon: 100.5018 }, { name: "Ho Chi Minh City", lat: 10.7769, lon: 106.7009 },
    { name: "Singapore", lat: 1.3521, lon: 103.8198 }, { name: "Kuala Lumpur", lat: 3.1390, lon: 101.6869 },
    { name: "Yangon", lat: 16.8409, lon: 96.1735 }, { name: "Hanoi", lat: 21.0278, lon: 105.8342 },
    { name: "Surabaya", lat: -7.2575, lon: 112.7521 }, { name: "Bandung", lat: -6.9175, lon: 107.6191 },
    { name: "Quezon City", lat: 14.6760, lon: 121.0437 }, { name: "Makassar", lat: -5.1477, lon: 119.4327 },
    { name: "Phnom Penh", lat: 11.5564, lon: 104.9282 }, { name: "Medan", lat: 3.5952, lon: 98.6722 },
    { name: "Cebu City", lat: 10.3157, lon: 123.8854 }, { name: "Da Nang", lat: 16.0544, lon: 108.2022 },
    { name: "Vientiane", lat: 17.9749, lon: 102.6309 }, { name: "Chiang Mai", lat: 18.7883, lon: 98.9853 },
    { name: "Mandalay", lat: 21.9587, lon: 96.0891 }, { name: "George Town", lat: 5.4141, lon: 100.3288 },
    { name: "Palembang", lat: -2.9909, lon: 104.7566 }, { name: "Semarang", lat: -6.9667, lon: 110.4283 },
    { name: "Davao City", lat: 7.1907, lon: 125.4553 }, { name: "Johor Bahru", lat: 1.4927, lon: 103.7414 },
    { name: "Ipoh", lat: 4.5975, lon: 101.0901 }, { name: "Haiphong", lat: 20.8449, lon: 106.6881 },
    { name: "Can Tho", lat: 10.0452, lon: 105.7468 }, { name: "Naypyidaw", lat: 19.7633, lon: 96.0785 },
    { name: "Luang Prabang", lat: 19.8858, lon: 102.1350 }, { name: "Bandar Seri Begawan", lat: 4.9031, lon: 114.9398 },
    { name: "Kota Kinabalu", lat: 5.9804, lon: 116.0735 }, { name: "Kuching", lat: 1.5533, lon: 110.3439 },
    { name: "Denpasar", lat: -8.6705, lon: 115.2126 }, { name: "Yogyakarta", lat: -7.7956, lon: 110.3695 },
    { name: "Phuket", lat: 7.8804, lon: 98.3923 }, { name: "Pattaya", lat: 12.9236, lon: 100.8825 },
    { name: "Siem Reap", lat: 13.3610, lon: 103.8603 }, { name: "Sihanoukville", lat: 10.6276, lon: 103.5221 },
    { name: "Malacca", lat: 2.1896, lon: 102.2501 },
    { name: "Sydney", lat: -33.8688, lon: 151.2093 }, { name: "Melbourne", lat: -37.8136, lon: 144.9631 },
    { name: "Brisbane", lat: -27.4698, lon: 153.0251 }, { name: "Perth", lat: -31.9505, lon: 115.8605 },
    { name: "Adelaide", lat: -34.9285, lon: 138.6007 }, { name: "Auckland", lat: -36.8485, lon: 174.7633 },
    { name: "Gold Coast", lat: -28.0167, lon: 153.4000 }, { name: "Canberra", lat: -35.2809, lon: 149.1300 },
    { name: "Wellington", lat: -41.2865, lon: 174.7762 }, { name: "Newcastle", lat: -32.9283, lon: 151.7817 },
    { name: "Wollongong", lat: -34.4278, lon: 150.8931 }, { name: "Christchurch", lat: -43.5321, lon: 172.6362 },
    { name: "Hobart", lat: -42.8821, lon: 147.3272 }, { name: "Geelong", lat: -38.1499, lon: 144.3617 },
    { name: "Townsville", lat: -19.2590, lon: 146.8169 }, { name: "Darwin", lat: -12.4634, lon: 130.8456 },
    { name: "Cairns", lat: -16.9203, lon: 145.7710 }, { name: "Hamilton", lat: -37.7870, lon: 175.2793 },
    { name: "Dunedin", lat: -45.8788, lon: 170.5028 }, { name: "Suva", lat: -18.1416, lon: 178.4419 },
    { name: "Port Moresby", lat: -9.4438, lon: 147.1803 }, { name: "Nouméa", lat: -22.2758, lon: 166.4580 },
    { name: "Papeete", lat: -17.5350, lon: -149.5695 }, { name: "Apia", lat: -13.8333, lon: -171.7667 },
    { name: "Nadi", lat: -17.7765, lon: 177.4248 }, { name: "Honiara", lat: -9.4333, lon: 159.9500 },
    { name: "Port Vila", lat: -17.7333, lon: 168.3167 }, { name: "Sunshine Coast", lat: -26.6500, lon: 153.0667 }
];

async function getGoogleAqi(lat, lon) {
    const res = await fetch(`${GOOGLE_AQI_HOST}?key=${GOOGLE_AQI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { latitude: lat, longitude: lon } })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    const j = JSON.parse(text);
    if (j.error) throw new Error(`API fail: ${j.error.message}`);
    const aqi = j.indexes?.[0]?.aqi;
    const category = j.indexes?.[0]?.category;
    return {
        aqi: Number.isFinite(aqi) ? aqi : null,
        category: category || "N/A"
    };
}


exports.handler = async (event) => {
  // --- Standard Setup ---
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const FS_ESRI = "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";
  const SANE_WHERE = "value BETWEEN 0 AND 500 AND city IS NOT NULL AND unit IN ('µg/m³','ug/m3')";
  const json = (obj, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
  if (!OPENAI_API_KEY || !GOOGLE_AQI_KEY) return json({ reply: "Server configuration error: one or more API keys are missing." });

  // --- Helpers (Esri Fetching, OpenAI calling, etc.) ---
  const postFS = async (params) => { const res = await fetch(FS_ESRI, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), }); if (!res.ok) throw new Error(`ArcGIS FS ${res.status} ${res.statusText}`); const j = await res.json(); if (j.error) throw new Error(j.error.message || "ArcGIS FS error"); return j; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function callOpenAIWithRetry(body, maxTries = 3) { let attempt = 0; while (attempt < maxTries) { attempt++; const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(body) }); let out; try { out = await r.json(); } catch (e) { if (attempt >= maxTries) return { ok: false, msg: "OpenAI response parse error." }; await wait(300 * attempt); continue; } if (r.ok && !out?.error) return { ok: true, data: out }; const msg = out?.error?.message || `${r.status} ${r.statusText}`; if (r.status === 429 && attempt < maxTries) { const backoff = Math.round(700 * 2 ** (attempt - 1) + Math.random() * 200); await wait(backoff); continue; } return { ok: false, msg: `OpenAI error: ${msg}` }; } return { ok: false, msg: "OpenAI error: retries exceeded." }; }
  
  try {
    const { userMessage = "", history = [] } = JSON.parse(event.body || "{}");
    const text = String(userMessage || "").slice(0, 600).trim();
    const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
    
    // --- AI Tool Definitions ---
    const tools = [
      {
        type: "function",
        function: {
          name: "getCityPM25FromEsri",
          description: "Gets live PM2.5 data for ANY city or station from the global OpenAQ/Esri station network. Use for specific station names or any city not in the Google AQI list.",
          parameters: { type: "object", properties: { query: { type: "string", description: "City or station name, e.g., 'Hanoi', 'Delhi', or a specific station ID." } }, required: ["query"] },
        },
      },
      {
        type: "function",
        function: {
          name: "getGoogleAQIForCity",
          description: "Gets the current regional AQI for a specific city from a curated list of 200 cities across Asia, the Middle East, and Australia. Use this for general AQI questions about cities on that list.",
          parameters: { type: "object", properties: { city_name: { type: "string", description: "The name of the city, e.g., 'Riyadh', 'Jakarta', 'Sydney'." } }, required: ["city_name"] },
        },
      }
    ];
    
    // --- Tool Implementations ---
    async function run_getCityPM25FromEsri(args = {}) {
        const query = String(args.query || "").toLowerCase().trim();
        if (!query) return { ok: false, message: "Empty query." };
        const where = `(LOWER(city) LIKE '%${query}%' OR LOWER(location) LIKE '%${query}%') AND ${SANE_WHERE}`;
        const stats = JSON.stringify([{ statisticType: "avg", onStatisticField: "value", outStatisticFieldName: "avg_pm25" }, { statisticType: "count", onStatisticField: "value", outStatisticFieldName: "n_stations" }]);
        const j = await postFS({ where, outStatistics: stats, groupByFieldsForStatistics: "city,country_name", orderByFields: "n_stations DESC", returnGeometry: "true" });
        if (!j.features?.length) return { ok: false, message: `No recent PM2.5 station data found for "${args.query}".` };
        const a = j.features[0].attributes;
        return { ok: true, city: a.city, country: a.country_name, avg_pm25: Math.round(a.avg_pm25), stations: a.n_stations, action: { type: "zoomTo", city: a.city, country: a.country_name } };
    }

    async function run_getGoogleAQIForCity(args = {}) {
        const cityName = String(args.city_name || "").toLowerCase().trim();
        if (!cityName) return { ok: false, message: "Empty city name." };
        const city = GOOGLE_CITIES.find(c => c.name.toLowerCase() === cityName);
        if (!city) return { ok: false, message: `The city "${args.city_name}" is not on the Google AQI list. Try the other tool.` };
        const data = await getGoogleAqi(city.lat, city.lon);
        if (data.aqi === null) return { ok: false, message: `Could not retrieve Google AQI for ${city.name}.` };
        return { ok: true, city: city.name, ...data };
    }

    // --- AI System Prompt (Instructions) ---
    const system = `You are "AQI Assistant," an expert embedded in a map dashboard.
- You have two tools to get live data. You must choose the best one for the user's question.
1.  \`getCityPM25FromEsri\`: Use for any city worldwide, especially for specific PM2.5 values or queries about live monitoring stations. This is from the global OpenAQ network.
2.  \`getGoogleAQIForCity\`: Use ONLY for cities on your list of 200 (e.g., Jakarta, Riyadh, Sydney, etc.). This gives a regional AQI value. If unsure, use the Esri tool.
- Be concise (1-3 sentences).
- When giving data, ALWAYS cite your source, e.g., "(Source: Google AQI)" or "(Source: Esri/OpenAQ)".`.trim();

    // --- Main Execution Logic ---
    const first = await callOpenAIWithRetry({ model: OPENAI_MODEL, temperature: 0.1, tools, tool_choice: "auto", messages: [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }] });
    if (!first.ok) { console.error(first.msg); return json({ reply: "The AI is busy. Please try again in a moment." }); }

    let messages = [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }];
    let action = null;
    const msg = first.data?.choices?.[0]?.message;

    if (msg?.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        const args = JSON.parse(call.function?.arguments || "{}");
        let result;
        try {
          if (name === "getCityPM25FromEsri") {
            result = await run_getCityPM25FromEsri(args);
          } else if (name === "getGoogleAQIForCity") {
            result = await run_getGoogleAQIForCity(args);
          } else {
            result = { error: `Unknown tool: ${name}` };
          }
          if (result?.action) action = result.action;
        } catch (e) {
          result = { error: `Tool execution error: ${e.message}` };
        }
        messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(result) });
      }
      
      const second = await callOpenAIWithRetry({ model: OPENAI_MODEL, temperature: 0.7, messages });
      if (!second.ok) { console.error(second.msg); return json({ reply: "The AI is busy. Please try again." }); }
      const reply = second.data?.choices?.[0]?.message?.content?.trim() || "";
      return json({ reply, action });
    }

    const reply = msg?.content?.trim() || "";
    return json({ reply, action });
  } catch (err) {
    console.error("Handler error:", err);
    return json({ reply: "A server error occurred. Please try again." }, 500);
  }
};