-- ============================================================
-- RPC: deduct_balance_and_record_transaction
-- 1) ft_balances.balance 차감
-- 2) ft_user_transactions INSERT
-- 원자적 트랜잭션으로 처리 (balance 마이너스 허용)
-- ============================================================
CREATE OR REPLACE FUNCTION public.deduct_balance_and_record_transaction(
  p_balance_id    UUID,
  p_user_id       UUID,
  p_vender_name   TEXT,
  p_amount        NUMERIC,
  p_qty           INTEGER  DEFAULT 0,
  p_item_amount   NUMERIC  DEFAULT 0,
  p_shipping_fee  NUMERIC  DEFAULT 0,
  p_service_fee   NUMERIC  DEFAULT 0,
  p_other_fee     NUMERIC  DEFAULT 0,
  p_description   TEXT     DEFAULT '',
  p_reference_id  TEXT     DEFAULT NULL,
  p_order_no_1688 TEXT     DEFAULT NULL,
  p_admin_note    TEXT     DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_balance NUMERIC;
  v_tx_id       UUID;
BEGIN
  -- ── Section 1: ft_balances 잔액 차감 ──
  UPDATE ft_balances
  SET balance    = balance - p_amount,
      updated_at = NOW()
  WHERE id = p_balance_id
  RETURNING balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance_id(%) not found', p_balance_id;
  END IF;

  -- ── Section 2: ft_user_transactions 거래 기록 생성 ──
  INSERT INTO ft_user_transactions (
    balance_id, user_id, vender_name,
    type, category, amount, balance_snapshot,
    qty, item_amount, shipping_fee, service_fee, other_fee,
    description, reference_id, order_no_1688, admin_note
  ) VALUES (
    p_balance_id, p_user_id, p_vender_name,
    'out', '구매', p_amount, v_new_balance,
    p_qty, p_item_amount, p_shipping_fee, p_service_fee, p_other_fee,
    p_description, p_reference_id, p_order_no_1688, p_admin_note
  )
  RETURNING id INTO v_tx_id;

  -- ── Section 3: 결과 반환 ──
  RETURN json_build_object(
    'transaction_id', v_tx_id,
    'new_balance',    v_new_balance,
    'amount_deducted', p_amount
  );
END;
$$;
