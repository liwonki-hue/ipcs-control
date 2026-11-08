# TTLCache의 신선/낡음 처리, 동시 생성 방지, 만드는 도중 무효화, 범위별 무효화를 확인하는 테스트
import threading
import time

import cache_util
from cache_util import TTLCache


def wait_until(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_fresh_value_is_reused():
    c, calls = TTLCache("t1", ttl=60), []
    build = lambda: calls.append(1) or len(calls)
    assert c.get_or_build(build) == 1 and c.get_or_build(build) == 1
    assert len(calls) == 1


def test_first_call_builds_once_for_concurrent_callers():
    c, calls, release = TTLCache("t2", ttl=60), [], threading.Event()

    def build():
        calls.append(1)
        release.wait(2)
        return "v"
    out = []
    ts = [threading.Thread(target=lambda: out.append(c.get_or_build(build))) for _ in range(4)]
    [t.start() for t in ts]
    time.sleep(0.1)
    release.set()
    [t.join() for t in ts]
    assert out == ["v"] * 4 and len(calls) == 1


def test_stale_value_is_served_while_rebuilding_in_background():
    c = TTLCache("t3", ttl=60, min_gap=0)
    c.get_or_build(lambda: "old")
    c.invalidate()
    release = threading.Event()

    def slow():
        release.wait(2)
        return "new"
    assert c.get_or_build(slow) == "old"                                      # 기다리지 않고 낡은 값을 바로 준다
    assert c.peek() == ("old", False)
    release.set()
    assert wait_until(lambda: c.peek() == ("new", True))


def test_expired_ttl_also_serves_stale_then_refreshes():
    c = TTLCache("t4", ttl=0.05, min_gap=0)
    c.get_or_build(lambda: 1)
    time.sleep(0.1)
    assert c.get_or_build(lambda: 2) == 1
    assert wait_until(lambda: c.peek()[0] == 2)


def test_background_refresh_respects_min_gap_and_single_flight():
    c, calls = TTLCache("t5", ttl=60, min_gap=60), []
    c.get_or_build(lambda: calls.append(1) or "a")
    c.invalidate()
    started = [c.refresh_async(lambda: calls.append(1) or "b") for _ in range(3)]
    assert started.count(True) <= 1
    c.invalidate()
    assert c.refresh_async(lambda: "c") is False                              # 직전 시작으로부터 min_gap 이내


def test_invalidate_during_build_stores_value_but_not_fresh():
    c = TTLCache("t6", ttl=60)
    started, release = threading.Event(), threading.Event()

    def build():
        started.set()
        release.wait(2)
        return "scan"
    t = threading.Thread(target=lambda: c.get_or_build(build))
    t.start()
    started.wait(2)
    c.invalidate()                                                            # 스캔 도중 저장이 있었다
    release.set()
    t.join()
    assert c.peek() == ("scan", False)                                        # 낡은 스캔은 신선하다고 믿지 않는다


def test_failed_background_build_keeps_old_value():
    c = TTLCache("t7", ttl=60, min_gap=0)
    c.get_or_build(lambda: "keep")
    c.invalidate()

    def boom():
        raise RuntimeError("db down")
    assert c.get_or_build(boom) == "keep"
    assert wait_until(lambda: not c._bg_running)
    assert c.peek()[0] == "keep"


def test_clear_scopes_only_touches_matching_caches():
    joint = TTLCache("t8j", ttl=60, scopes=("joint",))
    support = TTLCache("t8s", ttl=60, scopes=("support",))
    joint.get_or_build(lambda: 1)
    support.get_or_build(lambda: 1)
    cache_util.clear_scopes({"joint"})
    assert joint.peek()[1] is False and support.peek()[1] is True
    cache_util.clear_scopes({"all"})
    assert support.peek()[1] is False
