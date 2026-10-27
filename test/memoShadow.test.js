// readMemoTextareas — shadow DOM 안 메모 textarea 탐지 테스트 (실제 Chrome 필요, 없으면 SKIP)
//   node test/memoShadow.test.js
// 1688 주문확인 페이지는 메모칸이 q-textarea 컴포넌트의 shadow DOM 안에 있어 document.querySelectorAll 로는 안 보인다.
// 두 가지 구조(호스트에 .q-textarea / shadow 안 div.q-textarea)와 메모칸 없는 블록을 함께 검사한다.
const fs = require('fs');
const { chromium } = require('playwright');
const { readMemoTextareas, MEMO_TEXTAREA_SEL } = require('../automation');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe' : ''
].find(p => p && fs.existsSync(p));

const HTML = `<!doctype html><html><body>
<script>
  // 구조 A: <q-textarea class="q-textarea"> 의 shadow 안에 textarea
  customElements.define('q-textarea', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<textarea></textarea>'; }
  });
  // 구조 B: <q-memo> 의 shadow 안에 <div class="q-textarea"><textarea>
  customElements.define('q-memo', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div class="q-textarea"><textarea></textarea></div>'; }
  });
  // 바깥 래퍼도 shadow (order-footer 가 컴포넌트 안에 있는 경우)
  customElements.define('q-footer', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="order-footer"><div class="leave-message-container"><q-textarea class="q-textarea"></q-textarea></div></div>'; }
  });
</script>
<div class="order-group-container"><div class="order-inner">
  <div class="order-footer"><div class="leave-message-container"><q-textarea class="q-textarea"></q-textarea></div></div>
</div></div>
<div class="order-group-container"><div class="order-inner">
  <div class="order-footer"><div class="leave-message-container"></div></div>
</div></div>
<div class="order-group-container"><div class="order-inner">
  <div class="order-footer"><div class="leave-message-container"><q-memo></q-memo></div></div>
</div></div>
<div class="order-group-container"><div class="order-inner"><q-footer></q-footer></div></div>
</body></html>`;

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

(async () => {
  if (!CHROME) { console.log('SKIP: Chrome 없음'); return; }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(HTML);

    const plain = await page.evaluate(() => document.querySelectorAll('.order-inner .order-footer .leave-message-container .q-textarea textarea').length);
    ok(plain === 0, `document.querySelectorAll 로는 0개 (예전 코드가 못 보던 상황 재현) → ${plain}`);

    let list = await readMemoTextareas(page);
    ok(Array.isArray(list) && list.length === 3, `메모칸 3개 탐지 → ${list && list.length}`);
    ok(JSON.stringify(list.map(t => t.inner)) === '[0,2,3]', `소속 .order-inner = [0,2,3] → ${JSON.stringify(list.map(t => t.inner))}`);
    ok(JSON.stringify(list.map(t => t.group)) === '[0,2,3]', `소속 .order-group-container = [0,2,3] → ${JSON.stringify(list.map(t => t.group))}`);
    ok(list.every(t => t.value === ''), '처음엔 모두 빈 값');

    // Phase 3 와 같은 방식으로 입력 → 다시 읽기
    const inners = page.locator('.order-inner');
    await inners.nth(0).locator(MEMO_TEXTAREA_SEL).first().fill('ORBO261027-A01 | BO-261027 | 0001-A01:2');
    await inners.nth(3).locator(MEMO_TEXTAREA_SEL).first().fill('줄1\n줄2');
    list = await readMemoTextareas(page);
    const byInner = new Map(list.map(t => [t.inner, t.value]));
    ok(byInner.get(0) === 'ORBO261027-A01 | BO-261027 | 0001-A01:2', '블록1 입력값 읽힘');
    ok(byInner.get(2) === '', '블록3 은 빈 값 그대로 (빈 메모 검사가 잡아야 함)');
    ok(byInner.get(3) === '줄1\n줄2', '블록4(이중 shadow) 입력값 읽힘');
    ok(!byInner.has(1), '메모칸 없는 블록2 는 목록에 없음');

    // 메모칸이 하나도 없는 페이지
    await page.setContent('<div class="order-inner"></div>');
    list = await readMemoTextareas(page);
    ok(Array.isArray(list) && list.length === 0, '메모칸 없는 페이지 → 빈 배열');
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
