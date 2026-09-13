-- ============================================================
-- RPC v2: deduct_balance_and_record_transaction_v2
--
-- 신 원장(ft_user_transactions)이 잔액의 **유일한** 정본이다. 대체재 없음.
--   1) 입력 검증: amount > 0, reference_id(주문코드) 필수, user 가 balance 그룹 소속인지
--   2) balance 단위 advisory lock — 두 PC 동시 차감 직렬화
--   3) reference_id 중복 차단 — 같은 주문코드 재차감 불가 (부분 유니크 인덱스로 이중 보호)
--   4) 원장 전환 여부 검사 — 이월 행(category='이월')이 없는 그룹은 **즉시 예외로 중단**
--      (ft_balances 등 다른 값으로 대신 계산하지 않는다)
--   5) 직전 스냅샷 = 원장 마지막 행 (없으면 예외)
--   6) 원장 INSERT — 신설 컬럼(applied_date=KST 오늘, source_table/ids, master_account, user_code) 포함
--   7) ft_balances 를 같은 값으로 갱신 — 캐시일 뿐, 기준값으로 읽지 않는다
--   8) ft_orders 가격 4필드 UPDATE — 같은 트랜잭션
-- 어느 단계든 실패하면 전부 롤백. 호출 측(앱)은 예외를 받으면 즉시 alert 하고 멈춘다.
--
-- 기존 v1(deduct_balance_and_record_transaction) 은 그대로 둔다 (호출자 없음 확인).
-- ============================================================
CREATE OR REPLACE FUNCTION public.deduct_balance_and_record_transaction_v2(
  p_balance_id     uuid,
  p_user_id        uuid,
  p_vender_name    text,
  p_amount         numeric,
  p_qty            integer DEFAULT 0,
  p_item_amount    numeric DEFAULT 0,
  p_shipping_fee   numeric DEFAULT 0,
  p_service_fee    numeric DEFAULT 0,
  p_other_fee      numeric DEFAULT 0,
  p_description    text    DEFAULT '',
  p_reference_id   text    DEFAULT NULL,
  p_order_no_1688  text    DEFAULT NULL,
  p_admin_note     text    DEFAULT NULL,
  p_master_account text    DEFAULT NULL,
  p_user_code      text    DEFAULT NULL,
  p_order_id       uuid    DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev    numeric;
  v_new     numeric;
  v_tx_id   uuid;
  v_applied date;
BEGIN
  -- ── 1) 입력 검증 ──
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid amount: %', p_amount USING ERRCODE = 'check_violation';
  END IF;
  IF p_reference_id IS NULL OR btrim(p_reference_id) = '' THEN
    RAISE EXCEPTION 'reference_id (order_code) is required';
  END IF;
  IF p_vender_name IS NULL OR btrim(p_vender_name) = '' THEN
    RAISE EXCEPTION 'vender_name is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ft_users WHERE id = p_user_id AND balance_id = p_balance_id) THEN
    RAISE EXCEPTION 'user % does not belong to balance %', p_user_id, p_balance_id;
  END IF;

  -- ── 2) balance 단위 직렬화 ──
  PERFORM pg_advisory_xact_lock(hashtext(p_balance_id::text));

  -- ── 3) 주문코드 중복 차단 ──
  IF EXISTS (
    SELECT 1 FROM ft_user_transactions
    WHERE balance_id = p_balance_id AND type = 'out' AND category = '구매'
      AND reference_id = p_reference_id
  ) THEN
    RAISE EXCEPTION 'duplicate deduction for reference_id %', p_reference_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- ── 4) 원장 전환 여부 — 이월 행 없으면 중단 (대체 계산 금지) ──
  IF NOT EXISTS (
    SELECT 1 FROM ft_user_transactions WHERE balance_id = p_balance_id AND category = '이월'
  ) THEN
    RAISE EXCEPTION 'ledger not initialized for balance % (no opening row)', p_balance_id;
  END IF;

  -- ── 5) 직전 스냅샷 — 원장에서만 ──
  SELECT balance_snapshot INTO v_prev
  FROM ft_user_transactions
  WHERE balance_id = p_balance_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION 'ledger has no snapshot for balance %', p_balance_id;
  END IF;

  v_new     := round(v_prev - p_amount, 2);
  v_applied := (now() AT TIME ZONE 'Asia/Seoul')::date;

  -- ── 6) 원장 INSERT ──
  INSERT INTO ft_user_transactions (
    balance_id, user_id, vender_name, type, category, amount, balance_snapshot,
    qty, item_amount, shipping_fee, service_fee, other_fee,
    description, reference_id, order_no_1688, admin_note,
    applied_date, source_table, source_ids, master_account, user_code
  ) VALUES (
    p_balance_id, p_user_id, p_vender_name, 'out', '구매', round(p_amount, 2), v_new,
    p_qty, p_item_amount, p_shipping_fee, p_service_fee, coalesce(p_other_fee, 0),
    p_description, p_reference_id, p_order_no_1688, p_admin_note,
    v_applied, 'ft_orders',
    CASE WHEN p_order_id IS NULL THEN NULL ELSE ARRAY[p_order_id] END,
    p_master_account, p_user_code
  )
  RETURNING id INTO v_tx_id;

  -- ── 7) ft_balances 캐시 갱신 (기준값 아님) ──
  UPDATE ft_balances SET balance = v_new, updated_at = now() WHERE id = p_balance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance_id(%) not found in ft_balances', p_balance_id;
  END IF;

  -- ── 8) ft_orders 가격 4필드 (같은 트랜잭션) ──
  IF p_order_id IS NOT NULL THEN
    UPDATE ft_orders
    SET delivery_fee     = p_shipping_fee,
        total_item_price = p_item_amount,
        service_fee      = p_service_fee,
        total_amount     = round(p_amount, 2)
    WHERE id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ft_orders(%) not found', p_order_id;
    END IF;
  END IF;

  RETURN json_build_object(
    'transaction_id', v_tx_id,
    'prev_balance',   v_prev,
    'new_balance',    v_new,
    'amount',         round(p_amount, 2),
    'applied_date',   v_applied
  );
END;
$$;
