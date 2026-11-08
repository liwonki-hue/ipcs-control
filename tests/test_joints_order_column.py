# /api/joints가 DB의 joint_no_num 컬럼으로 정렬하고, 컬럼이 없으면 윈도우 방식으로 자동 전환하는지 가짜 DB로 확인하는 테스트
import time
from types import SimpleNamespace

import pytest
from postgrest.exceptions import APIError

import app as A

MISSING = {"message": "column joint_master.joint_no_num does not exist", "code": "42703", "hint": None, "details": None}


def make_rows():
    rows, rid = [], 1
    for iso, n in (("ISO-A", 14), ("ISO-B", 12), ("ISO-C", 3)):
        nos = [str(i) for i in range(1, n + 1)] + ["3A"]
        nos.reverse()
        for no in nos:
            rows.append({"id": rid, "iso_drawing": iso, "joint_no": no, "joint_no_num": int("".join(ch for ch in no if ch.isdigit()) or 0) if no[0].isdigit() else 10**9})
            rid += 1
    return rows


ROWS = make_rows()


def numeric_order(rows):
    return sorted(rows, key=lambda r: (r["iso_drawing"], r["joint_no_num"], r["joint_no"], r["id"]))


class FakeQuery:
    """PostgREST 질의 흉내: order/eq/range를 기록하고 DB 정렬대로 결과를 돌려준다. fail이 주어지면 joint_no_num으로 정렬하는 질의에서 오류를 낸다."""

    def __init__(self, log, fail):
        self.log, self.fail = log, fail
        self.orders, self.eqs, self.rng = [], [], None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self.eqs.append((col, val))
        return self

    def order(self, col):
        self.orders.append(col)
        return self

    def range(self, lo, hi):
        self.rng = (lo, hi)
        return self

    def execute(self):
        self.log.append(self)
        if self.fail is not None and "joint_no_num" in self.orders:
            raise APIError(self.fail)
        if "joint_no_num" in self.orders:
            data = numeric_order(ROWS)
        else:
            data = sorted(ROWS, key=lambda r: (r["iso_drawing"], r["joint_no"], r["id"]))      # 문자열 정렬: 1, 10, 11, ..., 2
        for col, val in self.eqs:
            data = [r for r in data if r[col] == val]
        total = len(data)
        if self.rng:
            data = data[self.rng[0]: self.rng[1] + 1]
        return SimpleNamespace(data=[dict(r) for r in data], count=total)


@pytest.fixture
def db(monkeypatch):
    log = []
    holder = SimpleNamespace(fail=None, log=log)
    monkeypatch.setattr(A, "get_sb", lambda: SimpleNamespace(table=lambda _name: FakeQuery(log, holder.fail)))
    monkeypatch.setattr(A, "_jno_num_state", None)
    monkeypatch.setattr(A, "_jno_num_checked", 0.0)
    return holder


def page_ids(client, offset, limit):
    r = client.get(f"/api/joints?limit={limit}&offset={offset}")
    assert r.status_code == 200, r.get_json()
    return [x["id"] for x in r.get_json()["data"]], r.get_json()["count"]


def expected(offset, limit):
    return [r["id"] for r in numeric_order(ROWS)[offset: offset + limit]]


def test_uses_the_column_in_a_single_query(client, db):
    ids, count = page_ids(client, 5, 10)
    assert ids == expected(5, 10) and count == len(ROWS)
    assert len(db.log) == 1                                                       # 조회 한 번(경계 ISO 재조회 없음)
    q = db.log[0]
    assert q.orders == ["iso_drawing", "joint_no_num", "joint_no", "id"] and q.rng == (5, 14)
    assert A._jno_num_state is True


def test_falls_back_to_the_window_method_when_the_column_is_missing(client, db):
    db.fail = MISSING
    for offset in (0, 7, 14, 20, 28):
        ids, _ = page_ids(client, offset, 9)
        assert ids == expected(offset, 9), offset                                 # 컬럼이 없어도 결과는 같다
    assert A._jno_num_state is False


def test_does_not_retry_the_missing_column_on_every_request(client, db):
    db.fail = MISSING
    page_ids(client, 0, 9)
    db.log.clear()
    page_ids(client, 9, 9)
    assert not any("joint_no_num" in q.orders for q in db.log)                    # 이미 없다고 알았으니 다시 시도하지 않는다


def test_rechecks_after_the_interval_and_returns_to_the_column(client, db, monkeypatch):
    db.fail = MISSING
    page_ids(client, 0, 9)
    assert A._jno_num_state is False
    db.fail = None                                                                # 그 사이 사용자가 SQL을 실행했다
    monkeypatch.setattr(A, "_jno_num_checked", time.time() - A._JNO_NUM_RECHECK_SEC - 1)
    ids, _ = page_ids(client, 3, 9)
    assert ids == expected(3, 9) and A._jno_num_state is True


def test_other_database_errors_are_not_mistaken_for_a_missing_column(client, db):
    db.fail = {"message": "canceling statement due to statement timeout", "code": "57014", "hint": None, "details": None}
    r = client.get("/api/joints?limit=9&offset=0")
    assert r.status_code == 500                                                   # 관계없는 오류는 그대로 오류
    assert A._jno_num_state is None                                               # 컬럼이 없다고 잘못 기록하지 않는다


def test_row_data_includes_the_new_column_without_breaking_clients(client, db):
    r = client.get("/api/joints?limit=3&offset=0")
    assert all("joint_no" in row for row in r.get_json()["data"])
