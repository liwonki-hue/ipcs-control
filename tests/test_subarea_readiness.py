# Sub Area 준비율(Test Package 제외)과 Joint Check 숫자순 정렬 규칙을 확인하는 테스트
import app as A


def test_sub_area_readiness_excludes_test_package():
    assert A._readiness({"sub_area": "PR #1"}, 100, 100, 0) == 100.0        # Test Package가 없어도 100%가 된다
    assert A._readiness({"sub_area": "PR #1"}, 90, 45) == 80.0              # (90*7 + 45*2) / 9
    assert A._readiness({"system": "HW"}, 50, 50, 100) == 55.0              # System은 70/20/10 그대로


def test_parsed_sub_areas_use_two_part_readiness():
    raw = {"subareas": [{"sub_area": "PR #1", "total_di": 10, "completed_di": 9, "support_total": 20, "support_comp": 9}]}
    item = A._parse_rpc(raw)["subareas"][0]
    assert item["unified_readiness"] == 80.0


def test_tp_sort_key_orders_joint_numbers_numerically():
    rows = [{"package": "P1", "iso_drawing": "A", "joint_no": n, "id": i} for i, n in enumerate(["10", "2", "1A", "11", "1"])]
    assert [r["joint_no"] for r in sorted(rows, key=A._tp_sort_key)] == ["1", "1A", "2", "10", "11"]
