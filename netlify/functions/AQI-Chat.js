// netlify/functions/AQI-Chat.js
// MODIFIED: AI Assistant now uses Open Meteo as the primary data source.

// --- Helper function to calculate US AQI from PM2.5 (copied from frontend) ---
function calculateUSAQI(pm25) {
    if (pm25 === null || pm25 === undefined || isNaN(pm25)) return null;
    const breakpoints = [
        {low: 0.0, high: 12.0, aqiLow: 0, aqiHigh: 50}, {low: 12.1, high: 35.4, aqiLow: 51, aqiHigh: 100},
        {low: 35.5, high: 55.4, aqiLow: 101, aqiHigh: 150}, {low: 55.5, high: 150.4, aqiLow: 151, aqiHigh: 200},
        {low: 150.5, high: 250.4, aqiLow: 201, aqiHigh: 300}, {low: 250.5, high: 500.4, aqiLow: 301, aqiHigh: 500}
    ];
    for (let bp of breakpoints) {
        if (pm25 >= bp.low && pm25 <= bp.high) {
            return Math.round(((bp.aqiHigh - bp.aqiLow) / (bp.high - bp.low)) * (pm25 - bp.low) + bp.aqiLow);
        }
    }
    return pm25 > 500.4 ? 500 : null;
}

exports.handler = async (event) => {
  // --- Standard Setup ---
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const FS_ESRI = "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";
  const SANE_WHERE = "value BETWEEN 0 AND 500 AND city IS NOT NULL AND unit IN ('µg/m³','ug/m3')";
  const json = (obj, status = 200) => ({ statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
  if (!OPENAI_API_KEY) return json({ reply: "Server configuration error: API key is missing." });

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
          name: "getOpenMeteoAQIForCity",
          description: "Gets the current PM2.5 and calculated AQI for any city worldwide. This is the primary tool for most user questions about air quality in a specific city.",
          parameters: { type: "object", properties: { city_name: { type: "string", description: "The name of the city, e.g., 'Jakarta', 'Riyadh', 'Beijing'." } }, required: ["city_name"] },
        },
      },
      {
        type: "function",
        function: {
          name: "getCityPM25FromEsri",
          description: "Gets live PM2.5 data from the global OpenAQ/Esri station network. Use this as a fallback or if the user explicitly asks about 'stations' or 'monitoring locations'.",
          parameters: { type: "object", properties: { query: { type: "string", description: "City or station name, e.g., 'Hanoi', 'Delhi'." } }, required: ["query"] },
        },
      }
    ];
    
    // --- Tool Implementations ---
    async function run_getOpenMeteoAQIForCity(args = {}) {
        const cityName = String(args.city_name || "").trim();
        if (!cityName) return { ok: false, message: "Empty city name." };
        
        // 1. Geocode the city name to get coordinates
        const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1`;
        const geoResponse = await fetch(geocodeUrl);
        if (!geoResponse.ok) return { ok: false, message: `Failed to find coordinates for ${cityName}.`};
        const geoData = await geoResponse.json();
        if (!geoData.results || geoData.results.length === 0) {
            return { ok: false, message: `Could not find the city "${cityName}". Please check the spelling.` };
        }
        const location = geoData.results[0];
        const { latitude, longitude, name, country } = location;

        // 2. Get Air Quality data using the coordinates
        const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&hourly=pm2_5&timezone=auto`;
        const aqiResponse = await fetch(aqiUrl);
        if (!aqiResponse.ok) return { ok: false, message: `Failed to get air quality for ${name}.` };
        const aqiData = await aqiResponse.json();

        // 3. Process the data to find the latest valid reading
        if (aqiData.hourly && aqiData.hourly.pm2_5) {
            const pm25Values = aqiData.hourly.pm2_5;
            for (let i = pm25Values.length - 1; i >= 0; i--) {
                if (pm25Values[i] !== null && !isNaN(pm25Values[i])) {
                    const currentPM25 = Math.round(pm25Values[i] * 10) / 10;
                    const usAQI = calculateUSAQI(currentPM25);
                    return { ok: true, city: name, country: country || '', pm2_5: currentPM25, us_aqi: usAQI };
                }
            }
        }
        return { ok: false, message: `No recent PM2.5 data available from Open Meteo for ${name}.` };
    }

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

    // --- AI System Prompt (Instructions) ---
    const system = `You are "AQI Assistant," an expert embedded in a map dashboard.
- You have two tools. You MUST choose the best one.
1.  \`getOpenMeteoAQIForCity\`: This is your PRIMARY tool. Use it for almost any question about air quality in a specific city (e.g., "AQI in Jakarta", "PM2.5 in Beijing"). It finds the city's coordinates and gets the latest data.
2.  \`getCityPM25FromEsri\`: Use this ONLY if the user asks for data from "monitoring stations" or if the Open Meteo tool fails.
- Be concise (1-3 sentences).
- When giving data, ALWAYS cite your source, e.g., "(Source: Open Meteo)" or "(Source: Esri/OpenAQ)".`.trim();

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
          if (name === "getOpenMeteoAQIForCity") {
            result = await run_getOpenMeteoAQIForCity(args);
          } else if (name === "getCityPM25FromEsri") {
            result = await run_getCityPM25FromEsri(args);
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