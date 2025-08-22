// netlify/functions/build-aqi-cache.js

const { createClient } = require("@supabase/supabase-js");
const cities = require("./cities.json"); // Load the city data from the new JSON file

/**
 * Calculates the US AQI from a given PM2.5 value.
 * @param {number} pm25 - The PM2.5 concentration.
 * @returns {number|null} The calculated AQI value or null if input is invalid.
 */
function calculateUSAQI(pm25) {
    if (pm25 === null || isNaN(pm25) || pm25 < 0) return null;
    const breakpoints = [
        { low: 0.0, high: 12.0, aqiLow: 0, aqiHigh: 50 }, { low: 12.1, high: 35.4, aqiLow: 51, aqiHigh: 100 },
        { low: 35.5, high: 55.4, aqiLow: 101, aqiHigh: 150 }, { low: 55.5, high: 150.4, aqiLow: 151, aqiHigh: 200 },
        { low: 150.5, high: 250.4, aqiLow: 201, aqiHigh: 300 }, { low: 250.5, high: 500.4, aqiLow: 301, aqiHigh: 500 },
    ];
    for (const bp of breakpoints) {
        if (pm25 >= bp.low && pm25 <= bp.high) {
            return Math.round(((bp.aqiHigh - bp.aqiLow) / (bp.high - bp.low)) * (pm25 - bp.low) + bp.aqiLow);
        }
    }
    if (pm25 > 500.4) return 500;
    return null;
}

exports.handler = async (event, context) => {
    try {
        console.log("Function starting...");

        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
            const errorMessage = "Missing Supabase environment variables.";
            console.error(errorMessage);
            return { statusCode: 500, body: errorMessage };
        }
        
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        console.log("Supabase client initialized.");

        console.log("Starting to build AQI data cache for Supabase.");
        
        let cityResults = [];
        const batchSize = 10;
        const delay = 1000;

        for (let i = 0; i < cities.length; i += batchSize) {
            const batch = cities.slice(i, i + batchSize);
            console.log(`Fetching batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(cities.length / batchSize)}...`);
            
            const promises = batch.map(async (city, index) => {
                try {
                    const apiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&hourly=pm2_5&timezone=auto`;
                    const response = await fetch(apiUrl);
                    if (!response.ok) return null;
                    const data = await response.json();

                    if (data.hourly && data.hourly.pm2_5) {
                        let currentPM25 = null, currentTime = null;
                        for (let j = data.hourly.pm2_5.length - 1; j >= 0; j--) {
                            if (data.hourly.pm2_5[j] !== null && !isNaN(data.hourly.pm2_5[j])) {
                                currentPM25 = data.hourly.pm2_5[j];
                                currentTime = data.hourly.time[j];
                                break;
                            }
                        }
                        if (currentPM25 !== null) {
                            return {
                                type: "Feature",
                                geometry: { type: "Point", coordinates: [city.lon, city.lat] },
                                properties: { 
                                    ObjectID: i + index + 1,
                                    city: city.name,
                                    pm2_5: Math.round(currentPM25 * 10) / 10,
                                    us_aqi: calculateUSAQI(currentPM25),
                                    time: currentTime 
                                },
                            };
                        }
                    }
                } catch (error) {
                    console.warn(`Failed for ${city.name}:`, error.message);
                }
                return null;
            });

            const batchResults = await Promise.all(promises);
            cityResults.push(...batchResults.filter(Boolean));
            
            if (i + batchSize < cities.length) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        const geojsonObject = { type: "FeatureCollection", features: cityResults };
        
        console.log("Attempting to save data to Supabase...");
        const { error } = await supabase
          .from('cache')
          .upsert({ name: 'latest-aqi', data: geojsonObject });

        if (error) {
            console.error("Error saving to Supabase:", error);
            return { statusCode: 500, body: `Error saving data to Supabase: ${error.message}` };
        }

        console.log(`✅ AQI data cache successfully built and saved to Supabase.`);
        return { statusCode: 200, body: `Cache updated and saved to Supabase.` };

    } catch (e) {
        console.error("A critical error occurred in the handler:", e);
        return {
            statusCode: 500,
            body: `Function handler failed with error: ${e.message}`
        };
    }
};