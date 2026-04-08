import os
import io
import threading
import time
import pandas as pd
from datetime import datetime
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
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
_sb = None

def get_sb():
    global _sb
    if _sb is None:
        _sb = create_client(SUPABASE_URL, SUPABASE_KEY)
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

    def inject_pct(arr):
        for item in arr:
            pct = calc_pct(item.get("completed_di"), item.get("total_di"))
            item["progress_pct"] = pct
            item["progress_perc"] = pct
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

    for a in actual_raw:
        try:
            wk = int(a.get("week_no") or 0)
            if wk in all_weeks:
                all_weeks[wk]["completed_di"] = float(a.get("completed_di", 0) or 0)
        except: continue

    cum_p = cum_i = cum_a = 0.0
    final_weekly = []
    for i in range(1, max_wk + 1):
        w = all_weeks[i]
        cum_i += w.get("ideal_di", 0.0)
        cum_p += w.get("plan_di", 0.0)
        cum_a += w.get("completed_di", 0.0)
        w["cumul_ideal"] = round(cum_i, 2)
        w["cumul_plan"] = round(cum_p, 2)
        w["cumul_actual"] = round(cum_a, 2)
        w["progress_perc"] = calc_pct(w["completed_di"], w.get("plan_di", 0.0))
        final_weekly.append(w)

    return {
        "kpi":        kpi,
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
        res = sb.rpc("get_dashboard_summary_v17", {}).execute()
        raw = res.data
        if isinstance(raw, list) and len(raw) > 0: raw = raw[0]
        if not isinstance(raw, dict): raw = {}
            
        try:
            weeks_res = sb.table("week_schedule").select("*").order("week_no").execute()
            ws_data = weeks_res.data or []
            try:
                wpi_all = []
                offset = 0
                limit = 3000
                while True:
                    wpi_res = sb.table("week_plan_items").select("*").range(offset, offset + limit - 1).execute()
                    chunk = wpi_res.data or []
                    wpi_all.extend(chunk)
                    if len(chunk) < limit: break
                    offset += limit
                wpi_data = wpi_all
                wpi_agg = {}
                print(f"[bop-debug] Total week_plan_items found: {len(wpi_data)}")
                for r in wpi_data:
                    wk = int(r.get("week_no") or 0)
                    f = float(r.get("plan_fab_di", 0) or 0)
                    e = float(r.get("plan_erect_di", 0) or 0)
                    if wk not in wpi_agg: wpi_agg[wk] = {"f":0.0, "e":0.0}
                    wpi_agg[wk]["f"] += f
                    wpi_agg[wk]["e"] += e
                    if f > 0 or e > 0:
                        print(f"  - Plan: W{wk}, ISO: {r.get('iso_drawing')}, F: {f}, E: {e}")
                raw["actual_plan_agg"] = wpi_agg
            except Exception as e:
                raw["actual_plan_agg"] = {}
                print(f"[cache] wpi aggregation error: {e}")
            raw["week_schedule"] = ws_data
        except Exception as we:
            print(f"[cache] Week Schedule Fetch Error: {we}")
            raw["week_schedule"] = []

        try:
            offset = 0
            limit = 3000
            jm_all = []
            print(f"[bop-debug] Scanning joints for aggregation...")
            while True:
                chunk_res = sb.table("joint_master").select("unit,area,system,size_inch,date_completed,completed").range(offset, offset + limit - 1).execute()
                chunk = chunk_res.data or []
                jm_all.extend(chunk)
                offset += len(chunk)
                if not chunk: break
                if offset > 100000: break
            
            print(f"[bop-debug] Total joints scanned: {len(jm_all)}")
            weeks = raw.get("week_schedule", [])
            week_ranges = []
            for w in weeks:
                try:
                    s_str = str(w.get("week_start_date") or w.get("start_date") or "")[:10]
                    e_str = str(w.get("week_end_date") or w.get("end_date") or "")[:10]
                    if s_str and e_str:
                        s = datetime.strptime(s_str, "%Y-%m-%d").date()
                        e = datetime.strptime(e_str, "%Y-%m-%d").date()
                        week_ranges.append({"week_no": int(w.get("week_no")), "start": s, "end": e})
                except: pass
                
            def get_week_no(d_str):
                try:
                    d = datetime.strptime(d_str[:10], "%Y-%m-%d").date()
                    for wr in week_ranges:
                        if wr["start"] <= d <= wr["end"]: return wr["week_no"]
                except: pass
                return 0
            
            unit_map, area_map, sys_map, week_comp_map = {}, {}, {}, {}
            for r in jm_all:
                u = (r.get("unit") or "").strip()
                a = (r.get("area") or "").strip()
                s = (r.get("system") or "").strip()
                sz = float(r.get("size_inch", 0) or 0)
                is_comp = bool(r.get("date_completed")) or (str(r.get("completed") or "").upper() in ["O", "TRUE", "Y"])
                
                if is_comp and r.get("date_completed"):
                    wk_no = get_week_no(r.get("date_completed"))
                    if wk_no: week_comp_map[wk_no] = week_comp_map.get(wk_no, 0.0) + sz
                
                if u:
                    if u not in unit_map: unit_map[u] = {"unit": u, "total_di": 0.0, "completed_di": 0.0, "total_joints": 0, "completed_joints": 0}
                    unit_map[u]["total_di"] += sz
                    unit_map[u]["total_joints"] += 1
                    if is_comp: unit_map[u]["completed_di"] += sz; unit_map[u]["completed_joints"] += 1
                if a:
                    if a not in area_map: area_map[a] = {"area": a, "total_di": 0.0, "completed_di": 0.0, "total_joints": 0, "completed_joints": 0}
                    area_map[a]["total_di"] += sz
                    area_map[a]["total_joints"] += 1
                    if is_comp: area_map[a]["completed_di"] += sz; area_map[a]["completed_joints"] += 1
                if s:
                    if s not in sys_map: sys_map[s] = {"system": s, "total_di": 0.0, "completed_di": 0.0, "total_joints": 0, "completed_joints": 0}
                    sys_map[s]["total_di"] += sz
                    sys_map[s]["total_joints"] += 1
                    if is_comp: sys_map[s]["completed_di"] += sz; sys_map[s]["completed_joints"] += 1

            if unit_map: raw["unit"] = list(unit_map.values())
            if area_map: raw["area"] = list(area_map.values())
            if sys_map:  raw["sys"]  = list(sys_map.values())
            if week_comp_map:
                raw["act"] = [{"week_no": k, "completed_di": v} for k, v in week_comp_map.items()]
        except Exception as e:
            print(f"[bop-debug] Manual aggregation error: {e}")

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
    print("[cache] All caches cleared manually — starting background rebuild")
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
    if not force and _meta_cache["data"] and (now - _meta_cache["time"]) < 300:
        return jsonify(_meta_cache["data"])
    try:
        sb = get_sb()
        limit = 1000
        offset = 0
        units, systems, areas, sa_set = set(), set(), set(), set()
        print(f"[bop-meta] Starting full DB scan for metadata...")
        while True:
            res = sb.table("joint_master").select("id,unit,system,area,sub_area").order("id").range(offset, offset + limit - 1).execute()
            chunk = res.data or []
            if not chunk: break
            for r in chunk:
                u, s, a, sa = r.get("unit"), r.get("system"), r.get("area"), r.get("sub_area")
                if u: units.add(str(u).strip())
                if s: systems.add(str(s).strip())
                if a: areas.add(str(a).strip())
                if sa: sa_set.add(str(sa).strip())
            offset += len(chunk)
            if len(chunk) < 1: break
            if offset > 100000: break
        res_data = {
            "units":     sorted(list(units)),
            "systems":   sorted(list(systems)),
            "areas":     sorted(list(areas)),
            "sub_areas": sorted(list(sa_set))
        }
        print(f"[bop-meta] FULL DISCOVERY: {len(res_data['systems'])} systems.")
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
        q = sb.table("joint_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if iso:     q = q.eq("iso_drawing", iso)
        if subarea: q = q.eq("sub_area",    subarea)
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
    ISO Drawing summary with server-side filtering.
    Supports: ?system=HP&unit=B1&area=MB+%231&show_all=true
    When filters are provided, queries DB directly (no cache).
    When no filters, uses 5-min in-memory cache.
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
            print(f"[iso-summary] Aggregating from joint_master (system={f_system or 'ALL'}, unit={f_unit or 'ALL'}, area={f_area or 'ALL'})")
            offset = 0
            limit  = 3000
            jm_all = []
            while True:
                try:
                    q = sb.table("joint_master").select(
                        "unit,area,sub_area,system,line_no,iso_drawing,sf,size_inch,date_completed,completed"
                    )
                    # Server-side filters - same approach as /api/joints
                    if f_system:  q = q.eq("system",   f_system)
                    if f_unit:    q = q.eq("unit",     f_unit)
                    if f_area:    q = q.eq("area",     f_area)
                    if f_subarea: q = q.eq("sub_area", f_subarea)
                    chunk_res = q.range(offset, offset + limit - 1).execute()
                    chunk = chunk_res.data or []
                    jm_all.extend(chunk)
                    if len(chunk) < limit: break
                    offset += limit
                except Exception as e:
                    print(f"[iso-summary] Pagination error at offset {offset}: {e}")
                    break

            iso_map = {}
            for r in jm_all:
                iso = (r.get("iso_drawing") or "").strip()
                if not iso: continue
                if iso not in iso_map:
                    iso_map[iso] = {
                        "unit":           (r.get("unit")     or "").strip(),
                        "area":           (r.get("area")     or "").strip(),
                        "sub_area":       (r.get("sub_area") or "").strip(),
                        "system":         (r.get("system")   or "").strip(),
                        "line_no":        (r.get("line_no")  or "").strip(),
                        "iso_drawing":    iso,
                        "total_fab_di":   0.0,
                        "total_erect_di": 0.0,
                        "remain_fab_di":  0.0,
                        "remain_erect_di":0.0,
                    }
                sz = 0.0
                try: sz = float(r.get("size_inch") or 0)
                except: pass
                sf      = str(r.get("sf") or "").upper().strip()
                is_comp = bool(r.get("date_completed")) or (str(r.get("completed") or "").upper() in ["O", "TRUE", "Y"])
                if sf == "S" or "FAB" in sf:
                    iso_map[iso]["total_fab_di"] += sz
                    if not is_comp: iso_map[iso]["remain_fab_di"] += sz
                elif sf == "F" or "ERE" in sf or "FIELD" in sf:
                    iso_map[iso]["total_erect_di"] += sz
                    if not is_comp: iso_map[iso]["remain_erect_di"] += sz

            data = list(iso_map.values())
            # Cache only unfiltered full dataset
            if not has_filter:
                _iso_cache = {"time": now, "data": data}

        if not show_all:
            data = [r for r in data if (r.get("remain_fab_di", 0) > 0) or (r.get("remain_erect_di", 0) > 0)]

        data.sort(key=lambda x: str(x.get("iso_drawing", "")))
        return jsonify(data)
    except Exception as e:
        print(f"[iso-summary] Error: {e}")
        return jsonify([]), 200

# ══════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0",
            port=int(os.environ.get("PORT", 5000)))
