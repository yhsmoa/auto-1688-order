// ════════════════════════════════════════════════════════════
// deductParser — 1688 주문 내보내기 엑셀 → 차감 계산 (V1/V2 공용, 순수 함수)
//
//   · 브라우저(renderer.js, XLSX 전역)와 node 테스트(require) 양쪽에서 동작. DOM 접근 없음.
//   · 열 정의 (0-based):
//       A(0)  订单编号  1688 주문번호 (병합셀 — 주문 단위)
//       G(6)  运费      배송비
//       I(8)  实付款    실결제
//       U(20) 数量      수량
//       AD(29) 买家留言 "ORxx | ..." → 첫 토큰이 주문코드
//   · 병합셀: 값은 병합 시작 셀에서 읽고, 합산은 병합 첫 행에서만 (기존 V1 로직 그대로)
//   · 계산 (소수 2자리 반올림):
//       delivery_fee = ΣG
//       price        = ΣI − delivery_fee
//       service_fee  = price × SERVICE_FEE_RATE
//       amount       = delivery_fee + price + service_fee
//   · 검증: 주문코드 1개만 허용 / 현재 주문목록에 있어야 함 / 코드의 user_code 가 선택 유저와 일치
//           / 배송비·상품가 ≥ 0, 차감액 > 0, 수량 > 0  (원장 amount>=0 제약보다 먼저 명확한 메시지)
// ════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeductParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── 열 인덱스 / 수수료율 (매직넘버 금지) ──
  const COL = { A_ORDER_NO: 0, G_DELIVERY: 6, I_PAID: 8, U_QTY: 20, AD_MEMO: 29 };
  const SERVICE_FEE_RATE = 0.06;

  // ── 주문코드 형식: OR{user_code}{YYMMDD}-... (예: ORBZ260902-O23) ──
  const ORDER_CODE_RE = /^OR([A-Z]+)(\d{6})-/;

  const round2 = n => Math.round(n * 100) / 100;
  const toNum  = v => parseFloat(String(v).replace(/,/g, '')) || 0;
  const toInt  = v => parseInt(String(v).replace(/,/g, ''), 10) || 0;

  class DeductParseError extends Error {
    constructor(message) { super(message); this.name = 'DeductParseError'; }
  }

  // ── 병합셀: 현재 셀이 비어있으면 병합 시작 셀 값 ──
  function getMergedValue(rowIdx, colIdx, data, merges) {
    if (data[rowIdx] && data[rowIdx][colIdx] !== undefined && data[rowIdx][colIdx] !== '') {
      return data[rowIdx][colIdx];
    }
    for (const merge of merges) {
      if (rowIdx >= merge.s.r && rowIdx <= merge.e.r &&
          colIdx >= merge.s.c && colIdx <= merge.e.c) {
        if (data[merge.s.r] && data[merge.s.r][merge.s.c] !== undefined) {
          return data[merge.s.r][merge.s.c];
        }
      }
    }
    return '';
  }

  // ── 병합셀의 첫 행인지 (합산은 첫 행에서만) ──
  function isFirstRowOfMerge(rowIdx, colIdx, merges) {
    for (const merge of merges) {
      if (rowIdx >= merge.s.r && rowIdx <= merge.e.r &&
          colIdx >= merge.s.c && colIdx <= merge.e.c) {
        return rowIdx === merge.s.r;
      }
    }
    return true;
  }

  /**
   * 워크시트 → 차감 계산 결과
   * @param {object} worksheet   XLSX 워크시트
   * @param {object} XLSXLib     XLSX 라이브러리 (브라우저 전역 또는 require('xlsx'))
   * @param {object} opts
   * @param {Set<string>} opts.currentOrderCodes  현재 주문 목록의 주문코드 집합
   * @param {string}      opts.selectedUserCode   드롭박스 선택 유저의 user_code (빈 값이면 검사 생략)
   * @returns {{orderCode:string, orderNos1688:string[], delivery_fee:number, price:number,
   *            service_fee:number, amount:number, item_qty:number, rowCount:number}}
   * @throws {DeductParseError} 사용자에게 그대로 보여줄 메시지
   */
  function parseDeductWorksheet(worksheet, XLSXLib, opts) {
    const { currentOrderCodes, selectedUserCode } = opts || {};

    const jsonData = XLSXLib.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false });
    if (jsonData.length < 2) throw new DeductParseError('엑셀 파일에 데이터가 없습니다.');
    const merges = worksheet['!merges'] || [];

    if (!currentOrderCodes || currentOrderCodes.size === 0) {
      throw new DeductParseError('현재 주문 데이터에 주문코드(S열)가 없습니다.');
    }

    // ── AD열 주문코드 추출 + 현재 주문목록 대조 ──
    const excelOrderCodes = new Set();
    const mismatched = new Set();
    for (let i = 1; i < jsonData.length; i++) {
      const ad = getMergedValue(i, COL.AD_MEMO, jsonData, merges);
      if (!ad || !String(ad).trim()) continue;
      const code = String(ad).split('|')[0].trim();
      if (!code) continue;
      excelOrderCodes.add(code);
      if (!currentOrderCodes.has(code)) mismatched.add(code);
    }
    if (mismatched.size > 0) {
      throw new DeductParseError(
        `엑셀 파일을 확인해주세요.\n다른 주문코드(AD열)가 확인됩니다.\n\n불일치 코드: ${[...mismatched].join(', ')}`);
    }
    if (excelOrderCodes.size === 0) {
      throw new DeductParseError('엑셀 파일의 AD열에서 주문코드를 찾을 수 없습니다.');
    }
    if (excelOrderCodes.size > 1) {
      throw new DeductParseError(
        `엑셀에 주문코드가 ${excelOrderCodes.size}개 섞여 있습니다.\n한 번에 하나의 주문코드만 차감할 수 있습니다.\n\n${[...excelOrderCodes].join(', ')}`);
    }
    const orderCode = [...excelOrderCodes][0];

    // ── 주문코드 형식 + user_code 일치 ──
    const m = ORDER_CODE_RE.exec(orderCode);
    if (!m) throw new DeductParseError(`주문코드 형식이 올바르지 않습니다: ${orderCode}`);
    const codeUserCode = m[1];
    if (selectedUserCode && codeUserCode !== selectedUserCode) {
      throw new DeductParseError(
        `유저 코드가 일치하지 않습니다.\n\n엑셀 AD열: ${codeUserCode}\n선택된 유저: ${selectedUserCode}`);
    }

    // ── 합산 (G/I 는 병합 첫 행만, U 는 전 행, A 는 고유값) ──
    let delivery = 0, totalI = 0, qty = 0;
    const orderNos = new Set();
    for (let i = 1; i < jsonData.length; i++) {
      if (isFirstRowOfMerge(i, COL.G_DELIVERY, merges)) delivery += toNum(getMergedValue(i, COL.G_DELIVERY, jsonData, merges));
      if (isFirstRowOfMerge(i, COL.I_PAID,     merges)) totalI   += toNum(getMergedValue(i, COL.I_PAID,     jsonData, merges));
      qty += toInt(jsonData[i] && jsonData[i][COL.U_QTY]);
      const no = getMergedValue(i, COL.A_ORDER_NO, jsonData, merges);
      if (no && String(no).trim()) orderNos.add(String(no).trim());
    }

    const delivery_fee = round2(delivery);
    const price        = round2(totalI - delivery_fee);
    const service_fee  = round2(price * SERVICE_FEE_RATE);
    const amount       = round2(delivery_fee + price + service_fee);

    // ── 값 검증 ──
    if (delivery_fee < 0 || price < 0) {
      throw new DeductParseError(`계산값이 음수입니다. 엑셀 G열/I열을 확인해주세요.\n배송비 ${delivery_fee} / 상품가 ${price}`);
    }
    if (!(amount > 0)) throw new DeductParseError(`차감액이 0 이하입니다: ${amount}`);
    if (!(qty > 0))    throw new DeductParseError('수량(U열) 합계가 0입니다.');

    return {
      orderCode,
      orderNos1688: [...orderNos],
      delivery_fee, price, service_fee, amount,
      item_qty: qty,
      rowCount: jsonData.length - 1,
    };
  }

  return { parseDeductWorksheet, DeductParseError, SERVICE_FEE_RATE, COL, ORDER_CODE_RE,
           _internal: { getMergedValue, isFirstRowOfMerge, round2, toNum, toInt } };
});
