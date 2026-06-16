const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 중단 플래그
let shouldStop = false;

// Chrome 실행 경로 찾기
function findChromePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of possiblePaths) {
    try {
      fs.accessSync(p);
      return p;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Chrome 디버그 모드로 실행 (stealth 플래그 포함)
function launchChromeDebug(chromePath) {
  return new Promise((resolve) => {
    const chrome = spawn(chromePath, [
      '--remote-debugging-port=9222',
      '--user-data-dir=' + path.join(process.env.TEMP, 'chrome-debug-profile'),
      // Stealth 관련 플래그
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--disable-notifications',
    ], {
      detached: true,
      stdio: 'ignore'
    });

    chrome.unref();
    setTimeout(() => resolve(), 2000);
  });
}

// 1688 봇 인증 챌린지 감지: "subtree intercepts pointer events" 패턴이면
// 슬라이더/캡차 같은 봇 차단 레이어가 클릭 대상을 가린 상황으로 간주.
// 재시도/우회를 시도하면 IP/계정 차단 위험이 있으므로 즉시 중단해야 함.
class BotChallengeError extends Error {
  constructor(originalError) {
    super('Bot challenge detected (1688 anti-crawl). Aborting to avoid block.');
    this.name = 'BotChallengeError';
    this.original = originalError;
  }
}

function isBotInterceptError(err) {
  return !!(err && typeof err.message === 'string' &&
            err.message.includes('intercepts pointer events'));
}

// click 래퍼: intercept 에러를 BotChallengeError 로 변환하고,
// timeout 을 20s 로 잡아서 느린 PC 에서의 정상 클릭은 통과시키되,
// 봇 챌린지 상황의 Playwright 30s 재시도는 빠르게 끊는다.
async function safeClick(locator, opts = {}) {
  try {
    await locator.click({ timeout: 20000, ...opts });
  } catch (e) {
    if (isBotInterceptError(e)) {
      throw new BotChallengeError(e);
    }
    throw e;
  }
}

// 페이지에 stealth 스크립트 적용
async function applyStealthScripts(page) {
  await page.addInitScript(() => {
    // navigator.webdriver 숨기기
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // navigator.plugins 설정
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    // navigator.languages 설정
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ko-KR', 'ko', 'en-US', 'en'],
    });

    // chrome 객체 추가
    window.chrome = {
      runtime: {},
    };

    // permissions 쿼리 수정
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });
}

// 디버그 포트 연결 확인
async function tryConnectChrome(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const browser = await chromium.connectOverCDP('http://localhost:9222');
      return browser;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  return null;
}

// XL 변환 (2XL <-> XXL, 3XL <-> XXXL 등)
function convertXLSize(size) {
  // 2XL -> XXL
  const numToX = size.match(/^(\d)XL$/i);
  if (numToX) {
    const num = parseInt(numToX[1]);
    return 'X'.repeat(num) + 'L';
  }

  // XXL -> 2XL
  const xToNum = size.match(/^(X+)L$/i);
  if (xToNum) {
    const xCount = xToNum[1].length;
    if (xCount >= 2) {
      return xCount + 'XL';
    }
  }

  return null;
}

// 숫자만 추출
function extractNumber(str) {
  const match = str.match(/(\d+)/);
  return match ? match[1] : null;
}

// 사이즈 매칭 함수
function findSizeMatch(searchSize, availableSizes) {
  // 1. 정확히 일치
  const exactMatch = availableSizes.filter(s => s.text === searchSize);
  if (exactMatch.length === 1) {
    return { match: exactMatch[0], type: 'exact' };
  }

  // 2. startsWith 경계 매칭 (사이즈코드 + 비영숫자 경계)
  const escaped = searchSize.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsWithRegex = new RegExp(`^${escaped}(?![A-Za-z0-9])`, 'i');
  const startsWithMatch = availableSizes.filter(s => startsWithRegex.test(s.text));
  if (startsWithMatch.length === 1) {
    return { match: startsWithMatch[0], type: 'startsWith' };
  }
  if (startsWithMatch.length > 1) {
    return { match: null, type: 'multiple', count: startsWithMatch.length };
  }

  // 3. 부분 일치 (searchSize를 포함하는 옵션)
  const partialMatch = availableSizes.filter(s => s.text.includes(searchSize));
  if (partialMatch.length === 1) {
    return { match: partialMatch[0], type: 'partial' };
  }
  if (partialMatch.length > 1) {
    return { match: null, type: 'multiple', count: partialMatch.length };
  }

  // 3. XL 변환 (2XL <-> XXL 등)
  const convertedSize = convertXLSize(searchSize);
  if (convertedSize) {
    // 변환된 값으로 정확히 일치
    const xlExact = availableSizes.filter(s => s.text === convertedSize);
    if (xlExact.length === 1) {
      return { match: xlExact[0], type: 'xl-convert-exact' };
    }

    // 변환된 값으로 부분 일치
    const xlPartial = availableSizes.filter(s => s.text.includes(convertedSize));
    if (xlPartial.length === 1) {
      return { match: xlPartial[0], type: 'xl-convert-partial' };
    }
    if (xlPartial.length > 1) {
      return { match: null, type: 'multiple', count: xlPartial.length };
    }
  }

  // 4. FREE <-> 均码
  if (searchSize.toUpperCase() === 'FREE' || searchSize === '均码') {
    const freeMatch = availableSizes.filter(s =>
      s.text.toUpperCase().includes('FREE') || s.text.includes('均码')
    );
    if (freeMatch.length === 1) {
      return { match: freeMatch[0], type: 'free-match' };
    }
    if (freeMatch.length > 1) {
      return { match: null, type: 'multiple', count: freeMatch.length };
    }
  }

  // 5. 숫자만 추출해서 검색 (120CM -> 120)
  const numOnly = extractNumber(searchSize);
  if (numOnly && numOnly !== searchSize) {
    const numMatch = availableSizes.filter(s => s.text.includes(numOnly));
    if (numMatch.length === 1) {
      return { match: numMatch[0], type: 'number-match' };
    }
    if (numMatch.length > 1) {
      return { match: null, type: 'multiple', count: numMatch.length };
    }
  }

  return { match: null, type: 'not-found' };
}

// 장바구니 추가 성공 모달 닫기/제거
async function dismissSuccessModal(page) {
  try {
    const closeBtn = page.locator('.ant-modal-close');
    if (await closeBtn.count() > 0) {
      await closeBtn.first().click();
      await page.waitForTimeout(300);
    }
  } catch (e) {
    // close 버튼 없으면 무시
  }

  // DOM에서 모달 관련 요소 직접 제거
  await page.evaluate(() => {
    document.querySelectorAll('.ant-modal-root, .ant-modal-mask').forEach(el => el.remove());
    document.querySelectorAll('.feedback-dialog-message').forEach(el => {
      const wrapper = el.closest('.ant-modal-wrap') || el.closest('.ant-modal-root');
      if (wrapper) wrapper.remove();
    });
  }).catch(() => {});
}

// "Add to Cart" 클릭 후 새로운 성공 모달 감지 (재시도 포함)
async function clickAndWaitForNewModal(page, addCartBtn, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`  Add to cart attempt ${attempt}/${maxRetries}...`);

    // 1. 기존 모달 제거 (이전 그룹의 잔여 모달 방지)
    await dismissSuccessModal(page);

    // 2. 모달이 완전히 제거되었는지 확인
    const preClickCount = await page.locator('.feedback-dialog-message').count();
    if (preClickCount > 0) {
      console.log(`  Warning: ${preClickCount} stale modal(s) in DOM, force removing...`);
      await page.evaluate(() => {
        document.querySelectorAll('.feedback-dialog-message').forEach(el => {
          const root = el.closest('.ant-modal-root') || el.closest('.ant-modal-wrap') || el.parentElement;
          if (root) root.remove();
        });
      }).catch(() => {});
    }

    // 3. 클릭 (봇 챌린지 감지 시 BotChallengeError 로 즉시 중단)
    await safeClick(addCartBtn.first());

    // 4. 새로운 성공 모달 대기 (기존 모달은 제거했으므로 새것만 감지됨)
    try {
      await page.waitForSelector('.feedback-dialog-message:has-text("加购成功")', {
        timeout: 8000,
        state: 'visible'
      });

      // 5. 더블 체크: 실제로 보이는지 확인
      const isVisible = await page.locator('.feedback-dialog-message:has-text("加购成功")').isVisible();
      if (!isVisible) {
        console.log(`  Warning: Modal found but not visible, retrying...`);
        if (attempt < maxRetries) continue;
        return { success: false, error: 'Modal detected but not visible' };
      }

      console.log(`  SUCCESS! Cart add confirmed.`);
      return { success: true };

    } catch (e) {
      console.log(`  Attempt ${attempt}: Success message not found within timeout`);

      // 에러 모달이 떴는지 확인 (예: 재고 부족 등)
      const errorText = await page.locator('.feedback-dialog-message').first().innerText().catch(() => '');
      if (errorText) {
        console.log(`  Modal text: "${errorText}"`);
        return { success: false, error: `Cart response: ${errorText}` };
      }

      if (attempt < maxRetries) {
        console.log(`  Retrying...`);
        await page.waitForTimeout(1000);
      }
    }
  }

  return { success: false, error: 'Add to cart failed after retries' };
}

// 단일 주문 처리
async function processOneOrder(page, order) {
  const { url, color, size, quantity, orderNo } = order;

  console.log(`\n[${orderNo}] Processing...`);
  console.log(`  URL: ${url}`);
  console.log(`  Options: Color=${color} / Size=${size} / Qty=${quantity}`);

  // 1. 페이지 접속
  console.log(`  Loading page...`);
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  // Invalid page check
  if (page.url().includes('wrongpage.html')) {
    console.log(`  X Invalid URL`);
    throw new Error('Invalid URL');
  }

  // 상품 하가(下架) 체크
  const offlineTitle = await page.locator('h3.mod-detail-offline-title').count();
  if (offlineTitle > 0) {
    console.log(`  X Product offline (商品已下架)`);
    throw new Error('Invalid URL');
  }

  // 2. Wait for options
  console.log(`  Waiting for options...`);
  try {
    await page.waitForSelector('.module-od-sku-selection', { timeout: 15000 });
  } catch (e) {
    console.log(`  X Page load failed`);
    throw new Error('Page load failed');
  }

  // 3. 옵션 구조 파악: 색상 버튼이 있는지 확인
  const colorButtons = await page.locator('button.sku-filter-button').all();
  const hasColorOptions = colorButtons.length > 0;

  // 사이즈 옵션 영역 (expand-view-item)
  const sizeRows = await page.locator('.expand-view-item').all();
  const hasSizeOptions = sizeRows.length > 0;

  console.log(`  Option structure: Colors=${colorButtons.length}, Sizes=${sizeRows.length}`);

  let targetRow = null;

  if (hasColorOptions && hasSizeOptions) {
    // 케이스 2: 색상 + 사이즈 둘 다 있음
    console.log(`  Selecting color: ${color}`);

    // 모든 색상 버튼의 텍스트 수집
    const availableColors = [];
    for (const btn of colorButtons) {
      const btnText = await btn.innerText().catch(() => '');
      if (btnText) {
        availableColors.push({ text: btnText.trim(), button: btn });
      }
    }
    console.log(`  Available colors: ${availableColors.map(c => c.text).join(', ')}`);

    // 색상 매칭 (사이즈와 동일한 규칙 적용)
    const colorMatchResult = findSizeMatch(color, availableColors);

    if (colorMatchResult.match) {
      await colorMatchResult.match.button.click();
      console.log(`  + Color matched (${colorMatchResult.type}): ${colorMatchResult.match.text}`);
    } else if (colorMatchResult.type === 'multiple') {
      console.log(`  X Multiple color matches found (${colorMatchResult.count})`);
      throw new Error(`Color ambiguous: ${color} (${colorMatchResult.count} matches)`);
    } else {
      console.log(`  X Color not found: ${color}`);
      throw new Error(`Color not found: ${color}`);
    }
    await page.waitForTimeout(500);

    // 사이즈 옵션 목록 다시 가져오기 (색상 선택 후 변경될 수 있음)
    const updatedSizeRows = await page.locator('.expand-view-item').all();

    // 사이즈 옵션들의 텍스트 수집
    const availableSizes = [];
    for (const row of updatedSizeRows) {
      const labelText = await row.locator('.item-label').innerText().catch(() => '');
      if (labelText) {
        availableSizes.push({ text: labelText.trim(), row });
      }
    }

    console.log(`  Available sizes: ${availableSizes.map(s => s.text).join(', ')}`);
    console.log(`  Searching for size: ${size}`);

    // 사이즈 매칭
    const matchResult = findSizeMatch(size, availableSizes);

    if (matchResult.match) {
      targetRow = matchResult.match.row;
      console.log(`  + Size matched (${matchResult.type}): ${matchResult.match.text}`);
    } else if (matchResult.type === 'multiple') {
      console.log(`  X Multiple size matches found (${matchResult.count})`);
      throw new Error(`Size ambiguous: ${size} (${matchResult.count} matches)`);
    } else {
      console.log(`  X Size not found: ${size}`);
      throw new Error(`Size not found: ${size}`);
    }

  } else if (!hasColorOptions && hasSizeOptions) {
    // 케이스 1: 사이즈 옵션만 있음 - 색상을 사이즈 영역에서 검색
    console.log(`  No color buttons, searching color in size area: ${color}`);

    const availableSizes = [];
    for (const row of sizeRows) {
      const labelText = await row.locator('.item-label').innerText().catch(() => '');
      if (labelText) {
        availableSizes.push({ text: labelText.trim(), row });
      }
    }

    console.log(`  Available options: ${availableSizes.map(s => s.text).join(', ')}`);

    // 색상값으로 검색 (사이즈 검색 규칙 동일 적용)
    const matchResult = findSizeMatch(color, availableSizes);

    if (matchResult.match) {
      targetRow = matchResult.match.row;
      console.log(`  + Option matched (${matchResult.type}): ${matchResult.match.text}`);
    } else if (matchResult.type === 'multiple') {
      console.log(`  X Multiple matches found (${matchResult.count})`);
      throw new Error(`Option ambiguous: ${color} (${matchResult.count} matches)`);
    } else {
      console.log(`  X Option not found: ${color}`);
      throw new Error(`Option not found: ${color}`);
    }

  } else if (hasColorOptions && !hasSizeOptions) {
    // 색상 옵션만 있는 경우 - 색상 선택 후 바로 진행
    console.log(`  Only color options, selecting: ${color}`);

    // 모든 색상 버튼의 텍스트 수집
    const availableColors = [];
    for (const btn of colorButtons) {
      const btnText = await btn.innerText().catch(() => '');
      if (btnText) {
        availableColors.push({ text: btnText.trim(), button: btn });
      }
    }
    console.log(`  Available colors: ${availableColors.map(c => c.text).join(', ')}`);

    // 색상 매칭 (사이즈와 동일한 규칙 적용)
    const colorMatchResult = findSizeMatch(color, availableColors);

    if (colorMatchResult.match) {
      await colorMatchResult.match.button.click();
      console.log(`  + Color matched (${colorMatchResult.type}): ${colorMatchResult.match.text}`);
    } else if (colorMatchResult.type === 'multiple') {
      console.log(`  X Multiple color matches found (${colorMatchResult.count})`);
      throw new Error(`Color ambiguous: ${color} (${colorMatchResult.count} matches)`);
    } else {
      console.log(`  X Color not found: ${color}`);
      throw new Error(`Color not found: ${color}`);
    }
    await page.waitForTimeout(500);

    // 색상 선택 후 사이즈 옵션이 나타나는지 확인
    const newSizeRows = await page.locator('.expand-view-item').all();
    if (newSizeRows.length > 0) {
      const availableSizes = [];
      for (const row of newSizeRows) {
        const labelText = await row.locator('.item-label').innerText().catch(() => '');
        if (labelText) {
          availableSizes.push({ text: labelText.trim(), row });
        }
      }

      const matchResult = findSizeMatch(size, availableSizes);
      if (matchResult.match) {
        targetRow = matchResult.match.row;
        console.log(`  + Size matched (${matchResult.type}): ${matchResult.match.text}`);
      } else if (matchResult.type === 'multiple') {
        throw new Error(`Size ambiguous: ${size}`);
      } else {
        throw new Error(`Size not found: ${size}`);
      }
    }
  } else {
    console.log(`  X No options found on page`);
    throw new Error('No options found');
  }

  if (!targetRow) {
    throw new Error('Could not select option');
  }

  console.log(`  + Entering quantity: ${quantity}`);
  const inputField = targetRow.locator('.ant-input-number-input');
  await inputField.scrollIntoViewIfNeeded();

  // 입력 필드 클릭 후 기존 값 지우고 새 값 입력
  await inputField.click();
  await inputField.fill('');  // 먼저 비우기
  await inputField.type(quantity.toString(), { delay: 50 });  // 천천히 타이핑

  // 입력 확인을 위해 포커스 이동 (blur 이벤트 발생)
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);

  // 5. 배송비 체크
  const shippingCheck = await checkShippingFee(page);
  if (shippingCheck.warning) {
    return { success: false, shippingWarning: true, message: shippingCheck.message };
  }

  // 6. Add to cart
  console.log(`  Clicking add to cart...`);

  // 여러 방법으로 버튼 찾기
  let addCartBtn = page.locator('button[data-click="ADD_CART"]');

  if (await addCartBtn.count() === 0) {
    // 방법 2: 텍스트로 찾기
    addCartBtn = page.locator('button:has-text("加采购车")');
  }

  if (await addCartBtn.count() === 0) {
    // 방법 3: class로 찾기
    addCartBtn = page.locator('button.v-button:has-text("加采购车")');
  }

  if (await addCartBtn.count() === 0) {
    console.log(`  X Cart button not found`);

    // 디버깅: 페이지에 있는 버튼들 출력
    const allButtons = await page.locator('button').all();
    console.log(`  Debug: Found ${allButtons.length} buttons on page`);
    for (let i = 0; i < Math.min(allButtons.length, 5); i++) {
      const text = await allButtons[i].innerText().catch(() => '');
      if (text) console.log(`    Button ${i + 1}: ${text.trim()}`);
    }

    throw new Error('Cart button not found');
  }

  // 기존 모달 정리 후 장바구니 추가 + 새 모달 검증
  const cartResult = await clickAndWaitForNewModal(page, addCartBtn);

  if (cartResult.success) {
    console.log(`  SUCCESS!`);
    await dismissSuccessModal(page);
    return { success: true };
  } else {
    console.log(`  X Cart add failed: ${cartResult.error}`);
    throw new Error(cartResult.error || 'Add to cart failed');
  }
}

// 배송비 체크 함수
// 배송비가 20위안 이상이고 동시에 전체금액의 20% 이상인 경우 경고
async function checkShippingFee(page) {
  try {
    // 금액 정보가 나타날 때까지 대기
    await page.waitForSelector('.order-select-models', { timeout: 3000 });

    // 총 금액 추출
    const totalPriceEl = page.locator('.order-select-models .total-price strong');
    const totalPriceText = await totalPriceEl.innerText().catch(() => '');
    const totalPrice = parseFloat(totalPriceText.replace(/[^0-9.]/g, '')) || 0;

    // 배송비 추출
    const freightEl = page.locator('.order-select-models .total-freight-fee strong');
    const freightText = await freightEl.innerText().catch(() => '');
    const freightFee = parseFloat(freightText.replace(/[^0-9.]/g, '')) || 0;

    console.log(`  Price check - Total: ¥${totalPrice}, Freight: ¥${freightFee}`);

    // 배송비가 20위안 이상이고, 총금액의 20% 이상인 경우
    if (freightFee >= 20 && totalPrice > 0 && (freightFee / totalPrice) >= 0.2) {
      const ratio = ((freightFee / totalPrice) * 100).toFixed(1);
      console.log(`  WARNING: High shipping fee! (${ratio}% of total)`);
      return {
        warning: true,
        totalPrice,
        freightFee,
        ratio,
        message: `주문금액 ${totalPrice}, 배송비 ${freightFee} 확인 !`
      };
    }

    // 테스트용: 모든 배송비 정보 반환
    return { warning: false, totalPrice, freightFee, infoMessage: `금액 ${totalPrice}, 배송비 ${freightFee}` };
  } catch (e) {
    console.log(`  Price info not found: ${e.message}`);
    return { warning: false, totalPrice: 0, freightFee: 0, infoMessage: '배송비 정보 없음' };
  }
}

// URL에서 offer_id 추출
function extractOfferId(url) {
  const match = url.match(/offer\/(\d+)\.html/);
  return match ? match[1] : null;
}

// 동일 offer_id로 주문 그룹화
function groupOrdersByOfferId(orders) {
  const groups = {};

  orders.forEach((order, index) => {
    const offerId = extractOfferId(order.url);
    if (!offerId) return;

    if (!groups[offerId]) {
      groups[offerId] = {
        offerId,
        url: order.url,
        items: []
      };
    }

    // originalIndex가 있으면 사용, 없으면 현재 index 사용
    const orderIndex = order.originalIndex !== undefined ? order.originalIndex : index;

    // 동일 색상+사이즈 찾기
    const existingItem = groups[offerId].items.find(
      item => item.color === order.color && item.size === order.size
    );

    if (existingItem) {
      // 동일 옵션이면 수량 합산
      existingItem.quantity += order.quantity;
      existingItem.orderIndices.push(orderIndex);
    } else {
      // 새로운 옵션 추가
      groups[offerId].items.push({
        color: order.color,
        size: order.size,
        quantity: order.quantity,
        orderIndices: [orderIndex]  // 원본 orders 배열의 인덱스들
      });
    }
  });

  return Object.values(groups);
}

// 그룹 주문 처리 (동일 offer_id의 여러 옵션을 한 번에)
async function processGroupOrder(page, group, onProgress) {
  const { offerId, url, items } = group;

  console.log(`\n========================================`);
  console.log(`Processing Group: offer_id=${offerId}`);
  console.log(`URL: ${url}`);
  console.log(`Options to process: ${items.length}`);
  items.forEach((item, i) => {
    console.log(`  ${i + 1}. Color=${item.color}, Size=${item.size}, Qty=${item.quantity}`);
  });
  console.log(`========================================`);

  // 모든 아이템을 처리 중 상태로 표시
  items.forEach(item => {
    item.orderIndices.forEach(idx => {
      onProgress({ index: idx, status: 'processing' });
    });
  });

  // 1. 페이지 접속
  console.log(`\nLoading page...`);
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  // 이전 그룹의 잔여 모달 정리
  await dismissSuccessModal(page);

  // Invalid page check
  if (page.url().includes('wrongpage.html')) {
    console.log(`X Invalid URL`);
    items.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: 'Invalid URL' });
      });
    });
    return;
  }

  // 상품 하가(下架) 체크
  const offlineTitle = await page.locator('h3.mod-detail-offline-title').count();
  if (offlineTitle > 0) {
    console.log(`X Product offline (商品已下架)`);
    items.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: 'Product offline' });
      });
    });
    return;
  }

  // 2. Wait for options
  console.log(`Waiting for options...`);
  try {
    await page.waitForSelector('.module-od-sku-selection', { timeout: 15000 });
  } catch (e) {
    console.log(`X Page load failed`);
    items.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: 'Page load failed' });
      });
    });
    return;
  }

  // 3. 옵션 구조 파악
  const colorButtons = await page.locator('button.sku-filter-button').all();
  const hasColorOptions = colorButtons.length > 0;
  const sizeRows = await page.locator('.expand-view-item').all();
  const hasSizeOptions = sizeRows.length > 0;

  console.log(`Option structure: Colors=${colorButtons.length}, Sizes=${sizeRows.length}`);

  // 각 아이템(옵션) 처리
  for (const item of items) {
    console.log(`\n--- Processing: Color=${item.color}, Size=${item.size}, Qty=${item.quantity} ---`);

    try {
      let targetRow = null;

      if (hasColorOptions && hasSizeOptions) {
        // 케이스 2: 색상 + 사이즈 둘 다 있음
        console.log(`  Selecting color: ${item.color}`);

        // 모든 색상 버튼의 텍스트 수집
        const availableColors = [];
        for (const btn of colorButtons) {
          const btnText = await btn.innerText().catch(() => '');
          if (btnText) {
            availableColors.push({ text: btnText.trim(), button: btn });
          }
        }
        console.log(`  Available colors: ${availableColors.map(c => c.text).join(', ')}`);

        // 색상 매칭 (사이즈와 동일한 규칙 적용)
        const colorMatchResult = findSizeMatch(item.color, availableColors);

        if (colorMatchResult.match) {
          await safeClick(colorMatchResult.match.button);
          console.log(`  + Color matched (${colorMatchResult.type}): ${colorMatchResult.match.text}`);
        } else if (colorMatchResult.type === 'multiple') {
          throw new Error(`Color ambiguous: ${item.color} (${colorMatchResult.count} matches)`);
        } else {
          throw new Error(`Color not found: ${item.color}`);
        }
        await page.waitForTimeout(500);

        // 사이즈 옵션 목록 가져오기
        const updatedSizeRows = await page.locator('.expand-view-item').all();
        const availableSizes = [];
        for (const row of updatedSizeRows) {
          const labelText = await row.locator('.item-label').innerText().catch(() => '');
          if (labelText) {
            availableSizes.push({ text: labelText.trim(), row });
          }
        }

        console.log(`  Available sizes: ${availableSizes.map(s => s.text).join(', ')}`);

        const matchResult = findSizeMatch(item.size, availableSizes);
        if (matchResult.match) {
          targetRow = matchResult.match.row;
          console.log(`  + Size matched (${matchResult.type}): ${matchResult.match.text}`);
        } else if (matchResult.type === 'multiple') {
          throw new Error(`Size ambiguous: ${item.size} (${matchResult.count} matches)`);
        } else {
          throw new Error(`Size not found: ${item.size}`);
        }

      } else if (!hasColorOptions && hasSizeOptions) {
        // 케이스 1: 사이즈 옵션만 있음
        console.log(`  No color buttons, searching in size area: ${item.color}`);

        const availableSizes = [];
        for (const row of sizeRows) {
          const labelText = await row.locator('.item-label').innerText().catch(() => '');
          if (labelText) {
            availableSizes.push({ text: labelText.trim(), row });
          }
        }

        const matchResult = findSizeMatch(item.color, availableSizes);
        if (matchResult.match) {
          targetRow = matchResult.match.row;
          console.log(`  + Option matched (${matchResult.type}): ${matchResult.match.text}`);
        } else if (matchResult.type === 'multiple') {
          throw new Error(`Option ambiguous: ${item.color}`);
        } else {
          throw new Error(`Option not found: ${item.color}`);
        }

      } else if (hasColorOptions && !hasSizeOptions) {
        // 색상 옵션만 있는 경우
        console.log(`  Only color options, selecting: ${item.color}`);

        // 모든 색상 버튼의 텍스트 수집
        const availableColors = [];
        for (const btn of colorButtons) {
          const btnText = await btn.innerText().catch(() => '');
          if (btnText) {
            availableColors.push({ text: btnText.trim(), button: btn });
          }
        }

        // 색상 매칭 (사이즈와 동일한 규칙 적용)
        const colorMatchResult = findSizeMatch(item.color, availableColors);
        if (colorMatchResult.match) {
          await safeClick(colorMatchResult.match.button);
          console.log(`  + Color selected (${colorMatchResult.type}): ${colorMatchResult.match.text}`);
        } else if (colorMatchResult.type === 'multiple') {
          throw new Error(`Color ambiguous: ${item.color} (${colorMatchResult.count} matches)`);
        } else {
          throw new Error(`Color not found: ${item.color}`);
        }
        await page.waitForTimeout(500);

        const newSizeRows = await page.locator('.expand-view-item').all();
        if (newSizeRows.length > 0) {
          const availableSizes = [];
          for (const row of newSizeRows) {
            const labelText = await row.locator('.item-label').innerText().catch(() => '');
            if (labelText) {
              availableSizes.push({ text: labelText.trim(), row });
            }
          }

          const matchResult = findSizeMatch(item.size, availableSizes);
          if (matchResult.match) {
            targetRow = matchResult.match.row;
          } else if (matchResult.type === 'multiple') {
            throw new Error(`Size ambiguous: ${item.size}`);
          } else {
            throw new Error(`Size not found: ${item.size}`);
          }
        }
      } else {
        throw new Error('No options found');
      }

      if (!targetRow) {
        throw new Error('Could not select option');
      }

      // 수량 입력
      console.log(`  Entering quantity: ${item.quantity}`);
      const inputField = targetRow.locator('.ant-input-number-input');
      await inputField.scrollIntoViewIfNeeded();
      await safeClick(inputField);
      await inputField.fill('');
      await inputField.type(item.quantity.toString(), { delay: 50 });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);

      // 이 아이템 성공 (아직 장바구니 추가 전이지만 옵션 선택 완료)
      item.optionSelected = true;
      console.log(`  + Option & quantity set for this item`);

    } catch (error) {
      // 봇 챌린지 감지 시: 이 아이템 + 같은 그룹의 미처리 아이템을 모두 표시하고 상위로 전파
      if (error && error.name === 'BotChallengeError') {
        console.log(`  *** BOT CHALLENGE DETECTED — aborting this group ***`);
        item.optionSelected = false;
        item.error = error.message;
        // 현재 아이템 + 아직 손대지 않은 같은 그룹 아이템들 일괄 실패 마킹
        items.forEach(it => {
          if (it.optionSelected === true) return; // 이미 옵션 선택 끝난 건 그대로
          it.orderIndices.forEach(idx => {
            onProgress({ index: idx, status: 'error', errorReason: 'Bot challenge detected — stopped' });
          });
        });
        throw error; // processOrders 외부 루프가 잡아서 전체 중단
      }

      console.log(`  X FAILED: ${error.message}`);
      item.optionSelected = false;
      item.error = error.message;

      // 이 아이템의 모든 주문을 실패 처리
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: error.message });
      });
    }
  }

  // 4. 성공한 옵션이 하나라도 있으면 장바구니 추가
  const successItems = items.filter(item => item.optionSelected);

  if (successItems.length === 0) {
    console.log(`\nNo options selected successfully, skipping cart`);
    return;
  }

  console.log(`\n${successItems.length}/${items.length} options selected, checking shipping fee...`);

  // 배송비 체크
  const shippingCheck = await checkShippingFee(page);
  if (shippingCheck.warning) {
    console.log(`X High shipping fee detected, marking as error`);
    successItems.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: shippingCheck.message });
      });
    });
    return;
  }

  console.log(`Shipping fee OK, adding to cart...`);

  // 장바구니 버튼 찾기
  let addCartBtn = page.locator('button[data-click="ADD_CART"]');
  if (await addCartBtn.count() === 0) {
    addCartBtn = page.locator('button:has-text("加采购车")');
  }
  if (await addCartBtn.count() === 0) {
    addCartBtn = page.locator('button.v-button:has-text("加采购车")');
  }

  if (await addCartBtn.count() === 0) {
    console.log(`X Cart button not found`);
    successItems.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: 'Cart button not found' });
      });
    });
    return;
  }

  // 기존 모달 정리 후 장바구니 추가 + 새 모달 검증
  const cartResult = await clickAndWaitForNewModal(page, addCartBtn);

  if (cartResult.success) {
    console.log(`SUCCESS! Added to cart`);

    successItems.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'success', shippingInfo: shippingCheck.infoMessage });
      });
    });

    // 다음 그룹을 위해 성공 모달 정리
    await dismissSuccessModal(page);

  } else {
    console.log(`X Cart add failed: ${cartResult.error}`);
    successItems.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: cartResult.error || 'Add to cart failed' });
      });
    });
  }
}

// 전체 주문 처리
async function processOrders(orders, onProgress) {
  console.log('\n========================================');
  console.log('ORDER PROCESSING STARTED');
  console.log(`Total: ${orders.length} orders`);
  console.log('========================================');

  // 동일 offer_id로 그룹화
  const groups = groupOrdersByOfferId(orders);
  console.log(`\nGrouped into ${groups.length} unique products`);
  groups.forEach((g, i) => {
    console.log(`  ${i + 1}. offer_id=${g.offerId}: ${g.items.length} option(s)`);
  });

  // Chrome 연결
  console.log('\nConnecting to Chrome...');
  let browser = await tryConnectChrome(1);

  if (!browser) {
    console.log('Launching Chrome in debug mode...');
    const chromePath = findChromePath();
    if (!chromePath) {
      console.log('X Chrome not found');
      throw new Error('Chrome not found');
    }

    await launchChromeDebug(chromePath);
    browser = await tryConnectChrome(3);

    if (!browser) {
      console.log('X Cannot connect to Chrome');
      throw new Error('Cannot connect to Chrome');
    }
  }

  console.log('+ Chrome connected\n');

  const context = browser.contexts()[0];
  const page = await context.newPage();

  // Stealth 스크립트 적용
  await applyStealthScripts(page);

  // 중단 플래그 초기화
  shouldStop = false;

  try {
    for (let i = 0; i < groups.length; i++) {
      // 중단 확인
      if (shouldStop) {
        console.log('\n*** STOPPED BY USER ***');
        throw new Error('STOPPED_BY_USER');
      }

      const group = groups[i];
      console.log(`\n[Group ${i + 1}/${groups.length}] Processing...`);

      try {
        await processGroupOrder(page, group, onProgress);
      } catch (e) {
        // 봇 챌린지 감지: 남은 그룹 전부 에러 표시 후 즉시 중단 (차단 방지)
        if (e && e.name === 'BotChallengeError') {
          console.log('\n*** BOT CHALLENGE DETECTED — STOPPING ALL ORDERS TO AVOID BLOCK ***');
          for (let j = i + 1; j < groups.length; j++) {
            groups[j].items.forEach(item => {
              item.orderIndices.forEach(idx => {
                onProgress({ index: idx, status: 'error', errorReason: 'Bot challenge detected — stopped' });
              });
            });
          }
          shouldStop = true;
          break;
        }
        throw e;
      }

      // 다음 그룹 전 잠시 대기
      if (i < groups.length - 1) {
        await page.waitForTimeout(1000);

        if (shouldStop) {
          console.log('\n*** STOPPED BY USER ***');
          throw new Error('STOPPED_BY_USER');
        }
      }
    }
  } finally {
    console.log('\nALL ORDERS PROCESSED');
    console.log('Browser window kept open for review');
    shouldStop = false;
  }

  return orders;
}

// 검수 프로세스 (카트 확인 및 전체 선택)
async function startReview(orders, onReviewProgress) {
  console.log('\n========================================');
  console.log('REVIEW PROCESS STARTED');
  console.log(`Orders to verify: ${orders.length}`);
  console.log('========================================');

  // Chrome 연결
  console.log('\nConnecting to Chrome...');
  let browser = await tryConnectChrome(1);

  if (!browser) {
    console.log('X Chrome not connected');
    throw new Error('Chrome not connected. Please ensure the browser is still open.');
  }

  console.log('+ Chrome connected\n');

  const context = browser.contexts()[0];
  const pages = context.pages();

  // 가장 최근에 사용한 페이지 찾기
  let page = pages[pages.length - 1];

  try {
    // 1. 카트 페이지로 직접 이동
    console.log('Step 1: Navigating to cart page...');
    await page.goto('https://cart.1688.com/cart.htm', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    console.log('+ Navigated to cart page');

    // 카트 아이템이 로드될 때까지 대기
    console.log('  Waiting for cart items to load...');
    try {
      // 카트 아이템 링크가 나타날 때까지 대기
      await page.waitForSelector('a[href*="detail.1688.com/offer/"]', { timeout: 10000 });
      console.log('+ Cart items found');
    } catch (e) {
      console.log('  Warning: Cart items not found, continuing anyway...');
    }
    await page.waitForTimeout(2000);  // 추가 로딩 대기
    console.log('+ Page loaded');

    // 2. 페이지 맨 아래까지 천천히 스크롤 (동적 데이터 로딩)
    console.log('\nStep 2: Scrolling to bottom...');
    await smoothScrollToBottom(page);
    console.log('+ Scrolled to bottom');

    // 3. 페이지 맨 위로 스크롤
    console.log('\nStep 3: Scrolling to top...');
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await page.waitForTimeout(1500);
    console.log('+ Scrolled to top');

    // 4. "全选" 체크박스 선택 + 폴링
    console.log('\nStep 4: Selecting "全选" checkbox...');
    await selectAllCheckbox(page);

    // 체크박스 DOM 반영 폴링 (1초 × 30 = 최대 30초)
    let checkboxReady = false;
    for (let pollCount = 0; pollCount < 30; pollCount++) {
      await page.waitForTimeout(1000);
      checkboxReady = await page.evaluate(() => {
        const wrappers = document.querySelectorAll(
          '[class*="item-group-container--container"] .next-checkbox-wrapper'
        );
        if (wrappers.length === 0) return false;
        let checkedCount = 0;
        let activeCount = 0;
        for (const wrapper of wrappers) {
          const input = wrapper.querySelector('input.next-checkbox-input');
          if (input && input.disabled) continue;
          activeCount++;
          if (wrapper.classList.contains('checked')) checkedCount++;
        }
        return activeCount > 0 && checkedCount === activeCount;
      });
      if (checkboxReady) break;
    }
    console.log(checkboxReady
      ? '+ All checkboxes confirmed checked'
      : '! Warning: Some checkboxes may not be checked after 30s');

    // 5. 카트 데이터 추출 (체크 상태 미반영 시 재시도)
    console.log('\nStep 5: Extracting cart data...');
    let cartItems = await extractCartData(page);
    console.log(`+ Extracted ${cartItems.length} items from cart`);

    const maxRetries = 5;
    for (let retry = 1; retry <= maxRetries; retry++) {
      const activeItems = cartItems.filter(item => !item.isDisabled);
      const uncheckedItems = activeItems.filter(item => !item.isChecked);
      const uncheckedRate = activeItems.length > 0 ? uncheckedItems.length / activeItems.length : 0;

      console.log(`  Checkbox status: ${activeItems.length - uncheckedItems.length}/${activeItems.length} checked (unchecked rate: ${(uncheckedRate * 100).toFixed(1)}%)`);

      if (uncheckedRate === 0) {
        console.log('+ All checkboxes checked');
        break;
      }

      // 일부/전부 미체크 → 로딩 중으로 판단, 재시도
      console.log(`  ${uncheckedItems.length} checkboxes still unchecked (retry ${retry}/${maxRetries})...`);
      await page.waitForTimeout(2000);
      cartItems = await extractCartData(page);
      console.log(`+ Re-extracted ${cartItems.length} items from cart`);
    }

    // 디버깅: 추출된 아이템 로그
    if (cartItems.length > 0) {
      console.log('  Cart items found:');
      cartItems.forEach((item, idx) => {
        console.log(`    [${idx + 1}] offerId=${item.offerId}, color=${item.color}, size=${item.size}, qty=${item.quantity}`);
      });
    } else {
      // 카트가 비어있으면 페이지 구조 디버깅
      console.log('  No cart items extracted. Debugging page structure...');
      const debugInfo = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="detail.1688.com/offer/"]');
        const linksInfo = [];
        links.forEach((link, i) => {
          if (i < 5) {
            linksInfo.push({
              href: link.getAttribute('href'),
              text: link.textContent?.substring(0, 50)
            });
          }
        });
        return {
          linkCount: links.length,
          links: linksInfo,
          bodyPreview: document.body.innerText.substring(0, 300)
        };
      });
      console.log(`    Found ${debugInfo.linkCount} offer links`);
      debugInfo.links.forEach((l, i) => {
        console.log(`    Link ${i + 1}: ${l.href}`);
      });
    }

    // 6. 주문 데이터와 비교
    console.log('\nStep 6: Comparing with order data...');
    const comparisonResults = compareOrdersWithCart(orders, cartItems, onReviewProgress);

    console.log('\n========================================');
    console.log('REVIEW PROCESS COMPLETED');
    console.log(`Matched: ${comparisonResults.matched}, Mismatched: ${comparisonResults.mismatched}, Not Found: ${comparisonResults.notFound}`);
    console.log('========================================');

    return { success: true, cartItems, comparisonResults };

  } catch (error) {
    console.log(`\nX Review failed: ${error.message}`);
    throw error;
  }
}

// 주문 데이터와 카트 데이터 비교 함수 (그룹화 버전 - 일괄 처리)
function compareOrdersWithCart(orders, cartItems, onReviewProgress) {
  console.log('  Comparing orders with cart items (grouped by offer_id + option)...');

  let matched = 0;
  let mismatched = 0;
  let notFound = 0;

  // 결과를 일괄 저장할 배열
  const allResults = [];

  // 1. 주문 데이터를 offer_id + 색상 + 사이즈로 그룹화
  const orderGroups = {};
  orders.forEach((order, index) => {
    const orderUrlMatch = order.url.match(/offer\/(\d+)\.html/);
    const offerId = orderUrlMatch ? orderUrlMatch[1] : '';

    if (!offerId) {
      console.log(`  [${index + 1}] Order ${order.orderNo}: Cannot extract offer_id from URL`);
      notFound++;
      allResults.push({
        index,
        reviewStatus: 'error',
        reviewResult: { notFound: true, message: 'URL 오류' }
      });
      return;
    }

    // 그룹 키: offerId + 색상 + 사이즈
    const groupKey = `${offerId}|${order.color}|${order.size}`;

    if (!orderGroups[groupKey]) {
      orderGroups[groupKey] = {
        offerId,
        color: order.color,
        size: order.size,
        totalQuantity: 0,
        orderIndices: []
      };
    }

    orderGroups[groupKey].totalQuantity += order.quantity;
    orderGroups[groupKey].orderIndices.push(index);
  });

  console.log(`  Grouped into ${Object.keys(orderGroups).length} unique option groups`);

  // 매칭된 카트 아이템 추적용 Set
  const matchedCartItems = new Set();

  // 2. 각 그룹별로 카트 데이터와 비교
  Object.values(orderGroups).forEach(group => {
    const { offerId, color, size, totalQuantity, orderIndices } = group;

    console.log(`\n  Group: offerId=${offerId}, color=${color}, size=${size}, totalQty=${totalQuantity}`);
    console.log(`    Order indices: ${orderIndices.join(', ')}`);

    // 카트에서 해당 offer_id를 가진 아이템들 찾기 (이미 매칭된 아이템 제외)
    const allItemsWithOfferId = cartItems.filter(item => item.offerId === offerId);
    const candidateItems = allItemsWithOfferId.filter(item => !matchedCartItems.has(item));

    if (allItemsWithOfferId.length > candidateItems.length) {
      console.log(`    Filtered out ${allItemsWithOfferId.length - candidateItems.length} already-matched cart item(s)`);
    }

    if (candidateItems.length === 0) {
      const reason = allItemsWithOfferId.length === 0
        ? 'no matching offer_id'
        : 'all matching items already used';
      console.log(`    NOT FOUND in cart (${reason})`);
      notFound += orderIndices.length;
      orderIndices.forEach(idx => {
        allResults.push({
          index: idx,
          reviewStatus: 'error',
          reviewResult: { notFound: true, message: '카트에 없음' }
        });
      });
      return;
    }

    // 색상+사이즈로 가장 적합한 아이템 찾기
    let cartItem = null;
    let sizeMatchResult = null;
    let colorMatchResult = null;
    let isReversed = false; // 리버스 검수 여부 추적

    for (const item of candidateItems) {
      // 색상 매칭 결과 확인
      const colorResult = checkColorMatch(item.color || '', color || '');

      // 색상이 완전히 다르면 스킵
      if (colorResult.type === 'not-found') continue;

      // 사이즈 매칭 결과 확인
      const sizeResult = checkSizeMatch(item.size || '', size || '');

      // 둘 다 정확히 일치하는 것 우선
      if (colorResult.match && sizeResult.match) {
        cartItem = item;
        colorMatchResult = colorResult;
        sizeMatchResult = sizeResult;
        break;
      }

      // 부분 일치라도 일단 저장 (나중에 불일치로 처리)
      // 단, 색상과 사이즈 둘 다 최소한 partial 이상이어야 함 (not-found는 안 됨)
      if (!cartItem) {
        const colorNotFound = colorResult.type === 'not-found';
        const sizeNotFound = sizeResult.type === 'not-found';

        // 둘 다 not-found가 아닐 때만 부분 일치로 인정
        if (!colorNotFound && !sizeNotFound) {
          cartItem = item;
          colorMatchResult = colorResult;
          sizeMatchResult = sizeResult;
        }
      }
    }

    // 찾지 못한 경우 색상과 사이즈를 바꿔서 다시 시도
    if (!cartItem) {
      console.log(`    NOT FOUND with color=${color}, size=${size}`);
      console.log(`    Trying reversed: color=${size}, size=${color}`);

      let partialMatch = null; // 부분 일치 임시 저장

      for (const item of candidateItems) {
        // 색상 자리에 사이즈를, 사이즈 자리에 색상을 넣어서 비교
        const colorResult = checkColorMatch(item.color || '', size || '');

        // 색상이 완전히 다르면 스킵
        if (colorResult.type === 'not-found') continue;

        // 사이즈 매칭 결과 확인
        const sizeResult = checkSizeMatch(item.size || '', color || '');

        // Reversed 매칭: 정확히 일치하는 것 우선
        if (colorResult.match && sizeResult.match) {
          cartItem = item;
          colorMatchResult = colorResult;
          sizeMatchResult = sizeResult;
          isReversed = true; // 리버스 검수로 매칭됨
          console.log(`    + Found with REVERSED order! cart: ${item.color}; ${item.size}`);
          break; // 정확한 매칭 찾으면 즉시 종료
        }

        // 부분 일치는 임시 저장만 (계속 검색)
        // 단, 색상과 사이즈 둘 다 최소한 partial 이상이어야 함 (not-found는 안 됨)
        if (!partialMatch) {
          const colorNotFound = colorResult.type === 'not-found';
          const sizeNotFound = sizeResult.type === 'not-found';

          // 둘 다 not-found가 아닐 때만 부분 일치로 인정
          if (!colorNotFound && !sizeNotFound) {
            partialMatch = { item, colorResult, sizeResult };
          }
        }
      }

      // 정확한 매칭을 못 찾았고 부분 일치가 있으면 사용
      if (!cartItem && partialMatch) {
        cartItem = partialMatch.item;
        colorMatchResult = partialMatch.colorResult;
        sizeMatchResult = partialMatch.sizeResult;
        isReversed = true; // 리버스 검수로 매칭됨
        console.log(`    + Found partial/number match with REVERSED order (no exact match found)`);
      }
    }

    // 여전히 찾지 못한 경우
    if (!cartItem) {
      console.log(`    NOT FOUND in cart (even after reversing color/size)`);
      notFound += orderIndices.length;
      orderIndices.forEach(idx => {
        allResults.push({
          index: idx,
          reviewStatus: 'error',
          reviewResult: { notFound: true, message: '카트에 없음' }
        });
      });
      return;
    }

    console.log(`    Found in cart: color=${cartItem.color}, size=${cartItem.size}, qty=${cartItem.quantity}, isDisabled=${cartItem.isDisabled}`);

    // 매칭된 카트 아이템을 Set에 추가하여 중복 매칭 방지
    matchedCartItems.add(cartItem);

    // 체크박스가 체크되지 않은 경우 체크 오류로 처리
    if (!cartItem.isChecked) {
      console.log(`    CHECKBOX NOT CHECKED - Cannot order this item (isChecked=${cartItem.isChecked}, isDisabled=${cartItem.isDisabled})`);
      notFound += orderIndices.length;
      orderIndices.forEach(idx => {
        allResults.push({
          index: idx,
          reviewStatus: 'error',
          reviewResult: { notFound: true, message: '체크 오류', cartItem }
        });
      });
      return;
    }

    // 비교 수행
    const mismatches = [];

    // 수량 비교 (그룹 전체 수량과 카트 수량 비교)
    if (cartItem.quantity !== totalQuantity) {
      mismatches.push({
        field: 'quantity',
        cart: cartItem.quantity,
        order: totalQuantity
      });
      console.log(`    Quantity MISMATCH - Cart: ${cartItem.quantity}, Order Total: ${totalQuantity}`);
    }

    // 색상 비교 (엄격한 매칭)
    if (colorMatchResult && !colorMatchResult.match) {
      mismatches.push({
        field: 'color',
        cart: colorMatchResult.cartValue || cartItem.color,
        order: color,
        matchType: colorMatchResult.type  // 'partial' 또는 'not-found'
      });
      console.log(`    Color MISMATCH (${colorMatchResult.type}) - Cart: ${cartItem.color}, Order: ${color}`);
    }

    // 사이즈 비교 (엄격한 매칭)
    if (sizeMatchResult && !sizeMatchResult.match) {
      mismatches.push({
        field: 'size',
        cart: sizeMatchResult.cartValue || cartItem.size,
        order: size,
        matchType: sizeMatchResult.type  // 'partial' 또는 'number-match'
      });
      console.log(`    Size MISMATCH (${sizeMatchResult.type}) - Cart: ${cartItem.size}, Order: ${size}`);
    }

    // 그룹 내 모든 주문에 결과 적용
    if (mismatches.length > 0) {
      mismatched += orderIndices.length;
      orderIndices.forEach(idx => {
        allResults.push({
          index: idx,
          reviewStatus: 'mismatch',
          reviewResult: { mismatches, cartItem, isReversed }
        });
      });
    } else {
      matched += orderIndices.length;
      console.log(`    OK - All ${orderIndices.length} orders matched`);
      orderIndices.forEach(idx => {
        allResults.push({
          index: idx,
          reviewStatus: 'ok',
          reviewResult: { cartItem, isReversed }
        });
      });
    }
  });

  console.log(`\n  Comparison complete: ${matched} matched, ${mismatched} mismatched, ${notFound} not found`);

  // 모든 결과를 한 번에 전송 (batch 모드)
  console.log(`  Sending ${allResults.length} results in batch mode...`);
  onReviewProgress({ batch: true, results: allResults });

  return { matched, mismatched, notFound };
}

// 사이즈 매칭 체크 함수
// 검수용 엄격한 사이즈 매칭 (정확히 일치, XL변환, FREE/均码만 허용)
function checkSizeMatch(cartSize, orderSize) {
  // 둘 다 비어있거나 사이즈가 없는 경우 - 매칭 성공 (색상만 있는 상품)
  if (!cartSize && !orderSize) {
    return { match: true, type: 'no-size' };
  }

  // 카트에 사이즈가 없는데 주문에 사이즈가 있는 경우 - 매칭 성공 (색상만 있는 상품으로 간주)
  if (!cartSize && orderSize) {
    return { match: true, type: 'no-size' };
  }

  // 1. 정확히 일치
  if (cartSize === orderSize) {
    return { match: true, type: 'exact' };
  }

  // 3. XL 변환 체크 (2XL <-> XXL) - 정확히 일치만
  const convertedSize = convertXLSize(orderSize);
  if (convertedSize && cartSize === convertedSize) {
    return { match: true, type: 'xl-convert' };
  }

  // 4. FREE <-> 均码 (프리사이즈 동의어)
  const freeSizeAliases = ['FREE', '균码', '均码', 'F', 'FREESIZE', 'OneSize', 'OS'];
  const orderIsFree = freeSizeAliases.some(alias => orderSize.toUpperCase() === alias.toUpperCase());
  const cartIsFree = freeSizeAliases.some(alias => cartSize.toUpperCase().includes(alias.toUpperCase()));
  if (orderIsFree && cartIsFree) {
    return { match: true, type: 'free-size' };
  }

  // 2. 부분 일치 - 불허용 (불일치로 표시, 카트 값 알려줌)
  if (cartSize.includes(orderSize) || orderSize.includes(cartSize)) {
    return { match: false, type: 'partial', cartValue: cartSize };
  }

  // 5. 단위(cm, 码 등) 제거 후 비교 - 단위만 다르고 값이 같으면 매칭 성공
  const sizeUnits = /\s*(cm|码|岁|个月|mm|m|號|号|yd|inch|寸)\s*/gi;
  const orderStripped = orderSize.replace(sizeUnits, '').trim();
  const cartStripped = cartSize.replace(sizeUnits, '').trim();
  if (orderStripped && cartStripped && orderStripped === cartStripped) {
    return { match: true, type: 'unit-normalize', cartValue: cartSize };
  }

  // 6. 숫자 추출 비교 - 불허용 (불일치로 표시, 카트 값 알려줌)
  const orderNum = extractNumber(orderSize);
  const cartNum = extractNumber(cartSize);
  if (orderNum && cartNum && orderNum === cartNum) {
    return { match: false, type: 'number-match', cartValue: cartSize };
  }

  // 완전히 다름
  return { match: false, type: 'not-found', cartValue: cartSize };
}

// 색상 매칭 체크 함수 (검수용 엄격한 색상 매칭)
function checkColorMatch(cartColor, orderColor) {
  // 공백 정규화 (연속 공백 → 단일 공백, 양쪽 공백 제거)
  const normalizedCart = (cartColor || '').replace(/\s+/g, ' ').trim();
  const normalizedOrder = (orderColor || '').replace(/\s+/g, ' ').trim();

  // 둘 다 비어있는 경우 - 매칭 성공
  if (!normalizedCart && !normalizedOrder) {
    return { match: true, type: 'no-color' };
  }

  // 하나만 비어있는 경우 - 불일치
  if (!normalizedCart || !normalizedOrder) {
    return { match: false, type: 'not-found', cartValue: cartColor || '' };
  }

  // 1. 정확히 일치 (공백 정규화 후)
  if (normalizedCart === normalizedOrder) {
    return { match: true, type: 'exact' };
  }

  // 2. 부분 일치 - 불허용 (불일치로 표시, 카트 값 알려줌)
  if (normalizedCart.includes(normalizedOrder) || normalizedOrder.includes(normalizedCart)) {
    return { match: false, type: 'partial', cartValue: cartColor };
  }

  // 3. 단위(cm, 码 등) 제거 후 비교 (리버스 검수에서 사이즈가 color 자리에 올 때)
  const sizeUnits = /\s*(cm|码|岁|个月|mm|m|號|号|yd|inch|寸)\s*/gi;
  const cartStripped = normalizedCart.replace(sizeUnits, '').trim();
  const orderStripped = normalizedOrder.replace(sizeUnits, '').trim();
  if (cartStripped && orderStripped && cartStripped === orderStripped) {
    return { match: true, type: 'unit-normalize' };
  }

  // 완전히 다름
  return { match: false, type: 'not-found', cartValue: cartColor };
}

// 전체 선택 체크박스 클릭 함수
async function selectAllCheckbox(page) {
  // 모든 "全选" 체크박스 찾기 (판매자별로 여러 개 있을 수 있음)
  const checkboxes = page.locator('label.next-checkbox-wrapper:has-text("全选") input.next-checkbox-input');

  const checkboxCount = await checkboxes.count();
  console.log(`  Found ${checkboxCount} "全选" checkboxes`);

  if (checkboxCount === 0) {
    // 대체 선택자 시도
    console.log('  Trying alternative selectors...');
    const altCheckboxes = page.locator('label:has-text("全选") input[type="checkbox"]');
    const altCount = await altCheckboxes.count();
    console.log(`  Alternative: found ${altCount} checkboxes`);

    // 모든 대체 체크박스 클릭
    for (let i = 0; i < altCount; i++) {
      const cb = altCheckboxes.nth(i);
      const isChecked = await cb.isChecked().catch(() => false);
       if (!isChecked) {
        await cb.click({ force: true });
        await page.waitForTimeout(300);
        console.log(`+ Checkbox ${i + 1}/${altCount} selected (alternative)`);
      } else {
        console.log(`+ Checkbox ${i + 1}/${altCount} already selected`);
      }
    }
    return;
  }

  // 모든 "全选" 체크박스 클릭
  let selectedCount = 0;
  for (let i = 0; i < checkboxCount; i++) {
    const checkboxElement = checkboxes.nth(i);
    const isDisabled = await checkboxElement.isDisabled().catch(() => false);
    const isChecked = await checkboxElement.isChecked().catch(() => false);

    console.log(`  Checkbox ${i + 1}/${checkboxCount}: disabled=${isDisabled}, checked=${isChecked}`);

    if (isChecked) {
      console.log(`+ Checkbox ${i + 1} already selected`);
      selectedCount++;
    } else if (!isDisabled) {
      await checkboxElement.click({ force: true });
      await page.waitForTimeout(300);
      console.log(`+ Checkbox ${i + 1} selected`);
      selectedCount++;
    } else {
      console.log(`  Checkbox ${i + 1} is disabled, skipping`);
    }
  }

  console.log(`+ Total ${selectedCount}/${checkboxCount} checkboxes selected`);
}

// 카트 데이터 추출 함수
async function extractCartData(page) {
  console.log('  Parsing cart items...');

  const cartItems = await page.evaluate(() => {
    const items = [];

    // 체크박스가 있는 td 요소들을 찾아서 각 아이템 처리
    // 각 아이템은 item--checkbox 클래스를 가진 label이 있는 td에서 시작
    const checkboxLabels = document.querySelectorAll('label[class*="item--checkbox"]');

    checkboxLabels.forEach(label => {
      // 체크 상태 확인 (label 클래스 또는 input.checked 병용)
      const cbInput = label.querySelector('input[type="checkbox"]');
      const isChecked = label.classList.contains('checked')
                     || label.classList.contains('next-checkbox-checked')
                     || (cbInput ? cbInput.checked : false);
      // 체크박스 disabled 상태 확인
      const isDisabled = label.classList.contains('disabled')
                      || label.classList.contains('next-checkbox-disabled')
                      || (cbInput ? cbInput.disabled : false);

      // td 요소 찾기 (체크박스가 있는 셀)
      const td = label.closest('td');
      if (!td) return;

      // 같은 td 안에서 옵션 텍스트 찾기 (item--titleText)
      const titleTextEl = td.querySelector('[class*="titleText"]');
      let color = '';
      let size = '';

      if (titleTextEl) {
        const optionText = titleTextEl.textContent?.trim() || '';
        if (optionText.includes(';')) {
          const parts = optionText.split(';').map(s => s.trim());
          color = parts[0] || '';
          size = parts[1] || '';
        } else if (optionText) {
          // 세미콜론 없으면 color로 취급
          color = optionText;
          size = '';
        }
      }

      // 이미지 URL 찾기
      const imgEl = td.querySelector('img');
      let imgUrl = '';
      if (imgEl) {
        imgUrl = imgEl.getAttribute('src') || '';
        // _160x160.jpg_.webp 제거
        imgUrl = imgUrl.replace(/_\d+x\d+\.jpg_?\.webp$/, '');
      }

      // tr 요소 찾기 (행 전체)
      const tr = td.closest('tr');
      if (!tr) return;

      // 상위에서 shop 컨테이너 찾기 (판매자 정보)
      let sellerName = '';
      const shopContainer = tr.closest('[class*="shop-container"]');
      if (shopContainer) {
        const sellerLink = shopContainer.querySelector('a[class*="companyName"]');
        if (sellerLink) {
          sellerName = sellerLink.textContent?.trim() || '';
        }
      }

      // 같은 shop 컨테이너 또는 item-group에서 상품 링크 찾기
      let offerId = '';
      let productUrl = '';
      let productName = '';

      const itemGroup = tr.closest('[class*="item-group"]');
      if (itemGroup) {
        const titleLink = itemGroup.querySelector('a[class*="title"][href*="detail.1688.com/offer/"]');
        if (titleLink) {
          productUrl = titleLink.getAttribute('href') || '';
          productName = titleLink.textContent?.trim() || '';
          const offerMatch = productUrl.match(/offer\/(\d+)\.html/);
          if (offerMatch) {
            offerId = offerMatch[1];
          }
        }
      }

      if (!offerId) return;

      // 수량 찾기 - tr 내에서 input 찾기
      let quantity = 0;
      const qtyInput = tr.querySelector('input[aria-valuemin]');
      if (qtyInput) {
        quantity = parseInt(qtyInput.value) || 0;
      }

      // 단가 찾기 (쉼표 제거 후 파싱)
      let unitPrice = 0;
      const priceEl = tr.querySelector('[class*="rebatePrice"]');
      if (priceEl) {
        const priceText = priceEl.textContent?.trim().replace(/,/g, '') || '0';
        unitPrice = parseFloat(priceText) || 0;
      }

      // 소계 찾기 (쉼표 제거 후 파싱)
      let subtotal = 0;
      const subtotalEl = tr.querySelector('[class*="subtotal"]');
      if (subtotalEl) {
        const subtotalText = subtotalEl.textContent?.trim().replace(/,/g, '') || '0';
        subtotal = parseFloat(subtotalText) || 0;
      }

      items.push({
        sellerName,
        productName,
        productUrl,
        offerId,
        imgUrl,
        color,
        size,
        quantity,
        unitPrice,
        subtotal,
        isChecked,
        isDisabled
      });
    });

    return items;
  });

  // 추출된 데이터 로그 출력
  console.log('\n  ========== Cart Items ==========');
  cartItems.forEach((item, idx) => {
    console.log(`  [${idx + 1}]`);
    console.log(`    check_true = ${item.isChecked}, disabled = ${item.isDisabled}`);
    console.log(`    seller = ${item.sellerName}`);
    console.log(`    img_url = ${item.imgUrl}`);
    console.log(`    url = ${item.productUrl}`);
    console.log(`    offer_id = ${item.offerId}`);
    console.log(`    color = ${item.color}`);
    console.log(`    size = ${item.size || '없음'}`);
    console.log(`    qty = ${item.quantity}`);
    console.log(`    price = ${item.unitPrice.toFixed(2)}`);
    console.log(`    total_price = ${item.subtotal.toFixed(2)}`);
    console.log('');
  });
  console.log('  ==================================\n');

  return cartItems;
}

// 부드럽게 페이지 아래로 스크롤하는 함수 (lazy loading 대응)
async function smoothScrollToBottom(page) {
  console.log('    Starting blast-scroll to bottom...');

  // ── 헬퍼: 현재 페이지 상태 스냅샷 ──
  // scrollHeight + itemCount + shopCount + 로딩 인디케이터 여부를 한 번에 조회
  async function snapshot(triggerScroll) {
    return await page.evaluate((scroll) => {
      if (scroll) window.scrollTo(0, document.body.scrollHeight);
      const indicator = document.querySelector(
        '[class*="loadMoreIndicator"], [class*="loadMoreSpinner"], [class*="next-loading"], [class*="nc-loading"]'
      );
      let loading = false;
      if (indicator) {
        const style = window.getComputedStyle(indicator);
        loading = style.display !== 'none' && style.visibility !== 'hidden' && indicator.offsetHeight > 0;
      }
      return {
        h: document.body.scrollHeight,
        items: document.querySelectorAll('label[class*="item--checkbox"]').length,
        shops: document.querySelectorAll('[class*="shop-container--container"]').length,
        loading
      };
    }, triggerScroll);
  }

  // ── Phase 1: 끝까지 스크롤 + 다중 지표 안정화 대기 ──
  // 조건: scrollHeight + itemCount + shopCount 모두 maxStable(=10)회 연속 동일 + 로딩 인디케이터 없음
  const maxStable = 10;
  const pollInterval = 400;
  const maxBlastMs = 90000;

  let stableCount = 0;
  let prev = { h: 0, items: 0, shops: 0, loading: false };
  let blastCount = 0;
  const blastStart = Date.now();

  while (Date.now() - blastStart < maxBlastMs) {
    blastCount++;
    const snap = await snapshot(true);

    const allSame = snap.h === prev.h && snap.items === prev.items && snap.shops === prev.shops;
    console.log(`    Blast #${blastCount}: h=${snap.h}, items=${snap.items}, shops=${snap.shops}, loading=${snap.loading}, stable=${stableCount}`);

    if (allSame && !snap.loading) {
      stableCount++;
      if (stableCount >= maxStable) {
        console.log(`    All metrics stable for ${maxStable} checks, proceeding to Phase 2...`);
        break;
      }
    } else {
      stableCount = 0; // 변화 감지 또는 로딩 중 → 리셋
    }

    prev = snap;
    await page.waitForTimeout(pollInterval);
  }

  if (Date.now() - blastStart >= maxBlastMs) {
    console.log('    Blast phase timeout (90s)');
  }

  // ── Phase 2: 로딩 인디케이터 잔류 확인 (새 아이템 추가 감지 시 Phase 1 복귀) ──
  for (let waitCount = 0; waitCount < 15; waitCount++) {
    const snap = await snapshot(false);
    if (!snap.loading && snap.items === prev.items && snap.shops === prev.shops) break;

    console.log(`    Phase 2 wait #${waitCount + 1}: loading=${snap.loading}, items=${snap.items}, shops=${snap.shops}`);
    // 여전히 로딩 중이거나 새 컨텐츠가 나타나면 스크롤 한 번 더 트리거
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    prev = snap;
  }

  // ── Phase 3: 최종 안정화 대기 + 결과 로깅 ──
  await page.waitForTimeout(1500);

  const final = await snapshot(false);
  console.log(`    Final: items=${final.items}, shops=${final.shops}, scrollHeight=${final.h}`);
}

// 중단 함수
function stopProcessing() {
  shouldStop = true;
  console.log('Stop signal received');
}

// 중단 체크 헬퍼 (shouldStop이면 즉시 예외 발생)
function checkShouldStop() {
  if (shouldStop) {
    console.log('\n*** STOPPED BY USER ***');
    throw new Error('STOPPED_BY_USER');
  }
}

// ========================================
// 장시간 Playwright 작업을 shouldStop 체크와 함께 실행
// - asyncFn이 완료될 때까지 500ms 간격으로 checkShouldStop() 호출
// - shouldStop 감지 시 즉시 STOPPED_BY_USER 예외 발생
// - page.goto, page.waitForSelector, page.waitForURL 등에 사용
// ========================================
async function withStopCheck(asyncFn) {
  let done = false;
  let result = null;
  let error = null;

  asyncFn()
    .then(r => { done = true; result = r; })
    .catch(e => { done = true; error = e; });

  while (!done) {
    checkShouldStop();
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (error) throw error;
  return result;
}

// 참조코드 입력 함수 (주문 확인 창에서)
async function inputRefCodes(groupedData) {
  console.log('\n========================================');
  console.log('INPUT REF CODES STARTED');
  console.log(`Groups to process: ${Object.keys(groupedData).length}`);
  console.log('Grouped data:', JSON.stringify(groupedData, null, 2));
  console.log('========================================');

  // Chrome 연결
  console.log('\nConnecting to Chrome...');
  let browser = await tryConnectChrome(1);

  if (!browser) {
    console.log('X Chrome not connected');
    throw new Error('Chrome not connected');
  }

  console.log('+ Chrome connected\n');

  const context = browser.contexts()[0];
  const pages = context.pages();
  let page = pages[pages.length - 1];

  const successGroups = [];
  const successOrderIndexes = []; // 실제 매칭되어 입력된 orderIndex들
  let emptyTextareaCount = 0;
  const emptySellerNames = [];

  try {
    // 현재 페이지가 주문 확인 창인지 확인
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    // 모든 order-inner 영역 찾기
    const orderInners = page.locator('.order-inner');
    const orderCount = await orderInners.count();
    console.log(`\nFound ${orderCount} order(s) on page`);

    // 각 order-inner 처리
    for (let orderIdx = 0; orderIdx < orderCount; orderIdx++) {
      const orderInner = orderInners.nth(orderIdx);
      console.log(`\n=== Processing Order ${orderIdx + 1}/${orderCount} ===`);

      // 이 order 내의 모든 offer-container 찾기
      const offerContainers = orderInner.locator('.offer-container');
      const offerCount = await offerContainers.count();
      console.log(`  Found ${offerCount} offer(s) in this order`);

      // 이 order에 입력할 모든 참조코드 수집
      const allRefCodes = [];

      // 각 offer-container 처리
      for (let offerIdx = 0; offerIdx < offerCount; offerIdx++) {
        const offerContainer = offerContainers.nth(offerIdx);

        // offer_id 추출
        const offerLink = offerContainer.locator('a[href*="offer/"]').first();
        const hasLink = await offerLink.count() > 0;

        if (!hasLink) {
          console.log(`  Offer ${offerIdx + 1}: No offer link found`);
          continue;
        }

        const href = await offerLink.getAttribute('href');
        const offerIdMatch = href.match(/offer\/(\d+)\.html/);

        if (!offerIdMatch) {
          console.log(`  Offer ${offerIdx + 1}: Could not extract offer_id from ${href}`);
          continue;
        }

        const offerId = offerIdMatch[1];
        console.log(`\n  --- Offer ${offerIdx + 1}: ${offerId} ---`);

        // 이 offer_id가 우리 데이터에 있는지 확인
        const groupInfo = groupedData[offerId];
        if (!groupInfo) {
          console.log(`    X Not in our data, skipping`);
          continue;
        }

        console.log(`    ✓ Found in data with ${groupInfo.items.length} item(s)`);

        // cargo-container 찾기
        const cargoContainers = offerContainer.locator('.cargo-container');
        const cargoCount = await cargoContainers.count();
        console.log(`    Found ${cargoCount} cargo(s)`);

        // 각 cargo 처리
        for (let cargoIdx = 0; cargoIdx < cargoCount; cargoIdx++) {
          const cargoContainer = cargoContainers.nth(cargoIdx);

          // 옵션 정보 추출
          const cargoSpec = cargoContainer.locator('.cargo-spec');
          const hasSpec = await cargoSpec.count() > 0;

          if (!hasSpec) {
            console.log(`      Cargo ${cargoIdx + 1}: No spec found`);
            continue;
          }

          const specText = await cargoSpec.textContent();
          console.log(`      Cargo ${cargoIdx + 1} spec: "${specText}"`);

          // 색상과 사이즈 추출
          let color = '';
          let size = '';

          const specParts = specText.split(';').map(s => s.trim());
          for (const part of specParts) {
            if (part.includes('颜色:') || part.includes('色:')) {
              color = part.replace(/颜色:|色:/g, '').trim();
            } else if (part.includes('尺码:') || part.includes('码:')) {
              size = part.replace(/尺码:|码:/g, '').trim();
            }
          }

          console.log(`      Extracted: Color="${color}", Size="${size}"`);

          // 프리사이즈 동의어 목록
          const freeSizeAliases = ['FREE', 'free', 'Free', '균码', '均码', 'F', '프리', '프리사이즈', 'FREESIZE', 'OneSize', 'OS'];

          // 프리사이즈 여부 확인 함수
          const isFreeSize = (s) => freeSizeAliases.some(alias => s.toUpperCase().includes(alias.toUpperCase()));

          // 매칭되는 아이템 찾기 (부분 매칭 허용)
          // 공백 정규화 (연속 공백 → 단일 공백)
          const normalizedColor = color.replace(/\s+/g, ' ').trim();

          const matchingItems = groupInfo.items.filter(item => {
            // 색상은 정확히 일치 (공백 정규화 적용)
            const normalizedItemColor = (item.color || '').replace(/\s+/g, ' ').trim();
            const colorMatch = normalizedItemColor === normalizedColor;

            // 사이즈 매칭: 프리사이즈 동의어 처리 + 부분 매칭 (공백 정규화 적용)
            let sizeMatch = false;
            const normalizedItemSize = (item.size || '').replace(/\s+/g, ' ').trim();
            const normalizedSize = size.replace(/\s+/g, ' ').trim();
            const itemIsFree = isFreeSize(normalizedItemSize);
            const cargoIsFree = isFreeSize(normalizedSize);

            if (itemIsFree && cargoIsFree) {
              // 둘 다 프리사이즈면 매칭
              sizeMatch = true;
            } else if (normalizedSize.includes(normalizedItemSize) || normalizedItemSize.includes(normalizedSize)) {
              // 부분 매칭 (예: "L"이 "L适合120-140斤"에 포함되는지)
              sizeMatch = true;
            } else if (normalizedItemSize === normalizedSize) {
              // 정확히 일치
              sizeMatch = true;
            }

            console.log(`        Comparing Item(${normalizedItemColor}|${normalizedItemSize}) vs Cargo(${normalizedColor}|${normalizedSize}) = ${colorMatch && sizeMatch}`);
            return colorMatch && sizeMatch;
          });

          if (matchingItems.length > 0) {
            console.log(`      ✓ Found ${matchingItems.length} matching item(s)`);
            // 매칭된 항목들을 수집 (중복 방지)
            matchingItems.forEach(item => {
              // 이미 추가된 orderIndex는 스킵 (중복 방지)
              if (item.orderIndex !== undefined && successOrderIndexes.includes(item.orderIndex)) {
                console.log(`        Skipped (already added): orderIndex ${item.orderIndex}`);
                return;
              }

              // 아이템 객체를 수집 (리스트 순서 유지)
              allRefCodes.push({
                orderCode: item.orderCode,
                orderNoDatePart: item.orderNoDatePart,
                orderNoRestPart: item.orderNoRestPart,
                quantity: item.quantity,
                orderIndex: item.orderIndex
              });
              // 매칭 성공한 orderIndex 기록 (제출 확인 후 success 리스트에 병합)
              if (item.orderIndex !== undefined) {
                currentBatchIndexes.push(item.orderIndex);
              }
              console.log(`        Added: ${item.orderCode} | ${item.orderNoDatePart} | ${item.orderNoRestPart}:${item.quantity} (orderIndex: ${item.orderIndex})`);
            });

            // 성공한 offer_id 추가 (제출 확인 후 success 리스트에 병합)
            if (!currentBatchGroups.includes(offerId)) {
              currentBatchGroups.push(offerId);
            }
          } else {
            console.log(`      X No matching items`);
          }
        }
      }

      // 이 order에 입력할 참조코드가 있으면 textarea에 입력
      if (allRefCodes.length > 0) {
        console.log(`\n  Total ${allRefCodes.length} ref code(s) to input for this order`);

        // 원래 주문 목록 순서대로 정렬 (orderIndex 기준)
        allRefCodes.sort((a, b) => a.orderIndex - b.orderIndex);
        console.log('  Sorted by orderIndex:', allRefCodes.map(i => `${i.orderNoRestPart}:${i.quantity} (idx:${i.orderIndex})`).join(', '));

        // 같은 orderCode + orderNoDatePart 끼리 그룹화 (정렬된 순서 유지)
        const groupedRefCodes = [];
        const groupMap = new Map();

        allRefCodes.forEach(item => {
          const key = `${item.orderCode}|${item.orderNoDatePart}`;
          if (!groupMap.has(key)) {
            const group = {
              orderCode: item.orderCode,
              orderNoDatePart: item.orderNoDatePart,
              restParts: []
            };
            groupMap.set(key, group);
            groupedRefCodes.push(group);
          }
          groupMap.get(key).restParts.push(`${item.orderNoRestPart}:${item.quantity}`);
        });

        // 최종 텍스트 생성: ORBO260121-P25 | BO-260121 | 0004-S31:1, 0004-S32:1, 0004-S33:1
        const memoLines = groupedRefCodes.map(group => {
          return `${group.orderCode} | ${group.orderNoDatePart} | ${group.restParts.join(', ')}`;
        });
        const memoText = memoLines.join('\n');
        console.log(`  Combined memo text:\n${memoText}`);

        // order-footer의 textarea 찾기
        const textarea = orderInner.locator('.order-footer .leave-message-container .q-textarea textarea').first();
        const textareaFound = await textarea.count() > 0;

        console.log(`  Textarea in order-footer found: ${textareaFound}`);

        if (textareaFound) {
          console.log(`  Attempting to input ref codes...`);
          await textarea.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await textarea.click();
          await page.waitForTimeout(200);
          await textarea.fill(memoText);
          await page.waitForTimeout(500);

          // 입력 확인
          const inputValue = await textarea.inputValue();
          console.log(`  Input verification: ${inputValue.length} chars`);

          if (inputValue === memoText) {
            console.log(`  ✓ Ref codes inputted successfully`);
          } else {
            console.log(`  ! Input may not match exactly`);
            console.log(`  Expected length: ${memoText.length}, Got: ${inputValue.length}`);
          }
        } else {
          console.log(`  X Textarea not found in order-footer`);
        }
      } else {
        console.log(`\n  No ref codes to input for this order`);
      }
    }

    // 페이지 전체 textarea 확인 (입력되지 않은 것 찾기)
    console.log('\n--- Checking for empty textareas ---');

    // 입력 실패한 orderIndexes 수집
    const failedOrderIndexes = [];

    // order-group-container 기준으로 다시 찾기 (판매자명 포함)
    const orderGroups = page.locator('.order-group-container');
    const orderGroupCount = await orderGroups.count();

    for (let orderIdx = 0; orderIdx < orderGroupCount; orderIdx++) {
      const orderGroup = orderGroups.nth(orderIdx);

      // 판매자명 찾기 - order-group-header 안의 .shop-link 텍스트
      const shopLink = orderGroup.locator('.order-group-header .shop-title .shop-link').first();
      let sellerName = 'Unknown Seller';

      if (await shopLink.count() > 0) {
        sellerName = await shopLink.innerText().catch(() => 'Unknown Seller');
        sellerName = sellerName.trim();
      }

      // textarea 확인 - order-group-container 안의 order-footer에서 찾기
      const textarea = orderGroup.locator('.order-footer .leave-message-container .q-textarea textarea').first();

      if (await textarea.count() > 0) {
        const value = await textarea.inputValue();
        if (!value || value.trim() === '') {
          emptyTextareaCount++;
          emptySellerNames.push(sellerName);
          console.log(`  Order ${orderIdx + 1} (${sellerName}): EMPTY`);

          // 이 order의 offer_id들에 해당하는 orderIndexes 수집
          const offerContainers = orderGroup.locator('.offer-container');
          const offerCount = await offerContainers.count();
          for (let offerIdx = 0; offerIdx < offerCount; offerIdx++) {
            const offerContainer = offerContainers.nth(offerIdx);
            const offerLink = offerContainer.locator('a[href*="offer/"]').first();
            if (await offerLink.count() > 0) {
              const href = await offerLink.getAttribute('href');
              const offerIdMatch = href.match(/offer\/(\d+)\.html/);
              if (offerIdMatch) {
                const offerId = offerIdMatch[1];
                const groupInfo = groupedData[offerId];
                if (groupInfo && groupInfo.orderIndexes) {
                  failedOrderIndexes.push(...groupInfo.orderIndexes);
                }
              }
            }
          }
        } else {
          console.log(`  Order ${orderIdx + 1} (${sellerName}): Has content (${value.length} chars)`);
        }
      }
    }

    const totalTextareas = orderGroupCount;

    console.log('\n========================================');
    console.log('INPUT REF CODES COMPLETED');
    console.log(`Success groups: ${successGroups.length}/${Object.keys(groupedData).length}`);
    console.log('Success groups:', successGroups);
    console.log(`Success order indexes: ${successOrderIndexes.length}`, successOrderIndexes);
    console.log(`Empty textareas: ${emptyTextareaCount}/${totalTextareas}`);
    if (emptySellerNames.length > 0) {
      console.log('Empty sellers:', emptySellerNames);
    }
    console.log('Failed order indexes:', failedOrderIndexes);
    console.log('========================================');

    // 주소지 선택 버튼 클릭
    console.log('\nClicking address selection button...');
    try {
      const addressBtn = page.locator('.address-action:has-text("更改地址")');
      if (await addressBtn.count() > 0) {
        await addressBtn.first().click();
        console.log('+ Address selection button clicked');
        await page.waitForTimeout(500);
      } else {
        console.log('Address button not found');
      }
    } catch (e) {
      console.log(`Address button click failed: ${e.message}`);
    }

    return { success: true, successGroups, successOrderIndexes, emptyTextareaCount, totalTextareas, emptySellerNames, failedOrderIndexes };

  } catch (error) {
    console.log(`\nX Input ref codes failed: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

// 로그인 설정용 브라우저 열기 함수
async function openLoginBrowser() {
  console.log('\n========================================');
  console.log('OPENING LOGIN BROWSER');
  console.log('========================================');

  // Chrome 경로 찾기
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error('Chrome을 찾을 수 없습니다.');
  }

  console.log('Chrome path:', chromePath);

  // Chrome 디버그 모드로 실행
  await launchChromeDebug(chromePath);

  console.log('Chrome launched in debug mode on port 9222');
  console.log('User can now login to 1688.com');
  console.log('========================================');

  return { success: true };
}

// ========================================
// 참조코드 입력 V2 (카트 → 결산 → 참조코드 → 주소 → 제출 → 반복)
// - 카트에서 최대 24개 상점씩 처리 후 제출, 남은 상점이 있으면 반복
// - 빈 textarea 발생 시 제출하지 않고 즉시 중단
// - shouldStop 플래그로 사용자 수동 중단 지원
// ========================================
async function inputRefCodesV2(groupedData, userCode) {
  console.log('\n========================================');
  console.log('INPUT REF CODES V2 STARTED');
  console.log(`Groups to process: ${Object.keys(groupedData).length}`);
  console.log(`User code: ${userCode}`);
  console.log('========================================');

  // ── Section 1: Chrome 연결 ──
  console.log('\nSection 1: Connecting to Chrome...');
  let browser = await tryConnectChrome(1);

  if (!browser) {
    console.log('X Chrome not connected');
    throw new Error('Chrome not connected. Please ensure the browser is still open.');
  }

  console.log('+ Chrome connected\n');

  const context = browser.contexts()[0];
  const pages = context.pages();
  let page = pages[pages.length - 1];

  // ── 누적 변수 초기화 ──
  shouldStop = false;
  const successGroups = [];
  const successOrderIndexes = [];
  const failedOrderIndexes = [];
  let emptyTextareaCount = 0;
  let totalTextareas = 0;
  const emptySellerNames = [];
  let iterationCount = 0;
  let stoppedByEmptyTextarea = false;
  let exitReason = '';  // 루프 종료 사유 추적

  try {
    // ═══════════════════════════════════════
    // 메인 루프: 카트 → 결산 → 참조코드 → 주소 → 제출 → 반복
    // ═══════════════════════════════════════
    while (true) {
      iterationCount++;
      // 이번 배치에서 성공한 indexes/groups - 제출 확인 후에만 success 리스트에 병합
      const currentBatchIndexes = [];
      const currentBatchGroups = [];
      console.log(`\n${'='.repeat(50)}`);
      console.log(`ITERATION ${iterationCount}`);
      console.log('='.repeat(50));
      checkShouldStop();

      // ── Section 2: 카트 페이지 접속 + 로딩 대기 ──
      // 이전 제출의 리다이렉트(order_success.htm)와 충돌 방지: 최대 3회 재시도 + URL 검증
      console.log('\nSection 2: Navigating to cart page...');
      let cartNavigated = false;
      for (let navRetry = 0; navRetry < 3; navRetry++) {
        try {
          await withStopCheck(() => page.goto('https://cart.1688.com/cart.htm', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          }));
          // URL 검증: 실제로 카트 페이지인지 확인
          const currentUrl = page.url();
          if (currentUrl.includes('cart.1688.com/cart')) {
            cartNavigated = true;
            break;
          }
          console.log(`  Cart URL mismatch (attempt ${navRetry + 1}/3): ${currentUrl}`);
          await page.waitForTimeout(5000);
        } catch (e) {
          console.log(`  Cart navigation attempt ${navRetry + 1}/3 failed: ${e.message}`);
          await page.waitForTimeout(5000);
        }
      }
      if (!cartNavigated) {
        exitReason = '카트 페이지 접속 실패 (3회 재시도)';
        console.log(`  X ${exitReason}`);
        break;
      }
      console.log('+ Navigated to cart page');

      try {
        await withStopCheck(() => page.waitForSelector('[class*="shop-container--container"]', { timeout: 10000 }));
        console.log('+ Shop containers found');
      } catch (e) {
        if (e.message === 'STOPPED_BY_USER') throw e;
        console.log('  Warning: Shop containers not found, waiting anyway...');
      }
      await page.waitForTimeout(5000);
      console.log('+ Page fully loaded (5s wait)');

      // ── Section 2.5: 상점 존재 여부 확인 ──
      const shopSelector = '[class*="shop-container--container"]';
      const shopCount = await page.locator(shopSelector).count();
      if (shopCount === 0) {
        exitReason = '장바구니에 남은 상점 없음 (정상 종료)';
        console.log(`+ ${exitReason}`);
        break;
      }
      console.log(`+ Found ${shopCount} shop container(s), continuing...`);

      // ── Section 3: 상점 체크박스 batch 선택 ──
      console.log('\nSection 3: Selecting shop checkboxes (batch)...');
      checkShouldStop();
      await selectShopCheckboxes(page);
      await trimExcessSellers(page, 24);

      // ── Section 4: 结算 버튼 클릭 + 주문확인 페이지 대기 ──
      // 全选 체크 후 가격 재계산 로딩 완료 대기 → 결산 버튼 활성화 확인
      console.log('\nSection 4: Waiting for 结算 button to be ready...');
      checkShouldStop();

      const settleBtnSelector = '[class*="bottom-bar--submitBtn"]';
      let settleReady = false;
      for (let pollCount = 0; pollCount < 30; pollCount++) {
        checkShouldStop();
        await page.waitForTimeout(1000);
        const btn = page.locator(settleBtnSelector).first();
        if (await btn.count() === 0) continue;
        // disabled 속성 또는 disabled 클래스 확인
        const isDisabled = await btn.evaluate(el => {
          return el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true';
        }).catch(() => true);
        if (!isDisabled) {
          settleReady = true;
          break;
        }
      }

      if (!settleReady) {
        exitReason = '结算 버튼 활성화 대기 실패 (30초)';
        console.log(`  X ${exitReason}`);
        break;
      }

      const submitBtn = page.locator(settleBtnSelector).first();
      await submitBtn.click();
      console.log('+ 结算 button clicked (after loading complete)');

      console.log('  Waiting for order confirmation page...');
      try {
        await withStopCheck(() => page.waitForURL('**/order/confirm*', { timeout: 30000 }));
        console.log('+ URL changed to order confirmation page');
      } catch (e) {
        if (e.message === 'STOPPED_BY_USER') throw e;
        console.log('  Warning: URL pattern not matched, waiting for page elements...');
      }

      try {
        await withStopCheck(() => page.waitForSelector('.order-inner', { timeout: 15000 }));
        console.log('+ Order inner elements loaded');
      } catch (e) {
        if (e.message === 'STOPPED_BY_USER') throw e;
        console.log('  Warning: .order-inner not found, trying alternative...');
        await page.waitForTimeout(5000);
      }
      await page.waitForTimeout(2000);
      console.log('+ Order confirmation page ready');

      // ── Section 5: 참조코드 입력 ──
      console.log('\nSection 5: Inputting reference codes...');
      checkShouldStop();

      const orderInners = page.locator('.order-inner');
      const orderCount = await orderInners.count();
      console.log(`  Found ${orderCount} order(s) on page`);

      // ── Phase 1: 1회 page.evaluate()로 모든 주문/상품/옵션 데이터 수집 ──
      // (기존: 주문×상품×옵션 수만큼 브라우저 왕복 → 신규: 1회 왕복)
      console.log('  [Batch] Collecting all order data in one evaluate call...');
      const pageOrderData = await page.evaluate(() => {
        return [...document.querySelectorAll('.order-inner')].map((orderEl, orderIdx) => ({
          orderIdx,
          offers: [...orderEl.querySelectorAll('.offer-container')].map(offerEl => ({
            offerId: (() => {
              const href = offerEl.querySelector('a[href*="offer/"]')?.getAttribute('href') || '';
              const m = href.match(/offer\/(\d+)\.html/);
              return m ? m[1] : null;
            })(),
            cargos: [...offerEl.querySelectorAll('.cargo-container')].map(cargoEl => ({
              spec: cargoEl.querySelector('.cargo-spec')?.textContent?.trim() || ''
            }))
          }))
        }));
      });
      console.log(`  [Batch] Collected ${pageOrderData.length} order(s) data`);

      // ── Phase 2: Node.js에서 모든 매칭 처리 (브라우저 왕복 없음) ──
      const freeSizeAliases = ['FREE', 'free', 'Free', '균码', '均码', 'F', '프리', '프리사이즈', 'FREESIZE', 'OneSize', 'OS'];
      const isFreeSize = (s) => freeSizeAliases.some(alias => s.toUpperCase().includes(alias.toUpperCase()));

      const textareaMap = new Map(); // orderIdx → memoText

      for (const orderData of pageOrderData) {
        const { orderIdx, offers } = orderData;
        const allRefCodes = [];

        for (const offer of offers) {
          const { offerId, cargos } = offer;
          if (!offerId) { console.log(`  Order ${orderIdx + 1}: offer without ID, skipping`); continue; }

          const groupInfo = groupedData[offerId];
          if (!groupInfo) { console.log(`  Order ${orderIdx + 1} / Offer ${offerId}: not in data, skipping`); continue; }

          console.log(`  Order ${orderIdx + 1} / Offer ${offerId}: ${groupInfo.items.length} item(s), ${cargos.length} cargo(s)`);

          for (const cargo of cargos) {
            const { spec } = cargo;
            if (!spec) continue;

            let color = '';
            let size = '';
            const specParts = spec.split(';').map(s => s.trim());
            for (const part of specParts) {
              if (part.includes('颜色:') || part.includes('色:')) {
                color = part.replace(/颜色:|色:/g, '').trim();
              } else if (part.includes('尺码:') || part.includes('码:')) {
                size = part.replace(/尺码:|码:/g, '').trim();
              }
            }

            const normalizedColor = color.replace(/\s+/g, ' ').trim();

            const matchingItems = groupInfo.items.filter(item => {
              const normalizedItemColor = (item.color || '').replace(/\s+/g, ' ').trim();
              const colorMatch = normalizedItemColor === normalizedColor;

              let sizeMatch = false;
              const normalizedItemSize = (item.size || '').replace(/\s+/g, ' ').trim();
              const normalizedSize = size.replace(/\s+/g, ' ').trim();

              if (isFreeSize(normalizedItemSize) && isFreeSize(normalizedSize)) {
                sizeMatch = true;
              } else if (normalizedSize.includes(normalizedItemSize) || normalizedItemSize.includes(normalizedSize)) {
                sizeMatch = true;
              } else if (normalizedItemSize === normalizedSize) {
                sizeMatch = true;
              }

              // 2XL ↔ XXL 변환 매칭
              if (!sizeMatch) {
                const convertedSize = convertXLSize(normalizedSize) || convertXLSize(normalizedItemSize);
                if (convertedSize) {
                  sizeMatch = normalizedItemSize === convertedSize || normalizedSize === convertedSize
                            || normalizedSize.includes(convertedSize) || normalizedItemSize.includes(convertedSize);
                }
              }

              console.log(`    Cargo(${normalizedColor}|${normalizedSize}) vs Item(${normalizedItemColor}|${normalizedItemSize}) = ${colorMatch && sizeMatch}`);
              return colorMatch && sizeMatch;
            });

            matchingItems.forEach(item => {
              if (item.orderIndex !== undefined && (successOrderIndexes.includes(item.orderIndex) || currentBatchIndexes.includes(item.orderIndex))) {
                console.log(`    Skipped (already added): orderIndex ${item.orderIndex}`);
                return;
              }
              allRefCodes.push({
                orderCode: item.orderCode,
                orderNoDatePart: item.orderNoDatePart,
                orderNoRestPart: item.orderNoRestPart,
                quantity: item.quantity,
                orderIndex: item.orderIndex
              });
              if (item.orderIndex !== undefined) currentBatchIndexes.push(item.orderIndex);
              if (!currentBatchGroups.includes(offerId)) currentBatchGroups.push(offerId);
              console.log(`    Added: ${item.orderCode} | ${item.orderNoDatePart} | ${item.orderNoRestPart}:${item.quantity} (orderIndex: ${item.orderIndex})`);
            });
          }
        }

        if (allRefCodes.length > 0) {
          allRefCodes.sort((a, b) => a.orderIndex - b.orderIndex);
          const groupMap = new Map();
          const groupedRefCodes = [];
          allRefCodes.forEach(item => {
            const key = `${item.orderCode}|${item.orderNoDatePart}`;
            if (!groupMap.has(key)) {
              const group = { orderCode: item.orderCode, orderNoDatePart: item.orderNoDatePart, restParts: [] };
              groupMap.set(key, group);
              groupedRefCodes.push(group);
            }
            groupMap.get(key).restParts.push(`${item.orderNoRestPart}:${item.quantity}`);
          });
          const memoText = groupedRefCodes.map(g => `${g.orderCode} | ${g.orderNoDatePart} | ${g.restParts.join(', ')}`).join('\n');
          textareaMap.set(orderIdx, memoText);
          console.log(`  Order ${orderIdx + 1}: memoText ready (${allRefCodes.length} codes)`);
        } else {
          console.log(`  Order ${orderIdx + 1}: no matching ref codes`);
        }
      }

      // ── Phase 3: 계산된 memoText로 textarea 일괄 입력 ──
      console.log(`  [Batch] Filling ${textareaMap.size}/${orderCount} textarea(s)...`);
      for (const [orderIdx, memoText] of textareaMap) {
        const orderInner = orderInners.nth(orderIdx);
        const textarea = orderInner.locator('.order-footer .leave-message-container .q-textarea textarea').first();

        if (await textarea.count() === 0) {
          console.log(`  Order ${orderIdx + 1}: X Textarea not found`);
          continue;
        }

        await textarea.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await textarea.click();
        await page.waitForTimeout(200);
        await textarea.fill(memoText);
        await page.waitForTimeout(300);

        const inputValue = await textarea.inputValue();
        if (inputValue === memoText) {
          console.log(`  Order ${orderIdx + 1}: + Input OK (${inputValue.length} chars)`);
        } else {
          console.log(`  Order ${orderIdx + 1}: ! Mismatch (expected: ${memoText.length}, got: ${inputValue.length})`);
        }
      }

      // ── Section 5.5: 빈 textarea 확인 → 있으면 제출 없이 즉시 중단 ──
      console.log('\n--- Checking for empty textareas ---');
      emptyTextareaCount = 0;
      emptySellerNames.length = 0;

      const orderGroups = page.locator('.order-group-container');
      const orderGroupCount = await orderGroups.count();
      totalTextareas = orderGroupCount;

      for (let orderIdx = 0; orderIdx < orderGroupCount; orderIdx++) {
        const orderGroup = orderGroups.nth(orderIdx);

        const shopLink = orderGroup.locator('.order-group-header .shop-title .shop-link').first();
        let sellerName = 'Unknown Seller';

        if (await shopLink.count() > 0) {
          sellerName = await shopLink.innerText().catch(() => 'Unknown Seller');
          sellerName = sellerName.trim();
        }

        const textarea = orderGroup.locator('.order-footer .leave-message-container .q-textarea textarea').first();

        if (await textarea.count() > 0) {
          const value = await textarea.inputValue();
          if (!value || value.trim() === '') {
            emptyTextareaCount++;
            emptySellerNames.push(sellerName);
            console.log(`  Order ${orderIdx + 1} (${sellerName}): EMPTY`);

            const offerContainers = orderGroup.locator('.offer-container');
            const offerCount = await offerContainers.count();
            for (let offerIdx = 0; offerIdx < offerCount; offerIdx++) {
              const offerContainer = offerContainers.nth(offerIdx);
              const offerLink = offerContainer.locator('a[href*="offer/"]').first();
              if (await offerLink.count() > 0) {
                const href = await offerLink.getAttribute('href');
                const offerIdMatch = href.match(/offer\/(\d+)\.html/);
                if (offerIdMatch) {
                  const offerId = offerIdMatch[1];
                  const groupInfo = groupedData[offerId];
                  if (groupInfo && groupInfo.orderIndexes) {
                    failedOrderIndexes.push(...groupInfo.orderIndexes);
                  }
                }
              }
            }
          } else {
            console.log(`  Order ${orderIdx + 1} (${sellerName}): Has content (${value.length} chars)`);
          }
        }
      }

      // 빈 textarea 발견 → 제출하지 않고 루프 종료
      if (emptyTextareaCount > 0) {
        console.log(`\n!!! ${emptyTextareaCount} empty textarea(s) found. Stopping before submit.`);
        stoppedByEmptyTextarea = true;
        break;
      }

      // ── Section 6: 주소 선택 ──
      console.log('\nSection 6: Address selection...');
      checkShouldStop();
      await selectAddress(page, userCode);

      // ── Section 6.5: 주문 제출 버튼 클릭 ──
      // 주소 확정(确定) 후 로딩 완료 대기 → enabled + visible 된 후 클릭
      console.log('\nSection 6.5: Waiting for submit button to be ready...');
      checkShouldStop();

      // 提交订单 버튼: <q-button type="primary" disabled="false" loading="false">
      const submitBtnSelector = 'q-button[type="primary"][disabled="false"][loading="false"]';
      try {
        await withStopCheck(() => page.waitForSelector(submitBtnSelector, { state: 'visible', timeout: 30000 }));
        console.log('  + Submit button is ready (visible & enabled)');
      } catch (e) {
        if (e.message === 'STOPPED_BY_USER') throw e;
        exitReason = '제출 버튼 활성화 대기 실패 (30초)';
        console.log(`  X ${exitReason}: ${e.message}`);
        break;
      }

      const submitOrderBtn = page.locator(submitBtnSelector).last();
      await submitOrderBtn.click();
      console.log('  + Submit order button clicked');

      // ── Section 6.6: 제출 완료 대기 ──
      // 성공/결제 페이지 URL 감지 (최대 40초) → 미감지 시 루프 계속 (장바구니로 복귀)
      console.log('  Waiting for submission to complete...');
      let submissionDetected = false;
      for (let waitSec = 0; waitSec < 40; waitSec++) {
        await page.waitForTimeout(1000);
        checkShouldStop();
        const currentUrl = page.url();
        if (
          currentUrl.includes('order_success') ||
          currentUrl.includes('make_order_success') ||
          currentUrl.includes('batch-cashier') ||
          currentUrl.includes('cashierOrderNo')
        ) {
          console.log(`  + Submission success page detected (${waitSec + 1}s): ${currentUrl}`);
          submissionDetected = true;
          break;
        }
      }
      if (!submissionDetected) {
        // 미감지 → 이번 배치 성공 처리 안 함, 루프 계속 (장바구니로 돌아가 다음 배치 처리)
        console.log(`  ! 주문 성공 URL 미감지 (40초) - 이번 배치(${currentBatchIndexes.length}건) 성공 처리 안 함, 루프 계속`);
        continue;
      }

      // 제출 확인 완료 → 이번 배치를 success 리스트에 병합
      currentBatchIndexes.forEach(idx => successOrderIndexes.push(idx));
      currentBatchGroups.forEach(g => { if (!successGroups.includes(g)) successGroups.push(g); });
      console.log(`  + Batch confirmed: ${currentBatchIndexes.length}건 성공 처리 (누적: ${successOrderIndexes.length}건)`);

      await page.waitForTimeout(5000);
      console.log('  + Submission wait completed');

      // → while 루프 처음으로: 카트 페이지로 이동하여 남은 상점 처리
      console.log('\n  Returning to cart for next batch...');
    }

    // ── Section 7: 누적 결과 반환 ──
    console.log('\n========================================');
    console.log('INPUT REF CODES V2 COMPLETED');
    console.log(`Iterations: ${iterationCount}`);
    console.log(`Success groups: ${successGroups.length}/${Object.keys(groupedData).length}`);
    console.log(`Success order indexes: ${successOrderIndexes.length}`, successOrderIndexes);
    console.log(`Empty textareas: ${emptyTextareaCount}/${totalTextareas}`);
    console.log(`Stopped by empty textarea: ${stoppedByEmptyTextarea}`);
    if (emptySellerNames.length > 0) {
      console.log('Empty sellers:', emptySellerNames);
    }
    console.log('Failed order indexes:', failedOrderIndexes);
    console.log(`Exit reason: ${exitReason || 'N/A'}`);
    console.log('========================================');

    return {
      success: true, successGroups, successOrderIndexes,
      emptyTextareaCount, totalTextareas, emptySellerNames,
      failedOrderIndexes, iterationCount,
      stoppedByUser: false, stoppedByEmptyTextarea,
      exitReason
    };

  } catch (error) {
    if (error.message === 'STOPPED_BY_USER') {
      console.log('\nV2 stopped by user');
      return {
        success: true, successGroups, successOrderIndexes,
        emptyTextareaCount, totalTextareas, emptySellerNames,
        failedOrderIndexes, iterationCount,
        stoppedByUser: true, stoppedByEmptyTextarea: false,
        exitReason: '사용자 중지'
      };
    }
    console.log(`\nX Input ref codes V2 failed: ${error.message}`);
    console.error(error.stack);
    throw error;
  } finally {
    shouldStop = false;
  }
}

// ========================================
// 상점별 체크박스 선택 함수 (카트 페이지)
// - ≤24개: 헤더 全选 체크박스로 한번에 선택 (빠름, ~3초)
// - >24개: 상점별 개별 클릭 (lazy loading 대응, 최대 24개)
// ========================================
// 상점 lazy-load 트리거: 최소 targetCount개 상점이 DOM에 나타날 때까지 스크롤
// - 1688 카트는 하단으로 스크롤해야 더 많은 상점이 렌더링됨
// - 이미 targetCount 이상이면 즉시 반환
// - 연속 stableChecks 회 동안 증가 없으면 종료 (더 이상 없음)
// ========================================
async function scrollUntilShopCount(page, targetCount, maxMs = 60000) {
  const shopSelector = '[class*="shop-container--container"]';
  const initial = await page.locator(shopSelector).count();
  console.log(`  [Scroll] Initial shop count: ${initial}, target: ${targetCount}`);

  if (initial >= targetCount) {
    console.log(`  [Scroll] Already have ${initial} shops (≥${targetCount}), skipping scroll`);
    return initial;
  }

  const start = Date.now();
  let prevCount = initial;
  let stableCount = 0;
  const maxStable = 8; // 연속 8회(약 3초) 동안 변화 없으면 종료
  let loopNo = 0;

  while (Date.now() - start < maxMs) {
    checkShouldStop();
    loopNo++;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);

    const current = await page.locator(shopSelector).count();
    console.log(`  [Scroll] #${loopNo}: shops=${current}`);

    if (current >= targetCount) {
      console.log(`  [Scroll] Reached target: ${current} shops`);
      return current;
    }

    if (current === prevCount) {
      stableCount++;
      if (stableCount >= maxStable) {
        console.log(`  [Scroll] Stable at ${current} shops (no more to load)`);
        return current;
      }
    } else {
      stableCount = 0;
    }
    prevCount = current;
  }

  console.log(`  [Scroll] Timeout (${maxMs}ms), final count: ${prevCount}`);
  return prevCount;
}

// ========================================
// 全选 클릭으로 보이는 상점 전체 선택
// - 스크롤 없음 (보이는 페이지만 선택)
// - 全选 = MtopPurchaseAstoreService.async 배치 API 1회 호출
// ========================================
async function selectShopCheckboxes(page) {
  const shopSelector = '[class*="shop-container--container"]';
  const selectAllSelector = 'th[class*="colCheckbox"] .next-checkbox-input';

  const shopCount = await page.locator(shopSelector).count();
  console.log(`  ${shopCount} shop(s) detected`);

  const selectAllCb = page.locator(selectAllSelector);
  if (await selectAllCb.count() === 0) {
    console.log('  X 全选 checkbox not found');
    return;
  }

  // 이미 체크되어 있으면 스킵
  const isChecked = await selectAllCb.isChecked().catch(() => false);
  if (isChecked) {
    console.log('  + 全选 already checked');
    return;
  }

  // 全选 클릭
  await selectAllCb.click();
  console.log('  + 全选 clicked');

  // 체크 확인 폴링 (500ms × 60 = 최대 30초)
  for (let i = 0; i < 60; i++) {
    checkShouldStop();
    await page.waitForTimeout(500);
    const status = await page.evaluate(({ shopSel }) => {
      const shops = document.querySelectorAll(shopSel);
      let checkedShops = 0;
      for (let i = 0; i < shops.length; i++) {
        const w = shops[i].querySelector('[class*="companyWrapper"] .next-checkbox-wrapper');
        if (w && w.classList.contains('checked')) checkedShops++;
      }
      return { checkedShops, total: shops.length };
    }, { shopSel: shopSelector });

    if (status.checkedShops === status.total && status.total > 0) {
      console.log(`  + All ${status.checkedShops} shops selected via 全选`);
      return;
    }
  }

  console.log('  ! 全选 timeout');
}

// 结算 버튼은 판매자 24개 초과 시 비활성화되므로 초과분을 해제한다.
// 판매자 체크박스 해제(판매자 레벨)만 수행 — 상품 체크박스는 건드리지 않음.
async function trimExcessSellers(page, max = 24) {
  const sellerCheckedSel = '[class*="companyWrapper"] .next-checkbox-wrapper.checked';

  const current = await page.locator(sellerCheckedSel).count();
  console.log(`  판매자 체크 ${current}/${max}`);

  if (current <= max) return;

  const excess = current - max;
  console.log(`  초과 ${excess}개 해제 시작`);

  for (let i = 0; i < excess; i++) {
    checkShouldStop();
    const checked = page.locator(sellerCheckedSel);
    const count = await checked.count();
    if (count === 0) break;

    // 마지막(가장 하단) 판매자부터 해제 → 스크롤로 추가 로드된 것 우선 제외
    const last = checked.nth(count - 1);
    await last.scrollIntoViewIfNeeded().catch(() => {});
    await last.click();
    console.log(`  - 판매자 해제 (${i + 1}/${excess})`);

    // 서버 응답 + 리렌더링 대기
    await page.waitForTimeout(3000);
  }

  const after = await page.locator(sellerCheckedSel).count();
  console.log(`  판매자 체크 완료: ${after}/${max}`);
}

// ========================================
// 상점 체크박스 일괄 선택 (최대 24개 상점을 동시에 클릭)
// - Promise.all로 모든 Playwright 클릭을 동시에 실행 (CDP 병렬 전송)
// - 단일 폴링 루프로 전체 체크 완료 대기 (최대 30초)
// ========================================
async function selectShopCheckboxesBatch(page, shopCount) {
  const shopSelector = '[class*="shop-container--container"]';
  const sellerCheckboxSelector = '[class*="companyWrapper"] .next-checkbox-input';
  const targetCount = Math.min(shopCount, 24);
  console.log(`  [Batch] Clicking ${targetCount} seller checkboxes simultaneously...`);

  // ── Step 1: 체크 안 된 상점만 필터링 후 동시 클릭 ──
  const clickPromises = [];
  for (let i = 0; i < targetCount; i++) {
    const shop = page.locator(shopSelector).nth(i);
    const checkbox = shop.locator(sellerCheckboxSelector).first();
    clickPromises.push(checkbox.click({ force: true }).catch(() => null));
  }
  await Promise.all(clickPromises);
  console.log(`  [Batch] ${clickPromises.length} clicks dispatched simultaneously`);

  // ── Step 2: 단일 폴링 루프 (500ms × 60 = 최대 30초) ──
  let allChecked = false;
  for (let i = 0; i < 60; i++) {
    checkShouldStop();
    await page.waitForTimeout(500);
    const status = await page.evaluate((maxN) => {
      const shops = document.querySelectorAll('[class*="shop-container--container"]');
      let checkedShops = 0;
      let totalItems = 0;
      let checkedItems = 0;
      const limit = Math.min(shops.length, maxN);
      for (let i = 0; i < limit; i++) {
        const sw = shops[i].querySelector('[class*="companyWrapper"] .next-checkbox-wrapper');
        if (sw && sw.classList.contains('checked')) checkedShops++;
        const items = shops[i].querySelectorAll('[class*="item-group-container--container"] .next-checkbox-input');
        for (const cb of items) {
          totalItems++;
          const lbl = cb.closest('.next-checkbox-wrapper');
          if ((lbl && lbl.classList.contains('checked')) || cb.getAttribute('aria-checked') === 'true') {
            checkedItems++;
          }
        }
      }
      return { checkedShops, totalItems, checkedItems };
    }, targetCount);

    if (status.checkedShops === targetCount && status.totalItems > 0 && status.checkedItems === status.totalItems) {
      allChecked = true;
      console.log(`  [Batch] All checked — shops=${status.checkedShops}/${targetCount}, items=${status.checkedItems}/${status.totalItems}`);
      break;
    }
  }

  // ── Step 3: 결과 로깅 (실패 시 경고만, fallback 없음) ──
  if (!allChecked) {
    console.log('  [Batch] ! Warning: batch timeout - some checkboxes may not be checked');
  } else {
    console.log(`  [Batch] All ${targetCount} shops checked successfully`);
  }
}

// ========================================
// 주소 선택 함수 (주문확인 페이지)
// - 更改地址 클릭 → 모달에서 user_code 매칭 주소 선택 → 确定 클릭
// ========================================
async function selectAddress(page, userCode) {
  // "更改地址" 버튼 클릭
  console.log('  Clicking 更改地址 button...');
  try {
    const addressBtn = page.locator('.address-action:has-text("更改地址")');
    if (await addressBtn.count() > 0) {
      await addressBtn.first().click();
      console.log('  + 更改地址 button clicked');
      await page.waitForTimeout(1000);
    } else {
      console.log('  X 更改地址 button not found');
      return;
    }
  } catch (e) {
    console.log(`  X 更改地址 button click failed: ${e.message}`);
    return;
  }

  // 주소 모달 로딩 대기
  console.log('  Waiting for address modal...');
  try {
    await page.waitForSelector('.address-subject', { timeout: 10000 });
    console.log('  + Address modal loaded');
  } catch (e) {
    console.log('  X Address modal not found');
    return;
  }
  await page.waitForTimeout(500);

  // 주소 목록에서 user_code 매칭 항목 찾기
  // address-name 텍스트의 끝이 userCode와 일치하는 항목 선택
  console.log(`  Looking for address ending with "${userCode}"...`);

  const matchResult = await page.evaluate((targetUserCode) => {
    const addressSubjects = document.querySelectorAll('.address-subject');
    const results = [];

    for (let i = 0; i < addressSubjects.length; i++) {
      const nameEl = addressSubjects[i].querySelector('.address-name');
      if (!nameEl) continue;

      const nameText = nameEl.textContent.trim();
      results.push(nameText);

      if (nameText.endsWith(targetUserCode)) {
        return { found: true, index: i, name: nameText, total: addressSubjects.length };
      }
    }

    return { found: false, names: results, total: addressSubjects.length };
  }, userCode);

  if (!matchResult.found) {
    console.log(`  X No address found matching user_code "${userCode}"`);
    console.log(`  Available addresses: ${matchResult.names?.join(', ')}`);
    console.log('  Manual address selection required');
    return;
  }

  console.log(`  + Found matching address: "${matchResult.name}" (${matchResult.index + 1}/${matchResult.total})`);

  // 매칭된 주소 클릭
  const addressSubjects = page.locator('.address-subject');
  const targetAddress = addressSubjects.nth(matchResult.index);
  await targetAddress.click();
  await page.waitForTimeout(500);
  console.log('  + Address selected');

  // "确 定" 버튼 클릭하여 주소 확정
  console.log('  Clicking 确定 button...');
  try {
    const confirmBtn = page.locator('.address-button-group .ant-btn-primary');
    if (await confirmBtn.count() > 0) {
      await confirmBtn.first().click();
      await page.waitForTimeout(500);
      console.log('  + Address confirmed (确定 clicked)');
    } else {
      console.log('  X 确定 button not found');
    }
  } catch (e) {
    console.log(`  X 确定 button click failed: ${e.message}`);
  }
}

// ========================================
// 문의 탭: 판매자에게 재고 문의 채팅 입력 (전송 안함)
// - group: { offerId, url, items: [{chinaOption, quantity}, ...] }
// - 상품 페이지 접속 → 客服 버튼 클릭 → 새 탭 대기 → 채팅창에 중국어 메시지 입력
// ========================================
async function askInquiry(group) {
  console.log('\n========== 문의 시작 ==========');
  console.log('  group:', JSON.stringify(group).substring(0, 200));

  const browser = await tryConnectChrome();
  if (!browser) {
    console.log('  Chrome 연결 실패, 디버그 모드로 실행 시도...');
    const chromePath = findChromePath();
    if (!chromePath) return { success: false, error: 'Chrome을 찾을 수 없습니다' };
    await launchChromeDebug(chromePath);
    const retry = await tryConnectChrome(3);
    if (!retry) return { success: false, error: 'Chrome 연결 실패' };
  }

  const connected = browser || await tryConnectChrome();
  const context = connected.contexts()[0];
  const page = await context.newPage();
  await applyStealthScripts(page);

  try {
    // Step 1: 상품 페이지 접속
    console.log('  URL 접속:', group.url);
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Step 2: 客服 버튼 찾기 + 클릭 → 새 탭 대기
    const kefuSelector = 'a.action-item[data-trace="BAR_咨询商家"]';
    console.log('  客服 버튼 대기...');
    await page.waitForSelector(kefuSelector, { timeout: 15000 });

    console.log('  客服 버튼 클릭 → 새 탭 대기...');
    const [chatPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15000 }),
      page.locator(kefuSelector).first().click()
    ]);

    await chatPage.waitForLoadState('domcontentloaded', { timeout: 20000 });
    console.log('  새 탭 열림:', chatPage.url());
    await chatPage.waitForTimeout(5000); // 채팅 위젯 초기 렌더링 대기

    // Step 3: 채팅 입력창 찾기 — 메인 프레임 + 모든 iframe 순회
    // 1688 IM은 채팅 UI를 iframe으로 감싸는 경우가 있어 frameLocator 폴백 필요
    const editSelector = 'pre.edit[contenteditable="true"]';
    console.log('  채팅 입력창 탐색...');

    let editTarget = null; // Locator (page or frame)
    const deadline = Date.now() + 30000;

    while (Date.now() < deadline) {
      checkShouldStop();

      // 메인 프레임 우선
      if (await chatPage.locator(editSelector).count() > 0) {
        editTarget = chatPage.locator(editSelector).first();
        console.log('  + 메인 프레임에서 입력창 발견');
        break;
      }

      // 모든 iframe 순회
      const frames = chatPage.frames();
      for (const frame of frames) {
        if (frame === chatPage.mainFrame()) continue;
        try {
          if (await frame.locator(editSelector).count() > 0) {
            editTarget = frame.locator(editSelector).first();
            console.log(`  + iframe(${frame.url().substring(0, 80)})에서 입력창 발견`);
            break;
          }
        } catch (e) { /* cross-origin frame은 skip */ }
      }
      if (editTarget) break;

      await chatPage.waitForTimeout(1000);
    }

    if (!editTarget) {
      // 진단 로그: 현재 페이지 상태 + 프레임 목록
      console.log('  X 입력창 미발견 - 진단 정보:');
      console.log('    URL:', chatPage.url());
      console.log('    프레임 수:', chatPage.frames().length);
      chatPage.frames().forEach((f, i) => console.log(`    [${i}] ${f.url().substring(0, 120)}`));
      throw new Error('채팅 입력창(pre.edit)을 메인/iframe 어디에서도 찾지 못함');
    }

    // Step 4: 중국어 메시지 조립
    const header = '您好，下单前咨询库存：';
    const lines = group.items.map(it => `${it.chinaOption} - ${it.quantity}`);
    const footer = '请告知可订购数量，谢谢！';
    const message = [header, ...lines, '', footer].join('\n');

    console.log('  메시지 입력:\n' + message);

    // Step 5: contenteditable에 메시지 입력 (전송 안함)
    await editTarget.evaluate((el, text) => {
      el.focus();
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, message);

    await chatPage.waitForTimeout(1000);

    console.log('  ★ 메시지 입력 완료 (전송 안함)');
    console.log('========== 문의 완료 ==========\n');

    return {
      success: true,
      offerId: group.offerId,
      itemCount: group.items.length,
      message: message
    };

  } catch (e) {
    console.log('  X 에러:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = { processOrders, startReview, stopProcessing, inputRefCodes, inputRefCodesV2, openLoginBrowser, askInquiry };
