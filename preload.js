const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  processOrders: (orders) => ipcRenderer.invoke('process-orders', orders),
  onProgress: (callback) => ipcRenderer.on('order-progress', (event, data) => callback(data)),
  startReview: (orders) => ipcRenderer.invoke('start-review', orders),
  onReviewProgress: (callback) => ipcRenderer.on('review-progress', (event, data) => callback(data)),
  stopProcessing: () => ipcRenderer.send('stop-processing'),
  inputRefCodes: (groupedCodes) => ipcRenderer.invoke('input-ref-codes', groupedCodes),
  inputRefCodesV2: (groupedCodes) => ipcRenderer.invoke('input-ref-codes-v2', groupedCodes),
  openLoginBrowser: () => ipcRenderer.invoke('open-login-browser'),
  askInquiry: (group) => ipcRenderer.invoke('ask-inquiry', group),
  // Supabase 환경 변수
  getEnv: (key) => process.env[key],
  // 창 닫기 관련
  onCheckUnsavedData: (callback) => ipcRenderer.on('check-unsaved-data', () => callback()),
  sendUnsavedDataResponse: (hasUnsavedData) => ipcRenderer.send('unsaved-data-response', hasUnsavedData),
  forceClose: () => ipcRenderer.send('force-close'),
  closeAfterSave: () => ipcRenderer.send('close-after-save'),
  // 앱 재시작 (종료 후 자동 재실행)
  restartApp: () => ipcRenderer.send('restart-app'),
  // 네이티브 다이얼로그 후 입력칸 포커스 복구
  restoreFocus: () => ipcRenderer.send('restore-focus'),
  // 현재 앱 버전 조회
  getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
