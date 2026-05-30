# -*- coding: utf-8 -*-
import os
import io
import gc
import gzip
import threading
import time
from datetime import datetime, timedelta
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
                    except Exception:
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
_sb_lock = threading.Lock()

def get_sb():
    """Singleton Supabase client. Re-creates on connection error."""
    global _sb
    with _sb_lock:
        if _sb is None:
            try:
                options = ClientOptions(schema="construction", postgrest_client_timeout=90)
                _sb = create_client(SUPABASE_URL, SUPABASE_KEY, options=options)
            except Exception as e:
                print(f"[supabase] connection failed: {e}")
                raise
    return _sb

def reset_sb():
    """Force re-create the Supabase client (for connection error recovery)."""
    global _sb
    with _sb_lock:
        _sb = None
    print("[supabase] client reset")

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
    kpi = first(raw.get("kpi")) or {}
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
_cache           = {}
_lock            = threading.Lock()
_building        = False
_build_fail      = False
_build_fail_time = 0          # epoch seconds when last build failed
BUILD_FAIL_RETRY_SEC = 60     # wait 60s before retrying after a failed build
CACHE_TTL        = 1200       # 20 minutes — minimize DB calls on Render free tier

def _extract_d17(d17, raw):
    """v17 RPC 응답에서 raw dict 채우기"""
    if isinstance(d17, list) and d17: d17 = d17[0]
    if not isinstance(d17, dict) or not d17: return False
    kpi17 = d17.get("kpi")
    if kpi17: raw["kpi"] = kpi17 if isinstance(kpi17, list) else [kpi17]
    raw["units"]    = d17.get("unit")    or []
    raw["areas"]    = d17.get("area")    or []
    raw["subareas"] = d17.get("subarea") or d17.get("area") or []
    raw["systems"]  = d17.get("sys")     or []
    for item in raw["systems"]:
        if "plan_di" in item and "total_di" not in item:
            item["total_di"] = item["plan_di"]
    raw["weekly"] = d17.get("act") or []
    raw["weeks"]  = d17.get("wk")  or []
    plan_agg = {}
    for pi in (d17.get("pi") or []):
        try:
            wk  = int(pi.get("week_no") or 0)
            fab = float(pi.get("plan_fab_di", 0) or 0)
            ere = float(pi.get("plan_erect_di", 0) or 0)
            if wk not in plan_agg: plan_agg[wk] = {"f": 0.0, "e": 0.0}
            plan_agg[wk]["f"] += fab; plan_agg[wk]["e"] += ere
        except (ValueError, TypeError): continue
    raw["actual_plan_agg"] = {str(k): v for k, v in plan_agg.items()}
    return True


def _extract_d2(d2, raw, sb):
    """v2 RPC 응답으로 raw dict 보완"""
    if isinstance(d2, list) and d2: d2 = d2[0]
    if not isinstance(d2, dict): return
    if d2.get("ep_act"):
        raw["ep_weekly"] = d2["ep_act"]
    if d2.get("ep_kpi"):
        val = d2["ep_kpi"]
        raw["ep_kpi"] = [val] if isinstance(val, dict) else val
    if not raw.get("units")   and d2.get("unit"): raw["units"]   = d2["unit"]
    if not raw.get("systems") and d2.get("sys"):
        raw["systems"] = d2["sys"]
        for item in raw["systems"]:
            if "plan_di" in item and "total_di" not in item:
                item["total_di"] = item["plan_di"]
    if d2.get("act") and raw.get("weekly"):
        if not raw.get("weeks"):
            try: raw["weeks"] = sb.table("week_schedule").select("*").order("week_no").execute().data or []
            except: pass
        sched_map = {w["week_no"]: str(w["week_start_date"])[:10] for w in (raw.get("weeks") or [])}
        v2_date_map, v2_wk_map = {}, {}
        for a in (d2["act"] or []):
            wn = a.get("week_no")
            if wn:
                v2_wk_map[int(wn)] = a
                if wn in sched_map: v2_date_map[sched_map[wn]] = a
        for item in raw["weekly"]:
            start_date = str(item.get("week_start") or "")[:10]
            v2_item = v2_date_map.get(start_date)
            if not v2_item:
                wk = item.get("week_no")
                if wk is None and "week_label" in item:
                    lbl = str(item["week_label"])
                    if lbl.startswith("W") and lbl[1:].isdigit(): wk = int(lbl[1:])
                if wk: v2_item = v2_wk_map.get(int(wk))
            if v2_item:
                if not float(item.get("fab_di") or 0):   item["fab_di"]   = v2_item.get("fab_di") or 0
                if not float(item.get("erect_di") or 0): item["erect_di"] = v2_item.get("erect_di") or 0


def _extract_ep(ep_data, raw):
    """EP aggregates RPC 응답으로 raw dict 보완"""
    if isinstance(ep_data, list) and ep_data: ep_data = ep_data[0]
    if not isinstance(ep_data, dict): return
    raw["ep_sys"]  = ep_data.get("ep_sys")  or []
    raw["ep_area"] = ep_data.get("ep_area") or []
    ep_wk = ep_data.get("ep_weekly") or []
    if ep_wk and not raw.get("ep_weekly"): raw["ep_weekly"] = ep_wk
    if not raw.get("ep_kpi") and raw.get("ep_sys"):
        tot  = round(sum(v.get("total_di",     0) for v in raw["ep_sys"]), 2)
        comp = round(sum(v.get("completed_di", 0) for v in raw["ep_sys"]), 2)
        raw["ep_kpi"] = [{"total_di": tot, "completed_di": comp}]


def _build():
    global _building, _build_fail, _build_fail_time
    try:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from datetime import timezone

        sb  = get_sb()
        raw = {}
        print("[cache] Background build started...")

        # ═══════════════════════════════════════════════════════════════
        # FAST PATH: Supabase dashboard_cache 테이블 읽기 (1~2초)
        # pg_cron이 5분마다 갱신 → Flask는 단순 SELECT만
        # ═══════════════════════════════════════════════════════════════
        cache_hit = False
        try:
            cr = sb.table("dashboard_cache").select("data,built_at").eq("cache_key", "main").execute()
            if cr.data:
                row      = cr.data[0]
                built_at = datetime.fromisoformat(row["built_at"].replace("Z", "+00:00"))
                age      = (datetime.now(timezone.utc) - built_at).total_seconds()
                if age < 7200:  # 2시간 이내 → 신선 (Render cold-start 대비 넉넉히)
                    combined = row["data"]
                    d17_raw  = combined.get("v17") or {}
                    d2_raw   = combined.get("v2")  or {}
                    ep_raw   = combined.get("ep")  or {}
                    wa_raw   = combined.get("wa")  or []

                    if _extract_d17(d17_raw, raw):
                        _extract_d2(d2_raw, raw, sb)
                        _extract_ep(ep_raw, raw)
                        # weekly actuals 보완
                        if isinstance(wa_raw, list) and wa_raw:
                            wa_map = {int(w["week_no"]): w for w in wa_raw if w.get("week_no")}
                            for item in (raw.get("weekly") or []):
                                wno = int(item.get("week_no") or 0)
                                if wno in wa_map:
                                    m = wa_map[wno]
                                    item["completed_di"] = m.get("completed_di", item.get("completed_di", 0))
                                    item["fab_di"]       = m.get("fab_di",       item.get("fab_di", 0))
                                    item["erect_di"]     = m.get("erect_di",     item.get("erect_di", 0))
                            existing = {int(i.get("week_no") or 0) for i in (raw.get("weekly") or [])}
                            for wno, w in sorted(wa_map.items()):
                                if wno not in existing:
                                    (raw.setdefault("weekly", [])).append(w)
                            if raw.get("weekly"):
                                raw["weekly"].sort(key=lambda x: int(x.get("week_no") or 0))
                        cache_hit = True
                        print(f"[cache] DB cache HIT (age={age:.0f}s) - skipping RPCs")
        except Exception as ce:
            print(f"[cache] DB cache miss: {ce}")

        # ═══════════════════════════════════════════════════════════════
        # FALLBACK PATH: 병렬 RPC 호출 (캐시 미스 시)
        # ThreadPoolExecutor → v17, v2, EP 동시 실행 → 최장 RPC만 기다림
        # ═══════════════════════════════════════════════════════════════
        if not cache_hit:
            print("[cache] DB cache MISS - running parallel RPCs...")
            def _fetch_v17(): return sb.rpc("get_dashboard_summary_v17", {}).execute()
            def _fetch_v2():  return sb.rpc("get_dashboard_aggregates_control_v2", {}).execute()
            def _fetch_ep():  return sb.rpc("get_ep_aggregates", {}).execute()

            # ── non-blocking executor: shutdown(wait=False) prevents hanging
            #    when a slow RPC exceeds timeout but the thread keeps running ──
            ex = ThreadPoolExecutor(max_workers=3)
            try:
                fut_v17 = ex.submit(_fetch_v17)
                fut_v2  = ex.submit(_fetch_v2)
                fut_ep  = ex.submit(_fetch_ep)

                # v17 (필수) — 90s hard limit
                try:
                    res = fut_v17.result(timeout=90)
                    d17 = res.data; del res
                    if not _extract_d17(d17, raw): raise ValueError("v17 returned empty")
                    del d17
                    print("[cache] v17 parallel OK")
                except Exception as e:
                    raise Exception("Primary RPC (v17) failed. Aborting.") from e

                # v2 (보완) — 45s
                try:
                    res2 = fut_v2.result(timeout=45)
                    d2 = res2.data; del res2
                    _extract_d2(d2, raw, sb); del d2
                    print("[cache] v2 parallel OK")
                except Exception as e2:
                    print(f"[cache] v2 RPC error (non-critical): {e2}")

                # EP aggregates (보완) — 45s
                try:
                    res_ep = fut_ep.result(timeout=45)
                    ep_data = res_ep.data; del res_ep
                    _extract_ep(ep_data, raw); del ep_data
                    print("[cache] EP parallel OK")
                except Exception as ep_e:
                    print(f"[cache] EP RPC error (non-critical): {ep_e}")
            finally:
                # 느린 RPC 스레드가 남아있어도 _build() 블로킹 방지
                ex.shutdown(wait=False, cancel_futures=True)

        # ── Week schedule fallback ──────────────────────────────────────
        if not raw.get("weeks"):
            try:
                raw["weeks"] = sb.table("week_schedule").select("*").order("week_no").execute().data or []
            except Exception as we:
                print(f"[cache] week_schedule error: {we}")
                raw["weeks"] = []

        if not raw.get("kpi"):
            print("[cache] WARNING: kpi empty after all RPCs!")

        # ── Support & TestPkg aggregates → inject into kpi (supplements fields not in v17 RPC) ──
        try:
            # support_master: completed = True or date_completed present
            sr = sb.table("support_master").select("completed, date_completed").execute()
            s_rows = sr.data or []
            del sr
            s_total = len(s_rows)
            s_comp  = sum(1 for x in s_rows if x.get("completed") == True or x.get("date_completed"))
            del s_rows

            # test_package_master — status 컬럼 없음, completed/date_completed으로 판단
            tr = sb.table("test_package_master").select("completed, date_completed").execute()
            t_rows = tr.data or []
            del tr
            t_total = len(t_rows)
            t_comp  = sum(1 for x in t_rows if x.get("completed") == True or x.get("date_completed"))
            del t_rows

            # Inject into the first item of the kpi list
            kpi_list = raw.get("kpi")
            if isinstance(kpi_list, list) and kpi_list:
                kpi_list[0]["support_total"] = s_total
                kpi_list[0]["support_comp"]  = s_comp
                kpi_list[0]["testpkg_total"] = t_total
                kpi_list[0]["testpkg_comp"]  = t_comp
            elif isinstance(kpi_list, dict):
                kpi_list["support_total"] = s_total
                kpi_list["support_comp"]  = s_comp
                kpi_list["testpkg_total"] = t_total
                kpi_list["testpkg_comp"]  = t_comp
            print(f"[cache] Support {s_comp}/{s_total}, TestPkg {t_comp}/{t_total}")
        except Exception as sp_e:
            print(f"[cache] support/testpkg agg error (non-critical): {sp_e}")

        data = _parse_rpc(raw)

        del raw  # free the large raw dict — only processed data needed
        kpi_pct = (data.get("kpi") or {}).get("overall_pct", "N/A")
        
        # Populate _meta_cache safely
        try:
            m_units = sorted(list(set(u.get("unit") for u in (data.get("units") or []) if isinstance(u, dict) and u.get("unit"))))
            m_sys   = sorted(list(set(s.get("system") for s in (data.get("systems") or []) if isinstance(s, dict) and s.get("system"))))
            m_area  = sorted(list(set(a.get("area") for a in (data.get("areas") or []) if isinstance(a, dict) and a.get("area"))))
            m_sub   = sorted(list(set(a.get("sub_area") or a.get("subarea") or a.get("area") for a in (data.get("subareas") or []) if isinstance(a, dict) and (a.get("sub_area") or a.get("subarea") or a.get("area")))))
        except Exception as me:
            print(f"[cache] Meta extraction error: {me}")
            m_units, m_sys, m_area, m_sub = [], [], [], []
        
        global _meta_cache
        with _lock:
            _cache["data"] = data
            _cache["time"] = time.time()
            _meta_cache["data"] = {
                "units": m_units,
                "systems": m_sys,
                "areas": m_area,
                "sub_areas": m_sub
            }
            _meta_cache["time"] = time.time()
            
        _build_fail = False
        gc.collect()  # reclaim freed memory after cache build
        print(f"[cache] Build SUCCESS. Overall: {kpi_pct}%")
    except Exception as e:
        _build_fail = True
        _build_fail_time = time.time()
        print(f"[cache] CRITICAL BUILD ERROR: {e}")
        import traceback; traceback.print_exc()
    finally:
        _building = False


def get_cache(force=False):
    global _building, _build_fail, _build_fail_time
    with _lock:
        has  = "data" in _cache
        age  = time.time() - _cache.get("time", 0) if has else float("inf")

    stale = age > CACHE_TTL
    if has and not force and not stale:
        with _lock: return _cache["data"]

    with _lock:
        if not _building:
            now = time.time()
            # If last build failed recently, wait for cooldown before retrying
            if _build_fail and (now - _build_fail_time) < BUILD_FAIL_RETRY_SEC:
                pass  # skip — too soon after last failure
            else:
                _build_fail = False  # reset flag before new attempt
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
    global _meta_cache, _building
    now   = time.time()
    force = False  # Disabled ?t= to prevent blocking Gunicorn thread
    if not force and _meta_cache.get("data") and (now - _meta_cache["time"]) < 3600:
        return jsonify(_meta_cache["data"])
    
    # If not in cache, _build() will populate it eventually.
    # We should just return 202 instead of blocking the thread.
    return jsonify({"building": True, "message": "Meta data is building..."}), 202

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
        # Build permanently failed and cooldown hasn't expired yet → tell client to show error
        if _build_fail and not _building:
            wait_left = max(0, round(BUILD_FAIL_RETRY_SEC - (time.time() - _build_fail_time)))
            return jsonify({
                "build_failed": True,
                "message": f"Cache build failed. Auto-retry in {wait_left}s. Check server logs.",
            }), 503
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

@app.route("/api/weekly-actuals")
def api_weekly_actuals():
    """date_completed 기준 주간 실적 집계 — 별도 호출로 캐시 빌드 비블로킹"""
    try:
        res = get_sb().rpc("get_weekly_actuals", {}).execute()
        data = res.data
        if isinstance(data, list) and data and not isinstance(data[0], dict):
            data = data[0]
        return jsonify(data or [])
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/refresh-db-cache")
def api_refresh_db_cache():
    """Supabase dashboard_cache 갱신 후 Flask 캐시 재빌드 트리거.
    GitHub Actions keep-alive에서 호출 → pg_cron 대체."""
    global _build_fail, _building
    try:
        # 1. DB 내부에서 집계 (refresh_dashboard_cache RPC)
        get_sb().rpc("refresh_dashboard_cache", {}).execute()
        # 2. Flask 인메모리 캐시 초기화 → 다음 요청 시 DB cache 읽기 (1~2초)
        with _lock:
            _cache.clear()
            _build_fail = False
            if not _building:
                _building = True
                threading.Thread(target=_build, daemon=True).start()
                rebuild_started = True
            else:
                rebuild_started = False
        return jsonify({"ok": True, "message": "DB cache refreshed, Flask rebuild started" if rebuild_started else "DB cache refreshed, build already in progress"})
    except Exception as e:
        print(f"[refresh-db-cache] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

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
        welder  = request.args.get("welder",   "")
        q = sb.table("joint_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if iso:     q = q.ilike("iso_drawing", f"%{iso}%")
        if subarea: q = q.eq("sub_area",    subarea)
        if phase:   q = q.eq("phase",       phase)
        if insp:    q = q.eq("inspection",  insp)
        if pkg:     q = q.eq("package",     pkg)
        if welder:  q = q.ilike("welder",   f"%{welder}%")
        if nde_only == "true":
            q = q.or_("pt_date.not.is.null,mt_date.not.is.null,rt_date.not.is.null,pwht_date.not.is.null")
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


# ── Welder Stats Fallback (direct DB computation) ─────────────────────
def _welder_stats_fallback(date_from="", date_to="", system="", welder=""):
    """Compute welder stats directly from joint_master when RPC unavailable."""
    from collections import defaultdict
    from datetime import datetime

    sb = get_sb()
    q = (sb.table("joint_master")
           .select("welder, date_completed, di, system")
           .not_.is_("date_completed", "null")
           .not_.is_("welder", "null"))
    if date_from: q = q.gte("date_completed", date_from)
    if date_to:   q = q.lte("date_completed", date_to)
    if system:    q = q.eq("system", system)
    if welder:    q = q.ilike("welder", f"%{welder}%")
    rows = q.execute().data or []

    # Per-welder aggregates
    w_joints = defaultdict(int)
    w_di     = defaultdict(float)
    w_dates  = defaultdict(set)
    # Weekly / monthly totals
    weekly_jo  = defaultdict(int)
    weekly_di  = defaultdict(float)
    weekly_ws  = defaultdict(set)
    weekly_num = {}          # week_key → numeric sort key
    monthly_jo = defaultdict(int)
    monthly_di = defaultdict(float)
    monthly_ws = defaultdict(set)
    # Last-week / last-month tracking
    week_welder_jo = defaultdict(lambda: defaultdict(int))
    week_welder_di = defaultdict(lambda: defaultdict(float))
    month_welder_jo = defaultdict(lambda: defaultdict(int))
    month_welder_di = defaultdict(lambda: defaultdict(float))

    for row in rows:
        weld_raw = (row.get("welder") or "").strip()
        date_str = str(row.get("date_completed") or "")[:10]
        di_val   = float(row.get("di") or 0)
        if not weld_raw or not date_str:
            continue
        welders_list = [w.strip() for w in weld_raw.split("/") if w.strip()]
        if not welders_list:
            continue
        di_each = di_val / len(welders_list)
        try:
            dt   = datetime.strptime(date_str, "%Y-%m-%d")
            iso  = dt.isocalendar()
            wk   = f"{iso[0]}-W{iso[1]:02d}"
            mo   = date_str[:7]
            wk_n = iso[0] * 100 + iso[1]
        except Exception:
            continue

        for w in welders_list:
            w_joints[w] += 1
            w_di[w]     += di_each
            w_dates[w].add(date_str)
            week_welder_jo[wk][w]  += 1
            week_welder_di[wk][w]  += di_each
            month_welder_jo[mo][w] += 1
            month_welder_di[mo][w] += di_each

        weekly_jo[wk]  += 1
        weekly_di[wk]  += di_val
        weekly_ws[wk].update(welders_list)
        weekly_num[wk]  = wk_n
        monthly_jo[mo] += 1
        monthly_di[mo] += di_val
        monthly_ws[mo].update(welders_list)

    # Build ranking
    ranking = []
    for w in w_joints:
        active_days = max(len(w_dates[w]), 1)
        ranking.append({
            "welder":         w,
            "joints":         w_joints[w],
            "total_di":       round(w_di[w], 1),
            "avg_di_per_day": round(w_di[w] / active_days, 2),
            "active_days":    active_days,
        })
    ranking.sort(key=lambda x: x["avg_di_per_day"], reverse=True)

    # Build weekly list (sorted chronologically)
    weekly_list = []
    for wk in sorted(weekly_num, key=lambda k: weekly_num[k]):
        wc = len(weekly_ws[wk])
        weekly_list.append({
            "week_no":           weekly_num[wk],
            "week_label":        wk,
            "joints":            weekly_jo[wk],
            "total_di":          round(weekly_di[wk], 1),
            "avg_di_per_welder": round(weekly_di[wk] / wc, 2) if wc else 0,
        })

    # Build monthly list
    monthly_list = []
    for mo in sorted(monthly_jo):
        wc = len(monthly_ws[mo])
        monthly_list.append({
            "month":             mo,
            "joints":            monthly_jo[mo],
            "total_di":          round(monthly_di[mo], 1),
            "avg_di_per_welder": round(monthly_di[mo] / wc, 2) if wc else 0,
        })

    # Last active week / month per-welder
    def _per_welder_rows(wk_or_mo, jo_map, di_map, label_key, label_val):
        rows_out = []
        for w in jo_map[wk_or_mo]:
            active = max(len(w_dates[w]), 1)
            rows_out.append({
                label_key:        label_val,
                "welder":         w,
                "joints":         jo_map[wk_or_mo][w],
                "total_di":       round(di_map[wk_or_mo][w], 1),
                "avg_di_per_day": round(w_di[w] / active, 2),
            })
        rows_out.sort(key=lambda x: x["avg_di_per_day"], reverse=True)
        return rows_out

    last_week_rows, last_month_rows = [], []
    if weekly_list:
        last_wk = weekly_list[-1]["week_label"]
        last_week_rows = _per_welder_rows(last_wk, week_welder_jo, week_welder_di,
                                          "week_label", last_wk)
    if monthly_list:
        last_mo = monthly_list[-1]["month"]
        last_month_rows = _per_welder_rows(last_mo, month_welder_jo, month_welder_di,
                                           "month", last_mo)

    stats = {
        "active_welders": len(ranking),
        "total_joints":   sum(r["joints"] for r in ranking),
        "total_di":       round(sum(r["total_di"] for r in ranking), 1),
    }
    return {
        "stats":      stats,
        "ranking":    ranking,
        "weekly":     weekly_list,
        "monthly":    monthly_list,
        "last_week":  last_week_rows,
        "last_month": last_month_rows,
    }


# ── Welder Summary ────────────────────────────────────────────────────
@app.route("/api/welder-summary")
def api_welder_summary():
    date_from = request.args.get("date_from", "").strip()
    date_to   = request.args.get("date_to",   "").strip()
    sys_      = request.args.get("system",    "").strip()
    wld       = request.args.get("welder",    "").strip()
    try:
        sb  = get_sb()
        res = sb.rpc("get_welder_stats_v4", {
            "f_date_from": date_from,
            "f_date_to":   date_to,
            "f_system":    sys_,
            "f_welder":    wld
        }).execute()
        data = res.data
        # RPC must return a dict; if it returns something else, fall through
        if isinstance(data, dict) and data:
            return jsonify(data)
        raise ValueError("RPC returned empty or unexpected result")
    except Exception as rpc_err:
        print(f"[welder-summary] RPC failed ({rpc_err}), using Python fallback")
        try:
            return jsonify(_welder_stats_fallback(date_from, date_to, sys_, wld))
        except Exception as e:
            print(f"[welder-summary] Fallback failed: {e}")
            return jsonify({"error": str(e)}), 500


# ── Welder Daily Stats ─────────────────────────────────────────────────
@app.route("/api/welder-daily")
def api_welder_daily():
    try:
        from datetime import date as _date, timedelta
        from collections import defaultdict
        sb  = get_sb()
        cutoff = (_date.today() - timedelta(days=120)).isoformat()
        res = sb.table("joint_master") \
            .select("date_completed, welder, di") \
            .gte("date_completed", cutoff) \
            .not_.is_("date_completed", "null") \
            .not_.is_("welder", "null") \
            .execute()
        rows = res.data or []
        del res  # free response object immediately
        daily = defaultdict(lambda: {"welders": set(), "total_di": 0.0})
        for row in rows:
            day = str(row.get("date_completed") or "")[:10]
            wl  = (row.get("welder") or "").strip()
            if not day or not wl:
                continue
            for w in [x.strip() for x in wl.split("/") if x.strip()]:
                daily[day]["welders"].add(w)
            daily[day]["total_di"] += float(row.get("di") or 0)
        del rows  # free raw data immediately
        result = []
        for day in sorted(daily.keys(), reverse=True):
            d   = daily[day]
            wc  = len(d["welders"])
            tot = round(d["total_di"], 1)
            avg = round(tot / wc, 2) if wc > 0 else 0
            result.append({"day": day, "welder_count": wc, "total_di": tot, "avg_di_per_welder": avg})
        del daily
        return jsonify(result)
    except Exception as e:
        print(f"[welder-daily] Error: {e}")
        return jsonify([]), 500


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
        rows_read = updated = skipped = 0
        sb = get_sb()
        batch = []
        try:
            ws = wb.active
            # Headers: System(0), Phase(1), Package(2), Unit(3), Area(4), Sub Area(5),
            #          Line No(6), ISO Drawing(7), Rev(8), Spool No(9), Bore(10),
            #          MAT(11), Size(12), S/F(13), Joint(14), ...
            for row in ws.iter_rows(min_row=2, values_only=True):
                iso = row[7]
                joint = row[14]
                phase = row[1]
                pkg   = row[2]
                if not iso or joint is None:
                    skipped += 1
                    continue
                rows_read += 1
                if not phase and not pkg:
                    continue
                update = {}
                if phase: update["phase"]   = str(phase).strip()
                if pkg:   update["package"] = str(pkg).strip()
                batch.append((str(iso).strip(), str(int(joint)) if isinstance(joint, float) else str(joint).strip(), update))
        finally:
            wb.close()

        # ── Single bulk_update_phase_package() RPC call — eliminates N+1 queries ──
        # ISO+joint_no matching and UPDATE handled in DB → minimal Python memory usage
        rpc_payload = [
            {"iso": iso, "joint_no": joint_no,
             "phase": upd.get("phase"), "package": upd.get("package")}
            for iso, joint_no, upd in batch
        ]
        del batch

        rpc_used = False
        if rpc_payload:
            try:
                # Pass JSONB array to RPC in chunks of up to 2000
                for i in range(0, len(rpc_payload), 2000):
                    chunk = rpc_payload[i:i+2000]
                    res = sb.rpc("bulk_update_phase_package",
                                 {"updates": chunk}).execute()
                    updated += int(res.data or 0)
                    del res
                rpc_used = True
            except Exception as rpc_e:
                print(f"[sync] bulk_update_phase_package RPC failed, falling back to Python batch: {rpc_e}")

        # Fallback: Python batch upsert when RPC is not deployed
        if not rpc_used and rpc_payload:
            isos = list({r["iso"] for r in rpc_payload})
            db_rows = []
            for i in range(0, len(isos), 200):
                try:
                    r = sb.table("joint_master") \
                        .select("id, iso_drawing, joint_no") \
                        .in_("iso_drawing", isos[i:i+200]).execute()
                    db_rows.extend(r.data or [])
                    del r
                except Exception: pass

            def _norm(v):
                try: return str(int(float(str(v).strip())))
                except: return str(v).strip()
            lookup = {(row["iso_drawing"], _norm(row["joint_no"])): row["id"] for row in db_rows}
            del db_rows

            upsert_records = []
            for rec in rpc_payload:
                jid = lookup.get((rec["iso"], _norm(rec["joint_no"])))
                upd = {k: v for k, v in {"phase": rec["phase"], "package": rec["package"]}.items() if v}
                if jid and upd:
                    upsert_records.append({"id": jid, **upd})
            del lookup

            for i in range(0, len(upsert_records), 500):
                try:
                    res = sb.table("joint_master").upsert(upsert_records[i:i+500]).execute()
                    updated += len(res.data or [])
                    del res
                except Exception: pass
            del upsert_records

        del rpc_payload
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
        iso     = request.args.get("iso",      "").strip()

        q = sb.table("joint_master").select(
            "id,system,package,iso_drawing,joint_no,date_completed,"
            "vt_date,vt_result,"
            "inspection,mt_date,mt_result,pt_date,pt_result,"
            "rt_date,rt_result,rt_finding,rt_2_date,rt_2_result,pwht,pwht_date,pwht_result",
            count="exact"
        ).not_.is_("package", "null")

        if pkg:    q = q.ilike("package",     f"%{pkg}%")
        if iso:    q = q.ilike("iso_drawing", f"%{iso}%")
        if system: q = q.eq("system",  system)

        # status 필터: completed = vt_result=PASS + date_completed, pending = 그 외
        if status == "completed":
            q = q.not_.is_("date_completed", "null").eq("vt_result", "PASS")
        elif status == "pending":
            q = q.or_("date_completed.is.null,vt_result.neq.PASS,vt_result.is.null")

        res = q.order("package").order("iso_drawing").order("joint_no") \
               .range(offset, offset + limit - 1).execute()

        # Compute STATUS per row
        rows = []
        for r in (res.data or []):
            pending = True  # default PENDING

            if r.get("date_completed"):  # 용접 완료된 경우만 추가 판단
                has_nde  = any([r.get("mt_date"), r.get("pt_date"),
                                r.get("rt_date"), r.get("rt_2_date")])
                has_pwht = r.get("pwht") == "Y"

                # VT: date + result=PASS 필수
                vt_ok = bool(r.get("vt_date")) and r.get("vt_result") == "PASS"

                if not has_nde and not has_pwht:
                    # NDE/PWHT 요건 없음 → VT PASS만으로 Completed
                    pending = not vt_ok
                else:
                    # NDE/PWHT 요건 있음 → VT + NDE + PWHT 모두 PASS
                    nde_ok = True
                    if r.get("mt_date")   and r.get("mt_result")   != "PASS": nde_ok = False
                    if r.get("pt_date")   and r.get("pt_result")   != "PASS": nde_ok = False
                    if r.get("rt_date")   and r.get("rt_result")   != "PASS": nde_ok = False
                    if r.get("rt_2_date") and r.get("rt_2_result") != "PASS": nde_ok = False
                    pwht_ok = (not has_pwht) or (r.get("pwht_result") == "PASS")
                    pending = not (vt_ok and nde_ok and pwht_ok)

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
        pkg     = request.args.get("package", "").strip()
        iso     = request.args.get("iso",      "").strip()
        q = sb.table("support_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if area:    q = q.eq("area",        area)
        if subarea: q = q.eq("sub_area",    subarea)
        if phase:   q = q.eq("phase",       phase)
        if pkg:     q = q.ilike("package",  f"%{pkg}%")
        if iso:
            iso_s = iso.replace(",", "").replace("(", "").replace(")", "")
            q = q.or_(f"iso_drawing.ilike.%{iso_s}%,support_drawing.ilike.%{iso_s}%")
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


@app.route("/api/support-master/sync-phase-package", methods=["POST"])
def api_support_sync_phase_package():
    """joint_master의 iso_drawing으로 phase/package를 매칭해 support_master에 업데이트."""
    try:
        sb = get_sb()
        # 1. joint_master에서 iso_drawing별 phase/package 수집 (SELECT DISTINCT)
        jm_res = sb.table("joint_master").select("iso_drawing, phase, package") \
            .not_.is_("iso_drawing", "null").execute()
        iso_map = {}
        for row in (jm_res.data or []):
            iso = (row.get("iso_drawing") or "").strip()
            ph  = (row.get("phase")   or "").strip() or None
            pkg = (row.get("package") or "").strip() or None
            if iso and (ph or pkg):
                # 먼저 나온 값 우선
                if iso not in iso_map:
                    iso_map[iso] = {"phase": ph, "package": pkg}
                else:
                    if ph  and not iso_map[iso]["phase"]:   iso_map[iso]["phase"]   = ph
                    if pkg and not iso_map[iso]["package"]: iso_map[iso]["package"] = pkg
        del jm_res

        if not iso_map:
            return jsonify({"ok": False, "error": "joint_master에 phase/package 데이터 없음"}), 404

        # 2. support_master에서 iso_drawing이 있는 행 조회
        sm_res = sb.table("support_master").select("id, iso_drawing, phase, package") \
            .not_.is_("iso_drawing", "null").execute()
        sm_rows = sm_res.data or []
        del sm_res

        # Batch upsert — eliminates N individual UPDATE queries
        upsert_records = []
        for row in sm_rows:
            iso = (row.get("iso_drawing") or "").strip()
            if not iso or iso not in iso_map:
                continue
            mapped = iso_map[iso]
            patch = {"id": row["id"]}
            if mapped.get("phase")   and not row.get("phase"):   patch["phase"]   = mapped["phase"]
            if mapped.get("package") and not row.get("package"): patch["package"] = mapped["package"]
            if len(patch) > 1:  # has more than just "id"
                upsert_records.append(patch)

        updated = 0
        for i in range(0, len(upsert_records), 500):
            chunk = upsert_records[i:i + 500]
            try:
                sb.table("support_master").upsert(chunk).execute()
                updated += len(chunk)
            except Exception as ue:
                print(f"[sm-sync] upsert chunk error: {ue}")
        del upsert_records

        with _lock: _cache.clear()
        return jsonify({"ok": True, "updated": updated, "iso_matched": len(iso_map)})
    except Exception as e:
        print(f"[sm-sync-phase-pkg] Error: {e}")
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
        FIELDS = ["system", "sub_area", "test_pkg", "completed", "date_completed", "remark"]
        records, skipped = [], 0
        for _, row in df.iterrows():
            rec = {}
            for f in FIELDS:
                v = row.get(f)
                if v is None or (isinstance(v, float) and pd.isna(v)):
                    v = None
                else:
                    v = str(v).strip() or None
                rec[f] = v
            dc = rec.get("date_completed")
            if dc:
                try:
                    rec["date_completed"] = pd.to_datetime(dc).strftime("%Y-%m-%d")
                    rec["completed"] = True
                except Exception:
                    rec["date_completed"] = None
                    rec["completed"] = False
            else:
                rec["completed"] = False
            if not rec.get("system") and not rec.get("test_pkg"):
                skipped += 1
                continue
            records.append(rec)
        if not records:
            return jsonify({"ok": False, "error": f"No valid rows (skipped {skipped})"}), 400
        sb = get_sb()
        inserted = 0
        for i in range(0, len(records), 500):
            res = sb.table("test_package_master").insert(records[i:i+500]).execute()
            inserted += len(res.data or [])
            del res
        with _lock: _cache.clear()
        return jsonify({"ok": True, "imported": inserted, "skipped": skipped})
    except Exception as e:
        print(f"[testpkg-import] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.after_request
def compress_response(resp):
    if (resp.status_code == 200
            and resp.content_type.startswith("application/json")
            and resp.content_length
            and resp.content_length > 2048
            and "gzip" in request.headers.get("Accept-Encoding", "")):
        resp.data = gzip.compress(resp.data, compresslevel=6)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Content-Length"]   = len(resp.data)
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5005, debug=False)
