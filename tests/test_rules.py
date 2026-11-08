# 합격 판정·PWHT·Revision 비교·Test Package 단계처럼 진행률 집계의 바탕이 되는 순수 규칙 테스트
import pytest

import app as A


def joint(**kw):
    """용접 완료 + VT PASS인 기본 조인트에 칸을 덮어쓴다."""
    base = {"date_completed": "2026-10-01", "inspection": "VT", "vt_date": "2026-10-02", "vt_result": "PASS", "pwht": "N"}
    base.update(kw)
    return base


# ── _required_pwht ────────────────────────────────────────────────────
@pytest.mark.parametrize("mat,expected", [
    ("CS", "N"), ("cs", "N"), (" SS ", "N"),
    ("ALLOY (P22)", "N"), ("ALLOY (P91)", "Y"),
    ("ALLOY", None), ("", None), (None, None),
])
def test_required_pwht(mat, expected):
    assert A._required_pwht(mat) == expected


# ── _rt_passed ────────────────────────────────────────────────────────
def test_rt_passed_first_shot():
    assert A._rt_passed({"rt_date": "2026-10-03", "rt_result": "PASS"})


def test_rt_passed_after_repair_reshoot():
    assert A._rt_passed({"rt_date": "2026-10-03", "rt_result": "FAIL", "rt_2_date": "2026-10-09", "rt_2_result": "PASS"})


@pytest.mark.parametrize("row", [
    {},
    {"rt_date": None, "rt_result": "PASS"},                                  # 촬영일 없는 PASS는 인정하지 않는다
    {"rt_date": "2026-10-03", "rt_result": "FAIL"},
    {"rt_date": "2026-10-03", "rt_result": "FAIL", "rt_2_date": "2026-10-09", "rt_2_result": "FAIL"},
])
def test_rt_not_passed(row):
    assert not A._rt_passed(row)


# ── _joint_accepted ───────────────────────────────────────────────────
def test_accepted_requires_weld_date():
    assert not A._joint_accepted(joint(date_completed=None))


def test_accepted_vt_only():
    assert A._joint_accepted(joint())


@pytest.mark.parametrize("kw", [{"vt_result": "FAIL"}, {"vt_result": None}, {"vt_date": None}])
def test_accepted_requires_vt_pass(kw):
    assert not A._joint_accepted(joint(**kw))


def test_accepted_rt_first_shot_and_reshoot():
    assert A._joint_accepted(joint(inspection="RT", rt_date="2026-10-03", rt_result="PASS"))
    assert A._joint_accepted(joint(inspection="RT", rt_date="2026-10-03", rt_result="FAIL", rt_2_date="2026-10-09", rt_2_result="PASS"))
    assert not A._joint_accepted(joint(inspection="RT", rt_date="2026-10-03", rt_result="FAIL"))
    assert not A._joint_accepted(joint(inspection="RT"))                       # RT 지정인데 결과 없음


@pytest.mark.parametrize("insp,col", [("PT", "pt"), ("MT", "mt")])
def test_accepted_pt_mt(insp, col):
    assert A._joint_accepted(joint(inspection=insp, **{f"{col}_date": "2026-10-03", f"{col}_result": "PASS"}))
    assert not A._joint_accepted(joint(inspection=insp, **{f"{col}_date": "2026-10-03", f"{col}_result": "FAIL"}))
    assert not A._joint_accepted(joint(inspection=insp))


def test_accepted_pwht_required_when_y():
    assert not A._joint_accepted(joint(pwht="Y"))
    assert not A._joint_accepted(joint(pwht="Y", pwht_result="FAIL"))
    assert A._joint_accepted(joint(pwht="Y", pwht_result="PASS"))


def test_accepted_vt_only_with_failed_extra_nde():
    """VT 전용이어도 실시된 NDE가 FAIL이면 합격이 아니다."""
    assert not A._joint_accepted(joint(inspection="", pt_date="2026-10-03", pt_result="FAIL"))
    assert not A._joint_accepted(joint(inspection="", rt_date="2026-10-03", rt_result="FAIL"))
    assert A._joint_accepted(joint(inspection="", pt_date="2026-10-03", pt_result="PASS"))


# ── _rev_older ────────────────────────────────────────────────────────
@pytest.mark.parametrize("new,cur,expected", [
    ("C01", "C01A", True), ("C01A", "C01B", True), ("C01C", "C03", True),
    ("C03", "C01C", False), ("C01", "C01", False), ("c01", "C01A", True),
    ("VOID", "C01", False), ("C01", "VOID", False),                          # 형식이 다르면 비교하지 않는다
])
def test_rev_older(new, cur, expected):
    assert A._rev_older(new, cur) is expected


# ── _pkg_stage ────────────────────────────────────────────────────────
def test_pkg_stage():
    assert A._pkg_stage(True, {}) == "completed"
    assert A._pkg_stage(False, {"piping_total": 10, "piping_completed": 10, "support_total": 4, "support_installed": 4}) == "ready"
    assert A._pkg_stage(False, {"piping_total": 10, "piping_completed": 10, "support_total": 4, "support_installed": 3}) == "in_progress"
    assert A._pkg_stage(False, {"piping_total": 10, "piping_completed": 3}) == "in_progress"
    assert A._pkg_stage(False, {"piping_total": 10}) == "not_started"
    assert A._pkg_stage(False, {}) == "not_started"


# ── 정렬 키 ───────────────────────────────────────────────────────────
def test_joint_no_key_numeric_order():
    rows = [{"joint_no": n, "id": i} for i, n in enumerate(["10", "2", "1A", "1", "X"])]
    assert [r["joint_no"] for r in sorted(rows, key=A._joint_no_key)] == ["1", "1A", "2", "10", "X"]


def test_tp_sort_key_null_package_last():
    rows = [{"package": None, "iso_drawing": "A", "joint_no": "1", "id": 1},
            {"package": "P2", "iso_drawing": "A", "joint_no": "1", "id": 2},
            {"package": "P1", "iso_drawing": "B", "joint_no": "1", "id": 3}]
    assert [r["id"] for r in sorted(rows, key=A._tp_sort_key)] == [3, 2, 1]


# ── 날짜 검증 ─────────────────────────────────────────────────────────
class _Q:
    def __init__(self, row):
        self.row, self.data = row, []

    def select(self, *_): return self
    def eq(self, *_): return self
    def limit(self, *_): return self

    def execute(self):
        self.data = [self.row]
        return self


class _SB:
    def __init__(self, row):
        self.row = row

    def table(self, _):
        return _Q(self.row)


def test_validate_rejects_inspection_before_weld_date():
    sb = _SB({"date_completed": "2026-10-10", "vt_date": None})
    err = A._validate_joint_update(sb, 1, {"vt_date": "2026-10-09"})
    assert err and "VT" in err


def test_validate_allows_same_or_later_date():
    sb = _SB({"date_completed": "2026-10-10", "vt_date": None})
    assert A._validate_joint_update(sb, 1, {"vt_date": "2026-10-10"}) is None
    assert A._validate_joint_update(sb, 1, {"vt_date": "2026-10-12"}) is None


def test_validate_ignores_saves_without_date_columns():
    assert A._validate_joint_update(_SB({}), 1, {"welder": "IWP-001"}) is None


def test_validate_does_not_block_unchanged_old_error():
    """이미 날짜 오류가 있는 조인트라도, 날짜가 실제로 바뀌지 않는 저장(용접사만 고치기 등)은 막지 않는다."""
    sb = _SB({"date_completed": "2026-10-10", "vt_date": "2026-10-01"})
    assert A._validate_joint_update(sb, 1, {"date_completed": "2026-10-10", "vt_date": "2026-10-01", "welder": "IWP-001"}) is None
