# Context Notes — Export/Print 전 탭 적용 + Import 제거 (2026-06-10)

## 결정 사항

### Export 방식
- 차트/테이블 혼합 탭(Early Power, Weekly, RT Quality)은 렌더된 DOM 테이블을
  `XLSX.utils.table_to_sheet`로 변환하는 공용 헬퍼 `exportTablesExcel(specs, fileName)` 사용.
  이유: 데이터 소스 구조와 무관하게 화면에 보이는 그대로 내보내므로 유지보수 부담 최소.
- Unit/Area 탭은 테이블이 없어 `_dashData.units / .areas`에서 JSON 시트 생성.
- Welder 탭은 기존 `exportWelderExcel()` 함수가 이미 있었으나 버튼이 없었음 → 버튼만 연결.

### Print 방식
- 기존 `printPage(pageId)` 재사용 (page-print-active 클래스 토글).
- @media print에 패널 흰 배경/검정 텍스트 보강 — 차트 탭 인쇄 시 다크 테마 그대로 나오던 문제 대응.

### Import 제거 범위
- 사용자 지시: "모든 탭의 Import 버튼 삭제".
- 프런트 버튼 + onchange 핸들러(importJMExcel/importSMExcel) 삭제.
- 백엔드 `/api/joints/import`, `/api/support-master/import`, `/api/testpkg-master/import`는
  프런트 참조가 없어져 dead code → 함께 삭제 (필요 시 git history에서 복원 가능).
- `/api/joints/import-welder`는 메모리에 기록돼 있었으나 현재 app.py에 존재하지 않음 (이미 제거된 상태).
- `downloadJMTemplate()`도 참조 없는 dead code → 삭제.
- import 엔드포인트 제거로 pandas가 완전 미사용 → `import io` 제거 + requirements.txt에서 pandas 제거
  (Render 빌드 시간/메모리 절감). openpyxl은 sync-phase-package에서 사용 중이라 유지.

## 테스트 결과 (2026-06-10, 로컬 5005)
- 12개 탭 Export 전부 시트 생성 확인 (EP 6시트, Weekly 5시트, Welder 3시트, RT 3시트, Unit/Area 2시트).
- 12개 탭 Print 전부 대상 페이지 page-print-active 일치 확인. 콘솔 에러 0건.
- Test Master는 DB 0건 상태라 Export가 "No data" 토스트 — 정상 동작 (Sync from Pkg 실행 후 데이터 생김).
- 서버 기동 직후 /api/ep-support-summary가 일시적 500 → 캐시 빌드와 겹친 콜드스타트 현상, 이후 정상.

### 버튼 배치
- 차트 탭(Overview/EP/Weekly/UnitArea/Welder/RT)은 `.page-header` 우측에 Export/Print 배치.
- 데이터 탭은 기존 jm-top-row 우측 배치 유지, 빠진 Print만 추가 (Pkg Master, Test Master).

---

# Context Notes — Render OOM 예방 1~4번 (2026-09-19)

## 근거 (09-16~19 로그 19k줄 + Render 이벤트 API)
- 수정(20초 디바운스) 배포 후 OOM 이벤트 0건이지만 RSS 피크가 352~376MB로 사고 당시와 비슷.
- 지금 지표 `ru_maxrss`는 최고치라 누수/일시 피크 구분 불가 → 현재값과 cgroup 사용량이 필요.
- `/api/cache/clear` 431건 중 392건(91%)이 Joint 저장(PATCH /api/joints) 직후, 39건(9%)이 Support 저장. 5분 자동 갱신은 `getDashData(true)`만 쓰고 cache/clear를 부르지 않음(확인 완료).

## 결정 사항
- 자가재시작(`_maybe_self_recycle`)은 이번 범위 밖(5번)이라 기존 `ru_maxrss` 기준 그대로 둔다. 새 로그 포맷은 `mem cur=..MB peak=..MB cgroup=..MB/..MB`로 바꾸고, 예전 `RSS=` 정규식이 조용히 의미가 바뀌지 않게 이름을 다르게 한다.
- 연결 끊김 재시도는 supabase-py가 지원하는 `ClientOptions(httpx_client=...)`로 트랜스포트만 감싼다(콜사이트 수정 없음, 라이브러리 내부 패치 없음). HTTP/2 설정은 기존과 동일하게 유지해 프로토콜 변화 위험을 피한다.
- 재시도 대상은 멱등 요청만: GET/HEAD/OPTIONS/PUT/PATCH/DELETE와 `rpc/get_*`, `rpc/refresh_dashboard_cache`. INSERT/UPSERT(POST)와 `bulk_update_phase_package`는 재시도하지 않는다(중복 쓰기 방지).
- 디바운스는 leading+trailing. 기존 leading-only는 연속 저장의 마지막 건이 서버 캐시에 반영되지 않은 채 TTL(20분)까지 남을 수 있었다. 진행 중인 빌드는 clear 이전 데이터로 결과를 쓸 수 있어 `_rebuild_pending`으로 끝난 뒤 1회 더 돌린다.
- 디바운스로 응답이 deferred일 때 프런트 `_refreshAfterSave`가 바로 `getDashData(true)`를 하면 옛 캐시로 낙관적 KPI 갱신을 덮어쓰므로, `retry_after`만큼 기다린 뒤 조회한다.
- 4번은 Joint 저장 비중이 91%라 Support 전용이 아니라 `scope=joint`도 함께 만든다. scope=joint는 `_sup_test_cache`, `_sub_area_cache`를 보존(joint 저장은 support 집계·sub_area 목록을 바꾸지 않음), scope=support는 joint 유래 캐시를 모두 보존. 지정 없으면 기존처럼 전체 삭제.
- `_get_jm_iso_stats(force=True)`는 캐시가 5분 이내면 그대로 반환하므로(force는 동기/비동기 여부만 결정) 수정 불필요.

## 구현 중 추가로 확인한 것 (4번)
- 자동 갱신(5분)은 `getDashData(true)`만 쓰고 cache/clear를 부르지 않는다. cache/clear는 저장 후에만 호출된다.
- `PATCH /api/joints/<id>` 핸들러가 저장마다 `_cache.clear()`를 직접 실행하고 있었다. 캐시가 비면 다음 `/api/dashboard` 요청이 디바운스와 무관하게 즉시 재빌드를 시작하므로, 로그의 "빌드 횟수 ≈ cache/clear 횟수의 1.8배"를 설명한다. 프런트의 Joint 저장 4곳은 모두 `_refreshAfterSave`(→ cache/clear)를 부르므로 핸들러의 clear를 제거했다.
- 핸들러 clear를 없애면 `_refreshPending` 가드가 갱신 중 저장의 clear 호출을 버려 그 저장이 서버 캐시에 반영되지 않는다. 그래서 `_refreshDirty`를 두어 갱신 중 들어온 저장은 끝난 뒤 한 번 더 갱신한다(Node 테스트로 5회 연속 저장이 2회 갱신으로 합쳐짐 확인).
- scope 삭제 대상: 공통(대시보드, ep_sup, area_field, pkg_stats, testpkg_all) / joint=+meta,pkg_list,daily,wkbd,jm_fv,welder,rt,daily_report,kpi_override,welder_daily,iso_stats / support=+sup_test / all=+sub_area.
- 실측(로컬, 실 Supabase 읽기 전용) 재빌드 1회 비용: all 30.1초·joint_master 조회 16회·HTTP 30회 / joint 19.0초·10회·20회 / support 10.0초·0회·12회. 세 경우 모두 재빌드 후 KPI가 전체 재빌드와 동일.
- 남은 과제(범위 밖): joint 범위에도 iso_stats(약 6페이지)와 kpi_override 스캔이 남는다. iso_stats는 원래 5분 TTL이라 joint 저장마다 비우지 않는 것도 가능하나 UI 영향 확인이 필요해 보류.
- 로그 형식이 바뀌었다: `clear executed scope=..`(실제 실행), `clear scope=.. deferred Ns`(묶임), `mem cur=..MB peak=..MB cgroup=..MB`. 예전 `All caches cleared`/`RSS=` 패턴으로는 더 이상 집계되지 않는다.

---

# Context Notes — JM vs Drawing DB 비교 리포트 (2026-09-19)

- 기준은 Drawing DB(drawing.dwg_latest). "누락" = Drawing DB에 있는데 JM(joint_master)에 없는 도면, "Revision 불일치" = JM 조인트 중 하나라도 rev가 도면 revision과 다른 ISO. 비교는 앞뒤 공백 제거 + 대소문자 무시.
- JM은 조인트마다 rev를 가지므로 ISO 하나에 여러 rev가 섞일 수 있다(18개 ISO). 기존 스크립트는 최빈값 하나로 대표했지만, 불일치를 놓치지 않도록 "JM Rev (조인트 수)"로 전부 표시하고 "불일치 조인트 수"를 따로 센다.
- dwg_latest의 Revision `VOID`(53건)는 발행 후 무효 처리된 도면(remark "Void (Voided after issuance)", file_link 없음). 누락 38건은 전부 VOID라 JM에 없는 게 정상일 수 있고, VOID 15건은 JM에 조인트가 남아 있어 별도 비고로 표시한다.
- 기존 `fetch_all`은 정렬 없이 range로 페이지를 나눠 페이지 경계에서 행이 중복/누락될 수 있었다. `order("id")`를 추가하고 끝에서 전체 건수(count=exact)와 대조해 어긋나면 중단하게 했다.
- 기존 "JM에만 존재" 비교는 유지(현재 0건이라 엑셀에는 행이 나오지 않음). 출력은 Reports/ISO_Drawing_vs_JM_YYYYMMDD.xlsx (Reports/는 gitignore, 로컬 전용).

---

# Context Notes — Joint Master 목록 정렬(ISO Drawing → Joint No 숫자순) (2026-09-21)

- 원인: `/api/joints`가 `order("id")`라 나중에 추가된 조인트(id가 큼)는 항상 맨 뒤에 나와 확인이 어려웠다. `joint_no`는 문자열이라 DB에서 그냥 정렬하면 1,10,11,…,2 순이 된다.
- JM 화면은 30건씩 서버 페이징이라 정렬은 DB 조회 단계에서 해야 한다. 앱 키로는 DDL(숫자 정렬용 generated column)을 못 하고 배포 순서 의존이 생겨 채택하지 않았다.
- 채택: DB는 `iso_drawing, joint_no, id`로 정렬해 페이지를 자른 뒤, 같은 ISO 안에서만 숫자순으로 재정렬한다. ISO 묶음의 순서·크기는 두 정렬이 같으므로, 페이지 양 끝의 ISO만 전체 행(최대 45건)을 다시 조회해 자리를 맞춘다(`_sort_joints_numeric`). 응답은 페이지당 약 1.4초(경계 ISO 조회 2회 포함).
- `1A`, `6A` 같은 문자 붙은 번호(5건)는 숫자 부분 기준으로 `1` 바로 뒤에 온다. NDE 탭과 엑셀 export도 같은 엔드포인트라 같은 순서가 된다.
- 검증: 전체 51,114건의 기대 순서와 API 결과를 표본 44페이지(첫/끝 페이지 포함), limit=1000, status=completed 필터로 대조해 모두 일치.

---

# Context Notes — KPI Remaining DI Piping 기준 + Fab/Erect % (2026-09-22)

- 원인: `renderKPI`가 Remaining 서브텍스트를 `100 - weightedPct`(Piping 70/Support 20/Test 10 가중 진척)로 계산해 61.4%로 나왔다. Total DI 카드는 Piping 진척(52.5%)을 쓰므로 Remaining도 `100 - pipingPct`(47.5%)로 맞췄다. Remaining DI 숫자(remaining_di)는 원래 Piping DI 기준이라 그대로다.
- Fab/Erect % 기준: kpi에 이미 있는 `fab_total_di`/`erect_total_di` 대비 비율로 계산했다(공정별 진행률, 서버의 fab_pct/erect_pct와 같은 정의). Completed는 완료/전체, Remaining은 (전체-완료)/전체이며 Fab+Erect 잔여 합이 remaining_di와 일치한다. "완료 DI 중 Fab 비중"으로 해석할 수도 있으나 서버 fab_pct와의 일관성 때문에 채택하지 않았다.
- 조인트 저장 시 낙관적 갱신(saveJointDate/clear)은 fab_di/erect_di를 건드리지 않아 Fab/Erect %는 서버 재빌드(_refreshAfterSave) 후에 맞춰진다. 기존 Fab/Erect 숫자도 동일했다.

---

# Context Notes — 신규 Revision Drawing JM 정합성 (2026-09-24)

- dwg_latest에는 업로드 시각 컬럼이 없어 file_link의 Cloudinary 버전(`/v1790175409/` = Unix 초)을 KST로 변환해 업로드일을 판별했다. 09-23 23시 109건 + 09-24 00시 41건은 하나의 연속 업로드 배치라 "어제 업로드"로 본다. 전부 revision C03.
- JM rev 갱신에서 기존 예외 4 ISO(SA-049-1, WD-541-1, CH-506-1, LN-052-1: JM이 Drawing DB보다 최신)는 사용자 결정(2026-09-19)에 따라 제외한다. 이번 업로드 대상이 아니라 그대로 남아 있다.
- PDF는 벡터 PDF(텍스트 레이어 있음)이고 Joint No는 원형 안 숫자, Part No는 사각 안 숫자다. PyMuPDF로 작은 원(폭≈5pt, 곡선 4개)을 찾아 그 안의 텍스트를 Joint No로 읽는다. 샘플(WD-452-1) 검증: 원 12개 = JM joint_no 1~12. PyMuPDF는 프로젝트 .venv에만 설치(requirements.txt에는 넣지 않음).
- JM rev 갱신 결과: 139 ISO / 1,653 조인트를 전부 C03으로 변경(C01A 934, C01B 712, C01C 7). 롤백 데이터는 `Reports/JM_Rev_Update_Backup_20260924_1934.xlsx`(id, 기존 rev, 새 rev; 1933 파일은 미리보기 때 만든 동일 내용). 적용 후 재비교: 예외 4 ISO(59조인트)와 VOID 누락 38건만 남음.
- PDF는 세 종류였다. (1) 텍스트 레이어 도면: 원(폭≈5.4pt, 곡선) 안 텍스트를 그대로 읽는다. (2) 글자가 선분으로 그려진 도면(텍스트 레이어 없음): 원은 36선분 폴리라인(폭≈10pt)이고 숫자는 원 안의 별도 경로다. 글리프 선분만 tight crop해 높이 64px로 다시 그려 RapidOCR로 읽고 선 굵기 3종으로 투표한다. 처음에 원 크기 기준 큰 캔버스에 그리니 글자가 작아 6/8/9를 자주 틀렸고(저신뢰 다수), tight crop으로 바꾸자 샘플이 JM과 정확히 일치했다. (3) Joint No 원이 아예 없는 도면(14건): 대조 불가로 분류.
- 같은 번호가 여러 번 나와도 오류가 아니다. 상세도(View B-B, Detail A)에 같은 조인트가 다시 표기된다(CWR-033-1의 18/19/22). 비교는 번호 집합 기준이다. `0` 원은 도면에 실제로 "0"이 적힌 것(DW-001-1은 10이어야 할 자리, WD-518-1)이라 PDF에만 있는 번호로 그대로 보고한다.
- 검증 결과: 152건 중 일치 103, 불일치 35(PDF에만 13 / JM에만 18 / 양쪽 4), 표기 없음 14. 불일치 조인트는 JM에만 46개(완료된 것 21개), PDF에만 46개.
- PyMuPDF와 rapidocr/onnxruntime은 프로젝트 .venv에만 설치(requirements.txt 미반영, 앱 런타임과 무관). scratch/ 는 gitignore라 스크립트는 로컬에만 있다.

---

# Context Notes — 전체 JM DB vs ISO Drawing PDF Joint No 대조 (2026-09-24)

- 기존 JM 엑셀 export 형식(exportJMExcel): ID, UNIT, SYSTEM, AREA, SUB AREA, LINE NO, ISO DRAWING, REV, SPOOL NO, MAT, SIZE, S/F, JOINT NO, DI, WELDER, PHASE, COMPLETED DATE, REMARK. 이미 REMARK(joint_master.remark) 열이 있으므로, 원본 REMARK는 그대로 두고 비교 결과는 새 열 "비교 REMARK"로 추가한다(원본 내용 덮어쓰기 방지).
- DB는 변경하지 않는다(엑셀 산출만). 4,000건가량 PDF는 디스크에 저장하지 않고 메모리에서 파싱하고 결과만 캐시한다.
- PDF 판독기(scratch/pdf_joint_reader.py) 개선 이력과 이유. 처음엔 152건 표본에서만 검증됐고, 전체 3,973건으로 넓히자 도면 유형이 더 있었다.
  1) 회전된 페이지: 일부 PDF는 page.rotation=270이고 get_drawings 좌표가 회전 전 기준이라 원 안 글자가 옆으로 누워 읽히고 가시성 판정도 어긋났다. `page.rotation_matrix`로 화면 좌표로 변환(`_to_display`)한 뒤 읽는다. 이전에 넣었던 "0/90/270/180도 시험" 로직은 이 문제의 우회책이었고, 변환 후에는 대부분 0도에서 읽힌다(9를 6으로 읽는 오독도 해소).
  2) 원 표현이 3~4가지: 경로 하나에 선분 36개인 다각형, 곡선 4개(12pt), 선분 하나당 경로 하나로 쪼갠 원(끝점 연결로 복원, `_ring_circles`). 원 폭은 4.5~18pt.
  3) 흰 마스크(wipeout)로 가려진 옛 도형: 렌더링해 잉크가 있는 원만 인정(`_visibility`).
  4) 선분 수로 덩어리를 걸러내려던 시도는 소구경 도면 정상 번호까지 지워 되돌렸다(선분 수 기준 금지). `0` 원은 도면에 실제로 그려진 표기(다른 도면과의 연결 지점으로 보임)라 제외하지 않고 비교 REMARK에 명시한다.
  5) 병렬 추출: ONNX 스레드 1개로 제한, 글리프 판독 결과를 프로세스별 파일(Reports/glyph_cache_<pid>.tsv)로 공유(한 파일에 동시 append하면 줄이 섞임). 기존 캐시는 로직 변경 때마다 삭제하고 --all로 재추출.
- 최종 결과(2026-09-24): 비교 3,960 도면 중 일치 2,961, 차이 999(JM에만 있는 조인트 1,035개[그중 완료 183개], ISO Drawing에만 있는 번호 2,748개), 대조 불가 13(원형 Joint No 표기가 없는 도면). 산출물 `Reports/Large_Bore_Master_20260924.xlsx`(JM에만 175 / ISO Drawing에만 1,455), `Reports/Small_Bore_Master_20260924.xlsx`(JM에만 860 / ISO Drawing에만 1,293). 시트: JointMaster(기존 JM 열 + "비교 REMARK"), 요약, Revision 불일치·VOID, 대조 불가 도면.
- Bore 규칙: JM 행은 SIZE>2 Large, ≤2 Small. ISO Drawing에만 있는 번호는 SIZE가 없어 (1) 같은 ISO의 JM 조인트가 한 Bore뿐이면 그 Bore (2) 혼합이면 도면 Line No의 앞 크기(≤2" Small) 순으로 배정하고 근거를 REMARK에 적었다. 한 ISO가 Large+Small이 섞여 있을 때는 추정임을 감안해야 한다.
- 해석 주의: "ISO Drawing에만 있음"은 HS/ST/LS 계통에 집중돼 있다(상세도/단면도에 같은 번호가 다시 표기되거나 지지대 용접 상세 번호가 섞인 것으로 추정). 상세도 영역은 도면마다 그려진 방식이 달라 자동 구분하지 못했다. `0` 원은 다른 도면과의 연결 지점 표기로 보이나 확정은 아니다. 조인트 번호 앞자리 0은 비교 시 제거('09'→'9').
