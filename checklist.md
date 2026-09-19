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
