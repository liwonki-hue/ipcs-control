# Joint Master 화면의 필터가 Export·Print 조회에 빠짐없이 전달되는지 확인하는 테스트
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_joint_master_export_sends_every_screen_filter():
    """화면의 jm-* 필터를 Export가 빠뜨리면 필터를 고르고 내려받아도 전체 Joint가 나온다(2026-11-24 Material 필터 사례)."""
    html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "static" / "js" / "dashboard.js").read_text(encoding="utf-8")
    screen = set(re.findall(r'<(?:select|input)[^>]*\bid="(jm-[a-z]+)"', html)) - {"jm-count"}
    fields = re.search(r"const _JM_FILTER_FIELDS = \[(.*?)\];", js, re.S).group(1)
    sent = set(re.findall(r'\["(jm-[a-z]+)"', fields))
    assert screen, "화면 필터를 찾지 못했다"
    assert screen <= sent, f"Export에 빠진 필터: {sorted(screen - sent)}"
    # Export와 Print가 같은 목록을 쓴다
    assert js.count("_readFilters(_JM_FILTER_FIELDS)") >= 2
