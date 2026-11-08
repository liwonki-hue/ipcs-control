# ISO Drawing 단위 현황과 데이터 품질 검사를 만드는 순수 함수 모음 (DB·Flask에 의존하지 않는다)
import re

JOINT_COLUMNS = ("id,iso_drawing,joint_no,rev,system,sub_area,package,mat,size_inch,bore,sf,line_no,di,date_completed,welder,"
                 "inspection,pwht,vt_date,vt_result,pt_date,pt_result,mt_date,mt_result,rt_date,rt_result,rt_2_date,rt_2_result,"
                 "pwht_date,pwht_result")
SUPPORT_COLUMNS = "iso_drawing,system,completed,package"

SAMPLE_CAP = 500         # 검사 항목마다 화면에 보여 줄 예시 최대 개수 (전체 건수는 count로 따로 센다)
_NDE = ("vt", "pt", "mt", "rt", "rt_2", "pwht")
_MAT_RE = re.compile(r"CS|SS|ALLOY \(P\d+\)")

# key: (심각도, 제목, 조치 안내) — 화면에는 이 순서대로 보여 준다(심각도 error → warn → info)
CHECKS = {
    "missing_system":      ("error", "Missing System", "Enter the System in Joint Master"),
    "missing_sub_area":    ("error", "Missing Sub Area", "Enter the Sub Area in Joint Master"),
    "missing_mat":         ("error", "Missing Material", "Enter the Material (affects the PWHT rule and Material breakdowns)"),
    "missing_size":        ("error", "Missing or zero Size", "Enter size_inch (affects the Bore class and D/I)"),
    "mat_format":          ("error", "Invalid Material format", "Must be CS, SS, ALLOY (P22) or ALLOY (P91), with the space"),
    "gm1_not_ss":          ("error", "GM1 line but Material is not SS", "GM1 lines must be SS"),
    "pwht_rule":           ("error", "PWHT rule violation", "CS, SS and P22 must be N; P91 must be Y"),
    "bore_rule":           ("error", "Wrong Bore class", "size_inch <= 2 is Small, otherwise Large"),
    "date_order":          ("error", "Inspection date earlier than weld date", "Correct the dates"),
    "result_without_date": ("error", "Result entered without an inspection date", "Enter the inspection date"),
    "nde_without_weld":    ("error", "Inspection recorded without a weld date", "Enter the weld date or check the inspection record"),
    "weld_future":         ("error", "Weld date is in the future", "Check for a date typo"),
    "welded_no_welder":    ("warn", "Welded but no welder entered", "Enter the welder"),
    "sf_invalid":          ("warn", "S/F is not S or F", "Use capital S or F (a lowercase s is counted as Shop in the totals)"),
    "iso_multi_rev":       ("warn", "Several Revs within one ISO", "Use the same Rev for the whole ISO"),
    "iso_multi_system":    ("warn", "Several Systems within one ISO", "An ISO should belong to a single System"),
    "iso_multi_sub_area":  ("info", "Several Sub Areas within one ISO", "Can be normal when a line crosses areas - just confirm it is intended"),
    "iso_system_mismatch": ("warn", "System differs between Joint and Support", "Align the System in both places (a System change must be made in all 3 tables)"),
    "package_orphan":      ("warn", "Package not in Test Package Register", "Register the package or check the Package spelling"),
    "missing_in_drawing":  ("warn", "ISO not found in Drawing DB", "Check whether the drawing has been uploaded"),
    "rev_mismatch":        ("warn", "Joint Rev differs from Drawing DB Rev", "Check whether work is on a superseded drawing, then update the Rev"),
    "void_with_joints":    ("warn", "Joints remain on a VOID drawing", "Find the replacement drawing and clean up the joints"),
    "missing_package":     ("info", "No Package assigned", "Confirm whether this scope needs a Package"),
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
        self._accepted, self._required_pwht = accepted, required_pwht
        self._today_s = today.isoformat()
        self.isos = {}
        self.joint_count = 0
        self.checks = {k: {"count": 0, "samples": []} for k in CHECKS}
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
        if weld:
            a["welded"] += 1
            a["welded_di"] += di
            if fab:
                a["fab_w"] += 1
            elif erect:
                a["erect_w"] += 1
            if weld > a["last_weld"]:
                a["last_weld"] = weld
        if accepted:
            a["accepted"] += 1

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
            f("pwht_rule", f"mat='{mat}' -> PWHT must be {need}, found '{pwht or 'empty'}'")
        if size > 0:
            want = "Small" if size <= 2 else "Large"
            if _s(r.get("bore")) != want: f("bore_rule", f"size_inch={size:g} -> must be {want}, found '{_s(r.get('bore')) or 'empty'}'")
        if sf not in ("S", "F"): f("sf_invalid", f"sf='{sf}'")
        if not pkg: f("missing_package", "")
        if weld:
            if weld > self._today_s: f("weld_future", weld)
            if not _s(r.get("welder")): f("welded_no_welder", weld)
        any_nde = False
        for p in _NDE:
            d, res = _s(r.get(p + "_date"))[:10], _s(r.get(p + "_result"))
            if res and not d: f("result_without_date", f"{p.upper()} result {res}")
            if d or res: any_nde = True
            if d and weld and d < weld: f("date_order", f"{p.upper()} {d} < weld {weld}")
        if any_nde and not weld: f("nde_without_weld", "Inspection recorded but no weld date")

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
                self._flag("iso_system_mismatch", iso, f"Joint {'/'.join(systems)} <-> Support {'/'.join(sorted(sup_sys))}")
            if drawing is not None and iso:
                rev = drawing.get(iso)
                if rev is None:
                    self._flag("missing_in_drawing", iso, f"{a['n']} joints")
                elif rev.upper() == "VOID":
                    self._flag("void_with_joints", iso, f"{a['n']} joints ({a['welded']} welded)")
                elif revs and set(revs) != {rev}:
                    self._flag("rev_mismatch", iso, f"Joint {'/'.join(revs) or 'empty'} <-> Drawing {rev}")
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
                    self._flag("package_orphan", "", f"{pkg} ({cnt} joints)")

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
        }
