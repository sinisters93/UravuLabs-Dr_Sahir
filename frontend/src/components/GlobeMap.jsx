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

const BACKEND_URL = "https://uravulabs-dr-sahir.onrender.com";

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

  const highlightDataRef = useRef(null); // 🔴 store highlight geojson

  const [selectedCity, setSelectedCity] = useState(null);
  const [startDate, setStartDate] = useState("2024-12-15");
  const [endDate, setEndDate] = useState("2024-12-20");
  const [interval, setInterval] = useState("daily");

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [activeLayer, setActiveLayer] = useState("satellite");

  // === Orbit animation ===
  const animateOrbit = () => {
    if (rotatingRef.current && mapRef.current) {
      if (modeRef.current === "globe") {
        bearingRef.current += 0.05;
        mapRef.current.jumpTo({
          center: [0, 20],
          zoom: 1.5,
          pitch: 0,
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
      if (modeRef.current === "globe") rotatingRef.current = true;
    }, 5000);
  };

  // === Add red boundary highlight ===
  const addHighlightLayer = (feature) => {
    if (!mapRef.current) return;
    highlightDataRef.current = feature; // save for re-adding later

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

  // === Restore highlight after style change ===
  const restoreHighlight = () => {
    if (!mapRef.current || !highlightDataRef.current) return;
    addHighlightLayer(highlightDataRef.current);
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

      mapRef.current.addSource("mapbox-dem", {
        type: "raster-dem",
        url: "mapbox://mapbox.terrain-rgb",
        tileSize: 512,
        maxzoom: 14,
      });
      mapRef.current.setTerrain({ source: "mapbox-dem", exaggeration: 1.2 });

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

        if (markerRef.current) markerRef.current.remove();
        markerRef.current = new mapboxgl.Marker({ color: "red" })
          .setLngLat(coords)
          .addTo(mapRef.current);

        try {
          const resp = await fetch(
            `${BACKEND_URL}/boundary?city=${encodeURIComponent(placeName)}`
          );
          const geojsonResp = await resp.json();
          if (geojsonResp && geojsonResp.geojson) {
            addHighlightLayer(geojsonResp.geojson);
          }
        } catch (err) {
          console.error("Boundary fetch failed:", err);
        }

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
          rotatingRef.current = true;
        });
      });

      mapRef.current.on("dragstart", pauseOrbit);
      mapRef.current.on("zoomstart", pauseOrbit);
    });

    return () => {
      cancelAnimationFrame(animationRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      if (mapRef.current) mapRef.current.remove();
    };
  }, []);

  // === Run Simulation ===
  const runSimulation = async () => {
    if (!selectedCity) {
      alert("Please search and select a city first!");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(
        `${BACKEND_URL}/flux?city=${encodeURIComponent(
          selectedCity
        )}&start_date=${startDate}&end_date=${endDate}&interval=${interval}`
      );
      const data = await resp.json();
      setResults(data);
    } catch (err) {
      console.error("Backend call failed:", err);
      setResults({ error: err.message });
    } finally {
      setLoading(false);
    }
  };

  // === Reset Globe ===
  const resetGlobe = () => {
    setSelectedCity(null);
    modeRef.current = "globe";
    rotatingRef.current = true;

    mapRef.current.flyTo({
      center: [0, 20],
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
      speed: 0.8,
      curve: 1.5,
      duration: 3000,
    });

    if (markerRef.current) markerRef.current.remove();
    if (mapRef.current.getSource("highlight")) {
      if (mapRef.current.getLayer("highlight-fill"))
        mapRef.current.removeLayer("highlight-fill");
      if (mapRef.current.getLayer("highlight-outline"))
        mapRef.current.removeLayer("highlight-outline");
      mapRef.current.removeSource("highlight");
    }
    highlightDataRef.current = null;
    setResults(null);
  };

  return (
    <div style={{ position: "relative", height: "100vh", width: "100vw" }}>
      <div ref={mapContainerRef} style={{ height: "100%", width: "100%" }} />

      {/* Entry Panel */}
      <div
        style={{
          position: "absolute",
          bottom: 20,
          left: 20,
          background: "rgba(255,255,255,0.9)",
          padding: "12px",
          borderRadius: "8px",
          width: "260px",
          fontSize: "14px",
        }}
      >
        <h4>🌫 Vapor Flux Simulation</h4>
        <div>
          <label>Interval: </label>
          {["daily", "monthly", "yearly"].map((opt) => (
            <button
              key={opt}
              onClick={() => setInterval(opt)}
              style={{
                margin: "5px 5px 0 0",
                background: interval === opt ? "#0b79d0" : "#eee",
                color: interval === opt ? "white" : "black",
                border: "none",
                padding: "5px 10px",
                borderRadius: "4px",
              }}
            >
              {opt}
            </button>
          ))}
        </div>

        {/* Adaptive Inputs */}
        <div>
          <label>Start: </label>
          {interval === "daily" && (
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          )}
          {interval === "monthly" && (
            <input
              type="month"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          )}
          {interval === "yearly" && (
            <input
              type="number"
              min="2000"
              max="2100"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          )}
        </div>

        <div>
          <label>End: </label>
          {interval === "daily" && (
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          )}
          {interval === "monthly" && (
            <input
              type="month"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          )}
          {interval === "yearly" && (
            <input
              type="number"
              min="2000"
              max="2100"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          )}
        </div>

        <button
          onClick={runSimulation}
          style={{
            marginTop: "10px",
            width: "100%",
            background: "#0b79d0",
            color: "white",
            border: "none",
            padding: "8px",
            borderRadius: "5px",
          }}
        >
          {loading ? "Running..." : "Run Simulation"}
        </button>
      </div>

      {/* Results Panel */}
      {results && !results.error && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            right: 20,
            background: "rgba(255,255,255,0.95)",
            padding: "12px",
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
          <b>Wind:</b> {results.wind_speed_ms?.toFixed(2)} m/s
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
                      color =
                        results.net_flux_L >= results.demand_L
                          ? "#2ecc71"
                          : "#e74c3c";
                    }
                    return (
                      <rect
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        fill={color}
                        rx={4}
                      />
                    );
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ height: "220px", marginTop: "15px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={results.flux_series}>
                <CartesianGrid stroke="#ccc" strokeDasharray="5 5" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(val) => {
                    if (results.interval === "daily") return val;
                    if (results.interval === "monthly") return val.slice(0, 7);
                    if (results.interval === "yearly") return val.slice(0, 4);
                    return val;
                  }}
                />
                <YAxis tickFormatter={(val) => (val / 1e9).toFixed(1) + "B"} />
                <Tooltip
                  formatter={(val) => val.toExponential(2) + " L"}
                  labelFormatter={(label) => {
                    if (results.interval === "daily") return label;
                    if (results.interval === "monthly") return label.slice(0, 7);
                    if (results.interval === "yearly") return label.slice(0, 4);
                    return label;
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="flux_L"
                  stroke="#1f77b4"
                  dot={false}
                  name={
                    results.interval === "daily"
                      ? "Daily Flux"
                      : results.interval === "monthly"
                      ? "Monthly Flux"
                      : "Yearly Flux"
                  }
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Error Panel */}
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

      {/* Map Layer Toggle + Reset */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          background: "rgba(255,255,255,0.85)",
          padding: "6px",
          borderRadius: "6px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          display: "flex",
          gap: "4px",
        }}
      >
        <button
          onClick={() => {
            mapRef.current.setStyle(
              "mapbox://styles/mapbox/satellite-streets-v12"
            );
            setActiveLayer("satellite");
            mapRef.current.once("styledata", restoreHighlight);
          }}
          style={{
            margin: "2px",
            fontWeight: activeLayer === "satellite" ? "bold" : "normal",
          }}
        >
          Satellite
        </button>
        <button
          onClick={() => {
            mapRef.current.setStyle("mapbox://styles/mapbox/streets-v12");
            setActiveLayer("streets");
            mapRef.current.once("styledata", restoreHighlight);
          }}
          style={{
            margin: "2px",
            fontWeight: activeLayer === "streets" ? "bold" : "normal",
          }}
        >
          Streets
        </button>
        {selectedCity && (
          <button
            onClick={resetGlobe}
            style={{
              margin: "2px",
              background: "#0b79d0",
              color: "white",
              border: "none",
              padding: "4px 8px",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            🌍 Reset
          </button>
        )}
      </div>
    </div>
  );
};

export default GlobeMap;
