# ISO 집계·데이터 품질 검사(iso_analysis.py)를 합성 행으로 확인하는 테스트
import re
from datetime import date

import pytest

import app as A
import iso_analysis as IA

TODAY = date(2026, 11, 8)


def make(**kw):
    """규칙에 어긋나는 데가 없는 용접 완료·VT PASS 조인트."""
    base = {"id": 1, "iso_drawing": "ISO-1", "joint_no": "1", "rev": "C01", "system": "AS", "sub_area": "PR #4", "package": "PKG-1",
            "mat": "CS", "size_inch": 6, "bore": "Large", "sf": "F", "line_no": '6"-AS-001', "di": 6.0, "date_completed": "2026-10-01",
            "welder": "IWP-001", "inspection": "VT", "pwht": "N", "vt_date": "2026-10-02", "vt_result": "PASS"}
    base.update(kw)
    return base


def analyze(rows, supports=(), **result_kw):
    an = IA.Analyzer(A._joint_accepted, A._required_pwht, TODAY)
    for r in rows:
        an.add_joint(r)
    for r in supports:
        an.add_support(r)
    return an.result(**result_kw)


def check(res, key):
    return next(c for c in res["quality"]["checks"] if c["key"] == key)


# ── ISO 집계 ──────────────────────────────────────────────────────────
def test_status_progression():
    rows = [
        make(id=1, iso_drawing="NS", date_completed=None, vt_date=None, vt_result=None),
        make(id=2, iso_drawing="WELDING"), make(id=3, iso_drawing="WELDING", date_completed=None, vt_date=None, vt_result=None),
        make(id=4, iso_drawing="WELDED", vt_result=None),                       # 용접 끝, VT 결과 없음 → 검사 대기
        make(id=5, iso_drawing="ACC"),
    ]
    by = {r["iso"]: r for r in analyze(rows)["isos"]}
    assert by["NS"]["status"] == "NOT_STARTED"
    assert by["WELDING"]["status"] == "WELDING"
    assert by["WELDED"]["status"] == "WELDED" and by["WELDED"]["pending"] == 1
    assert by["ACC"]["status"] == "ACCEPTED" and by["ACC"]["pending"] == 0


def test_totals_and_fab_erect_split():
    rows = [make(id=1, sf="S", di=4), make(id=2, sf="F", di=6, date_completed=None, vt_date=None, vt_result=None), make(id=3, sf="s", di=2)]
    iso = analyze(rows)["isos"][0]
    assert (iso["n"], iso["di"], iso["welded"], iso["welded_di"]) == (3, 12.0, 2, 6.0)
    assert (iso["fab_n"], iso["fab_w"], iso["erect_n"], iso["erect_w"]) == (2, 2, 1, 0)   # 소문자 s도 Shop
    assert iso["fab_done_erect_open"] is True
    assert iso["last_weld"] == "2026-10-01"


def test_multi_values_are_marked_and_flagged():
    res = analyze([make(id=1, rev="C01", system="AS"), make(id=2, rev="C01A", system="DW")])
    iso = res["isos"][0]
    assert iso["rev"] == "(multi)" and iso["system"] == "(multi)"
    assert check(res, "iso_multi_rev")["count"] == 1 and check(res, "iso_multi_system")["count"] == 1


def test_support_counts_and_system_mismatch():
    res = analyze([make()], supports=[{"iso_drawing": "ISO-1", "system": "AS", "completed": True},
                                      {"iso_drawing": "ISO-1", "system": "AS", "completed": False},
                                      {"iso_drawing": "UNKNOWN", "system": "AS", "completed": True}])
    iso = res["isos"][0]
    assert (iso["sup_n"], iso["sup_done"]) == (2, 1)
    assert check(res, "iso_system_mismatch")["count"] == 0
    res = analyze([make()], supports=[{"iso_drawing": "ISO-1", "system": "DW", "completed": True}])
    assert check(res, "iso_system_mismatch")["count"] == 1


# ── 데이터 품질 ───────────────────────────────────────────────────────
def test_clean_row_raises_no_error_or_warning():
    res = analyze([make()], testpkg_numbers={"PKG-1"}, drawing={"ISO-1": "C01"})
    bad = [c for c in res["quality"]["checks"] if c["count"] and c["severity"] != "info"]
    assert bad == []


@pytest.mark.parametrize("key,kw", [
    ("missing_system", {"system": ""}),
    ("missing_sub_area", {"sub_area": None}),
    ("missing_mat", {"mat": ""}),
    ("missing_size", {"size_inch": 0}),
    ("mat_format", {"mat": "ALLOY(P91)", "pwht": "Y"}),
    ("gm1_not_ss", {"line_no": "6\"-GM1-001", "mat": "CS"}),
    ("pwht_rule", {"mat": "CS", "pwht": "Y"}),
    ("pwht_rule", {"mat": "ALLOY (P91)", "pwht": None}),
    ("bore_rule", {"size_inch": 2, "bore": "Large"}),
    ("bore_rule", {"size_inch": 3, "bore": None}),
    ("sf_invalid", {"sf": "s"}),
    ("sf_invalid", {"sf": ""}),
    ("date_order", {"vt_date": "2026-09-30"}),
    ("result_without_date", {"rt_result": "PASS", "rt_date": None}),
    ("nde_without_weld", {"date_completed": None}),
    ("weld_future", {"date_completed": "2026-11-09"}),
    ("welded_no_welder", {"welder": ""}),
    ("missing_package", {"package": None}),
])
def test_each_quality_check_fires(key, kw):
    res = analyze([make(**kw)])
    c = check(res, key)
    assert c["count"] == 1 and c["samples"][0]["iso"] == "ISO-1"


@pytest.mark.parametrize("kw", [
    {"mat": "SS", "pwht": "N", "line_no": "6\"-GM1-001"},    # GM1 + SS는 정상
    {"mat": "ALLOY (P22)", "pwht": "N"}, {"mat": "ALLOY (P91)", "pwht": "Y", "pwht_date": "2026-10-03", "pwht_result": "PASS"},
    {"size_inch": 2, "bore": "Small"}, {"size_inch": 2.5, "bore": "Large"},
    {"sf": "S"}, {"vt_date": "2026-10-01"},                    # 같은 날 검사는 정상
])
def test_valid_variants_do_not_fire_errors(kw):
    res = analyze([make(**kw)])
    assert [c["key"] for c in res["quality"]["checks"] if c["count"] and c["severity"] == "error"] == []


def test_sample_cap_keeps_total_count():
    rows = [make(id=i, system="") for i in range(IA.SAMPLE_CAP + 25)]
    c = check(analyze(rows), "missing_system")
    assert c["count"] == IA.SAMPLE_CAP + 25 and len(c["samples"]) == IA.SAMPLE_CAP


def test_drawing_comparison():
    rows = [make(id=1, iso_drawing="A"), make(id=2, iso_drawing="B", rev="C01"), make(id=3, iso_drawing="C"), make(id=4, iso_drawing="D")]
    res = analyze(rows, drawing={"A": "C01", "B": "C01B", "C": "VOID"})
    assert check(res, "missing_in_drawing")["samples"][0]["iso"] == "D"
    assert check(res, "rev_mismatch")["samples"][0]["iso"] == "B"
    assert check(res, "void_with_joints")["samples"][0]["iso"] == "C"
    assert check(res, "rev_mismatch")["count"] == 1


def test_drawing_checks_skipped_without_drawing_db():
    res = analyze([make()], drawing=None, drawing_error="Drawing DB not configured")
    assert res["quality"]["drawing_available"] is False
    assert all(check(res, k)["count"] == 0 for k in ("missing_in_drawing", "rev_mismatch", "void_with_joints"))


def test_package_orphan_needs_register():
    rows = [make(id=1, package="PKG-1"), make(id=2, iso_drawing="ISO-2", package="PKG-X")]
    res = analyze(rows, testpkg_numbers={"PKG-1"})
    assert check(res, "package_orphan")["count"] == 1 and "PKG-X" in check(res, "package_orphan")["samples"][0]["detail"]
    assert check(analyze(rows), "package_orphan")["count"] == 0          # Register를 못 읽었으면 대조하지 않는다


def test_checks_sorted_by_severity():
    order = {"error": 0, "warn": 1, "info": 2}
    sev = [order[c["severity"]] for c in analyze([make()])["quality"]["checks"]]
    assert sev == sorted(sev)


# ── 화면 문구는 영어 ──────────────────────────────────────────────────
HANGUL = re.compile(r"[가-힣]")


def test_check_titles_and_hints_are_english():
    """해외 현장 사용자가 보는 화면이라 검사 제목·안내는 영어여야 한다(코드 주석만 한글)."""
    assert [k for k, (_, title, hint) in IA.CHECKS.items() if HANGUL.search(title + hint)] == []


def test_every_detail_message_is_english():
    rows = [
        make(id=1, system="", sub_area="", mat="CS", pwht="Y", size_inch=2, bore="Large", sf="s", line_no="GM1", package=None,
             date_completed="2026-11-20", welder="", vt_date="2026-09-01", rt_result="PASS", rt_date=None),
        make(id=2, iso_drawing="ISO-2", date_completed=None, pt_date="2026-10-01", rev="C01A", system="HP", package="PKG-X"),
        make(id=3, iso_drawing="ISO-2", rev="C01B", system="DW"),
        make(id=4, iso_drawing="ISO-3"), make(id=5, iso_drawing="ISO-4"),
    ]
    res = analyze(rows, supports=[{"iso_drawing": "ISO-2", "system": "ATM", "completed": True}],
                  testpkg_numbers={"PKG-1"}, drawing={"ISO-2": "C01", "ISO-3": "VOID"})
    fired = [c for c in res["quality"]["checks"] if c["count"]]
    assert len(fired) >= 15                                                    # 대부분의 검사가 실제로 문구를 만들었는지
    texts = [s["detail"] for c in fired for s in c["samples"]]
    assert texts and [t for t in texts if HANGUL.search(t)] == []
