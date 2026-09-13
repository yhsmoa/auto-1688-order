-- ============================================================
-- ft_user_transactions 인덱스
--
--   · ux_ft_user_tx_purchase_ref : 같은 balance 에서 같은 주문코드(reference_id)로
--                                  구매 차감이 두 번 들어가지 못하게 하는 부분 유니크 인덱스.
--                                  RPC v2 의 중복 검사와 이중 보호. (적용 전 중복 0건 확인)
--   · ix_ft_user_tx_balance_created : 원장 조회·직전 스냅샷 조회 (balance_id, created_at, id) 순.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_ft_user_tx_purchase_ref
  ON ft_user_transactions (balance_id, reference_id)
  WHERE type = 'out' AND category = '구매' AND reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ft_user_tx_balance_created
  ON ft_user_transactions (balance_id, created_at, id);
