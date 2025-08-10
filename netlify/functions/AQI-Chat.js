// netlify/functions/AQI-Chat.js
// AQI Assistant — LLM-first chatbot with tools + fuzzy city/station search
// Uses Esri Living Atlas (OpenAQ PM2.5 latest hour) and OpenAI function-calling.
// Secrets are read from Netlify environment variables.

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

  // ── Config (from env) ───────────────────────────────────────────────────────
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;     // set in Netlify UI
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Living Atlas Feature Service (OpenAQ PM2.5, latest hour)
  const FS =
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Air_Quality_PM25_Latest_Results/FeatureServer/0/query";

  // Keep numbers sane; ensure city exists; units µg/m³
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
        "Server configuration error: missing OpenAI API key. Please set OPENAI_API_KEY and redeploy.",
    });
  }

  // ── Small caches to reduce API hits (memory resets when function cold starts)
  const topCitiesCache = globalThis.__aqiTopCache || (globalThis.__aqiTopCache = { ts: 0, key: "", data: null }); // 60s
  const cityCache = globalThis.__aqiCityCache || (globalThis.__aqiCityCache = new Map()); // 30s per key

  // ── Helpers ─────────────────────────────────────────────────────────────────
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

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function callOpenAIWithRetry(body, maxTries = 3) {
    let attempt = 0;
    while (attempt < maxTries) {
      attempt++;
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
        if (attempt >= maxTries) return { ok: false, msg: "OpenAI response parse error." };
        await wait(300 * attempt);
        continue;
      }

      if (r.ok && !out?.error) return { ok: true, data: out };

      const msg = out?.error?.message || `${r.status} ${r.statusText}`;
      const isRate = r.status === 429 || /rate limit/i.test(msg);
      if (isRate && attempt < maxTries) {
        // exponential backoff + jitter
        const backoff = Math.round(700 * 2 ** (attempt - 1) + Math.random() * 200);
        await wait(backoff);
        continue;
      }
      return { ok: false, msg: `OpenAI error: ${msg}` };
    }
    return { ok: false, msg: "OpenAI error: retries exceeded." };
  }

  // ── Fuzzy/alias helpers for city & station names (diacritics, addresses) ────
  const CITY_ALIASES = {
    // Vietnam
    "hanoi": ["hà nội", "ha noi", "hanoi"],
    "ho chi minh": ["hồ chí minh", "ho chi minh", "hcmc", "sài gòn", "saigon"],
    // Common diacritic variants
    "sao paulo": ["são paulo", "sao paulo"],
    "bogota": ["bogotá", "bogota"],
    "mexico city": ["ciudad de méxico", "mexico city"],
    "belem": ["belém", "belem"],
    "montreal": ["montréal", "montreal"],
  };

  const esc = (s) => String(s).toLowerCase().replace(/'/g, "''");

  function buildCityWhere(cands) {
    const parts = [];
    for (const c of cands) {
      const s = esc(c);
      parts.push(`LOWER(city) LIKE '%${s}%'`);
      parts.push(`LOWER(location) LIKE '%${s}%'`);
    }
    return "(" + parts.join(" OR ") + ")";
  }

  try {
    // ── Read request body with small caps (avoid spam/overspend) ──────────────
    const MAX_CHARS = 600;
    const MAX_TURNS = 8;
    const { userMessage = "", history = [] } = JSON.parse(event.body || "{}");

    const text = String(userMessage || "").slice(0, MAX_CHARS).trim();
    const safeHistory = Array.isArray(history)
      ? history
          .slice(-MAX_TURNS)
          .map((m) => ({
            role: m.role,
            content: String(m.content || "").slice(0, MAX_CHARS),
          }))
      : [];

    // ── Tools (declared to the LLM) ───────────────────────────────────────────
    const tools = [
      {
        type: "function",
        function: {
          name: "getTopCities",
          description:
            "Return top N polluted cities worldwide using latest PM2.5 (avg across stations; only cities with ≥3 stations). Values in µg/m³.",
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
            "Return a live summary for a city or station name (best match): avg PM2.5 and station count. Accepts city names, station names, or addresses (tolerant).",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "City/station text e.g., 'Hanoi', 'Số 46, phố Lưu Quang Vũ (Vietnam)'" },
            },
            required: ["query"],
          },
        },
      },
    ];

    // ── Tool implementations ──────────────────────────────────────────────────
    async function run_getTopCities(args = {}) {
      const k = Math.max(1, Math.min(20, Number.isFinite(+args.limit) ? +args.limit : 5));
      const now = Date.now();
      const key = `k=${k}`;
      if (topCitiesCache.data && topCitiesCache.key === key && now - topCitiesCache.ts < 60_000) {
        return topCitiesCache.data;
      }

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

      topCitiesCache.ts = now;
      topCitiesCache.key = key;
      topCitiesCache.data = items;
      return items;
    }

    async function run_getCityPM25(args = {}) {
      const raw = String(args.query || "").trim();
      if (!raw) return { ok: false, message: "Empty query." };

      // Optional country hint like "(Vietnam)" at the end
      const countryHint = (raw.match(/\(([^)]+)\)\s*$/) || [])[1]?.trim() || "";
      const rawNoParen = raw.replace(/\([^)]+\)\s*$/, "").trim();

      // Normalize user input: lowercase + strip diacritics for ASCII baseline
      const ascii = rawNoParen
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, ""); // remove accent marks
      const base = ascii.replace(/\s+/g, " ").trim();

      // Cache by normalized + country
      const cacheKey = `${base}||${countryHint.toLowerCase()}`;
      const hit = cityCache.get(cacheKey);
      const now = Date.now();
      if (hit && now - hit.ts < 30_000) return hit.data;

      // Candidates: aliases if known; otherwise user text + ascii base
      const candidates = CITY_ALIASES[base] || [rawNoParen, base];

      const stats = JSON.stringify([
        { statisticType: "avg", onStatisticField: "value", outStatisticFieldName: "avg_pm25" },
        { statisticType: "count", onStatisticField: "value", outStatisticFieldName: "n_stations" },
      ]);

      // A) City/alias search against city & location (fast path)
      const whereCity = buildCityWhere(candidates);
      const whereA =
        `${whereCity}` +
        (countryHint ? ` AND LOWER(country_name) LIKE '%${esc(countryHint)}%'` : "") +
        ` AND ${SANE_WHERE}`;

      let j = await postFS({
        where: whereA,
        outFields: "city,country_name,location",
        outStatistics: stats,
        groupByFieldsForStatistics: "city,country_name",
        orderByFields: "avg_pm25 DESC",
        resultRecordCount: "1",
        returnGeometry: "true",
        f: "json",
      });

      if (j.features?.length) {
        const a = j.features[0].attributes;
        const res = {
          ok: true,
          city: a.city || a.location,
          country: a.country_name,
          avg_pm25: Math.round(a.avg_pm25),
          stations: a.n_stations,
          action: { type: "zoomTo", city: a.city || a.location, country: a.country_name },
        };
        cityCache.set(cacheKey, { ts: now, data: res });
        return res;
      }

      // B) Fuzzy station/location search (tolerant to punctuation/accents)
      // Keep only a–z0–9, then insert % between chars to create a loose LIKE pattern
      const loose = ascii.replace(/[^a-z0-9]+/g, ""); // e.g., "so46pholuuquangvu"
      const fuzzy = loose.split("").join("%");        // e.g., "s%o%4%6%p%h%o%l%u%u%q%u%a%n%g%v%u"
      if (fuzzy.length >= 3) {
        const whereB =
          `(LOWER(location) LIKE '%${fuzzy}%')` +
          (countryHint ? ` AND LOWER(country_name) LIKE '%${esc(countryHint)}%'` : "") +
          ` AND ${SANE_WHERE}`;

        j = await postFS({
          where: whereB,
          outFields: "city,country_name,location",
          outStatistics: stats,
          groupByFieldsForStatistics: "city,country_name",
          orderByFields: "avg_pm25 DESC",
          resultRecordCount: "1",
          returnGeometry: "true",
          f: "json",
        });

        if (j.features?.length) {
          const a = j.features[0].attributes;
          const res = {
            ok: true,
            city: a.city || a.location,
            country: a.country_name,
            avg_pm25: Math.round(a.avg_pm25),
            stations: a.n_stations,
            action: { type: "zoomTo", city: a.city || a.location, country: a.country_name },
          };
          cityCache.set(cacheKey, { ts: now, data: res });
          return res;
        }
      }

      // C) Still nothing
      const res = { ok: false, message: `No recent PM2.5 for "${raw}".` };
      cityCache.set(cacheKey, { ts: now, data: res });
      return res;
    }

    // ── System persona (AQI-only; the model decides when to use tools) ────────
    const system = `
You are "AQI Assistant", an air-quality (PM2.5/AQI) specialist embedded in a map dashboard.
Answer ONLY air-quality questions. Be concise (1–4 sentences), factual, and avoid made-up numbers.
Use the available tools to fetch live PM2.5 when helpful.
Include: "Source: OpenAQ via Esri Living Atlas (latest hour)" when citing live values.
If a tool returns a 'zoomTo' action, mention it briefly; the UI may handle it.
    `.trim();

    // ── First call: let the model decide to call a tool ───────────────────────
    const first = await callOpenAIWithRetry({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 350,
      tools,
      tool_choice: "auto",
      messages: [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }],
    });
    if (!first.ok) {
      console.error(first.msg);
      return json({ reply: "The AI is busy right now. Please try again in a moment." });
    }

    let messages = [{ role: "system", content: system }, ...safeHistory, { role: "user", content: text }];
    let action = null;
    const msg = first.data?.choices?.[0]?.message;

    // ── Execute tool calls (supports multiple) ────────────────────────────────
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

      // ── Second call: finalize response using tool outputs ───────────────────
      const second = await callOpenAIWithRetry({
        model: OPENAI_MODEL,
        temperature: 0.7,
        max_tokens: 350,
        messages,
      });
      if (!second.ok) {
        console.error(second.msg);
        return json({ reply: "The AI is busy right now. Please try again in a moment." });
      }

      const reply2 = second.data?.choices?.[0]?.message?.content?.trim() || "";
      return json({ reply: reply2 || "OpenAI returned no content.", action });
    }

    // ── No tool call: return model's direct answer ────────────────────────────
    const reply = msg?.content?.trim() || "";
    return json({ reply: reply || "OpenAI returned no content.", action });
  } catch (err) {
    console.error("Handler error:", err);
    return json({ reply: "Server error while answering. Please try again." }, 200);
  }
};
