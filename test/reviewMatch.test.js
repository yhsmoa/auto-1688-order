// 검수 매칭 테스트 — node test/reviewMatch.test.js
const { compareOrdersWithCart, checkSizeMatch } = require('../automation.js');
let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const quiet = () => {};
const run = (orders, cart) => { let batch = null; const res = compareOrdersWithCart(orders, cart, (p) => { batch = p; }); return { res, batch }; };
const origLog = console.log; console.log = quiet;

// (a) 실제 사례: 장바구니 '120 裤长63cm; 上新.加绒    直筒牛仔裤'(공백 4칸, 순서 뒤집힘) vs 주문 color='上新.加绒 直筒牛仔裤', size='120 裤长63cm'
const url = 'https://detail.1688.com/offer/1081478521484.html';
const orders = ['120 裤长63cm', '130 裤长68cm', '140 裤长73cm'].map((sz, i) => ({ url, color: '上新.加绒 直筒牛仔裤', size: sz, quantity: 1, orderNo: `BO-261022-018${7 + i}-A01`, finalComplete: true }));
const cart = ['120 裤长63cm', '130 裤长68cm', '140 裤长73cm'].map(sz => ({ offerId: '1081478521484', color: sz, size: '上新.加绒    直筒牛仔裤', quantity: 1, isChecked: true, isDisabled: false, sellerName: '郾城区终杆百货店', productName: '儿童秋冬韩版牛仔加绒裤' }));
let { res, batch } = run(orders, cart);
console.log = origLog;
ok(res.matched === 3 && res.notFound === 0, `(a) 공백 4칸·순서 뒤집힘 → 3건 일치 (matched=${res.matched}, notFound=${res.notFound})`);
ok(res.extraItems.length === 0, `(a) '주문 목록에 없음' 0건 (extra=${res.extraItems.length})`);
ok(batch.results.every(r => r.reviewStatus === 'ok' && r.reviewResult.isReversed), '(a) 결과 전부 ok + 리버스 매칭 표시');

// (b) 단위 함수: 공백 차이만 있으면 exact
ok(checkSizeMatch('上新.加绒    直筒牛仔裤', '上新.加绒 直筒牛仔裤').match === true, '(b) checkSizeMatch 공백 차이 → 일치');
ok(checkSizeMatch(' 120cm ', '120cm').type === 'exact', '(b) 양끝 공백 → exact');
ok(checkSizeMatch('120\u3000cm', '120 cm').match === true, '(b) 전각 공백 → 일치');
// (c) 기존 동작 유지: 다른 사이즈는 여전히 불일치
ok(checkSizeMatch('130', '120').match === false, '(c) 다른 값은 불일치 유지');
ok(checkSizeMatch('XL', '2XL').match === false && checkSizeMatch('XXL', '2XL').match === true, '(c) XL 변환 규칙 유지');

if (fail) { console.log(`${fail} FAILED`); process.exit(1); } else console.log('ALL OK');
