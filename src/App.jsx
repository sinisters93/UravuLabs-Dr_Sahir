import React from "react";
import GlobeMap from "./components/GlobeMap";
import SimulationForm from "./components/SimulationForm";

export default function App() {
  return (
    <div style={{ height: "100vh", width: "100vw", position: "relative" }}>
      <GlobeMap />
      <div style={{
        position: "absolute",
        top: 20,
        left: 20,
        background: "white",
        padding: "20px",
        borderRadius: "10px",
        width: "300px",
        zIndex: 2,
        boxShadow: "0 0 10px rgba(0,0,0,0.3)"
      }}>
        <h3>Uravu Simulation</h3>
        <SimulationForm />
      </div>
    </div>
  );
}
