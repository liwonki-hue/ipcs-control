# Steam Blowing(임시 배관) 집계와 Permanent 집계 분리 규칙을 확인하는 테스트
import re
from pathlib import Path

import app as A

ROOT = Path(__file__).resolve().parent.parent


def test_service_comes_from_line_no_suffix():
    assert A._sb_service('12"-HS-B1-26/101-DB1-PP') == "HS"
    assert A._sb_service('6"-AS-B2-26/011-DB1-PP') == "AS"
    assert A._sb_service('10"-LS-B1-26/301-DB1-PP') == "LS"
    assert A._sb_service(None) == "-" and A._sb_service("") == "-"


def test_sb_summary_groups_by_service_unit_and_week(monkeypatch):
    rows = [
        {"unit": "B1", "line_no": '12"-HS-B1-26/101-DB1-PP', "iso_drawing": "ISO-1", "di": 12, "date_completed": None},
        {"unit": "B1", "line_no": '12"-HS-B1-26/101-DB1-PP', "iso_drawing": "ISO-1", "di": 12, "date_completed": "2026-11-18"},   # 수요일
        {"unit": "B2", "line_no": '6"-LS-B2-26/301-DB1-PP', "iso_drawing": "ISO-2", "di": 6, "date_completed": "2026-11-16"},    # 같은 주 월요일
    ]
    monkeypatch.setattr(A, "_fetch_all_pages", lambda make_query, **kw: rows)
    res = A._build_sb_summary()
    assert res["kpi"] == {"total_di": 30.0, "completed_di": 18.0, "joints": 3, "completed_joints": 2, "isos": 2}
    assert {s["name"]: s["total_di"] for s in res["service"]} == {"HS": 24.0, "LS": 6.0}
    assert {u["name"]: u["completed_di"] for u in res["unit"]} == {"B1": 12.0, "B2": 6.0}
    assert res["weekly"] == [{"week_start": "2026-11-16", "completed_di": 18.0, "joints": 2}]
    assert res["schedule"] == {"start": "2027-02-01", "end": "2027-05-31"}        # 설치 일정(사용자 지정)


def test_sb_endpoint_is_public_and_returns_summary(anon_client, monkeypatch):
    monkeypatch.setattr(A, "_fetch_all_pages", lambda make_query, **kw: [])
    r = anon_client.get("/api/sb-summary")
    assert r.status_code == 200 and r.get_json()["kpi"]["joints"] == 0


def test_permanent_queries_exclude_sb():
    """집계용 joint_master 조회는 모두 SB를 제외해야 한다. 목록·저장(id 기준)·SB 집계 자신은 예외 — 새 집계를 만들 때 빠뜨리면 여기서 걸린다."""
    src = (ROOT / "app.py").read_text(encoding="utf-8")
    must = ['select("di,sf,date_completed,system,unit,area,sub_area").neq("system", SB_SYSTEM)',      # 대시보드 완료 집계
            'select("date_completed,di,sf").neq("system", SB_SYSTEM)',                                # 일별 실적
            'select("date_completed, welder, di").neq("system", SB_SYSTEM)',                          # 용접사 일별
            'select("welder,sf,di").neq("system", SB_SYSTEM)',                                         # 용접사 요약
            'lambda r: None if r.get("system") == SB_SYSTEM else an.add_joint(r)']                    # ISO Status
    for s in must:
        assert s in src, s
    # SB 탭 전용 조회는 eq(SB)로만 읽는다
    assert len(re.findall(r'\.eq\("system", SB_SYSTEM\)', src)) == 1
