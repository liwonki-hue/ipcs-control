# /api/joints 본 조회의 앞뒤 여유 행(윈도우)으로 경계 ISO 재조회를 줄여도 결과가 "전체 숫자순 정렬 후 자르기"와 같은지 확인하는 테스트
import random

import pytest

import app as A


def make_dataset(seed, n_iso=60, max_size=30, null_rate=0.05):
    rnd = random.Random(seed)
    rows, rid = [], 1
    for k in range(n_iso):
        iso = f"ISO-{k:03d}" if rnd.random() >= null_rate else None                # 일부는 ISO가 없는 행(DB 정렬에서 맨 뒤, 한 덩어리로 합쳐진다)
        size = rnd.randint(1, max_size)
        nos = [str(i) for i in range(1, size + 1)]
        nos += [f"{rnd.randint(1, size)}A" for _ in range(rnd.randint(0, 2))]       # 1A처럼 숫자 뒤에 글자
        rnd.shuffle(nos)
        for no in nos:
            rows.append({"id": rid, "iso_drawing": iso, "joint_no": no})
            rid += 1
    return rows


def db_order(rows):
    """DB의 정렬: iso_drawing(없으면 맨 뒤), joint_no 문자열(1,10,11,...,2), id"""
    return sorted(rows, key=lambda r: (r["iso_drawing"] is None, r["iso_drawing"] or "", r["joint_no"], r["id"]))


def expected_page(rows, offset, limit):
    """화면에 보여야 하는 결과: ISO 순서는 그대로, 같은 ISO 안은 joint_no 숫자순으로 정렬한 전체에서 자른 페이지"""
    ordered = sorted(db_order(rows), key=lambda r: (r["iso_drawing"] is None, r["iso_drawing"] or "", A._joint_no_key(r)))
    return ordered[offset: offset + limit]


def run_page(rows, offset, limit, margin):
    """app.py의 엔드포인트와 같은 순서로 페이지를 만든다. 반환: (결과 id 목록, DB 재조회 횟수)"""
    data = db_order(rows)
    total = len(data)
    fetched = []

    def fetch_iso_rows(iso):
        fetched.append(iso)
        return [r for r in data if r["iso_drawing"] == iso]

    lo = max(0, offset - margin)
    window = data[lo: offset + limit + margin]
    page = window[offset - lo: offset - lo + limit]
    has_after = offset + len(page) < total
    resolve = A._iso_rows_from_window(window, lo, total, fetch_iso_rows)
    out = A._sort_joints_numeric(page, resolve, offset > 0, has_after)
    return [r["id"] for r in out], len(fetched)


@pytest.mark.parametrize("seed", range(6))
@pytest.mark.parametrize("margin", [0, 3, 12, 40])
def test_windowed_page_equals_global_numeric_order(seed, margin):
    rows = make_dataset(seed)
    rnd = random.Random(seed * 100 + margin)
    total = len(rows)
    cases = [(0, 15), (15, 15), (total - 7, 15), (total - 1, 15), (total, 15), (total + 50, 15), (0, total + 10), (5, 1)]
    cases += [(rnd.randint(0, total), rnd.choice([1, 7, 12, 15, 30, 100])) for _ in range(60)]
    for offset, limit in cases:
        got, _ = run_page(rows, offset, limit, margin)
        want = [r["id"] for r in expected_page(rows, offset, limit)]
        assert got == want, (seed, margin, offset, limit)


def test_enough_margin_needs_no_db_refetch():
    """ISO가 여유분보다 작으면(실데이터: 평균 13·최대 52, 여유 40) 페이지 위치와 상관없이 DB 재조회가 0회다.
    ISO가 없는 행은 하나의 큰 덩어리가 되어 여유분을 넘을 수 있으므로 이 시험에서는 뺀다(실데이터에는 없다)."""
    rows = make_dataset(1, max_size=30, null_rate=0)
    total = len(rows)
    refetch = 0
    for offset in range(0, total, 7):
        _, n = run_page(rows, offset, 15, margin=40)
        refetch += n
    assert refetch == 0


def test_without_margin_boundary_isos_are_refetched():
    """여유분이 0이면(기존 방식) 중간 페이지는 경계 ISO를 DB에서 다시 받는다 — 개선 전과 같은 동작."""
    rows = make_dataset(1)
    total = len(rows)
    counts = [run_page(rows, off, 15, margin=0)[1] for off in range(15, total - 30, 15)]
    assert sum(counts) > len(counts)                                              # 페이지당 평균 1회 이상


def test_isos_larger_than_the_margin_still_correct_via_fallback():
    rows = make_dataset(3, n_iso=20, max_size=60)                                 # 여유분(10)보다 큰 ISO가 많다
    total = len(rows)
    fallbacks = 0
    for offset in range(0, total, 5):
        got, n = run_page(rows, offset, 15, margin=10)
        assert got == [r["id"] for r in expected_page(rows, offset, 15)], offset
        fallbacks += n
    assert fallbacks > 0                                                          # 보완 경로(DB 재조회)가 실제로 쓰였다


def test_resolver_uses_window_only_when_both_ends_are_visible():
    window = [{"id": 1, "iso_drawing": "A", "joint_no": "1"}, {"id": 2, "iso_drawing": "B", "joint_no": "1"}, {"id": 3, "iso_drawing": "B", "joint_no": "2"},
              {"id": 4, "iso_drawing": "C", "joint_no": "1"}]
    calls = []
    fetch = lambda iso: calls.append(iso) or ["from-db"]
    r = A._iso_rows_from_window(window, lo=10, total=100, fetch_iso_rows=fetch)
    assert [x["id"] for x in r("B")] == [2, 3] and calls == []                    # 앞뒤에 다른 ISO가 있어 완결
    assert r("A") == ["from-db"] and r("C") == ["from-db"]                        # 윈도우 양 끝 ISO는 더 이어질 수 있다
    r0 = A._iso_rows_from_window(window, lo=0, total=100, fetch_iso_rows=fetch)
    assert [x["id"] for x in r0("A")] == [1]                                      # 윈도우가 데이터셋 처음이면 앞쪽은 완결
    r_end = A._iso_rows_from_window(window, lo=96, total=100, fetch_iso_rows=fetch)
    assert [x["id"] for x in r_end("C")] == [4]                                   # 윈도우가 데이터셋 끝이면 뒤쪽은 완결
    assert r("Z") == ["from-db"]                                                  # 윈도우에 없는 ISO
