// 수량 조합(enumerateQtyCombos) 테스트 — node test/qtyCombos.test.js
const { enumerateQtyCombos, describeQtyConstraints } = require('../automation.js');
const rows = (...q) => q.map((quantity, i) => ({ orderIndex: i, quantity }));
let fail = 0;
function expectTop(name, rs, c, expectIdx, expectSum) {
  const combos = enumerateQtyCombos(rs, c);
  const top = combos[0];
  const ok = top ? (JSON.stringify(top.idx) === JSON.stringify(expectIdx) && top.sum === expectSum) : (expectIdx === null);
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}: top=${top ? `${top.sum} rows[${top.idx}]` : 'none'} (expected ${expectIdx === null ? 'none' : `${expectSum} rows[${expectIdx}]`})`);
  if (!ok) fail++;
}
const INF = Infinity;
// 사용자 예시
expectTop('단위5: 5,3,3 → {5}',            rows(5,3,3),     { min: 5, unit: 5, max: INF }, [0], 5);
expectTop('단위5: 5,3,2 → 전부(10)',        rows(5,3,2),     { min: 5, unit: 5, max: INF }, [0,1,2], 10);
expectTop('단위5: 3,4,2 → {3,2}',          rows(3,4,2),     { min: 5, unit: 5, max: INF }, [0,2], 5);
expectTop('최소2: 1,1 → 둘 다',             rows(1,1),       { min: 2, unit: 1, max: INF }, [0,1], 2);
expectTop('최소2: 1 → 없음',                rows(1),         { min: 2, unit: 1, max: INF }, null);
// 재고 제한
expectTop('재고5: 2,2,2 → 앞 2행(4)',       rows(2,2,2),     { min: 1, unit: 1, max: 5 },   [0,1], 4);
expectTop('재고5·단위5: 2,2,2 → 없음',      rows(2,2,2),     { min: 5, unit: 5, max: 5 },   null);
// 동점: 앞 행 우선
expectTop('단위5·재고10: 5,5,3,2 → {1,2}',  rows(5,5,3,2),   { min: 5, unit: 5, max: 10 },  [0,1], 10);
expectTop('단위5·재고10: 3,4,2,5,1 → 1,2,3,5', rows(3,4,2,5,1), { min: 5, unit: 5, max: 10 }, [0,1,2,4], 10);
// 품절/0 수량 행 방어
expectTop('0수량 행 포함: 0,3 단위3',       rows(0,3),       { min: 1, unit: 3, max: INF }, [0,1], 3);
// 17행 (접두 폴백)
expectTop('17행 단위1 재고10 → 앞 10행',    rows(...Array(17).fill(1)), { min: 1, unit: 1, max: 10 }, [0,1,2,3,4,5,6,7,8,9], 10);
console.log(describeQtyConstraints({ min: 5, unit: 5, max: 10 }, 12), '|', describeQtyConstraints({ min: 1, unit: 1, max: INF }, 3));
if (fail) { console.log(`${fail} FAILED`); process.exit(1); } else console.log('ALL OK');
