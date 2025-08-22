// netlify/functions/get-aqi-data.js

const { getStore } = require("@netlify/blobs");

exports.handler = async () => {
    // Get the blob store we saved to earlier
    const store = getStore("aqi-data-store");
    
    // Retrieve the cached JSON data
    const aqiData = await store.get("latest-aqi", { type: "json" });

    if (!aqiData) {
        return { 
            statusCode: 500, 
            body: "Could not load AQI data cache. It may not have been generated yet. Please trigger the build-aqi-cache function." 
        };
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aqiData),
    };
};