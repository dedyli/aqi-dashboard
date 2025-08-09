// netlify/functions/AQI-Chat.js
// Simple AQI-only chatbot backend for your dashboard

exports.handler = async (event) => {
  // --- CONFIG ---
  const OPENAI_API_KEY = "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";

  const FS =
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";
  const SANE_WHERE =
    "value BETWEEN 0 AND 500 AND city IS NOT NULL AND unit IN ('µg/m³','ug/m3')";

  const json = (obj, status = 200) => ({
    statusCode: status,
    headers: { "Content-Type": "application/json" },
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
    const { userMessage = "" } = JSON.parse(event.body || "{}");
    const text = String(userMessage).trim();
    if (!text) return json({ reply: "Ask me about PM2.5 / AQI." });

    const aqiRegex =
      /(aqi|air\s*quality|pm\s*2\.?5|pm2\.?5|pollution|particulate|smog|haze)/i;
    if (!aqiRegex.test(text)) {
      return json({
        reply:
          "I can only answer **air-quality** questions (PM2.5/AQI). Try: “Top 5 polluted cities now” or “What’s PM2.5 in Delhi?”.",
      });
    }

    const lower = text.toLowerCase();
    const wantsTop = /\b(top|worst|most\s+polluted|rank|ranking)\b/.test(lower);
    const zoomMatch = text.match(
      /\b(?:zoom|center|go\s*to|show)\s+(?:me\s+)?(.+)$/i
    );
    const cityLikeMatch =
      text.match(/\b(?:in|for|at|around)\s+([A-Za-z\-\.\s']{2,})$/i) ||
      text.match(/^([A-Za-z\-\.\s']{2,})\s+pm\s*2?\.?5$/i);

    let dataNote = "";
    let action = null;

    if (wantsTop) {
      const k = Math.min(toInt((lower.match(/top\s+(\d{1,2})/) || [])[1], 5), 20);
      const stats = JSON.stringify([
        {
          statisticType: "avg",
          onStatisticField: "value",
          outStatisticFieldName: "avg_pm25",
        },
        {
          statisticType: "count",
          onStatisticField: "value",
          outStatisticFieldName: "n_stations",
        },
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
        return `${i + 1}. ${a.city}, ${a.country_name} — ${Math.round(
          a.avg_pm25
        )} µg/m³ (avg, ${a.n_stations} stations)`;
      });
      dataNote = rows.length
        ? `Top ${rows.length} polluted cities (live):\n${rows.join("\n")}`
        : "Live ranking unavailable right now.";
    } else if (zoomMatch || cityLikeMatch) {
      const guess = (zoomMatch?.[1] || cityLikeMatch?.[1] || "").trim();
      if (guess) {
        const where = `LOWER(city) LIKE '%${clean(
          guess.toLowerCase()
        )}%' AND ${SANE_WHERE}`;
        const stats = JSON.stringify([
          {
            statisticType: "avg",
            onStatisticField: "value",
            outStatisticFieldName: "avg_pm25",
          },
          {
            statisticType: "count",
            onStatisticField: "value",
            outStatisticFieldName: "n_stations",
          },
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
          dataNote = `Latest PM2.5 for ${a.city}, ${a.country_name}: ${Math.round(
            a.avg_pm25
          )} µg/m³ (avg of ${a.n_stations} stations).`;
          action = { type: "zoomTo", city: a.city, country: a.country_name };
        } else {
          dataNote = `No recent PM2.5 found for “${guess}”.`;
        }
      }
    }

    if (!dataNote) {
      dataNote =
        "Answer as an AQI/PM2.5 specialist. Categories (µg/m³): Good 0–10, Moderate 10–25, USG 25–50, Unhealthy 50–75, Very Unhealthy 75–100, Hazardous 100+. Source: OpenAQ via Esri Living Atlas.";
    }

    if (!OPENAI_API_KEY) {
      return json({ reply: dataNote, action });
    }

    const system = `
You are an AQI-only assistant embedded in a PM2.5 map dashboard.

RULES:
- Only answer questions about PM2.5/AQI/air-quality. If asked anything else, say you only handle AQI topics.
- Be concise (1–4 sentences), friendly, avoid inventing numbers.
- If a city is unclear, ask for clarification.
- If zoom requested, acknowledge; UI may use 'action' payload.

PM2.5 categories (µg/m³):
Good 0–10; Moderate 10–25; USG 25–50; Unhealthy 50–75; Very Unhealthy 75–100; Hazardous 100+.
Data source: OpenAQ recent PM2.5 via Esri Living Atlas (updates ~hourly).
    `.trim();

    const user = `User message: """${text}"""
Live context: """${dataNote}"""`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
        max_tokens: 280,
      }),
    });

    const out = await resp.json();
    const reply =
      out?.choices?.[0]?.message?.content?.trim() || dataNote || "OK.";

    return json({ reply, action });
  } catch (err) {
    console.error(err);
    return json(
      { reply: "Sorry — I hit an error while answering. Please try again." },
      200
    );
  }
};

