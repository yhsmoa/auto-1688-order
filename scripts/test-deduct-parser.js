// ════════════════════════════════════════════════════════════
// 차감 파서 회귀 테스트 — 공용 파서(deductParser.js) vs 구 V1 알고리즘(복사본)
//
//   실행: node scripts/test-deduct-parser.js [엑셀경로]
//   기본 파일: 21637257_1771930430000.xlsx (BZ, 149행, 병합 1,221)
//
//   구 V1 알고리즘을 그대로 복사해 두고, 같은 파일에서 두 결과가 완전히 같은지 비교한다.
//   (delivery_fee / price / service_fee / amount / item_qty / orderCode)
// ════════════════════════════════════════════════════════════
const path = require('path');
const XLSX = require('xlsx');
const DeductParser = require('../deductParser.js');

const file = process.argv[2] || path.join(__dirname, '..', '21637257_1771930430000.xlsx');
const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];

// ── 구 V1 알고리즘 복사본 (renderer.js 2026-09-12 이전 processDeductExcel) ──
function legacyV1(worksheet) {
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false });
  const merges = worksheet['!merges'] || [];
  const AD_COL = 29, G_COL = 6, I_COL = 8, U_COL = 20;

  function getMergedValue(rowIdx, colIdx, data, merges) {
    if (data[rowIdx] && data[rowIdx][colIdx] !== undefined && data[rowIdx][colIdx] !== '') return data[rowIdx][colIdx];
    for (const merge of merges) {
      if (rowIdx >= merge.s.r && rowIdx <= merge.e.r && colIdx >= merge.s.c && colIdx <= merge.e.c) {
        if (data[merge.s.r] && data[merge.s.r][merge.s.c] !== undefined) return data[merge.s.r][merge.s.c];
      }
    }
    return '';
  }
  function isFirstRowOfMerge(rowIdx, colIdx, merges) {
    for (const merge of merges) {
      if (rowIdx >= merge.s.r && rowIdx <= merge.e.r && colIdx >= merge.s.c && colIdx <= merge.e.c) return rowIdx === merge.s.r;
    }
    return true;
  }

  const codes = new Set();
  for (let i = 1; i < jsonData.length; i++) {
    const ad = getMergedValue(i, AD_COL, jsonData, merges);
    if (ad && ad.toString().trim()) { const c = ad.toString().split('|')[0].trim(); if (c) codes.add(c); }
  }
  let delivery_fee = 0, total_I = 0, item_qty = 0;
  for (let i = 1; i < jsonData.length; i++) {
    if (isFirstRowOfMerge(i, G_COL, merges)) delivery_fee += parseFloat(String(getMergedValue(i, G_COL, jsonData, merges)).replace(/,/g, '')) || 0;
    if (isFirstRowOfMerge(i, I_COL, merges)) total_I += parseFloat(String(getMergedValue(i, I_COL, jsonData, merges)).replace(/,/g, '')) || 0;
    item_qty += parseInt(String(jsonData[i] && jsonData[i][U_COL]).replace(/,/g, '')) || 0;
  }
  delivery_fee = Math.round(delivery_fee * 100) / 100;
  const price = Math.round((total_I - delivery_fee) * 100) / 100;
  const service_fee = Math.round(price * 0.06 * 100) / 100;
  const amount = Math.round((delivery_fee + price + service_fee) * 100) / 100;
  return { orderCode: [...codes][0], codes, delivery_fee, price, service_fee, amount, item_qty, rows: jsonData.length - 1 };
}

// ── 실행 ──
const legacy = legacyV1(ws);
const calc = DeductParser.parseDeductWorksheet(ws, XLSX, {
  currentOrderCodes: new Set(legacy.codes),   // 현재 주문목록 = 엑셀 코드 (대조 통과용)
  selectedUserCode: '',                        // 유저 코드 검사는 생략 (형식 검사는 수행)
});

const fields = ['orderCode', 'delivery_fee', 'price', 'service_fee', 'amount', 'item_qty'];
let ok = true;
console.log(`파일: ${path.basename(file)}  (행 ${legacy.rows}, 병합 ${(ws['!merges'] || []).length})`);
console.log('필드'.padEnd(14), 'V1(구)'.padEnd(20), '공용 파서'.padEnd(20), '일치');
for (const f of fields) {
  const same = legacy[f] === calc[f];
  ok = ok && same;
  console.log(String(f).padEnd(14), String(legacy[f]).padEnd(20), String(calc[f]).padEnd(20), same ? '✓' : '✗');
}
console.log('1688 주문번호(A열 고유):', calc.orderNos1688.length, '건 — 예:', calc.orderNos1688.slice(0, 3).join(', '));
console.log(ok ? '\nPASS — 공용 파서 결과가 구 V1 과 동일합니다.' : '\nFAIL — 불일치 항목이 있습니다.');
process.exit(ok ? 0 : 1);
