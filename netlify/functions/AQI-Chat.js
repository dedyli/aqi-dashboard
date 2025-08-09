// netlify/functions/AQI-Chat.js
// LLM-first AQI specialist with tool calling (OpenAQ via Esri Living Atlas)
// Reads secrets from Netlify env vars (no keys in code).

exports.handler = async (event) => {
  // POST only
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

  // -------- CONFIG (from environment) --------
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;          // set in Netlify UI
  const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const NODE_ENV_NAME  = process.env.NODE_VERSION || "18";

  // ArcGIS Feature Service (Esri Living Atlas → OpenAQ PM2.5 latest hour)
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

  if (!OPENAI_API_KEY || !OPENAI_API_KEY.startsWith("sk-")) {
    console.error("Missing/invalid OPENAI_API_KEY env var.");
    return json({
      reply:
        "Server configuration error: missing OpenAI API key. Please set OPENAI_API_KEY in Netlify → Site settings → Environment variables and redeploy.",
    });
  }

  // -------- helpers --------
  const postFS = async (params) => {
    const res = await fetch(FS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`ArcGIS FS ${res.status} ${res.statusText}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "ArcGIS FS error");
    return j;
  };
  const clean = (s = "") => String(s).replace(/'/g, "''");

  try {
    const { userMessage = "", history = [] } = JSON.parse(event.body || "{}");
    const text = String(userMessage || "").trim();

    // ---- Tools exposed to the LLM ----
    const tools = [
      {
        type: "function",
        function: {
          name: "getTopCities",
          description:
            "Return top N polluted cities worldwide using latest PM2.5 (avg across stations; include only cities with ≥3 stations). Values in µg/m³.",
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
                description: "City text, e.g., 'delhi', 'hanoi', 'paris'.",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    // ---- Tool implementations ----
    async function run_getTopCities(args = {}) {
      const k = Math.max(
        1,
        Math.min(20, Number.isFinite(+args.limit) ? +args.limit : 5)
      );
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

    // ---- System persona (AQI-only; LLM decides everything else) ----
    const system = `
You are "AQI Assistant", an air-quality (PM2.5/AQI) specialist in a map dashboard.
Answer ONLY air-quality topics. Use the tools for live PM2.5 data when useful.
Be concise (1–4 sentences), factual, and avoid made-up numbers.
Include: “Source: OpenAQ via Esri Living Atlas (latest hour)” when citing live values.
If a tool returns a 'zoomTo' action, mention it briefly; the UI may handle it.
    `.trim();

    // keep last 8 turns
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

    // ---- OpenAI helper with explicit error surface ----
    async function callOpenAI(body) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      let out;
      try {
        out = await r.json();
      } catch (e) {
        console.error("OpenAI parse error:", e);
        return { ok: false, msg: "OpenAI response parse error." };
      }
      if (!r.ok || out?.error) {
        const msg = out?.error?.message || `${r.status} ${r.statusText}`;
        console.error("OpenAI error:", msg);
        return { ok: false, msg: `OpenAI error: ${msg}` };
      }
      return { ok: true, data: out };
    }

    // 1) Let the model decide whether to call a tool
    const first = await callOpenAI({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 350,
      tools: [
        { type: "function", function: { name: "getTopCities", parameters: { type: "object", properties: { limit: { type: "integer" } } }, description: "Return top N polluted cities using latest PM2.5." } },
        { type: "function", function: { name: "getCityPM25", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, description: "Return live PM2.5 summary for a city (best match)." } }
      ],
      tool_choice: "auto",
      messages: [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }],
    });
    if (!first.ok) return json({ reply: first.msg });

    let messages = [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }];
    let action = null;
    const msg = first.data?.choices?.[0]?.message;

    // 2) Execute tool calls (support many)
    if (msg?.tool_calls?.length) {
      messages.push(msg); // assistant with tool_calls
      for (const call of msg.tool_calls) {
        const name = call.function?.name || call.name;
        const argsJson = call.function?.arguments || call.arguments || "{}";
        let result;
        try {
          const args = JSON.parse(argsJson);
          if (name === "getTopCities") result = await run_getTopCities(args);
          else if (name === "getCityPM25") {
            result = await run_getCityPM25(args);
            if (result?.action) action = result.action;
          } else result = { error: `Unknown tool: ${name}` };
        } catch (e) {
          result = { error: `Tool exec error: ${String(e?.message || e)}` };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: JSON.stringify(result),
        });
      }

      // 3) Finalize natural reply using tool outputs
      const second = await callOpenAI({
        model: OPENAI_MODEL,
        temperature: 0.7,
        max_tokens: 350,
        messages,
      });
      if (!second.ok) return json({ reply: second.msg });
      const reply2 = second.data?.choices?.[0]?.message?.content?.trim() || "";
      return json({ reply: reply2 || "OpenAI returned no content.", action });
    }

    // 4) No tool calls → direct answer
    const reply = msg?.content?.trim() || "";
    return json({ reply: reply || "OpenAI returned no content.", action });
  } catch (err) {
    console.error("Handler error:", err);
    return json({ reply: "Server error while answering. Please try again." }, 200);
  }
};
