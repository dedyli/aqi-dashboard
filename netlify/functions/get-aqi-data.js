// netlify/functions/get-aqi-data.js

import { getStore } from "@netlify/blobs";

export const handler = async () => {
    // Get the same blob store
    const store = getStore("aqi-data-store");
    
    // Retrieve the cached JSON data
    const aqiData = await store.get("latest-aqi", { type: "json" });

    if (!aqiData) {
        return { statusCode: 500, body: "Could not load AQI data cache. It may not have been generated yet." };
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aqiData),
    };
};