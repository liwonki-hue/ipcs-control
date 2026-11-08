# 락·동시 생성 방지·낡은 값 먼저 보여 주고 뒤에서 갱신하기·무효화 범위를 한 곳에서 관리하는 TTL 캐시 (app.py를 임포트하지 않는다)
import threading
import time

_REGISTRY = []   # (캐시, 범위 집합)


class TTLCache:
    """값 하나를 보관한다. 만드는 데 오래 걸리는 집계(수십 초)용이다.
    - 신선(TTL 안, 무효화 없음): 그대로 돌려준다.
    - 낡음(TTL 지남 또는 invalidate됨): 낡은 값을 바로 돌려주고 뒤에서 한 번만 다시 만든다. 사용자가 수십 초를 기다리지 않는다.
    - 값이 아직 없음(서버를 막 켠 직후): 첫 호출만 만들고, 동시에 온 호출은 그 결과를 기다려 받는다.
    - 뒤에서 만들기는 min_gap초 간격으로만 시작한다 — 저장이 계속되는 동안 스캔이 연달아 도는 것을 막는다.
    - 만드는 도중 invalidate가 있었으면 그 결과는 저장하되 신선하지 않은 것으로 표시해 다음 호출이 다시 만들게 한다."""

    def __init__(self, name, ttl, scopes=("all",), min_gap=60):
        self.name, self.ttl, self.min_gap = name, ttl, min_gap
        self._lock = threading.Lock()
        self._build_lock = threading.Lock()
        self._value, self._time, self._valid, self._gen = None, 0.0, False, 0
        self._bg_running, self._last_start = False, 0.0
        _REGISTRY.append((self, frozenset(scopes) | {"all"}))

    def _fresh(self):
        return self._value is not None and self._valid and time.time() - self._time < self.ttl

    def peek(self):
        """(값, 신선 여부). 값이 없으면 (None, False)."""
        with self._lock:
            return self._value, self._fresh()

    def age(self):
        with self._lock:
            return time.time() - self._time if self._value is not None else None

    def invalidate(self):
        """값은 남기되 낡은 것으로 표시한다(다음 호출이 뒤에서 다시 만들게 한다)."""
        with self._lock:
            self._valid = False
            self._gen += 1

    def _store(self, value, gen):
        with self._lock:
            self._value, self._time = value, time.time()
            self._valid = (self._gen == gen)

    def _build_and_store(self, build):
        with self._lock:
            gen = self._gen
        value = build()
        self._store(value, gen)
        return value

    def refresh_async(self, build):
        """뒤에서 다시 만든다. 이미 만드는 중이거나 최근에 시작했으면 아무것도 하지 않는다."""
        with self._lock:
            if self._bg_running or time.time() - self._last_start < self.min_gap:
                return False
            self._bg_running, self._last_start = True, time.time()
        threading.Thread(target=self._run_bg, args=(build,), daemon=True).start()
        return True

    def _run_bg(self, build):
        try:
            with self._build_lock:
                self._build_and_store(build)
        except Exception as e:
            print(f"[cache:{self.name}] background build failed: {type(e).__name__}")
        finally:
            with self._lock:
                self._bg_running = False

    def get_or_build(self, build):
        value, fresh = self.peek()
        if fresh:
            return value
        if value is not None:
            self.refresh_async(build)
            return value
        with self._build_lock:
            value, _ = self.peek()
            if value is not None:
                return value
            return self._build_and_store(build)


def clear_scopes(scopes):
    """등록된 캐시 중 범위가 하나라도 겹치는 것을 낡은 것으로 표시한다. 'all'이 오면 전부."""
    wanted = set(scopes)
    for cache, own in _REGISTRY:
        if "all" in wanted or own & wanted:
            cache.invalidate()
