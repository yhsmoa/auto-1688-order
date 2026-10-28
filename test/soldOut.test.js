// 품절 옵션 행(库存不足) 판정 테스트 (실제 Chrome 필요, 없으면 SKIP)
//   node test/soldOut.test.js
// 2026-10-28 실제 1688 상품 페이지 구조(사이즈 6개 중 130/140cm 품절)를 그대로 줄여 옮김.
const fs = require('fs');
const { chromium } = require('playwright');
const { isSoldOutRow } = require('../automation');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe' : ''
].find(p => p && fs.existsSync(p));

const normalRow = (label, stock) => `<div class="expand-view-item v-flex"><div class="v-flex"><span class="item-label" title="${label}">${label}</span></div>
  <span class="item-price-stock">¥18</span><span class="item-price-stock"><od-text i18n="sku-stock">库存${stock}件</od-text></span>
  <span class="item-input-number"><div class="ant-input-number-group-wrapper"><div class="ant-input-number ant-input-number-sm"><div class="ant-input-number-input-wrap">
  <input autocomplete="off" role="spinbutton" step="1" placeholder="0" class="ant-input-number-input" value=""></div></div></div></span></div>`;
const soldRow = (label) => `<div class="expand-view-item v-flex soldout"><div class="v-flex"><span class="item-label" title="${label}">${label}</span></div>
  <span class="item-price-stock">¥18</span><div class="item-count-invalid"><od-text i18n="sku-stock-empty">库存不足</od-text></div></div>`;

const HTML = `<div class="expand-view-list">${normalRow('110cm', 1986)}${normalRow('120cm', 1862)}${normalRow('150cm', 1773)}${normalRow('160cm', 1905)}${soldRow('130cm')}${soldRow('140cm')}
  <div class="expand-view-item v-flex soldout" id="oddRow"><div class="v-flex"><span class="item-label">170cm</span></div>
    <span class="item-input-number"><input class="ant-input-number-input" value=""></span></div></div>`;

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

(async () => {
  if (!CHROME) { console.log('SKIP: Chrome 없음'); return; }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(HTML);
    const rows = await page.locator('.expand-view-item').all();
    const result = {};
    for (const row of rows) result[(await row.locator('.item-label').innerText()).trim()] = await isSoldOutRow(row);
    ok(result['110cm'] === false && result['120cm'] === false && result['150cm'] === false && result['160cm'] === false, '재고 있는 4개 사이즈 → 품절 아님');
    ok(result['130cm'] === true, '130cm (库存不足) → 품절');
    ok(result['140cm'] === true, '140cm (库存不足) → 품절');
    ok(result['170cm'] === false, 'soldout 표시가 있어도 입력칸이 있으면 품절로 단정하지 않음 (기존 수량 확인으로 처리)');
    ok(Object.keys(result).length === 7, `품절 행도 라벨이 읽혀 옵션 매칭 대상에 포함됨 (${Object.keys(result).length}개)`);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
