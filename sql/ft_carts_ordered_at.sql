-- ============================================================
-- ft_carts.ordered_at — 웹에서 [주문]이 눌린 시각 (2026-11-03)
--
-- 왜: ft_carts.created_at 은 카트를 '처음 만든' 시각이라, 고객이 며칠 뒤 [주문]을 누르면
--     V2 [장바구니 불러오기] 드롭박스에 지난 날짜로 나타났다 (주문을 다 넣었는데 지난 날짜 카트가 생기는 문제).
--
-- 규칙 (트리거 — 웹 코드 수정 없이 모든 경로에 적용):
--   · status 가 'ORDER' 로 바뀌는 순간 (INSERT 포함: split_cart_and_order 의 '-2' 카트) → ordered_at = now()
--   · 'NEW' 로 되돌아가면 (반려) → ordered_at = NULL (다시 [주문]하면 새 시각)
--   · 'DONE' 등 그 밖의 전환은 값 유지
--
-- 기존 'ORDER' 카트 백필: 정확한 시각을 알 수 없어 '가장 이른 가능 시각' 으로 추정
--   = greatest(카트 생성, 마지막 상품 추가). NEW 카트에만 상품을 넣을 수 있으므로 [주문]은 그 뒤.
-- ============================================================
ALTER TABLE public.ft_carts ADD COLUMN IF NOT EXISTS ordered_at timestamptz;

CREATE OR REPLACE FUNCTION public.ft_carts_set_ordered_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ORDER' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'ORDER') THEN
    NEW.ordered_at := now();
  ELSIF NEW.status = 'NEW' THEN
    NEW.ordered_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ft_carts_ordered_at ON public.ft_carts;
CREATE TRIGGER trg_ft_carts_ordered_at
  BEFORE INSERT OR UPDATE OF status ON public.ft_carts
  FOR EACH ROW EXECUTE FUNCTION public.ft_carts_set_ordered_at();

UPDATE public.ft_carts c
SET ordered_at = greatest(c.created_at, coalesce((SELECT max(i.created_at) FROM public.ft_cart_items i WHERE i.cart_id = c.id), c.created_at))
WHERE c.status = 'ORDER' AND c.ordered_at IS NULL;
