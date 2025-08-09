// netlify/functions/AQI-Chat.js
// LLM-first AQI specialist with tool calling (no handcrafted fallbacks)

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Netlify-CDN-Cache-Control": "no-store",
      },
      body: JSON.stringify({ error: "POST only" }),
    };
  }

  // ----- CONFIG -----
  const OPENAI_API_KEY = "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"; // <-- paste your key
  const FS =
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";
  const SANE_WHERE =
    "value BETWEEN 0 AND 500 AND city IS NOT NULL AND unit IN ('µg/m³','ug/m3')";

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

  try {
    const { userMessage = "", history = [] } = JSON.parse(event.body || "{}");
    const text = String(userMessage || "").trim();

    // ----- Tool definitions (for the LLM) -----
    const tools = [
      {
        type: "function",
        function: {
          name: "getTopCities",
          description:
            "Return top N polluted cities worldwide using latest PM2.5 (avg across stations, include only cities with ≥3 stations). Values in µg/m³.",
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
            "Return a live summary for a city name fragment (best match): avg PM2.5 and station count.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "City text provided by the user, e.g. 'delhi', 'hanoi'.",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    // ----- Tool implementations -----
    async function run_getTopCities(args = {}) {
      const k = Math.max(1, Math.min(20, Number.isFinite(+args.limit) ? +args.limit : 5));
      const stats = JSON.stringify([
        { statisticType: "avg", onStatisticField: "value", outStatisticFieldName: "avg_pm25" },
        { statisticType: "count", onStatisticField: "value", outStatisticFieldName: "n_stations" },
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
      return (j.features || []).map((f, i) => {
        const a = f.attributes || {};
        return {
          rank: i + 1,
          city: a.city,
          country: a.country_name,
          avg_pm25: Math.round(a.avg_pm25),
          stations: a.n_stations,
        };
      });
    }

    async function run_getCityPM25(args = {}) {
      const q = String(args.query || "").trim();
      if (!q) return { ok: false, message: "Empty query." };
      const where = `LOWER(city) LIKE '%${clean(q.toLowerCase())}%' AND ${SANE_WHERE}`;
      const stats = JSON.stringify([
        { statisticType: "avg", onStatisticField: "value", outStatisticFieldName: "avg_pm25" },
        { statisticType: "count", onStatisticField: "value", outStatisticFieldName: "n_stations" },
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
      return {
        ok: true,
        city: a.city,
        country: a.country_name,
        avg_pm25: Math.round(a.avg_pm25),
        stations: a.n_stations,
        action: { type: "zoomTo", city: a.city, country: a.country_name },
      };
    }

    // ----- System prompt (persona + constraints). No hard fallbacks here. -----
    const system = `
You are "AQI Assistant", an **air-quality (PM2.5/AQI) specialist** embedded in a map dashboard.
Be concise (1–4 sentences), evidence-based, and current. Use the available tools to fetch live PM2.5 where helpful.
Answer **only** air-quality questions; for unrelated topics, briefly decline.
Categories (µg/m³): Good 0–10; Moderate 10–25; USG 25–50; Unhealthy 50–75; Very Unhealthy 75–100; Hazardous 100+.
Always include brief context when citing live figures, e.g., “Source: OpenAQ via Esri Living Atlas (latest hour)”.
If a zoomTo action is returned in tool data, mention it briefly; the UI may use it.
`.trim();

    // Keep last 8 turns to avoid repetition
    const safeHistory = Array.isArray(history)
      ? history.slice(-8).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : [];

    // 1) Let the model decide whether to call a tool
    const first = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 350,
        tools,
        tool_choice: "auto",
        messages: [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }],
      }),
    }).then(r => r.json());

    // Build conversation for potential second turn
    let messages = [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }];
    let action = null;

    // 2) Execute tool calls returned by the model (support multiple)
    const msg = first?.choices?.[0]?.message;
    if (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      messages.push(msg); // assistant with tool_calls

      for (const call of msg.tool_calls) {
        const name = call.function?.name || call.name;
        const argsJson = call.function?.arguments || call.arguments || "{}";
        let result = null;

        try {
          const args = JSON.parse(argsJson);
          if (name === "getTopCities") result = await run_getTopCities(args);
          if (name === "getCityPM25") {
            result = await run_getCityPM25(args);
            if (result?.action) action = result.action;
          }
        } catch (e) {
          result = { error: String(e?.message || e) };
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: JSON.stringify(result),
        });
      }

      // 3) Ask the model to craft the final natural reply using tool outputs
      const second = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.7,
          max_tokens: 350,
          messages,
        }),
      }).then(r => r.json());

      const reply = second?.choices?.[0]?.message?.content?.trim() ?? "";
      return json({ reply, action });
    }

    // 4) If the model didn’t call tools, return its direct answer (no hardcoded fallback)
    const reply = msg?.content?.trim() ?? "";
    return json({ reply, action });
  } catch (err) {
    console.error(err);
    // Only genuine error message remains.
    return json({ reply: "Sorry — I hit an error while answering. Please try again." }, 200);
  }
};
