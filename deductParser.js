// ════════════════════════════════════════════════════════════
// deductParser — 1688 주문 내보내기 엑셀 → 차감 계산 (순수 함수)
//
//   · 브라우저(renderer.js, XLSX 전역)와 node 테스트(require) 양쪽에서 동작. DOM 접근 없음.
//   · 열 정의 (0-based):
//       A(0)  订单编号  1688 주문번호 (병합셀 — 1688 주문 단위)
//       G(6)  运费      배송비        (병합셀 — 1688 주문 단위)
//       I(8)  实付款    실결제        (병합셀 — 1688 주문 단위)
//       U(20) 数量      수량          (상품 행 단위)
//       Y(24) Offer ID               (상품 행 단위)
//       AD(29) 买家留言 메모          (병합셀 — 1688 주문 단위, 여러 줄 가능: "ORxx | 날짜 | 품번:수량")
//
//   · 2026-10-25 분류 규칙 (여러 주문건이 섞인 엑셀 대응):
//       엑셀을 1688 주문(A열 병합 그룹) 단위로 나누고, 그룹의 AD 전체 텍스트에서 주문코드를 모두 추출한다.
//         코드 집합 == {대상}         → 포함 (합산)
//         대상 없음 (다른 코드만)      → 제외, 코드별 건수 집계
//         비어 있음 (메모 없음)        → 제외, 건수 집계
//         대상 + 다른 코드 (혼합)      → 중단 (실결제·운임이 1688 주문 단위라 코드별로 나눌 수 없음)
//       대상 코드 = 현재 주문목록의 주문코드. 목록에 코드가 여러 개면 엑셀에 등장하는 것으로 좁히고,
//       그래도 1개로 정해지지 않으면 중단.
//   · 교차검증 (경고만, 차단 아님):
//       ② 주문번호 등록 단계의 1688 주문번호 집합 vs 포함된 A열 집합
//       ③ 포함 그룹의 Y열 Offer ID 가 현재 주문목록의 offer_id 집합에 속하는지
//   · 계산 (소수 2자리 반올림, 포함 그룹에 한정):
//       delivery_fee = ΣG (병합 첫 행만)   price = ΣI (병합 첫 행만) − delivery_fee
//       service_fee  = price × SERVICE_FEE_RATE   amount = delivery_fee + price + service_fee
//   · 검증: 대상 코드의 user_code 가 선택 유저와 일치 / 배송비·상품가 ≥ 0, 차감액 > 0, 수량 > 0
// ════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeductParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── 열 인덱스 / 수수료율 (매직넘버 금지) ──
  const COL = { A_ORDER_NO: 0, G_DELIVERY: 6, I_PAID: 8, U_QTY: 20, Y_OFFER_ID: 24, AD_MEMO: 29 };
  const SERVICE_FEE_RATE = 0.06;

  // ── 주문코드 형식: OR{user_code}{YYMMDD}-{시간알파벳}{분2자리}[_난수]  (예: ORBZ260902-O23) ──
  const ORDER_CODE_RE   = /^OR([A-Z]+)(\d{6})-/;                 // 선두 검사 + user_code 추출
  const CODE_SCAN_RE    = /OR[A-Z]{2,}\d{6}-[A-Z]\d{2}(?:_\d+)?/g; // 메모 텍스트 전체에서 코드 전부 추출

  const round2 = n => Math.round(n * 100) / 100;
  const toNum  = v => parseFloat(String(v).replace(/,/g, '')) || 0;
  const toInt  = v => parseInt(String(v).replace(/,/g, ''), 10) || 0;
  const str    = v => (v === undefined || v === null) ? '' : String(v).trim();

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

  // ── 메모 텍스트에서 주문코드 전부 추출 (중복 제거, 등장 순) ──
  //   정규식에 하나도 안 걸리면 구형 표기("ORBZ251031A01 | ...") 대비로 첫 '|' 토큰이 OR 로 시작하면 채택
  function extractCodes(text) {
    const t = str(text);
    if (!t) return [];
    const found = t.match(CODE_SCAN_RE) || [];
    if (found.length === 0) {
      const first = t.split('|')[0].trim();
      if (/^OR[A-Z]+\d{6}/.test(first)) found.push(first);
    }
    return [...new Set(found)];
  }

  // ── 행을 1688 주문 그룹으로 묶는다 (A열 병합값 기준, 등장 순) ──
  //   A 가 비어 있고 병합도 아닌 행은 직전 그룹에 붙인다 (내보내기 형식 방어).
  function groupBy1688Order(jsonData, merges) {
    const groups = [];
    const byNo = new Map();
    let last = null;
    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.every(c => c === '' || c === undefined || c === null)) continue;
      let no = str(getMergedValue(i, COL.A_ORDER_NO, jsonData, merges));
      if (!no && last) no = last.orderNo1688;
      if (!no) no = `(row ${i + 1})`;
      let g = byNo.get(no);
      if (!g) {
        g = { orderNo1688: no, rowIdx: [], memo: '', codes: [], offerIds: new Set() };
        byNo.set(no, g); groups.push(g);
      }
      g.rowIdx.push(i);
      const memo = str(getMergedValue(i, COL.AD_MEMO, jsonData, merges));
      if (memo && !g.memo.includes(memo)) g.memo = g.memo ? `${g.memo}\n${memo}` : memo;
      const offer = str(row[COL.Y_OFFER_ID]);
      if (offer) g.offerIds.add(offer);
      last = g;
    }
    groups.forEach(g => { g.codes = extractCodes(g.memo); });
    return groups;
  }

  /**
   * 워크시트 → 차감 계산 결과
   * @param {object} worksheet   XLSX 워크시트
   * @param {object} XLSXLib     XLSX 라이브러리 (브라우저 전역 또는 require('xlsx'))
   * @param {object} opts
   * @param {Set<string>} opts.currentOrderCodes    현재 주문 목록의 주문코드 집합 (대상 코드 결정)
   * @param {string}      opts.selectedUserCode     드롭박스 선택 유저의 user_code (빈 값이면 검사 생략)
   * @param {Set<string>} [opts.session1688OrderIds] 주문번호 등록 단계의 1688 주문번호 집합 (교차검증 ②, 없으면 생략)
   * @param {Set<string>} [opts.sessionOfferIds]     현재 주문목록의 offer_id 집합 (교차검증 ③, 없으면 생략)
   * @returns {{
   *   orderCode:string, orderNos1688:string[], delivery_fee:number, price:number, service_fee:number, amount:number,
   *   item_qty:number, rowCount:number,
   *   included:{orders:number, rows:number},
   *   excluded:{byCode:Object<string,number>, noMemo:number, orders:number, rows:number},
   *   crossCheck:{checked1688:boolean, missingInExcel:string[], notInSession:string[], checkedOffer:boolean, unknownOffers:string[]},
   *   warnings:string[]
   * }}
   * @throws {DeductParseError} 사용자에게 그대로 보여줄 메시지
   */
  function parseDeductWorksheet(worksheet, XLSXLib, opts) {
    const { currentOrderCodes, selectedUserCode, session1688OrderIds, sessionOfferIds } = opts || {};

    const jsonData = XLSXLib.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false });
    if (jsonData.length < 2) throw new DeductParseError('엑셀 파일에 데이터가 없습니다.');
    const merges = worksheet['!merges'] || [];

    if (!currentOrderCodes || currentOrderCodes.size === 0) {
      throw new DeductParseError('현재 주문 데이터에 주문코드(S열)가 없습니다.');
    }

    // ── 1688 주문 단위 그룹 ──
    const groups = groupBy1688Order(jsonData, merges);
    if (groups.length === 0) throw new DeductParseError('엑셀에서 1688 주문 행을 찾을 수 없습니다.');

    const excelCodes = new Set();
    groups.forEach(g => g.codes.forEach(c => excelCodes.add(c)));
    if (excelCodes.size === 0) {
      throw new DeductParseError('엑셀 AD열(买家留言)에서 주문코드를 하나도 찾을 수 없습니다.\n참조코드가 입력된 주문 내보내기 파일인지 확인해주세요.');
    }

    // ── 대상 코드 결정 ──
    let targets = [...currentOrderCodes];
    if (targets.length > 1) targets = targets.filter(c => excelCodes.has(c));
    if (targets.length === 0) {
      throw new DeductParseError(
        `엑셀에 현재 주문코드가 없습니다.\n\n현재 주문: ${[...currentOrderCodes].join(', ')}\n엑셀 코드: ${[...excelCodes].join(', ')}`);
    }
    if (targets.length > 1) {
      throw new DeductParseError(
        `현재 주문목록의 주문코드가 ${targets.length}개 엑셀에 함께 있어 대상을 정할 수 없습니다.\n하나의 주문만 불러온 상태에서 차감하세요.\n\n${targets.join(', ')}`);
    }
    const orderCode = targets[0];

    // ── 주문코드 형식 + user_code 일치 ──
    const m = ORDER_CODE_RE.exec(orderCode);
    if (!m) throw new DeductParseError(`주문코드 형식이 올바르지 않습니다: ${orderCode}`);
    const codeUserCode = m[1];
    if (selectedUserCode && codeUserCode !== selectedUserCode) {
      throw new DeductParseError(
        `유저 코드가 일치하지 않습니다.\n\n주문코드: ${codeUserCode}\n선택된 유저: ${selectedUserCode}`);
    }

    // ── 분류 ──
    const included = [];
    const excluded = { byCode: {}, noMemo: 0, orders: 0, rows: 0 };
    const mixed = [];
    for (const g of groups) {
      const hasTarget = g.codes.includes(orderCode);
      const others = g.codes.filter(c => c !== orderCode);
      if (hasTarget && others.length === 0) { included.push(g); continue; }
      if (hasTarget && others.length > 0) { mixed.push(g); continue; }
      excluded.orders++; excluded.rows += g.rowIdx.length;
      if (g.codes.length === 0) excluded.noMemo++;
      else others.forEach(c => { excluded.byCode[c] = (excluded.byCode[c] || 0) + 1; });
    }
    if (mixed.length > 0) {
      const list = mixed.map(g => `  · ${g.orderNo1688}: ${g.codes.join(', ')}`).join('\n');
      throw new DeductParseError(
        `한 1688 주문에 현재 주문코드와 다른 주문코드가 함께 들어 있어 차감을 중단합니다.\n` +
        `(실결제·운임이 1688 주문 단위라 코드별로 정확히 나눌 수 없습니다)\n\n${list}\n\n` +
        `해당 1688 주문은 별도로 정리한 뒤 다시 시도하세요.`);
    }
    if (included.length === 0) {
      throw new DeductParseError(
        `현재 주문코드(${orderCode})에 해당하는 1688 주문이 엑셀에 없습니다.\n` +
        `제외: 다른 주문코드 ${Object.values(excluded.byCode).reduce((a, b) => a + b, 0)}건, 메모 없음 ${excluded.noMemo}건`);
    }

    // ── 합산 (포함 그룹에 한정; G/I 는 병합 첫 행만, U 는 전 행, A 는 고유값) ──
    let delivery = 0, totalI = 0, qty = 0, rows = 0;
    const orderNos = [];
    const includedOffers = new Set();
    for (const g of included) {
      orderNos.push(g.orderNo1688);
      g.offerIds.forEach(o => includedOffers.add(o));
      for (const i of g.rowIdx) {
        rows++;
        if (isFirstRowOfMerge(i, COL.G_DELIVERY, merges)) delivery += toNum(getMergedValue(i, COL.G_DELIVERY, jsonData, merges));
        if (isFirstRowOfMerge(i, COL.I_PAID,     merges)) totalI   += toNum(getMergedValue(i, COL.I_PAID,     jsonData, merges));
        qty += toInt(jsonData[i] && jsonData[i][COL.U_QTY]);
      }
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

    // ── 교차검증 (경고만) ──
    const warnings = [];
    const crossCheck = { checked1688: false, missingInExcel: [], notInSession: [], checkedOffer: false, unknownOffers: [] };
    if (session1688OrderIds && session1688OrderIds.size > 0) {
      crossCheck.checked1688 = true;
      const inc = new Set(orderNos);
      crossCheck.missingInExcel = [...session1688OrderIds].filter(n => !inc.has(n));
      crossCheck.notInSession   = orderNos.filter(n => !session1688OrderIds.has(n));
      if (crossCheck.missingInExcel.length) warnings.push(`주문목록에 등록된 1688 주문번호 중 엑셀에 없는 것 ${crossCheck.missingInExcel.length}건 (차감 누락 가능)`);
      if (crossCheck.notInSession.length)   warnings.push(`엑셀에 포함됐지만 주문목록에 등록되지 않은 1688 주문번호 ${crossCheck.notInSession.length}건`);
    }
    if (sessionOfferIds && sessionOfferIds.size > 0) {
      crossCheck.checkedOffer = true;
      crossCheck.unknownOffers = [...includedOffers].filter(o => !sessionOfferIds.has(o));
      if (crossCheck.unknownOffers.length) warnings.push(`포함된 1688 주문의 상품(Offer ID) 중 주문목록에 없는 것 ${crossCheck.unknownOffers.length}개`);
    }

    return {
      orderCode,
      orderNos1688: orderNos,
      delivery_fee, price, service_fee, amount,
      item_qty: qty,
      rowCount: jsonData.length - 1,
      included: { orders: included.length, rows },
      excluded,
      crossCheck,
      warnings,
    };
  }

  return { parseDeductWorksheet, DeductParseError, SERVICE_FEE_RATE, COL, ORDER_CODE_RE, CODE_SCAN_RE,
           _internal: { getMergedValue, isFirstRowOfMerge, round2, toNum, toInt, extractCodes, groupBy1688Order } };
});
