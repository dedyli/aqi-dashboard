// functions/get-news-feed.js

// !!! IMPORTANT: REPLACE 'YOUR_NEWSAPI_ORG_KEY' WITH YOUR ACTUAL API KEY !!!
// Sign up for a free key at https://newsapi.org/
const API_KEY = '10159dcb689d44a4b34ad0b466200aff'; 

exports.handler = async (event, context) => {
    if (API_KEY === 'YOUR_NEWSAPI_ORG_KEY' || !API_KEY) {
        console.error("NewsAPI.org API Key is not set.");
        return { statusCode: 500, body: JSON.stringify({ error: "News API key not configured." }) };
    }
    
    // Search for articles with relevant keywords using NewsAPI.org's 'everything' endpoint
    const keywords = ["air quality", "pollution", "wildfire", "smog", "haze", "environmental protection"];
    const query = keywords.join(" OR ");
    // Fetch up to 20 articles from the last week, sorted by relevance
    const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&pageSize=20&sortBy=relevancy&apiKey=${API_KEY}`;

    try {
        const newsResponse = await fetch(newsUrl);
        if (!newsResponse.ok) {
            console.error(`NewsAPI.org API error: ${newsResponse.status} ${newsResponse.statusText}`);
            const errorBody = await newsResponse.json();
            console.error("Error details:", errorBody);
            return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch news from NewsAPI.org." }) };
        }
        
        const newsData = await newsResponse.json();

        if (newsData.status !== 'ok' || !newsData.articles || newsData.articles.length === 0) {
            console.log("No articles found or API error status:", newsData);
            return { statusCode: 200, body: JSON.stringify({ articles: [] }) };
        }

        // Map the articles to the structure expected by the front-end.
        // NewsAPI.org has a very similar structure to what we used before.
        const articles = newsData.articles.map(article => ({
            title: article.title,
            description: article.description,
            url: article.url,
            source_name: article.source.name
        }));
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            // Return the articles in the format the front-end expects
            body: JSON.stringify({ articles: articles })
        };

    } catch (error) {
        console.error("Error fetching news feed:", error);
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to fetch news." }) };
    }
};