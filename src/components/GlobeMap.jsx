import React, { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const GlobeMap = () => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    // Initialize map
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      projection: "globe",
      center: [77.2090, 28.6139], // default Delhi
      zoom: 1.5,
    });

    mapRef.current.on("style.load", () => {
      mapRef.current.setFog({});
    });

    // Add geocoder (search bar)
    const geocoder = new MapboxGeocoder({
      accessToken: mapboxgl.accessToken,
      mapboxgl: mapboxgl,
      marker: false,
    });

    mapRef.current.addControl(geocoder);

    // Update form on result
    geocoder.on("result", (e) => {
      const [lng, lat] = e.result.center;
      document.getElementById("latitude").value = lat.toFixed(4);
      document.getElementById("longitude").value = lng.toFixed(4);
      mapRef.current.flyTo({ center: [lng, lat], zoom: 10 });
    });

    return () => mapRef.current?.remove();
  }, []);

  return <div ref={mapContainerRef} style={{ height: "100vh", width: "100vw" }} />;
};

export default GlobeMap;

