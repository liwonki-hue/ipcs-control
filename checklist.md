# Checklist — Export/Print 전 탭 적용 + Import 제거 + 최적화 (2026-06-10)

## 1. Export to Excel / Print 버튼 — 모든 탭 ✅
- [x] Overview: 헤더에 Export/Print 추가 (패널 내 중복 Export는 헤더로 이동)
- [x] Early Power: Export(6개 테이블 시트) + Print 추가 — 테스트 통과
- [x] Weekly: Export(5개 테이블 시트) + Print 추가 — 테스트 통과
- [x] Systems: 기존 Export plan_di undefined 가능성 수정(total_di fallback) — 테스트 통과
- [x] Unit/Area: Export(Units/Areas 시트) + Print 추가 — 테스트 통과
- [x] Welder: 기존 exportWelderExcel 함수에 버튼 연결 + Print 추가 — 3시트 통과
- [x] RT Quality: Export(3개 테이블 시트) + Print 추가 — 테스트 통과
- [x] Joint Master: 기존 Export/Print 검증 통과
- [x] Support Master: 기존 Export/Print 검증 통과
- [x] NDE & PWHT: 기존 Export/Print 검증 통과
- [x] Pkg Master: Print 추가, Export 검증 통과
- [x] Test Master: Print 추가, Export는 데이터 0건 시 "No data" 처리 정상
- [x] Print CSS: 패널/카드/게이지 인쇄용 흰 배경·검정 텍스트 보강

## 2. Import 버튼 삭제 ✅
- [x] index.html: JM/SM Import 버튼 + 파일 input 삭제 (DOM 검증: 0건)
- [x] dashboard.js: importJMExcel, importSMExcel, downloadJMTemplate(dead) 삭제
- [x] app.py: /api/joints/import, /api/support-master/import, /api/testpkg-master/import 삭제
- [x] 후속 정리: import io 제거, pandas requirements 제거, .btn-de-import CSS 제거

## 3. 직접 테스트 (브라우저) ✅
- [x] 12개 탭 전부 Export 실행 → 시트/행 수 확인 (Test Master는 빈 데이터 경로 확인)
- [x] 12개 탭 전부 Print 실행 → page-print-active 대상 페이지 일치 확인
- [x] 콘솔 에러/경고 0건

## 4. 최적화 (6단계) ✅
- [x] 1) 임시 코드/파일 제거 — srv_out.txt, srv_err.txt 삭제
- [x] 2) 전체 코드 검증 — 고아 import/함수/CSS 제거 (위 2번 항목)
- [x] 3) 전체 기능 검증 — 12개 탭 순회 (위 3번 항목)
- [x] 4) 성능·안정성 — pandas 의존 제거(빌드/메모리 감소), 캐시/gzip 기존 설정 유지
- [x] 5) 로컬 웹 직접 작동 검증 — 서버 재시작 후 재검증 완료
- [x] 6) git commit → push

---

# Checklist — Render OOM 예방 1~4번 (2026-09-19)

Plan: 09-19 로그 점검에서 나온 예방책 중 무료 범위 1~4번을 수행. 항목별로 검증 후 의미 단위로 커밋하고, push는 finish 때 한다.

- [x] 1. 메모리 측정 정상화 — 현재 RSS + 컨테이너(cgroup) 사용량 로그, 요청 단위 메모리 변화 로그, stdout 즉시 출력
  - 검증: 로컬 부팅, 새 로그 포맷 확인, Windows에서 None 안전
- [x] 3. Supabase 연결 끊김 1회 재시도 — 멱등 요청만 재시도하는 httpx 트랜스포트를 httpx_client로 주입
  - 검증: 가짜 트랜스포트 단위 테스트(재시도/비멱등 미재시도), 실서버 읽기 스모크
- [x] 2. `/api/cache/clear` 디바운스 개선 — leading+trailing, 진행 중 빌드 재실행 플래그, 프런트가 deferred 응답이면 대기
  - 검증: Flask test client로 연속 호출 시나리오
- [x] 4. 저장 종류별 캐시 무효화 범위(scope=joint/support) — 호출 431건 중 Joint 저장 91%, Support 9%
  - 검증: scope별 삭제/보존 대상 단위 테스트, 프런트 호출부 수정
- [x] 항목별 커밋 (push는 finish 때)

---

# Checklist — JM vs Drawing DB 비교 리포트 (2026-09-19)

- [x] 두 DB 구조 확인 (dwg_latest 4,026건 유일, Revision에 VOID 53건 포함)
- [x] `scripts/compare_iso_drawings.py`를 Drawing DB 기준으로 갱신 — JM 누락 / Revision 불일치 / (기존 유지) JM에만 존재
- [x] 검증: 엑셀 재로딩, 누락 4건·불일치 6건을 DB에서 직접 재조회해 대조, 일치 ISO가 결과에 없는지 확인
- [x] 커밋 (push는 finish 때)

---

# Checklist — Joint Master 목록 정렬 (2026-09-21)

- [x] 원인 확인 (order("id"), joint_no 문자열)
- [x] `/api/joints`를 ISO Drawing → Joint No 숫자순으로 정렬 (`_sort_joints_numeric`)
- [x] 검증: 전체 정렬과 표본 페이지/필터/큰 limit 대조, WD-512-1에서 Joint 21이 마지막
- [x] 커밋 (push는 finish 때)

---

# Checklist — KPI Remaining DI를 Piping 기준으로 + Fab/Erect % 표시 (2026-09-22)

- [x] Remaining DI 서브텍스트의 % 를 가중 전체 진척(weightedPct)이 아닌 Piping(overall_pct) 기준으로 수정
- [x] Completed DI 카드: Fab/Erect 옆에 각 공정 전체 DI 대비 % 가로 표시
- [x] Remaining DI 카드: Fab/Erect 잔여 DI와 잔여 % 가로 표시
- [x] 브라우저에서 값/레이아웃 확인 — Fab+Erect 잔여 합 = 77,376, 1920px에서 가로 한 줄, 1416px(사이드바 포함)에서는 카드가 좁아 줄바꿈

---

# Checklist — 신규 Revision Drawing(2026-09-23 업로드) JM 정합성 (2026-09-24)

- [x] 업로드 대상 식별: file_link의 Cloudinary 버전 타임스탬프(KST)로 09-23 23시~09-24 00시 배치 150건 + 09-21 2건 = 152건 (전부 C03)
- [x] JM rev vs Drawing DB 비교 (미리보기, 읽기 전용) — 139 ISO / 1,653 조인트가 C03으로 변경 대상, 기존 예외 4 ISO 제외
- [x] JM rev를 Drawing DB 기준으로 갱신(canary → 일괄) + 롤백용 백업 + 검증 — 0건 불일치, 전체 51,114행 유지
- [x] 152개 PDF에서 원형 Joint No 추출 → JM joint_no와 ISO별 대조 (Reports/JM_Joint_vs_PDF_20260924.xlsx)
- [x] 불일치 ISO 표본을 렌더링해 추출 로직 검증 (CWS-062-1, CWR-033-1, LS-011-2, DW-001-1, WD-518-1)

---

# Checklist — 전체 JM DB vs ISO Drawing PDF Joint No 대조 → Large/Small Bore Master 엑셀 (2026-09-24)

- [x] 전체 도면(VOID 제외 3,973건) PDF를 다운로드 후 메모리에서 파싱해 Joint No 추출(병렬, 결과 캐시 Reports/pdf_joint_extract_cache.jsonl)
- [x] 추출 결과 품질 점검 — 도면 유형·회전 페이지·가려진 도형 등 판독기를 여러 차례 보완, 0건 도면 13건만 남음: 도면 유형별(텍스트/OCR/표기없음) 분포, 표기 없음 도면의 원 미검출 여부 표본 확인
- [x] JM과 ISO별 Joint No 집합 비교 + Revision 상태 비교
- [x] 기존 Joint Master 엑셀 형식(ID~REMARK) + "비교 REMARK" 열로 차이 행 작성 (JM에만 있음 / ISO Drawing에만 있음)
- [x] Bore 분리: size_inch ≤ 2 Small, 그 외 Large (ISO Drawing에만 있는 번호는 규칙 확정 후 배정)
- [x] Large_Bore_Master_20260924.xlsx, Small_Bore_Master.xlsx 생성 및 건수 검증

---

# Checklist — Joint Master 검색/저장 지연 개선 (2026-09-26)

가정: "진행" = 제안한 4개 중 코드로 할 수 있는 1·3·4번. 2번(Render Start Command `--threads 4 --timeout 90`)은 대시보드 설정이라 안내만 한다.

- [x] 1. 일괄 저장: `POST /api/joints/bulk-date`(로그인 필요, ids 200개씩 단일 UPDATE) + Apply to All/Clear를 요청 1회로 (PATCH N회 제거)
- [x] 3. 검색 디바운스(350ms) + 이전 요청 취소(AbortController) + 응답 순서 확인 (`loadJointMaster`)
- [x] 4. `/api/joints` 경계 ISO 재조회를 페이지 앞뒤에 같은 ISO 행이 있을 수 있을 때만 수행(DB 왕복 2회 → 보통 1회)
- [x] 검증: 정렬 결과가 이전과 동일한지(모의 DB 전수 + 실제 DB 표본), bulk 엔드포인트(값이 안 바뀌는 조회성 갱신으로만), 브라우저에서 입력 시 요청 수, 문법/컴파일
- [x] 2. Render Start Command 변경(사용자가 대시보드에서 적용 완료)

---

# Checklist — 최적화 6단계 (2026-09-27)

배경: 09-26에 Render Start Command가 `--workers 1 --threads 4 --timeout 90`으로 바뀌어, 요청이 이제 동시에 처리된다. 단일 스레드를 전제로 짠 코드가 있는지가 이번 점검의 핵심이다.

- [x] 1. 임시/불필요 코드 제거 (추적 파일 전체)
- [x] 2. 전체 코드 검증: 잠재 버그, 미사용 코드, 중복, N+1, 예외 처리 누락, 스레드 안전성
- [x] 3. 모든 탭·API·차트·테이블·드롭다운 동작 검증 (API 38개 전수 + 브라우저 12개 탭)
- [x] 4. 속도·안정성: 캐시 TTL, RPC 수, gzip, 메모리, 동시 요청 시 메모리/중복 스캔
- [x] 5. 로컬 웹에서 직접 확인
- [ ] 6. semantic commit → push

---

# Checklist — 공정 관리 관점 개선 1~3절 적용 (2026-09-27)

가정: "1번부터 3번까지" = 추천 답변의 1절(로직 높음)·2절(로직 중간)·3절(메뉴·화면). 4절(범위 확장) 제외.

- [x] 1-① Backlog API + Overview 카드 (NDE/VT/PWHT 대기, RT Repair 미처리, Package 미배정, 날짜 오류, 경과일)
- [x] 1-② P91 PWHT 기본값 Y (DB 반영, 백업, P22·명시값은 유지)
- [x] 1-③ Test Package 준비도를 검사 합격 기준으로 + Package 미배정 표시
- [x] 1-④ 용접사 입력 추천 목록 (형식 검증은 사용자 결정으로 제거 — 협력사별 형식 차이)
- [x] 1-⑤ Joint Master "Rev 불일치" 필터
- [x] 2 RT 촬영률(용접사별), 날짜 순서 검증(저장 시)
- [x] 2 수정 이력 / 3 Test Package 단계 칸 — 사용자 SQL 실행 후 연결
- [x] 2 Support 가중치 — 사용자 결정: 가중치 없음(EA 수량 유지)
- [x] 3 메뉴 재배치·이름 변경, JM 빠른 필터 버튼
- [x] 검증(시험·브라우저) → 커밋 (push는 finish 때)

---

# Checklist — OOM 재발 근본 원인 및 불필요 코드 정리 (2026-09-29)

- [x] Render events API로 09-28 배포(6858506) 이후 OOM 확인 — 09-29 04:32~04:45Z 8회, 10:02~10:21Z 9회
- [x] 해당 구간 로그로 원인 요청 확정 — `GET /api/joints?limit=10000`(Export/Print) 한 건에 RSS 60→265~320MB
- [x] 로컬 재현·단계별 측정 — postgrest `validate_json` 파싱이 +245MB(json.loads +37MB)
- [x] 수정 1: postgrest 응답 json.loads 파싱 + supabase==2.31.0 고정 (18483c1), 4개 테이블 72,417행 결과 동일 확인
- [x] 수정 2: 목록 API 2,000행 상한 + 프런트 count 기준 페이지 루프 (4a6d785), 브라우저에서 전체·필터 건수 일치 확인
- [x] 주간 운영 로그로 엔드포인트 사용 빈도 확인 → 안 쓰는 기능·코드 삭제 (`/api/area-field-quantities`만 해당, ed23fa7)
- [x] 테스트·빌드 확인(scratch 시험 9개 통과) → 커밋 (push는 finish 때)
- [ ] 배포 후 확인: Render events API로 OOM 0건, `[memory] GET /api/joints` 급등 사라졌는지

## 2026-10-10 testpkg-joints OOM 수정
- [x] status 스캔을 판정 컬럼+id만 읽고 id만 캐시
- [x] 같은 조건 동시 스캔 락, 스캔 후 malloc_trim
- [x] 기존 방식과 결과 동일 검증(실DB)
- [ ] push(finish) 후 Render events OOM 0건·`mem cur` 하강 확인

# Checklist — Early Power 임원 보고용 1페이지 Report (2026-10-29)
- [x] EP 헤더에 Report 버튼 추가 (Export Excel / Print 옆)
- [x] `buildEpReportHtml(data, sup)` — A4 가로 1페이지: 헤더·KPI 줄·S-Curve(SVG)·System 표·Sub Area 표
- [x] `epReport()` — 새 창에 열어 자동 인쇄(PDF 저장 가능), 팝업 차단 시 안내
- [x] EP 목표 주/날짜 상수화(`EP_TARGET_WK`=39, `EP_TARGET_DATE`) — 화면 S-Curve와 보고서가 같은 값 사용
- [x] 로컬 검증: 보고서 HTML이 A4 가로 1페이지에 들어가는지(PDF 쪽수), 수치가 EP 탭과 일치
- [x] dashboard.js 캐시 버전(v=) 올림, 커밋 (push는 finish 후)

---

# Checklist — 저장(PATCH) API 수정 가능 컬럼 제한 (2026-11-08)

Plan: Joint·Support·Test Package 저장 API가 요청 본문을 그대로 UPDATE에 넘기던 것을, 화면이 실제로 보내는 컬럼만 받도록 서버에서 제한한다. 화면 코드는 바꾸지 않는다.

- [x] 화면이 보내는 PATCH 페이로드 전수 확인 (Joint 4곳, Support 3곳, Test Pkg 1곳)
- [x] 허용 목록 상수 + 공용 헬퍼 `_editable_body` 추가 (`JOINT_EDITABLE`, `SUPPORT_EDITABLE`, `TESTPKG_EDITABLE`)
- [x] 세 PATCH 엔드포인트에 적용, 목록 밖 컬럼·비객체·빈 본문은 400
- [x] Support: completed와 date_completed가 함께 오면 서로 일치해야 함(화면은 항상 일치)
- [x] 테스트 `scratch/test_patch_whitelist.py` — 가짜 DB로 거절·정상 저장·화면 페이로드 통과·401 확인 (45건 통과)
- [x] 기존 테스트 test_bulk_date·test_sort_joints_numeric 영향 없음
- [ ] 실제 화면에서 저장 동작 확인 — 운영 DB에 연결된 로컬이라 로그인 후 사용자가 직접 확인 필요

---

# Checklist — 즉시 개선 3종: esc() · pytest · refresh 호출 제한 (2026-11-08)

Plan: 컬럼 제한(9df5ba9)에 이어 나머지 "즉시" 항목을 적용한다. 인증·접근 제어를 바꾸는 항목(공개 조회 범위, 토큰, 환경변수, 개인 계정)은 사용자 확인 대상이라 제외.

- [x] esc() — dashboard.js에 HTML 이스케이프 함수 추가, DB 문자열 보간 61곳 + 변수 보간 6곳에 적용
- [x] drillWelder 인라인 핸들러(JS 문자열 컨텍스트)는 data-welder 속성으로 전환 — HTML 이스케이프로는 막을 수 없는 형태였음
- [x] refresh-db-cache 최소 간격 300초 (건너뛴 호출은 200+skipped, 실패한 호출은 간격에 안 넣음)
- [x] tests/ — pytest 72건 (합격 판정·PWHT·Rev 비교·Pkg 단계·날짜 검증·저장 API·호출 간격·esc 적용 여부)
- [x] .github/workflows/tests.yml — 푸시마다 pytest (가짜 DB라 시크릿 불필요), requirements-dev.txt
- [x] 검증: .env 없이도 72건 통과 / esc 하나를 일부러 빼면 테스트 실패 확인 / 로컬 서버 재시작 후 JM·Support·NDE·Test Pkg·RT·Welder·Overview·EP 렌더링과 콘솔 에러 0 확인 / 실서버에서 3회 호출 시 1회만 갱신
- [ ] 로그인 후 실제 저장(JM·Support·Test Pkg)과 특수문자 값 표시는 사용자가 직접 확인 (운영 DB 연결 + 로그인 정보 규칙)

---

# Checklist — ISO 중심 기능(추천 2번) + 구조 개선(추천 3번) (2026-11-08)

Plan: ISO Drawing 단위로 진행 상황을 한눈에 보는 "ISO Status" 탭, 규칙 위반·불일치를 찾는 "Data Quality" 탭, Overview의 System별 진행 속도·완료 예측 표를 만든다. 새 코드는 처음부터 분리된 모듈(iso_analysis.py, cache_util.py, static/js/iso_tools.js)로 쓰고 pytest를 붙인다.

범위 밖(사용자 결정·권한 필요 또는 검증 불가)
- Render에 DRAWING_SUPABASE_* 환경변수 설정(보안), 유료 인스턴스(비용), 시험 이후 공정 추가(범위 결정)
- 집계 SQL(RPC) 이전: DDL을 앱 키로 실행할 수 없고 여기서 검증도 못 함 → 이번에는 페이지 단위 1회 스캔+캐시로 처리
- 기존 app.py·dashboard.js 전체 분리와 기존 캐시 15개 이관: 테스트가 없는 구간이라 회귀 위험이 큼 → 새 코드만 분리

- [x] iso_analysis.py — ISO 집계, 데이터 품질 검사, 속도·예측 (순수 함수)
- [x] cache_util.py — TTLCache(낡은 값 먼저 보여 주기·single-flight·범위별 무효화)
- [x] app.py — 병렬 스캔 + /api/iso-status, /api/data-quality(로그인), /api/pace-forecast, 저장 시 무효화, keep-alive 예열
- [x] 화면 — ISO Status 탭, Data Quality 탭, Overview Pace & Forecast 표(목표일 입력 시 필요 속도·격차)
- [x] pytest — 127건(집계·검사 24개 항목·속도 예측·캐시·엔드포인트·이스케이프)
- [x] 실데이터 검증 — 운영과 같은 supabase 2.31 환경에서 21.6초·+50MB·오류 0, 합계가 대시보드 KPI와 일치, 화면 3곳 확인

## 정정 (2026-11-08) — Pace & Forecast 삭제
- 사용자 판단: 플랜트 공사는 System별로 꾸준히 진행되지 않아 최근 4주 속도로 만든 완료 예측은 의미 있는 데이터가 아님 → Overview의 Pace & Forecast 표와 `/api/pace-forecast`, 집계 코드, 테스트를 모두 제거.

---

# Checklist — 최적화 및 finish (2026-11-09)

- [x] 1. 임시/불필요 코드 제거 — 추적 파일(app.py, iso_analysis.py, cache_util.py, iso_tools.js, tests)에 debug print·console.log·TODO·주석 처리된 코드 0건
- [x] 2. 전체 코드 검증 — pyflakes(app.py·신규 모듈·tests) 지적 0건(도구 동작 확인함), JS 미참조 함수 0건(dashboard.js 126개, iso_tools.js 26개), iso_tools.js 전체 정독 → 버그 2건 수정(아래)
- [x] 3. 기능 검증 — GET API 22개 전부 응답(데이터 품질만 로그인 필요라 401이 정상), 15개 탭 전부 렌더링·JS 오류 0, JM/Support/NDE/TP 페이지 이동·JM ISO 검색·용접사 상세 확인
- [x] 4. 성능·안정성 — 운영 환경(supabase 2.31)에서 keep-alive 한 번에 재빌드+ISO 분석+사용자 조회 7건이 동시에 겹치는 최악 상황: 전부 200, 22초, 메모리 65→115MB(512MB 한도 대비 여유). 낡은 캐시는 0.03초에 응답, 압축 후 `/api/iso-status` 82KB
- [x] 5. 로컬 웹 검증 — 서버 재시작 후 위 3·4번을 브라우저로 확인
- [x] 6. pytest 128건(로컬, `.env` 없는 운영 환경 모두) → commit → push

---

# Checklist — finish (2026-11-09, 서버 페이지 표 행 수 맞춤·제목 변경 마무리)

- [x] 1. 임시/불필요 코드 제거 — 지난 push(`3e2a63c`) 이후 추가된 줄에 debug print·console.log·TODO·주석 처리된 코드 0건
- [x] 2. 전체 코드 검토 — pyflakes 0건, JS 미참조 함수 0건(dashboard.js 139개·iso_tools.js 24개), 공용 `_fitServerPage` 정독(로딩·빈 결과 행, 반복 3회 제한, 상한 기억, 페이지 위치 유지) 이상 없음
- [x] 3. 테스트 — pytest 130건(로컬, `.env` 없는 운영 환경 모두), 15개 탭 재확인(JS 오류 0). ISO 분석이 처음 만들어지는 약 20초 동안 다른 탭 조회와 겹치면 로컬(supabase 2.4.5)에서만 500이 날 수 있음(운영 조건에서는 동시 4건 전부 200) — 분석이 끝난 뒤 재확인에서 전부 정상
- [x] 4. commit — 미push 커밋 3개(`107ec00`, `605c5fe`, `402d05a`) + 이 기록
- [ ] 5. push 후 GitHub Actions(Tests) 결과와 Render 배포 확인

---

# Checklist — finish (2026-11-09, 네비게이터 개수 위치 정렬)

- [x] 1. 임시 코드 제거 — 추가된 줄에 debug print·console.log·TODO 0건
- [x] 2. 검토 — pyflakes 0건, JS 문법 정상, 변경은 CSS 규칙 2줄과 캐시 버전뿐
- [x] 3. 테스트 — pytest 130건(로컬, `.env` 없는 운영 환경 모두), 행 수 맞춤 5개 탭이 1696×830에서 네비게이터 화면 안·문서 스크롤 0px
- [x] 4. commit — `6fdd4d7` + 이 기록
- [ ] 5. push 후 CI(Tests) 확인

---

# Checklist — 최적화 (2026-11-09)

- [x] 1. 임시/불필요 코드 제거 — 추적 소스 전체에서 debug print·console.log·TODO·주석 처리된 코드 0건
- [x] 2. 전체 코드 검증 — pyflakes 0건(스크립트 포함), 맨몸 `except:` 5곳을 구체적 예외로 좁힘, `for`+DB 호출 2곳은 묶음 전송으로 확인, JS 미참조 함수 0건
- [x] 3. 기능 검증 — GET API 22개, 15개 탭, 다섯 표의 행 수 맞춤·페이지 이동
- [x] 4. 속도·안정성 — 첫 표시 조회 2회→재방문 1회(맞춘 행 수 기억), `/api/joints` 병목 분석(건수 계산은 7%), 최악 동시 부하 메모리 115MB(지난 finish 때 측정)
- [x] 5. 로컬 웹 검증 — 서버 재시작 후 브라우저로 확인
- [ ] 6. commit → push → CI(Tests) 확인

---

# Checklist — finish (2026-11-09, `/api/joints` 윈도우 조회 + 보조 집계 4종 개선)

- [x] 1. 임시 코드 제거 — 추가된 줄에 debug print·console.log·TODO 0건
- [x] 2. 검토 — pyflakes 0건, 맨몸 `except:` 0곳, JS 문법 정상. 보조 집계 개선 중 주간 집계 들여쓰기 결함을 응답 비교로 찾아 고침
- [x] 3. 테스트 — pytest 186건(`/api/joints` 윈도우 28개, 캐시 확장 7개, 보조 집계 20개 신규). 실데이터 비교: `/api/joints` 42개 요청 차이 0건, 보조 집계 4종 응답이 개선 전과 동일. 운영 조건 최악 겹침(10개 동시) 전부 200·메모리 최고 120MB, 저장 12초 뒤 네 캐시 재신선. 화면(Overview·Early Power·Weekly·Welder) 확인
- [x] 4. commit
- [ ] 5. push 후 CI(Tests)·Render 배포 확인

---

# Checklist — finish (2026-11-09, joint_no_num 컬럼으로 `/api/joints` 숫자 정렬)

- [x] 1. 임시 코드 제거 — 추가된 줄에 debug print·console.log·TODO 0건
- [x] 2. 검토 — pyflakes 0건, 맨몸 `except:` 0곳, JS 문법 정상
- [x] 3. 테스트 — pytest 192건(로컬, `.env` 없는 운영 환경 모두). 실데이터 42개 요청이 원래 기준과 차이 0건, 중앙값 0.99→0.48초. DB 컬럼 51,645행 전부 규칙과 일치. 화면(Joint Master 1~3페이지·NDE) 확인
- [x] 4. commit — `6d83eb5` + 이 기록
- [ ] 5. push 후 CI(Tests)·Render 배포 확인

---

# Checklist — finish (2026-11-09, ISO Status·Test Pkg Joint Check 행 높이 통일)

- [x] 1. 임시 코드 제거 — 추가된 줄에 debug 출력·TODO 0건
- [x] 2. 검토 — pyflakes 0건, 맨몸 `except:` 0곳, JS 문법 정상, 쓰지 않게 된 `--iso-pad` 로직 제거
- [x] 3. 테스트 — pytest 192건 통과. 화면에서 ISO Status 39px / Test Pkg Joint Check 39.6~40px / Joint Master 38.8~39.2px, 페이지 스크롤 없음
- [x] 4. commit — `497ff12` + 이 기록
- [ ] 5. push 후 CI(Tests) 확인
