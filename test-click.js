const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

// Chrome 실행 경로 찾기
function findChromePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of possiblePaths) {
    try {
      require('fs').accessSync(p);
      return p;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Chrome 디버그 모드로 실행
function launchChromeDebug(chromePath) {
  return new Promise((resolve) => {
    console.log('Chrome을 디버그 모드로 실행 중...');

    const chrome = spawn(chromePath, [
      '--remote-debugging-port=9222',
      '--user-data-dir=' + path.join(process.env.TEMP, 'chrome-debug-profile'),
    ], {
      detached: true,
      stdio: 'ignore'
    });

    chrome.unref();
    setTimeout(() => resolve(), 2000);
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
        console.log(`연결 재시도 중... (${i + 2}/${retries})`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  return null;
}

async function addToCart() {
  console.log('========================================');
  console.log('  1688 장바구니 담기 테스트');
  console.log('========================================\n');

  // Chrome 연결
  console.log('Chrome 디버그 모드에 연결 시도...\n');
  let browser = await tryConnectChrome(1);

  if (!browser) {
    console.log('실행 중인 디버그 Chrome이 없습니다.\n');

    const chromePath = findChromePath();
    if (!chromePath) {
      console.log('❌ Chrome을 찾을 수 없습니다.');
      return;
    }

    console.log(`Chrome 경로: ${chromePath}`);
    await launchChromeDebug(chromePath);
    browser = await tryConnectChrome(3);

    if (!browser) {
      console.log('❌ Chrome에 연결할 수 없습니다.');
      return;
    }
  }

  console.log('✅ Chrome에 연결됨!\n');

  const context = browser.contexts()[0];
  const page = await context.newPage();

  try {
    // 1. 페이지 접속
    const url = 'https://detail.1688.com/offer/769773431818.html?offerId=769773431818&hotSaleSkuId=5279596981159';
    console.log('페이지 접속 중...');
    console.log(`URL: ${url}\n`);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',  // networkidle 대신 더 빠른 조건
      timeout: 30000
    });

    // 페이지 주요 요소가 나타날 때까지 대기
    console.log('페이지 요소 로딩 대기 중...');
    await page.waitForSelector('button.sku-filter-button', { timeout: 15000 });

    console.log('✅ 페이지 로드 완료\n');

    // 2. 색상 선택 (咖啡色)
    console.log('색상 선택 중... (咖啡色)');

    // 咖啡色 버튼 찾기
    const colorButton = page.locator('button.sku-filter-button:has-text("咖啡色")');

    if (await colorButton.count() > 0) {
      await colorButton.first().scrollIntoViewIfNeeded();
      await colorButton.first().click();
      console.log('✅ 咖啡色 선택 완료\n');
    } else {
      console.log('❌ 咖啡色 버튼을 찾을 수 없습니다.');

      // 디버깅: 현재 있는 색상 버튼 출력
      const allColors = await page.locator('button.sku-filter-button').all();
      console.log(`현재 페이지의 색상 버튼들 (${allColors.length}개):`);
      for (let i = 0; i < Math.min(allColors.length, 5); i++) {
        const text = await allColors[i].innerText();
        console.log(`  ${i + 1}. ${text.trim()}`);
      }
      await browser.disconnect();
      return;
    }

    // 잠시 대기 (옵션 로딩)
    await page.waitForTimeout(1000);

    // 3. 사이즈 옵션의 + 버튼 클릭 (M 사이즈)
    console.log('사이즈 선택 중... (M)');

    // M 사이즈 옵션 행 찾기
    const sizeRow = page.locator('.expand-view-item:has(.item-label:text("M"))');

    if (await sizeRow.count() > 0) {
      // 해당 행의 + 버튼 찾기
      const plusButton = sizeRow.first().locator('.anticon-plus');

      if (await plusButton.count() > 0) {
        await plusButton.first().scrollIntoViewIfNeeded();
        await plusButton.first().click();
        console.log('✅ M 사이즈 수량 +1 완료\n');
      } else {
        console.log('❌ + 버튼을 찾을 수 없습니다.');
      }
    } else {
      console.log('❌ M 사이즈 옵션을 찾을 수 없습니다.');

      // 디버깅: 현재 있는 사이즈 옵션 출력
      const allSizes = await page.locator('.expand-view-item .item-label').all();
      console.log(`현재 페이지의 사이즈 옵션들 (${allSizes.length}개):`);
      for (let i = 0; i < Math.min(allSizes.length, 10); i++) {
        const text = await allSizes[i].innerText();
        console.log(`  ${i + 1}. ${text.trim()}`);
      }
    }

    // 결과 확인을 위해 대기
    console.log('3초 후 브라우저 연결 해제...');
    await page.waitForTimeout(3000);

  } catch (error) {
    console.error('에러 발생:', error.message);
  } finally {
    console.log('\n✅ 스크립트 종료 (브라우저는 유지됩니다)');
    await browser.disconnect();
  }
}

addToCart();
