// deductParser 테스트 — node test/deductParser.test.js
//  1) 회귀: 샘플 엑셀(단일 주문코드) 결과가 이전 파서와 동일
//  2) 합성: 여러 1688 주문이 섞인 시트에서 대상 코드만 합산 / 제외 집계 / 혼합 중단 / 교차검증 경고
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const P = require('../deductParser.js');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

// ── 1) 회귀 테스트 (이전 파서가 있을 때만) ──
const sample = path.join(__dirname, '..', '21637257_1771930430000.xlsx');
const oldParserPath = process.env.OLD_PARSER; // git show HEAD~1:deductParser.js > /tmp/old.js 로 추출해 전달
if (fs.existsSync(sample)) {
  const ws = XLSX.readFile(sample).Sheets['sheet1'];
  const cur = P.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set(['ORBZ260224-S11']), selectedUserCode: 'BZ' });
  console.log('sample →', { amount: cur.amount, price: cur.price, delivery: cur.delivery_fee, qty: cur.item_qty, orders1688: cur.orderNos1688.length, included: cur.included, excluded: cur.excluded });
  ok(cur.included.orders === 95 && cur.excluded.orders === 0, 'sample: 95개 1688 주문 전부 포함, 제외 0');
  if (oldParserPath && fs.existsSync(oldParserPath)) {
    const OLD = require(oldParserPath);
    const prev = OLD.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set(['ORBZ260224-S11']), selectedUserCode: 'BZ' });
    ok(near(prev.amount, cur.amount) && near(prev.price, cur.price) && near(prev.delivery_fee, cur.delivery_fee) && prev.item_qty === cur.item_qty,
       `sample: 이전 파서와 금액·수량 동일 (amount ${prev.amount} vs ${cur.amount})`);
    ok(prev.orderNos1688.length === cur.orderNos1688.length, 'sample: 1688 주문번호 수 동일');
  } else {
    console.log('(skip) OLD_PARSER 미지정 — 이전 파서 비교 생략');
  }
} else {
  console.log('(skip) 샘플 엑셀 없음');
}

// ── 2) 합성 시트 ──
// 1688 주문 하나 = n행. A/G/I/AD 는 첫 행에 값 + 병합, U/Y 는 행마다.
function buildSheet(orders) {
  const header = []; for (let c = 0; c <= 30; c++) header.push(`c${c}`);
  header[0] = '订单编号'; header[6] = '运费(元)'; header[8] = '实付款(元)'; header[20] = '数量'; header[24] = 'Offer ID'; header[29] = '买家留言';
  const rows = [header]; const merges = [];
  for (const o of orders) {
    const start = rows.length;
    o.items.forEach((it, k) => {
      const r = new Array(31).fill('');
      if (k === 0) { r[0] = o.no; r[6] = o.fee; r[8] = o.paid; r[29] = o.memo; }
      r[20] = it.qty; r[24] = it.offer;
      rows.push(r);
    });
    const end = rows.length - 1;
    if (end > start) [0, 6, 8, 29].forEach(c => merges.push({ s: { r: start, c }, e: { r: end, c } }));
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  return ws;
}
const T = 'ORBO261025-Q45', OTHER = 'ORBO261022-O56';
const memo = (code, items) => `${code} | BO-261025 | ${items}`;

// (a) 대상 2건 + 다른 코드 1건 + 메모 없음 1건
let ws = buildSheet([
  { no: '1001', fee: 10, paid: 110, memo: memo(T, '0001-A01:2'),            items: [{ qty: 2, offer: '111' }] },
  { no: '1002', fee: 5,  paid: 55,  memo: memo(T, '0002-A01:1, 0003-A01:1'), items: [{ qty: 1, offer: '222' }, { qty: 1, offer: '333' }] },
  { no: '2001', fee: 7,  paid: 77,  memo: memo(OTHER, '0009-A01:3'),        items: [{ qty: 3, offer: '999' }] },
  { no: '3001', fee: 3,  paid: 33,  memo: '',                               items: [{ qty: 4, offer: '444' }] },
]);
let r = P.parseDeductWorksheet(ws, XLSX, {
  currentOrderCodes: new Set([T]), selectedUserCode: 'BO',
  session1688OrderIds: new Set(['1001', '1002', '1003']), sessionOfferIds: new Set(['111', '222']),
});
ok(r.orderCode === T, '(a) 대상 코드 결정');
ok(near(r.delivery_fee, 15) && near(r.price, 150) && near(r.service_fee, 9) && near(r.amount, 174) && r.item_qty === 4, `(a) 대상만 합산: fee 15 / price 150 / svc 9 / amount 174 / qty 4 → ${r.delivery_fee}/${r.price}/${r.service_fee}/${r.amount}/${r.item_qty}`);
ok(r.included.orders === 2 && r.included.rows === 3, '(a) 포함 2주문 3행');
ok(r.excluded.orders === 2 && r.excluded.byCode[OTHER] === 1 && r.excluded.noMemo === 1, '(a) 제외: 다른 코드 1, 메모 없음 1');
ok(JSON.stringify(r.orderNos1688) === JSON.stringify(['1001', '1002']), '(a) 1688 주문번호 = 포함 그룹만');
ok(r.crossCheck.missingInExcel.length === 1 && r.crossCheck.missingInExcel[0] === '1003', '(a) 교차② 엑셀에 없는 1688 주문 1건(1003)');
ok(r.crossCheck.notInSession.length === 0, '(a) 교차② 주문목록에 없는 포함 주문 0건');
ok(r.crossCheck.unknownOffers.length === 1 && r.crossCheck.unknownOffers[0] === '333', '(a) 교차③ 주문목록에 없는 offer 1개(333)');
ok(r.warnings.length === 2, `(a) 경고 2건: ${r.warnings.join(' / ')}`);

// (b) 혼합 1688 주문 → 중단
ws = buildSheet([
  { no: '1001', fee: 10, paid: 110, memo: memo(T, '0001-A01:2') + '\n' + memo(OTHER, '0009-A01:1'), items: [{ qty: 2, offer: '111' }, { qty: 1, offer: '999' }] },
  { no: '1002', fee: 5,  paid: 55,  memo: memo(T, '0002-A01:1'), items: [{ qty: 1, offer: '222' }] },
]);
try { P.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set([T]), selectedUserCode: 'BO' }); ok(false, '(b) 혼합 → 예외'); }
catch (e) { ok(e instanceof P.DeductParseError && /함께 들어 있어/.test(e.message) && e.message.includes('1001'), `(b) 혼합 → 중단 메시지에 1688 주문번호 포함`); }

// (c) 대상 코드가 엑셀에 없음 → 중단
ws = buildSheet([{ no: '2001', fee: 7, paid: 77, memo: memo(OTHER, '0009-A01:3'), items: [{ qty: 3, offer: '999' }] }]);
try { P.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set([T]), selectedUserCode: 'BO' }); ok(false, '(c) 대상 없음 → 예외'); }
catch (e) { ok(e instanceof P.DeductParseError && /현재 주문.*없습니다/.test(e.message), '(c) 대상 없음 → 중단'); }

// (d) 현재 주문목록에 코드 2개, 엑셀에는 하나만 → 그 하나로 결정
ws = buildSheet([{ no: '1001', fee: 10, paid: 110, memo: memo(T, '0001-A01:2'), items: [{ qty: 2, offer: '111' }] }]);
r = P.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set([T, 'ORBO261024-R50']), selectedUserCode: 'BO' });
ok(r.orderCode === T && near(r.amount, 110 + 6), '(d) 목록 코드 2개 중 엑셀에 있는 것으로 결정');

// (e) user_code 불일치 → 중단
try { P.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set([T]), selectedUserCode: 'BZ' }); ok(false, '(e) user_code 불일치 → 예외'); }
catch (e) { ok(/유저 코드가 일치하지 않습니다/.test(e.message), '(e) user_code 불일치 → 중단'); }

// (f) 교차검증 미제공 → 경고 없음
r = P.parseDeductWorksheet(ws, XLSX, { currentOrderCodes: new Set([T]), selectedUserCode: 'BO' });
ok(!r.crossCheck.checked1688 && !r.crossCheck.checkedOffer && r.warnings.length === 0, '(f) 교차검증 집합 없음 → 검사 생략, 경고 0');

// (g) 구형 메모 표기 (정규식 미일치) 폴백
ok(JSON.stringify(P._internal.extractCodes('ORBZ251031A01 | BZ-251031 | 0001-A01:1')) === JSON.stringify(['ORBZ251031A01']), '(g) 구형 코드 폴백 추출');
ok(JSON.stringify(P._internal.extractCodes(memo(T, 'x') + '\n' + memo(OTHER, 'y') + '\n' + memo(T, 'z'))) === JSON.stringify([T, OTHER]), '(g) 여러 줄 코드 전부 추출·중복 제거');

if (fail) { console.log(`${fail} FAILED`); process.exit(1); } else console.log('ALL OK');

// ── 3) 품번 단위 대조 모드 (sessionItems 제공) ──
{
  const P2 = require('../deductParser.js');
  let f2 = 0;
  const ok2 = (c, m) => { console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) f2++; };
  const T13 = 'ORBO261026-B13', T03 = 'ORBO261026-B03', Q45 = 'ORBO261025-Q45';
  const memo2 = (code, items) => `${code} | BO-261026 | ${items}`;
  // 세션(현재 주문 B13) 성공 품번 4개
  const session = [
    { itemNo: 'BO-261026-0255-A01', qty: 15 }, { itemNo: 'BO-261026-0253-A01', qty: 10 },
    { itemNo: 'BO-261026-0245-S21', qty: 3 },  { itemNo: 'BO-261026-0245-S22', qty: 3 },
  ];
  // (h) 메모 코드가 B03 으로 다르지만 품번이 현재 주문 것 → 포함 / Q45 는 다른 품번 → 제외
  let ws2 = buildSheet([
    { no: '1001', fee: 31.5, paid: 549,  memo: memo2(T13, '0255-A01:15'),            items: [{ qty: 15, offer: '1' }] },
    { no: '1002', fee: 61,   paid: 1301, memo: memo2(T13, '0253-A01:10'),            items: [{ qty: 10, offer: '2' }] },
    { no: '2001', fee: 10,   paid: 175.4, memo: memo2(T03, '0245-S21:3, 0245-S22:3'), items: [{ qty: 3, offer: '3' }, { qty: 3, offer: '3' }] },
    { no: '9001', fee: 3.92, paid: 80.16, memo: `${Q45} | BO-261025 | 0100-A01:3`,   items: [{ qty: 3, offer: '9' }] },
  ]);
  let r2 = P2.parseDeductWorksheet(ws2, XLSX, { currentOrderCodes: new Set([T13]), selectedUserCode: 'BO', sessionItems: session });
  ok2(r2.mode === 'items', '(h) 품번 모드 동작');
  ok2(r2.included.orders === 3 && r2.excluded.orders === 1 && r2.excluded.byCode[Q45] === 1, '(h) B03 메모 주문 포함(품번 일치), Q45 제외');
  ok2(near(r2.delivery_fee, 102.5) && near(r2.price, 1922.9) && r2.item_qty === 31, `(h) 합산: fee 102.5 / price 1922.9 / qty 31 → ${r2.delivery_fee}/${r2.price}/${r2.item_qty}`);
  ok2(r2.match.sessionTotal === 4 && r2.match.matched === 4 && r2.match.missing.length === 0, '(h) 성공 4건 / 일치 4건 / 누락 0');
  ok2(r2.match.extraInExcel === 1 && r2.match.extraOrders === 1, '(h) 엑셀에만 있는 품번 1 / 1688 주문 1');
  ok2(r2.warnings.length === 0, '(h) 경고 없음');

  // (i) 성공 품번 중 엑셀에 없는 것 → missing 목록 + 경고, 메모 수량 불일치 경고
  const session2 = [...session, { itemNo: 'BO-261026-0260-A01', qty: 7 }];
  ws2 = buildSheet([
    { no: '1001', fee: 31.5, paid: 549, memo: memo2(T13, '0255-A01:15'), items: [{ qty: 15, offer: '1' }] },
    { no: '1002', fee: 61,   paid: 1301, memo: memo2(T13, '0253-A01:12'), items: [{ qty: 12, offer: '2' }] }, // 메모 12 vs 주문 10
    { no: '2001', fee: 10,   paid: 175.4, memo: memo2(T03, '0245-S21:3, 0245-S22:3'), items: [{ qty: 3, offer: '3' }, { qty: 3, offer: '3' }] },
  ]);
  r2 = P2.parseDeductWorksheet(ws2, XLSX, { currentOrderCodes: new Set([T13]), selectedUserCode: 'BO', sessionItems: session2 });
  ok2(r2.match.missing.length === 1 && r2.match.missing[0].itemNo === 'BO-261026-0260-A01', '(i) 엑셀에 없는 성공 품번 1건(0260)');
  ok2(r2.match.qtyMismatch.length === 1 && r2.match.qtyMismatch[0].memoQty === 12 && r2.match.qtyMismatch[0].orderQty === 10, '(i) 수량 불일치 1건 감지');
  ok2(r2.warnings.length === 2, `(i) 경고 2건: ${r2.warnings.join(' / ')}`);

  // (j) 한 1688 주문에 현재 주문 품번 + 다른 품번 혼합 → 중단
  ws2 = buildSheet([
    { no: '1001', fee: 31.5, paid: 549, memo: memo2(T13, '0255-A01:15') + '\n' + `${Q45} | BO-261025 | 0100-A01:3`, items: [{ qty: 15, offer: '1' }, { qty: 3, offer: '9' }] },
  ]);
  try { P2.parseDeductWorksheet(ws2, XLSX, { currentOrderCodes: new Set([T13]), selectedUserCode: 'BO', sessionItems: session }); ok2(false, '(j) 혼합 → 예외'); }
  catch (e) { ok2(e instanceof P2.DeductParseError && /함께 들어 있어/.test(e.message) && e.message.includes('0255-A01'), '(j) 혼합 → 중단 (품번 표시)'); }

  // (k) 메모에 품번이 없는 1688 주문은 코드 규칙으로 폴백 (코드 == 현재 → 포함)
  ws2 = buildSheet([
    { no: '1001', fee: 31.5, paid: 549, memo: memo2(T13, '0255-A01:15'), items: [{ qty: 15, offer: '1' }] },
    { no: '1005', fee: 5,    paid: 55,  memo: T13 + ' 단독 메모',          items: [{ qty: 1, offer: '5' }] },
  ]);
  r2 = P2.parseDeductWorksheet(ws2, XLSX, { currentOrderCodes: new Set([T13]), selectedUserCode: 'BO', sessionItems: session });
  ok2(r2.included.orders === 2 && r2.groupsDetail[1].reason === 'code', '(k) 품번 없는 메모는 코드 규칙 폴백으로 포함');

  // (l) 세션 품번이 엑셀에 하나도 없음 → 중단
  ws2 = buildSheet([{ no: '9001', fee: 3.92, paid: 80.16, memo: `${Q45} | BO-261025 | 0100-A01:3`, items: [{ qty: 3, offer: '9' }] }]);
  try { P2.parseDeductWorksheet(ws2, XLSX, { currentOrderCodes: new Set([T13]), selectedUserCode: 'BO', sessionItems: session }); ok2(false, '(l) 해당 없음 → 예외'); }
  catch (e) { ok2(/엑셀에 없습니다/.test(e.message) && /확인된 것 0개/.test(e.message), '(l) 현재 주문 해당 1688 주문 없음 → 중단'); }

  // (m) 메모 품번 파서 단위 테스트
  const its = P2._internal.extractMemoItems(`${T13} | BO-261026 | 0253-A01:10, 0254-A01:10\n${T03} | BO-261026 | 0245-S21:3`);
  ok2(its.length === 3 && its[0].itemNo === 'BO-261026-0253-A01' && its[0].qty === 10 && its[2].code === T03, '(m) 메모 품번·수량·코드 추출');

  if (f2) { console.log(`${f2} FAILED (items mode)`); process.exit(1); } else console.log('ITEMS MODE ALL OK');
}
