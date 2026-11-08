# 테스트 공용 설정 — 운영 DB 없이 앱을 임포트하고 가짜 Supabase 클라이언트를 끼워 넣는다
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as app_module  # noqa: E402


class FakeQuery:
    def __init__(self, log, table):
        self.log, self.table_name, self.payload = log, table, None
        self.data = []

    def update(self, payload):
        self.payload = payload
        return self

    def select(self, *_):
        return self

    def limit(self, *_):
        return self

    def eq(self, col, val):
        if self.payload is not None:
            self.log.append((self.table_name, self.payload, col, val))
        return self

    def execute(self):
        return self


class FakeSB:
    """update()된 내용만 기록하고, select()는 빈 결과를 돌려준다."""

    def __init__(self):
        self.log = []

    def table(self, name):
        return FakeQuery(self.log, name)


@pytest.fixture
def fake_sb(monkeypatch):
    sb = FakeSB()
    monkeypatch.setattr(app_module, "get_sb", lambda: sb)
    monkeypatch.setattr(app_module, "_update_tp_status_cache", lambda ids: None)
    return sb


@pytest.fixture
def client(fake_sb):
    """editor로 로그인한 테스트 클라이언트"""
    c = app_module.app.test_client()
    with c.session_transaction() as s:
        s["role"] = "editor"
    return c


@pytest.fixture
def anon_client(fake_sb):
    return app_module.app.test_client()
