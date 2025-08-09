// netlify/functions/aqi-chat.js
// AQI-only chatbot backend (Node 18 on Netlify)

exports.handler = async (event) => {
  // --- CONFIG ---
  const OPENAI_API_KEY = "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"; // <-- replace with your key

  const FS =
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";
  const SANE_WHERE =
    "value BETWEEN 0 AND 500 AND city IS NOT NULL AND unit IN ('µg/m³','ug/m3')";

  const json = (obj, status = 200) => ({
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Netlify-CDN-Cache-Control": "no-store"
    },
    body: JSON.stringify(obj),
  });

  const postFS = async (params) => {
    const res = await fetch(FS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`ArcGIS FS error ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "ArcGIS FS error");
    return j;
  };

  const clean = (s = "") => String(s).replace(/'/g, "''");
  const toInt = (s, d) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : d;
  };

  if (event.httpMethod !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { userMessage = "", history = [] } = JSON.parse(event.body || "{}");
    const text = String(userMessage).trim();
    if (!text) return json({ reply: "Ask me about PM2.5 / AQI." });

    // AQI-only guard
    const aqiRegex = /(aqi|air\s*quality|pm\s*2\.?5|pm2\.?5|pollution|particulate|fine\s*dust|smog|haze)/i;
    if (!aqiRegex.test(text)) {
      return json({
        reply:
          "I can only answer **air-quality** questions (PM2.5/AQI). Try: “Top 5 polluted cities now” or “What’s PM2.5 in Delhi?”.",
      });
    }

    // intents
    const lower = text.toLowerCase();
    const wantsTop = /\b(top|worst|most\s+polluted|rank|ranking)\b/.test(lower);
    const cityQuery =
      (lower.match(/pm\s*2\.?5[^a-z0-9]+(?:in|for|at)\s+([a-z\-\.\s']{2,})$/i)?.[1]) ||
      (lower.match(/^([a-z\-\.\s']{2,})\s+(?:pm\s*2\.?5|aqi)\b/i)?.[1]) ||
      (lower.match(/\b(?:zoom|center|go\s*to|show)\s+(?:me\s+)?([a-z\-\.\s']{2,})$/i)?.[1]) ||
      null;

    let dataNote = "";
    let action = null;

    if (wantsTop) {
      const k = Math.min(toInt((lower.match(/top\s+(\d{1,2})/) || [])[1], 5), 20);
      const stats = JSON.stringify([
        { statisticType: "avg", onStatisticField: "value", outStatisticFieldName: "avg_pm25" },
        { statisticType: "count", onStatisticField: "value", outStatisticFieldName: "n_stations" }
      ]);
      const j = await postFS({
        where: SANE_WHERE,
        outStatistics: stats,
        groupByFieldsForStatistics: "city,country_name",
        having: "COUNT(value) >= 3",
        orderByFields: "avg_pm25 DESC",
        resultRecordCount: String(k),
        returnGeometry: "false",
        f: "json",
      });
      const rows = (j.features || []).map((f, i) => {
        const a = f.attributes || {};
        return `${i + 1}. ${a.city}, ${a.country_name} — ${Math.round(a.avg_pm25)} µg/m³ (avg, ${a.n_stations} stations)`;
      });
      dataNote = rows.length
        ? `Top ${rows.length} polluted cities (live):\n${rows.join("\n")}`
        : "Live ranking unavailable right now.";
    } else if (cityQuery) {
      const guess = cityQuery.trim();
      const where = `LOWER(city) LIKE '%${clean(guess.toLowerCase())}%' AND ${SANE_WHERE}`;
      const stats = JSON.stringify([
        { statisticType: "avg", onStatisticField: "value", outStatisticFieldName: "avg_pm25" },
        { statisticType: "count", onStatisticField: "value", outStatisticFieldName: "n_stations" }
      ]);
      const j = await postFS({
        where,
        outFields: "city,country_name",
        outStatistics: stats,
        groupByFieldsForStatistics: "city,country_name",
        orderByFields: "avg_pm25 DESC",
        resultRecordCount: "1",
        returnGeometry: "true",
        f: "json",
      });
      const a = j.features?.[0]?.attributes;
      if (a) {
        dataNote = `Latest PM2.5 for ${a.city}, ${a.country_name}: ${Math.round(a.avg_pm25)} µg/m³ (avg of ${a.n_stations} stations).`;
        action = { type: "zoomTo", city: a.city, country: a.country_name };
      } else {
        dataNote = `No recent PM2.5 found for “${guess}”.`;
      }
    }

    if (!dataNote) {
      dataNote =
        "Answer as an AQI/PM2.5 specialist. Categories (µg/m³): Good 0–10, Moderate 10–25, USG 25–50, Unhealthy 50–75, Very Unhealthy 75–100, Hazardous 100+. Source: OpenAQ via Esri Living Atlas (latest hour).";
    }

    // Build LLM messages with short history
    const safeHistory = Array.isArray(history)
      ? history.slice(-8).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : [];

    const system = `
You are an AQI-only assistant inside a PM2.5 dashboard.

Rules:
- Only answer PM2.5/AQI/air-quality questions; otherwise refuse politely.
- Be concise (1–4 sentences), factual; do not invent numbers.
- Use the provided "Live context" for figures; if unclear, ask a brief follow-up.
- If zoom is implied, acknowledge; the UI may use an 'action' object.
Categories (µg/m³): Good 0–10; Moderate 10–25; USG 25–50; Unhealthy 50–75; Very Unhealthy 75–100; Hazardous 100+.
Source: OpenAQ via Esri Living Atlas (updated about hourly).
`.trim();

    const messages = [
      { role: "system", content: system },
      ...safeHistory,
      { role: "user", content: `User: """${text}"""\nLive context:\n${dataNote}` }
    ];

    if (!OPENAI_API_KEY) return json({ reply: dataNote, action });

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.6,
        max_tokens: 280
      }),
    });
    const out = await resp.json();
    const reply = out?.choices?.[0]?.message?.content?.trim() || dataNote;

    return json({ reply, action });
  } catch (err) {
    console.error(err);
    return json({ reply: "Sorry — I hit an error while answering. Please try again." }, 200);
  }
};

