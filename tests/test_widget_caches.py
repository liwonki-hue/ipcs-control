# 대시보드 보조 집계 4종(daily-actuals·weekly-last-breakdown·welder-daily·ep-support-summary)의 계산·캐시 무효화·미리 데우기·오류 응답을 가짜 DB로 확인하는 테스트
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import app as A
import cache_util


def reset(cache):
    cache._value, cache._time, cache._valid, cache._bg_running, cache._last_start, cache._last_access = None, 0.0, False, False, 0.0, 0.0


@pytest.fixture(autouse=True)
def clean_caches():
    caches = (A._daily_cache, A._wkbd_cache, A._welder_daily_cache, A._ep_sup_cache)
    for c in caches:
        reset(c)
    yield
    for c in caches:
        reset(c)


# ── _fetch_all_pages: 페이지를 동시에 읽어도 순서·개수가 순차로 읽을 때와 같다 ─────────────
class FakeQuery:
    def __init__(self, data):
        self.data, self.lo, self.hi = data, 0, None

    def order(self, *_):
        return self

    def range(self, lo, hi):
        self.lo, self.hi = lo, hi
        return self

    def execute(self):
        return SimpleNamespace(data=self.data[self.lo: self.hi + 1])


@pytest.fixture
def fake_pages(monkeypatch):
    monkeypatch.setattr(A, "_sb_exec", lambda fn: fn(None))


@pytest.mark.parametrize("total", [0, 1, 9999, 10000, 10001, 25000, 30000, 30001])
def test_fetch_all_pages_returns_everything_in_order(fake_pages, total):
    data = [{"id": i} for i in range(total)]
    got = A._fetch_all_pages(lambda sb: FakeQuery(data), page=10000, workers=3)
    assert [r["id"] for r in got] == list(range(total))


def test_fetch_all_pages_small_pages_and_workers(fake_pages):
    data = [{"id": i} for i in range(53)]
    for page, workers in [(5, 2), (7, 3), (50, 1), (60, 4)]:
        assert A._fetch_all_pages(lambda sb: FakeQuery(data), page=page, workers=workers) == data


# ── daily-actuals ────────────────────────────────────────────────────────
def test_daily_actuals_result_sums_by_day_and_sf():
    rows = [{"date_completed": "2026-11-02", "di": 4, "sf": "S"}, {"date_completed": "2026-11-02", "di": 6, "sf": "f"},
            {"date_completed": "2026-11-03", "di": 2.5, "sf": ""}, {"date_completed": "2026-10-01", "di": 99, "sf": "S"}]
    r = A._daily_actuals_result(rows, ["2026-11-02", "2026-11-03"])
    assert r["date_start"] == "2026-11-02" and r["date_end"] == "2026-11-03"
    assert r["data"] == [{"date": "2026-11-02", "completed_di": 10.0, "fab_di": 4.0, "erect_di": 6.0},
                         {"date": "2026-11-03", "completed_di": 2.5, "fab_di": 0.0, "erect_di": 0.0}]


def recent_rows(days):
    today = datetime.now(A.ALMT).date()
    return [{"date_completed": (today - timedelta(days=d)).isoformat(), "di": 3.0, "sf": "S"} for d in days for _ in range(2)]


def test_daily_actuals_fast_path_uses_a_single_query(monkeypatch):
    calls = []

    def fake_exec(fn):
        calls.append(1)
        return SimpleNamespace(data=recent_rows([0, 1, 2, 3, 4, 6, 8]))
    monkeypatch.setattr(A, "_sb_exec", fake_exec)
    res = A._build_daily_actuals()
    assert len(calls) == 1                                                       # 5일 이상 있으면 DB 왕복 1회
    assert len(res["data"]) == 5 and res["date_end"] == datetime.now(A.ALMT).date().isoformat()
    assert all(d["completed_di"] == 6.0 for d in res["data"])


def test_daily_actuals_falls_back_when_fewer_than_five_recent_days(monkeypatch):
    calls = []

    def fake_exec(fn):
        calls.append(1)
        if len(calls) == 1:
            return SimpleNamespace(data=recent_rows([0, 1]))                      # 최근 14일에 작업일이 2일뿐(연휴 등)
        if len(calls) == 2:
            return SimpleNamespace(data=[{"date_completed": f"2026-09-0{d}"} for d in range(1, 8)])
        return SimpleNamespace(data=[{"date_completed": f"2026-09-0{d}", "di": 1.0, "sf": "F"} for d in range(3, 8)])
    monkeypatch.setattr(A, "_sb_exec", fake_exec)
    res = A._build_daily_actuals()
    assert len(calls) == 3                                                       # 기존 2단계 조회로 돌아갔다
    assert [d["date"] for d in res["data"]] == [f"2026-09-0{d}" for d in range(3, 8)]


def test_daily_actuals_endpoint_error_is_500_and_empty(client, monkeypatch):
    def boom():
        raise RuntimeError("db")
    monkeypatch.setattr(A, "_build_daily_actuals", boom)
    r = client.get("/api/daily-actuals")
    assert r.status_code == 500 and r.get_json()["data"] == []


# ── 저장하면 낡은 값을 주지 않는다 ─────────────────────────────────────────
def prime(cache, value):
    cache.get_or_build(lambda: value)
    assert cache.peek() == (value, True)


def test_joint_save_invalidates_the_four_caches_without_stale_service(monkeypatch):
    monkeypatch.setattr(A.threading, "Thread", lambda *a, **k: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(A, "_building", False)
    monkeypatch.setattr(A, "_prewarm_widgets", lambda: None)
    for c in (A._daily_cache, A._wkbd_cache, A._welder_daily_cache, A._ep_sup_cache):
        prime(c, "before-save")
    A._run_cache_clear({"joint"})
    for c in (A._daily_cache, A._wkbd_cache, A._welder_daily_cache, A._ep_sup_cache):
        assert c.peek()[1] is False
        assert c.get_or_build(lambda: "after-save") == "after-save"             # 저장 전 값 대신 새로 만든다


def test_support_save_invalidates_only_the_support_derived_cache(monkeypatch):
    monkeypatch.setattr(A.threading, "Thread", lambda *a, **k: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(A, "_building", False)
    monkeypatch.setattr(A, "_prewarm_widgets", lambda: None)
    for c in (A._daily_cache, A._ep_sup_cache):
        prime(c, "x")
    A._run_cache_clear({"support"})
    assert A._ep_sup_cache.peek()[1] is False                                    # EP Support 집계는 Support 저장으로 바뀐다
    assert A._daily_cache.peek()[1] is True                                      # 조인트 일별 실적은 그대로


# ── 미리 데우기 ──────────────────────────────────────────────────────────
def test_prewarm_widgets_refreshes_only_recently_used_caches(monkeypatch):
    started = []
    monkeypatch.setattr(A, "_build_daily_actuals", lambda: "d")
    monkeypatch.setattr(A, "_build_welder_daily", lambda: "w")
    for c in (A._daily_cache, A._welder_daily_cache):
        prime(c, "old")
        c.invalidate()
    A._welder_daily_cache._last_access = time.time() - 3600                      # 한 시간 동안 아무도 안 썼다
    monkeypatch.setattr(A.threading, "Thread", lambda target=None, args=(), daemon=None: SimpleNamespace(start=lambda: started.append(args[0]())))
    A._prewarm_widgets()
    assert started == ["d"]                                                      # 쓰이던 것만 다시 만든다
    assert A._welder_daily_cache.peek() == ("old", False)


def test_clear_and_keep_alive_both_prewarm():
    import inspect
    assert "_prewarm_widgets()" in inspect.getsource(A._run_cache_clear)
    assert "_prewarm_widgets()" in inspect.getsource(A.api_refresh_db_cache)


# ── ep-support-summary 오류 처리 ─────────────────────────────────────────
def test_ep_partial_result_is_returned_but_never_cached(client, monkeypatch):
    partial = {"sys": [], "area": [], "subarea_map": {}, "testpkg_total": 0, "testpkg_comp": 0, "testpkg_sys": []}

    def build():
        raise A._PartialEpSummary(partial)
    monkeypatch.setattr(A, "_build_ep_support", build)
    r = client.get("/api/ep-support-summary")
    assert r.status_code == 200 and r.get_json()["testpkg_total"] == 0
    assert A._ep_sup_cache.peek()[0] is None                                     # 불완전한 값은 캐시에 남지 않는다


def test_ep_partial_result_does_not_replace_a_good_cached_value(client, monkeypatch):
    prime(A._ep_sup_cache, {"testpkg_total": 9})
    A._ep_sup_cache.invalidate()

    def build():
        raise A._PartialEpSummary({"testpkg_total": 0})
    monkeypatch.setattr(A, "_build_ep_support", build)
    r = client.get("/api/ep-support-summary")
    assert r.get_json() == {"testpkg_total": 9}                                  # 이전의 온전한 값을 준다


def test_other_errors_are_500_without_leaking_details(anon_client, monkeypatch):
    """로그인하지 않은 요청에는 오류 종류만 준다(로그인한 사용자에게는 원인 문구를 준다)."""
    def boom():
        raise RuntimeError("secret-key-abc")
    monkeypatch.setattr(A, "_build_ep_support", boom)
    monkeypatch.setattr(A, "_build_weekly_breakdown", boom)
    monkeypatch.setattr(A, "_build_welder_daily", boom)
    for url in ("/api/ep-support-summary", "/api/weekly-last-breakdown", "/api/welder-daily"):
        r = anon_client.get(url)
        assert r.status_code == 500 and "secret-key-abc" not in r.get_data(as_text=True)
