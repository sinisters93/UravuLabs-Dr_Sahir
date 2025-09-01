import React, { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";

// Mapbox token from .env
mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_TOKEN;

const GlobeMap = () => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!mapboxgl.accessToken) {
      console.error("Mapbox token missing. Add it to .env as REACT_APP_MAPBOX_TOKEN");
      return;
    }

    // Initialize map
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12", // Default style
      projection: "globe", // 3D globe
      zoom: 1.5,
      center: [0, 20],
      pitch: 0,
      bearing: 0,
    });

    // Add zoom & rotation controls
    mapRef.current.addControl(new mapboxgl.NavigationControl(), "top-right");

    // Add geocoder search bar
    const geocoder = new MapboxGeocoder({
      accessToken: mapboxgl.accessToken,
      mapboxgl: mapboxgl,
      marker: false,
      placeholder: "Search for a city or area...",
    });

    mapRef.current.addControl(geocoder, "top-left");

    // On location selection → zoom in, add marker, outline boundary
    geocoder.on("result", (e) => {
      const [lng, lat] = e.result.center;

      // Fly to location
      mapRef.current.flyTo({
        center: [lng, lat],
        zoom: 12,
        speed: 1.2,
        curve: 1,
      });

      // Add marker
      new mapboxgl.Marker({ color: "red" })
        .setLngLat([lng, lat])
        .addTo(mapRef.current);
    });

    // Add layer toggle control
    const layerList = document.getElementById("menu");
    const inputs = layerList.getElementsByTagName("input");

    for (const input of inputs) {
      input.onclick = (layer) => {
        const styleId = layer.target.id;
        mapRef.current.setStyle("mapbox://styles/mapbox/" + styleId);
      };
    }

    return () => mapRef.current.remove();
  }, []);

  return (
    <div style={{ height: "100%", width: "100%" }}>
      {/* Layer toggle menu */}
      <div id="menu" style={{
        position: "absolute",
        background: "#fff",
        padding: "10px",
        fontFamily: "sans-serif",
        zIndex: 1
      }}>
        <input id="satellite-streets-v12" type="radio" name="rtoggle" defaultChecked />
        <label htmlFor="satellite-streets-v12">Satellite</label>
        <br />
        <input id="streets-v12" type="radio" name="rtoggle" />
        <label htmlFor="streets-v12">Streets</label>
        <br />
        <input id="outdoors-v12" type="radio" name="rtoggle" />
        <label htmlFor="outdoors-v12">Terrain</label>
      </div>

      {/* Map container */}
      <div ref={mapContainerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
};

export default GlobeMap;
