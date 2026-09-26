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
