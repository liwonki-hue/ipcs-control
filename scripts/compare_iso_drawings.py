# joint_master(JM)와 drawing.dwg_latest(ipcs-drawing) 비교 — Drawing DB 기준으로 JM 누락/Revision 불일치를 엑셀로 출력
import os
from collections import Counter, defaultdict
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from supabase import create_client, ClientOptions

VOID_REV = "VOID"


def load_env():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(base_dir, ".env")
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()


def fetch_all(sb, table, cols, page_size=1000):
    """id 순으로 페이지네이션한다(정렬 없이 range만 쓰면 페이지 경계에서 행이 중복/누락될 수 있음).
    끝나면 전체 건수와 대조해 어긋나면 중단한다."""
    total = sb.table(table).select("id", count="exact").limit(1).execute().count
    rows, offset = [], 0
    while True:
        batch = sb.table(table).select(cols).order("id").range(offset, offset + page_size - 1).execute().data or []
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    if len(rows) != total:
        raise RuntimeError(f"{table}: {len(rows)}건을 읽었지만 테이블은 {total}건입니다. 다시 실행하세요.")
    return rows


def norm(v):
    return (v or "").strip()


def rev_text(revs):
    return ", ".join(f"{rev or '(blank)'}({cnt})" for rev, cnt in sorted(revs.items(), key=lambda x: (-x[1], x[0])))


def main():
    load_env()

    ctrl_sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"],
                            options=ClientOptions(schema="construction", postgrest_client_timeout=90))
    draw_sb = create_client(os.environ["DRAWING_SUPABASE_URL"], os.environ["DRAWING_SUPABASE_KEY"],
                            options=ClientOptions(schema="drawing", postgrest_client_timeout=120))

    print("Fetching joint_master (JM)...")
    jm_rows = fetch_all(ctrl_sb, "joint_master", "id,iso_drawing,rev")
    print(f"  {len(jm_rows)} rows")
    print("Fetching drawing.dwg_latest (Drawing DB, 기준)...")
    dwg_rows = fetch_all(draw_sb, "dwg_latest", "id,drawing_no,line_no,system,title,revision,remark")
    print(f"  {len(dwg_rows)} rows")

    jm_revs = defaultdict(Counter)  # ISO -> {rev: 조인트 수}
    for row in jm_rows:
        iso = norm(row.get("iso_drawing"))
        if iso:
            jm_revs[iso][norm(row.get("rev"))] += 1
    dwg = {norm(r.get("drawing_no")): r for r in dwg_rows if norm(r.get("drawing_no"))}

    result = []          # (구분, drawing_no, dwg row, drawing rev, JM rev 텍스트, JM 조인트 수, 불일치 조인트 수, 비고)
    rev_pairs = Counter()        # (Drawing rev, JM rev) -> ISO 수
    rev_pair_joints = Counter()  # (Drawing rev, JM rev) -> 조인트 수
    for no in sorted(dwg):
        d = dwg[no]
        d_rev = norm(d.get("revision"))
        is_void = d_rev.upper() == VOID_REV
        revs = jm_revs.get(no)
        if revs is None:
            note = "Drawing DB에서 VOID 처리된 도면 - JM에 조인트가 없는 것이 정상일 수 있음" if is_void else ""
            result.append(("JM 누락", no, d, d_rev, "", 0, 0, note))
            continue
        bad = {rev: cnt for rev, cnt in revs.items() if rev.upper() != d_rev.upper()}
        if not bad:
            continue
        notes = []
        if is_void:
            notes.append("VOID 처리된 도면인데 JM에 조인트가 있음 - 확인 필요")
        if len(revs) > 1:
            notes.append("JM 내 Revision 혼재")
        for rev, cnt in bad.items():
            rev_pairs[(d_rev, rev or "(blank)")] += 1
            rev_pair_joints[(d_rev, rev or "(blank)")] += cnt
        result.append(("Revision 불일치", no, d, d_rev, rev_text(revs), sum(revs.values()), sum(bad.values()), "; ".join(notes)))

    for no in sorted(set(jm_revs) - set(dwg)):  # Drawing DB에 없는 ISO (기존 비교 항목 유지)
        revs = jm_revs[no]
        result.append(("JM에만 존재", no, {}, "", rev_text(revs), sum(revs.values()), sum(revs.values()), "Drawing DB에 없는 ISO"))

    kinds = Counter(r[0] for r in result)
    missing_void = sum(1 for r in result if r[0] == "JM 누락" and r[3].upper() == VOID_REV)
    mismatch_void = sum(1 for r in result if r[0] == "Revision 불일치" and r[3].upper() == VOID_REV)
    mismatch_mixed = sum(1 for r in result if r[0] == "Revision 불일치" and "혼재" in r[7])
    mismatch_joints = sum(r[6] for r in result if r[0] == "Revision 불일치")
    print(f"JM 누락: {kinds['JM 누락']} (VOID {missing_void})")
    print(f"Revision 불일치: {kinds['Revision 불일치']} ISO / 조인트 {mismatch_joints} (VOID 도면 {mismatch_void}, JM 내 혼재 {mismatch_mixed})")
    print(f"JM에만 존재: {kinds['JM에만 존재']}")

    header_fill = PatternFill("solid", fgColor="305496")
    kind_fill = {"JM 누락": "F8CBAD", "Revision 불일치": "FFE699", "JM에만 존재": "D9D9D9"}

    def style_header(ws):
        for cell in ws[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = header_fill

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "요약"
    ws.append(["항목", "값"])
    style_header(ws)
    for label, value in [
        ("비교 기준", "Drawing DB (drawing.dwg_latest)"),
        ("실행 시각", datetime.now().strftime("%Y-%m-%d %H:%M")),
        ("Drawing DB 도면 수", len(dwg)),
        ("JM ISO 수 / 조인트 수", f"{len(jm_revs)} / {len(jm_rows)}"),
        ("JM 누락 (Drawing DB에 있고 JM에 없음)", f"{kinds['JM 누락']} (그 중 VOID 도면 {missing_void})"),
        ("Revision 불일치 (ISO 수)", f"{kinds['Revision 불일치']} (그 중 VOID 도면 {mismatch_void}, JM 내 Revision 혼재 {mismatch_mixed})"),
        ("Revision 불일치 (조인트 수)", mismatch_joints),
        ("JM에만 존재 (Drawing DB에 없음)", kinds["JM에만 존재"]),
    ]:
        ws.append([label, value])
    ws.append([])
    ws.append(["Drawing Rev (기준)", "JM Rev", "ISO 수", "조인트 수"])
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
    for (d_rev, j_rev), n in sorted(rev_pairs.items(), key=lambda x: -rev_pair_joints[x[0]]):
        ws.append([d_rev, j_rev, n, rev_pair_joints[(d_rev, j_rev)]])
    for i, w in enumerate([46, 60, 10, 12], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws2 = wb.create_sheet("비교 결과")
    ws2.append(["구분", "Drawing No", "Line No", "System", "Title", "Drawing Rev (기준)",
                "JM Rev (조인트 수)", "JM 조인트 수", "불일치 조인트 수", "Drawing Remark", "비고"])
    style_header(ws2)
    for kind, no, d, d_rev, jm_text, jm_cnt, bad_cnt, note in result:
        ws2.append([kind, no, d.get("line_no") or "", d.get("system") or "", d.get("title") or "", d_rev,
                    jm_text, jm_cnt, bad_cnt, d.get("remark") or "", note])
        ws2.cell(row=ws2.max_row, column=1).fill = PatternFill("solid", fgColor=kind_fill[kind])
    for i, w in enumerate([16, 32, 30, 8, 46, 16, 26, 12, 14, 30, 50], start=1):
        ws2.column_dimensions[get_column_letter(i)].width = w
    ws2.freeze_panes = "C2"
    ws2.auto_filter.ref = ws2.dimensions

    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Reports")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"ISO_Drawing_vs_JM_{datetime.now().strftime('%Y%m%d')}.xlsx")
    wb.save(out_path)
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
