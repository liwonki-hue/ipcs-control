# ISO Drawing 단위 현황, 데이터 품질 검사, System별 진행 속도·완료 예측을 만드는 순수 함수 모음 (DB·Flask에 의존하지 않는다)
import math
import re
from datetime import date, timedelta

JOINT_COLUMNS = ("id,iso_drawing,joint_no,rev,system,sub_area,package,mat,size_inch,bore,sf,line_no,di,date_completed,welder,"
                 "inspection,pwht,vt_date,vt_result,pt_date,pt_result,mt_date,mt_result,rt_date,rt_result,rt_2_date,rt_2_result,"
                 "pwht_date,pwht_result")
SUPPORT_COLUMNS = "iso_drawing,system,completed,package"

SAMPLE_CAP = 500         # 검사 항목마다 화면에 보여 줄 예시 최대 개수 (전체 건수는 count로 따로 센다)
PACE_WINDOW_DAYS = 28    # 최근 4주 평균으로 속도를 잡는다
_NDE = ("vt", "pt", "mt", "rt", "rt_2", "pwht")
_MAT_RE = re.compile(r"CS|SS|ALLOY \(P\d+\)")

# key: (심각도, 제목, 조치 안내) — 화면에는 이 순서대로 보여 준다(심각도 error → warn → info)
CHECKS = {
    "missing_system":      ("error", "System 없음", "Joint Master에서 System을 입력"),
    "missing_sub_area":    ("error", "Sub Area 없음", "Joint Master에서 Sub Area를 입력"),
    "missing_mat":         ("error", "Material 없음", "Material을 입력(PWHT 규칙과 Material별 집계에 영향)"),
    "missing_size":        ("error", "Size 없음/0", "size_inch를 입력(Bore 구분과 DI 계산에 영향)"),
    "mat_format":          ("error", "Material 표기 오류", "CS · SS · ALLOY (P22) · ALLOY (P91) 형식이어야 함(공백 포함)"),
    "gm1_not_ss":          ("error", "Line No에 GM1이 있는데 Material이 SS가 아님", "GM1 라인은 SS"),
    "pwht_rule":           ("error", "PWHT 규칙 위반", "CS·SS·P22는 N, P91은 Y"),
    "bore_rule":           ("error", "Bore 구분 오류", "size_inch ≤ 2 → Small, 그 외 Large"),
    "date_order":          ("error", "검사일이 용접일보다 빠름", "날짜를 바로잡기"),
    "result_without_date": ("error", "결과는 있는데 검사일이 없음", "검사일을 입력"),
    "nde_without_weld":    ("error", "용접일 없이 검사가 기록됨", "용접일을 입력하거나 검사 기록을 확인"),
    "weld_future":         ("error", "용접일이 오늘 이후", "날짜 오타 확인"),
    "welded_no_welder":    ("warn", "용접일은 있는데 용접사가 없음", "용접사를 입력"),
    "sf_invalid":          ("warn", "S/F 값이 S 또는 F가 아님", "대문자 S 또는 F로 통일(소문자 s는 집계에서 Shop으로 취급됨)"),
    "iso_multi_rev":       ("warn", "한 ISO 안에 Rev가 여러 개", "ISO 전체를 같은 Rev로"),
    "iso_multi_system":    ("warn", "한 ISO 안에 System이 여러 개", "ISO 하나는 한 System이어야 함"),
    "iso_multi_sub_area":  ("info", "한 ISO 안에 Sub Area가 여러 개", "배관이 여러 구역을 지나면 정상일 수 있음 — 의도한 것인지만 확인"),
    "iso_system_mismatch": ("warn", "Joint와 Support의 System이 다름", "두 곳의 System을 맞추기(System 변경은 3곳을 같이 고쳐야 함)"),
    "package_orphan":      ("warn", "Test Package Register에 없는 Package", "Register에 등록하거나 Package 표기 확인"),
    "missing_in_drawing":  ("warn", "Drawing DB에 없는 ISO", "도면 업로드 여부 확인"),
    "rev_mismatch":        ("warn", "Joint Rev와 Drawing DB Rev가 다름", "개정 전 도면으로 시공하는지 확인 후 Rev 갱신"),
    "void_with_joints":    ("warn", "VOID 도면에 조인트가 남아 있음", "대체 도면 확인 후 조인트 정리"),
    "missing_package":     ("info", "Package 미지정", "Package가 필요한 범위인지 확인"),
}


def _s(v):
    return ("" if v is None else str(v)).strip()


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


class Analyzer:
    """조인트·Support 행을 한 건씩 흘려 넣어 집계한다(전체 행을 메모리에 쌓지 않는다).
    accepted(row): 조인트가 시험 가능한 상태인지, required_pwht(mat): 재질별 PWHT 고정값 — 둘 다 app.py의 규칙 함수를 받는다."""

    def __init__(self, accepted, required_pwht, today):
        self._accepted, self._required_pwht, self.today = accepted, required_pwht, today
        self._today_s = today.isoformat()
        self._cutoff = (today - timedelta(days=PACE_WINDOW_DAYS - 1)).isoformat()
        self.isos = {}
        self.joint_count = 0
        self.checks = {k: {"count": 0, "samples": []} for k in CHECKS}
        self.pace = {"system": {}, "sub_area": {}}
        self.overall = [0.0, 0.0, 0.0, 0, 0]          # 전체 DI, 완료 DI, 최근 4주 완료 DI, 전체 조인트, 완료 조인트
        self.packages = {}                             # Joint Master Package → 조인트 수
        self._sup_systems = {}                         # iso → Support에 있는 System 집합

    # ── 검사 결과 기록 ────────────────────────────────────────────────
    def _flag(self, key, iso, detail, row_id=None, joint_no=None):
        c = self.checks[key]
        c["count"] += 1
        if len(c["samples"]) < SAMPLE_CAP:
            c["samples"].append({"id": row_id, "iso": iso, "joint_no": joint_no, "detail": detail})

    # ── Joint Master 한 행 ────────────────────────────────────────────
    def add_joint(self, r):
        self.joint_count += 1
        iso = _s(r.get("iso_drawing"))
        rid, jno = r.get("id"), r.get("joint_no")
        di = _num(r.get("di"))
        sf = _s(r.get("sf"))
        sfu = sf.upper()
        weld = _s(r.get("date_completed"))[:10]
        system, sub_area, mat, pkg = _s(r.get("system")), _s(r.get("sub_area")), _s(r.get("mat")), _s(r.get("package"))
        accepted = bool(weld) and self._accepted(r)

        a = self.isos.get(iso)
        if a is None:
            a = self.isos[iso] = {"revs": set(), "systems": set(), "sub_areas": set(), "packages": set(),
                                  "n": 0, "di": 0.0, "welded": 0, "welded_di": 0.0, "fab_n": 0, "fab_w": 0, "erect_n": 0,
                                  "erect_w": 0, "accepted": 0, "last_weld": "", "sup_n": 0, "sup_done": 0}
        a["n"] += 1
        a["di"] += di
        a["revs"].add(_s(r.get("rev")))
        a["systems"].add(system)
        a["sub_areas"].add(sub_area)
        if pkg:
            a["packages"].add(pkg)
            self.packages[pkg] = self.packages.get(pkg, 0) + 1
        fab, erect = sfu in ("S", "SHOP"), sfu in ("F", "FIELD")
        if fab:
            a["fab_n"] += 1
        elif erect:
            a["erect_n"] += 1
        recent = False
        if weld:
            a["welded"] += 1
            a["welded_di"] += di
            if fab:
                a["fab_w"] += 1
            elif erect:
                a["erect_w"] += 1
            if weld > a["last_weld"]:
                a["last_weld"] = weld
            recent = self._cutoff <= weld <= self._today_s
        if accepted:
            a["accepted"] += 1

        # 진행 속도(System·Sub Area별 전체/완료/최근 4주 DI)
        for dim, key in (("system", system), ("sub_area", sub_area)):
            g = self.pace[dim].setdefault(key or "(none)", [0.0, 0.0, 0.0, 0, 0])
            g[0] += di
            g[3] += 1
            if weld:
                g[1] += di
                g[4] += 1
                if recent:
                    g[2] += di
        o = self.overall
        o[0] += di
        o[3] += 1
        if weld:
            o[1] += di
            o[4] += 1
            if recent:
                o[2] += di

        # 데이터 품질
        f = lambda key, detail: self._flag(key, iso, detail, rid, jno)
        if not system: f("missing_system", "")
        if not sub_area: f("missing_sub_area", "")
        if not mat: f("missing_mat", "")
        size = _num(r.get("size_inch"))
        if size <= 0: f("missing_size", f"size_inch={r.get('size_inch')}")
        if mat and not _MAT_RE.fullmatch(mat): f("mat_format", f"mat='{mat}'")
        if "GM1" in _s(r.get("line_no")).upper() and mat != "SS": f("gm1_not_ss", f"mat='{mat}', line_no={_s(r.get('line_no'))}")
        need, pwht = self._required_pwht(mat), _s(r.get("pwht"))
        if (need == "N" and pwht == "Y") or (need == "Y" and pwht != "Y"):
            f("pwht_rule", f"mat='{mat}' → PWHT는 {need}여야 하는데 '{pwht or '빈 값'}'")
        if size > 0:
            want = "Small" if size <= 2 else "Large"
            if _s(r.get("bore")) != want: f("bore_rule", f"size_inch={size:g} → {want}여야 하는데 '{_s(r.get('bore')) or '빈 값'}'")
        if sf not in ("S", "F"): f("sf_invalid", f"sf='{sf}'")
        if not pkg: f("missing_package", "")
        if weld:
            if weld > self._today_s: f("weld_future", weld)
            if not _s(r.get("welder")): f("welded_no_welder", weld)
        any_nde = False
        for p in _NDE:
            d, res = _s(r.get(p + "_date"))[:10], _s(r.get(p + "_result"))
            if res and not d: f("result_without_date", f"{p.upper()} 결과 {res}")
            if d or res: any_nde = True
            if d and weld and d < weld: f("date_order", f"{p.upper()} {d} < 용접 {weld}")
        if any_nde and not weld: f("nde_without_weld", "검사 기록은 있는데 용접일 없음")

    # ── Support 한 행 ─────────────────────────────────────────────────
    def add_support(self, r):
        iso = _s(r.get("iso_drawing"))
        a = self.isos.get(iso)
        if a is None:
            return
        a["sup_n"] += 1
        if r.get("completed"):
            a["sup_done"] += 1
        if _s(r.get("system")):
            self._sup_systems.setdefault(iso, set()).add(_s(r.get("system")))

    # ── 결과 만들기 ───────────────────────────────────────────────────
    def result(self, testpkg_numbers=None, drawing=None, drawing_error=None):
        """testpkg_numbers: Test Package Register의 번호 집합(없으면 Package 대조 생략).
        drawing: {도면번호: revision} (Drawing DB를 못 읽었으면 None), drawing_error: 못 읽은 이유."""
        rows = []
        for iso, a in self.isos.items():
            revs = sorted(x for x in a["revs"] if x)
            systems = sorted(x for x in a["systems"] if x)
            subs = sorted(x for x in a["sub_areas"] if x)
            pkgs = sorted(a["packages"])
            if len(revs) > 1: self._flag("iso_multi_rev", iso, " / ".join(revs))
            if len(systems) > 1: self._flag("iso_multi_system", iso, " / ".join(systems))
            if len(subs) > 1: self._flag("iso_multi_sub_area", iso, " / ".join(subs))
            sup_sys = self._sup_systems.get(iso)
            if sup_sys and systems and not (sup_sys & set(systems)):
                self._flag("iso_system_mismatch", iso, f"Joint {'/'.join(systems)} ↔ Support {'/'.join(sorted(sup_sys))}")
            if drawing is not None and iso:
                rev = drawing.get(iso)
                if rev is None:
                    self._flag("missing_in_drawing", iso, f"조인트 {a['n']}건")
                elif rev.upper() == "VOID":
                    self._flag("void_with_joints", iso, f"조인트 {a['n']}건 (용접 {a['welded']}건)")
                elif revs and set(revs) != {rev}:
                    self._flag("rev_mismatch", iso, f"Joint {'/'.join(revs) or '빈 값'} ↔ Drawing {rev}")
            n, w = a["n"], a["welded"]
            if w == 0: status = "NOT_STARTED"
            elif w < n: status = "WELDING"
            elif a["accepted"] < n: status = "WELDED"
            else: status = "ACCEPTED"
            rows.append({
                "iso": iso, "rev": revs[0] if len(revs) == 1 else ("(multi)" if revs else ""),
                "system": systems[0] if len(systems) == 1 else ("(multi)" if systems else ""),
                "sub_area": subs[0] if len(subs) == 1 else ("(multi)" if subs else ""),
                "package": pkgs[0] if len(pkgs) == 1 else ("(multi)" if pkgs else ""),
                "n": n, "di": round(a["di"], 2), "welded": w, "welded_di": round(a["welded_di"], 2),
                "fab_n": a["fab_n"], "fab_w": a["fab_w"], "erect_n": a["erect_n"], "erect_w": a["erect_w"],
                "accepted": a["accepted"], "pending": w - a["accepted"], "last_weld": a["last_weld"],
                "sup_n": a["sup_n"], "sup_done": a["sup_done"], "status": status,
                "fab_done_erect_open": a["fab_n"] > 0 and a["fab_w"] == a["fab_n"] and a["erect_w"] < a["erect_n"],
            })
        rows.sort(key=lambda x: x["iso"])

        if testpkg_numbers is not None:
            for pkg, cnt in sorted(self.packages.items()):
                if pkg not in testpkg_numbers:
                    self._flag("package_orphan", "", f"{pkg} (조인트 {cnt}건)")

        order = {"error": 0, "warn": 1, "info": 2}
        checks = [{"key": k, "severity": CHECKS[k][0], "title": CHECKS[k][1], "hint": CHECKS[k][2],
                   "count": c["count"], "samples": c["samples"]} for k, c in self.checks.items()]
        checks.sort(key=lambda c: (order[c["severity"]], -c["count"]))
        return {
            "today": self._today_s,
            "joints": self.joint_count,
            "isos": rows,
            "quality": {"checks": checks, "drawing_available": drawing is not None, "drawing_error": drawing_error,
                        "testpkg_checked": testpkg_numbers is not None},
            "pace": self._pace_tables(),
        }

    # ── 진행 속도·완료 예측 ───────────────────────────────────────────
    def _pace_row(self, name, g):
        total, done, recent = g[0], g[1], g[2]
        remaining = max(total - done, 0.0)
        per_week = recent / (PACE_WINDOW_DAYS / 7)
        weeks = remaining / per_week if per_week > 0 else None
        eta = (self.today + timedelta(days=math.ceil(weeks * 7))).isoformat() if weeks is not None else None
        if remaining == 0:
            weeks, eta = 0.0, self._today_s
        return {"name": name, "total_di": round(total, 1), "done_di": round(done, 1), "remaining_di": round(remaining, 1),
                "pct": round(done / total * 100, 2) if total else 0.0, "recent_di": round(recent, 1),
                "per_week": round(per_week, 1), "eta_weeks": None if weeks is None else round(weeks, 1), "eta_date": eta}

    def _pace_tables(self):
        def table(dim):
            return sorted((self._pace_row(k, g) for k, g in self.pace[dim].items()), key=lambda x: (-x["remaining_di"], x["name"]))
        return {"window_days": PACE_WINDOW_DAYS, "overall": self._pace_row("ALL", self.overall),
                "by_system": table("system"), "by_sub_area": table("sub_area")}
