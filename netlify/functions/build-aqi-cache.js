// netlify/functions/build-aqi-cache.js
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");

function readCities() {
  const p = path.join(__dirname, "cities.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function calculateUSAQI(pm25) { /* keep your current implementation */ }

exports.handler = async () => {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("Missing envs", { hasUrl: !!SUPABASE_URL, hasKey: !!SERVICE_KEY });
      return { statusCode: 500, body: "Missing Supabase envs (URL or SERVICE KEY)." };
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const cities = readCities();
    console.log(`Building AQI cache for ${cities.length} cities…`);

    const batchSize = 10;
    const delay = 750;
    const features = [];

    for (let i = 0; i < cities.length; i += batchSize) {
      const batch = cities.slice(i, i + batchSize);
      const idx = Math.floor(i / batchSize) + 1;

      console.log(`Batch ${idx}/${Math.ceil(cities.length / batchSize)}…`);

      const results = await Promise.all(
        batch.map(async (city, k) => {
          try {
            const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&hourly=pm2_5&timezone=auto`;
            const r = await fetch(url);
            if (!r.ok) return null;
            const data = await r.json();

            if (data.hourly?.pm2_5?.length) {
              for (let j = data.hourly.pm2_5.length - 1; j >= 0; j--) {
                const v = data.hourly.pm2_5[j];
                if (v !== null && !Number.isNaN(v)) {
                  return {
                    type: "Feature",
                    geometry: { type: "Point", coordinates: [city.lon, city.lat] },
                    properties: {
                      ObjectID: i + k + 1,
                      city: city.name,
                      pm2_5: Math.round(v * 10) / 10,
                      us_aqi: calculateUSAQI(v),
                      time: data.hourly.time[j],
                    },
                  };
                }
              }
            }
          } catch (e) {
            console.warn(`City failed: ${city.name}`, e.message);
          }
          return null;
        })
      );

      features.push(...results.filter(Boolean));

      // write partial progress so the reader never sees an empty cache
      const partial = {
        type: "FeatureCollection",
        features,
        meta: {
          status: "partial",
          fetched: features.length,
          total: cities.length,
          updated_at: new Date().toISOString(),
        },
      };

      const { error: upErr } = await supabase
        .from("cache")
        .upsert(
          { name: "latest-aqi", data: partial, updated_at: new Date().toISOString() },
          { onConflict: "name" }
        );

      if (upErr) {
        console.error("Partial upsert error:", upErr);
        // Don’t fail the whole run — keep going; next batch might succeed.
      }

      if (i + batchSize < cities.length) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // final write
    const final = {
      type: "FeatureCollection",
      features,
      meta: { status: "complete", fetched: features.length, total: cities.length, updated_at: new Date().toISOString() },
    };

    const { error } = await supabase
      .from("cache")
      .upsert({ name: "latest-aqi", data: final, updated_at: new Date().toISOString() }, { onConflict: "name" });

    if (error) {
      console.error("Final upsert error:", error);
      return { statusCode: 500, body: `Error saving data to Supabase: ${error.message}` };
    }

    console.log(`✅ Done. Saved ${features.length} features.`);
    return { statusCode: 200, body: `Cache updated. Rows: ${features.length}` };
  } catch (e) {
    console.error("Handler crash:", e);
    return { statusCode: 500, body: `Function failed: ${e.message}` };
  }
};
