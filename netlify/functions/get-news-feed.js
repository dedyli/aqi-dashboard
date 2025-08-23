// functions/get-news-feed.js

// !!! IMPORTANT: REPLACE 'YOUR_GNEWS_API_KEY' WITH YOUR ACTUAL API KEY !!!
// Note: A placeholder key is used here for demonstration.
const API_KEY = 'eb6e1360b30c6a7f876690a5ef785d0f';

exports.handler = async (event, context) => {
    if (API_KEY === 'YOUR_GNEWS_API_KEY' || !API_KEY) {
        console.error("GNews API Key is not set.");
        return { statusCode: 500, body: JSON.stringify({ error: "News API key not configured." }) };
    }
    
    // Search for articles with relevant keywords
    const keywords = ["air quality", "pollution", "wildfire", "smog", "haze", "environmental protection"];
    const query = keywords.join(" OR ");
    // Fetch up to 20 articles
    const newsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=20&token=${API_KEY}`;

    try {
        const newsResponse = await fetch(newsUrl);
        if (!newsResponse.ok) {
            console.error(`GNews API error: ${newsResponse.status} ${newsResponse.statusText}`);
            const errorBody = await newsResponse.json();
            console.error("Error details:", errorBody);
            return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch news from GNews API." }) };
        }
        
        const newsData = await newsResponse.json();

        if (!newsData.articles || newsData.articles.length === 0) {
            // If no articles are found, return an empty array.
            return { statusCode: 200, body: JSON.stringify({ articles: [] }) };
        }

        // Directly map the articles to a simpler structure without geocoding.
        // The front-end now expects a simple array of articles.
        const articles = newsData.articles.map(article => ({
            title: article.title,
            description: article.description,
            url: article.url,
            source_name: article.source.name
        }));
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            // Return the articles directly
            body: JSON.stringify({ articles: articles })
        };

    } catch (error) {
        console.error("Error fetching news feed:", error);
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch news." }) };
    }
};