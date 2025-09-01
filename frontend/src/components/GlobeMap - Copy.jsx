import React, { useRef, useEffect, useState } from "react";
import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";

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

  const [activeLayer, setActiveLayer] = useState("satellite");

  // 🌍 Orbit animation
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
          center: center,
          zoom: zoom,
          pitch: pitch,
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

  useEffect(() => {
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [0, 20],
      zoom: 1.5,
      projection: "globe",
    });

    mapRef.current.on("load", () => {
      console.log("✅ Globe loaded");
      mapRef.current.setFog({});
      animateOrbit();

      // Add DEM source (for terrain)
      mapRef.current.addSource("mapbox-dem", {
        type: "raster-dem",
        url: "mapbox://mapbox.terrain-rgb",
        tileSize: 512,
        maxzoom: 14,
      });

      // Add 3D buildings (initially off until toggle)
      mapRef.current.addLayer({
        id: "3d-buildings",
        source: "composite",
        "source-layer": "building",
        filter: ["==", "extrude", "true"],
        type: "fill-extrusion",
        minzoom: 15,
        paint: {
          "fill-extrusion-color": "#aaa",
          "fill-extrusion-height": [
            "interpolate",
            ["linear"],
            ["zoom"],
            15,
            0,
            15.05,
            ["get", "height"],
          ],
          "fill-extrusion-base": [
            "interpolate",
            ["linear"],
            ["zoom"],
            15,
            0,
            15.05,
            ["get", "min_height"],
          ],
          "fill-extrusion-opacity": 0.6,
        },
        layout: { visibility: "none" }, // default hidden
      });

      // Pause rotation on user interaction
      mapRef.current.on("dragstart", pauseOrbit);
      mapRef.current.on("zoomstart", pauseOrbit);

      // Geocoder
      const geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl: mapboxgl,
        marker: false,
        placeholder: "Search city/area…",
      });
      mapRef.current.addControl(geocoder, "top-left");

      geocoder.on("result", async (e) => {
        const coords = e.result.center;
        const placeName = e.result.place_name;
        modeRef.current = "focus";
        rotatingRef.current = false;

        if (markerRef.current) markerRef.current.remove();
        markerRef.current = new mapboxgl.Marker({ color: "red" })
          .setLngLat(coords)
          .addTo(mapRef.current);

        if (mapRef.current.getSource("boundary")) {
          mapRef.current.removeLayer("boundary-fill");
          mapRef.current.removeLayer("boundary-outline");
          mapRef.current.removeSource("boundary");
        }

        try {
          const osmUrl = `https://nominatim.openstreetmap.org/search.php?q=${encodeURIComponent(
            placeName
          )}&polygon_geojson=1&format=jsonv2`;

          const response = await fetch(osmUrl);
          const data = await response.json();

          if (data.length > 0 && data[0].geojson) {
            const boundaryGeoJSON = {
              type: "Feature",
              geometry: data[0].geojson,
            };

            mapRef.current.addSource("boundary", {
              type: "geojson",
              data: boundaryGeoJSON,
            });

            mapRef.current.addLayer({
              id: "boundary-fill",
              type: "fill",
              source: "boundary",
              paint: {
                "fill-color": "rgba(255, 0, 0, 0.15)",
                "fill-outline-color": "red",
              },
            });

            mapRef.current.addLayer({
              id: "boundary-outline",
              type: "line",
              source: "boundary",
              paint: {
                "line-color": "red",
                "line-width": 3,
                "line-blur": 1,
              },
            });
          }
        } catch (err) {
          console.error("OSM boundary fetch failed:", err);
        }

        mapRef.current.flyTo({
          center: coords,
          zoom: 15,
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

  // 🔀 Toggle between layers
  const handleLayerChange = (layer) => {
    if (!mapRef.current) return;

    if (layer === "satellite") {
      mapRef.current.setStyle("mapbox://styles/mapbox/satellite-streets-v12");
    } else if (layer === "streets") {
      mapRef.current.setStyle("mapbox://styles/mapbox/streets-v12");
    } else if (layer === "terrain") {
      mapRef.current.setStyle("mapbox://styles/mapbox/outdoors-v12");
    }

    // Wait for style load before toggling 3D buildings
    mapRef.current.once("style.load", () => {
      if (layer === "buildings") {
        mapRef.current.setStyle("mapbox://styles/mapbox/satellite-streets-v12");

        mapRef.current.once("style.load", () => {
          // Re-add DEM + buildings
          mapRef.current.addSource("mapbox-dem", {
            type: "raster-dem",
            url: "mapbox://mapbox.terrain-rgb",
            tileSize: 512,
            maxzoom: 14,
          });
          mapRef.current.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });

          mapRef.current.addLayer({
            id: "3d-buildings",
            source: "composite",
            "source-layer": "building",
            filter: ["==", "extrude", "true"],
            type: "fill-extrusion",
            minzoom: 15,
            paint: {
              "fill-extrusion-color": "#aaa",
              "fill-extrusion-height": [
                "interpolate",
                ["linear"],
                ["zoom"],
                15,
                0,
                15.05,
                ["get", "height"],
              ],
              "fill-extrusion-base": [
                "interpolate",
                ["linear"],
                ["zoom"],
                15,
                0,
                15.05,
                ["get", "min_height"],
              ],
              "fill-extrusion-opacity": 0.6,
            },
          });
        });
      }
    });

    setActiveLayer(layer);
  };

  return (
    <div style={{ position: "relative", height: "100vh", width: "100vw" }}>
      <div
        ref={mapContainerRef}
        style={{ height: "100%", width: "100%" }}
      />
      {/* UI Buttons */}
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
          style={{ margin: "2px", fontWeight: activeLayer === "satellite" ? "bold" : "normal" }}
        >
          🌍 Satellite
        </button>
        <button
          onClick={() => handleLayerChange("streets")}
          style={{ margin: "2px", fontWeight: activeLayer === "streets" ? "bold" : "normal" }}
        >
          🗺 Streets
        </button>
        <button
          onClick={() => handleLayerChange("terrain")}
          style={{ margin: "2px", fontWeight: activeLayer === "terrain" ? "bold" : "normal" }}
        >
          🏔 Terrain
        </button>
        <button
          onClick={() => handleLayerChange("buildings")}
          style={{ margin: "2px", fontWeight: activeLayer === "buildings" ? "bold" : "normal" }}
        >
          🏙 Buildings
        </button>
      </div>
    </div>
  );
};

export default GlobeMap;
