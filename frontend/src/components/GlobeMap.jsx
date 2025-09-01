import React, { useRef, useEffect, useState } from "react";
import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
} from "recharts";

import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-geocoder/lib/mapbox-gl-geocoder.css";

mapboxgl.accessToken =
  "pk.eyJ1IjoidXJhdnVsYWJzIiwiYSI6ImNtZDJwNGpxdzFnMG0ybHNqZDd6MHFrOGEifQ.I5anlhSNTyzAOJov1tFTyg";

const GlobeMap = () => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const animationRef = useRef(null);
  const rotatingRef = useRef(true);
  const markerRef = useRef(null);
  const bearingRef = useRef(0);
  const modeRef = useRef("globe");
  const resumeTimerRef = useRef(null);

  const highlightFeatureRef = useRef(null);

  const [activeLayer, setActiveLayer] = useState("satellite");
  const [selectedCity, setSelectedCity] = useState(null);
  const [startDate, setStartDate] = useState("2024-12-15");
  const [endDate, setEndDate] = useState("2024-12-20");
  const [interval, setInterval] = useState("daily");
  const [windSpeed, setWindSpeed] = useState(2);
  const [rawResults, setRawResults] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  // === Orbit animation ===
  const animateOrbit = () => {
    if (rotatingRef.current && mapRef.current) {
      bearingRef.current += modeRef.current === "globe" ? 0.05 : 0.2;
      if (modeRef.current === "globe") {
        mapRef.current.jumpTo({
          center: [0, 20],
          zoom: 1.5,
          pitch: 0,
          bearing: bearingRef.current,
        });
      } else {
        const zoom = mapRef.current.getZoom();
        const pitch = mapRef.current.getPitch();
        const center = mapRef.current.getCenter();
        mapRef.current.jumpTo({
          center,
          zoom,
          pitch,
          bearing: bearingRef.current,
        });
      }
    }
    animationRef.current = requestAnimationFrame(animateOrbit);
  };

  const pauseOrbit = () => {
    rotatingRef.current = false;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      rotatingRef.current = true;
    }, 5000);
  };

  // === Init Map ===
  useEffect(() => {
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [0, 20],
      zoom: 1.5,
      projection: "globe",
    });

    mapRef.current.on("load", () => {
      mapRef.current.setFog({});
      animateOrbit();

      // Hide clutter
      const layers = mapRef.current.getStyle().layers;
      layers.forEach((layer) => {
        if (layer.type === "symbol") {
          if (
            layer.id.includes("country-label") ||
            layer.id.includes("state-label") ||
            layer.id.includes("settlement-major-label") ||
            layer.id.includes("settlement-minor-label")
          ) {
            mapRef.current.setLayoutProperty(layer.id, "visibility", "visible");
          } else {
            mapRef.current.setLayoutProperty(layer.id, "visibility", "none");
          }
        }
      });

      mapRef.current.on("style.load", () => {
        if (highlightFeatureRef.current) {
          addHighlightLayer(highlightFeatureRef.current);
        }
      });

      mapRef.current.on("dragstart", pauseOrbit);
      mapRef.current.on("zoomstart", pauseOrbit);

      // ✅ Geocoder restricted to cities and clears after search
      const geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl: mapboxgl,
        marker: false,
        placeholder: "Search city…",
        types: "country,region,place",
      });
      mapRef.current.addControl(geocoder, "top-left");

      geocoder.on("result", async (e) => {
        const coords = e.result.center;
        const placeName = e.result.text;
        setSelectedCity(placeName);
        modeRef.current = "focus";
        rotatingRef.current = false;

        // ✅ Clear search input automatically
        geocoder.clear();

        // Marker
        if (markerRef.current) markerRef.current.remove();
        markerRef.current = new mapboxgl.Marker({ color: "red" })
          .setLngLat(coords)
          .addTo(mapRef.current);

        // ✅ Fetch realistic boundary from backend
        try {
          const resp = await fetch(
            `http://127.0.0.1:5000/boundary?city=${encodeURIComponent(placeName)}`
          );
          const geojson = await resp.json();
          if (geojson && !geojson.error) {
            highlightFeatureRef.current = geojson;
            addHighlightLayer(geojson);
          }
        } catch (err) {
          console.error("Boundary fetch failed:", err);
        }

        // Fly to city
        mapRef.current.flyTo({
          center: coords,
          zoom: 10,
          pitch: 60,
          bearing: 30,
          speed: 0.8,
          curve: 1.5,
          duration: 4000,
        });

        mapRef.current.once("moveend", () => {
          bearingRef.current = 30;
          rotatingRef.current = true;
        });
      });
    });

    return () => {
      cancelAnimationFrame(animationRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      if (mapRef.current) mapRef.current.remove();
    };
  }, []);

  const addHighlightLayer = (feature) => {
    if (!mapRef.current) return;
    if (mapRef.current.getSource("highlight")) {
      if (mapRef.current.getLayer("highlight-fill"))
        mapRef.current.removeLayer("highlight-fill");
      if (mapRef.current.getLayer("highlight-outline"))
        mapRef.current.removeLayer("highlight-outline");
      mapRef.current.removeSource("highlight");
    }
    mapRef.current.addSource("highlight", { type: "geojson", data: feature });
    mapRef.current.addLayer({
      id: "highlight-fill",
      type: "fill",
      source: "highlight",
      paint: { "fill-color": "rgba(255,0,0,0.2)" },
    });
    mapRef.current.addLayer({
      id: "highlight-outline",
      type: "line",
      source: "highlight",
      paint: { "line-color": "red", "line-width": 2 },
    });
  };

  const handleLayerChange = (layer) => {
    if (!mapRef.current) return;
    if (layer === "satellite") {
      mapRef.current.setStyle("mapbox://styles/mapbox/satellite-streets-v12");
    } else if (layer === "streets") {
      mapRef.current.setStyle("mapbox://styles/mapbox/streets-v12");
    }
    setActiveLayer(layer);
  };

  const runSimulation = async () => {
    if (!selectedCity) {
      alert("Please search and select a city first!");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(
        `http://127.0.0.1:5000/flux?city=${encodeURIComponent(
          selectedCity
        )}&start_date=${startDate}&end_date=${endDate}&interval=${interval}&wind=2`
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Backend error");
      setRawResults(data);
    } catch (err) {
      console.error("Backend call failed:", err);
      setRawResults({ error: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!rawResults || rawResults.error) {
      setResults(rawResults);
      return;
    }
    const scaling = windSpeed / 2.0;
    const scaledFlux = rawResults.net_flux_L * scaling;
    const scaledSeries = rawResults.daily_flux_series.map((d) => ({
      date: d.date,
      flux_L: d.flux_L * scaling,
    }));
    setResults({
      ...rawResults,
      net_flux_L: scaledFlux,
      flux_to_demand_ratio: scaledFlux / rawResults.demand_L,
      wind_speed_ms: windSpeed,
      daily_flux_series: scaledSeries,
    });
  }, [rawResults, windSpeed]);

  return (
    <div style={{ position: "relative", height: "100vh", width: "100vw" }}>
      <div ref={mapContainerRef} style={{ height: "100%", width: "100%" }} />

      {/* ✅ Left Panel: Inputs only */}
      <div
        style={{
          position: "absolute",
          bottom: 20,
          left: 20,
          background: "rgba(255,255,255,0.9)",
          padding: "10px",
          borderRadius: "8px",
          width: "300px",
          fontSize: "14px",
        }}
      >
        <h4>🌫 Vapor Flux Simulation</h4>
        <div>
          <label>Interval: </label>
          <select value={interval} onChange={(e) => setInterval(e.target.value)}>
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        <div>
          <label>Start: </label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label>End: </label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>

        <div>
          <label>Wind Speed: {windSpeed} m/s</label>
          <input
            type="range"
            min="0.5"
            max="10"
            step="0.5"
            value={windSpeed}
            onChange={(e) => setWindSpeed(parseFloat(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>

        <button onClick={runSimulation} style={{ marginTop: "6px", width: "100%" }}>
          {loading ? "Running..." : "Run Simulation"}
        </button>
      </div>

      {/* ✅ Right Panel: Results */}
      {results && !results.error && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            right: 20,
            background: "rgba(255,255,255,0.9)",
            padding: "10px",
            borderRadius: "8px",
            width: "380px",
            fontSize: "14px",
            maxHeight: "80vh",
            overflowY: "auto",
          }}
        >
          <h4>📊 Simulation Results</h4>
          <b>City:</b> {results.city} <br />
          <b>Date:</b> {results.start_date} → {results.end_date} <br />
          <b>Interval:</b> {results.interval} <br />
          <b>Area:</b> {results.area_km2} km² <br />
          <b>Mean AH:</b> {results.mean_AH_gm3} g/m³ <br />
          <b>Total Stock:</b> {Number(results.total_stock_L).toExponential(2)} L <br />
          <b>Net Flux:</b> {Number(results.net_flux_L).toExponential(2)} L <br />
          <b>Demand:</b> {Number(results.demand_L).toExponential(2)} L <br />
          <b>Ratio:</b> {(results.flux_to_demand_ratio * 100).toFixed(2)}% <br />
          <b>Wind:</b> {results.wind_speed_ms} m/s

          {/* Bar Chart */}
          <div style={{ height: "200px", marginTop: "10px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  { name: "Net Flux", value: results.net_flux_L, type: "flux" },
                  { name: "Demand", value: results.demand_L, type: "demand" },
                ]}
              >
                <XAxis dataKey="name" />
                <YAxis tickFormatter={(val) => (val / 1e9).toFixed(1) + "B"} />
                <Tooltip formatter={(val) => val.toExponential(2) + " L"} />
                <Bar
                  dataKey="value"
                  shape={(props) => {
                    const { x, y, width, height, payload } = props;
                    let color = "#8884d8";
                    if (payload.type === "flux") {
                      color = results.net_flux_L >= results.demand_L ? "#2ecc71" : "#e74c3c";
                    }
                    return <rect x={x} y={y} width={width} height={height} fill={color} rx={4} />;
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Line Chart */}
          <div style={{ height: "220px", marginTop: "15px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={results.daily_flux_series}>
                <CartesianGrid stroke="#ccc" strokeDasharray="5 5" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(val) => (val / 1e9).toFixed(1) + "B"} />
                <Tooltip formatter={(val) => val.toExponential(2) + " L"} />
                <Legend />
                <Line type="monotone" dataKey="flux_L" stroke="#1f77b4" dot={false} name="Daily Flux" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {results && results.error && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            right: 20,
            background: "rgba(255,200,200,0.9)",
            padding: "10px",
            borderRadius: "8px",
            width: "320px",
          }}
        >
          <b>Error:</b> {results.error}
        </div>
      )}

      {/* Map Layer Toggle */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          background: "rgba(255,255,255,0.8)",
          padding: "6px",
          borderRadius: "6px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        }}
      >
        <button
          onClick={() => handleLayerChange("satellite")}
          style={{
            margin: "2px",
            fontWeight: activeLayer === "satellite" ? "bold" : "normal",
          }}
        >
          Satellite
        </button>
        <button
          onClick={() => handleLayerChange("streets")}
          style={{
            margin: "2px",
            fontWeight: activeLayer === "streets" ? "bold" : "normal",
          }}
        >
          Streets
        </button>
      </div>
    </div>
  );
};

export default GlobeMap;
