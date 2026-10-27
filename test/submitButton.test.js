// 제출 버튼(立即下单) 찾기·클릭 테스트 (실제 Chrome 필요, 없으면 SKIP)  — 약 35초 걸림 (30초 재클릭 대기 포함)
//   node test/submitButton.test.js
// 1688 주문확인 페이지에는 같은 立即下单 버튼이 2개(본문 아래는 숨김, 오른쪽 패널은 보임) 있다. (2026-10-27 실측)
// 가짜 order.1688.com 페이지를 page.route 로 띄워서 실제 URL 판정까지 함께 검사한다. 외부로 나가는 요청은 없다.
const fs = require('fs');
const { chromium } = require('playwright');
const { findSubmitButton, clickSubmitAndConfirm } = require('../automation');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe' : ''
].find(p => p && fs.existsSync(p));

const CONFIRM_URL = 'https://order.1688.com/order/smart_make_order.htm?p=cart';
const SUCCESS_URL = 'https://order.1688.com/order/make_order_success.htm';

// ignoreClicks: 이 횟수만큼의 클릭은 무시(페이지가 반응 안 하는 상황), 그 다음 클릭에 성공 페이지로 이동
const confirmHtml = (ignoreClicks) => `<!doctype html><html><body>
<div class="commit-card" style="display:none">
  <q-button data-tracker="btn-submit-order" type="primary" disabled="false" loading="false" id="hiddenBtn">立即下单</q-button>
</div>
<q-button type="primary" class="pc" style="display:none">确定</q-button>
<aside><div class="commit-container">
  <q-button data-tracker="btn-submit-order" type="primary" disabled="false" loading="false" id="visibleBtn"
            style="display:inline-block;width:200px;height:40px;background:#f60">立即下单</q-button>
</div></aside>
<script>
  window.__clicks = { hidden: 0, visible: 0 };
  document.getElementById('hiddenBtn').addEventListener('click', () => window.__clicks.hidden++);
  document.getElementById('visibleBtn').addEventListener('click', () => {
    window.__clicks.visible++;
    localStorage.setItem('clicks', String(window.__clicks.visible));
    if (window.__clicks.visible > ${ignoreClicks}) location.href = '${SUCCESS_URL}';
  });
</script>
</body></html>`;

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

(async () => {
  if (!CHROME) { console.log('SKIP: Chrome 없음'); return; }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext();
    let ignoreClicks = 0;
    await context.route('https://order.1688.com/**', route => {
      const url = route.request().url();
      if (url.startsWith(SUCCESS_URL)) return route.fulfill({ contentType: 'text/html', body: '<html><body>success</body></html>' });
      return route.fulfill({ contentType: 'text/html', body: confirmHtml(ignoreClicks) });
    });
    const page = await context.newPage();
    const visibleClicks = () => page.evaluate(() => Number(localStorage.getItem('clicks') || 0)).catch(() => -1);

    // 1) 첫 번째 일치 버튼이 숨겨져 있어도 보이는 버튼을 찾는다
    await page.goto(CONFIRM_URL);
    const btn = await findSubmitButton(page);
    ok(!!btn, '제출 버튼 찾음');
    ok(btn && (await btn.getAttribute('id')) === 'visibleBtn', '숨겨진 첫 번째가 아니라 보이는 버튼을 고름');
    // 예전 방식 재현: waitForSelector 는 첫 번째(숨김)만 봐서 실패
    const oldWay = await page.waitForSelector('q-button[type="primary"][disabled="false"][loading="false"]', { state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
    ok(oldWay === false, '예전 waitForSelector 방식은 실패함 (오류 재현)');

    // 2) 메모가 틀리면 제출 버튼을 누르지 않는다
    let r = await clickSubmitAndConfirm(page, async () => ({ ok: false, message: '제출 전 확인: 주문 2 메모가 입력되지 않음' }));
    ok(r.status === 'memo_failed' && r.clicks === 0, `메모 실패 → memo_failed, 클릭 0회 (${r.status}, ${r.clicks})`);
    ok((await visibleClicks()) === 0 && (await page.evaluate(() => window.__clicks.hidden)) === 0, '실제로 아무 버튼도 안 눌림');

    // 3) 정상: 한 번 클릭에 성공 페이지
    await page.evaluate(() => localStorage.clear());
    let verifyCalls = 0;
    r = await clickSubmitAndConfirm(page, async () => { verifyCalls++; return { ok: true, summary: '테스트' }; });
    ok(r.status === 'success' && r.clicks === 1, `한 번에 성공 (${r.status}, clicks=${r.clicks})`);
    ok(verifyCalls === 1, `클릭 전 메모 확인 1회 (${verifyCalls})`);

    // 4) 첫 클릭 무반응 → 30초 뒤 메모 재확인 → 다시 클릭 → 성공
    ignoreClicks = 1;
    await page.goto(CONFIRM_URL);
    await page.evaluate(() => localStorage.clear());
    verifyCalls = 0;
    const t0 = Date.now();
    r = await clickSubmitAndConfirm(page, async () => { verifyCalls++; return { ok: true, summary: '테스트' }; });
    const sec = Math.round((Date.now() - t0) / 1000);
    ok(r.status === 'success' && r.clicks === 2, `무반응 후 재클릭으로 성공 (${r.status}, clicks=${r.clicks}, ${sec}s)`);
    ok(verifyCalls === 2, `클릭마다 메모 확인 (첫 클릭 전 + 재클릭 전 = 2회 → ${verifyCalls})`);
    ok(sec >= 29, `재클릭은 30초 무반응 뒤에만 (${sec}s)`);

    // 5) 재클릭 직전 메모 확인 실패 → 다시 누르지 않고 멈춤
    await page.goto(CONFIRM_URL);
    await page.evaluate(() => localStorage.clear());
    let n = 0;
    r = await clickSubmitAndConfirm(page, async () => (++n === 1 ? { ok: true, summary: '첫 확인' } : { ok: false, message: '제출 전 확인: 빈 메모칸 1개' }));
    ok(r.status === 'memo_failed' && r.clicks === 1, `재클릭 전 메모 실패 → 추가 클릭 없음 (${r.status}, clicks=${r.clicks})`);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
