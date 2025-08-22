// functions/get-news-feed.js

// !!! IMPORTANT: REPLACE 'YOUR_GNEWS_API_KEY' WITH YOUR ACTUAL API KEY !!!
const API_KEY = 'eb6e1360b30c6a7f876690a5ef785d0f';

exports.handler = async (event, context) => {
    if (API_KEY === 'YOUR_GNEWS_API_KEY') {
        console.error("GNews API Key is not set.");
        return { statusCode: 500, body: JSON.stringify({ error: "News API key not configured." }) };
    }
    
    // Search for articles with relevant keywords
    const keywords = ["air quality", "pollution", "wildfire", "smog", "haze"];
    const query = keywords.join(" OR ");
    const newsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=10&token=${API_KEY}`;

    try {
        const newsResponse = await fetch(newsUrl);
        const newsData = await newsResponse.json();

        if (!newsData.articles || newsData.articles.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ type: "FeatureCollection", features: [] }) };
        }

        let features = [];
        
        // Find a location for each article
        for (const article of newsData.articles) {
            // Use the article title to search for a location
            const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(article.title)}&count=1`;
            const geoResponse = await fetch(geocodeUrl);
            const geoData = await geoResponse.json();

            if (geoData.results && geoData.results.length > 0) {
                const location = geoData.results[0];
                features.push({
                    type: "Feature",
                    geometry: {
                        type: "Point",
                        coordinates: [location.longitude, location.latitude]
                    },
                    properties: {
                        title: article.title,
                        description: article.description,
                        url: article.url,
                        source_name: article.source.name
                    }
                });
            }
        }
        
        const geojsonObject = {
            type: "FeatureCollection",
            features: features
        };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geojsonObject)
        };

    } catch (error) {
        console.error("Error fetching news feed:", error);
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch news." }) };
    }
};