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

  // 2. 부분 일치 (searchSize를 포함하는 옵션)
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

  await addCartBtn.first().click();

  // 6. Check success message
  console.log(`  Waiting for success message...`);
  try {
    await page.waitForSelector('.feedback-dialog-message:has-text("加购成功")', { timeout: 5000 });
    console.log(`  SUCCESS!`);
    return { success: true };
  } catch (e) {
    console.log(`  X Success message not found`);
    throw new Error('Add to cart failed');
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
    const freightEl = page.locator('.order-select-models .total-freight-fee strong.currency');
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
          await colorMatchResult.match.button.click();
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
          await colorMatchResult.match.button.click();
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
      await inputField.click();
      await inputField.fill('');
      await inputField.type(item.quantity.toString(), { delay: 50 });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);

      // 이 아이템 성공 (아직 장바구니 추가 전이지만 옵션 선택 완료)
      item.optionSelected = true;
      console.log(`  + Option & quantity set for this item`);

    } catch (error) {
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

  await addCartBtn.first().click();

  // 성공 메시지 확인
  console.log(`Waiting for success message...`);
  try {
    await page.waitForSelector('.feedback-dialog-message:has-text("加购成功")', { timeout: 5000 });
    console.log(`SUCCESS! Added to cart`);

    // 성공한 아이템들 완료 처리 (테스트용: 배송비 정보 포함)
    successItems.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'success', shippingInfo: shippingCheck.infoMessage });
      });
    });

  } catch (e) {
    console.log(`X Success message not found`);
    successItems.forEach(item => {
      item.orderIndices.forEach(idx => {
        onProgress({ index: idx, status: 'error', errorReason: 'Add to cart failed' });
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

      await processGroupOrder(page, group, onProgress);

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

    // 4. "全选" 체크박스 선택
    console.log('\nStep 4: Selecting "全选" checkbox...');
    await selectAllCheckbox(page);

    // 체크박스 상태 업데이트 대기
    await page.waitForTimeout(1000);
    console.log('+ Waited for checkbox state update');

    // 5. 카트 데이터 추출
    console.log('\nStep 5: Extracting cart data...');
    const cartItems = await extractCartData(page);
    console.log(`+ Extracted ${cartItems.length} items from cart`);

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

  // 5. 숫자 추출 비교 - 불허용 (불일치로 표시, 카트 값 알려줌)
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
  console.log('    Starting lazy-load aware scroll...');

  // 현재 아이템 개수 추적
  let previousItemCount = 0;
  let sameCountAttempts = 0;
  const maxSameCountAttempts = 5;  // 연속 5번 같은 아이템 수면 완료로 판단
  let scrollCount = 0;
  const maxScrollAttempts = 50;  // 무한 루프 방지
  const scrollDistance = 800;  // 한 번에 스크롤할 거리 (픽셀)

  while (scrollCount < maxScrollAttempts) {
    scrollCount++;

    // 현재 아이템 개수 확인
    const currentItemCount = await page.evaluate(() => {
      return document.querySelectorAll('label[class*="item--checkbox"]').length;
    });

    // 점진적으로 스크롤 (바닥으로 점프하지 않고 조금씩)
    await page.evaluate((distance) => {
      window.scrollBy(0, distance);
    }, scrollDistance);

    // 콘텐츠 로딩 대기 (lazy loading을 위해 충분히 대기)
    await page.waitForTimeout(800);

    // 새로운 아이템 개수 확인
    const newItemCount = await page.evaluate(() => {
      return document.querySelectorAll('label[class*="item--checkbox"]').length;
    });

    console.log(`    Scroll #${scrollCount}: items ${currentItemCount} -> ${newItemCount}`);

    // 아이템 개수가 변하지 않으면 카운트 증가
    if (newItemCount === previousItemCount) {
      sameCountAttempts++;

      // 페이지 끝에 도달했는지 확인
      const isAtBottom = await page.evaluate(() => {
        return (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
      });

      if (isAtBottom && sameCountAttempts >= maxSameCountAttempts) {
        console.log(`    Scroll complete - no new items after ${maxSameCountAttempts} attempts at bottom`);
        break;
      }
    } else {
      sameCountAttempts = 0;  // 아이템이 늘었으면 카운트 리셋
    }

    previousItemCount = newItemCount;
  }

  if (scrollCount >= maxScrollAttempts) {
    console.log(`    Max scroll attempts (${maxScrollAttempts}) reached`);
  }

  // 스크롤 완료 후 추가 대기 (최종 콘텐츠 로딩)
  await page.waitForTimeout(1500);

  // 최종 아이템 개수 확인
  const finalItemCount = await page.evaluate(() => {
    return document.querySelectorAll('label[class*="item--checkbox"]').length;
  });
  console.log(`    Final cart item count: ${finalItemCount}`);
}

// 중단 함수
function stopProcessing() {
  shouldStop = true;
  console.log('Stop signal received');
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
              // 매칭 성공한 orderIndex 기록
              if (item.orderIndex !== undefined) {
                successOrderIndexes.push(item.orderIndex);
              }
              console.log(`        Added: ${item.orderCode} | ${item.orderNoDatePart} | ${item.orderNoRestPart}:${item.quantity} (orderIndex: ${item.orderIndex})`);
            });

            // 성공한 offer_id 추가
            if (!successGroups.includes(offerId)) {
              successGroups.push(offerId);
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

module.exports = { processOrders, startReview, stopProcessing, inputRefCodes, openLoginBrowser };
