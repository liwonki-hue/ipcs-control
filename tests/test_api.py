# 저장 API의 컬럼 제한·인증, refresh-db-cache 호출 간격, HTML 이스케이프 적용 여부를 확인하는 API 테스트
import re
from pathlib import Path

import pytest

import app as A

ROOT = Path(__file__).resolve().parent.parent

# 화면(dashboard.js)이 저장 호출 지점마다 실제로 보내는 컬럼 묶음
UI_PAYLOADS = [
    ("Joint 용접 저장", "/api/joints/1", {"date_completed": None, "welder": None, "phase": None, "package": None, "inspection": None, "pwht": None}),
    ("Joint VT 저장", "/api/joints/1", {"inspection": "VT", "vt_date": None, "vt_result": None}),
    ("Joint NDE 저장", "/api/joints/1", {"pt_date": None, "pt_result": "", "mt_date": None, "mt_result": "", "rt_date": None, "rt_result": "",
                                      "rt_finding": None, "rt_2_date": None, "rt_2_result": "", "pwht_date": None, "pwht_result": ""}),
    ("Support 저장", "/api/support-master/1", {"date_completed": None, "completed": False, "phase": None, "package": None}),
    ("TestPkg 저장", "/api/testpkg-master/1", {"phase": None, "design_pressure": None, "test_pressure": None, "method": None,
                                              "media": None, "holding_time": None, "date_completed": None, "completed": False}),
]
# (URL, 허용 컬럼 하나, 막혀야 하는 컬럼들)
LOCKED = [
    ("/api/joints/1", {"welder": "IWP-001"}, ["iso_drawing", "system", "mat", "id", "di", "size_inch", "sub_area"]),
    ("/api/support-master/1", {"phase": "EP"}, ["support_drawing", "iso_drawing", "system", "id"]),
    ("/api/testpkg-master/1", {"method": "HYDRO"}, ["package", "system", "id", "result"]),
]


@pytest.mark.parametrize("name,url,body", UI_PAYLOADS, ids=[p[0] for p in UI_PAYLOADS])
def test_ui_payloads_are_accepted(client, fake_sb, name, url, body):
    r = client.patch(url, json=body)
    assert r.status_code == 200, r.get_json()
    saved = fake_sb.log[0][1]
    assert saved["updated_by"] == "editor" and "updated_at" in saved


@pytest.mark.parametrize("url,good,forbidden", LOCKED)
def test_columns_outside_allowlist_are_rejected(client, fake_sb, url, good, forbidden):
    for col in forbidden:
        r = client.patch(url, json={**good, col: "x"})
        assert r.status_code == 400 and col in r.get_json()["error"]
    assert fake_sb.log == []                                                    # 거절된 요청은 DB에 닿지 않는다


@pytest.mark.parametrize("url,good,forbidden", LOCKED)
@pytest.mark.parametrize("body", [{}, [1], "x"])
def test_non_object_bodies_are_rejected(client, fake_sb, url, good, forbidden, body):
    assert client.patch(url, json=body).status_code == 400
    assert client.patch(url, data="not json", content_type="text/plain").status_code == 400
    assert fake_sb.log == []


@pytest.mark.parametrize("url,good,forbidden", LOCKED)
def test_patch_requires_login(anon_client, url, good, forbidden):
    assert anon_client.patch(url, json=good).status_code == 401


def test_audit_fields_cannot_be_forged(client):
    r = client.patch("/api/joints/1", json={"welder": "x", "updated_by": "admin"})
    assert r.status_code == 400                                                 # updated_by는 허용 목록에 없다


@pytest.mark.parametrize("body,code", [
    ({"completed": True, "date_completed": None}, 400),
    ({"completed": False, "date_completed": "2026-11-01"}, 400),
    ({"completed": True, "date_completed": "2026-11-01"}, 200),
    ({"completed": False, "date_completed": None}, 200),
    ({"completed": True}, 200),
])
def test_support_completed_matches_date(client, body, code):
    assert client.patch("/api/support-master/1", json=body).status_code == code


def test_joint_pwht_rule_still_enforced(client, monkeypatch):
    """허용 목록을 통과한 뒤에도 재질별 PWHT 규칙은 그대로 적용된다."""
    class SB:
        def __init__(self): self.updated = False
        def table(self, _): return self
        def select(self, *_): return self
        def eq(self, *_): return self
        def limit(self, *_): return self
        def update(self, *_):
            self.updated = True
            return self
        def execute(self):
            class R: data = [{"mat": "ALLOY (P91)"}]
            return R

    sb = SB()
    monkeypatch.setattr(A, "get_sb", lambda: sb)
    r = client.patch("/api/joints/1", json={"pwht": "N"})
    assert r.status_code == 400 and "PWHT must be Y" in r.get_json()["error"]
    assert not sb.updated


# ── refresh-db-cache 호출 간격 ────────────────────────────────────────
class _RpcSB:
    def __init__(self, fail=False):
        self.calls, self.fail = 0, fail

    def rpc(self, *_):
        self.calls += 1
        return self

    def execute(self):
        if self.fail:
            raise ConnectionError("boom")
        return self


class _NoThread:
    def __init__(self, *a, **k): pass
    def start(self): pass


@pytest.fixture
def refresh_env(monkeypatch):
    monkeypatch.setattr(A, "_refresh_last", 0.0)
    monkeypatch.setattr(A.threading, "Thread", _NoThread)                       # 재빌드·Rev 동기화 스레드를 띄우지 않는다
    monkeypatch.setattr(A._joint_analysis_cache, "refresh_async", lambda build: True)   # ISO 분석 스캔도 시작하지 않는다
    monkeypatch.setattr(A, "_building", False)
    return monkeypatch


def test_refresh_second_call_within_interval_is_skipped(refresh_env):
    sb = _RpcSB()
    refresh_env.setattr(A, "get_sb", lambda: sb)
    c = A.app.test_client()
    first = c.get("/api/refresh-db-cache")
    second = c.get("/api/refresh-db-cache")
    assert first.status_code == 200 and not first.get_json().get("skipped")
    assert second.status_code == 200 and second.get_json()["skipped"] is True    # 200이어야 keep-alive 워크플로가 실패로 보지 않는다
    assert sb.calls == 1


def test_refresh_allowed_again_after_interval(refresh_env):
    sb = _RpcSB()
    refresh_env.setattr(A, "get_sb", lambda: sb)
    c = A.app.test_client()
    c.get("/api/refresh-db-cache")
    refresh_env.setattr(A, "_refresh_last", A._refresh_last - A._REFRESH_MIN_INTERVAL - 1)
    assert not c.get("/api/refresh-db-cache").get_json().get("skipped")
    assert sb.calls == 2


def test_refresh_failure_does_not_block_retry(refresh_env):
    bad, good = _RpcSB(fail=True), _RpcSB()
    box = {"sb": bad}
    refresh_env.setattr(A, "get_sb", lambda: box["sb"])
    c = A.app.test_client()
    assert c.get("/api/refresh-db-cache").status_code == 500
    box["sb"] = good
    r = c.get("/api/refresh-db-cache")                                          # keep-alive의 즉시 재시도
    assert r.status_code == 200 and not r.get_json().get("skipped") and good.calls == 1


# ── HTML 이스케이프 ───────────────────────────────────────────────────
JS = (ROOT / "static" / "js" / "dashboard.js").read_text(encoding="utf-8")


def test_esc_helper_defined_and_escapes_five_characters():
    m = re.search(r"function esc\(v\) \{.*?\n\}", JS, re.S)
    assert m, "esc() 정의가 없다"
    for ch in ('"&amp;"', '"&lt;"', '"&gt;"', '"&quot;"', '"&#39;"'):
        assert ch in m.group(0)


def test_no_unescaped_db_strings_in_templates():
    """사용자가 입력하거나 DB에서 온 문자열 칸이 esc() 없이 템플릿에 들어가면 실패한다."""
    fields = ("iso_drawing|welder|system|joint_no|sub_area|rev|revision|package|mat|size_inch|sf|phase|line_no|unit|area|type|"
              "test_pressure|test_pkg_no|support_drawing|inspection|holding_time|design_pressure|rt_finding|updated_by")
    # 값을 그대로 출력하는 형태(`${r.f}`, `${r.f||"x"}`)만 본다. `r.f==='VT'?'selected':''` 같은 비교식은 상수만 출력하므로 안전하다.
    bare = re.findall(r"\$\{\s*(?:r|row)\.(?:%s)(?:\s*\|\|\s*(?:\"[^\"]*\"|'[^']*'))*\s*\}" % fields, JS)
    assert bare == []


def test_no_unescaped_db_strings_in_iso_tools():
    """iso_tools.js의 템플릿에서 ISO·Package·System·상세 문구 같은 문자열 값은 반드시 esc()를 거친다."""
    js = (ROOT / "static" / "js" / "iso_tools.js").read_text(encoding="utf-8")
    fields = "iso|system|sub_area|package|rev|detail|title|hint|last_weld|joint_no"
    # 값을 그대로 출력하는 형태(`${r.f}`, `${r.f||"x"}`)만 본다. 조건식(`${s.iso ? ... : ""}`)은 값을 출력하지 않으므로 제외.
    bare = re.findall(r"\$\{\s*(?:r|s|c)\.(?:%s)(?:\s*\|\|\s*(?:\"[^\"]*\"|'[^']*'))*\s*\}" % fields, js)
    assert bare == []
    assert "esc(" in js


def test_no_string_arguments_in_inline_handlers():
    """onclick="fn('${값}')"는 HTML 이스케이프로 막을 수 없다(브라우저가 엔티티를 먼저 되돌린다). 데이터 속성으로 넘긴다."""
    assert re.findall(r"""on[a-z]+="[^"]*'\$\{(?!r\.date\})[^}]*\}'""", JS) == []


# ── ISO 현황·데이터 품질 엔드포인트 ──────────────────────────────
FAKE_ANALYSIS = {"built_at": "2026-11-08 12:00", "today": "2026-11-08", "joints": 2,
                 "isos": [{"iso": "ISO-1", "status": "WELDING"}],
                 "quality": {"checks": [], "drawing_available": False, "drawing_error": "Drawing DB not configured", "testpkg_checked": True}}


@pytest.fixture
def fake_analysis(monkeypatch):
    monkeypatch.setattr(A, "_get_joint_analysis", lambda: FAKE_ANALYSIS)


def test_data_quality_requires_login(anon_client, fake_analysis):
    assert anon_client.get("/api/data-quality").status_code == 401


def test_analysis_endpoints_payloads(client, anon_client, fake_analysis):
    r = anon_client.get("/api/iso-status")                                      # 모니터링 화면이라 다른 조회 API처럼 로그인 없이 본다
    assert r.status_code == 200 and r.get_json()["isos"][0]["iso"] == "ISO-1" and "age_sec" in r.get_json()
    assert anon_client.get("/api/pace-forecast").status_code == 404                # 제거된 API
    r = client.get("/api/data-quality")
    assert r.status_code == 200 and r.get_json()["joints"] == 2 and r.get_json()["isos"] == 1


def test_analysis_errors_do_not_leak_details(anon_client, monkeypatch):
    def boom():
        raise RuntimeError("secret-key-abc")
    monkeypatch.setattr(A, "_get_joint_analysis", boom)
    r = anon_client.get("/api/iso-status")
    assert r.status_code == 500 and "secret-key-abc" not in r.get_data(as_text=True)


@pytest.mark.parametrize("scope,invalidated", [("joint", True), ("support", True), ("all", True)])
def test_saves_invalidate_the_analysis_cache(monkeypatch, scope, invalidated):
    monkeypatch.setattr(A.threading, "Thread", _NoThread)                       # 재빌드 스레드를 띄우지 않는다
    monkeypatch.setattr(A, "_building", False)
    A._joint_analysis_cache.get_or_build(lambda: {"x": 1})
    A._joint_analysis_cache.peek()
    A._joint_analysis_cache._valid = True
    A._run_cache_clear({scope})
    assert A._joint_analysis_cache.peek()[1] is (not invalidated)


def test_joint_bulk_date_api_is_removed(client):
    assert client.post("/api/joints/bulk-date", json={"ids": [1], "date_completed": None}).status_code == 404


def test_joint_master_has_no_bulk_update_panel():
    html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    assert "jm-iso-bulk-panel" not in html and "applyIsoBulkDate" not in html
    assert "sm-bulk-date" in html                                              # Support Master의 패널은 그대로
