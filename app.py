import os
import io
import gc
import gzip
import threading
import time
from datetime import datetime
from flask import Flask, render_template, jsonify, request
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

# ── RPC data processing ────────────────────────────────────────────────
def _parse_rpc(raw):
    if not isinstance(raw, dict):
        raw = {}

    def first(v):
        if isinstance(v, list) and v: return v[0]
        if isinstance(v, dict) and v: return v
        return None

    def lst(v):
        return v if isinstance(v, list) else []

    def calc_pct(comp, total):
        c = comp or 0
        t = total or 0
        if t <= 0: return 0
        return round((c / t) * 100, 2)

    # 1. KPI processing
    kpi = first(raw.get("kpi"))
    if kpi:
        tdi  = kpi.get("total_di", 0) or 0
        cdi  = kpi.get("completed_di", 0) or 0
        fcdi = kpi.get("fab_completed_di", 0) or kpi.get("fab_di", 0) or 0
        ftdi = kpi.get("fab_total_di", 0) or 0
        ecdi = kpi.get("erect_completed_di", 0) or kpi.get("erect_di", 0) or 0
        etdi = kpi.get("erect_total_di", 0) or 0

        kpi["total_plan_di"]    = tdi
        kpi["completed_di"]     = cdi
        kpi["overall_pct"]      = calc_pct(cdi, tdi)
        kpi["progress_pct"]     = kpi["overall_pct"]
        kpi["fab_di"]           = fcdi
        kpi["fab_total_di"]     = ftdi
        kpi["fab_pct"]          = calc_pct(fcdi, ftdi)
        kpi["erect_di"]         = ecdi
        kpi["erect_total_di"]   = etdi
        kpi["erect_pct"]        = calc_pct(ecdi, etdi)
        kpi["remaining_di"]     = tdi - cdi
        kpi["report_date"]      = datetime.now().strftime("%Y-%m-%d")
        kpi["total_plan_joints"] = kpi.get("total_joints", 0)
        kpi["completed_plan_di"] = cdi

        # Unified Readiness: D/I 70%, Support 20%, Test 10%
        s_pct = calc_pct(kpi.get("support_comp"), kpi.get("support_total"))
        t_pct = calc_pct(kpi.get("testpkg_comp"), kpi.get("testpkg_total"))
        kpi["support_pct"]       = s_pct
        kpi["testpkg_pct"]       = t_pct
        kpi["unified_readiness"] = round((kpi["overall_pct"] * 0.7) + (s_pct * 0.2) + (t_pct * 0.1), 2)

    def inject_pct(arr):
        for item in arr:
            di_pct  = calc_pct(item.get("completed_di"), item.get("total_di"))
            sup_pct = calc_pct(item.get("support_comp"), item.get("support_total"))
            tst_pct = calc_pct(item.get("testpkg_comp"), item.get("testpkg_total"))
            item["progress_pct"]      = di_pct
            item["support_pct"]       = sup_pct
            item["testpkg_pct"]       = tst_pct
            # D/I 70%, Support 20%, Test 10% (consistent with KPI weights)
            item["unified_readiness"] = round(di_pct * 0.7 + sup_pct * 0.2 + tst_pct * 0.1, 2)
        return arr

    actual_raw    = lst(raw.get("weekly") or raw.get("act"))
    ep_actual_raw = lst(raw.get("ep_weekly") or raw.get("ep_act"))
    weeks_raw     = lst(raw.get("weeks") or raw.get("week_schedule"))

    all_weeks = {}
    a_wks = [int(a.get("week_no") or 0) for a in actual_raw if a.get("week_no")]
    # Limit to actual data range + small buffer (not a fixed 60)
    max_wk = (max(a_wks) + 6) if a_wks else 30

    # Pre-map week labels and dates from weeks_raw
    date_map      = {}   # week_no → week_label
    week_date_map = {}   # week_no → {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
    for w in weeks_raw:
        try:
            wno = int(w.get("week_no") or 0)
            sd  = w.get("week_start_date") or w.get("start_date")
            ed  = w.get("week_end_date")   or w.get("end_date")
            if wno and sd:
                dt      = datetime.strptime(str(sd)[:10], "%Y-%m-%d")
                year_wk = dt.isocalendar()[1]
                proj_wk = year_wk - 14
                date_map[wno]      = f"W{proj_wk}"
                week_date_map[wno] = {
                    "week_start": str(sd)[:10],
                    "week_end":   str(ed)[:10] if ed else str(sd)[:10],
                }
        except: continue

    for i in range(1, max_wk + 1):
        label = date_map.get(i, f"W{i}")
        dates = week_date_map.get(i, {"week_start": "", "week_end": ""})
        all_weeks[i] = {
            "week_no":      i,
            "week_label":   label,
            "week_start":   dates["week_start"],
            "week_end":     dates["week_end"],
            "completed_di": 0.0,
            "plan_di":      0.0,
            "fab_di":       0.0,
            "erect_di":     0.0,
            "cumul_actual": 0.0,
        }

    # Populate plan_di from actual_plan_agg
    actual_plan_agg = raw.get("actual_plan_agg") or {}
    if not isinstance(actual_plan_agg, dict): actual_plan_agg = {}
    for wk_str, agg in actual_plan_agg.items():
        try:
            wk = int(wk_str)
            if wk in all_weeks and isinstance(agg, dict):
                pfab   = float(agg.get("f", 0) or 0)
                perect = float(agg.get("e", 0) or 0)
                all_weeks[wk]["plan_di"] = pfab + perect
        except (ValueError, TypeError): continue

    # Weekly actual progress
    for a in actual_raw:
        try:
            wk = int(a.get("week_no") or 0)
            if wk in all_weeks:
                all_weeks[wk]["completed_di"] += float(a.get("completed_di", 0) or 0)
                all_weeks[wk]["fab_di"]       += float(a.get("fab_di", 0) or 0)
                all_weeks[wk]["erect_di"]     += float(a.get("erect_di", 0) or 0)
        except: continue

    # EP weekly
    ep_week_map = {}
    for a in ep_actual_raw:
        try:
            wk = int(a.get("week_no") or 0)
            if wk in all_weeks:
                ep_week_map[wk] = ep_week_map.get(wk, 0.0) + float(a.get("completed_di", 0) or 0)
        except: continue

    cum_a = ep_cum_a = 0.0
    final_weekly = []
    ep_weekly    = []
    for i in range(1, max_wk + 1):
        w = all_weeks[i]
        cum_a    += w["completed_di"]
        ep_c      = ep_week_map.get(i, 0.0)
        ep_cum_a += ep_c
        w["cumul_actual"] = round(cum_a, 2)
        final_weekly.append(w)
        ep_weekly.append({
            "week_no":     i,
            "week_label":  w["week_label"],
            "completed_di": ep_c,
            "cumul_actual": round(ep_cum_a, 2),
        })

    return {
        "kpi":             kpi,
        "ep_kpi":          raw.get("ep_kpi"),
        "ep_weekly":       ep_weekly,
        "ep_unit":         raw.get("ep_unit"),
        "ep_area":         raw.get("ep_area"),
        "ep_sys":          raw.get("ep_sys"),
        "weekly":          final_weekly,
        "systems":         inject_pct(lst(raw.get("systems") or raw.get("sys"))),
        "units":           inject_pct(lst(raw.get("units")   or raw.get("unit"))),
        "areas":           inject_pct(lst(raw.get("areas")   or raw.get("area"))),
        "subareas":        inject_pct(lst(raw.get("subareas") or raw.get("area"))),
        "meta":            first(raw.get("meta")) or {},
    }

# ── In-memory cache ──────────────────────────────────────────────────
_cache      = {}
_lock       = threading.Lock()
_building   = False
_build_fail = False
CACHE_TTL   = 900  # 15 minutes

def _build():
    global _building, _build_fail
    try:
        sb  = get_sb()
        raw = {}
        print("[cache] Background build started...")

        # ── Primary: get_dashboard_summary_v17 ──
        try:
            res = sb.rpc("get_dashboard_summary_v17", {}).execute()
            d17 = res.data
            del res  # free httpx response immediately
            if isinstance(d17, list) and d17: d17 = d17[0]

            if isinstance(d17, dict) and d17:
                print(f"[cache] v17 RPC OK. Keys: {list(d17.keys())}")
                kpi17 = d17.get("kpi")
                if kpi17:
                    raw["kpi"] = kpi17 if isinstance(kpi17, list) else [kpi17]

                raw["units"]    = d17.get("unit")   or []
                raw["areas"]    = d17.get("area")   or []
                raw["subareas"] = d17.get("subarea") or d17.get("area") or []
                raw["systems"]  = d17.get("sys")    or []
                for item in raw["systems"]:
                    if "plan_di" in item and "total_di" not in item:
                        item["total_di"] = item["plan_di"]

                raw["weekly"] = d17.get("act") or []
                raw["weeks"]  = d17.get("wk")  or []

                # Aggregate pi → actual_plan_agg {str(wk): {f, e}}
                plan_agg = {}
                for pi in (d17.get("pi") or []):
                    try:
                        wk  = int(pi.get("week_no") or 0)
                        fab = float(pi.get("plan_fab_di", 0) or 0)
                        ere = float(pi.get("plan_erect_di", 0) or 0)
                        if wk not in plan_agg: plan_agg[wk] = {"f": 0.0, "e": 0.0}
                        plan_agg[wk]["f"] += fab
                        plan_agg[wk]["e"] += ere
                    except (ValueError, TypeError): continue
                raw["actual_plan_agg"] = {str(k): v for k, v in plan_agg.items()}
                del plan_agg
            del d17  # free raw v17 dict after extraction
        except Exception as e:
            print(f"[cache] v17 RPC error: {e}")

        # ── Supplement: get_dashboard_aggregates_control_v2 ──
        try:
            res2 = sb.rpc("get_dashboard_aggregates_control_v2", {}).execute()
            d2   = res2.data
            del res2  # free httpx response immediately
            if isinstance(d2, list) and d2: d2 = d2[0]
            if isinstance(d2, dict):
                if d2.get("ep_act"):
                    raw["ep_weekly"] = d2["ep_act"]
                if d2.get("ep_kpi"):
                    val = d2["ep_kpi"]
                    raw["ep_kpi"] = [val] if isinstance(val, dict) else val
                if not raw.get("units") and d2.get("unit"):
                    raw["units"] = d2["unit"]
                if not raw.get("systems") and d2.get("sys"):
                    raw["systems"] = d2["sys"]
                    for item in raw["systems"]:
                        if "plan_di" in item and "total_di" not in item:
                            item["total_di"] = item["plan_di"]

                # Supplement weekly fab/erect breakdown from v2
                if d2.get("act") and raw.get("weekly"):
                    if not raw.get("weeks"):
                        try:
                            raw["weeks"] = sb.table("week_schedule").select("*").order("week_no").execute().data or []
                        except: pass

                    sched_map = {w["week_no"]: str(w["week_start_date"])[:10] for w in (raw.get("weeks") or [])}

                    # Build lookup maps ONCE (not inside the inner loop)
                    v2_date_map = {}
                    v2_wk_map   = {}
                    for a in (d2["act"] or []):
                        wn = a.get("week_no")
                        if wn:
                            v2_wk_map[int(wn)] = a
                            if wn in sched_map:
                                v2_date_map[sched_map[wn]] = a

                    for item in raw["weekly"]:
                        start_date = str(item.get("week_start") or "")[:10]
                        v2_item = v2_date_map.get(start_date)

                        if not v2_item:
                            wk = item.get("week_no")
                            if wk is None and "week_label" in item:
                                label = str(item["week_label"])
                                if label.startswith("W") and label[1:].isdigit():
                                    wk = int(label[1:])
                            if wk:
                                v2_item = v2_wk_map.get(int(wk))

                        if v2_item:
                            if not float(item.get("fab_di") or 0):
                                item["fab_di"] = v2_item.get("fab_di") or 0
                            if not float(item.get("erect_di") or 0):
                                item["erect_di"] = v2_item.get("erect_di") or 0

                del v2_date_map, v2_wk_map
            del d2  # free raw v2 dict after extraction
        except Exception as e2:
            print(f"[cache] v2 RPC error (non-critical): {e2}")

        # ── Week schedule fallback ──
        if not raw.get("weeks"):
            try:
                raw["weeks"] = sb.table("week_schedule").select("*").order("week_no").execute().data or []
                print(f"[cache] Fetched {len(raw['weeks'])} weeks from table")
            except Exception as we:
                print(f"[cache] week_schedule error: {we}")
                raw["weeks"] = []

        if not raw.get("kpi"):
            print("[cache] WARNING: kpi empty after all RPCs!")

        data = _parse_rpc(raw)
        del raw  # free the large raw dict — only processed data needed
        kpi_pct = (data.get("kpi") or {}).get("overall_pct", "N/A")
        with _lock:
            _cache["data"] = data
            _cache["time"] = time.time()
        _build_fail = False
        gc.collect()  # reclaim freed memory after cache build
        print(f"[cache] Build SUCCESS. Overall: {kpi_pct}%")
    except Exception as e:
        _build_fail = True
        print(f"[cache] CRITICAL BUILD ERROR: {e}")
        import traceback; traceback.print_exc()
    finally:
        _building = False


def get_cache(force=False):
    global _building, _build_fail
    with _lock:
        has  = "data" in _cache
        age  = time.time() - _cache.get("time", 0) if has else float("inf")

    stale = age > CACHE_TTL
    if has and not force and not stale:
        with _lock: return _cache["data"]

    with _lock:
        if not _building:
            _building = True
            threading.Thread(target=_build, daemon=True).start()

    # Return existing data (possibly stale) while rebuild runs
    with _lock: return _cache.get("data")


# ── Metadata ─────────────────────────────────────────────────────────
_meta_cache = {"time": 0, "data": None}

@app.route("/api/cache/clear")
def api_cache_clear():
    global _meta_cache, _building
    with _lock: _cache.clear()
    _meta_cache = {"time": 0, "data": None}
    print("[cache] All caches cleared - starting background rebuild")
    with _lock:
        if not _building:
            _building = True
            threading.Thread(target=_build, daemon=True).start()
    return jsonify({"status": "ok", "message": "All caches cleared, rebuild started"})

@app.route("/api/meta", methods=["GET"])
def api_meta():
    global _meta_cache
    now   = time.time()
    force = request.args.get("t") is not None
    if not force and _meta_cache["data"] and (now - _meta_cache["time"]) < 3600:
        return jsonify(_meta_cache["data"])
    try:
        sb       = get_sb()
        res      = sb.rpc("get_distinct_meta_v2", {}).execute()
        res_data = res.data or {"units": [], "systems": [], "areas": [], "sub_areas": []}
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
@app.route("/api/test")
def api_test():
    return jsonify({"status": "working", "time": time.time()})

@app.route("/api/dashboard")
def api_dashboard():
    data = get_cache()
    if data is None:
        return jsonify({"building": True}), 202
    return jsonify(data)

@app.route("/api/status")
def api_status():
    """Diagnostic endpoint – shows cache state and data availability."""
    with _lock:
        has  = "data" in _cache
        age  = round(time.time() - _cache.get("time", 0), 1) if has else None
        kpi  = (_cache.get("data") or {}).get("kpi") or {}
    return jsonify({
        "cache_ready":    has,
        "cache_age_sec":  age,
        "building":       _building,
        "build_failed":   _build_fail,
        "kpi_total_di":   kpi.get("total_plan_di"),
        "kpi_completed":  kpi.get("completed_di"),
        "kpi_overall_pct": kpi.get("overall_pct"),
    })

@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok", "uptime": "running"})

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
        phase   = request.args.get("phase",    "")
        insp    = request.args.get("inspection","")
        nde_only= request.args.get("nde_only", "")
        pkg     = request.args.get("package",  "")
        q = sb.table("joint_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if iso:     q = q.eq("iso_drawing", iso)
        if subarea: q = q.eq("sub_area",    subarea)
        if phase:   q = q.eq("phase",       phase)
        if insp:    q = q.eq("inspection",  insp)
        if pkg:     q = q.eq("package",     pkg)
        if nde_only == "true": q = q.in_("inspection", ["PT", "MT", "RT"])
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


# ── Weekly Last-Week System/SubArea Breakdown ─────────────────────────
@app.route("/api/weekly-last-breakdown")
def api_weekly_last_breakdown():
    try:
        sb = get_sb()
        # 1. Find the last date with completed joints
        last_row = sb.table("joint_master").select("date_completed") \
                     .not_.is_("date_completed", "null") \
                     .order("date_completed", desc=True).limit(1).execute().data
        if not last_row:
            return jsonify({"systems": [], "subareas": [], "week_label": "—", "week_start": "", "week_end": ""})
        last_date = str(last_row[0]["date_completed"])[:10]

        # 2. Find which week contains that date
        weeks = sb.table("week_schedule").select("week_no,week_start_date,week_end_date") \
                  .order("week_no", desc=True).execute().data or []
        last_week = None
        for w in weeks:
            ws = str(w.get("week_start_date") or "")[:10]
            we = str(w.get("week_end_date")   or "")[:10]
            if ws and we and ws <= last_date <= we:
                last_week = w
                break
        if not last_week:
            return jsonify({"systems": [], "subareas": [], "week_label": "—", "week_start": last_date, "week_end": last_date})

        ws_date = str(last_week["week_start_date"])[:10]
        we_date = str(last_week["week_end_date"])[:10]
        week_no = last_week["week_no"]

        # 3. Query joints completed in this week
        joints = sb.table("joint_master") \
                   .select("system,sub_area,sf,size_inch,mat") \
                   .gte("date_completed", ws_date) \
                   .lte("date_completed", we_date) \
                   .not_.is_("date_completed", "null") \
                   .execute().data or []

        # 4. Aggregate by system and sub_area and mat
        sys_map = {}
        sub_map = {}
        mat_map = {}
        for j in joints:
            sys = j.get("system") or "—"
            sub = j.get("sub_area") or "—"
            mat = j.get("mat") or "—"
            sf  = (j.get("sf") or "").upper()
            di  = float(j.get("size_inch") or 0)
            is_fab   = sf == "S" or "FAB" in sf
            is_erect = sf == "F" or "ERE" in sf or "FIELD" in sf
            for key, mapping in [(sys, sys_map), (sub, sub_map), (mat, mat_map)]:
                if key not in mapping:
                    mapping[key] = {"fab_di": 0.0, "erect_di": 0.0, "completed_di": 0.0}
                mapping[key]["completed_di"] += di
                if is_fab:   mapping[key]["fab_di"]   += di
                elif is_erect: mapping[key]["erect_di"] += di

        def to_list(mapping, key_field):
            return sorted(
                [{key_field: k, "fab_di": round(v["fab_di"],1),
                  "erect_di": round(v["erect_di"],1), "completed_di": round(v["completed_di"],1)}
                 for k, v in mapping.items()],
                key=lambda x: x[key_field]
            )

        return jsonify({
            "week_no":    week_no,
            "week_label": f"W{week_no}",
            "week_start": ws_date,
            "week_end":   we_date,
            "systems":    to_list(sys_map, "system"),
            "subareas":   to_list(sub_map, "sub_area"),
            "materials":  to_list(mat_map, "mat"),
        })
    except Exception as e:
        print(f"[weekly-breakdown] Error: {e}")
        return jsonify({"error": str(e)}), 500


# ── Welder Summary ────────────────────────────────────────────────────
@app.route("/api/welder-summary")
def api_welder_summary():
    try:
        sb  = get_sb()
        res = sb.rpc("get_welder_stats_v4", {
            "f_date_from": request.args.get("date_from", "").strip(),
            "f_date_to":   request.args.get("date_to",   "").strip(),
            "f_system":    request.args.get("system",    "").strip(),
            "f_welder":    request.args.get("welder",    "").strip()
        }).execute()
        return jsonify(res.data or {})
    except Exception as e:
        print(f"[welder-summary] Error: {e}")
        return jsonify({"error": str(e)}), 500


# ── Joint Master Bulk Import (Excel) ──────────────────────────────────
@app.route("/api/joints/import", methods=["POST"])
def api_joints_import():
    import pandas as pd
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400
        f   = request.files["file"]
        buf = io.BytesIO(f.read())
        df  = pd.read_excel(buf, dtype=str)
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

        records, skipped = [], 0
        for _, row in df.iterrows():
            rec = {}
            for col, db_col in FIELD_MAP.items():
                val = row.get(col)
                if val is None or (isinstance(val, float) and pd.isna(val)): val = None
                else: val = str(val).strip() or None
                rec[db_col] = val
            if not rec.get("iso_drawing"):
                skipped += 1; continue
            for num_col in ("size_inch", "di"):
                v = rec.get(num_col)
                if v:
                    try:   rec[num_col] = float(v)
                    except: rec[num_col] = None
            dc = rec.get("date_completed")
            if dc:
                try:
                    rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
                    rec["completed"]      = True
                except:
                    rec["date_completed"] = None
            else:
                rec["completed"] = False
            records.append(rec)

        if not records:
            return jsonify({"ok": False, "error": f"No valid rows (skipped {skipped})"}), 400

        sb = get_sb()
        inserted = 0
        for i in range(0, len(records), 500):
            sb.table("joint_master").insert(records[i:i + 500]).execute()
            inserted += len(records[i:i + 500])

        with _lock: _cache.clear()
        _meta_cache["time"] = 0
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})
    except Exception as e:
        print(f"[joints-import] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Sync Phase + Package from local Excel ─────────────────────────────
@app.route("/api/joints/sync-phase-package", methods=["POST"])
def api_joints_sync_phase_package():
    import openpyxl, os
    EXCEL_PATH = os.path.join(os.path.dirname(__file__), "Raw File", "BOP Piping Joint Master.xlsx")
    try:
        if not os.path.exists(EXCEL_PATH):
            return jsonify({"ok": False, "error": f"File not found: {EXCEL_PATH}"}), 404

        wb = openpyxl.load_workbook(EXCEL_PATH, read_only=True, data_only=True)
        ws = wb.active
        # Headers: System(0), Phase(1), Package(2), Unit(3), Area(4), Sub Area(5),
        #          Line No(6), ISO Drawing(7), Rev(8), Spool No(9), Bore(10),
        #          MAT(11), Size(12), S/F(13), Joint(14), ...
        rows_read = updated = skipped = 0
        sb = get_sb()

        batch = []
        for row in ws.iter_rows(min_row=2, values_only=True):
            iso = row[7]
            joint = row[14]
            phase = row[1]
            pkg   = row[2]
            if not iso or joint is None:
                skipped += 1
                continue
            rows_read += 1
            # Only update if phase or package has a value
            if not phase and not pkg:
                continue
            update = {}
            if phase: update["phase"]   = str(phase).strip()
            if pkg:   update["package"] = str(pkg).strip()
            batch.append((str(iso).strip(), str(int(joint)) if isinstance(joint, float) else str(joint).strip(), update))

        wb.close()

        # Update matching joints in DB
        for iso, joint_no, upd in batch:
            try:
                res = sb.table("joint_master") \
                    .update(upd) \
                    .eq("iso_drawing", iso) \
                    .eq("joint_no",    joint_no) \
                    .execute()
                if res.data:
                    updated += len(res.data)
            except Exception:
                pass

        with _lock: _cache.clear()
        return jsonify({"ok": True, "rows_read": rows_read, "updated": updated, "skipped": skipped})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Test Package Joints (joint-level inspection view) ──────────────────
@app.route("/api/testpkg-joints", methods=["GET"])
def api_testpkg_joints():
    try:
        sb      = get_sb()
        limit   = int(request.args.get("limit",  100))
        offset  = int(request.args.get("offset",   0))
        pkg     = request.args.get("package",  "").strip()
        system  = request.args.get("system",   "").strip()
        status  = request.args.get("status",   "").strip()

        q = sb.table("joint_master").select(
            "id,system,package,iso_drawing,joint_no,date_completed,"
            "vt_date,vt_result,"
            "inspection,mt_date,mt_result,pt_date,pt_result,"
            "rt_date,rt_result,pwht,pwht_date,pwht_result",
            count="exact"
        ).not_.is_("package", "null")

        if pkg:    q = q.eq("package", pkg)
        if system: q = q.eq("system",  system)

        res = q.order("package").order("iso_drawing").order("joint_no") \
               .range(offset, offset + limit - 1).execute()

        # Compute STATUS per row
        rows = []
        for r in (res.data or []):
            # Welding not done → always PENDING
            pending = not r.get("date_completed")
            if not pending:
                # VT: date entered but no result → PENDING
                if r.get("vt_date") and not r.get("vt_result"):
                    pending = True
                # NDE: date entered but no result → PENDING
                elif (r.get("mt_date") and not r.get("mt_result")) or \
                     (r.get("pt_date") and not r.get("pt_result")) or \
                     (r.get("rt_date") and not r.get("rt_result")):
                    pending = True
                # PWHT required but no result → PENDING
                elif r.get("pwht") == "Y" and not r.get("pwht_result"):
                    pending = True
            r["status"] = "PENDING" if pending else "Completed"
            rows.append(r)

        return jsonify({"data": rows, "count": res.count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Support Master CRUD ───────────────────────────────────────────────
@app.route("/api/support-master", methods=["GET"])
def api_support_get():
    try:
        sb      = get_sb()
        limit   = int(request.args.get("limit",  100))
        offset  = int(request.args.get("offset",   0))
        unit    = request.args.get("unit",     "").strip()
        system  = request.args.get("system",   "").strip()
        area    = request.args.get("area",     "").strip()
        subarea = request.args.get("sub_area", "").strip()
        status  = request.args.get("status",   "").strip()
        phase   = request.args.get("phase",    "").strip()
        iso     = request.args.get("iso",      "").strip()
        q = sb.table("support_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if area:    q = q.eq("area",        area)
        if subarea: q = q.eq("sub_area",    subarea)
        if phase:   q = q.eq("phase",       phase)
        if iso:     q = q.or_(f"iso_drawing.ilike.%{iso}%,support_drawing.ilike.%{iso}%")
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
        with _lock: _cache.clear()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/support-master/<int:rid>", methods=["DELETE"])
def api_support_delete(rid):
    try:
        get_sb().table("support_master").delete().eq("id", rid).execute()
        with _lock: _cache.clear()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/support-master/import", methods=["POST"])
def api_support_import():
    import pandas as pd
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400
        buf  = io.BytesIO(request.files["file"].read())
        df   = pd.read_excel(buf, dtype=str)
        # Normalize columns: remove trailing spaces, lower case, replace space with underscore
        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
        
        # Mapping for Support Master Excel columns to DB columns
        # Excel: ['no._', 'phase', 'unit', 'system', 'area', 'sub_area', 'support_drawing', 'revision', 'iso_drawubg', 'line_no', 'welder', 'actual_date', 'action']
        FIELD_MAP = {
            "phase": "phase",
            "unit": "unit",
            "system": "system",
            "area": "area",
            "sub_area": "sub_area",
            "support_drawing": "support_drawing",
            "revision": "revision",
            "iso_drawubg": "iso_drawing",
            "iso_drawing": "iso_drawing", # fallback
            "line_no": "line_no",
            "welder": "welder",
            "actual_date": "date_completed"
        }
        
        records, skipped = [], 0
        for _, row in df.iterrows():
            rec = {}
            for excel_col, db_col in FIELD_MAP.items():
                v = row.get(excel_col)
                if v is None or (isinstance(v, float) and pd.isna(v)): 
                    v = None
                else: 
                    v = str(v).strip() or None
                if v: rec[db_col] = v
            
            # Additional logic for date_completed and completed
            dc = rec.get("date_completed")
            if dc:
                try:
                    rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
                    rec["completed"]      = True
                except:
                    rec["date_completed"] = None
                    rec["completed"]      = False
            else:
                rec["completed"] = False
                
            if not rec.get("system") and not rec.get("support_drawing"):
                skipped += 1; continue
                
            records.append(rec)
            
        if not records:
            return jsonify({"ok": False, "error": f"No valid rows (skipped {skipped})"}), 400
            
        sb = get_sb()
        inserted = 0
        for i in range(0, len(records), 500):
            sb.table("support_master").insert(records[i:i+500]).execute()
            inserted += len(records[i:i+500])
        with _lock: _cache.clear()
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})
    except Exception as e:
        print(f"[support-import] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Test Package Master CRUD ──────────────────────────────────────────
@app.route("/api/testpkg-master", methods=["GET"])
def api_testpkg_get():
    try:
        sb      = get_sb()
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
        with _lock: _cache.clear()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/testpkg-master/<int:rid>", methods=["DELETE"])
def api_testpkg_delete(rid):
    try:
        get_sb().table("test_package_master").delete().eq("id", rid).execute()
        with _lock: _cache.clear()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/testpkg-master/import", methods=["POST"])
def api_testpkg_import():
    import pandas as pd
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400
        buf  = io.BytesIO(request.files["file"].read())
        df   = pd.read_excel(buf, dtype=str)
        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
        FIELDS   = ["system","sub_area","test_pkg","completed","date_completed","remark"]
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
                    rec["completed"]      = True
                except: rec["date_completed"] = None
            else:
                cmp_val = str(rec.get("completed") or "").upper()
                rec["completed"] = cmp_val in ("TRUE","Y","O","1")
            records.append(rec)
        if not records:
            return jsonify({"ok": False, "error": f"No valid rows (skipped {skipped})"}), 400
        sb = get_sb()
        inserted = 0
        for i in range(0, len(records), 500):
            sb.table("test_package_master").insert(records[i:i+500]).execute()
            inserted += len(records[i:i+500])
        with _lock: _cache.clear()
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Welder ID Import (from Welder tracking Excel) ─────────────────────
@app.route("/api/joints/import-welder", methods=["POST"])
def api_joints_import_welder():
    import pandas as pd
    try:
        if "file" not in request.files:
            return jsonify({"ok": False, "error": "No file uploaded"}), 400

        buf = io.BytesIO(request.files["file"].read())
        df  = pd.read_excel(buf, dtype=str)
        # Keep original column names (Chinese/English mix) — match by exact name
        df.columns = [str(c).strip() for c in df.columns]

        def norm_jno(v):
            """Normalise joint_no to plain integer string: '1.0' → '1', '01' → '1'."""
            try:    return str(int(float(str(v).strip())))
            except: return str(v).strip()

        # Collect (iso_drawing, joint_no, welder) tuples from Excel
        rows = []
        for _, row in df.iterrows():
            iso = str(row.get("ISO Drawing") or "").strip()
            jno = norm_jno(row.get("Joint") or "")
            wld = str(row.get("Root/ Hot Welder") or "").strip()
            if not iso or not jno or not wld or wld.lower() == "nan":
                continue
            rows.append((iso, jno, wld))

        if not rows:
            return jsonify({"ok": False, "error": "No valid welder rows found"}), 400

        # Fetch DB joints for every ISO Drawing referenced in the Excel
        sb   = get_sb()
        isos = list({r[0] for r in rows})
        db_joints = []
        for i in range(0, len(isos), 200):
            res = sb.table("joint_master") \
                    .select("id, iso_drawing, joint_no") \
                    .in_("iso_drawing", isos[i:i+200]) \
                    .execute()
            db_joints.extend(res.data or [])

        # Build lookup: (iso_drawing, normalised_joint_no) → id
        lookup = {
            (r["iso_drawing"], norm_jno(r["joint_no"])): r["id"]
            for r in db_joints
        }

        # Match Excel rows to DB IDs
        update_map  = {}   # id → welder
        not_found   = 0
        for iso, jno, wld in rows:
            jid = lookup.get((iso, jno))
            if jid:
                update_map[jid] = wld
            else:
                not_found += 1

        if not update_map:
            return jsonify({
                "ok": False,
                "error": f"No joints matched ({not_found} rows not found)"
            }), 400

        # Batch upsert: only update `welder` for matched IDs
        records = [{"id": jid, "welder": wld} for jid, wld in update_map.items()]
        for i in range(0, len(records), 500):
            sb.table("joint_master").upsert(records[i:i+500]).execute()

        with _lock: _cache.clear()
        return jsonify({
            "ok":       True,
            "updated":  len(update_map),
            "not_found": not_found,
        })
    except Exception as e:
        print(f"[import-welder] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Gzip compression for JSON API responses ─────────────────────────────────
@app.after_request
def compress_response(response):
    if (response.status_code == 200
            and response.content_type.startswith("application/json")
            and len(response.data) > 2048
            and "gzip" in request.headers.get("Accept-Encoding", "")):
        compressed = gzip.compress(response.data, compresslevel=6)
        if len(compressed) < len(response.data):
            response.data = compressed
            response.headers["Content-Encoding"] = "gzip"
            response.headers["Content-Length"] = len(compressed)
    return response

# ── Pre-warm cache on startup (works with both python app.py and gunicorn) ──
threading.Thread(target=_build, daemon=True).start()

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0",
            port=int(os.environ.get("PORT", 5001)))
