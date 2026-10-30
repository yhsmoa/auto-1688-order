// 配送方式 → 商家配送 선택 테스트 (실제 Chrome 필요, 없으면 SKIP)
//   node test/merchantDelivery.test.js
// 2026-10-30 실제 주문확인 페이지 구조를 그대로 줄여 옮김:
//   .order-inner > .order-footer > official-delivery-service #shadow > official-delivery-pc-content #shadow
//     > official-delivery-method-pc #shadow > .pc-content-radio > .pc-content-radio-item (@click 으로 선택 전환)
//   v1.0.81~v1.0.89: 탐색이 official-delivery-service 자신의 shadow DOM 에 들어가지 않아 '영역 없음'으로 건너뜀.
const fs = require('fs');
const { chromium } = require('playwright');
const { selectMerchantDelivery } = require('../automation');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe' : ''
].find(p => p && fs.existsSync(p));

// 실제처럼: 항목 div 클릭 → (약간 늦게) 선택 상태가 다시 그려짐. q-radio 는 내부 shadow 에 .q-radio div.
const COMPONENTS = `<script>
  customElements.define('q-radio', class extends HTMLElement {
    connectedCallback() { if (this.shadowRoot) return; this.style.display = 'inline-block'; this.attachShadow({ mode: 'open' }).innerHTML = '<div class="q-radio"><div class="radio" style="display:inline-block;width:16px;height:16px;border:1px solid #999"></div><div class="label"><slot></slot></div></div>'; }
  });
  customElements.define('official-delivery-method-pc', class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.sel = this.getAttribute('initial') || 'official';
      this.attachShadow({ mode: 'open' });
      this.paint();
    }
    paint() {
      this.shadowRoot.innerHTML = '<div class="pc-content-radio">'
        + '<div class="pc-content-radio-item" data-v="normal"><q-radio value="normal" checked="' + (this.sel === 'normal') + '" class="pc"></q-radio><div class="pc-content-radio-item-title">商家配送</div><div class="price">¥22</div></div>'
        + '<div class="pc-content-radio-item" data-v="official"><q-radio value="official" checked="' + (this.sel === 'official') + '" class="pc"></q-radio><div class="pc-content-radio-item-title">官方配送</div><div class="price">¥19.42</div><div class="discount">已补2.58元</div></div>'
        + '</div>';
      this.shadowRoot.querySelectorAll('.pc-content-radio-item').forEach(it => it.addEventListener('click', () => {
        window.__itemClicks = (window.__itemClicks || 0) + 1;
        const v = it.dataset.v;
        setTimeout(() => { this.sel = v; this.paint(); }, 200);
      }));
    }
  });
  customElements.define('official-delivery-pc-content', class extends HTMLElement {
    connectedCallback() { if (this.shadowRoot) return; this.attachShadow({ mode: 'open' }).innerHTML = '<official-delivery-method-pc initial="' + (this.getAttribute('initial') || 'official') + '"></official-delivery-method-pc>'; }
  });
  customElements.define('official-delivery-service', class extends HTMLElement {
    connectedCallback() { if (this.shadowRoot) return; this.attachShadow({ mode: 'open' }).innerHTML = this.hasAttribute('empty') ? '' : '<official-delivery-pc-content initial="' + (this.getAttribute('initial') || 'official') + '"></official-delivery-pc-content>'; }
  });
</script>`;

const block = (initial) => `<div class="order-inner"><div class="order-footer"><official-delivery-service initial="${initial}"></official-delivery-service></div></div>`;
const radioState = (page) => page.locator('official-delivery-method-pc q-radio').evaluateAll(els => els.map(e => e.getAttribute('value') + '=' + e.getAttribute('checked')).join(' '));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

(async () => {
  if (!CHROME) { console.log('SKIP: Chrome 없음'); return; }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();

    // 1) 실제 페이지와 같은 구조 1블록, 기본값 官方配送
    await page.setContent(COMPONENTS + block('official'));
    let r = await selectMerchantDelivery(page);
    ok(r.present === true, '配送方式 영역을 찾음 (예전: 영역 없음으로 건너뜀)');
    ok(r.found === 1 && r.ok === true && r.unselected === 0, `商家配送 선택됨 (found=${r.found}, unselected=${r.unselected})`);
    ok((await radioState(page)) === 'normal=true official=false', `페이지 상태 확인: ${await radioState(page)}`);

    // 2) 이미 商家配送 이면 누르지 않음
    await page.setContent(COMPONENTS + block('normal'));
    await page.evaluate(() => { window.__itemClicks = 0; });
    r = await selectMerchantDelivery(page);
    ok(r.ok && r.selected === 1, '이미 商家配送 → 그대로 OK');
    ok(!(await page.evaluate(() => window.__itemClicks)), '이미 선택돼 있으면 클릭하지 않음');

    // 3) 여러 상점 블록 (官方/商家/官方 섞임)
    await page.setContent(COMPONENTS + block('official') + block('normal') + block('official'));
    r = await selectMerchantDelivery(page);
    ok(r.found === 3 && r.ok, `3블록 모두 商家配送 (found=${r.found}, unselected=${r.unselected})`);
    ok((await radioState(page)) === 'normal=true official=false normal=true official=false normal=true official=false', '3블록 페이지 상태 확인');

    // 4) 스캔 범위 밖에 있는 경우 (주문 블록 안 배송 영역은 비어 있고, 실제 라디오는 바깥) → 건너뛰지 않고 Playwright 로 처리
    await page.setContent(COMPONENTS + `<div class="order-inner"><official-delivery-service empty></official-delivery-service></div>`
      + `<div class="elsewhere"><official-delivery-service initial="official"></official-delivery-service></div>`);
    r = await selectMerchantDelivery(page);
    ok(r.present === true && r.ok === true, `스캔이 놓쳐도 교차 확인으로 선택 (present=${r.present}, ok=${r.ok})`);
    ok((await radioState(page)) === 'normal=true official=false', `교차 확인 경로 페이지 상태: ${await radioState(page)}`);

    // 5) 配送方式 영역이 아예 없는 페이지 → 그대로 진행
    await page.setContent(COMPONENTS + `<div class="order-inner"><div class="order-footer"></div></div>`);
    r = await selectMerchantDelivery(page);
    ok(r.present === false && r.ok === true, '영역 없음 → 건너뜀 (진행)');
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
