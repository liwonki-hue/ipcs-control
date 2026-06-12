# -*- coding: utf-8 -*-
import os
import gc
import gzip
import bisect
import threading
import time
from datetime import datetime, timedelta, timezone
from collections import defaultdict, Counter
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, render_template, jsonify, request
from supabase import create_client

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

def _sb_exec(fn):
    """Supabase 연결 오류(WinError 10060 등) 시 클라이언트 리셋 후 1회 재시도"""
    try:
        return fn(get_sb())
    except Exception as e:
        err = str(e)
        if "10060" in err or "WinError" in err or "ConnectionReset" in err or "timeout" in err.lower():
            print(f"[supabase] connection error, resetting client: {e}")
            reset_sb()
            return fn(get_sb())
        raise

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
                date_map[wno]      = f"W{wno}"
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
_ep_sup_cache: dict = {}      # /api/ep-support-summary 메모리 캐시
_pkg_stats_cache: dict = {}   # /api/testpkg-master readiness 계산 캐시
_pkg_cache: dict = {"time": 0, "data": {}}  # /api/joints/packages 시스템별 패키지 목록 캐시
_daily_cache: dict = {"time": 0, "data": None}      # /api/daily-actuals 5분 캐시
_wkbd_cache: dict  = {"time": 0, "data": None}      # /api/weekly-last-breakdown 5분 캐시

def _build_secondary_caches():
    """_build() 완료 후 보조 캐시 사전 로딩 — pkg_stats v2 와 pkg_list 병렬 실행"""
    global _pkg_stats_cache, _pkg_cache

    def _load_pkg_stats():
        try:
            rpc_res = _sb_exec(lambda sb: sb.rpc("get_pkg_readiness_stats_v2", {}).execute())
            data = {
                r["package"]: {
                    "piping_total":      int(r.get("piping_total",     0) or 0),
                    "piping_completed":  int(r.get("piping_completed", 0) or 0),
                    "support_total":     int(r.get("support_total",    0) or 0),
                    "support_installed": int(r.get("support_installed",0) or 0),
                }
                for r in (rpc_res.data or [])
            }
            with _lock:
                _pkg_stats_cache["data"] = data
                _pkg_stats_cache["time"] = time.time()
            print(f"[secondary_cache] pkg_stats v2: {len(data)} packages")
        except Exception as e:
            print(f"[secondary_cache] pkg_stats v2 fallback to v1: {e}")
            try:
                rpc_res = _sb_exec(lambda sb: sb.rpc("get_pkg_readiness_stats_v1", {}).execute())
                data = {
                    r["package"]: {
                        "piping_total":      int(r.get("total",     0) or 0),
                        "piping_completed":  int(r.get("completed", 0) or 0),
                        "support_total":     0,
                        "support_installed": 0,
                    }
                    for r in (rpc_res.data or [])
                }
                with _lock:
                    _pkg_stats_cache["data"] = data
                    _pkg_stats_cache["time"] = time.time()
                print(f"[secondary_cache] pkg_stats v1: {len(data)} packages")
            except Exception as e2:
                print(f"[secondary_cache] pkg_stats failed: {e2}")

    def _load_pkg_list():
        try:
            rpc_res = _sb_exec(lambda sb: sb.rpc("get_distinct_packages_v1", {}).execute())
            by_sys: dict = {}
            for r in (rpc_res.data or []):
                s = r.get("system") or ""
                p = r.get("package") or ""
                if p:
                    if s not in by_sys: by_sys[s] = set()
                    by_sys[s].add(p)
            with _lock:
                _pkg_cache["data"] = {s: sorted(v) for s, v in by_sys.items()}
                _pkg_cache["time"] = time.time()
            print(f"[secondary_cache] pkg_list: {len(_pkg_cache['data'])} systems")
        except Exception as e:
            print(f"[secondary_cache] pkg_list failed: {e}")

    with ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(_load_pkg_stats)
        f2 = ex.submit(_load_pkg_list)
        f1.result()
        f2.result()


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
                v2_fab   = float(v2_item.get("fab_di")   or 0)
                v2_erect = float(v2_item.get("erect_di") or 0)
                comp     = float(item.get("completed_di") or 0)
                # v2 plan data contaminates future weeks — only apply if plausible
                if comp > 0 and (v2_fab + v2_erect) <= comp * 2.0:
                    if not float(item.get("fab_di") or 0):   item["fab_di"]   = v2_fab
                    if not float(item.get("erect_di") or 0): item["erect_di"] = v2_erect


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
                try:
                    ex.shutdown(wait=False, cancel_futures=True)  # Python 3.9+
                except TypeError:
                    ex.shutdown(wait=False)  # Python 3.8

        # ── Week schedule fallback ──────────────────────────────────────
        if not raw.get("weeks"):
            try:
                raw["weeks"] = sb.table("week_schedule").select("*").order("week_no").execute().data or []
            except Exception as we:
                print(f"[cache] week_schedule error: {we}")
                raw["weeks"] = []

        if not raw.get("kpi"):
            print("[cache] WARNING: kpi empty after all RPCs!")

        # ── Support & TestPkg: per-system 병렬 집계 + KPI 총계 동시 계산 ──
        # 4개 별도 count 쿼리 대신 per-system 루프에서 합산하여 DB 왕복 4회 절약
        try:
            def _fetch_support_breakdown():
                tot = defaultdict(int); done = defaultdict(int)
                off = 0
                while True:
                    r = sb.table("support_master").select("system,date_completed") \
                          .range(off, off + 999).execute()
                    for row in (r.data or []):
                        s = row.get("system") or ""
                        tot[s] += 1
                        if row.get("date_completed"): done[s] += 1
                    if len(r.data or []) < 1000: break
                    off += 1000
                return tot, done

            def _fetch_test_breakdown():
                tot = defaultdict(int); done = defaultdict(int)
                off = 0
                while True:
                    r = sb.table("test_package_master").select("system,completed") \
                          .range(off, off + 999).execute()
                    for row in (r.data or []):
                        s = row.get("system") or ""
                        tot[s] += 1
                        if row.get("completed"): done[s] += 1
                    if len(r.data or []) < 1000: break
                    off += 1000
                return tot, done

            with ThreadPoolExecutor(max_workers=2) as _ex:
                _fut_sup = _ex.submit(_fetch_support_breakdown)
                _fut_tst = _ex.submit(_fetch_test_breakdown)
                _sup_s_tot, _sup_s_done = _fut_sup.result(timeout=60)
                _tst_s_tot, _tst_s_done = _fut_tst.result(timeout=60)

            s_total = sum(_sup_s_tot.values())
            s_comp  = sum(_sup_s_done.values())
            t_total = sum(_tst_s_tot.values())
            t_comp  = sum(_tst_s_done.values())

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

            for _item in (raw.get("systems") or []):
                _s = _item.get("system") or ""
                _item["support_total"] = _sup_s_tot.get(_s, 0)
                _item["support_comp"]  = _sup_s_done.get(_s, 0)
                _item["testpkg_total"] = _tst_s_tot.get(_s, 0)
                _item["testpkg_comp"]  = _tst_s_done.get(_s, 0)
            print(f"[cache] Support {s_comp}/{s_total}, TestPkg {t_comp}/{t_total}, systems={len(raw.get('systems', []))}")
        except Exception as sp_e:
            print(f"[cache] support/testpkg agg error (non-critical): {sp_e}")

        # ── KPI + weekly + breakdown override: 직접 joint_master에서 집계 ──
        # v17 RPC/dashboard_cache의 과소 집계를 보정.
        # date_completed IS NOT NULL 기준으로 직접 페이지네이션 집계.
        # system/unit/area/sub_area 별 completed_di도 함께 덮어씌워
        # Overview·Systems·Unit/Area 탭 수치를 Weekly 탭과 일치시킨다.
        try:
            wk_di_m    = defaultdict(float); wk_fab_m = defaultdict(float); wk_erect_m = defaultdict(float)
            sys_di_m   = defaultdict(float)  # per-system completed DI
            unit_di_m  = defaultdict(float)  # per-unit completed DI
            area_di_m  = defaultdict(float)  # per-area (MB #1 등) completed DI
            sub_di_m   = defaultdict(float)  # per-sub_area (CCWPH #1 등) completed DI

            # bisect 기반 O(log n) 주차 검색 (linear scan 대비 ~10x 빠름)
            _wk_raw = raw.get("weeks") or []
            _wk_sorted = sorted(
                [(str(w.get("week_start_date") or w.get("week_start") or "")[:10],
                  str(w.get("week_end_date")   or w.get("week_end")   or "")[:10],
                  w.get("week_no"))
                 for w in _wk_raw
                 if (w.get("week_start_date") or w.get("week_start"))],
                key=lambda x: x[0]
            )
            _wk_starts = [x[0] for x in _wk_sorted]

            def _wkno_for(d):
                idx = bisect.bisect_right(_wk_starts, d) - 1
                if idx >= 0 and _wk_sorted[idx][0] <= d <= _wk_sorted[idx][1]:
                    return _wk_sorted[idx][2]
                return None

            c_di = c_fab = c_erect = 0.0
            c_joints = 0
            off, bsz = 0, 1000
            while True:
                r = sb.table("joint_master").select("di,sf,date_completed,system,unit,area,sub_area") \
                      .not_.is_("date_completed", "null") \
                      .order("id").range(off, off + bsz - 1).execute()
                rows = r.data or []; del r
                for row in rows:
                    di  = float(row.get("di") or 0)
                    sf  = (row.get("sf") or "").upper()
                    dc  = str(row.get("date_completed") or "")[:10]
                    wno = _wkno_for(dc)
                    c_di += di
                    if   sf in ("S", "SHOP"):  c_fab   += di
                    elif sf in ("F", "FIELD"): c_erect += di
                    sys_di_m[row.get("system")   or ""] += di
                    unit_di_m[row.get("unit")    or ""] += di
                    area_di_m[row.get("area")    or ""] += di
                    sub_di_m[row.get("sub_area") or ""] += di
                    if wno:
                        wk_di_m[wno]    += di
                        if   sf in ("S", "SHOP"):  wk_fab_m[wno]   += di
                        elif sf in ("F", "FIELD"): wk_erect_m[wno] += di
                c_joints += len(rows)
                if len(rows) < bsz: break
                off += bsz

            if c_joints > 0:
                kpi_list = raw.get("kpi")
                if isinstance(kpi_list, list) and kpi_list:
                    kpi_list[0]["completed_di"]       = c_di
                    kpi_list[0]["completed_joints"]   = c_joints
                    kpi_list[0]["fab_completed_di"]   = c_fab
                    kpi_list[0]["erect_completed_di"] = c_erect

                if wk_di_m and raw.get("weekly"):
                    for item in raw["weekly"]:
                        wno = int(item.get("week_no") or 0)
                        if wno in wk_di_m:
                            item["completed_di"] = round(wk_di_m[wno], 2)
                            item["fab_di"]       = round(wk_fab_m.get(wno, 0.0), 2)
                            item["erect_di"]     = round(wk_erect_m.get(wno, 0.0), 2)

                # 시스템별 completed_di 덮어쓰기 — Overview·Systems 탭 일치
                for item in (raw.get("systems") or []):
                    s = item.get("system") or ""
                    if s in sys_di_m:
                        item["completed_di"] = round(sys_di_m[s], 2)

                # 유닛별 completed_di 덮어쓰기 — Unit/Area 탭 일치
                for item in (raw.get("units") or []):
                    u = item.get("unit") or ""
                    if u in unit_di_m:
                        item["completed_di"] = round(unit_di_m[u], 2)

                # 에리어·서브에리어별 completed_di 덮어쓰기
                for item in (raw.get("areas") or []):
                    a = item.get("area") or ""
                    if a in area_di_m:
                        item["completed_di"] = round(area_di_m[a], 2)
                for item in (raw.get("subareas") or []):
                    s = item.get("sub_area") or item.get("area") or ""
                    if s in sub_di_m:
                        item["completed_di"] = round(sub_di_m[s], 2)

            print(f"[cache] KPI override: DI={c_di:.1f}, fab={c_fab:.1f}, erect={c_erect:.1f}, joints={c_joints}, "
                  f"systems={len(sys_di_m)}, units={len(unit_di_m)}, subareas={len(sub_di_m)}")
        except Exception as _kpi_e:
            print(f"[cache] KPI override error (non-critical): {_kpi_e}")

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
        _build_secondary_caches()  # 빌드 완료 전 동기 실행 — 첫 요청부터 캐시 히트
    except Exception as e:
        with _lock:
            _build_fail = True
            _build_fail_time = time.time()
        print(f"[cache] CRITICAL BUILD ERROR: {e}")
        import traceback; traceback.print_exc()
    finally:
        with _lock:
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
    global _building
    with _lock:
        _cache.clear()
        _meta_cache["time"] = 0
        _meta_cache["data"] = None
        _ep_sup_cache.clear()
        _pkg_stats_cache.clear()
        _pkg_cache["time"] = 0
        _pkg_cache["data"] = {}
        _daily_cache["time"] = 0
        _daily_cache["data"] = None
        _wkbd_cache["time"] = 0
        _wkbd_cache["data"] = None
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
    """date_completed 기준 주간 실적 집계 — Python 직접 집계 (RPC erect=0 버그 우회)"""
    # Python fallback: joint_master + week_schedule 직접 집계
    try:
        sb = get_sb()
        cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

        # 최근 90일 완료 조인트
        j_res = sb.table("joint_master") \
            .select("date_completed,di,sf") \
            .gte("date_completed", cutoff) \
            .not_.is_("date_completed", "null") \
            .execute()
        joints = j_res.data or []
        del j_res
        if not joints:
            return jsonify([])

        min_d = min(str(j.get("date_completed") or "")[:10] for j in joints)

        # 해당 기간의 주차 스케줄 조회
        wk_res = sb.table("week_schedule") \
            .select("week_no,week_start_date,week_end_date") \
            .gte("week_end_date", min_d) \
            .order("week_no").execute()
        weeks = wk_res.data or []
        del wk_res

        wk_di    = defaultdict(float)
        wk_fab   = defaultdict(float)
        wk_erect = defaultdict(float)

        # O(log m) week lookup: sorted list of (start_date, end_date, week_no)
        wk_sorted = sorted(
            [(str(w["week_start_date"])[:10], str(w["week_end_date"])[:10], w["week_no"])
             for w in weeks if w.get("week_start_date") and w.get("week_end_date") and w.get("week_no")],
            key=lambda x: x[0]
        )
        wk_starts = [x[0] for x in wk_sorted]

        def _find_week(dc):
            idx = bisect.bisect_right(wk_starts, dc) - 1
            if idx >= 0 and wk_sorted[idx][0] <= dc <= wk_sorted[idx][1]:
                return wk_sorted[idx][2]
            return None

        for j in joints:
            dc = str(j.get("date_completed") or "")[:10]
            di = float(j.get("di") or 0)
            sf = (j.get("sf") or "").upper()
            wno = _find_week(dc)
            if wno:
                wk_di[wno] += di
                if sf in ("S", "SHOP"):
                    wk_fab[wno] += di
                elif sf in ("F", "FIELD"):
                    wk_erect[wno] += di
        del joints

        result = [
            {
                "week_no":      int(wno),
                "week_label":   f"W{wno}",
                "completed_di": round(wk_di[wno], 2),
                "fab_di":       round(wk_fab.get(wno, 0), 2),
                "erect_di":     round(wk_erect.get(wno, 0), 2),
            }
            for wno in sorted(wk_di)
        ]
        return jsonify(result)
    except Exception as e:
        print(f"[weekly-actuals] Fallback error: {e}")
        return jsonify([]), 500

@app.route("/api/daily-actuals")
def api_daily_actuals():
    """실제 작업 기록 기준 최근 5일간 일별 DI 실적 집계 — 5분 서버 캐시 + 연결 오류 재시도"""
    global _daily_cache
    with _lock:
        cached = _daily_cache.get("data")
        age    = time.time() - _daily_cache.get("time", 0)
    if cached is not None and age < 300:
        return jsonify(cached)
    try:
        # 실적이 있는 날짜만 최근 5일 추출 — 연결 오류 시 자동 재시도
        dates_res = _sb_exec(lambda sb: sb.table("joint_master")
            .select("date_completed")
            .not_.is_("date_completed", "null")
            .gt("di", 0)
            .order("date_completed", desc=True)
            .limit(500).execute())
        all_dates = dates_res.data or []
        del dates_res

        distinct_dates = sorted(set(
            str(r["date_completed"])[:10] for r in all_dates if r.get("date_completed")
        ))
        del all_dates

        if not distinct_dates:
            return jsonify({"date_start": None, "date_end": None, "data": []})

        last_5 = distinct_dates[-5:]
        range_start, range_end = last_5[0], last_5[-1]

        j_res = _sb_exec(lambda sb: sb.table("joint_master")
            .select("date_completed,di,sf")
            .gte("date_completed", range_start)
            .lte("date_completed", range_end)
            .not_.is_("date_completed", "null")
            .execute())
        joints = j_res.data or []
        del j_res

        day_di = defaultdict(float)
        day_fab = defaultdict(float)
        day_erect = defaultdict(float)
        for j in joints:
            dc = str(j.get("date_completed") or "")[:10]
            if dc not in last_5:
                continue
            di = float(j.get("di") or 0)
            sf = (j.get("sf") or "").upper()
            day_di[dc] += di
            if sf in ("S", "SHOP"):   day_fab[dc]   += di
            elif sf in ("F", "FIELD"): day_erect[dc] += di
        del joints

        result = {"date_start": range_start, "date_end": range_end, "data": [
            {"date": dc, "completed_di": round(day_di.get(dc,0),2),
             "fab_di": round(day_fab.get(dc,0),2), "erect_di": round(day_erect.get(dc,0),2)}
            for dc in last_5
        ]}
        with _lock:
            _daily_cache["data"] = result
            _daily_cache["time"] = time.time()
        return jsonify(result)
    except Exception as e:
        print(f"[daily-actuals] Error: {e}")
        if cached is not None:          # 오류 시 stale 캐시라도 반환
            return jsonify(cached)
        return jsonify({"date_start": None, "date_end": None, "data": []}), 500


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
        mat     = request.args.get("mat",      "")
        size    = request.args.get("size",     "")
        q = sb.table("joint_master").select("*", count="exact")
        if unit:    q = q.eq("unit",        unit)
        if system:  q = q.eq("system",      system)
        if iso:     q = q.ilike("iso_drawing", f"%{iso}%")
        if subarea: q = q.eq("sub_area",    subarea)
        if phase:   q = q.eq("phase",       phase)
        if insp:    q = q.eq("inspection",  insp)
        if pkg:     q = q.eq("package",     pkg)
        if welder:  q = q.ilike("welder",   f"%{welder}%")
        if mat:     q = q.eq("mat",          mat)
        pwht    = request.args.get("pwht",     "")
        if pwht:    q = q.eq("pwht",         pwht)
        if size:
            try:    q = q.eq("size_inch", float(size))
            except ValueError: pass
        if nde_only == "true":
            q = q.or_("inspection.in.(PT,MT,RT),pt_date.not.is.null,mt_date.not.is.null,rt_date.not.is.null,pwht_date.not.is.null")
        if status == "completed": q = q.not_.is_("date_completed", "null")
        if status == "pending":   q = q.is_("date_completed",      "null")
        res = q.order("id").range(offset, offset + limit - 1).execute()
        return jsonify({"data": res.data, "count": res.count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/joints/packages", methods=["GET"])
def api_joints_packages():
    """시스템별 distinct package 목록 반환 — 캐시 우선, 미스 시 RPC 단일 쿼리"""
    global _pkg_cache
    try:
        system = request.args.get("system", "").strip()
        now = time.time()

        with _lock:
            cached_data = _pkg_cache.get("data")
            cached_age  = now - _pkg_cache.get("time", 0)

        if cached_data and cached_age < 3600:
            return jsonify(cached_data.get(system, []))

        # 캐시 미스: RPC 단일 쿼리로 전체 패키지 목록 로딩
        sb = get_sb()
        try:
            rpc_res = sb.rpc("get_distinct_packages_v1", {}).execute()
            by_sys: dict = {}
            for r in (rpc_res.data or []):
                s = r.get("system") or ""
                p = r.get("package") or ""
                if p:
                    if s not in by_sys: by_sys[s] = set()
                    by_sys[s].add(p)
            with _lock:
                _pkg_cache["data"] = {s: sorted(v) for s, v in by_sys.items()}
                _pkg_cache["time"] = time.time()
            return jsonify(_pkg_cache["data"].get(system, []))
        except Exception:
            # fallback: per-system paginated query
            q = sb.table("joint_master").select("package").not_.is_("package", "null")
            if system:
                q = q.eq("system", system)
            rows, off = [], 0
            while True:
                r = q.range(off, off + 999).execute()
                rows.extend(r.data or [])
                if len(r.data or []) < 1000: break
                off += 1000
            return jsonify(sorted(set(r["package"] for r in rows if r.get("package"))))
    except Exception as e:
        return jsonify([])

@app.route("/api/joints/filter-values", methods=["GET"])
def api_joints_filter_values():
    col = request.args.get("col", "")
    ALLOWED = {"phase", "package", "system", "sub_area", "mat", "size_inch", "sf", "inspection", "pwht"}
    if col not in ALLOWED:
        return jsonify({"error": "invalid column"}), 400
    try:
        rows, off = [], 0
        while True:
            r = get_sb().table("joint_master").select(col).range(off, off + 999).execute()
            rows.extend(r.data or [])
            if len(r.data or []) < 1000: break
            off += 1000
        seen, vals = set(), []
        for r in rows:
            v = r.get(col)
            if v is not None and str(v) not in seen:
                seen.add(str(v)); vals.append(v)
        try:    vals.sort()
        except: vals.sort(key=str)
        return jsonify({"values": vals})
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
    """주간 breakdown 집계 — 5분 서버 캐시 + 연결 오류 재시도"""
    global _wkbd_cache
    with _lock:
        cached = _wkbd_cache.get("data")
        age    = time.time() - _wkbd_cache.get("time", 0)
    if cached is not None and age < 300:
        return jsonify(cached)
    try:
        # 1. Find the last date with completed joints — 연결 오류 시 재시도
        last_row = _sb_exec(lambda sb: sb.table("joint_master").select("date_completed")
                     .not_.is_("date_completed", "null")
                     .order("date_completed", desc=True).limit(1).execute()).data
        if not last_row:
            return jsonify({"systems": [], "subareas": [], "week_label": "—", "week_start": "", "week_end": ""})
        last_date = str(last_row[0]["date_completed"])[:10]

        # 2. Find which week contains that date
        wk_rows = _sb_exec(lambda sb: sb.table("week_schedule")
                    .select("week_no,week_start_date,week_end_date")
                    .lte("week_start_date", last_date)
                    .gte("week_end_date",   last_date)
                    .limit(1).execute()).data or []
        last_week = wk_rows[0] if wk_rows else None
        if not last_week:
            return jsonify({"systems": [], "subareas": [], "week_label": "—", "week_start": last_date, "week_end": last_date})

        ws_date = str(last_week["week_start_date"])[:10]
        we_date = str(last_week["week_end_date"])[:10]
        week_no = last_week["week_no"]

        # 3. Query joints completed in this week
        sb = get_sb()
        joints = []
        _q = sb.table("joint_master") \
               .select("system,sub_area,sf,size_inch,mat") \
               .gte("date_completed", ws_date) \
               .lte("date_completed", we_date) \
               .not_.is_("date_completed", "null")
        _off = 0
        while True:
            _page = _q.range(_off, _off + 999).execute().data or []
            joints.extend(_page)
            if len(_page) < 1000: break
            _off += 1000

        # 4. Aggregate
        sys_map, sub_map, mat_map = {}, {}, {}
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
                if is_fab:     mapping[key]["fab_di"]   += di
                elif is_erect: mapping[key]["erect_di"] += di

        for always_mat in ("ALLOY (P91)", "ALLOY (P22)", "ALLOY (P11)"):
            if always_mat not in mat_map:
                mat_map[always_mat] = {"fab_di": 0.0, "erect_di": 0.0, "completed_di": 0.0}

        def to_list(mapping, key_field):
            return sorted(
                [{key_field: k, "fab_di": round(v["fab_di"],1),
                  "erect_di": round(v["erect_di"],1), "completed_di": round(v["completed_di"],1)}
                 for k, v in mapping.items()],
                key=lambda x: x[key_field]
            )

        result = {
            "week_no":    week_no,
            "week_label": f"W{week_no}",
            "week_start": ws_date,
            "week_end":   we_date,
            "systems":    to_list(sys_map, "system"),
            "subareas":   to_list(sub_map, "sub_area"),
            "materials":  to_list(mat_map, "mat"),
        }
        with _lock:
            _wkbd_cache["data"] = result
            _wkbd_cache["time"] = time.time()
        return jsonify(result)
    except Exception as e:
        print(f"[weekly-breakdown] Error: {e}")
        if cached is not None:      # 오류 시 stale 캐시라도 반환
            return jsonify(cached)
        return jsonify({"error": str(e)}), 500


# ── Welder Stats Fallback (direct DB computation) ─────────────────────
def _welder_stats_fallback(date_from="", date_to="", system="", welder=""):
    """Compute welder stats directly from joint_master when RPC unavailable."""
    sb = get_sb()

    # week_schedule: bisect 기반 O(log n) 주차 탐색 (기존 선형 O(n) 교체)
    wk_sched = sb.table("week_schedule").select("week_no,week_start_date,week_end_date").order("week_no").execute().data or []
    _wk_sorted = sorted(
        [(str(w.get("week_start_date") or "")[:10],
          str(w.get("week_end_date")   or "")[:10],
          w.get("week_no"))
         for w in wk_sched if w.get("week_start_date")],
        key=lambda x: x[0]
    )
    _wk_starts = [x[0] for x in _wk_sorted]
    def _project_wkno(date_str):
        idx = bisect.bisect_right(_wk_starts, date_str) - 1
        if idx >= 0 and _wk_sorted[idx][0] <= date_str <= _wk_sorted[idx][1]:
            return _wk_sorted[idx][2]
        return None

    q = (sb.table("joint_master")
           .select("welder, date_completed, di, system")
           .not_.is_("date_completed", "null")
           .not_.is_("welder", "null"))
    if date_from: q = q.gte("date_completed", date_from)
    if date_to:   q = q.lte("date_completed", date_to)
    if system:    q = q.eq("system", system)
    if welder:    q = q.ilike("welder", f"%{welder}%")
    rows, off, bsz = [], 0, 1000
    while True:
        page = q.order("id").range(off, off + bsz - 1).execute().data or []
        rows.extend(page)
        if len(page) < bsz:
            break
        off += bsz

    # Per-welder aggregates
    w_joints = defaultdict(int)
    w_di     = defaultdict(float)
    w_dates  = defaultdict(set)
    # Weekly / monthly totals
    weekly_jo  = defaultdict(int)
    weekly_di  = defaultdict(float)
    weekly_ws    = defaultdict(set)
    weekly_dates = defaultdict(set)   # 주간 실제 작업일 수 계산용
    weekly_num   = {}                 # week_key → project week_no (정수)
    monthly_jo = defaultdict(int)
    monthly_di = defaultdict(float)
    monthly_ws = defaultdict(set)
    monthly_dates = defaultdict(set)
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
            mo = date_str[:7]
        except Exception:
            continue

        # project week_no로 매핑 (없으면 ISO 폴백)
        proj_wno = _project_wkno(date_str)
        if proj_wno is not None:
            wk   = f"W{proj_wno}"
            wk_n = proj_wno
        else:
            try:
                dt   = datetime.strptime(date_str, "%Y-%m-%d")
                iso  = dt.isocalendar()
                wk   = f"W{iso[1]}"
                wk_n = iso[1]
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

        weekly_jo[wk]   += 1
        weekly_di[wk]   += di_val
        weekly_ws[wk].update(welders_list)
        weekly_dates[wk].add(date_str)
        weekly_num[wk]   = wk_n
        monthly_jo[mo]  += 1
        monthly_di[mo]  += di_val
        monthly_ws[mo].update(welders_list)
        monthly_dates[mo].add(date_str)

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
        wc   = max(len(weekly_ws[wk]), 1)
        wdays= max(len(weekly_dates[wk]), 1)
        weekly_list.append({
            "week_no":           weekly_num[wk],
            "week_label":        wk,
            "joints":            weekly_jo[wk],
            "total_di":          round(weekly_di[wk], 1),
            "avg_di_per_welder": round(weekly_di[wk] / wc / wdays, 2),  # 일평균/용접사
        })

    # Build monthly list
    monthly_list = []
    for mo in sorted(monthly_jo):
        wc    = max(len(monthly_ws[mo]), 1)
        wdays = max(len(monthly_dates[mo]), 1)
        monthly_list.append({
            "month":             mo,
            "joints":            monthly_jo[mo],
            "total_di":          round(monthly_di[mo], 1),
            "avg_di_per_welder": round(monthly_di[mo] / wc / wdays, 2),  # 일평균/용접사
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
    def _add_fab_erect(data):
        """ranking 항목에 fab_di / erect_di 추가 (joint_master 직접 집계)."""
        try:
            sb2 = get_sb()
            q = sb2.table("joint_master").select("welder,sf,di") \
                   .not_.is_("date_completed", "null") \
                   .not_.is_("welder", "null")
            if date_from: q = q.gte("date_completed", date_from)
            if date_to:   q = q.lte("date_completed", date_to)
            if sys_:      q = q.eq("system", sys_)
            fab_map = {}; erect_map = {}
            off, bsz = 0, 1000
            while True:
                rows = q.order("id").range(off, off + bsz - 1).execute().data or []
                for row in rows:
                    wraw = (row.get("welder") or "").strip()
                    if not wraw: continue
                    di_val = float(row.get("di") or 0)
                    sf     = (row.get("sf") or "").upper()
                    wlist  = [w.strip() for w in wraw.split("/") if w.strip()]
                    di_each = di_val / len(wlist)
                    for w in wlist:
                        if sf in ("S", "SHOP"):
                            fab_map[w]   = fab_map.get(w, 0.0)   + di_each
                        elif sf in ("F", "FIELD"):
                            erect_map[w] = erect_map.get(w, 0.0) + di_each
                if len(rows) < bsz: break
                off += bsz
            for r in data.get("ranking", []):
                w = r.get("welder", "")
                r["fab_di"]   = round(fab_map.get(w, 0.0), 1)
                r["erect_di"] = round(erect_map.get(w, 0.0), 1)
        except Exception as e:
            print(f"[welder-summary] fab/erect merge failed: {e}")
        return data

    try:
        sb  = get_sb()
        res = sb.rpc("get_welder_stats_v4", {
            "f_date_from": date_from,
            "f_date_to":   date_to,
            "f_system":    sys_,
            "f_welder":    wld
        }).execute()
        data = res.data
        if isinstance(data, dict) and data:
            return jsonify(_add_fab_erect(data))
        raise ValueError("RPC returned empty or unexpected result")
    except Exception as rpc_err:
        print(f"[welder-summary] RPC failed ({rpc_err}), using Python fallback")
        try:
            return jsonify(_add_fab_erect(_welder_stats_fallback(date_from, date_to, sys_, wld)))
        except Exception as e:
            print(f"[welder-summary] Fallback failed: {e}")
            return jsonify({"error": str(e)}), 500


# ── Welder Daily Stats ─────────────────────────────────────────────────
@app.route("/api/welder-daily")
def api_welder_daily():
    try:
        sb  = get_sb()
        cutoff = (datetime.now() - timedelta(days=120)).strftime("%Y-%m-%d")
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


# ── Sync Phase + Package from local Excel ─────────────────────────────
@app.route("/api/joints/sync-phase-package", methods=["POST"])
def api_joints_sync_phase_package():
    import openpyxl
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


# ── Packages by System ────────────────────────────────────────────────
@app.route("/api/packages")
def api_packages():
    """시스템별 distinct Package 목록 반환 — Test PKG Master 드롭다운용"""
    system = request.args.get("system", "").strip()
    try:
        sb = get_sb()
        q  = sb.table("joint_master").select("package").not_.is_("package", "null")
        if system:
            q = q.eq("system", system)
        pkgs = set()
        off = 0
        while True:
            r = q.order("package").range(off, off + 999).execute()
            for row in (r.data or []):
                if row.get("package"):
                    pkgs.add(row["package"])
            if len(r.data or []) < 1000:
                break
            off += 1000
        return jsonify(sorted(pkgs))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
        welder  = request.args.get("welder",   "").strip()

        q = sb.table("joint_master").select(
            "id,system,package,iso_drawing,joint_no,date_completed,welder,"
            "vt_date,vt_result,"
            "inspection,mt_date,mt_result,pt_date,pt_result,"
            "rt_date,rt_result,rt_finding,rt_2_date,rt_2_result,pwht,pwht_date,pwht_result",
            count="exact"
        ).or_("package.not.is.null,inspection.in.(VT,RT)")

        if pkg:    q = q.ilike("package",     f"%{pkg}%")
        if iso:    q = q.ilike("iso_drawing", f"%{iso}%")
        if welder: q = q.ilike("welder",      f"%{welder}%")
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
                insp     = (r.get("inspection") or "").upper()
                has_pwht = r.get("pwht") == "Y"
                vt_ok    = bool(r.get("vt_date")) and r.get("vt_result") == "PASS"

                if insp == "RT":
                    # RT 조인트: VT PASS + RT PASS 둘 다 필수
                    rt_ok = bool(r.get("rt_date")) and r.get("rt_result") == "PASS"
                    pwht_ok = (not has_pwht) or (r.get("pwht_result") == "PASS")
                    pending = not (vt_ok and rt_ok and pwht_ok)
                elif insp in ("PT", "MT"):
                    # PT/MT 조인트: VT PASS + 해당 NDE PASS 필수
                    nde_ok = True
                    if insp == "PT" and (not r.get("pt_date") or r.get("pt_result") != "PASS"):
                        nde_ok = False
                    if insp == "MT" and (not r.get("mt_date") or r.get("mt_result") != "PASS"):
                        nde_ok = False
                    pwht_ok = (not has_pwht) or (r.get("pwht_result") == "PASS")
                    pending = not (vt_ok and nde_ok and pwht_ok)
                else:
                    # VT 전용 또는 inspection 없음: VT PASS만으로 Completed
                    has_any_nde = any([r.get("mt_date"), r.get("pt_date"),
                                       r.get("rt_date"), r.get("rt_2_date")])
                    if has_any_nde:
                        nde_ok = True
                        if r.get("mt_date")   and r.get("mt_result")   != "PASS": nde_ok = False
                        if r.get("pt_date")   and r.get("pt_result")   != "PASS": nde_ok = False
                        if r.get("rt_date")   and r.get("rt_result")   != "PASS": nde_ok = False
                        if r.get("rt_2_date") and r.get("rt_2_result") != "PASS": nde_ok = False
                        pwht_ok = (not has_pwht) or (r.get("pwht_result") == "PASS")
                        pending = not (vt_ok and nde_ok and pwht_ok)
                    else:
                        pwht_ok = (not has_pwht) or (r.get("pwht_result") == "PASS")
                        pending = not (vt_ok and pwht_ok)

            r["status"] = "PENDING" if pending else "Completed"
            rows.append(r)

        return jsonify({"data": rows, "count": res.count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── RT Quality Performance ─────────────────────────────────────────────
@app.route("/api/rt-quality")
def api_rt_quality():
    """RT 불량률 분석: 전체 KPI, 용접사별/시스템별/월별 repair rate, repair 상세 목록."""
    try:
        sb = get_sb()
        cols = ("id,system,sub_area,iso_drawing,joint_no,welder,sf,"
                "rt_date,rt_result,rt_finding,rt_2_date,rt_2_result,date_completed")

        # RT 촬영된 조인트 전체 수집 (rt_date 있는 행 대상)
        rows, offset_ = [], 0
        while True:
            res = (sb.table("joint_master")
                     .select(cols)
                     .not_.is_("rt_date", "null")
                     .order("rt_date")
                     .range(offset_, offset_ + 999)
                     .execute())
            batch = res.data or []
            rows.extend(batch)
            if len(batch) < 1000:
                break
            offset_ += 1000

        # KPI 집계
        total      = len(rows)
        first_pass = sum(1 for r in rows if r.get("rt_result") == "PASS")
        repair     = sum(1 for r in rows if r.get("rt_result") not in ("PASS", None, ""))
        second_pass = sum(1 for r in rows
                         if r.get("rt_result") not in ("PASS", None, "")
                         and r.get("rt_2_result") == "PASS")
        second_fail = repair - second_pass

        def pct(n, d):
            return round(n / d * 100, 1) if d else 0.0

        kpi = {
            "total_rt":     total,
            "first_pass":   first_pass,
            "repair":       repair,
            "repair_rate":  pct(repair, total),
            "second_pass":  second_pass,
            "second_fail":  second_fail,
        }

        # Remaining: repair 후 2nd RT 미촬영 건수
        remaining_total = sum(
            1 for r in rows
            if r.get("rt_result") not in ("PASS", None, "")
            and not r.get("rt_2_date")
        )
        kpi["remaining"] = remaining_total

        # 용접사별 집계 (Repair 건수 내림차순)
        w_tot  = defaultdict(int)
        w_pass = defaultdict(int)
        w_rep  = defaultdict(int)
        w_rem  = defaultdict(int)
        for r in rows:
            welders = [w.strip() for w in (r.get("welder") or "UNKNOWN").split("/") if w.strip()]
            if not welders:
                welders = ["UNKNOWN"]
            is_repair = r.get("rt_result") not in ("PASS", None, "")
            is_rem    = is_repair and not r.get("rt_2_date")
            for w in welders:
                w_tot[w]  += 1
                if not is_repair: w_pass[w] += 1
                if is_repair:     w_rep[w]  += 1
                if is_rem:        w_rem[w]  += 1
        by_welder = sorted(
            [{"welder": w, "total": w_tot[w], "pass": w_pass[w],
              "repair": w_rep[w], "remaining": w_rem[w],
              "repair_rate": pct(w_rep[w], w_tot[w])}
             for w in w_tot],
            key=lambda x: (-x["repair"], -x["repair_rate"])
        )
        welder_count = len(w_tot)

        # KPI에 welder_count 추가
        kpi["welder_count"] = welder_count

        # 기본 시스템 목록 (RT 데이터 없는 시스템도 포함)
        BASE_SYSTEMS = ["AS", "CCP", "CCW", "FG", "FW", "GT", "HP", "HRSG", "HW", "LP", "RW", "ST"]

        # 시스템별 집계 (Repair 건수 내림차순)
        s_tot  = defaultdict(int)
        s_pass = defaultdict(int)
        s_rep  = defaultdict(int)
        s_rem  = defaultdict(int)
        for r in rows:
            sys = r.get("system") or "—"
            is_repair = r.get("rt_result") not in ("PASS", None, "")
            is_rem    = is_repair and not r.get("rt_2_date")
            s_tot[sys]  += 1
            if not is_repair: s_pass[sys] += 1
            if is_repair:     s_rep[sys]  += 1
            if is_rem:        s_rem[sys]  += 1
        all_sys = set(s_tot.keys()) | set(BASE_SYSTEMS)
        by_system = sorted(
            [{"system": s, "total": s_tot.get(s, 0), "pass": s_pass.get(s, 0),
              "repair": s_rep.get(s, 0), "remaining": s_rem.get(s, 0),
              "repair_rate": pct(s_rep.get(s, 0), s_tot.get(s, 0))}
             for s in all_sys],
            key=lambda x: (-x["repair"], x["system"])
        )

        # 월별 집계
        m_tot = defaultdict(int)
        m_rep = defaultdict(int)
        for r in rows:
            dt = (r.get("rt_date") or "")[:7]  # YYYY-MM
            if not dt:
                continue
            m_tot[dt] += 1
            if r.get("rt_result") not in ("PASS", None, ""):
                m_rep[dt] += 1
        by_month = [
            {"month": m, "total": m_tot[m], "repair": m_rep[m],
             "repair_rate": pct(m_rep[m], m_tot[m])}
            for m in sorted(m_tot)
        ]

        # 불량 항목별 집계 (rt_finding, repair 건만)
        f_count = defaultdict(int)
        for r in rows:
            if r.get("rt_result") not in ("PASS", None, ""):
                finding = (r.get("rt_finding") or "Unknown").strip() or "Unknown"
                f_count[finding] += 1
        by_finding = sorted(
            [{"finding": f, "count": c} for f, c in f_count.items()],
            key=lambda x: -x["count"]
        )

        # Repair 상세 목록 (rt_result != PASS)
        repair_list = [
            {k: r.get(k) for k in
             ("id","system","sub_area","iso_drawing","joint_no","welder","sf",
              "rt_date","rt_result","rt_finding","rt_2_date","rt_2_result")}
            for r in rows if r.get("rt_result") not in ("PASS", None, "")
        ]

        return jsonify({
            "kpi":         kpi,
            "by_welder":   by_welder,
            "by_system":   by_system,
            "by_month":    by_month,
            "by_finding":  by_finding,
            "repair_list": repair_list,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Area별 Field DI / Support EA 집계 ─────────────────────────────────
@app.route("/api/area-field-quantities")
def api_area_field_quantities():
    """sub_area별 Field joints(sf='F') DI 합산 및 Support EA 카운트를 단일 호출로 반환."""
    TARGET_SUBS = [
        "PR #3", "PR #4", "PR #5", "PR #6", "PR #7",
        "MB STR", "HRSG #11 PR", "GT #11", "HRSG #12 PR", "GT #12"
    ]
    try:
        sb = get_sb()
        # Field DI: sf='F' 인 조인트만 집계 (배치 페이징)
        di_by_sub = {}
        batch, offset = 1000, 0
        while True:
            res = (sb.table("joint_master")
                     .select("sub_area, di")
                     .eq("sf", "F")
                     .in_("sub_area", TARGET_SUBS)
                     .range(offset, offset + batch - 1)
                     .execute())
            for row in res.data or []:
                sub = row.get("sub_area", "")
                di_by_sub[sub] = di_by_sub.get(sub, 0) + (row.get("di") or 0)
            if not res.data or len(res.data) < batch:
                break
            offset += batch

        # Support EA: 단일 쿼리로 sub_area 필터 후 Python에서 집계 (N+1 제거)
        ea_rows, ea_off = [], 0
        while True:
            r = (sb.table("support_master")
                   .select("sub_area")
                   .in_("sub_area", TARGET_SUBS)
                   .range(ea_off, ea_off + 999).execute())
            ea_rows.extend(r.data or [])
            if len(r.data or []) < 1000:
                break
            ea_off += 1000
        ea_by_sub = dict(Counter(r["sub_area"] for r in ea_rows if r.get("sub_area")))

        return jsonify({"di": di_by_sub, "ea": ea_by_sub})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Support Master CRUD ───────────────────────────────────────────────
@app.route("/api/ep-support-summary")
def api_ep_support_summary():
    global _ep_sup_cache
    with _lock:
        cached = _ep_sup_cache.get("data")
        if cached and time.time() - _ep_sup_cache.get("time", 0) < CACHE_TTL:
            return jsonify(cached)
    try:
        rows = get_sb().table("support_master").select("system,sub_area,area,date_completed").eq("phase","EP").execute().data or []
        sys_map, area_map, subarea_map = {}, {}, {}
        for r in rows:
            s, sa, ar = r.get("system",""), r.get("sub_area",""), r.get("area","")
            comp = 1 if r.get("date_completed") else 0
            sys_map.setdefault(s, {"system": s, "total_di": 0, "completed_di": 0})
            sys_map[s]["total_di"] += 1; sys_map[s]["completed_di"] += comp
            area_map.setdefault(sa, {"sub_area": sa, "area": ar, "total_di": 0, "completed_di": 0})
            area_map[sa]["total_di"] += 1; area_map[sa]["completed_di"] += comp
            if sa and ar: subarea_map[sa] = ar
        result = {"sys": list(sys_map.values()), "area": list(area_map.values()), "subarea_map": subarea_map}
        with _lock:
            _ep_sup_cache["data"] = result
            _ep_sup_cache["time"] = time.time()
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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

@app.route("/api/support-master/sync-phase-package", methods=["POST"])
def api_support_sync_phase_package():
    """joint_master의 iso_drawing으로 phase/package를 매칭해 support_master에 업데이트."""
    try:
        sb = get_sb()
        # 1. joint_master에서 iso_drawing별 phase/package 수집 (페이지네이션)
        iso_map = {}
        _joff = 0
        while True:
            jm_res = sb.table("joint_master").select("iso_drawing, phase, package") \
                .not_.is_("iso_drawing", "null").range(_joff, _joff + 999).execute()
            for row in (jm_res.data or []):
                iso = (row.get("iso_drawing") or "").strip()
                ph  = (row.get("phase")   or "").strip() or None
                pkg = (row.get("package") or "").strip() or None
                if iso and (ph or pkg):
                    if iso not in iso_map:
                        iso_map[iso] = {"phase": ph, "package": pkg}
                    else:
                        if ph  and not iso_map[iso]["phase"]:   iso_map[iso]["phase"]   = ph
                        if pkg and not iso_map[iso]["package"]: iso_map[iso]["package"] = pkg
            if len(jm_res.data or []) < 1000: del jm_res; break
            del jm_res
            _joff += 1000

        if not iso_map:
            return jsonify({"ok": False, "error": "joint_master에 phase/package 데이터 없음"}), 404

        # 2. support_master에서 iso_drawing이 있는 행 조회 (페이지네이션)
        sm_rows = []
        _soff = 0
        while True:
            sm_res = sb.table("support_master").select("id, iso_drawing, phase, package") \
                .not_.is_("iso_drawing", "null").range(_soff, _soff + 999).execute()
            sm_rows.extend(sm_res.data or [])
            if len(sm_res.data or []) < 1000: del sm_res; break
            del sm_res
            _soff += 1000

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
        system   = request.args.get("system",      "").strip()
        subarea  = request.args.get("sub_area",    "").strip()
        pkg_no   = request.args.get("test_pkg_no", "").strip()
        status   = request.args.get("status",      "").strip()
        search   = request.args.get("q",           "").strip()
        skip_readiness = request.args.get("skip_readiness", "0") == "1"
        q = sb.table("test_package_master").select("*", count="exact")
        if system:  q = q.eq("system",      system)
        if subarea: q = q.eq("sub_area",    subarea)
        if pkg_no:  q = q.eq("test_pkg_no", pkg_no)
        if status == "pass":    q = q.eq("completed", True)
        if status == "pending": q = q.eq("completed", False)
        if search:
            like = f"%{search}%"
            q = q.or_(f"system.ilike.{like},test_pkg_no.ilike.{like},method.ilike.{like},test_pressure.ilike.{like}")
        res = q.order("id").range(offset, offset + limit - 1).execute()
        rows = res.data or []

        # Readiness: piping 70% + support 30% 가중 진행률
        if skip_readiness:
            for row in rows:
                row["piping_total"] = 0; row["piping_completed"] = 0
                row["support_total"] = 0; row["support_installed"] = 0
        else:
            global _pkg_stats_cache
            now2 = time.time()
            with _lock:
                pkg_stats = _pkg_stats_cache.get("data")
                pkg_stats_age = now2 - _pkg_stats_cache.get("time", 0)
            if pkg_stats is None or pkg_stats_age > CACHE_TTL:
                try:
                    rpc_res = sb.rpc("get_pkg_readiness_stats_v2", {}).execute()
                    pkg_stats = {
                        r["package"]: {
                            "piping_total":      int(r.get("piping_total",     0) or 0),
                            "piping_completed":  int(r.get("piping_completed", 0) or 0),
                            "support_total":     int(r.get("support_total",    0) or 0),
                            "support_installed": int(r.get("support_installed",0) or 0),
                        }
                        for r in (rpc_res.data or [])
                    }
                except Exception:
                    try:
                        rpc_res = sb.rpc("get_pkg_readiness_stats_v1", {}).execute()
                        pkg_stats = {
                            r["package"]: {
                                "piping_total":      int(r.get("total",     0) or 0),
                                "piping_completed":  int(r.get("completed", 0) or 0),
                                "support_total":     0,
                                "support_installed": 0,
                            }
                            for r in (rpc_res.data or [])
                        }
                    except Exception:
                        pkg_stats = {}
                with _lock:
                    _pkg_stats_cache["data"] = pkg_stats
                    _pkg_stats_cache["time"] = time.time()
            for row in rows:
                s = pkg_stats.get(row.get("test_pkg_no") or "", {})
                row["piping_total"]      = s.get("piping_total",     0)
                row["piping_completed"]  = s.get("piping_completed", 0)
                row["support_total"]     = s.get("support_total",    0)
                row["support_installed"] = s.get("support_installed",0)

        return jsonify({"data": rows, "count": res.count})
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

@app.route("/api/testpkg-master/sync", methods=["POST"])
def api_testpkg_sync():
    """joint_master의 distinct package를 test_package_master에 자동 등록 (중복 제외)"""
    try:
        sb = get_sb()
        existing = sb.table("test_package_master").select("system,test_pkg_no").execute().data or []
        existing_set = {(r.get("system") or "", r.get("test_pkg_no") or "") for r in existing}

        pkgs, off = [], 0
        while True:
            r = sb.table("joint_master").select("system,sub_area,package") \
                    .not_.is_("package", "null").range(off, off + 999).execute()
            pkgs.extend(r.data or [])
            if len(r.data or []) < 1000: break
            off += 1000
        del r

        seen: dict = {}
        for row in pkgs:
            key = (row.get("system") or "", row.get("package") or "")
            if key[1] and key not in seen:
                seen[key] = row.get("sub_area") or ""
        del pkgs

        to_insert = [
            {"system": sys, "sub_area": sub, "test_pkg_no": pkg, "completed": False}
            for (sys, pkg), sub in seen.items()
            if (sys, pkg) not in existing_set
        ]

        inserted = 0
        for i in range(0, len(to_insert), 500):
            res = sb.table("test_package_master").insert(to_insert[i:i+500]).execute()
            inserted += len(res.data or [])
        del to_insert

        with _lock: _cache.clear()
        return jsonify({"ok": True, "inserted": inserted, "total": len(seen)})
    except Exception as e:
        print(f"[testpkg-sync] Error: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.after_request
def compress_response(resp):
    data_len = resp.content_length or len(resp.data or b"")
    if (resp.status_code == 200
            and resp.content_type
            and resp.content_type.startswith("application/json")
            and data_len > 2048
            and "gzip" in request.headers.get("Accept-Encoding", "")):
        resp.data = gzip.compress(resp.data, compresslevel=6)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Content-Length"]   = len(resp.data)
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5005, debug=False)
