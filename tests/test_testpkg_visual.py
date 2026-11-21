# Visual(VT) Test Package를 압력 시험과 따로 세는 규칙을 확인하는 테스트
import app as A


def test_visual_packages_are_counted_separately():
    agg = {}
    A._tp_add(agg, "FG", "HYDRO", "completed")
    A._tp_add(agg, "FG", "VISUAL", "completed")        # 완료는 시험 종류와 상관없이 completed
    A._tp_add(agg, "FG", "VISUAL", "ready")
    A._tp_add(agg, "FG", "visual", "in_progress")     # 대소문자 무관
    A._tp_add(agg, "FG", "VISUAL", "not_started")
    A._tp_add(agg, None, "PNEUMATIC", "not_started")
    fg = agg["FG"]
    assert fg["total"] == 5
    assert (fg["completed"], fg["ready"], fg["in_progress"], fg["not_started"]) == (2, 0, 0, 0)       # 압력 시험 완료 + Visual 완료
    assert (fg["v_ready"], fg["v_pending"]) == (1, 2)                                                   # 완료 전 Visual만 따로
    assert "v_completed" not in fg
    assert agg["-"]["not_started"] == 1 and agg["-"]["v_pending"] == 0                                  # System이 없으면 "-"


def test_register_method_filter_is_accepted(client, monkeypatch):
    seen = []

    class Q:
        def __getattr__(self, name):
            def f(*a, **k):
                seen.append((name, a))
                return self
            return f
        def __init__(self):
            self.data, self.count = [], 0

    class FakeSb:
        def table(self, *_):
            return Q()

    monkeypatch.setattr(A, "get_sb", lambda: FakeSb())
    monkeypatch.setattr(A, "_exec_page", lambda q: q)
    monkeypatch.setattr(A, "_load_pkg_stats", lambda sb: {})
    assert client.get("/api/testpkg-master?method=visual").status_code == 200       # 대소문자 무관
    assert ("eq", ("method", "VISUAL")) in seen
    seen.clear()
    assert client.get("/api/testpkg-master").status_code == 200                     # 필터 없으면 method 조건 없음
    assert not any(n == "eq" and a[0] == "method" for n, a in seen)
