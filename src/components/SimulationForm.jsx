import React, { useState } from "react";

const SimulationForm = () => {
  const [message, setMessage] = useState("");
  const [zipLink, setZipLink] = useState("");

  const runSimulation = async (e) => {
    e.preventDefault();
    setMessage("⏳ Running simulation...");
    setZipLink("");

    const payload = {
      latitude: document.getElementById("latitude").value,
      longitude: document.getElementById("longitude").value,
      start_date: document.getElementById("start_date").value,
      end_date: document.getElementById("end_date").value,
      scenario: document.getElementById("scenario").value,
      required_lpd: document.getElementById("required_lpd").value,
      available_area: document.getElementById("available_area").value,
      use_manual: document.getElementById("use_manual").value === "true",
    };

    try {
      const res = await fetch("http://127.0.0.1:5000/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      setMessage("✅ Simulation completed!");
      setZipLink(`http://127.0.0.1:5000/download/${data.zip_name}`);
    } catch (err) {
      console.error(err);
      setMessage("❌ Error during simulation.");
    }
  };

  return (
    <form onSubmit={runSimulation}>
      <label>Latitude:</label>
      <input type="text" id="latitude" defaultValue="28.6139" required />

      <label>Longitude:</label>
      <input type="text" id="longitude" defaultValue="77.2090" required />

      <label>Start Date:</label>
      <input type="date" id="start_date" defaultValue="2024-12-15" required />

      <label>End Date:</label>
      <input type="date" id="end_date" defaultValue="2025-01-15" required />

      <label>Scenario:</label>
      <select id="scenario" defaultValue="A">
        <option value="A">A (2000 LPD, stacked)</option>
        <option value="B">B (30000 LPD, unstacked)</option>
      </select>

      <label>Required LPD:</label>
      <input type="number" id="required_lpd" defaultValue="50000" required />

      <label>Available Area (m²):</label>
      <input type="number" id="available_area" defaultValue="300" required />

      <label>Manual Placement?</label>
      <select id="use_manual" defaultValue="false">
        <option value="false">No</option>
        <option value="true">Yes</option>
      </select>

      <button type="submit" style={{ marginTop: "10px" }}>Run Simulation</button>

      {message && <p style={{ marginTop: "10px" }}>{message}</p>}
      {zipLink && (
        <a href={zipLink} target="_blank" rel="noopener noreferrer">
          ⬇ Download ZIP
        </a>
      )}
    </form>
  );
};

export default SimulationForm;
