// functions/get-aqi-data.js

// Helper function to calculate US AQI from PM2.5
function calculateUSAQI(pm25) {
    if (pm25 === null || isNaN(pm25) || pm25 < 0) return null;

    const breakpoints = [
        { low: 0.0, high: 12.0, aqiLow: 0, aqiHigh: 50 },
        { low: 12.1, high: 35.4, aqiLow: 51, aqiHigh: 100 },
        { low: 35.5, high: 55.4, aqiLow: 101, aqiHigh: 150 },
        { low: 55.5, high: 150.4, aqiLow: 151, aqiHigh: 200 },
        { low: 150.5, high: 250.4, aqiLow: 201, aqiHigh: 300 },
        { low: 250.5, high: 500.4, aqiLow: 301, aqiHigh: 500 },
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
    // UPDATED: Array now contains 120 of the most populous cities for reliability
    const cities = [
        { name: "Tokyo", lat: 35.6895, lon: 139.6917 }, { name: "Delhi", lat: 28.6139, lon: 77.2090 },
        { name: "Shanghai", lat: 31.2304, lon: 121.4737 }, { name: "São Paulo", lat: -23.5505, lon: -46.6333 },
        { name: "Mumbai", lat: 19.0760, lon: 72.8777 }, { name: "Mexico City", lat: 19.4326, lon: -99.1332 },
        { name: "Beijing", lat: 39.9042, lon: 116.4074 }, { name: "Osaka", lat: 34.6937, lon: 135.5023 },
        { name: "Cairo", lat: 30.0444, lon: 31.2357 }, { name: "New York", lat: 40.7128, lon: -74.0060 },
        { name: "Dhaka", lat: 23.8103, lon: 90.4125 }, { name: "Karachi", lat: 24.8607, lon: 67.0011 },
        { name: "Buenos Aires", lat: -34.6037, lon: -58.3816 }, { name: "Kolkata", lat: 22.5726, lon: 88.3639 },
        { name: "Istanbul", lat: 41.0082, lon: 28.9784 }, { name: "Chongqing", lat: 29.5630, lon: 106.5516 },
        { name: "Lagos", lat: 6.5244, lon: 3.3792 }, { name: "Manila", lat: 14.5995, lon: 120.9842 },
        { name: "Rio de Janeiro", lat: -22.9068, lon: -43.1729 }, { name: "Tianjin", lat: 39.3434, lon: 117.3616 },
        { name: "Kinshasa", lat: -4.4419, lon: 15.2663 }, { name: "Guangzhou", lat: 23.1291, lon: 113.2644 },
        { name: "Los Angeles", lat: 34.0522, lon: -118.2437 }, { name: "Moscow", lat: 55.7558, lon: 37.6173 },
        { name: "Shenzhen", lat: 22.5431, lon: 114.0579 }, { name: "Lahore", lat: 31.5820, lon: 74.3294 },
        { name: "Bangalore", lat: 12.9716, lon: 77.5946 }, { name: "Paris", lat: 48.8566, lon: 2.3522 },
        { name: "Bogotá", lat: 4.7110, lon: -74.0721 }, { name: "Jakarta", lat: -6.2088, lon: 106.8456 },
        { name: "Chennai", lat: 13.0827, lon: 80.2707 }, { name: "Lima", lat: -12.0464, lon: -77.0428 },
        { name: "Bangkok", lat: 13.7563, lon: 100.5018 }, { name: "Seoul", lat: 37.5665, lon: 126.9780 },
        { name: "Nagoya", lat: 35.1815, lon: 136.9066 }, { name: "Hyderabad", lat: 17.3850, lon: 78.4867 },
        { name: "London", lat: 51.5074, lon: -0.1278 }, { name: "Tehran", lat: 35.6892, lon: 51.3890 },
        { name: "Chicago", lat: 41.8781, lon: -87.6298 }, { name: "Chengdu", lat: 30.5728, lon: 104.0668 },
        { name: "Nanjing", lat: 32.0603, lon: 118.7969 }, { name: "Wuhan", lat: 30.5928, lon: 114.3055 },
        { name: "Ho Chi Minh City", lat: 10.8231, lon: 106.6297 }, { name: "Luanda", lat: -8.8368, lon: 13.2343 },
        { name: "Ahmedabad", lat: 23.0225, lon: 72.5714 }, { name: "Kuala Lumpur", lat: 3.1390, lon: 101.6869 },
        { name: "Xi'an", lat: 34.3416, lon: 108.9398 }, { name: "Hong Kong", lat: 22.3193, lon: 114.1694 },
        { name: "Dongguan", lat: 23.0462, lon: 113.7463 }, { name: "Hangzhou", lat: 30.2741, lon: 120.1551 },
        { name:. "Foshan", lat: 23.0215, lon: 113.1214 }, { name: "Shenyang", lat: 41.8057, lon: 123.4315 },
        { name: "Riyadh", lat: 24.7136, lon: 46.6753 }, { name: "Baghdad", lat: 33.3152, lon: 44.3661 },
        { name: "Santiago", lat: -33.4489, lon: -70.6693 }, { name: "Surat", lat: 21.1702, lon: 72.8311 },
        { name: "Madrid", lat: 40.4168, lon: -3.7038 }, { name: "Suzhou", lat: 31.2990, lon: 120.5853 },
        { name: "Pune", lat: 18.5204, lon: 73.8567 }, { name: "Harbin", lat: 45.8038, lon: 126.5350 },
        { name: "Houston", lat: 29.7604, lon: -95.3698 }, { name: "Dallas", lat: 32.7767, lon: -96.7970 },
        { name: "Toronto", lat: 43.6532, lon: -79.3832 }, { name: "Dar es Salaam", lat: -6.7924, lon: 39.2083 },
        { name: "Miami", lat: 25.7617, lon: -80.1918 }, { name: "Belo Horizonte", lat: -19.9167, lon: -43.9345 },
        { name: "Singapore", lat: 1.3521, lon: 103.8198 }, { name: "Philadelphia", lat: 39.9526, lon: -75.1652 },
        { name: "Atlanta", lat: 33.7490, lon: -84.3880 }, { name: "Fukuoka", lat: 33.5904, lon: 130.4017 },
        { name: "Khartoum", lat: 15.5007, lon: 32.5599 }, { name: "Barcelona", lat: 41.3851, lon: 2.1734 },
        { name: "Johannesburg", lat: -26.2041, lon: 28.0473 }, { name: "Saint Petersburg", lat: 59.9311, lon: 30.3609 },
        { name: "Qingdao", lat: 36.0671, lon: 120.3826 }, { name: "Dalian", lat: 38.9140, lon: 121.6147 },
        { name: "Washington, D.C.", lat: 38.9072, lon: -77.0369 }, { name: "Yangon", lat: 16.8409, lon: 96.1735 },
        { name: "Alexandria", lat: 31.2001, lon: 29.9187 }, { name: "Jinan", lat: 36.6683, lon: 116.9972 },
        { name: "Guadalajara", lat: 20.6597, lon: -103.3496 }, { name: "Ankara", lat: 39.9334, lon: 32.8600 },
        { name: "Abidjan", lat: 5.3599, lon: -4.0083 }, { name: "Melbourne", lat: -37.8136, lon: 144.9631 },
        { name: "Sydney", lat: -33.8688, lon: 151.2093 }, { name: "Monterrey", lat: 25.6866, lon: -100.3161 },
        { name: "Busan", lat: 35.1796, lon: 129.0756 }, { name: "Cape Town", lat: -33.9249, lon: 18.4241 },
        { name: "Brasília", lat: -15.7942, lon: -47.8825 }, { name: "Medellín", lat: 6.2476, lon: -75.5658 },
        { name: "Zhengzhou", lat: 34.7466, lon: 113.6254 }, { name: "Recife", lat: -8.0476, lon: -34.8770 },
        { name: "Yaoundé", lat: 3.8480, lon: 11.5021 }, { name: "Kunming", lat: 25.0422, lon: 102.7183 },
        { name: "Jaipur", lat: 26.9124, lon: 80.9462 }, { name: "Porto Alegre", lat: -30.0346, lon: -51.2177 },
        { name: "Fortaleza", lat: -3.7319, lon: -38.5267 }, { name: "Salvador", lat: -12.9777, lon: -38.5016 },
        { name: "Rome", lat: 41.9028, lon: 12.4964 }, { name: "Phoenix", lat: 33.4484, lon: -112.0740 },
        { name: "Detroit", lat: 42.3314, lon: -83.0458 }, { name: "Montréal", lat: 45.5017, lon: -73.5673 },
        { name: "Casablanca", lat: 33.5731, lon: -7.5898 }, { name: "Pyongyang", lat: 39.0392, lon: 125.7625 },
        { name: "Dubai", lat: 25.2048, lon: 55.2708 }, { name: "Kabul", lat: 34.5281, lon: 69.1723 }
    ];
    
    let cityResults = [];

    await Promise.all(
        cities.map(async (city, index) => {
            try {
                const apiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&hourly=pm2_5&timezone=auto`;
                const response = await fetch(apiUrl);
                if (!response.ok) return;

                const data = await response.json();
                if (data.hourly && data.hourly.pm2_5 && data.hourly.time) {
                    const times = data.hourly.time;
                    const pm25Values = data.hourly.pm2_5;
                    
                    let currentPM25 = null;
                    let currentTime = null;
                    
                    for (let i = pm25Values.length - 1; i >= 0; i--) {
                        if (pm25Values[i] !== null && !isNaN(pm25Values[i])) {
                            currentPM25 = pm25Values[i];
                            currentTime = times[i];
                            break;
                        }
                    }

                    if (currentPM25 !== null) {
                        cityResults.push({
                            type: "Feature",
                            geometry: { type: "Point", coordinates: [city.lon, city.lat] },
                            properties: {
                                ObjectID: index + 1,
                                city: city.name,
                                pm2_5: Math.round(currentPM25 * 10) / 10,
                                us_aqi: calculateUSAQI(currentPM25),
                                time: currentTime,
                            },
                        });
                    }
                }
            } catch (error) {
                console.warn(`Failed to fetch data for ${city.name}:`, error.message);
            }
        })
    );
    
    const geojsonObject = {
        type: "FeatureCollection",
        features: cityResults,
    };

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(jsonObject),
    };
};