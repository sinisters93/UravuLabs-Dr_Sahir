import React, { useRef, useEffect, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import * as THREE from "three";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, LineChart, Line,
  CartesianGrid, Legend,
} from "recharts";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-geocoder/lib/mapbox-gl-geocoder.css";

/** ==== CONFIG ==== */
const BACKEND_URL = "https://uravulabs-dr-sahir.onrender.com";
mapboxgl.accessToken =
  "pk.eyJ1IjoidXJhdnVsYWJzIiwiYSI6ImNtZDJwNGpxdzFnMG0ybHNqZDd6MHFrOGEifQ.I5anlhSNTyzAOJov1tFTyg";

const whenStyleReady = (map, fn) => {
  if (!map) return;
  if (map.isStyleLoaded()) fn();
  else map.once("style.load", fn);
};

const GlobeMap = () => {
  const mapContainerRef = useRef(null);
  const canvasRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const highlightDataRef = useRef(null);

  const animationRef = useRef(null);
  const rotatingRef = useRef(true);
  const bearingRef = useRef(0);
  const modeRef = useRef("globe");

  const [selectedCity, setSelectedCity] = useState(null);
  const [startDate, setStartDate] = useState("2024-12-15");
  const [endDate, setEndDate] = useState("2024-12-20");
  const [interval, setInterval] = useState("daily");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [activeBase, setActiveBase] = useState("satellite");
  const [show3D, setShow3D] = useState(false);

  const particleArray = useRef([]);
  const flowFrameRef = useRef(0);
  const windSeriesRef = useRef([]);

  const threeLayerId = "flux-3d-particles";
  const threeStateRef = useRef({
    scene: null, camera: null, renderer: null, points: null,
    positions: null, speeds: null, headingRad: 0, num: 0,
  });

  /** Orbit animation */
  const animateOrbit = useCallback(() => {
    if (rotatingRef.current && mapRef.current && modeRef.current === "globe") {
      bearingRef.current += 0.05;
      mapRef.current.jumpTo({ center: [0, 20], zoom: 1.5, bearing: bearingRef.current });
    }
    animationRef.current = requestAnimationFrame(animateOrbit);
  }, []);

  /** Terrain and 3D buildings */
  const ensureTerrain = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    whenStyleReady(map, () => {
      if (!map.getSource("mapbox-dem")) {
        map.addSource("mapbox-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
      }
      map.setTerrain({ source: "mapbox-dem", exaggeration: 1.2 });
    });
  }, []);

  const add3DBuildings = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    whenStyleReady(map, () => {
      if (map.getLayer("3d-buildings") || !map.getSource("composite")) return;
      map.addLayer({
        id: "3d-buildings",
        source: "composite",
        "source-layer": "building",
        filter: ["==", "extrude", "true"],
        type: "fill-extrusion",
        minzoom: 15,
        paint: {
          "fill-extrusion-color": "#bbb",
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["get", "min_height"],
          "fill-extrusion-opacity": 0.6,
        },
      }, "waterway-label");
    });
  }, []);

  /** Boundary highlight */
  const addHighlightLayer = useCallback((geojson) => {
    const map = mapRef.current;
    if (!map || !geojson) return;
    whenStyleReady(map, () => {
      ["highlight-fill", "highlight-outline"].forEach(id => map.getLayer(id) && map.removeLayer(id));
      map.getSource("highlight") && map.removeSource("highlight");
      map.addSource("highlight", { type: "geojson", data: geojson });
      map.addLayer({ id: "highlight-fill", type: "fill", source: "highlight", paint: { "fill-color": "rgba(255,0,0,0.12)" } });
      map.addLayer({ id: "highlight-outline", type: "line", source: "highlight", paint: { "line-color": "#ff0000", "line-width": 2, "line-blur": 0.2 } });
    });
  }, []);

  const fetchAndDrawBoundary = useCallback(async (name) => {
    try {
      const resp = await fetch(`${BACKEND_URL}/boundary?city=${encodeURIComponent(name)}`);
      const data = await resp.json();
      if (data?.geojson) {
        highlightDataRef.current = data.geojson;
        addHighlightLayer(data.geojson);
      }
    } catch (e) {
      console.error("Boundary fetch failed:", e);
    }
  }, [addHighlightLayer]);

  const restoreHighlight = useCallback(() => {
    if (highlightDataRef.current) addHighlightLayer(highlightDataRef.current);
  }, [addHighlightLayer]);

  /** 2D arrows */
  const init2DArrows = useCallback(() => {
    const map = mapRef.current, canvas = canvasRef.current;
    if (!map || !canvas) return;
    const ctx = canvas.getContext("2d");
    const resizeCanvas = () => {
      const rect = mapContainerRef.current.getBoundingClientRect();
      canvas.width = rect.width; canvas.height = rect.height;
    };
    resizeCanvas();

    const bounds = map.getBounds();
    const N = 200;
    particleArray.current = Array.from({ length: N }, () => ({
      lon: bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest()),
      lat: bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth()),
      age: Math.random() * 200,
    }));

    const draw = () => {
      if (show3D) { ctx.clearRect(0, 0, canvas.width, canvas.height); requestAnimationFrame(draw); return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const frames = windSeriesRef.current;
      if (!frames?.length) { requestAnimationFrame(draw); return; }
      const frame = frames[flowFrameRef.current % frames.length];
      const heading = ((frame.direction_deg + 180) % 360) * (Math.PI / 180);
      const speed = frame.speed_ms || 0;
      const baseLen = Math.min(18, speed * 0.5);
      const driftStep = 0.0015 + Math.min(0.004, speed * 0.0003);

      particleArray.current.forEach((p) => {
        const pos = map.project([p.lon, p.lat]);
        const dx = baseLen * Math.sin(heading);
        const dy = baseLen * Math.cos(heading);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        ctx.lineTo(pos.x + dx, pos.y - dy);
        ctx.strokeStyle = "rgba(0,80,220,0.28)";
        ctx.lineWidth = 0.9;
        ctx.stroke();
        p.lon += driftStep * Math.sin(heading);
        p.lat += driftStep * Math.cos(heading);
        if (++p.age > 300) {
          const b = map.getBounds();
          p.lon = b.getWest() + Math.random() * (b.getEast() - b.getWest());
          p.lat = b.getSouth() + Math.random() * (b.getNorth() - b.getSouth());
          p.age = 0;
        }
      });
      flowFrameRef.current = (flowFrameRef.current + 1) % frames.length;
      requestAnimationFrame(draw);
    };
    draw();
  }, [show3D]);

  /** 3D Layer */
  const add3DLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map || map.getLayer("flux-3d-particles")) return;
    const S = threeStateRef.current;
    S.scene = new THREE.Scene(); S.camera = new THREE.Camera();
    const geometry = new THREE.BufferGeometry();
    const bounds = map.getBounds();
    const num = 1800;
    const positions = new Float32Array(num * 3);
    for (let i = 0; i < num; i++) {
      const lon = bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest());
      const lat = bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth());
      const alt = (map.queryTerrainElevation([lon, lat]) || 0) + 40 + Math.random() * 80;
      const m = mapboxgl.MercatorCoordinate.fromLngLat([lon, lat], alt);
      positions.set([m.x, m.y, m.z], i * 3);
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: 0x0b79d0, size: 6, transparent: true, opacity: 0.25 });
    const points = new THREE.Points(geometry, material);
    S.scene.add(points);
    S.points = points;
    S.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: map.painter.context.gl, alpha: true });
    S.renderer.autoClear = false;
    const customLayer = {
      id: "flux-3d-particles", type: "custom", renderingMode: "3d",
      render(gl, matrix) {
        const m = new THREE.Matrix4().fromArray(matrix);
        S.camera.projectionMatrix = m;
        S.renderer.state.reset();
        S.renderer.render(S.scene, S.camera);
        map.triggerRepaint();
      },
    };
    map.addLayer(customLayer, "waterway-label");
  }, []);

  const remove3DLayer = useCallback(() => {
    const map = mapRef.current;
    if (map.getLayer("flux-3d-particles")) map.removeLayer("flux-3d-particles");
  }, []);

  /** Map init */
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [0, 20],
      zoom: 1.5,
      projection: "globe",
    });
    mapRef.current = map;
    map.on("load", () => {
      map.setFog({});
      ensureTerrain();
      add3DBuildings();

      const geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken, mapboxgl, marker: false, placeholder: "Search city…", types: "place",
      });
      map.addControl(geocoder, "top-left");
      geocoder.on("result", async (e) => {
        const coords = e.result.center;
        const name = e.result.text;
        setSelectedCity(name);
        rotatingRef.current = false;
        if (markerRef.current) markerRef.current.remove();
        markerRef.current = new mapboxgl.Marker({ color: "red" }).setLngLat(coords).addTo(map);
        await fetchAndDrawBoundary(name);
        map.flyTo({ center: coords, zoom: 11, pitch: 60, bearing: 30, duration: 2800 });
      });

      map.on("style.load", () => { ensureTerrain(); add3DBuildings(); restoreHighlight(); });
      animateOrbit();
    });
  }, [ensureTerrain, add3DBuildings, fetchAndDrawBoundary, restoreHighlight, animateOrbit]);

  /** Simulation */
  const runSimulation = async () => {
    if (!selectedCity) return alert("Search a city first");
    setLoading(true);
    try {
      const url = `${BACKEND_URL}/flux?city=${encodeURIComponent(selectedCity)}&start_date=${startDate}&end_date=${endDate}&interval=${interval}`;
      const resp = await fetch(url);
      const data = await resp.json();
      setResults(data);
      windSeriesRef.current = data.wind_series || [];
      show3D ? (remove3DLayer(), add3DLayer()) : init2DArrows();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  /** Reset globe */
  const resetGlobe = () => {
    const map = mapRef.current;
    map.flyTo({ center: [0, 20], zoom: 1.5, pitch: 0, bearing: 0, duration: 2500 });
    if (markerRef.current) markerRef.current.remove();
    ["highlight-fill", "highlight-outline"].forEach(id => map.getLayer(id) && map.removeLayer(id));
    map.getSource("highlight") && map.removeSource("highlight");
    setResults(null);
    setSelectedCity(null);
    remove3DLayer();
  };

  /** Toggle 3D */
  const toggle3D = () => {
    const map = mapRef.current;
    const next = !show3D;
    setShow3D(next);
    if (next) {
      map.setProjection("mercator");
      let center = [77.5946, 12.9716];
      if (selectedCity && markerRef.current) {
        const m = markerRef.current.getLngLat();
        center = [m.lng, m.lat];
      }
      map.flyTo({ center, zoom: 12, pitch: 60, bearing: 30, duration: 1500 });
      remove3DLayer();
      add3DLayer();
    } else {
      remove3DLayer();
      map.setProjection("globe");
      init2DArrows();
      map.flyTo({ pitch: 0, bearing: 0, duration: 1000 });
    }
  };

  return (
    <div style={{ height: "100vh", width: "100vw", position: "relative" }}>
      <div ref={mapContainerRef} style={{ height: "100%", width: "100%" }} />
      <canvas ref={canvasRef} style={{
        position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2,
        opacity: show3D ? 0 : 1, transition: "opacity 0.3s ease",
      }} />

      {/* 🧭 Top-right Panel */}
      <div style={{
        position: "absolute", top: 10, right: 10, background: "rgba(255,255,255,0.92)",
        padding: 8, borderRadius: 6, boxShadow: "0 1px 4px rgba(0,0,0,0.3)", zIndex: 5,
      }}>
        <button onClick={() => {
          setActiveBase("satellite");
          mapRef.current.setStyle("mapbox://styles/mapbox/satellite-streets-v12");
        }} style={{
          fontWeight: activeBase === "satellite" ? "bold" : "normal", marginRight: 6, cursor: "pointer",
        }}>Satellite</button>
        <button onClick={() => {
          setActiveBase("streets");
          mapRef.current.setStyle("mapbox://styles/mapbox/streets-v12");
        }} style={{
          fontWeight: activeBase === "streets" ? "bold" : "normal", marginRight: 6, cursor: "pointer",
        }}>Streets</button>
        {selectedCity && (
          <button onClick={resetGlobe} style={{
            background: "#0b79d0", color: "white", border: "none",
            padding: "4px 8px", borderRadius: 4, cursor: "pointer",
          }}>🌍 Reset</button>
        )}
      </div>

      {/* 🧮 Bottom-left Control Panel */}
      <div style={{
        position: "absolute", bottom: 20, left: 20,
        background: "rgba(255,255,255,0.95)", padding: 12,
        borderRadius: 8, width: 300, zIndex: 5,
      }}>
        <h4>🌫 Vapor Flux Simulation</h4>
        <div>
          <label>Interval: </label>
          {["daily", "monthly", "yearly"].map(opt => (
            <button key={opt} onClick={() => setInterval(opt)} style={{
              margin: "4px 5px 0 0",
              background: interval === opt ? "#0b79d0" : "#eee",
              color: interval === opt ? "white" : "black",
              border: "none", padding: "5px 10px", borderRadius: 4, cursor: "pointer",
            }}>{opt}</button>
          ))}
        </div>
        <div style={{ marginTop: 6 }}>
          <label>Start: </label>
          <input type={interval === "yearly" ? "number" : interval === "monthly" ? "month" : "date"} value={startDate} onChange={e => setStartDate(e.target.value)} />
        </div>
        <div style={{ marginTop: 6 }}>
          <label>End: </label>
          <input type={interval === "yearly" ? "number" : interval === "monthly" ? "month" : "date"} value={endDate} onChange={e => setEndDate(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={runSimulation} style={{
            flex: 1, background: "#0b79d0", color: "white", border: "none",
            padding: 8, borderRadius: 4, cursor: "pointer",
          }}>{loading ? "Running..." : "Run Simulation"}</button>
          <button onClick={toggle3D} style={{
            width: 110, background: show3D ? "#6c5ce7" : "#2ecc71",
            color: "white", border: "none", padding: 8, borderRadius: 4, cursor: "pointer",
          }}>{show3D ? "2D Mode" : "3D Mode"}</button>
        </div>
      </div>

      {/* 📊 Right Results Panel */}
      {results && !results.error && (
        <div style={{
          position: "absolute", bottom: 20, right: 20,
          background: "rgba(255,255,255,0.95)", padding: 12,
          borderRadius: 8, width: 420, maxHeight: "80vh",
          overflowY: "auto", zIndex: 5,
        }}>
          <h4>📊 Simulation Results</h4>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            <b>{results.city}</b> ({results.interval}) <br />
            {results.start_date} → {results.end_date}
          </div>
          <div>Area: {results.area_km2} km²</div>
          <div>Mean AH: {results.mean_AH_gm3} g/m³</div>
          <div>Total Stock: {Number(results.total_stock_L).toExponential(2)} L</div>
          <div>Net Flux: {Number(results.net_flux_L).toExponential(2)} L</div>
          <div>Demand: {Number(results.demand_L).toExponential(2)} L</div>
          <div>Ratio: {(results.flux_to_demand_ratio * 100).toFixed(2)}%</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span>Wind: {results.wind_speed_ms?.toFixed(2)} m/s</span>
            {results.wind_arrow_svg && (
              <img src={results.wind_arrow_svg} alt="wind direction" style={{ width: 28, height: 28 }} />
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={[{ name: "Flux", value: results.net_flux_L }, { name: "Demand", value: results.demand_L }]}>
                <XAxis dataKey="name" />
                <YAxis tickFormatter={v => (v / 1e9).toFixed(1) + "B"} />
                <Tooltip formatter={v => v.toExponential(2) + " L"} />
                <Bar dataKey="value" fill="#0b79d0" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ marginTop: 20 }}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={results.flux_series}>
                <CartesianGrid stroke="#ccc" strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis tickFormatter={v => (v / 1e9).toFixed(1) + "B"} />
                <Tooltip formatter={v => v.toExponential(2) + " L"} />
                <Legend />
                <Line type="monotone" dataKey="flux_L" stroke="#2ecc71" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
};

export default GlobeMap;
