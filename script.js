document.addEventListener('DOMContentLoaded', function() {
    require([
        "esri/Map",
        "esri/views/MapView",
        "esri/layers/GeoJSONLayer",
        "esri/widgets/Legend"
    ], function(Map, MapView, GeoJSONLayer, Legend) {

        // --- Helper: OpenAQ to ESRI GeoJSON endpoint (serverless CORS proxy not needed for this public endpoint) ---
        const openaqGeoJsonUrl = "https://api.openaq.org/v2/measurements?limit=1000&order_by=datetime&sort=desc&parameter=pm25&format=geojson";

        // --- ArcGIS Map and View Setup ---
        const map = new Map({
            basemap: "satellite"
        });

        const view = new MapView({
            container: "viewDiv",
            map: map,
            center: [0, 20],
            zoom: 3,
            popup: {
                dockEnabled: true,
                dockOptions: {
                    buttonEnabled: false,
                    breakpoint: false
                }
            }
        });

        // --- Create the GeoJSONLayer for PM2.5 AQI ---
        const pm25Layer = new GeoJSONLayer({
            url: openaqGeoJsonUrl,
            title: "PM2.5 Air Quality (OpenAQ)",
            copyright: "OpenAQ",
            popupTemplate: {
                title: "{city}, {country}",
                content: `
                    <b>PM2.5:</b> {value} {unit}<br>
                    <b>Source:</b> {sourceName}<br>
                    <b>Date:</b> {date.local}
                `
            },
            renderer: {
                type: "class-breaks",
                field: "value",
                classBreakInfos: [
                    {
                        minValue: 0, maxValue: 10,
                        symbol: { type: "simple-marker", color: "#00e400", size: 8, outline: { width: 1, color: "white" } },
                        label: "Good (0-10 µg/m³)"
                    },
                    {
                        minValue: 10.1, maxValue: 25,
                        symbol: { type: "simple-marker", color: "#ffff00", size: 10, outline: { width: 1, color: "white" } },
                        label: "Moderate (10-25 µg/m³)"
                    },
                    {
                        minValue: 25.1, maxValue: 50,
                        symbol: { type: "simple-marker", color: "#ff7e00", size: 12, outline: { width: 1, color: "white" } },
                        label: "Unhealthy for Sensitive (25-50 µg/m³)"
                    },
                    {
                        minValue: 50.1, maxValue: 75,
                        symbol: { type: "simple-marker", color: "#ff0000", size: 14, outline: { width: 1, color: "white" } },
                        label: "Unhealthy (50-75 µg/m³)"
                    },
                    {
                        minValue: 75.1, maxValue: 100,
                        symbol: { type: "simple-marker", color: "#8f3f97", size: 16, outline: { width: 1, color: "white" } },
                        label: "Very Unhealthy (75-100 µg/m³)"
                    },
                    {
                        minValue: 100.1, maxValue: 999,
                        symbol: { type: "simple-marker", color: "#7e0023", size: 18, outline: { width: 1, color: "white" } },
                        label: "Hazardous (100+ µg/m³)"
                    }
                ]
            }
        });

        map.add(pm25Layer);

        // --- Add the Legend only after view and layer are loaded ---
        view.whenLayerView(pm25Layer).then(() => {
            const legend = new Legend({
                view: view,
                layerInfos: [{
                    layer: pm25Layer,
                    title: "PM2.5 Air Quality (µg/m³)"
                }]
            });
            view.ui.add(legend, "bottom-left");
            document.getElementById('loading').style.display = 'none';
        }).catch(error => {
            console.error("LayerView failed to load: ", error);
            document.getElementById('loading').innerHTML = 'Error loading map/layer.';
        });

        // --- UI Interactions (unchanged) ---
        function togglePanel(panelId, viewClass) {
            const panel = document.getElementById(panelId);
            const viewDiv = document.getElementById('viewDiv');
            const isOpen = panel.classList.toggle('open');
            viewDiv.classList.toggle(viewClass, isOpen);
            setTimeout(() => view.resize(), 300);
        }
        
        document.getElementById('hamburgerBtn').addEventListener('click', () => togglePanel('sidebar', 'sidebar-open'));
        document.getElementById('settingsBtn').addEventListener('click', () => togglePanel('settingsPanel', 'settings-open'));

        document.querySelectorAll('.basemap-option').forEach(option => {
            option.addEventListener('click', function() {
                map.basemap = this.dataset.basemap;
                document.querySelectorAll('.basemap-option').forEach(opt => opt.classList.remove('active'));
                this.classList.add('active');
            });
        });
        
        function performSearch() {
            const query = document.getElementById('searchInput').value.toLowerCase().trim();
            if (!query) return;

            const cities = {
                'beijing': [116.4074, 39.9042], 'delhi': [77.2090, 28.6139],
                'new york': [-74.0059, 40.7128], 'london': [-0.1278, 51.5074],
                'tokyo': [139.6503, 35.6762], 'mumbai': [72.8777, 19.0760],
                'lahore': [74.3587, 31.5204], 'dhaka': [90.4125, 23.8103]
            };

            const coords = cities[query];
            if (coords) {
                view.goTo({ center: coords, zoom: 10 }, { duration: 1500 });
            } else {
                alert('City not found. Try: Beijing, Delhi, New York, etc.');
            }
        }

        document.getElementById('searchBtn').addEventListener('click', performSearch);
        document.getElementById('searchInput').addEventListener('keypress', e => {
            if (e.key === 'Enter') performSearch();
        });
    });
});
