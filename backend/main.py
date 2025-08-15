# main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import numpy as np
import pandas as pd
import geopandas as gpd
import osmnx as ox
from shapely.geometry import Point
from datetime import datetime, timedelta

# ==== FASTAPI SETUP ====
app = FastAPI()

# Allow CORS for all origins (Netlify frontend can call backend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==== REQUEST MODEL ====
class LocationRequest(BaseModel):
    city: str
    latitude: float
    longitude: float
    start_date: str
    end_date: str

# ==== CORE SIMULATION FUNCTION ====
def run_model_for_location(city, latitude, longitude, start_date, end_date):
    # 1. Fetch polygon for the city
    gdf = ox.geocode_to_gdf(city)
    polygon = gdf.geometry[0]
    area_km2 = gdf.to_crs(epsg=3857).geometry.area.iloc[0] / 1e6

    # 2. Fetch weather data
    url = (
        f"https://archive-api.open-meteo.com/v1/archive?"
        f"latitude={latitude}&longitude={longitude}&start_date={start_date}"
        f"&end_date={end_date}&hourly=temperature_2m,relative_humidity_2m,windspeed_10m"
        f"&timezone=auto"
    )
    r = requests.get(url)
    data = r.json()

    if "hourly" not in data:
        return {"error": "No data from Open-Meteo"}

    df = pd.DataFrame(data["hourly"])
    df["time"] = pd.to_datetime(df["time"])

    # 3. Calculate Absolute Humidity (AH, g/m³)
    T = df["temperature_2m"]
    RH = df["relative_humidity_2m"]
    es = 6.112 * np.exp((17.67 * T) / (T + 243.5))
    e = RH / 100 * es
    AH = (2.1674 * e) / (273.15 + T)
    df["absolute_humidity"] = AH

    # 4. Daily average AH
    daily_ah = df.groupby(df["time"].dt.date)["absolute_humidity"].mean().reset_index()

    # 5. Volume of air in 1 km column
    volume_m3 = area_km2 * 1e6  # m² × height(1000 m)

    # 6. Stock in liters
    daily_ah["vapor_stock_L"] = daily_ah["absolute_humidity"] * volume_m3 / 1000

    return {
        "city": city,
        "area_km2": area_km2,
        "daily_data": daily_ah.to_dict(orient="records")
    }

# ==== API ENDPOINT ====
@app.post("/run-model")
def run_model(req: LocationRequest):
    return run_model_for_location(
        req.city,
        req.latitude,
        req.longitude,
        req.start_date,
        req.end_date
    )
