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


def test_register_sort_package_number_order_with_misc_last():
    rows = [
        {"system": "GT MISC", "test_pkg_no": "BOP-GM-002"},
        {"system": "ST MISC", "test_pkg_no": "BOP-SM-001"},
        {"system": "HW", "test_pkg_no": "BOP-HW-010"},
        {"system": "GT MISC", "test_pkg_no": "BOP-GM-001"},
        {"system": "AS", "test_pkg_no": "BOP-AS-002"},
        {"system": "HW", "test_pkg_no": "BOP-HW-002"},
        {"system": "AS", "test_pkg_no": "BOP-AS-001"},
        {"system": None, "test_pkg_no": None},
    ]
    rows.sort(key=A._tpm_sort_key)
    assert [(r["system"], r["test_pkg_no"]) for r in rows] == [
        (None, None), ("AS", "BOP-AS-001"), ("AS", "BOP-AS-002"),
        ("HW", "BOP-HW-002"), ("HW", "BOP-HW-010"),                 # 번호는 숫자 순서 (2 < 10)
        ("GT MISC", "BOP-GM-001"), ("GT MISC", "BOP-GM-002"), ("ST MISC", "BOP-SM-001")]   # MISC는 모두 맨 뒤
