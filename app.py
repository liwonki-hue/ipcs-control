import os
import io
import threading
import time
import pandas as pd
from datetime import datetime, date
from flask import Flask, render_template, jsonify, request, send_file
from supabase import create_client, Client

# ── Load .env ─────────────────────────────────────────────────────────
def load_env_manually():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"): continue
                if "=" in line:
                    try:
                        key, val = line.split("=", 1)
                        os.environ[key.strip()] = val.strip()
                    except:
                        continue

load_env_manually()

# ── Flask ──────────────────────────────────────────────────────────────
base_dir = os.path.abspath(os.path.dirname(__file__))
app = Flask(__name__,
            template_folder=os.path.join(base_dir, "templates"),
            static_folder=os.path.join(base_dir, "static"),
            static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

# ── Supabase (singleton) ───────────────────────────────────────────────
from supabase import ClientOptions
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
_sb = None

def get_sb():
    global _sb
    if _sb is None:
        options = ClientOptions(schema="construction")
        _sb = create_client(SUPABASE_URL, SUPABASE_KEY, options=options)
    return _sb

# ── RPC key conversion ────────────────────────────────────────────────
def _parse_rpc(raw):
    if not isinstance(raw, dict):
        raw = {}

    def first(v): 
        if isinstance(v, list) and v: return v[0]
        if isinstance(v, dict): return v
        return {}
        
    def lst(v):   
        return v if isinstance(v, list) else []

    def calc_pct(comp, total):
        if not total or total <= 0: return 0
        return round((comp / total) * 100, 2)

    # 1. KPI processing
    kpi = first(raw.get("kpi"))
    if kpi:
        tdi = kpi.get("total_di", 0) or 0
        cdi = kpi.get("completed_di", 0) or 0
        fcdi = kpi.get("fab_completed_di", 0) or 0
        ecdi = kpi.get("erect_completed_di", 0) or 0

        kpi["overall_pct"] = calc_pct(cdi, tdi)
        kpi["progress_perc"] = kpi["overall_pct"]
        kpi["progress_pct"] = kpi["overall_pct"]
        kpi["fab_pct"] = calc_pct(fcdi, kpi.get("fab_total_di", 0))
        kpi["erect_pct"] = calc_pct(ecdi, kpi.get("erect_total_di", 0))
        kpi["remaining_di"] = tdi - cdi
        kpi["report_date"] = datetime.now().strftime("%Y-%m-%d")
        kpi["fab_di"] = fcdi
        kpi["erect_di"] = ecdi
        kpi["total_plan_di"] = tdi
        kpi["total_plan_joints"] = kpi.get("total_joints", 0)
        kpi["completed_plan_di"] = cdi

        sup_pct = calc_pct(kpi.get("support_comp"), kpi.get("support_total"))
        tst_pct = calc_pct(kpi.get("testpkg_comp"), kpi.get("testpkg_total"))
        kpi["support_pct"] = sup_pct
        kpi["testpkg_pct"] = tst_pct
        kpi["unified_readiness"] = round(kpi["overall_pct"] * 0.6 + sup_pct * 0.2 + tst_pct * 0.2, 2)

    def inject_pct(arr):
        for item in arr:
            di_pct = calc_pct(item.get("completed_di"), item.get("total_di"))
            sup_pct = calc_pct(item.get("support_comp"), item.get("support_total"))
            tst_pct = calc_pct(item.get("testpkg_comp"), item.get("testpkg_total"))
            item["progress_pct"] = di_pct
            item["progress_perc"] = di_pct
            item["support_pct"] = sup_pct
            item["testpkg_pct"] = tst_pct
            item["unified_readiness"] = round(di_pct * 0.6 + sup_pct * 0.2 + tst_pct * 0.2, 2)
        return arr

    actual_raw = lst(raw.get("act"))
    ideal_raw = lst(raw.get("week_schedule"))
    actual_plan_agg = raw.get("actual_plan_agg", {})
    
    all_weeks = {}
    max_wk = 60
    
    i_wks = [int(p.get("week_no") or 0) for p in ideal_raw if p.get("week_no")]
    p_wks = [int(k) for k in actual_plan_agg.keys()]
    a_wks = [int(a.get("week_no") or 0) for a in actual_raw if a.get("week_no")]
    if i_wks: max_wk = max(max_wk, max(i_wks))
    if p_wks: max_wk = max(max_wk, max(p_wks))
    if a_wks: max_wk = max(max_wk, max(a_wks))
    
    for i in range(1, max_wk + 1):
        all_weeks[i] = {
            "week_no": i, "week_label": f"W{i}",
            "completed_di": 0.0, "plan_di": 0.0, "ideal_di": 0.0,
            "start_date": "", "end_date": "",
            "cumul_plan": 0.0, "cumul_ideal": 0.0, "cumul_actual": 0.0,
            "progress_perc": 0.0
        }

    for p in ideal_raw:
        try:
            wk = int(p.get("week_no") or 0)
            if wk in all_weeks:
                idf     = float(p.get("plan_fab_di", 0) or 0)
                ide     = float(p.get("plan_erect_di", 0) or 0)
                idtotal = float(p.get("plan_di", 0) or 0)
                if idtotal == 0 and (idf > 0 or ide > 0): idtotal = idf + ide
                all_weeks[wk]["ideal_di"] = idtotal
                all_weeks[wk]["ideal_fab_di"] = idf
                all_weeks[wk]["ideal_erect_di"] = ide
                all_weeks[wk]["start_date"] = str(p.get("week_start_date") or p.get("start_date") or "")[:10]
                all_weeks[wk]["end_date"]   = str(p.get("week_end_date") or p.get("end_date") or "")[:10]
        except: continue

    actual_plan_agg = raw.get("actual_plan_agg", {})
    if not isinstance(actual_plan_agg, dict): actual_plan_agg = {}
    for wk_str, agg in actual_plan_agg.items():
        try:
            wk = int(wk_str)
            if wk in all_weeks:
                pfab = float(agg.get("f", 0.0) or 0.0)
                perect = float(agg.get("e", 0.0) or 0.0)
                all_weeks[wk]["plan_fab_di"] = pfab
                all_weeks[wk]["plan_erect_di"] = perect
                all_weeks[wk]["plan_di"] = pfab + perect
        except (ValueError, TypeError): continue

    actual_raw = lst(raw.get("act"))
    ep_actual_raw = lst(raw.get("ep_act"))
    for a in actual_raw:
        try:
            wk = int(a.get("week_no") or 0)
            if wk in all_weeks:
                all_weeks[wk]["completed_di"] = float(a.get("completed_di", 0) or 0)
        except: continue

    ep_week_map = {}
    for a in ep_actual_raw:
        try:
            wk = int(a.get("week_no") or 0)
            if wk in all_weeks:
                ep_week_map[wk] = float(a.get("completed_di", 0) or 0)
        except: continue

    cum_p = cum_i = cum_a = ep_cum_a = 0.0
    final_weekly = []
    ep_weekly = []
    for i in range(1, max_wk + 1):
        w = all_weeks[i]
        cum_i += w.get("ideal_di", 0.0)
        cum_p += w.get("plan_di", 0.0)
        cum_a += w.get("completed_di", 0.0)
        ep_c = ep_week_map.get(i, 0.0)
        ep_cum_a += ep_c
        
        w["cumul_ideal"] = round(cum_i, 2)
        w["cumul_plan"] = round(cum_p, 2)
        w["cumul_actual"] = round(cum_a, 2)
        w["progress_perc"] = calc_pct(w["completed_di"], w.get("plan_di", 0.0))
        final_weekly.append(w)
        
        ep_w = {"week_no": i, "week_label": w["week_label"], "completed_di": ep_c, "cumul_actual": round(ep_cum_a, 2)}
        ep_weekly.append(ep_w)

    return {
        "kpi":        kpi,
        "ep_kpi":     raw.get("ep_kpi"),
        "ep_weekly":  ep_weekly,
        "ep_unit":    raw.get("ep_unit"),
        "ep_area":    raw.get("ep_area"),
        "ep_sys":     raw.get("ep_sys"),
        "weekly":     final_weekly,
        "weeks":      final_weekly,
        "systems":    inject_pct(lst(raw.get("sys"))),
        "units":      inject_pct(lst(raw.get("unit"))),
        "areas":      inject_pct(lst(raw.get("area"))),
        "sub_areas":  inject_pct(lst(raw.get("subarea"))),
        "subareas":   inject_pct(lst(raw.get("subarea"))),
        "activities": final_weekly,
        "meta":       first(raw.get("meta")),
    }

# ── In-memory cache ──────────────────────────────────────────────────
_cache      = {}
_lock       = threading.Lock()
_building   = False
_build_fail = False

def _build():
    global _building, _build_fail
    try:
        sb = get_sb()
        # 1. Basic summary
        try:
            res = sb.rpc("get_dashboard_summary_v17", {}).execute()
            raw = res.data
            if isinstance(raw, list) and len(raw) > 0: raw = raw[0]
            if not isinstance(raw, dict): raw = {}
        except Exception as rpc_e:
            print(f"[cache] RPC Error: {rpc_e}")
            raw = {}
            
        # 2. Week schedule
        try:
            weeks_res = sb.table("week_schedule").select("*").order("week_no").execute()
            raw["week_schedule"] = weeks_res.data or []
        except Exception as we:
            print(f"[cache] Week Schedule Fetch Error: {we}")
            raw["week_schedule"] = []

        # 3. Week plan items aggregation
        try:
            wpi_agg = {}
            offset = 0
            limit = 5000
            while True:
                wpi_res = sb.table("week_plan_items").select("week_no,plan_fab_di,plan_erect_di").range(offset, offset + limit - 1).execute()
                chunk = wpi_res.data or []
                for r in chunk:
                    wk = int(r.get("week_no") or 0)
                    f = float(r.get("plan_fab_di", 0) or 0)
                    e = float(r.get("plan_erect_di", 0) or 0)
                    if wk not in wpi_agg: wpi_agg[wk] = {"f":0.0, "e":0.0}
                    wpi_agg[wk]["f"] += f
                    wpi_agg[wk]["e"] += e
                if len(chunk) < limit: break
                offset += limit
            raw["actual_plan_agg"] = wpi_agg
        except Exception as e:
            raw["actual_plan_agg"] = {}
            print(f"[cache] wpi aggregation error: {e}")

        # 4. Integrated Dashboard Aggregation via RPC
        try:
            agg_res = sb.rpc("get_dashboard_aggregates_control_v2", {}).execute()
            agg_data = agg_res.data
            if agg_data:
                for k in ["unit","area","sys","act","ep_act","kpi","ep_kpi"]:
                    if k in agg_data:
                        # KPI and EP_KPI are objects but _parse_rpc expects list for some parts
                        if k in ["kpi", "ep_kpi"] and isinstance(agg_data[k], dict):
                            raw[k] = [agg_data[k]]
                        else:
                            raw[k] = agg_data[k]
        except Exception as e:
            print(f"[bop-debug] RPC integrated aggregation error: {e}")

        data = _parse_rpc(raw)
        with _lock: _cache["data"] = data
        _build_fail = False
    except Exception as e:
        _build_fail = True
        print(f"[cache] ERROR: {e}")
    finally:
        _building = False

def get_cache(force=False):
    global _building, _build_fail
    with _lock: has = "data" in _cache
    if has and not force:
        with _lock: return _cache["data"]
    with _lock:
        if not _building:
            _building = True
            threading.Thread(target=_build, daemon=True).start()
    with _lock: return _cache.get("data")

# ── Metadata ─────────────────────────────────────────────────────────
_meta_cache = {"time": 0, "data": None}

@app.route("/api/cache/clear")
def api_cache_clear():
    global _cache, _meta_cache, _iso_cache, _building
    with _lock: _cache.clear()
    _meta_cache = {"time": 0, "data": None}
    _iso_cache  = {"time": 0, "data": []}
    print("[cache] All caches cleared manually - starting background rebuild")
    # Immediately kick off background rebuild so next /api/dashboard call is fast
    with _lock:
        if not _building:
            _building = True
            threading.Thread(target=_build, daemon=True).start()
    return jsonify({"status": "ok", "message": "All caches cleared, rebuild started"})

@app.route("/api/meta", methods=["GET"])
def api_meta():
    global _meta_cache
    now = time.time()
    force = request.args.get("t") is not None
    if not force and _meta_cache["data"] and (now - _meta_cache["time"]) < 3600:
        return jsonify(_meta_cache["data"])
    try:
        sb = get_sb()
        res = sb.rpc("get_distinct_meta_v2", {}).execute()
        res_data = res.data
        if not res_data:
            res_data = {"units": [], "systems": [], "areas": [], "sub_areas": []}
        _meta_cache = {"time": now, "data": res_data}
        return jsonify(res_data)
    except Exception as e:
        print(f"[api-meta] Error: {e}")
        return jsonify({"error": str(e)}), 500

# ══════════════════════════════════════════════════════════════════════
#  PAGE
# ══════════════════════════════════════════════════════════════════════
@app.route("/")
def index():
    return render_template("index.html")

# ══════════════════════════════════════════════════════════════════════
#  DASHBOARD API
# ══════════════════════════════════════════════════════════════════════
@app.route("/api/dashboard")
def api_dashboard():
    data = get_cache()
    if data is None:
        return jsonify({"building": True}), 202
    return jsonify(data)

@app.route("/api/debug")
def api_debug():
    try:
        res = get_sb().rpc("get_dashboard_summary_v17", {}).execute()
        return jsonify({"status": "ok", "raw_type": str(type(res.data)), "data": res.data})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok", "uptime": "running"})

# ── Weeks (Schedule) ──────────────────────────────────────────────────
@app.route("/api/weeks", methods=["GET"])
def api_weeks_get():
    try:
        res = get_sb().table("week_schedule").select("*").order("week_no").execute()
        return jsonify(res.data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/weeks", methods=["POST"])
def api_weeks_post():
    try:
        res = get_sb().table("week_schedule").insert(request.get_json()).execute()
        return jsonify({"ok": True, "data": res.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Joint Master ───────────────────────────────────────────────────────
@app.route("/api/joints", methods=["GET"])
def api_joints_get():
    try:
        sb      = get_sb()
        limit   = int(request.args.get("limit",  50))
        offset  = int(request.args.get("offset",  0))
        unit    = request.args.get("unit",     "")
        system  = request.args.get("system",   "")
        status  = request.args.get("status",   "")
        iso     = request.args.get("iso",      "")
        subarea = request.args.get("sub_area", "")
        phase   = request.args.get("phase", "")
        q = sb.table("joint_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if iso:     q = q.eq("iso_drawing", iso)
        if subarea: q = q.eq("sub_area",    subarea)
        if phase:   q = q.eq("phase",       phase)
        if status == "completed": q = q.not_.is_("date_completed", "null")
        if status == "pending":   q = q.is_("date_completed",      "null")
        res = q.order("id").range(offset, offset + limit - 1).execute()
        return jsonify({"data": res.data, "count": res.count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/joints", methods=["POST"])
def api_joints_post():
    try:
        res = get_sb().table("joint_master").insert(request.get_json()).execute()
        return jsonify({"ok": True, "data": res.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/joints/<int:jid>", methods=["PATCH"])
def api_joints_patch(jid):
    try:
        get_sb().table("joint_master").update(request.get_json()).eq("id", jid).execute()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/joints/<int:jid>", methods=["DELETE"])
def api_joints_delete(jid):
    try:
        get_sb().table("joint_master").delete().eq("id", jid).execute()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Week Plan Items ────────────────────────────────────────────────────
@app.route("/api/week-plan-items", methods=["GET"])
def api_wpi_get():
    try:
        sb    = get_sb()
        wk_no = request.args.get("week_no", "")
        q     = sb.table("week_plan_items").select("*")
        if wk_no: q = q.eq("week_no", int(wk_no))
        return jsonify(q.order("id").execute().data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/week-plan-items", methods=["POST"])
def api_wpi_post():
    try:
        res = get_sb().table("week_plan_items").insert(request.get_json()).execute()
        return jsonify({"ok": True, "data": res.data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/week-plan-items/<int:item_id>", methods=["PATCH"])
def api_wpi_patch(item_id):
    try:
        get_sb().table("week_plan_items").update(request.get_json()).eq("id", item_id).execute()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/week-plan-items/<int:item_id>", methods=["DELETE"])
def api_wpi_delete(item_id):
    try:
        get_sb().table("week_plan_items").delete().eq("id", item_id).execute()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# ── ISO Summary (server-side filtering) ───────────────────────────────
import time
_iso_cache = {"time": 0, "data": []}

@app.route("/api/iso-summary")
def api_iso_summary():
    """
    ISO Drawing summary with server-side filtering and DB-side aggregation.
    """
    global _iso_cache
    try:
        sb         = get_sb()
        show_all   = request.args.get("show_all",  "false").lower() == "true"
        f_system   = request.args.get("system",    "").strip()
        f_unit     = request.args.get("unit",      "").strip()
        f_area     = request.args.get("area",      "").strip()
        f_subarea  = request.args.get("sub_area",  "").strip()
        has_filter = bool(f_system or f_unit or f_area or f_subarea)

        # Use cache only when no specific filter is applied
        now = time.time()
        if not has_filter and _iso_cache["data"] and (now - _iso_cache["time"]) < 300:
            data = _iso_cache["data"]
        else:
            print(f"[iso-summary] RPC aggregation (system={f_system or 'ALL'}, unit={f_unit or 'ALL'}, area={f_area or 'ALL'})")
            res = sb.rpc("get_iso_summary_v2", {
                "f_system": f_system,
                "f_unit": f_unit,
                "f_area": f_area,
                "f_subarea": f_subarea
            }).execute()
            data = res.data or []
            
            # Cache only unfiltered full dataset
            if not has_filter:
                _iso_cache = {"time": now, "data": data}

        if not show_all:
            data = [r for r in data if (float(r.get("remain_fab_di", 0) or 0) > 0) or (float(r.get("remain_erect_di", 0) or 0) > 0)]

        data.sort(key=lambda x: str(x.get("iso_drawing", "")))
        return jsonify(data)
    except Exception as e:
        print(f"[iso-summary] Error: {e}")
        return jsonify([]), 200

        if not show_all:
            data = [r for r in data if (r.get("remain_fab_di", 0) > 0) or (r.get("remain_erect_di", 0) > 0)]

        data.sort(key=lambda x: str(x.get("iso_drawing", "")))
        return jsonify(data)
    except Exception as e:
        print(f"[iso-summary] Error: {e}")
        return jsonify([]), 200

@app.route("/api/welder-summary")
def api_welder_summary():
    import re
    try:
        sb = get_sb()
        # Optional filters from query params
        date_from = request.args.get("date_from", "").strip()
        date_to   = request.args.get("date_to",   "").strip()
        f_system  = request.args.get("system",    "").strip()
        f_welder  = request.args.get("welder",    "").strip()

        offset = 0
        limit  = 5000
        all_completed = []
        while True:
            q = sb.table("joint_master").select(
                "welder, di, size_inch, date_completed, system, unit, area"
            ).not_.is_("date_completed", "null")
            if f_system: q = q.eq("system", f_system)
            if date_from: q = q.gte("date_completed", date_from)
            if date_to:   q = q.lte("date_completed", date_to)
            chunk = q.range(offset, offset + limit - 1).execute().data or []
            all_completed.extend(chunk)
            if len(chunk) < limit: break
            offset += limit

        if not all_completed:
            return jsonify({
                "stats": {"active_welders": 0, "total_joints": 0, "total_di": 0, "avg_di": 0},
                "ranking": [], "trend": [], "welder_daily": {}, "system_breakdown": []
            })

        welder_map  = {}  # welder -> {joints, total_di, last_active, systems: {}, daily: {}}
        daily_map   = {}  # date -> total_di
        sys_map     = {}  # system -> {joints, total_di}
        total_di    = 0

        for r in all_completed:
            w_str = (r.get("welder") or "Unknown").strip()
            welders = [w.strip() for w in re.split(r'[,/]+', w_str) if w.strip()] or ["Unknown"]

            sz_val = r.get("di")
            if sz_val is None or sz_val == "": sz_val = r.get("size_inch")
            try:   di = float(sz_val or 0)
            except: di = 0.0
            dt  = (r.get("date_completed") or "")[:10]
            sys = (r.get("system") or "").strip()
            total_di += di
            di_per_welder = di / len(welders)

            # filter by specific welder if requested
            matched_welders = [w for w in welders if not f_welder or w == f_welder] if f_welder else welders

            for w in matched_welders:
                if w not in welder_map:
                    welder_map[w] = {"welder": w, "joints": 0, "total_di": 0,
                                     "last_active": "", "systems": {}, "daily": {}}
                wm = welder_map[w]
                wm["joints"] += 1
                wm["total_di"] += di_per_welder
                if dt > wm["last_active"]: wm["last_active"] = dt
                if sys:
                    wm["systems"][sys] = wm["systems"].get(sys, 0) + di_per_welder
                if dt:
                    wm["daily"][dt] = wm["daily"].get(dt, 0) + di_per_welder

            if dt:  daily_map[dt]  = daily_map.get(dt, 0) + di
            if sys: sys_map[sys]   = sys_map.get(sys, {"system": sys, "joints": 0, "total_di": 0})
            if sys:
                sys_map[sys]["joints"] += 1
                sys_map[sys]["total_di"] += di

        ranking = sorted(welder_map.values(), key=lambda x: x["total_di"], reverse=True)
        # Convert nested dicts to sorted lists for chart use
        for wm in ranking:
            wm["system_list"] = sorted(
                [{"system": k, "di": round(v, 2)} for k, v in wm["systems"].items()],
                key=lambda x: x["di"], reverse=True
            )
            wm["daily_list"] = sorted(
                [{"date": k, "di": round(v, 2)} for k, v in wm["daily"].items()]
            )
            wm["total_di"] = round(wm["total_di"], 2)
            del wm["systems"], wm["daily"]

        trend   = [{"date": k, "di": round(v, 2)} for k, v in sorted(daily_map.items())]
        sys_bkd = sorted(sys_map.values(), key=lambda x: x["total_di"], reverse=True)
        stats   = {
            "active_welders": len(welder_map),
            "total_joints":   len(all_completed),
            "total_di":       round(total_di, 2),
            "avg_di":         round(total_di / len(welder_map), 2) if welder_map else 0
        }
        return jsonify({"stats": stats, "ranking": ranking, "trend": trend,
                        "system_breakdown": sys_bkd})
    except Exception as e:
        print(f"[welder-summary] Error: {e}")
        return jsonify({"error": str(e)}), 500


# ── Joint Master Bulk Import (Excel) ──────────────────────────────────
@app.route("/api/joints/import", methods=["POST"])
def api_joints_import():
    """Bulk upsert from uploaded Excel file.
    Expected columns (case-insensitive, extra cols ignored):
      unit, system, area, sub_area, line_no, iso_drawing, rev,
      spool_no, mat, size_inch, sf, joint_no, di, welder, phase,
      date_completed, remark
    """
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400
        f = request.files["file"]
        buf = io.BytesIO(f.read())
        df = pd.read_excel(buf, dtype=str)
        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]

        FIELD_MAP = {
            "unit": "unit", "system": "system", "area": "area",
            "sub_area": "sub_area", "line_no": "line_no",
            "iso_drawing": "iso_drawing", "rev": "rev",
            "spool_no": "spool_no", "mat": "mat",
            "size_inch": "size_inch", "sf": "sf", "joint_no": "joint_no",
            "di": "di", "welder": "welder", "phase": "phase",
            "date_completed": "date_completed", "remark": "remark"
        }

        records = []
        skipped = 0
        for _, row in df.iterrows():
            rec = {}
            for col, db_col in FIELD_MAP.items():
                val = row.get(col, None)
                if val is None or (isinstance(val, float) and pd.isna(val)): val = None
                else: val = str(val).strip() or None
                rec[db_col] = val

            # Skip rows without iso_drawing
            if not rec.get("iso_drawing"):
                skipped += 1
                continue

            # Convert numeric fields
            for num_col in ["size_inch", "di"]:
                v = rec.get(num_col)
                if v:
                    try:   rec[num_col] = float(v)
                    except: rec[num_col] = None

            # Normalise date
            dc = rec.get("date_completed")
            if dc:
                try:
                    parsed = pd.to_datetime(dc)
                    rec["date_completed"] = parsed.strftime("%Y-%m-%d")
                    rec["completed"] = True
                except:
                    rec["date_completed"] = None
            else:
                rec["completed"] = False

            records.append(rec)

        if not records:
            return jsonify({"ok": False, "error": f"No valid rows found (skipped {skipped})"}), 400

        # Batch upsert in chunks of 500
        sb = get_sb()
        CHUNK = 500
        inserted = 0
        for i in range(0, len(records), CHUNK):
            batch = records[i:i + CHUNK]
            sb.table("joint_master").insert(batch).execute()
            inserted += len(batch)

        # Clear caches so dashboard refreshes
        global _cache, _meta_cache, _iso_cache
        with _lock: _cache.clear()
        _meta_cache = {"time": 0, "data": None}
        _iso_cache  = {"time": 0, "data": []}

        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})
    except Exception as e:
        print(f"[joints-import] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

# ── Support Master CRUD ───────────────────────────────────────────────
@app.route("/api/support-master", methods=["GET"])
def api_support_get():
    try:
        sb = get_sb()
        limit   = int(request.args.get("limit",  100))
        offset  = int(request.args.get("offset",   0))
        system  = request.args.get("system",  "").strip()
        subarea = request.args.get("sub_area","").strip()
        status  = request.args.get("status",  "").strip()
        iso     = request.args.get("iso",     "").strip()
        q = sb.table("support_master").select("*", count="exact")
        if system:  q = q.eq("system",      system)
        if subarea: q = q.eq("sub_area",    subarea)
        if iso:     q = q.eq("iso_drawing", iso)
        if status == "completed": q = q.not_.is_("date_completed", "null")
        if status == "pending":   q = q.is_("date_completed",      "null")
        res = q.order("id").range(offset, offset + limit - 1).execute()
        return jsonify({"data": res.data, "count": res.count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/support-master", methods=["POST"])
def api_support_post():
    try:
        res = get_sb().table("support_master").insert(request.get_json()).execute()
        return jsonify({"ok": True, "data": res.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/support-master/<int:rid>", methods=["PATCH"])
def api_support_patch(rid):
    try:
        get_sb().table("support_master").update(request.get_json()).eq("id", rid).execute()
        _cache.clear(); return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/support-master/<int:rid>", methods=["DELETE"])
def api_support_delete(rid):
    try:
        get_sb().table("support_master").delete().eq("id", rid).execute()
        _cache.clear(); return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/support-master/import", methods=["POST"])
def api_support_import():
    """Bulk import from Excel.
    Expected columns: system, sub_area, iso_drawing, support_no, completed, date_completed, remark
    """
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400
        buf = io.BytesIO(request.files["file"].read())
        df  = pd.read_excel(buf, dtype=str)
        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
        FIELDS = ["system","sub_area","iso_drawing","support_no","completed","date_completed","remark"]
        records, skipped = [], 0
        for _, row in df.iterrows():
            rec = {}
            for f in FIELDS:
                v = row.get(f)
                rec[f] = None if (v is None or (isinstance(v, float) and pd.isna(v))) else str(v).strip() or None
            if not rec.get("system") and not rec.get("iso_drawing"):
                skipped += 1; continue
            dc = rec.get("date_completed")
            if dc:
                try:
                    rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
                    rec["completed"] = True
                except: rec["date_completed"] = None
            else:
                cmp_val = str(rec.get("completed") or "").upper()
                rec["completed"] = cmp_val in ["TRUE","Y","O","1"]
            records.append(rec)
        if not records:
            return jsonify({"ok": False, "error": f"No valid rows (skipped {skipped})"}), 400
        sb = get_sb(); inserted = 0
        for i in range(0, len(records), 500):
            sb.table("support_master").insert(records[i:i+500]).execute()
            inserted += len(records[i:i+500])
        with _lock: _cache.clear()
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Test Package Master CRUD ──────────────────────────────────────────
@app.route("/api/testpkg-master", methods=["GET"])
def api_testpkg_get():
    try:
        sb = get_sb()
        limit   = int(request.args.get("limit",  100))
        offset  = int(request.args.get("offset",   0))
        system  = request.args.get("system",  "").strip()
        subarea = request.args.get("sub_area","").strip()
        status  = request.args.get("status",  "").strip()
        q = sb.table("test_package_master").select("*", count="exact")
        if system:  q = q.eq("system",   system)
        if subarea: q = q.eq("sub_area", subarea)
        if status == "completed": q = q.not_.is_("date_completed", "null")
        if status == "pending":   q = q.is_("date_completed",      "null")
        res = q.order("id").range(offset, offset + limit - 1).execute()
        return jsonify({"data": res.data, "count": res.count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/testpkg-master", methods=["POST"])
def api_testpkg_post():
    try:
        res = get_sb().table("test_package_master").insert(request.get_json()).execute()
        return jsonify({"ok": True, "data": res.data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/testpkg-master/<int:rid>", methods=["PATCH"])
def api_testpkg_patch(rid):
    try:
        get_sb().table("test_package_master").update(request.get_json()).eq("id", rid).execute()
        _cache.clear(); return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/testpkg-master/<int:rid>", methods=["DELETE"])
def api_testpkg_delete(rid):
    try:
        get_sb().table("test_package_master").delete().eq("id", rid).execute()
        _cache.clear(); return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/testpkg-master/import", methods=["POST"])
def api_testpkg_import():
    """Bulk import from Excel.
    Expected columns: system, sub_area, test_pkg, completed, date_completed, remark
    """
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400
        buf = io.BytesIO(request.files["file"].read())
        df  = pd.read_excel(buf, dtype=str)
        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
        FIELDS = ["system","sub_area","test_pkg","completed","date_completed","remark"]
        records, skipped = [], 0
        for _, row in df.iterrows():
            rec = {}
            for f in FIELDS:
                v = row.get(f)
                rec[f] = None if (v is None or (isinstance(v, float) and pd.isna(v))) else str(v).strip() or None
            if not rec.get("system") and not rec.get("test_pkg"):
                skipped += 1; continue
            dc = rec.get("date_completed")
            if dc:
                try:
                    rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
                    rec["completed"] = True
                except: rec["date_completed"] = None
            else:
                cmp_val = str(rec.get("completed") or "").upper()
                rec["completed"] = cmp_val in ["TRUE","Y","O","1"]
            records.append(rec)
        if not records:
            return jsonify({"ok": False, "error": f"No valid rows (skipped {skipped})"}), 400
        sb = get_sb(); inserted = 0
        for i in range(0, len(records), 500):
            sb.table("test_package_master").insert(records[i:i+500]).execute()
            inserted += len(records[i:i+500])
        with _lock: _cache.clear()
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0",
            port=int(os.environ.get("PORT", 5001)))
