const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { processOrders, stopProcessing } = require('./automation');
const { autoUpdater } = require('electron-updater');

// 빌드된 앱에서 .env 파일 경로 설정
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

let mainWindow;
let forceClose = false;  // 강제 종료 플래그

// ========== 자동 업데이트 설정 ==========
autoUpdater.autoDownload = false;  // 수동 다운로드
autoUpdater.autoInstallOnAppQuit = true;

// 업데이트 확인 완료
autoUpdater.on('update-available', (info) => {
  console.log('업데이트 발견:', info.version);
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '업데이트 가능',
    message: `새 버전(${info.version})이 있습니다. 다운로드하시겠습니까?`,
    buttons: ['다운로드', '나중에']
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });
});

// 업데이트 없음
autoUpdater.on('update-not-available', () => {
  console.log('최신 버전입니다.');
});

// 다운로드 진행률
autoUpdater.on('download-progress', (progress) => {
  console.log(`다운로드 중: ${Math.round(progress.percent)}%`);
  if (mainWindow) {
    mainWindow.webContents.send('update-progress', progress.percent);
  }
});

// 다운로드 완료
autoUpdater.on('update-downloaded', () => {
  console.log('업데이트 다운로드 완료');
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '업데이트 준비 완료',
    message: '업데이트가 다운로드되었습니다. 지금 재시작하여 설치하시겠습니까?',
    buttons: ['지금 재시작', '나중에']
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

// 업데이트 오류
autoUpdater.on('error', (err) => {
  console.error('업데이트 오류:', err);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

  // 개발자 도구 열기 (F12 또는 Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  // 창 닫기 전 확인
  mainWindow.on('close', async (e) => {
    if (forceClose) {
      return;  // 강제 종료 허용
    }

    // 렌더러에게 저장되지 않은 데이터가 있는지 확인
    e.preventDefault();
    mainWindow.webContents.send('check-unsaved-data');
  });
}

app.whenReady().then(() => {
  createWindow();

  // 빌드된 앱에서만 업데이트 확인
  if (app.isPackaged) {
    autoUpdater.checkForUpdates();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 주문 처리 IPC
ipcMain.handle('process-orders', async (event, orders) => {
  return await processOrders(orders, (progress) => {
    // 진행 상황을 렌더러로 전송
    mainWindow.webContents.send('order-progress', progress);
  });
});

// 검수 시작 IPC
ipcMain.handle('start-review', async (event, orders) => {
  const { startReview } = require('./automation');
  return await startReview(orders, (progress) => {
    // 검수 진행 상황을 렌더러로 전송
    mainWindow.webContents.send('review-progress', progress);
  });
});

// 주문 중단 IPC
ipcMain.on('stop-processing', () => {
  stopProcessing();
});

// 참조코드 입력 IPC
ipcMain.handle('input-ref-codes', async (event, groupedCodes) => {
  const { inputRefCodes } = require('./automation');
  return await inputRefCodes(groupedCodes);
});

// 로그인 설정용 브라우저 열기 IPC
ipcMain.handle('open-login-browser', async () => {
  const { openLoginBrowser } = require('./automation');
  return await openLoginBrowser();
});

// 저장되지 않은 데이터 응답 처리
ipcMain.on('unsaved-data-response', (event, hasUnsavedData) => {
  if (!hasUnsavedData) {
    // 저장되지 않은 데이터가 없으면 바로 종료
    forceClose = true;
    mainWindow.close();
  }
  // 저장되지 않은 데이터가 있으면 렌더러에서 모달 표시
});

// 강제 종료 (저장하지 않고 종료)
ipcMain.on('force-close', () => {
  forceClose = true;
  mainWindow.close();
});

// 저장 후 종료
ipcMain.on('close-after-save', () => {
  forceClose = true;
  mainWindow.close();
});
