// netlify/functions/AQI-Chat.js
// AQI specialist chatbot with OpenAI "function/tools" calling + Esri Living Atlas
// Node 18 recommended (netlify.toml -> [functions] node_version = "18")

exports.handler = async (event) => {
  // ---- CONFIG ----
  const OPENAI_API_KEY = "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"; // <-- put your key here
  const FS =
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";
  const SANE_WHERE =
    "value BETWEEN 0 AND 500 AND city IS NOT NULL AND unit IN ('µg/m³','ug/m3')";

  // ---- helpers ----
  const json = (obj, status = 200) => ({
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Netlify-CDN-Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  });

  const postFS = async (params) => {
    const res = await fetch(FS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`ArcGIS FS ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "ArcGIS FS error");
    return j;
  };

  const clean = (s = "") => String(s).replace(/'/g, "''");

  if (event.httpMethod !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { userMessage = "", history = [] } = JSON.parse(event.body || "{}");
    const text = String(userMessage || "").trim();

    if (!text) return json({ reply: "Ask me about PM2.5 / AQI." });

    // AQI-only guard up front (but allow synonyms)
    const aqiRegex =
      /(aqi|air\s*quality|pm\s*2\.?5|pm2\.?5|pollution|particulate|fine\s*dust|smog|haze)/i;
    if (!aqiRegex.test(text)) {
      return json({
        reply:
          "I’m an AQI specialist. I can help with PM2.5, AQI, air-quality trends, affected health categories, or the most polluted cities right now.",
      });
    }

    // ---------- OpenAI tool definitions ----------
    const tools = [
      {
        type: "function",
        function: {
          name: "getTopCities",
          description:
            "Return top N polluted cities worldwide using latest PM2.5 (avg across stations, only if ≥3 stations).",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                description: "How many to return (1–20). Default 5.",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getCityPM25",
          description:
            "Return a short live summary for a city name fragment (best match), including avg PM2.5 and station count.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "City text provided by the user, e.g., 'delhi', 'hanoi', 'paris'.",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    // ---------- Tool impls ----------
    async function run_getTopCities(args = {}) {
      const k =
        Math.max(1, Math.min(20, Number.isFinite(+args.limit) ? +args.limit : 5));
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
      const items = (j.features || []).map((f, i) => {
        const a = f.attributes || {};
        return {
          rank: i + 1,
          city: a.city,
          country: a.country_name,
          avg_pm25: Math.round(a.avg_pm25),
          stations: a.n_stations,
        };
      });
      return { items, note: "Values are µg/m³ (PM2.5), latest hour via OpenAQ." };
    }

    async function run_getCityPM25(args = {}) {
      const q = String(args.query || "").trim();
      if (!q) return { ok: false, message: "Empty query." };
      const where = `LOWER(city) LIKE '%${clean(q.toLowerCase())}%' AND ${SANE_WHERE}`;
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
      if (!a) return { ok: false, message: `No recent PM2.5 for "${q}".` };
      // return a suggested zoom action too
      return {
        ok: true,
        city: a.city,
        country: a.country_name,
        avg_pm25: Math.round(a.avg_pm25),
        stations: a.n_stations,
        action: { type: "zoomTo", city: a.city, country: a.country_name },
      };
    }

    // ---------- Compose conversation ----------
    const system = `
You are "AQI Assistant", an **air-quality (PM2.5/AQI) specialist** embedded in a map dashboard.
Your job: give short, helpful, and factual answers (1–4 sentences) to open-ended AQI questions.
Use the provided tools to fetch **live** data (Esri Living Atlas via OpenAQ) when relevant.

STRICT RULES:
- Only answer AQI/PM2.5/air-quality topics. Politely refuse unrelated topics.
- Do not invent numbers. Prefer calling tools for current readings or rankings.
- If a city name is ambiguous, ask a brief follow-up.
- When the tool returns an action (zoomTo), mention it briefly (the UI may handle the zoom).
- Categories (µg/m³): Good 0–10; Moderate 10–25; USG 25–50; Unhealthy 50–75; Very Unhealthy 75–100; Hazardous 100+.
- Source line: “Source: OpenAQ via Esri Living Atlas (latest hour).”
`.trim();

    const safeHistory = Array.isArray(history)
      ? history
          .slice(-8)
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string"
          )
      : [];

    // First call — let model decide if it wants a tool
    const first = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.6,
        max_tokens: 300,
        tools,
        tool_choice: "auto",
        messages: [
          { role: "system", content: system },
          ...safeHistory,
          { role: "user", content: text },
        ],
      }),
    }).then((r) => r.json());

    let action = null;
    let messages = [
      { role: "system", content: system },
      ...safeHistory,
      { role: "user", content: text },
    ];

    // If the model called a tool, execute it and continue the turn
    const call = first?.choices?.[0]?.message?.tool_calls?.[0];
    if (call) {
      const { name, arguments: argsJson, id } = call.function || call;
      let toolResult = null;

      try {
        const args = argsJson ? JSON.parse(argsJson) : {};
        if (name === "getTopCities") toolResult = await run_getTopCities(args);
        if (name === "getCityPM25") {
          toolResult = await run_getCityPM25(args);
          if (toolResult?.action) action = toolResult.action;
        }
      } catch (e) {
        toolResult = { error: String(e?.message || e) };
      }

      messages.push(first.choices[0].message); // assistant w/ tool call
      messages.push({
        role: "tool",
        tool_call_id: id,
        name,
        content: JSON.stringify(toolResult),
      });

      // Second call: ask the model to craft the natural reply using tool result
      const second = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.6,
          max_tokens: 300,
          messages,
        }),
      }).then((r) => r.json());

      const reply =
        second?.choices?.[0]?.message?.content?.trim() ||
        "I couldn’t produce a response.";
      return json({ reply, action });
    }

    // No tool call — just use the model’s direct answer (still AQI persona)
    const reply =
      first?.choices?.[0]?.message?.content?.trim() ||
      "I’m here for AQI/PM2.5 questions. Try: “Top 5 polluted cities now” or “PM2.5 in Delhi.”";
    return json({ reply, action });
  } catch (err) {
    console.error(err);
    return json(
      { reply: "Sorry — I hit an error while answering. Please try again." },
      200
    );
  }
};

