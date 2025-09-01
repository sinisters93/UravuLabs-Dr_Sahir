from flask import Flask, request, jsonify
import requests
import pandas as pd
import numpy as np
import osmnx as ox
import traceback
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # allow frontend (React) to fetch from Flask

# === AH CALCULATION HELPERS ===
def saturation_vp(T):
    """Saturation vapor pressure (hPa) using Tetens formula."""
    return 6.112 * np.exp((17.67 * T) / (T + 243.5))

def calc_AH(T, RH):
    """Absolute humidity (g/m³)."""
    Es = saturation_vp(T)  # hPa
    RH_frac = RH / 100.0    # convert % → fraction
    return (Es * 100 * RH_frac * 2.1674) / (273.15 + T)


@app.route("/flux", methods=["GET"])
def flux_endpoint():
    try:
        city = request.args.get("city", "Bangalore")
        start_date = request.args.get("start_date", "2024-12-15")
        end_date = request.args.get("end_date", "2024-12-20")
        interval = request.args.get("interval", "daily").lower()
        wind_speed = float(request.args.get("wind", 2.0))  # m/s

        print(">> Incoming params:", dict(request.args))

        demand_values = {"daily": 1.44e9, "monthly": 43.2e9, "yearly": 525.6e9}
        if interval not in demand_values:
            return jsonify({"error": "Invalid interval. Use daily, monthly, or yearly."}), 400
        demand_val = demand_values[interval]

        boundary = ox.geocode_to_gdf(city).to_crs("EPSG:4326")
        area_km2 = boundary.to_crs("EPSG:3857").geometry.area.iloc[0] / 1e6

        centroid_geom = (
            boundary.to_crs(epsg=3857).geometry.centroid.to_crs(epsg=4326).iloc[0]
        )
        latitude, longitude = centroid_geom.y, centroid_geom.x

        volume_m3 = area_km2 * 1e6 * 1000

        url = (
            f"https://archive-api.open-meteo.com/v1/archive?"
            f"latitude={latitude}&longitude={longitude}"
            f"&start_date={start_date}&end_date={end_date}"
            f"&hourly=temperature_2m,relative_humidity_2m"
            f"&timezone=auto"
        )
        resp = requests.get(url)
        if resp.status_code != 200:
            return jsonify({"error": "Weather API fetch failed"}), 500
        data = resp.json().get("hourly", {})

        df = pd.DataFrame(data)
        T = np.array(df["temperature_2m"])
        RH = np.array(df["relative_humidity_2m"])
        if len(T) == 0:
            return jsonify({"error": "No weather data available"}), 500

        AH = calc_AH(T, RH)
        mean_AH = np.mean(AH)  # g/m³
        total_stock_L = mean_AH * volume_m3 / 1000

        transport_efficiency = 0.08
        scaling = wind_speed / 2.0
        daily_flux_L = total_stock_L * transport_efficiency * scaling

        if interval == "daily":
            net_flux_L = daily_flux_L
        else:
            days = pd.date_range(start=start_date, end=end_date, freq="D")
            net_flux_L = daily_flux_L * len(days)

        dates = pd.to_datetime(df["time"])
        AH_series = calc_AH(T, RH)
        daily_data = pd.DataFrame({"date": dates, "AH": AH_series})
        daily_mean = daily_data.resample("D", on="date").mean()
        daily_flux_series = (
            daily_mean["AH"].values * volume_m3 / 1000 * transport_efficiency
        )

        ratio = net_flux_L / demand_val if demand_val > 0 else 0

        result = {
            "city": city,
            "interval": interval,
            "start_date": start_date,
            "end_date": end_date,
            "area_km2": round(float(area_km2), 2),
            "mean_AH_gm3": round(float(mean_AH), 2),
            "total_stock_L": round(float(total_stock_L), 2),
            "net_flux_L": round(float(net_flux_L), 2),
            "demand_L": float(demand_val),
            "flux_to_demand_ratio": round(float(ratio), 3),
            "wind_speed_ms": float(wind_speed),
            "daily_flux_series": [
                {"date": str(d.date()), "flux_L": float(v)}
                for d, v in zip(daily_mean.index, daily_flux_series)
            ],
        }

        return jsonify(result)

    except Exception as e:
        print(">> ERROR in /flux:", str(e))
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# === NEW: Boundary endpoint ===
@app.route("/boundary", methods=["GET"])
def boundary_endpoint():
    city = request.args.get("city", "Bangalore")
    try:
        boundary = ox.geocode_to_gdf(city).to_crs("EPSG:4326")
        return jsonify(boundary.__geo_interface__)  # return as GeoJSON
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print(app.url_map)
    app.run(debug=True)
