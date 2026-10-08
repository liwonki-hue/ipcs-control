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

---

# Context Notes — Joint Master 검색 반복 시 급격한 지연 진단 (2026-09-26)

- 증상: Joint Master에서 ISO Drawing No를 바꿔 가며 검색할수록 Data Loading이 급격히 길어진다.
- 원인(재현 확인): `templates/index.html`의 `#jm-iso`가 `oninput="loadJointMaster()"`라 글자마다 `/api/joints`를 호출한다(디바운스 없음). `apiFetch`는 요청 취소(AbortController)나 응답 순서 확인이 없고 `/api/joints`는 캐시도 안 한다. 27자 ISO를 치면 요청 25개가 4초 안에 나가고, 각 요청은 서버에서 약 1.3초(DB 왕복 2회: 메인 쿼리+경계 ISO 재조회 `_sort_joints_numeric`)라 Render처럼 요청을 하나씩 처리하는 sync 워커(`gunicorn app:app`)에서는 줄을 선다. 단일 스레드 서버로 재현: 1번째 검색 마지막 글자 응답까지 35s, 2번째 64s, 3번째 92s(앞 검색의 대기 요청 때문에 누적). 순차 요청은 누적 악화가 없었다(12개 ISO 검색이 각 약 3s→3s).
- DB 쪽은 원인이 아니다: 쿼리 단독 0.5s 내외(가장 가벼운 조회도 0.47s = 네트워크 왕복), 결과 행 수와 무관.
- 아직 수정하지 않았다(사용자가 확인만 요청). 후보: (1) 프런트 디바운스 300~400ms + 이전 요청 취소 + 응답 순서 확인, (2) `/api/joints` 쿼리를 1회로 줄이기(경계 재조회 제거 또는 조건부), (3) Render Start Command에 `--threads`(대시보드 변경, 메모리 영향 확인 필요).

---

# Context Notes — Render 로그 재검증(OOM) + JM 검색 지연 진단 정정 (2026-09-26)

- OOM 재검증(사용자 제공 Render API 키로 읽기 전용 조회, 키는 저장하지 않음): Events API 기준 마지막 oomKilled는 2026-09-14 05:59Z(수정 배포 전). 이후 12일간 server_failed 0건, 배포는 09-19(4b815b3), 09-21(8e99b1c, c148966)에 있었다. 09-19 16:27Z~09-26 07:08Z 로그(17.7k줄, 컨테이너 78개)에서 RSS 최대 339MB(09-23 09:16Z 컨테이너, build 61회), cgroup 사용 최대 401MB/512MB(09-24 02:56Z, build 52회). 기준선(09-16~19)의 RSS 피크 352~376MB보다 낮고 420MB 자가 재시작은 0회. `mem cgroup=`은 Render에서 정상 출력된다(cgroup이 RSS보다 60~130MB 크다).
- Supabase 끊김: 재시도(`connection dropped ... retrying once`) 290회, `CRITICAL BUILD ERROR` 0, `/api/dashboard` 503 0, `PATCH /api/joints` 500 0(기준선 3.6일: 24 / 106 / 9). 5xx는 7일간 18건: 09-21 02:36~03:42Z에 gunicorn WORKER TIMEOUT(기본 30s)으로 워커 13회 kill(support-master·welder-summary 500 13건), 09-24 03:46·03:50Z와 09-26 06:00·06:53Z의 `/api/joints` 500 5건(같은 시각 `ConnectionTerminated` 재시도 실패, 백그라운드 재빌드의 joint_master 스캔과 겹침). 로그의 "SIGKILL! Perhaps out of memory?"는 타임아웃 kill의 일반 문구였고 OOM이 아니다.
- 종료 신호 없는 컨테이너 20개: 마지막 줄이 정상 200 응답이고 메모리 이상이 없으며 server_failed도 없다(유휴 종료 때 로그가 안 남는 것으로 보임). 재빌드: clear 실행 154/58/54/99/44회(09-21~25)로 30초 병합이 작동.
- JM 검색 지연 정정: 이전 진단(글자마다 요청 → 워커 대기열)은 손으로 타이핑할 때만 해당한다. 운영 로그의 ISO 검색 892건 중 807건이 완성형(25자 이상)이라 실제 작업은 "ISO 붙여넣기 → 조인트별 PATCH → 다음 ISO"다. 연속 저장 구간 336개에서 PATCH 완료 간격 중앙값 2.7초(90%가 11.4초), "Apply to All" 22건이 77~102초 걸렸다(건당 3.5~4.6초). sync 워커 1개라 저장이 줄줄이 처리되는 동안 검색이 대기하고, 저장 뒤 cache/clear(scope=joint) 재빌드도 같은 프로세스에서 돈다(재빌드 중 검색 1.0s→1.1~2.1s, 재빌드 19s). 로컬 urllib 측정 3.1s는 `localhost`의 IPv6 우선 지연 때문이었고 실제 요청은 1.0~1.3s다.

---

# Context Notes — Joint Master 검색/저장 지연 개선 (2026-09-26)

- 범위 가정: 사용자의 "진행"을 제안 4개 중 코드로 가능한 1·3·4번으로 해석. 2번(Render Start Command)은 대시보드 설정이라 안내만 한다.
- 1) 일괄 저장: `POST /api/joints/bulk-date`(`@login_required`, 기존 PATCH와 동일 권한). ids는 정수 목록 1~1000개, date_completed는 YYYY-MM-DD 또는 null. PostgREST URL 길이 때문에 200개씩 나눠 `.in_("id", chunk)`로 UPDATE(보통 ISO 하나가 수십 건이라 1회). PATCH처럼 서버에서 `_cache`를 비우지 않는다(프런트가 저장 뒤 cache/clear scope=joint 호출). 응답 `updated`가 요청 수와 다르면 프런트가 오류로 처리한다. 기존 코드는 PATCH 응답을 확인하지 않아 실패해도 "saved"로 표시했는데, 요청 1회로 바꾸면 그 실패가 전체 실패가 되므로 `res.ok`/`updated`를 확인하도록 했다. `_runConcurrent`는 이 두 곳에서만 쓰여 함께 제거.
- 시험은 운영 DB에 연결된 환경이라 값이 바뀌지 않는 갱신만 사용(이미 null인 250건 null 저장, 같은 날짜 3건 재저장) — `scratch/test_bulk_date.py`(gitignore).
- 4) `/api/joints` 경계 ISO 재조회 축소: `_sort_joints_numeric`에 has_before/has_after 인자 추가. 페이지가 결과의 처음(offset=0)이면 첫 ISO 앞에, 결과의 끝(offset+len>=count)이면 끝 ISO 뒤에 같은 ISO 행이 있을 수 없어 재조회를 생략한다(기본값 True/True라 이전 동작과 호환). 검증: 모의 DB 페이지 48,004개에서 이전 동작·기대 순서와 불일치 0건, 실제 DB 40개 요청 응답 불일치 0건, 재조회 50→19회, 평균 응답 1.11→0.77s. 범위를 벗어난 offset은 PostgREST PGRST103으로 500이 되는데 이전부터 있던 동작이라 건드리지 않았다.
- 3) 검색 디바운스: `#jm-iso`는 `loadJointMasterDebounced()`(350ms), 그 외(필터·페이지·Search 버튼)는 즉시 `loadJointMaster()`이며 즉시 조회는 대기 중인 디바운스를 취소한다. `loadJointMaster`는 시작할 때 이전 요청을 AbortController로 취소하고 응답 순서 번호(`_jmSeq`)로 오래된 응답을 버린다(AbortError는 조용히 무시). `apiFetch`에 `signal` 옵션 추가. 브라우저 캐시 때문에 새 JS가 안 받아지지 않도록 `dashboard.js?v=7.40 -> 7.41`(bulk 변경 커밋에서 올리지 못한 것을 함께 반영). 서버가 이미 받은 요청은 클라이언트가 취소해도 처리되므로 효과의 핵심은 디바운스다.
- 브라우저 검증(로컬 서버 재시작 후): 27자를 글자당 120ms로 입력 -> `/api/joints` 요청 1회(이전 25~27회), 18행. 즉시 조회 2회 연달아 -> 마지막 결과(19행)만 표시. Apply to All/Clear는 bulk-date 요청 1회이고 조인트별 PATCH 0회, 저장 요청이 실패(401)하면 "Bulk save failed"로 표시하고 성공 토스트를 내지 않는다. 저장 요청은 fetch를 가로채 실제 운영 데이터는 바꾸지 않았다. 콘솔 오류는 로그인하지 않은 상태의 `cache/clear` 401과 기존 favicon 404뿐.
- finish(2026-09-26): 임시 코드 스캔(추적 파일 7개) 0건, pyflakes에서 미사용 import/변수/미정의 이름 0건(기존의 불필요한 `global` 선언 18줄만 남음, 동작에 영향 없어 건드리지 않음). 검토 중 보강: bulk-date가 뒤쪽 200건 묶음에서 실패하면 앞 묶음 반영 건수를 오류 응답에 포함. 시험: bulk-date/정렬/엔드포인트 동등성 3종 + 기존 회귀 시험 4종 통과. `test_supabase_retry`는 로컬 venv의 supabase가 2.4.5라 `httpx_client` 옵션이 없어 실패하는 기존 환경 차이(Render는 더 새 버전, 앱은 폴백으로 동작)이며 이번 변경과 무관.
- 사용자가 Render Start Command 변경을 완료했다고 알림(적용 값은 제안한 `--workers 1 --threads 4 --timeout 90`으로 가정).

---

# Context Notes — 최적화 6단계 (2026-09-27)

배경: 09-26에 Render Start Command가 `--workers 1 --threads 4 --timeout 90`으로 바뀌어 요청이 동시에 처리된다. 단일 스레드 전제의 코드가 점검 핵심이었다.

- 동시 요청 + HTTP/2: Render와 같은 supabase 2.31.0 venv에서 재빌드 중 동시 요청 240건 → 16건 실패(ReadError, 재시도 62회). HTTP/1.1로 바꾸자 0건·재시도 0회·더 빠름. `_supabase_options`에서 `http2=False`. 로컬 기본 venv의 supabase 2.4.5는 `httpx_client` 옵션을 몰라 재시도 전송 없이 기본 클라이언트(HTTP/2)로 폴백하므로, 운영과 같은 조건은 scratchpad의 venv_render(`pip install -r requirements.txt`)로 시험해야 한다.
- 공유 캐시: 보조 캐시 스레드가 `_cache["data"]`를 제자리 수정하던 `_apply_kpi_override(target=None)`를 복사 후 교체로 변경. 락 밖 전역 수정 전수 검사(ast)에서 다른 곳은 없음(`_mem_last_logged` 로그용 1건은 무해).
- PostgREST 1회 최대 10,000행: `/api/welder-daily`가 120일치 14,402건 중 1만 건만 읽어 119일 전부 과소 집계(합계 45,856→68,350). 페이지 분할로 수정. `/api/weekly-actuals`도 같은 문제였으나 호출처가 없어 제거.
- 정렬 없는 페이지 분할 18곳에 `order("id")`, testpkg-joints/RT에 id 동점 정렬 추가. 수정 전후 응답 비교로 값 동일 확인.
- 범위 밖 offset(PGRST103) 500 → 빈 페이지+건수(`_exec_page`), 새 검색 시 1페이지 초기화, 탭별 검색창 350ms 디바운스.
- Support sync 부분 upsert: postgrest가 열 목록을 키 합집합으로 보내 빠진 칸을 NULL로 덮어씀 → `_upsert_partial`(키 구성별 묶음). 현재 JM에서 채울 수 있는데 빈 support phase 170/package 1,140건(원인 구분 불가, Sync 버튼으로 채울 수 있음, 실행은 사용자 판단).
- Support PATCH의 직접 캐시 삭제 제거(프런트 scope=support clear가 대신함). Delete·Test Package 저장은 후속 clear가 없어 유지.
- 누락 기능: Welder 개별 분석 차트 2개가 늘 비어 있었음 → `/api/welder-detail` 추가(상위 12명 합계·작업일 수 RPC와 일치).
- 성능: area-field-quantities 1천→1만 건 단위(13.4s→3.2s). 일일 보고서 날짜 조회 500→2000(5일 누락 방지).
- 제거: `/api/test`, `/api/weekly-actuals`, `/api/joints/sync-phase-package`(gitignore된 Raw File 엑셀 의존, 어디서도 동작 불가). Procfile을 실제 Start Command와 일치.
- 보류(사용자 확인 필요): `dashboard_cache` 테이블이 앱 키로 조회 시 비어 있어 `_build`의 빠른 경로가 한 번도 쓰이지 않음(빌드 513회 중 512회 MISS). `refresh_dashboard_cache()`가 이 테이블에 쓰는 함수라 RLS로 읽기가 막힌 것으로 추정. 읽기 정책 추가는 권한 변경이라 하지 않음.
- 후속(2026-09-27): (1) Support Sync Phase/Package를 수정된 코드로 실행 — phase 170·package 1,140건 채움, 기존 값 변경 0칸(백업 `Reports/SM_PhasePkg_Backup_20260927_0129.json`, id·phase·package 전체). (2) `dashboard_cache`: 앱 키가 anon이고 anon에게 행이 안 보임(RLS). anon 키로는 정책을 못 바꿔 SQL Editor 실행용 SQL을 사용자에게 전달. (3) `--threads 4` 적용 후(09-26 08:53Z~20:24Z) Render 로그: OOM 이벤트 0, RSS 최대 321MB·cgroup 366/512MB, WORKER TIMEOUT 0, 5xx 1건(배포 직후 콜드 스타트에 보낸 시험 요청, 같은 순간 v2 RPC statement timeout), HTTP/2 끊김 재시도 36회 전부 복구. HTTP/1.1 전환(f07b2f6)은 20:23Z 배포라 이 로그엔 거의 반영 안 됨.
- dashboard_cache 정책 적용 확인(2026-09-27, 사용자가 SQL Editor에서 `anon read dashboard_cache` SELECT 정책 실행): 앱 키로 행 1개(`main`, v17/v2/ep/wa) 조회 가능. `refresh_dashboard_cache` 직후 빌드 비교 — 빠른 경로 3.7s vs RPC 경로 11.2s, 결과는 EP(ep_kpi/ep_sys/ep_area/ep_weekly)를 포함해 모든 키 동일(같은 sub_area 캐시 상태에서 시작 시). 빠른 경로는 캐시가 2시간 이내일 때만 쓰이는데 keep-alive가 하루 4~6번만 돌아 적중률은 제한적.

---

# Context Notes — 공정 관리 관점 개선 적용 (2026-09-27)

- 해석: "1번부터 3번까지" = 추천 답변 1~3절. DDL이 필요한 수정 이력·Test Package 단계 칸은 SQL 전달 후 연결, Support 가중치는 값 확인 필요.
- 검사 합격 판정 `_joint_accepted`(용접+VT PASS+지정 NDE PASS+PWHT 대상이면 PASS)를 Test Pkg Joint Check·준비도·Backlog가 공유. RT는 재촬영(rt_2) PASS도 합격(8건이 PENDING이던 버그).
- P91 PWHT 빈 값 3,095건을 Y로(백업 `Reports/P91_PWHT_Backup_20260927_0144.json`). P91은 면제가 없어서 적용했고, P22는 두께·구경 면제 규정이 있어 손대지 않음. P91인데 N으로 명시된 2건(HS-021-1 #4, ST-461-1 #1)은 확인 필요.
- 품질 스캔 `_scan_qa`(조인트 전체 1회, ~14초, 5분 캐시, 만료 시 이전 결과 즉시 + 백그라운드 갱신, 보조 캐시에서 순차 선계산, joint scope clear 시 삭제). `QA_CHECKS`와 `_apply_quick_filter`는 반드시 같은 조건이어야 카드 숫자와 목록 건수가 맞는다. postgrest 빌더는 자기 자신을 수정하므로 공통 조건을 함수 앞에서 만들면 안 된다(Rev 필터가 0건이 됐던 원인).
- Drawing DB 프로젝트는 1회 최대 1,000행(`DRAW_DB_PAGE`). 기존 Sync from Drawing이 support_latest 21,204건 중 1,000건만 읽던 버그 수정(실행은 하지 않음).
- 검증: 용접사 ID `IWP-000`/`IWP-K-000`, 검사일 >= 용접일(날짜를 건드리는 저장에만). 저장 실패 사유를 토스트로 표시.
- 결과(현재): 용접 16,663 중 검사 합격 1,720(10.3%). 검사 방법 미지정 13,087, VT 미실시 14,783, NDE 미실시 44, PWHT 미실시 346, Package 미배정 11,679, 날짜 오류 30, Rev 불일치 4 ISO(기존 예외). 용접사 ID 오류 20종.
- 사용자 결정(2026-09-27): (1) Support 진척 가중치 없음 — EA 수량 그대로. (2) P91인데 PWHT=N이던 2건(HS-021-1 #4, ST-461-1 #1)을 Y로 수정 — 둘 다 PWHT 날짜가 이미 있어 입력 오류였음(백업 `Reports/P91_PWHT_N_Backup_20260927_0210.json`). (3) 용접사 ID는 협력사별로 형식이 달라 현재 값 유지 → 저장 시 형식 검증 제거, 추천 목록·RT 촬영률은 모든 ID.
- 수정 이력·Test Package 단계(2026-09-27, 사용자 SQL 실행): `_audit(via)`가 {updated_at(UTC ISO), updated_by(role 또는 "role (bulk|sync)")}를 모든 쓰기 경로(JM PATCH·bulk-date, Support PATCH·sync-phase-package·sync-drawing upsert/insert, Test Pkg PATCH·sync insert)에 붙인다. 공용 계정이라 사람 이름은 남지 않는다. Test Pkg Register 칸 순서는 Line Check → Punch A Clear → 시험(기존 date_completed/completed) → Reinstatement. `scratch/test_bulk_date.py`의 운영 DB 시험은 이제 이력을 남기므로 `--live`일 때만 실행.
- 화면·메뉴(2026-09-27): Overview의 Post-Weld Backlog 패널 제거(별도 탭 예정, `loadBacklog`·`/api/backlog`는 유지). Marked PID 링크는 Test & Handover로 이동.
- 용접 전 검사 목록(2026-09-27): `scripts/export_inspection_before_weld.py` → `Reports/Inspection_before_Weld_YYYYMMDD.xlsx`. 시트1 검사일<용접일 30건(QA `date_error`와 같은 조건), 시트2 용접일 없이 검사 기록 1건(id 218434, VT). 검사 방법(inspection)만 지정된 것은 계획값이라 제외.
- ISO Revision 자동 적용(2026-09-27): keep-alive(`/api/refresh-db-cache`, 12분)가 `_sync_rev_from_drawing`을 백그라운드로 돌려 JM rev를 dwg_latest revision으로 맞춘다(이력 `system (rev-sync)`). **Drawing DB 쪽이 더 낮은 Revision이면 내리지 않는다**(C01<C01A<C01B<C01C<C03, VOID 등은 그대로 적용) — 09-19에 Drawing DB가 구 버전이라 JM 값으로 복구했던 4개 ISO(59 조인트) 때문. 첫 구현(무조건 적용)이 이 59건을 C01로 내렸다가 백업(`Reports/JM_Rev_AutoSync_Backup_20260927.json`)으로 즉시 되돌림. 건너뛴 ISO는 응답의 `rev_sync_last.skipped_older`.
- 검사일 규칙 정리(2026-09-27, 사용자 요청): 검사일<용접일 30건(VT 19칸·RT 11칸)을 용접일로 수정, 용접일 없는 id 218434의 VT 날짜·결과 삭제(이력 `system (date-fix)`, 백업 `Reports/Insp_Date_Fix_Backup_20260927.json`). 화면은 날짜 선택 즉시 `_inspOrderOk`가 행의 `data-weld`(NDE·Test Pkg Joint Check)/`data-insp-min`(JM 용접일 칸)과 비교해 어긋나면 토스트를 띄우고 입력을 받지 않는다. 서버는 기존대로 PATCH·bulk-date에서 한 번 더 막는다.

---

# Context Notes — OOM 재발 근본 원인 (2026-09-29)

- 09-28 수정(malloc_trim·QA 스캔 제거) 뒤에도 09-29 OOM 17회. 저장 재빌드 사이클은 이제 108→67MB로 내려와 정상이었고, 죽기 직전마다 `GET /api/joints?limit=10000&offset=N`(JM Export·Print, `_fetchAllFiltered`)이 있었다. 컨테이너 수명 1~2분, 한 건에 cur 265~320MB·cgroup 370~420MB, 두 건이 겹치거나 재빌드와 겹치면 512MB 초과.
- 진짜 원인은 라이브러리: postgrest 2.31 `APIResponse.from_http_request_response`가 `JSONAdapter.validate_json`(pydantic 재귀 Union)으로 파싱해 10,000행 조회 한 건이 네이티브 메모리 +245MB(httpx 수신+json.loads는 +31~37MB). tracemalloc에는 35MB만 잡힌다(힙 밖이라) — 메모리는 프로세스 수준(Windows `GetProcessMemoryInfo` PeakPagefileUsage, Linux VmRSS)으로 재야 한다. `requirements.txt`가 `supabase>=2.0.0`이라 배포 때 새 버전이 들어온 것.
- 수정: 그 메서드를 json.loads 파싱으로 교체(값·타입 동일 확인), 비공개 메서드라 `supabase==2.31.0` 고정 — **버전을 올릴 땐 `_get_count_from_http_request_response`·`model_construct`가 그대로인지 확인**. 목록 API 상한 `_MAX_PAGE_ROWS=2000`, 프런트는 서버 `count`까지 이어 받는다(상한이 바뀌어도 잘리지 않게).
- 측정(로컬, 요청 1건 최고 메모리 증가): JM Export 페이지 +229→+9MB, Test Pkg Status 필터 +136→+21MB, Support 전체 +131→+10MB, 전체 빌드 +51→+21MB(KPI 동일). JM 전체 51,114행 Export는 26회 요청 약 50초(로컬).
- 로컬 .venv도 supabase 2.31.0으로 맞췄다(이전 2.30.0).
- 불필요 코드 판단(09-22~29 운영 로그 26,205줄 기준 호출 수): 화면 기능 엔드포인트는 모두 호출됨. `/api/area-field-quantities`는 프런트 호출이 없고 로그의 1건도 curl 시험이라 삭제. 호출 0건인 Sync·bulk-date·Support/Test Pkg 수정·삭제는 드물게 쓰는 쓰기 기능이라 1주 기록만으로 지우지 않았다. `/api/welders` 404 56건은 v7.57 이전 JS가 열린 탭(코드엔 없음). app.py·dashboard.js에 참조 없는 함수는 없음.
- 옛 JS(v7.40 등)가 열린 탭은 Export가 1만 행 기준으로 돌아 2,000행 상한에서 첫 페이지만 받고 멈춘다 → 배포 후 사용자에게 새로고침 안내.

## 2026-10-07 Inspection 기본값 / PWHT 재질 제한
- 작업일 최초 입력 시 Inspection=VT 기본(JM 단건 저장은 프런트, ISO 일괄 저장은 bulk-date 서버). TP Joint Check의 Inspection은 드롭다운으로 변경 가능, VT Save 시 함께 저장.
- PWHT: CS·SS=N, P91=Y 고정, P22 등은 Y/N 선택. 서버 PATCH도 같은 규칙으로 거절(`_required_pwht`).
- 작업일 있고 Inspection 빈 기존 10,945건 VT 일괄 입력(사용자 요청). 백업 Reports/Inspection_VT_fill_backup_20261007_183856.json

## 2026-10-07 Overview 차트 개편
- Weekly DI → Monthly DI Productivity(최근 3개월, `_dashData.monthly` = date_completed 기준, 진행 중인 달은 부분값). 패널 폭 Monthly 1 : Pressure Test 2.
- Pressure Test Progress: `/api/testpkg-by-system`(test_package_master의 system별 total/completed, 5분 캐시, Test Package PATCH/DELETE·cache clear 시 무효화). 대시보드 System 전체 목록과 합쳐 Package 없는 System은 빈 칸으로 표시. 완료=파란색(Weekly DI 색과 동일), 완료율은 막대 위.
- 템플릿(index.html)은 Flask가 캐시하므로 로컬 확인 시 서버 재시작 필요.

## 2026-10-08 Pressure Test Progress 임시 형식
- 전체 Package 목록이 아직 없어 System별 "완료된 Package 개수"만 막대로 표시(막대 위 숫자). 전체 대비 완료 %로 바꿀 예정 — `/api/testpkg-by-system`이 total도 이미 내려주므로 `renderPressureTestChart`만 바꾸면 된다(이전 %/누적 막대 버전은 git 기록 c529e38~45465f0).
- Package 3곳(JM·Support·Test Package Master)은 같은 날 비움. 신규 등록 시 세 곳 형식 일치(백업은 Reports/).
