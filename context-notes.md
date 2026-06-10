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
