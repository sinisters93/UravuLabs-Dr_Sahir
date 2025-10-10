# =========================================================
#  Uravu Backend (final version)
#  with terrain + Numba + Redis + CORS + boundary fix
# =========================================================

from flask import Flask, request, jsonify
from flask_cors import CORS
import os, json, base64, calendar, traceback, requests
import pandas as pd
import numpy as np
import osmnx as ox

# ---- Optional dependencies ----
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# ---- Requests cache (optional) ----
_REQUESTS_CACHE_ENABLED = False
try:
    import requests_cache
    requests_cache.install_cache("weather_cache", expire_after=3600)
    _REQUESTS_CACHE_ENABLED = True
except Exception:
    _REQUESTS_CACHE_ENABLED = False

# ---- Redis (optional) ----
redis_client = None
try:
    import redis
except Exception:
    redis = None

# ---- Numba (optional) ----
_USE_NUMBA = False
try:
    from numba import njit
    _USE_NUMBA = True
except Exception:
    _USE_NUMBA = False

# =========================================================
# Flask App
# =========================================================
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# =========================================================
# Reference baseline (Bangalore)
# =========================================================
REF_CITY = "Bangalore"
REF_POP = 12_000_000
REF_DAILY_DEMAND = 1.44e9
REF_MONTHLY_DEMAND = REF_DAILY_DEMAND * 30
REF_YEARLY_DEMAND = REF_DAILY_DEMAND * 365
REF_AREA_KM2 = 740.0
REF_DENSITY = REF_POP / REF_AREA_KM2

# =========================================================
# Redis Setup
# =========================================================
USE_REDIS = os.getenv("USE_REDIS", "0") == "1"
REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

if USE_REDIS and redis:
    try:
        redis_client = redis.StrictRedis(
            host=REDIS_HOST, port=REDIS_PORT, db=0, decode_responses=True
        )
        redis_client.ping()
        print("✅ Redis connected")
    except Exception as e:
        print("⚠️ Redis unavailable:", e)
        redis_client = None
else:
    redis_client = None

# =========================================================
# Helper Functions
# =========================================================
def saturation_vp_np(T):
    return 6.112 * np.exp((17.67 * T) / (T + 243.5))

def calc_AH_np(T, RH):
    Es = saturation_vp_np(T)
    RH_frac = RH / 100.0
    return (Es * 100 * RH_frac * 2.1674) / (273.15 + T)

if _USE_NUMBA:
    from numba import njit

    @njit(fastmath=True, cache=True)
    def saturation_vp_nb(T):
        return 6.112 * np.exp((17.67 * T) / (T + 243.5))

    @njit(fastmath=True, cache=True)
    def calc_AH_nb(T, RH):
        Es = saturation_vp_nb(T)
        RH_frac = RH / 100.0
        return (Es * 100.0 * RH_frac * 2.1674) / (273.15 + T)

def calc_AH(T, RH):
    if _USE_NUMBA:
        return calc_AH_nb(T, RH)
    return calc_AH_np(T, RH)

def expand_dates_for_interval(start_date, end_date, interval):
    if interval == "monthly":
        if len(start_date) == 7:
            start_date = f"{start_date}-01"
        if len(end_date) == 7:
            y, m = map(int, end_date.split("-"))
            last_day = calendar.monthrange(y, m)[1]
            end_date = f"{end_date}-{last_day}"
    elif interval == "yearly":
        if len(start_date) == 4:
            start_date = f"{start_date}-01-01"
        if len(end_date) == 4:
            end_date = f"{end_date}-12-31"
    return start_date, end_date

def fetch_population_wikidata(city_name):
    """Fetch population from Wikidata."""
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
    except Exception:
        return None, "sparql_exception"

def demand_from_reference(population, interval):
    if not population or population <= 0:
        return None
    factor = population / REF_POP
    if interval == "daily":
        return REF_DAILY_DEMAND * factor
    if interval == "monthly":
        return REF_MONTHLY_DEMAND * factor
    if interval == "yearly":
        return REF_YEARLY_DEMAND * factor
    return REF_DAILY_DEMAND * factor

# =========================================================
# /flux Endpoint
# =========================================================
@app.route("/flux", methods=["GET"])
def flux_endpoint():
    try:
        city = request.args.get("city", "Bangalore")
        start_date = request.args.get("start_date", "2024-12-15")
        end_date = request.args.get("end_date", "2024-12-20")
        interval = request.args.get("interval", "daily").lower()
        start_date, end_date = expand_dates_for_interval(start_date, end_date, interval)

        # Redis cache check
        cache_key = f"flux:{city}:{interval}:{start_date}:{end_date}"
        if redis_client:
            cached = redis_client.get(cache_key)
            if cached:
                print(f"📦 Cache hit: {cache_key}")
                return jsonify(json.loads(cached))

        # Boundary
        try:
            boundary = ox.geocode_to_gdf(city, buffer_dist=0).to_crs("EPSG:4326")
            if boundary.empty:
                boundary = ox.geocode_to_gdf(f"{city}, India").to_crs("EPSG:4326")
            approx_boundary = False
        except Exception:
            boundary = ox.geocode_to_gdf("India").to_crs("EPSG:4326")
            approx_boundary = True

        area_km2 = boundary.to_crs("EPSG:3857").geometry.area.iloc[0] / 1e6
        centroid_geom = boundary.to_crs(epsg=3857).geometry.centroid.to_crs(epsg=4326).iloc[0]
        latitude, longitude = centroid_geom.y, centroid_geom.x

        # Population & demand
        pop_val, pop_source = fetch_population_wikidata(city)
        if not pop_val:
            pop_val = int(area_km2 * REF_DENSITY)
            pop_source = "area_scaled_from_ref_density"

        demand_val = demand_from_reference(pop_val, interval)
        if not demand_val:
            fallback = {"daily": REF_DAILY_DEMAND, "monthly": REF_MONTHLY_DEMAND, "yearly": REF_YEARLY_DEMAND}
            demand_val = fallback.get(interval)
            demand_source = f"fallback_constant_{interval}"
        else:
            demand_source = f"scaled_from_{REF_CITY}_{pop_source}"

        # Weather
        url = (
            f"https://archive-api.open-meteo.com/v1/archive?"
            f"latitude={latitude}&longitude={longitude}"
            f"&start_date={start_date}&end_date={end_date}"
            f"&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"
            f"&timezone=auto"
        )
        resp = requests.get(url, timeout=30)
        if resp.status_code != 200:
            return jsonify({"error": "Weather API fetch failed"}), 500

        hourly = resp.json().get("hourly", {})
        df = pd.DataFrame(hourly)
        if df.empty:
            return jsonify({"error": "No weather data"}), 500

        T = np.array(df["temperature_2m"], dtype=float)
        RH = np.array(df["relative_humidity_2m"], dtype=float)
        wind = np.array(df["wind_speed_10m"], dtype=float)
        wdir = np.array(df["wind_direction_10m"], dtype=float)
        AH = calc_AH(T, RH)
        mean_AH = float(np.nanmean(AH))

        # Volume (1 km height)
        volume_m3 = area_km2 * 1e9
        total_stock_L = mean_AH * volume_m3 / 1000.0

        # Terrain
        try:
            elev_api = f"https://api.open-meteo.com/v1/elevation?latitude={latitude}&longitude={longitude}"
            elev_resp = requests.get(elev_api, timeout=10).json()
            elevation_m = float(elev_resp.get("elevation", [0])[0] if isinstance(elev_resp.get("elevation"), list) else elev_resp.get("elevation", 0))
        except Exception:
            elevation_m = 0.0

        terrain_factor = max(0.2, 1.0 - elevation_m / 3000.0)
        transport_eff = 0.08
        wind_scaling = float(np.nanmean(wind)) / 2.0
        daily_flux_L = total_stock_L * transport_eff * wind_scaling * terrain_factor

        days = pd.date_range(start=start_date, end=end_date, freq="D")
        net_flux_L = daily_flux_L * len(days)
        ratio = net_flux_L / demand_val if demand_val else 0

        # Flux series
        dates = pd.to_datetime(df["time"])
        daily_data = pd.DataFrame({"date": dates, "AH": AH})
        grouped = daily_data.resample("D", on="date").mean()
        flux_series_vals = grouped["AH"].values * volume_m3 / 1000.0 * transport_eff * terrain_factor
        flux_records = [{"date": str(d.date()), "flux_L": float(v)} for d, v in zip(grouped.index, flux_series_vals)]

        # Wind arrow
        mean_dir = float(np.nanmean(wdir))
        arrow_svg = f'''
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
          <g transform="rotate({mean_dir},20,20)">
            <line x1="20" y1="30" x2="20" y2="10" stroke="#0050dc" stroke-width="2" />
            <polygon points="15,10 25,10 20,2" fill="#0050dc"/>
          </g>
        </svg>
        '''
        arrow_b64 = base64.b64encode(arrow_svg.encode()).decode("utf-8")
        arrow_data_url = f"data:image/svg+xml;base64,{arrow_b64}"

        response = {
            "city": city,
            "interval": interval,
            "start_date": start_date,
            "end_date": end_date,
            "area_km2": round(area_km2, 2),
            "mean_AH_gm3": round(mean_AH, 2),
            "total_stock_L": round(total_stock_L, 2),
            "wind_speed_ms": float(np.nanmean(wind)),
            "net_flux_L": round(net_flux_L, 2),
            "population_used": int(pop_val),
            "population_source": pop_source,
            "demand_L": float(demand_val),
            "demand_source": demand_source,
            "flux_to_demand_ratio": round(ratio, 3),
            "flux_series": flux_records,
            "wind_series": [{"speed_ms": float(s), "direction_deg": float(d)} for s, d in zip(wind, wdir)],
            "wind_arrow_svg": arrow_data_url,
            "terrain_elevation_m": elevation_m,
            "terrain_factor": round(terrain_factor, 3),
            "requests_cache": _REQUESTS_CACHE_ENABLED,
            "numba_enabled": _USE_NUMBA,
            "data_timestamp": pd.Timestamp.utcnow().isoformat() + "Z",
        }

        if redis_client:
            try:
                redis_client.setex(cache_key, 3600, json.dumps(response))
                print(f"💾 Cache set: {cache_key}")
            except Exception as e:
                print("Redis setex failed:", e)

        return jsonify(response)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# =========================================================
# /boundary Endpoint (with red outline fix)
# =========================================================
@app.route("/boundary", methods=["GET"])
def boundary_endpoint():
    city = request.args.get("city", "Bangalore")
    try:
        try:
            boundary = ox.geocode_to_gdf(city, buffer_dist=0).to_crs("EPSG:4326")
            if boundary.empty:
                boundary = ox.geocode_to_gdf(f"{city}, India").to_crs("EPSG:4326")
            approx = False
        except Exception:
            boundary = ox.geocode_to_gdf("India").to_crs("EPSG:4326")
            approx = True

        geojson = boundary.__geo_interface__
        if geojson.get("type") != "FeatureCollection":
            geojson = {"type": "FeatureCollection", "features": [geojson]}
        return jsonify({"geojson": geojson, "approx_boundary": approx})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# =========================================================
# /global_flux Endpoint
# =========================================================
@app.route("/global_flux", methods=["GET"])
def global_flux():
    try:
        lats = np.linspace(-89.5, 89.5, 180)
        lons = np.linspace(-179.5, 179.5, 360)
        grid = np.zeros((180, 360))
        for i, lat in enumerate(lats):
            T = 25 - 0.1 * abs(lat)
            RH = 70 - 0.2 * abs(lat)
            grid[i, :] = calc_AH(np.array([T]), np.array([RH]))[0]
        gmin, gmax = np.min(grid), np.max(grid)
        norm = (grid - gmin) / (gmax - gmin + 1e-9)
        return jsonify({
            "lats": lats.tolist(),
            "lons": lons.tolist(),
            "ah_grid": norm.tolist(),
            "min": float(gmin),
            "max": float(gmax),
            "timestamp": pd.Timestamp.utcnow().isoformat() + "Z"
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# =========================================================
# Health + Root
# =========================================================
@app.route("/healthz")
def health():
    return jsonify({
        "status": "ok",
        "redis": redis_client is not None,
        "requests_cache": _REQUESTS_CACHE_ENABLED,
        "numba_enabled": _USE_NUMBA
    })

@app.route("/")
def home():
    return """
    <h2>🌎 Uravu Backend Active</h2>
    <ul>
        <li><a href='/flux?city=Bangalore'>/flux?city=Bangalore</a></li>
        <li><a href='/boundary?city=Bangalore'>/boundary?city=Bangalore</a></li>
        <li><a href='/global_flux'>/global_flux</a></li>
        <li><a href='/healthz'>/healthz</a></li>
    </ul>
    """

# =========================================================
# Run
# =========================================================
if __name__ == "__main__":
    print(app.url_map)
    app.run(host="0.0.0.0", port=5000, debug=True)
