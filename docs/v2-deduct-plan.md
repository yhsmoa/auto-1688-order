# V2 차감 전환 계획 — `invoiceManager_transactions` → `ft_user_transactions`

작성일: 2026-09-12 · 대상 버전: v1.0.62 · 상태: **구현 완료 (2026-09-13)** — 아래 §2 질문은 전부 결정됨

## 구현 결과 요약 (2026-09-13)

- **정정**: §0.2 의 "매일 00:00 복사 잡"은 존재하지 않는다 (`pg_cron` 미설치, 예약 잡 0건). 09-01~09-12 복사 행은 purchase-agent 쪽에서 1회 실행한 백필이다. → R1(이중 차감) 은 "복사 잡 조정"이 아니라 **앱이 신 원장에만 기록**하는 것으로 해소.
- **DB** — `sql/deduct_balance_rpc_v2.sql`, `sql/ft_user_transactions_indexes.sql` 적용 완료.
  - RPC v2: advisory lock(R4) · reference_id 중복 차단(R5/R8) · 직전 원장 스냅샷 기준(R2) · `applied_date` KST 를 DB 에서 계산(R6) · 신설 컬럼 전부 기록 · `ft_balances` 캐시 갱신 · `ft_orders` 4필드 UPDATE 를 같은 트랜잭션(Q8) · 입력 검증(amount>0, 주문코드 필수, 유저-그룹 소속)
  - 부분 유니크 `(balance_id, reference_id) WHERE out/구매`, 인덱스 `(balance_id, created_at, id)`
  - immong 백필 31행 보정: `vender_name`=판매자명(Q3), `other_fee` null→0(Q7/R10), 금액·스냅샷 소수 2자리(Q2-c)
  - 운영 DB 에서 DO 블록+강제 롤백으로 검증: 정상 차감/체인/캐시 자동보정/KST 적용일/중복·0원·타그룹 차단/ft_orders 동일 트랜잭션 전부 통과, 잔여 데이터 0.
- **앱** — `deductParser.js`(V1/V2 공용 순수 파서, 주문코드 1개·형식·user_code·음수/0 검증, A열 1688 주문번호 수집) 신설. `processDeductExcelV2` 재작성(RPC v2, ft_orders 소유자 검증, 재조회 검증, ¥ 표기). V1 은 파서만 공유하고 구 원장 기록 유지, `date` 는 `todayKST()`(R6). 버튼: BZ/BR/BO → `btnDeductV2`("차감 (신 원장)"), HI/MB → `btnDeduct`(Q4/Q9).
- **회귀 테스트** — `node scripts/test-deduct-parser.js` : 실제 파일(BZ, 144행, 병합 1,221)에서 공용 파서 == 구 V1 (6개 필드 전부 일치) PASS.
- **결정** — Q1(a) · Q2(a)+캐시, 사전 보정 불필요(첫 차감에서 자동) · Q3 판매자명 · Q4(b) · Q5 `ft_orders`/[id] · Q6 넣음 · Q7 0 · Q8 유지+트랜잭션 · Q9 그룹별 하나 · Q11(a) · Q12 차단 · Q13 상수 · Q10 롤백 테스트 · Q14 범위 밖(앱은 service_role).
- **원칙 (2026-09-13 확정) — 신 원장이 유일한 기준, 대체재 없음.** 어느 단계든 문제가 있으면 다른 값(구 원장·ft_balances·전역 환율 등)으로 대신 계산하지 않고 즉시 alert 후 중단한다.
  - RPC v2: `ft_balances` 폴백 제거 → 이월 행 없는 그룹은 `ledger not initialized` 예외. `vender_name` 필수. 반환에서 `prev_source` 제거.
  - 앱 V2: 유저 정보(판매자명/코드/마스터계정) 누락 → 중단. `ft_orders` 주문코드 중복 → 중단(최신 행 임의 선택 안 함). 기록 후 검증 불일치 → 완료 처리하지 않고 경고, 후속 작업 중단.
  - purchase-agent: 사이드바 잔액·거래내역(신) 모두 신 원장만 읽음. 구 원장 대조 배지·구 원장 충전 환율·전역 환율 폴백 전부 제거. 미전환 그룹은 잔액 대신 빨간 경고.
  - 운영 DB 롤백 테스트: 정상 차감 체인 OK / 이월 없는 그룹(hilili) 차단 / 판매자명 빈 값 차단.
- **hilili(HI/MB) 전환 완료 (2026-09-13)** — immong 과 동일 절차: 구 RPC 잔재 72행 백업 후 삭제 → 8/31 이월(date NULL 12건은 created_at KST 로 판정) → 9월 구 원장 6건 복사 → 스냅샷 재계산. 최종 스냅샷 −264,819.64 = 구 공식 잔액 일치. 이제 **모든 그룹이 btnDeductV2 만** 사용하며 V1 은 어디에도 노출되지 않는다(Q4·Q9 갱신).
- **남은 것** — 구 거래요약(/transactions/summary)은 아직 구 원장을 읽는 화면으로 남아 있다. 앱 빌드·배포, 두 저장소 커밋은 미실행.

---

---

## 0. 조사 결과 요약

### 0.1 코드 현황 (renderer.js / index.html / sql)

| 경로 | 버튼 | 함수 | 기록 대상 | 현재 노출 |
|---|---|---|---|---|
| V1 차감 | `btnDeduct` | `deductStock` → `processDeductExcel` (renderer.js:362) → `saveDeductTransaction` (renderer.js:553) | `invoiceManager_transactions` INSERT / order_code 있으면 UPDATE. **잔액 미갱신(기록 전용)** | HI·MB·BZ·BR·BO 전부 |
| 구 V2 차감 | `btnDeductV2` | `deductStockV2` → `processDeductExcelV2` (renderer.js:5158) | ① `ft_orders` 가격 4필드 UPDATE ② RPC `deduct_balance_and_record_transaction` → `ft_balances.balance` 차감 + `ft_user_transactions` INSERT | **전 그룹 숨김** (v1.0.57부터) |

- 엑셀 파싱(1688 주문 내보내기): AD열(买家留言) `ORxx | ...` 주문코드, G열(运费) 배송비, I열(实付款) 실결제, U열(数量) 수량. 병합셀은 첫 행만 합산.
- 계산: `delivery_fee=ΣG`, `price=ΣI−ΣG`, `service_fee=price×0.06`, `amount=delivery+price+service` (모두 소수 2자리 반올림).
- V1/V2 파싱 코드가 거의 동일하게 **중복**되어 있음 (renderer.js:362~550 vs 5158~5305).
- 배포된 RPC 정의는 `sql/deduct_balance_rpc.sql` 과 동일. 신설 칼럼(applied_date 등)은 채우지 않음.
- `USER_CODE_BUTTON_VISIBILITY` (renderer.js:85) 가 그룹별 버튼 노출을 결정. 헤더 주석(renderer.js:76~81)에 "차감은 V1 통일" 명시.

### 0.2 DB 현황 (Supabase `manage-item`, 2026-09-12 조회)

**`ft_user_transactions` 24칼럼.** 기존 18개 + 신설 6개:

| 신설 칼럼 | 타입 | 칼럼 코멘트(DB) | 현재 값 채우는 주체 |
|---|---|---|---|
| `applied_date` | date | 거래요약 월 귀속 기준. 보통 created_at 날짜, 환불 정산행만 정산기간 종료일 | 외부 동기화 |
| `source_table` | text | `opening`(이월) / `invoiceManager_transactions`(구 원장 복사) / `ft_cancel_details`(환불 정산) | 외부 동기화 |
| `source_ids` | **uuid[]** | 원본 행 id 목록 — 이중 반영 방지 + 정산행 구성 건 조회 | 외부 동기화 |
| `master_account` | text | 대표 계정 username (immong, hilili) | 외부 동기화 |
| `user_code` | text | BZ/BR/BO/HI/MB — 화면 라벨 "immong BZ" 용 | 외부 동기화 |
| `krw_amount` | numeric | 충전 원화 금액(KRW) — 환율 계산용 | (아직 전부 null) |

- 제약: `amount >= 0` CHECK, FK `balance_id→ft_balances`, FK `user_id→ft_users`. **유니크 인덱스 없음**(PK만). 트리거/뷰/다른 함수 없음. RLS 비활성(anon 전체 권한 — Supabase advisor 경고).
- `ft_users` 5명: BO(sulon/설온), BR(immongbr/아이엠몽), BZ(immong/아이엠몽) → balance `a8965582`(김덕준) / HI(hilili/안녕릴리), MB(moodbeige/무드베이지) → balance `fcfc6aff`(유호성). `ft_users.master_id == balance_id` 로 동일.

**원장 데이터 103행의 출처 분포**

| balance | 출처 | 건수 | 기간 | 비고 |
|---|---|---|---|---|
| immong | `opening` 이월 | 1 | 2026-09-01 | source_ids 2,960건 = **전부 ft_cancel_details id** (iM 행 0건) |
| immong | `invoiceManager_transactions` 복사 | 28 | 09-01 ~ 09-12 | 매일 00:00:0N(UTC) 로 created_at **합성**, applied_date=iM.date, reference_id=order_code, vender_name=**username**(sulon/immong/immongbr), other_fee **null** |
| immong | `ft_cancel_details` 환불 | 2 | 09-12 | |
| hilili | (null) — 구 RPC 직접기록 | 72 | 03-13 ~ 08-24 | reference_id/user_code/master_account 없음, vender_name=**한글**(안녕릴리) |

**잔액 정합성**

| balance | `ft_balances.balance` (updated_at) | 원장 최신 `balance_snapshot` | Σin − Σout |
|---|---|---|---|
| immong | −210,799.83 (2026-04-21) | −104,362.86 | −104,362.86 ✓ |
| hilili | −140,995.34 (2026-08-24) | −140,995.34 | −140,995.34 ✓ |

→ 원장은 자체 체인으로 정합. **`ft_balances` 는 immong 쪽이 5개월 전 값으로 stale.** 외부 동기화는 ft_balances 를 갱신하지 않음.

**동기화 공백(iM 차감 중 원장에 없는 건, 08-20 이후)**

| 그룹 | 미반영 |
|---|---|
| HI | 9건 전부 (08-26 ~ 09-12) — hilili 는 이월도 없음 |
| BZ / BO | 08-20 ~ 08-31 13+14건 — 이월 이전이라 의도된 제외로 보이나 이월 source_ids 에도 없음 |
| BZ 충전 | MANUAL-충전 08-31 1건 |

### 0.3 발견된 리스크 (돈 관련, 구현 전 반드시 결정)

| # | 리스크 | 근거 |
|---|---|---|
| R1 | **이중 차감** — 앱이 원장에 직접 쓰는데 야간 동기화가 iM 차감을 또 복사 | 동기화가 source_ids 기준으로 iM→원장 복사 중. 앱이 iM 도 계속 쓰면 2번 반영 |
| R2 | **snapshot 기준 불일치** — 기존 RPC는 `ft_balances.balance − amount` 로 snapshot 계산. immong 은 ft_balances 가 stale 이라 체인이 −210k 로 점프 | 0.2 잔액 정합성 표 |
| R3 | **hilili 원장 미완성** — 이월 없음, 08-26 이후 미반영. 이 상태로 V2 켜면 HI/MB 잔액이 틀림 | 동기화 공백 표 |
| R4 | **동시성** — 두 PC가 같은 balance 에 동시에 차감하면 snapshot 경합 | 잠금 없음 |
| R5 | **재차감/수정 불가** — V1은 order_code 로 UPDATE 했지만 원장은 체인 구조라 UPDATE 하면 이후 행 snapshot 이 전부 틀어짐 | iM 에 order_code 중복 2건, UPDATE 이력 존재 |
| R6 | **날짜 UTC 버그** — `toISOString().split('T')[0]` 은 UTC 날짜. KST 00~09시 차감은 전날로 기록 (예: ORBZ260617-A48 date=06-16, KST=06-17). 그대로 applied_date 로 복사되면 월 귀속 오류 | renderer.js:589, iM 실데이터 |
| R7 | **vender_name 불일치** — 앱은 `ft_users.vender_name`(설온) 을 넣고, 동기화는 `username`(sulon) 을 넣음 | 0.2 출처 표 |
| R8 | **유니크 제약 없음** — 같은 order_code 로 두 번 눌러도 막지 못함(현 V2 는 amount+오늘 날짜로만 검사) | 인덱스 목록 |
| R9 | **RLS 비활성** — anon 키로도 원장 INSERT/DELETE 가능 (앱은 service_role 사용 중이라 기능엔 영향 없음) | Supabase advisor |
| R10 | `other_fee` 가 동기화 행은 null, RPC 행은 0 — 집계 시 `coalesce` 필요 | 실데이터 |
| R11 | 수수료 6% 하드코딩 (V1/V2 양쪽) | renderer.js:520, 5297 |
| R12 | 최근 `ft_orders` 가격 4필드 전부 null (V1 차감은 ft_orders 를 안 건드림), status 는 계속 PROCESSING | ft_orders 조회 |

---

## 1. 목표 설계 (제안)

### 1.1 값 매핑 — 엑셀 계산값 → `ft_user_transactions`

| 칼럼 | 값 | 출처 |
|---|---|---|
| `balance_id` | 선택 유저의 `ft_users.balance_id` | 드롭박스 dataset |
| `user_id` | `ft_users.id` (UUID 검증) | 드롭박스 value |
| `vender_name` | **Q3 결정** — 제안: `ft_users.username` (동기화 행과 통일) | |
| `type` / `category` | `'out'` / `'구매'` | 고정 |
| `amount` | `amount` (= delivery + price + service) | 계산 |
| `balance_snapshot` | 직전 snapshot − amount (RPC 내부 계산, **Q2 결정**) | RPC |
| `qty` | ΣU열 | 계산 |
| `item_amount` | `price` (ΣI − ΣG) | 계산 |
| `shipping_fee` | `delivery_fee` (ΣG) | 계산 |
| `service_fee` | `price × 0.06` | 계산 |
| `other_fee` | `0` (**Q7**) | 고정 |
| `description` | `'{order_code} 주문'` | 기존과 동일 |
| `reference_id` | `order_code` (AD열) — **중복 방지 키** | 엑셀 |
| `order_no_1688` | **Q6 결정** — 제안: A열(订单编号) 고유값 콤마 결합 | 엑셀 |
| `admin_note` | null | |
| `applied_date` | **KST 오늘** (UTC 버그 수정) | 앱/RPC |
| `source_table` | **Q5 결정** — 제안: `'ft_orders'` | 고정 |
| `source_ids` | **Q5 결정** — 제안: `[ft_orders.id]` | ft_orders 조회 |
| `master_account` | `ft_users.master_account` | 드롭박스 dataset |
| `user_code` | `ft_users.user_code` | 드롭박스 dataset |
| `krw_amount` | null (충전 전용) | |

### 1.2 새 RPC `deduct_balance_and_record_transaction_v2` (sql/deduct_balance_rpc_v2.sql 신규)

기존 RPC 는 그대로 두고(다른 호출자 없음 확인) v2 를 추가:

1. `pg_advisory_xact_lock(hashtext(p_balance_id::text))` — balance 단위 직렬화 (R4)
2. 중복 검사: `reference_id = p_reference_id AND type='out' AND category='구매' AND balance_id = p_balance_id` 존재 시 `RAISE EXCEPTION 'duplicate'` (R5/R8). 부분 유니크 인덱스로 이중 보호.
3. 직전 snapshot 조회: `SELECT balance_snapshot FROM ft_user_transactions WHERE balance_id=… ORDER BY created_at DESC, id DESC LIMIT 1` → 없으면 `ft_balances.balance` (R2, **Q2**)
4. `v_new = round(v_prev − p_amount, 2)` → INSERT (1.1 매핑 전부)
5. `ft_balances.balance = v_new, updated_at = now()` 동기 갱신 (**Q2-b**)
6. (**Q8**) `ft_orders` 가격 4필드 UPDATE 를 같은 트랜잭션 안으로 이동 → 원장은 성공했는데 ft_orders 는 실패하는 상황 제거
7. 반환 JSON: `transaction_id, prev_balance, new_balance, amount, applied_date`

보조 DDL (sql/ft_user_transactions_indexes.sql):
```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_ft_user_tx_out_ref
  ON ft_user_transactions (balance_id, reference_id)
  WHERE type = 'out' AND category = '구매' AND reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ft_user_tx_balance_created
  ON ft_user_transactions (balance_id, created_at DESC);
```
> 유니크 인덱스는 기존 데이터 충돌 검사 후 적용 (현재 reference_id 중복 0건 확인).

### 1.3 renderer.js 변경 목록

| 위치 | 변경 |
|---|---|
| 76~81 헤더 주석 | "차감 V1 통일" → V2(ft_user_transactions) 전환 내용으로 갱신 |
| 85~91 `USER_CODE_BUTTON_VISIBILITY` | `btnDeduct` → `btnDeductV2` 로 교체 (**Q9**: 그룹 범위, V1 병행 여부) |
| 362~550 / 5158~5305 | 엑셀 파싱+검증+계산을 `parseDeductExcel(file, orders, selectedUserCode)` 하나로 추출. 반환 `{orderCode, orderNos1688[], delivery_fee, price, service_fee, amount, item_qty}` — V1/V2 공용 |
| 589 `dateStr` | KST 날짜 헬퍼 `todayKST()` 로 교체 (V1 `date` 도 함께 수정, R6) |
| 5158 `processDeductExcelV2` | ① 파싱 헬퍼 호출 ② ft_orders 존재 확인(유지) ③ **amount+오늘 중복검사 제거** → reference_id 기반으로 대체 ④ RPC v2 호출(신설 파라미터 전달) ⑤ ft_orders UPDATE 는 RPC 안으로 이동(Q8) ⑥ 검증: 반환 tx id 재조회 + snapshot = prev − amount 확인 ⑦ 완료 alert 에 이전/이후 잔액 표시 |
| 5257~5270 user_code 검증 | 유지. `OR{user_code}{YYMMDD}-…` 형식 정규식으로 강화 |
| 796~842 `populateFtUserSelect` | 이미 필요한 dataset 전부 있음 (balanceId, username, userCode, masterAccount). 변경 없음 |
| 5488 `stepStatus.deduct` | 유지 |

### 1.4 index.html
- 1466~1469 차감 그룹: 버튼 라벨 정리 (`V2 차감` → `차감`, V1 은 `차감(구)` 로 숨김 유지 여부는 Q9)

### 1.5 전환 절차 (cutover)

1. **외부 동기화 잡 조정(선행, 다른 프로젝트)** — 앱이 원장에 직접 쓰기 시작한 날 이후 iM `transaction_type='차감'` 행을 복사하지 않도록 필터 추가, 또는 앱이 iM 기록을 중단 (**Q1**)
2. hilili 이월/백필 (**Q4**) — 8/31 기준 이월 행 + 08-26~09-12 iM 9건 복사, 또는 앱 전환 시점 기준 이월
3. immong `ft_balances.balance` 를 원장 최신 snapshot 으로 1회 보정 (**Q2-b** 채택 시)
4. DDL 적용 (인덱스, RPC v2) — `sql/` 파일로 저장 후 Supabase 에 적용
5. 앱 배포 (v1.0.62). 첫 며칠은 alert 로 이전/이후 잔액을 노출해 육안 검증
6. 검증 쿼리 (매일): `Σin−Σout == 최신 snapshot`, `reference_id 중복 0`, `applied_date == (created_at KST)::date`
7. 롤백: 버튼 가시성만 `btnDeduct` 로 되돌리면 V1 경로 즉시 복구 (원장 오기록은 `type='in'` 보정행으로 상쇄 — DELETE 금지)

### 1.6 테스트
- 실제 파일 `21637257_1771930430000.xlsx`(BZ, 149행, 병합 1,221) 로 파싱 회귀 테스트: V1 함수 결과와 새 공용 헬퍼 결과가 동일한지 콘솔 비교
- RPC 는 Supabase **브랜치**(또는 별도 테스트 balance 행)에서 중복/동시성/롤백 케이스 실행 후 운영 적용 (**Q10**)

---

## 2. 결정이 필요한 질문

아래 답을 받은 뒤 구현 시작. 각 항목에 제안(기본값)을 적었습니다.

### A. 이중 반영 / 외부 동기화 (가장 중요)
- **Q1.** 매일 00:00 에 `invoiceManager_transactions` → `ft_user_transactions` 로 복사하는 잡은 어느 프로젝트에 있고, 어떻게 중복을 막나요(source_ids 만?). 전환 후 앱은 (a) 원장만 기록하고 iM 기록 중단, (b) iM 도 계속 기록하되 동기화가 차감 행을 건너뛰게 수정, 중 어느 쪽인가요? — 제안: **(a)**. 단 iM 을 보는 다른 화면(월별 조회 등)이 있으면 (b).

### B. 잔액 기준
- **Q2.** `balance_snapshot` 은 (a) 원장 직전 행 snapshot 기준, (b) `ft_balances.balance` 기준 중 어느 것이 정본인가요? immong 은 두 값이 10만 위안 이상 차이납니다. — 제안: **(a)** 를 정본으로 하고, RPC 가 `ft_balances.balance` 도 같은 값으로 덮어써 캐시로 유지(**Q2-b**). 전환 전 immong ft_balances 1회 보정 동의 여부도 알려주세요.
- **Q2-c.** snapshot 을 소수 2자리로 반올림해도 되나요? (현재 동기화 행은 `-104362.86249999999207` 같은 부동소수 잔재가 있음)

### C. 필드 값
- **Q3.** `vender_name` 에 `ft_users.username`(sulon/immong/immongbr/hilili/moodbeige) 을 넣을까요, `vender_name`(설온/아이엠몽…) 을 넣을까요? — 제안: **username** (동기화 행과 통일).
- **Q5.** 앱 직접 기록의 `source_table` / `source_ids` 값은? — 제안: `'ft_orders'` / `[ft_orders.id]`. (대안: `'auto-1688-order'` / null)
- **Q6.** `order_no_1688` 에 엑셀 A열(订单编号) 고유값을 콤마로 넣을까요? 한 차감에 1688 주문이 여러 개(수십 개)일 수 있습니다. — 제안: **넣는다** (텍스트 길이 제한 없음).
- **Q7.** `other_fee` 는 0 으로 넣을까요, null 로 둘까요? (동기화 행은 null, 기존 RPC 행은 0) — 제안: **0**.

### D. hilili(HI/MB) 원장
- **Q4.** hilili 는 이월 행이 없고 08-26 이후 9건이 원장에 없습니다. (a) 다른 프로젝트에서 이월+백필 후 HI/MB 도 V2 전환, (b) HI/MB 는 당분간 V1 유지하고 immong 그룹만 V2 전환, 중 어느 쪽? — 제안: **(b) 로 시작**, 이월 준비되면 HI/MB 추가.

### E. 중복 / 재차감 정책
- **Q11.** 같은 order_code 로 다시 차감을 누르면 (a) 무조건 차단, (b) 금액이 다르면 "취소(in 보정행) + 재차감" 을 자동 생성, (c) confirm 후 추가 행 허용, 중 어느 것? — 제안: **(a)**. 수정은 관리 화면에서 보정행으로.
- **Q12.** 엑셀 AD열에 주문코드가 2개 이상 섞여 있으면(현재는 첫 코드만 사용) 차단할까요? — 제안: **차단**.

### F. 범위 / UI
- **Q9.** 버튼 구성: (a) 모든 그룹에서 `V2 차감` 만 노출, (b) 전환 기간 동안 `차감(구)`+`V2 차감` 둘 다 노출, 중 어느 것? — 제안: 전환 그룹은 **(a)**, 미전환 그룹(Q4 의 HI/MB)은 V1 만.
- **Q8.** `ft_orders` 가격 4필드(delivery_fee, total_item_price, service_fee, total_amount) UPDATE 를 계속 할까요? 그리고 차감 완료 시 `ft_orders.status` 를 바꿀까요(현재 전부 PROCESSING)? — 제안: **UPDATE 유지 + RPC 트랜잭션 안으로 이동**, status 는 변경 없음.
- **Q13.** 수수료 6% 는 유저/그룹별로 다를 가능성이 있나요? — 제안: 상수 유지, 필요하면 `ft_users` 칼럼으로 이동.

### G. 검증 / 테스트
- **Q10.** RPC 테스트를 Supabase 브랜치에서 할까요, 아니면 운영 DB 에 테스트용 balance 행을 만들어 할까요? — 제안: **브랜치**(비용 발생 시 알려드림).
- **Q14.** RLS 비활성(anon 전체 권한) 은 이번 범위에서 다룰까요? — 제안: 이번 범위 밖, 별도 작업.
