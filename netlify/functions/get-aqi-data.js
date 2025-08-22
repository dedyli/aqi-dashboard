// netlify/functions/get-aqi-data.js

const { createClient } = require("@supabase/supabase-js");

// The Supabase client will automatically use the environment variables from your Netlify settings.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async () => {
    // Retrieve the cached data from the 'cache' table where the 'name' column is 'latest-aqi'.
    const { data, error } = await supabase
      .from('cache')
      .select('data')
      .eq('name', 'latest-aqi')
      .single(); // We use .single() because we only expect one row with this name.

    // If there's an error or no data is found, return an error response.
    if (error || !data) {
        console.error("Error fetching from Supabase:", error);
        return { 
            statusCode: 500, 
            body: "Could not load AQI data from cache. It may not have been generated yet." 
        };
    }

    // If data is found, return it.
    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        // The 'data' field from the Supabase response contains our GeoJSON object.
        body: JSON.stringify(data.data),
    };
};
