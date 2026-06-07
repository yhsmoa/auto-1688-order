# 카트 → 주문 컬럼 매핑 가이드

장바구니의 **[주문]** 버튼 클릭 시, Supabase 의 어떤 컬럼이 어떻게 이동·매핑되는지 정리.

- 소스 코드: [`app/progress/cart/services/orderConvertService.ts`](../app/progress/cart/services/orderConvertService.ts)
- 트리거: [`useCartManagement.convertToOrder`](../app/progress/cart/hooks/useCartManagement.ts)

---

## 1. `ft_carts` → `ft_orders` (주문 헤더 1행)

| ft_orders 컬럼 | 출처 | 값 |
|---|---|---|
| `id` | 신규 UUID 생성 | `crypto.randomUUID()` |
| `created_at` | DB default | `now()` |
| `order_no` | 계산 | `'OR' + ft_users.user_code + 'YYMMDD' + '-' + HourLetter + mm` (KST 기준, 0시=A) |
| `user_id` | ft_users.id | 로그인 사용자 |
| `recipient_name` | ft_users.full_name | 그대로 |
| `recipient_phone` | ft_users.phone | 그대로 |
| `recipient_address` | ft_users.address | 그대로 |
| `status` | 고정값 | `'NEW'` |
| `total_amount` | — | **null (비움)** |
| `total_qty` | — | **null (비움)** |
| `delivery_fee` | — | **null (비움)** |
| `service_fee` | — | **null (비움)** |
| `extra_fee` | — | **null (비움)** |
| `total_item_price` | — | **null (비움)** |

> `ft_carts.id` 와 `ft_orders.id` 는 **무관** — 새 UUID 발급. 카트 메타는 변환 후 DELETE 됨.

---

## 2. `ft_cart_items` → `ft_order_items`

행마다 1:1 매핑. 단 세트 그룹(같은 `cart_seq`)은 `product_no` / `product_id` 를 공유.

| ft_order_items 컬럼 | 출처 | 값 |
|---|---|---|
| `id` | DB default | `gen_random_uuid()` |
| `created_at` | DB default | `now()` |
| `order_id` | Phase 1 생성 | 해당 ft_orders.id |
| `order_no` | Phase 1 생성 | 해당 ft_orders.order_no |
| `user_id` | ft_users.id | 로그인 사용자 |
| `status` | 고정값 | `'NEW'` |
| `item_seq` | 계산 | 1, 2, 3, … (전체 순서) |
| `item_no` | 계산 | `product_no + '-' + suffix` (suffix: `A01` 또는 `S{set_total}{set_seq}`) |
| `product_no` | 계산 | `user_code + '-' + YYMMDD + NNNN` (cart_seq 그룹마다 새 NNNN) |
| `product_id` | 신규 UUID | cart_seq 그룹 내 동일 UUID 공유 |
| `requested_date` | 클릭 시점 today (KST) | `YYYY-MM-DD` |
| `item_name` | ft_cart_items.item_name | 그대로 |
| `option_name` | ft_cart_items.option_name | 그대로 |
| `order_qty` | ft_cart_items.order_qty | 그대로 |
| `barcode` | ft_cart_items.barcode | 그대로 |
| `china_option1` | ft_cart_items.china_option1 | 그대로 |
| `china_option2` | ft_cart_items.china_option2 | 그대로 |
| `price_cny` | ft_cart_items.price_cny | 그대로 |
| `price_total_cny` | ft_cart_items.price_total_cny | 그대로 |
| `img_url` | ft_cart_items.img_url | 그대로 |
| `site_url` | ft_cart_items.site_url | 그대로 |
| `shipment_type` | ft_cart_items.shipment_type | 그대로 |
| `vendor_option_id` | ft_cart_items.vendor_option_id | 그대로 |
| `coupang_shipment_size` | ft_cart_items.coupang_shipment_size | 그대로 |
| `composition` | ft_cart_items.composition | 그대로 |
| `recommanded_age` | ft_cart_items.recommanded_age | 그대로 |
| `set_total` | ft_cart_items.set_total | 그대로 |
| `set_seq` | ft_cart_items.set_seq | 그대로 |
| `note_kr` | ft_cart_items.note_kr | 그대로 |
| **`note_notice`** | ft_cart_items.**`req_note`** | **이름 매핑 (req_note → note_notice)** |
| `shipped_qty` | — | **null (비움)** |
| `cancel_qty` | — | **null (비움)** |
| `arrival_qty` | — | **null (비움)** |
| `price_krw` | — | **null (비움)** |
| `price_total_krw` | — | **null (비움)** |
| `price_delivery_cny` | — | **null (비움)** |
| `price_delivery_kr` | — | **null (비움)** |
| `check_img` | — | **null (비움)** |
| `kc` | — | **null (비움)** |
| `kc_type` | — | **null (비움)** |
| `note_cn` | — | **null (비움)** |
| `customs_category` | — | **null (비움)** |
| `personal_order_no` | — | **null (비움)** ※ ft_cart_items 에는 있지만 주문엔 안 넣음 |
| `1688_offer_id` | — | **null (비움)** |
| `1688_order_id` | — | **null (비움)** |

### ft_cart_items 의 컬럼 중 ft_order_items 로 **이관 안 되는 것** (운영/메타 컬럼)

- `cart_id`, `cart_name` — 카트 단위 메타 (주문엔 무의미)
- `temp_seq` — 카트 임시 시퀀스
- `cart_seq` — 카트 정렬 키 (단, **세트 그룹 식별용으로 사용된 후 폐기**)
- `status` — 카트의 `'new'` 는 무시. 주문은 항상 `'NEW'` 로 시작.
- `price_krw`, `price_total_krw` — 주문에서 비워둠
- `check_img`, `kc`, `kc_type` — 주문에서 비워둠
- `personal_order_no` — 주문에서 비워둠

---

## 3. 변환 후 카트 삭제

INSERT 가 모두 성공한 뒤에만 실행. 실패 시 카트는 유지(재시도 가능).

| 순서 | 작업 |
|---|---|
| 1 | `DELETE FROM ft_cart_items WHERE cart_id = ? AND user_id = ?` |
| 2 | `DELETE FROM ft_carts WHERE id = ? AND user_id = ?` |

→ 카트는 흔적 없이 사라지고, 주문 테이블에만 데이터가 남습니다.

---

## 4. 키 생성 규칙 요약

### `order_no`
```
OR  +  user_code  +  YYMMDD  +  '-'  +  HourLetter  +  mm
```
- `HourLetter`: 0시=A, 1시=B, …, 23시=X (24글자)
- 예: 2026-06-07 14:30 KST, user_code=BZ → `ORBZ260607-O30`

### `product_no`
```
user_code  +  '-'  +  YYMMDD  +  NNNN
```
- `NNNN`: 같은 `user_code-YYMMDD` prefix 의 `ft_order_items.item_no` 4자리 max + 1 부터
- cart_seq 그룹마다 새 NNNN (= 같은 세트는 같은 NNNN)
- 예: `BZ-260607-0245`

### `item_no`
```
product_no  +  '-'  +  suffix
```
- 단건 (`set_total ≤ 1`): suffix = `A01`
- 세트 (`set_total > 1`): suffix = `S{set_total}{set_seq}` (예: 3/2 → `S32`)
- 예: `BZ-260607-0245-A01`, `BZ-260607-0245-S31`

### `product_id`
- cart_seq 그룹마다 1개의 UUID 생성 → 그룹 내 모든 행이 공유
- 단품은 그룹이 1행이므로 각 단품마다 별도 UUID
