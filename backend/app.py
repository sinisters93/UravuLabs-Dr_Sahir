from flask import Flask, request, jsonify
import requests
import pandas as pd
import numpy as np
import osmnx as ox
import traceback
import calendar
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ========= Reference baseline (Bangalore) =========
REF_CITY = "Bangalore"
REF_POP = 12000000         # 12 million
REF_DAILY_DEMAND = 1.44e9  # liters/day baseline
REF_MONTHLY_DEMAND = REF_DAILY_DEMAND * 30
REF_YEARLY_DEMAND = REF_DAILY_DEMAND * 365
REF_AREA_KM2 = 740.0       # approx. Bangalore metro area
REF_DENSITY = REF_POP / REF_AREA_KM2  # ~16,200 people/km²

# ========= Helpers =========
def saturation_vp(T):
    """Saturation vapor pressure (hPa) using Tetens formula."""
    return 6.112 * np.exp((17.67 * T) / (T + 243.5))

def calc_AH(T, RH):
    """Absolute humidity (g/m³)."""
    Es = saturation_vp(T)  # hPa
    RH_frac = RH / 100.0
    return (Es * 100 * RH_frac * 2.1674) / (273.15 + T)

def expand_dates_for_interval(start_date, end_date, interval):
    """Normalize monthly/yearly to YYYY-MM-DD for Open-Meteo."""
    if interval == "monthly":
        if len(start_date) == 7:  # YYYY-MM
            start_date = f"{start_date}-01"
        if len(end_date) == 7:
            y, m = map(int, end_date.split("-"))
            last_day = calendar.monthrange(y, m)[1]
            end_date = f"{end_date}-{last_day}"
    elif interval == "yearly":
        if len(start_date) == 4:  # YYYY
            start_date = f"{start_date}-01-01"
        if len(end_date) == 4:
            end_date = f"{end_date}-12-31"
    return start_date, end_date

def infer_country_from_boundary(gdf):
    try:
        disp = str(gdf.iloc[0].get("display_name", ""))
        parts = [p.strip() for p in disp.split(",") if p.strip()]
        return parts[-1] if parts else None
    except Exception:
        return None

def fetch_population_wikidata(city_name):
    """
    Fetch population using Wikidata SPARQL.
    Returns (population:int or None, source:str).
    """
    try:
        endpoint = "https://query.wikidata.org/sparql"
        query = f"""
        SELECT ?city ?cityLabel ?population WHERE {{
          ?city wdt:P1082 ?population.
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
          FILTER(CONTAINS(LCASE(?cityLabel), LCASE("{city_name}")))
        }}
        ORDER BY DESC(?population)
        LIMIT 1
        """
        resp = requests.get(endpoint, params={"query": query, "format": "json"}, timeout=15)
        if resp.status_code != 200:
            return None, "sparql_fetch_failed"
        j = resp.json()
        binds = j.get("results", {}).get("bindings", [])
        if not binds:
            return None, "sparql_no_binding"
        pop_str = binds[0].get("population", {}).get("value")
        if not pop_str:
            return None, "sparql_population_missing"
        pop = int(float(pop_str))
        return pop, "wikidata_sparql"
    except Exception as e:
        print("Population fetch error:", e)
        return None, "sparql_exception"

def demand_from_reference(population, interval):
    """
    Scale demand linearly with population relative to Bangalore reference.
    """
    if population is None or population <= 0:
        return None
    factor = population / REF_POP
    if interval == "daily":
        return REF_DAILY_DEMAND * factor
    if interval == "monthly":
        return REF_MONTHLY_DEMAND * factor
    if interval == "yearly":
        return REF_YEARLY_DEMAND * factor
    return REF_DAILY_DEMAND * factor

# ========= Flux analytics endpoint =========
@app.route("/flux", methods=["GET"])
def flux_endpoint():
    try:
        city = request.args.get("city", "Bangalore")
        start_date = request.args.get("start_date", "2024-12-15")
        end_date = request.args.get("end_date", "2024-12-20")
        interval = request.args.get("interval", "daily").lower()

        # Expand monthly/yearly
        start_date, end_date = expand_dates_for_interval(start_date, end_date, interval)

        # ---- Boundary / Area ----
        try:
            boundary = ox.geocode_to_gdf(city).to_crs("EPSG:4326")
            approx_boundary = False
        except Exception:
            boundary = ox.geocode_to_gdf("India").to_crs("EPSG:4326")
            approx_boundary = True

        area_km2 = boundary.to_crs("EPSG:3857").geometry.area.iloc[0] / 1e6
        centroid_geom = (
            boundary.to_crs(epsg=3857).geometry.centroid.to_crs(epsg=4326).iloc[0]
        )
        latitude, longitude = centroid_geom.y, centroid_geom.x
        country_inferred = infer_country_from_boundary(boundary)

        # ---- Population & Demand ----
        pop_val, pop_source = fetch_population_wikidata(city)

        if pop_val is None:
            # Fallback: area × reference density
            pop_val = int(area_km2 * REF_DENSITY)
            pop_source = "area_scaled_from_ref_density"

        demand_val = demand_from_reference(pop_val, interval)

        if demand_val is None:
            # Fallback constants (so UI never breaks)
            fallback = {"daily": REF_DAILY_DEMAND,
                        "monthly": REF_MONTHLY_DEMAND,
                        "yearly": REF_YEARLY_DEMAND}
            demand_val = fallback.get(interval)
            demand_source = f"fallback_constant_{interval}"
        else:
            demand_source = f"scaled_from_{REF_CITY}_{pop_source}"

        print("City:", city,
              "Area_km2:", round(area_km2, 2),
              "Pop:", pop_val,
              "Pop_source:", pop_source,
              "Demand:", demand_val,
              "Demand_source:", demand_source)

        # ---- Volume (to 1 km height) ----
        volume_m3 = area_km2 * 1e6 * 1000

        # ---- Weather ----
        url = (
            f"https://archive-api.open-meteo.com/v1/archive?"
            f"latitude={latitude}&longitude={longitude}"
            f"&start_date={start_date}&end_date={end_date}"
            f"&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m"
            f"&timezone=auto"
        )
        resp = requests.get(url, timeout=20)
        if resp.status_code != 200:
            return jsonify({"error": "Weather API fetch failed"}), 500
        data = resp.json().get("hourly", {})
        df = pd.DataFrame(data)
        if df.empty:
            return jsonify({"error": "No weather data available"}), 500

        # ---- Compute AH & flux ----
        T = np.array(df["temperature_2m"])
        RH = np.array(df["relative_humidity_2m"])
        wind = np.array(df["wind_speed_10m"])
        if len(T) == 0:
            return jsonify({"error": "No weather data"}), 500

        AH = calc_AH(T, RH)
        mean_AH = float(np.mean(AH))
        total_stock_L = mean_AH * volume_m3 / 1000.0

        transport_efficiency = 0.08
        scaling = float(np.mean(wind)) / 2.0
        daily_flux_L = total_stock_L * transport_efficiency * scaling

        if interval == "daily":
            net_flux_L = daily_flux_L
        else:
            days = pd.date_range(start=start_date, end=end_date, freq="D")
            net_flux_L = daily_flux_L * len(days)

        # ---- Flux series ----
        dates = pd.to_datetime(df["time"])
        AH_series = calc_AH(T, RH)
        daily_data = pd.DataFrame({"date": dates, "AH": AH_series})

        if interval == "daily":
            grouped = daily_data.resample("D", on="date").mean()
            flux_series = grouped["AH"].values * volume_m3 / 1000.0 * transport_efficiency
            flux_records = [{"date": str(d.date()), "flux_L": float(v)} for d, v in zip(grouped.index, flux_series)]
        elif interval == "monthly":
            grouped = daily_data.resample("M", on="date").mean()
            flux_series = grouped["AH"].values * volume_m3 / 1000.0 * transport_efficiency
            flux_records = [{"date": d.strftime("%Y-%m"), "flux_L": float(v)} for d, v in zip(grouped.index, flux_series)]
        else:
            grouped = daily_data.resample("Y", on="date").mean()
            flux_series = grouped["AH"].values * volume_m3 / 1000.0 * transport_efficiency
            flux_records = [{"date": d.strftime("%Y"), "flux_L": float(v)} for d, v in zip(grouped.index, flux_series)]

        # ---- Ratio ----
        ratio = float(net_flux_L) / float(demand_val) if demand_val and demand_val > 0 else 0.0

        return jsonify({
            "city": city,
            "interval": interval,
            "start_date": start_date,
            "end_date": end_date,

            "area_km2": round(float(area_km2), 2),
            "country_inferred": country_inferred,

            "mean_AH_gm3": round(mean_AH, 2),
            "total_stock_L": round(float(total_stock_L), 2),
            "wind_speed_ms": float(np.mean(wind)),
            "net_flux_L": round(float(net_flux_L), 2),

            "population_used": int(pop_val) if pop_val else None,
            "population_source": pop_source,
            "demand_L": float(demand_val) if demand_val is not None else None,
            "demand_source": demand_source,

            "flux_to_demand_ratio": round(float(ratio), 3),

            "flux_series": flux_records,
            "approx_boundary": approx_boundary,
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ========= Boundary endpoint =========
@app.route("/boundary", methods=["GET"])
def boundary_endpoint():
    city = request.args.get("city", "Bangalore")
    try:
        try:
            boundary = ox.geocode_to_gdf(city).to_crs("EPSG:4326")
            approx_boundary = False
        except Exception:
            boundary = ox.geocode_to_gdf("India").to_crs("EPSG:4326")
            approx_boundary = True
        return jsonify({
            "geojson": boundary.__geo_interface__,
            "approx_boundary": approx_boundary
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print(app.url_map)
    app.run(debug=True)
