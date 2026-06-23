console.log('=== renderer.js 로드 완료 ===');

// ── 네이티브 다이얼로그(alert/confirm) 후 입력칸 포커스 복구 ──
// Electron 버그: alert/confirm을 닫으면 <input>/<textarea>가 클릭해도 포커스를
// 받지 못해 "비활성화"된 것처럼 보인다(버튼은 정상). 다이얼로그 직후 창 포커스를
// 복구해 입력칸을 다시 쓸 수 있게 한다. (alert 125곳을 한 곳에서 일괄 처리)
(function patchDialogsForFocus() {
  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const restore = () => { try { window.api?.restoreFocus?.(); } catch (_) {} };
  window.alert = (msg) => { nativeAlert(msg); restore(); };
  window.confirm = (msg) => { const r = nativeConfirm(msg); restore(); return r; };
})();

// ── 재시작 버튼 아래에 현재 앱 버전 표시 ──
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const v = await window.api?.getAppVersion?.();
    const el = document.getElementById('appVersionLabel');
    if (el && v) el.textContent = 'v' + v;
  } catch (_) {}
});

let orders = [];
let isProcessing = false;  // 주문 진행 중 플래그
let unmatchedExcelData = [];  // 매칭되지 않은 엑셀 데이터
let isDataSaved = true;  // 데이터 저장 여부 플래그
let pendingAction = null;  // 대기 중인 액션 ('refresh' 또는 'close')
let inquiryOrders = [];  // 문의 탭 데이터
let currentTab = 'orderV2';  // 현재 활성 탭 ('order' | 'orderV2' | 'inquiry')

// ════════════════════════════════════════════════════════════
// 주문 탭 패스워드 게이트
// - 사용자/유저 드롭박스를 활성화하기 위해 입력해야 하는 패스워드
// - 일치 시 isOrderUnlocked = true → 드롭박스 활성화
// ════════════════════════════════════════════════════════════
// 게이트 비밀번호는 .env(ORDER_PASSWORD)에서 로드한다. 소스/히스토리에 하드코딩하지 않는다.
const ORDER_PASSWORD = (window.api && window.api.getEnv && window.api.getEnv('ORDER_PASSWORD')) || '';
let isOrderUnlocked = false;

// 패스워드 입력 핸들러
function onPasswordInput() {
  const input = document.getElementById('orderPwInput');
  if (!input) return;
  const matched = ORDER_PASSWORD !== '' && input.value === ORDER_PASSWORD;

  if (matched && !isOrderUnlocked) {
    isOrderUnlocked = true;
    input.style.borderColor = '#28a745';
  } else if (!matched && isOrderUnlocked) {
    isOrderUnlocked = false;
    input.style.borderColor = '#ddd';
  }

  applyOrderUnlockState();
}

// 패스워드 잠금 상태에 따라 사용자/유저 드롭박스 활성화/비활성화
function applyOrderUnlockState() {
  const userSelect = document.getElementById('userSelect');
  const ftUserSelect = document.getElementById('ftUserSelect');

  if (userSelect) userSelect.disabled = !isOrderUnlocked;
  if (ftUserSelect) ftUserSelect.disabled = !isOrderUnlocked;

  // 잠금 상태로 돌아가면 선택값 초기화 → 데이터 입력도 비활성화
  if (!isOrderUnlocked) {
    if (userSelect) userSelect.value = '';
    if (ftUserSelect) ftUserSelect.value = '';
  }

  updateDataInputState();
  applyUserCodeButtonVisibility();
}

// ════════════════════════════════════════════════════════════
// user_code 그룹별 우측 패널 버튼 가시성
// - ft_users.user_code prefix(알파벳 앞부분)로 그룹 결정
// - HI/MB → V2 풀 워크플로우
// - BZ    → V1 풀 워크플로우
// - BO    → 혼합 (저장 V2, 차감 V1, 실패만)
// ════════════════════════════════════════════════════════════
// 중단 버튼(btnStop, btnStopV2)은 작업 진행 상태에 따라 자체 제어되므로
// user_code 그룹 가시성 토글 대상에서 분리
const USER_CODE_BUTTON_VISIBILITY = {
  HI: ['btnRangeSelect', 'btnRangeDeselect', 'btnSkip', 'btnStart', 'btnReview', 'btnRefCodeV2', 'btnOrderNumber', 'btnSaveV2', 'btnDeductV2', 'btnExportFailV2'],
  MB: ['btnRangeSelect', 'btnRangeDeselect', 'btnSkip', 'btnStart', 'btnReview', 'btnRefCodeV2', 'btnOrderNumber', 'btnSaveV2', 'btnDeductV2', 'btnExportFailV2'],
  BZ: ['btnRangeSelect', 'btnRangeDeselect', 'btnSkip', 'btnStart', 'btnReview', 'btnRefCodeV2', 'btnOrderNumber', 'btnSaveSupabase', 'btnSaveV2', 'btnDeduct', 'btnExportFailV2'],
  BO: ['btnRangeSelect', 'btnRangeDeselect', 'btnSkip', 'btnStart', 'btnReview', 'btnRefCodeV2', 'btnOrderNumber', 'btnSaveV2', 'btnDeduct', 'btnExportFailV2'],
};

// 우측 패널의 모든 버튼 ID (가시성 계산용)
// - 'btnSave'(추가): 입력 섹션에 위치
// - 'btnStop'/'btnStopV2': 작업 진행 상태로 자체 제어 (disabled 토글)
const ALL_RP_ORDER_BUTTONS = [
  'btnRangeSelect', 'btnRangeDeselect',
  'btnSkip', 'btnStart', 'btnReview',
  'btnRefCode', 'btnRefCodeV2',
  'btnOrderNumber', 'btnSaveSupabase', 'btnSaveV2',
  'btnDeduct', 'btnDeductV2',
  'btnExportSuccess', 'btnExportFail', 'btnExportFailV2'
];

// user_code → prefix 추출 (예: "HI-001" → "HI", "BZ123" → "BZ")
function getUserCodePrefix(userCode) {
  if (!userCode) return null;
  const m = userCode.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : null;
}

// user_code 그룹에 따라 버튼 표시/숨김
function applyUserCodeButtonVisibility() {
  const ftUserSelect = document.getElementById('ftUserSelect');
  const userCode = ftUserSelect?.selectedOptions[0]?.dataset.userCode || '';
  const prefix = getUserCodePrefix(userCode);
  const allowList = USER_CODE_BUTTON_VISIBILITY[prefix] || null;

  ALL_RP_ORDER_BUTTONS.forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (!allowList) {
      // user_code 미선택/매핑 없음 → 모든 버튼 숨김
      btn.style.display = 'none';
    } else {
      btn.style.display = allowList.includes(id) ? '' : 'none';
    }
  });

  pruneEmptyRpGroups();
}

// 모든 버튼이 숨겨진 그룹/디바이더는 숨김 (시각적 빈 공간 제거)
function pruneEmptyRpGroups() {
  const rpOrder = document.getElementById('rpOrder');
  if (!rpOrder) return;

  const children = Array.from(rpOrder.children);

  // 1차: 그룹 단위로 빈 그룹 식별 후 숨김
  children.forEach(el => {
    if (!el.classList.contains('rp-group')) return;
    const buttons = el.querySelectorAll('button');
    if (buttons.length === 0) return;
    const allHidden = Array.from(buttons).every(b => b.style.display === 'none');
    el.style.display = allHidden ? 'none' : '';
  });

  // 2차: 디바이더 — 인접한 보이는 그룹이 양쪽에 모두 있을 때만 표시
  let prevVisibleGroup = null;
  let pendingDivider = null;
  children.forEach(el => {
    if (el.classList.contains('rp-group')) {
      const isVisible = el.style.display !== 'none';
      if (isVisible) {
        if (pendingDivider && prevVisibleGroup) {
          pendingDivider.style.display = '';
        }
        prevVisibleGroup = el;
        pendingDivider = null;
      }
    } else if (el.classList.contains('rp-divider') || el.classList.contains('rp-divider-line')) {
      el.style.display = 'none';  // 일단 숨겼다가 다음 보이는 그룹 만나면 켬
      pendingDivider = el;
    }
  });
}

// ════════════════════════════════════════════════════════════
// 탭 전환 — 좌측 사이드바 + 콘텐츠 + 우측 액션 패널 + 헤더 컨트롤 동기화
// ════════════════════════════════════════════════════════════
function switchTab(tabName) {
  currentTab = tabName;

  // 콘텐츠 탭 전환
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));

  if (tabName === 'order') {
    document.getElementById('tab-order').classList.add('active');
    document.getElementById('sideOrder').classList.add('active');
  } else if (tabName === 'orderV2') {
    document.getElementById('tab-orderV2').classList.add('active');
    document.getElementById('sideOrderV2').classList.add('active');
    // 진입 시 드롭박스 새로고침 (ft_carts.status='ORDER' 목록)
    loadFtCartsDropdown();
  } else if (tabName === 'inquiry') {
    document.getElementById('tab-inquiry').classList.add('active');
    document.getElementById('sideInquiry').classList.add('active');
  }

  // 우측 액션 패널 섹션 전환 — rpOrder 는 주문/V2 주문 두 탭 공유
  const isOrderLike = tabName === 'order' || tabName === 'orderV2';
  document.getElementById('rpOrder').style.display = isOrderLike ? 'flex' : 'none';
  document.getElementById('rpInquiry').style.display = tabName === 'inquiry' ? 'flex' : 'none';

  // 상단 헤더의 패스워드 + 사용자/유저 드롭박스 — 주문/V2 주문 탭에서 노출
  const userControls = document.getElementById('userControls');
  if (userControls) userControls.style.display = isOrderLike ? 'flex' : 'none';

  // 공유 주문 목록 영역 — 주문/V2 주문 탭에서만 노출 (inquiry 탭에서는 숨김)
  const sharedOrderList = document.getElementById('sharedOrderList');
  const sharedOrderListSpacer = document.getElementById('sharedOrderListSpacer');
  if (sharedOrderList) sharedOrderList.style.display = isOrderLike ? '' : 'none';
  if (sharedOrderListSpacer) sharedOrderListSpacer.style.display = isOrderLike ? '' : 'none';

  updateDataInputState();
}

// 버튼 단계 상태 관리
let stepStatus = {
  parse: false,      // 정리
  order: false,      // 주문 생략/진행
  review: false,     // 검수
  refCode: false,    // 참조코드 입력
  orderNumber: false,// 주문번호 등록
  save: false,       // 저장
  deduct: false,     // 차감
  success: false,    // 성공 내보내기
  fail: false        // 실패 내보내기
};

// 버튼 단계 색상 갱신 — V1/V2 짝꿍 버튼을 같은 단계로 처리
function updateButtonSteps() {
  // V1 + V2 짝꿍 버튼 참조
  const btnSave         = document.getElementById('btnSave');
  const btnSkip         = document.getElementById('btnSkip');
  const btnStart        = document.getElementById('btnStart');
  const btnReview       = document.getElementById('btnReview');
  const btnRefCode      = document.getElementById('btnRefCode');
  const btnRefCodeV2    = document.getElementById('btnRefCodeV2');
  const btnOrderNumber  = document.getElementById('btnOrderNumber');
  const btnSaveSupabase = document.getElementById('btnSaveSupabase');
  const btnSaveV2       = document.getElementById('btnSaveV2');
  const btnDeduct       = document.getElementById('btnDeduct');
  const btnDeductV2     = document.getElementById('btnDeductV2');
  const btnExportSuccess  = document.getElementById('btnExportSuccess');
  const btnExportFail     = document.getElementById('btnExportFail');
  const btnExportFailV2   = document.getElementById('btnExportFailV2');

  // 단계 클래스 초기화 — V2 짝꿍 포함
  const allBtns = [
    btnSave, btnSkip, btnStart, btnReview,
    btnRefCode, btnRefCodeV2,
    btnOrderNumber,
    btnSaveSupabase, btnSaveV2,
    btnDeduct, btnDeductV2,
    btnExportSuccess, btnExportFail, btnExportFailV2
  ];
  allBtns.forEach(btn => btn?.classList.remove('completed', 'next', 'active'));

  // 정리(parse) 단계
  if (stepStatus.parse) {
    btnSave?.classList.add('completed');
    if (!stepStatus.order) {
      btnSkip?.classList.add('next');
      btnStart?.classList.add('next');
    }
  } else {
    btnSave?.classList.add('next');
  }

  // 주문(order) 단계
  if (stepStatus.order) {
    btnSkip?.classList.add('completed');
    btnStart?.classList.add('completed');
    if (!stepStatus.review) {
      btnReview?.classList.add('next');
    }
  }

  // 검수(review) 단계
  if (stepStatus.review) {
    btnReview?.classList.add('completed');
    if (!stepStatus.refCode) {
      btnRefCode?.classList.add('next');
      btnRefCodeV2?.classList.add('next');
    }
  }

  // 참조코드(refCode) 단계 — V1/V2 동시 처리
  if (stepStatus.refCode) {
    btnRefCode?.classList.add('completed');
    btnRefCodeV2?.classList.add('completed');
    if (!stepStatus.orderNumber) {
      btnOrderNumber?.classList.add('next');
    }
  }

  // 주문번호 등록(orderNumber) 단계
  if (stepStatus.orderNumber) {
    btnOrderNumber?.classList.add('completed');
    if (!stepStatus.save) {
      btnSaveSupabase?.classList.add('next');
      btnSaveV2?.classList.add('next');
    }
  }

  // 저장(save) 단계 — V1/V2 동시 처리
  if (stepStatus.save) {
    btnSaveSupabase?.classList.add('completed');
    btnSaveV2?.classList.add('completed');
    if (!stepStatus.deduct) {
      btnDeduct?.classList.add('next');
      btnDeductV2?.classList.add('next');
    }
  }

  // 차감(deduct) 단계 — V1/V2 동시 처리
  if (stepStatus.deduct) {
    btnDeduct?.classList.add('completed');
    btnDeductV2?.classList.add('completed');
    if (!stepStatus.success && !stepStatus.fail) {
      btnExportSuccess?.classList.add('next');
      btnExportFail?.classList.add('next');
      btnExportFailV2?.classList.add('next');
    }
  }

  // 내보내기(success/fail) 단계
  if (stepStatus.success) {
    btnExportSuccess?.classList.add('completed');
  }
  if (stepStatus.fail) {
    btnExportFail?.classList.add('completed');
    btnExportFailV2?.classList.add('completed');
  }
}

// 차감 기능 - 엑셀 파일 업로드
function deductStock() {
  if (orders.length === 0) {
    alert('먼저 주문 데이터를 정리해주세요.');
    return;
  }

  // 파일 입력 요소 생성
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.xlsx,.xls';
  fileInput.style.display = 'none';

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await processDeductExcel(file);
    } catch (error) {
      console.error('차감 엑셀 처리 오류:', error);
      alert('엑셀 파일 처리 중 오류가 발생했습니다: ' + error.message);
    }
  });

  document.body.appendChild(fileInput);
  fileInput.click();
  document.body.removeChild(fileInput);
}

// 차감 엑셀 파일 처리
async function processDeductExcel(file) {
  const btnDeduct = document.getElementById('btnDeduct');
  const originalText = btnDeduct ? btnDeduct.textContent : '차감';

  if (btnDeduct) {
    btnDeduct.disabled = true;
    btnDeduct.textContent = '처리 중...';
  }

  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // 시트를 배열로 변환 (헤더 포함, 병합 셀 처리)
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      blankrows: false
    });

    if (jsonData.length < 2) {
      alert('엑셀 파일에 데이터가 없습니다.');
      return;
    }

    // 병합 셀 정보 가져오기
    const merges = worksheet['!merges'] || [];

    // AD열 = 29번 인덱스 (0부터 시작, A=0, B=1, ... AD=29)
    // G열 = 6번 인덱스
    // I열 = 8번 인덱스
    // U열 = 20번 인덱스 (수량)
    const AD_COL = 29;
    const G_COL = 6;
    const I_COL = 8;
    const U_COL = 20;

    // 현재 주문의 order_code 목록 가져오기
    const currentOrderCodes = new Set();
    orders.forEach(order => {
      if (order.orderCode) {
        currentOrderCodes.add(order.orderCode);
      } else if (order.dbData && order.dbData.order_code) {
        currentOrderCodes.add(order.dbData.order_code);
      }
    });

    if (currentOrderCodes.size === 0) {
      alert('현재 주문 데이터에 주문코드(S열)가 없습니다.');
      return;
    }

    console.log('현재 주문코드 목록:', Array.from(currentOrderCodes));

    // 엑셀 AD열에서 주문코드 추출 및 검증
    const excelOrderCodes = new Set();
    const mismatchedCodes = [];

    // 병합 셀 값을 채우는 헬퍼 함수
    function getMergedValue(rowIdx, colIdx, data, merges) {
      // 현재 셀에 값이 있으면 반환
      if (data[rowIdx] && data[rowIdx][colIdx] !== undefined && data[rowIdx][colIdx] !== '') {
        return data[rowIdx][colIdx];
      }

      // 병합 셀인지 확인
      for (const merge of merges) {
        if (rowIdx >= merge.s.r && rowIdx <= merge.e.r &&
            colIdx >= merge.s.c && colIdx <= merge.e.c) {
          // 병합 셀의 시작 셀 값 반환
          if (data[merge.s.r] && data[merge.s.r][merge.s.c] !== undefined) {
            return data[merge.s.r][merge.s.c];
          }
        }
      }

      return '';
    }

    // 2행부터 데이터 검증 (1행은 헤더)
    for (let i = 1; i < jsonData.length; i++) {
      const adValue = getMergedValue(i, AD_COL, jsonData, merges);

      if (adValue && adValue.toString().trim()) {
        // "주문코드 | 주문번호(줄임) | 주문번호(줄임)" 형식에서 주문코드 추출
        const parts = adValue.toString().split('|');
        const orderCode = parts[0].trim();

        if (orderCode) {
          excelOrderCodes.add(orderCode);

          // 현재 주문목록에 없는 코드인지 확인
          if (!currentOrderCodes.has(orderCode)) {
            mismatchedCodes.push(orderCode);
          }
        }
      }
    }

    console.log('엑셀 주문코드 목록:', Array.from(excelOrderCodes));
    console.log('불일치 코드:', mismatchedCodes);

    // 불일치 코드가 있으면 경고
    if (mismatchedCodes.length > 0) {
      alert(`엑셀 파일을 확인해주세요.\n다른 주문코드(AD열)가 확인됩니다.\n\n불일치 코드: ${mismatchedCodes.join(', ')}`);
      return;
    }

    // 주문코드가 하나도 없으면 경고
    if (excelOrderCodes.size === 0) {
      alert('엑셀 파일의 AD열에서 주문코드를 찾을 수 없습니다.');
      return;
    }

    // 병합 셀의 첫 번째 행인지 확인하는 함수
    function isFirstRowOfMerge(rowIdx, colIdx, merges) {
      for (const merge of merges) {
        if (rowIdx >= merge.s.r && rowIdx <= merge.e.r &&
            colIdx >= merge.s.c && colIdx <= merge.e.c) {
          // 병합 영역에 속함 - 첫 번째 행인지 확인
          return rowIdx === merge.s.r;
        }
      }
      // 병합 영역에 속하지 않음 - 일반 셀이므로 true 반환
      return true;
    }

    // G열, I열, U열 합계 계산 (병합 셀: 첫 번째 행에서만 값 가져오기)
    let delivery_fee = 0;
    let total_I = 0;
    let item_qty = 0;

    for (let i = 1; i < jsonData.length; i++) {
      // G열: 병합된 경우 첫 번째 행에서만 값 가져오기
      if (isFirstRowOfMerge(i, G_COL, merges)) {
        const gValue = getMergedValue(i, G_COL, jsonData, merges);
        const gNum = parseFloat(String(gValue).replace(/,/g, '')) || 0;
        delivery_fee += gNum;
      }

      // I열: 병합된 경우 첫 번째 행에서만 값 가져오기
      if (isFirstRowOfMerge(i, I_COL, merges)) {
        const iValue = getMergedValue(i, I_COL, jsonData, merges);
        const iNum = parseFloat(String(iValue).replace(/,/g, '')) || 0;
        total_I += iNum;
      }

      // U열: 수량 합계 (병합 없음)
      const uValue = jsonData[i] && jsonData[i][U_COL];
      const uNum = parseInt(String(uValue).replace(/,/g, '')) || 0;
      item_qty += uNum;
    }

    // 계산 (모두 소수점 2자리까지)
    delivery_fee = Math.round(delivery_fee * 100) / 100;
    const price = Math.round((total_I - delivery_fee) * 100) / 100;
    const service_fee = Math.round(price * 0.06 * 100) / 100;
    const amount = Math.round((delivery_fee + price + service_fee) * 100) / 100;

    console.log('=== 차감 계산 결과 ===');
    console.log('delivery_fee (G열 합계):', delivery_fee);
    console.log('total_I (I열 합계):', total_I);
    console.log('price (I열 - G열):', price);
    console.log('service_fee (price * 0.06):', service_fee);
    console.log('amount (합계):', amount);
    console.log('item_qty (U열 합계):', item_qty);

    // 대표 주문코드 (첫 번째 코드 사용)
    const orderCode = Array.from(excelOrderCodes)[0];

    // Supabase에 저장
    await saveDeductTransaction({
      order_code: orderCode,
      delivery_fee: delivery_fee,
      price: price,
      service_fee: service_fee,
      amount: amount,
      item_qty: item_qty
    });

  } finally {
    if (btnDeduct) {
      btnDeduct.disabled = false;
      btnDeduct.textContent = originalText;
    }
  }
}

// 차감 트랜잭션 Supabase 저장
async function saveDeductTransaction(calcData) {
  if (!supabaseClient) {
    alert('Supabase 연결이 초기화되지 않았습니다.');
    return;
  }

  // 선택된 사용자 정보 가져오기
  const userSelect = document.getElementById('userSelect');
  const selectedUserId = userSelect ? userSelect.value : '';
  const selectedOption = userSelect ? userSelect.options[userSelect.selectedIndex] : null;
  const selectedMasterAccount = selectedOption ? selectedOption.dataset.masterAccount : '';

  if (!selectedUserId) {
    alert('사용자를 선택해주세요.');
    return;
  }

  // 오늘 날짜 (YYYY-MM-DD)
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];

  // 저장할 데이터
  const transactionData = {
    order_code: calcData.order_code,
    user_id: selectedUserId,
    transaction_type: '차감',
    description: calcData.order_code + ' 주문',
    '1688_order_id': null,
    amount: calcData.amount,
    delivery_fee: calcData.delivery_fee,
    service_fee: calcData.service_fee,
    extra_fee: null,
    balance_after: null,
    status: '성공',
    admin_note: null,
    updated_at: null,
    price: calcData.price,
    master_account: selectedMasterAccount,
    date: dateStr,
    item_qty: calcData.item_qty
  };

  console.log('=== 차감 트랜잭션 저장 ===');
  console.log('저장할 데이터:', transactionData);

  try {
    // ── order_code 기준 중복 검사 ──
    const { data: existingTx, error: checkError } = await supabaseClient
      .from('invoiceManager_transactions')
      .select('id')
      .eq('order_code', calcData.order_code)
      .limit(1);

    if (checkError) {
      console.error('중복 검사 오류:', checkError);
      alert(`중복 검사 실패: ${checkError.message}`);
      return;
    }

    let data;
    if (existingTx && existingTx.length > 0) {
      // ── 기존 레코드 UPDATE (order_code 기준) ──
      console.log(`order_code(${calcData.order_code}) 기존 레코드 발견 → UPDATE`);
      const { data: updateData, error: updateError } = await supabaseClient
        .from('invoiceManager_transactions')
        .update(transactionData)
        .eq('id', existingTx[0].id)
        .select();

      if (updateError) {
        console.error('차감 업데이트 오류:', updateError);
        alert(`차감 업데이트 실패: ${updateError.message}`);
        return;
      }
      data = updateData;
      console.log('✓ 차감 업데이트 완료:', data);
    } else {
      // ── 신규 INSERT ──
      const { data: insertData, error: insertError } = await supabaseClient
        .from('invoiceManager_transactions')
        .insert([transactionData])
        .select();

      if (insertError) {
        console.error('차감 저장 오류:', insertError);
        alert(`차감 저장 실패: ${insertError.message}`);
        return;
      }
      data = insertData;
      console.log('✓ 차감 저장 완료:', data);
    }

    // 저장 검증 - 실제로 데이터가 저장됐는지 확인
    if (!data || data.length === 0) {
      alert('차감 저장 실패: 데이터가 반환되지 않았습니다.');
      return;
    }

    const savedId = data[0].id;
    console.log('저장된 ID:', savedId);

    // ID로 다시 조회하여 검증
    const { data: verifyData, error: verifyError } = await supabaseClient
      .from('invoiceManager_transactions')
      .select('*')
      .eq('id', savedId)
      .single();

    if (verifyError) {
      console.error('차감 검증 오류:', verifyError);
      alert(`차감 저장 검증 실패: ${verifyError.message}\n\n데이터가 저장되지 않았을 수 있습니다.`);
      return;
    }

    if (!verifyData) {
      alert('차감 저장 검증 실패: 저장된 데이터를 찾을 수 없습니다.');
      return;
    }

    // 저장된 데이터 값 검증
    const isValid =
      verifyData.order_code === calcData.order_code &&
      parseFloat(verifyData.amount) === calcData.amount &&
      parseFloat(verifyData.delivery_fee) === calcData.delivery_fee &&
      parseFloat(verifyData.price) === calcData.price;

    if (!isValid) {
      console.error('데이터 불일치:', { saved: verifyData, expected: calcData });
      alert('차감 저장 검증 실패: 저장된 데이터가 일치하지 않습니다.');
      return;
    }

    console.log('✓ 차감 저장 검증 완료:', verifyData);
    alert(`차감 저장 및 검증 완료!\n\n주문코드: ${calcData.order_code}\n배송비: ${calcData.delivery_fee.toLocaleString()}원\n상품가: ${calcData.price.toLocaleString()}원\n수수료: ${calcData.service_fee.toLocaleString()}원\n총액: ${calcData.amount.toLocaleString()}원\n\n✓ Supabase 저장 확인됨 (ID: ${savedId})`);

    // 버튼 상태 업데이트
    stepStatus.deduct = true;
    updateButtonSteps();

  } catch (error) {
    console.error('차감 저장 예외:', error);
    alert('차감 저장 중 오류가 발생했습니다: ' + error.message);
  }
}

// Supabase 클라이언트 (나중에 초기화)
let supabaseClient = null;

// ========== 드롭박스 데이터 저장 ==========
let usersApiData = [];   // users_api 테이블 데이터
let ftUsersData = [];     // ft_users 테이블 데이터

// Supabase 클라이언트 초기화 (페이지 로드 후)
window.addEventListener('DOMContentLoaded', () => {
  // 초기 상태: user_code 미선택 → 우측 패널 모든 버튼 숨김
  applyUserCodeButtonVisibility();
  // 초기 상태: 패스워드 잠김 → 사용자/유저 드롭박스 비활성
  applyOrderUnlockState();

  if (window.api && window.supabase) {
    const SUPABASE_URL = window.api.getEnv('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = window.api.getEnv('SUPABASE_SERVICE_ROLE_KEY');

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      console.log('✓ Supabase 클라이언트 초기화 완료');

      // 드롭박스 데이터 로드 (users_api + ft_users)
      loadUsersApi();
      loadFtUsers();
    } else {
      console.warn('⚠️ Supabase 환경 변수가 설정되지 않았습니다.');
    }
  } else {
    console.warn('⚠️ window.api 또는 window.supabase를 사용할 수 없습니다.');
  }
});

// users_api 데이터 로드
async function loadUsersApi() {
  if (!supabaseClient) {
    console.warn('Supabase 클라이언트가 초기화되지 않았습니다.');
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('users_api')
      .select('user_id, user_code, master_account, coupang_name')
      .order('master_account', { ascending: true });

    if (error) {
      console.error('users_api 로드 오류:', error);
      return;
    }

    usersApiData = data || [];
    console.log(`✓ users_api 로드 완료: ${usersApiData.length}개`);

    // 드롭박스 채우기
    populateUserSelect();
  } catch (error) {
    console.error('users_api 로드 중 예외:', error);
  }
}

// ========== ft_users 데이터 로드 ==========
async function loadFtUsers() {
  if (!supabaseClient) {
    console.warn('Supabase 클라이언트가 초기화되지 않았습니다.');
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('ft_users')
      .select('id, full_name, user_code, phone, address, balance_id, vender_name')
      .order('full_name', { ascending: true });

    if (error) {
      console.error('ft_users 로드 오류:', error);
      return;
    }

    ftUsersData = data || [];
    console.log(`✓ ft_users 로드 완료: ${ftUsersData.length}개`);

    // 드롭박스 채우기
    populateFtUserSelect();
  } catch (error) {
    console.error('ft_users 로드 중 예외:', error);
  }
}

// ft_users 드롭박스 채우기
function populateFtUserSelect() {
  const select = document.getElementById('ftUserSelect');
  if (!select) return;

  // 기존 옵션 제거 (첫 번째 옵션 제외)
  while (select.options.length > 1) {
    select.remove(1);
  }

  // ft_users 데이터로 옵션 추가 (full_name + user_code 형식)
  ftUsersData.forEach(user => {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = `${user.vender_name || user.full_name} ${user.user_code}`;
    option.dataset.userCode = user.user_code;
    option.dataset.fullName = user.full_name;
    option.dataset.phone = user.phone || '';
    option.dataset.address = user.address || '';
    option.dataset.balanceId = user.balance_id || '';
    option.dataset.venderName = user.vender_name || '';
    select.appendChild(option);
  });

  // 초기 상태 업데이트
  updateDataInputState();
  applyUserCodeButtonVisibility();

  // 유저 선택 시 데이터 입력 활성화 + user_code 그룹별 버튼 가시성 갱신 + V2 드롭박스 새로고침
  select.addEventListener('change', () => {
    updateDataInputState();
    applyUserCodeButtonVisibility();
    if (typeof loadFtCartsDropdown === 'function') loadFtCartsDropdown();
    // 【V2 주문 탭 세션】 사용자 변경 시 order_no 세션 리셋
    v2SessionOrderNo = null;
  });
}

// ========== users_api 드롭박스 채우기 ==========
function populateUserSelect() {
  const select = document.getElementById('userSelect');
  if (!select) return;

  // 기존 옵션 제거 (첫 번째 옵션 제외)
  while (select.options.length > 1) {
    select.remove(1);
  }

  // 사용자 데이터로 옵션 추가 (coupang_name + user_code 형식)
  usersApiData.forEach(user => {
    const option = document.createElement('option');
    option.value = user.user_id;
    option.textContent = `${user.coupang_name} ${user.user_code}`;
    option.dataset.userCode = user.user_code;
    option.dataset.masterAccount = user.master_account;
    select.appendChild(option);
  });

  // 초기 상태: 데이터 입력 비활성화
  updateDataInputState();

  // 사용자 선택 시 데이터 입력 활성화
  select.addEventListener('change', () => {
    updateDataInputState();
  });
}

// ════════════════════════════════════════════════════════════
// 드롭박스/패스워드 선택 상태에 따른 입력 활성화/비활성화
// - 주문 탭: 패스워드 통과 + 사용자/유저 모두 선택 + user_code 일치 → 활성화
// - 문의 탭: 사용자/유저 드롭박스와 무관하게 항상 활성화 (독립 동작)
// ════════════════════════════════════════════════════════════
function updateDataInputState() {
  // ── 주문 탭 입력 상태 ──
  const userSelect = document.getElementById('userSelect');
  const ftUserSelect = document.getElementById('ftUserSelect');
  const dataInput = document.getElementById('dataInput');
  const btnSave = document.getElementById('btnSave');

  if (dataInput) {
    const isUserSelected = userSelect && userSelect.value !== '';
    const isFtUserSelected = ftUserSelect && ftUserSelect.value !== '';
    const bothSelected = isUserSelected && isFtUserSelected;

    const userCode = userSelect?.selectedOptions[0]?.dataset.userCode || '';
    const ftUserCode = ftUserSelect?.selectedOptions[0]?.dataset.userCode || '';
    const codesMatch = userCode && ftUserCode && userCode === ftUserCode;

    if (isOrderUnlocked && bothSelected && codesMatch) {
      dataInput.disabled = false;
      dataInput.style.opacity = '1';
      dataInput.placeholder = '구글 시트에서 행 전체를 선택하고 복사(Ctrl+C) 후 여기에 붙여넣기(Ctrl+V)';
      if (btnSave) btnSave.disabled = false;
    } else {
      dataInput.disabled = true;
      dataInput.style.opacity = '0.5';
      if (!isOrderUnlocked) {
        dataInput.placeholder = '패스워드를 먼저 입력해주세요';
      } else if (bothSelected && !codesMatch) {
        dataInput.placeholder = `user_code 불일치: 사용자(${userCode}) ≠ 유저(${ftUserCode})`;
      } else {
        dataInput.placeholder = '사용자와 유저를 모두 선택해주세요';
      }
      if (btnSave) btnSave.disabled = true;
    }
  }

  // ── 문의 탭 입력 상태 (사용자/유저 드롭박스와 독립) ──
  const inquiryDataInput = document.getElementById('inquiryDataInput');
  const btnInquirySave = document.getElementById('btnInquirySave');
  if (inquiryDataInput) {
    inquiryDataInput.disabled = false;
    inquiryDataInput.style.opacity = '1';
    inquiryDataInput.placeholder = '구글 시트에서 행 전체를 선택하고 복사(Ctrl+C) 후 여기에 붙여넣기(Ctrl+V)';
    if (btnInquirySave) btnInquirySave.disabled = false;
  }
}

// 페이지 떠나기 전 확인 (beforeunload) - 새로고침용
window.addEventListener('beforeunload', (e) => {
  // 저장되지 않은 데이터가 있고, 주문 목록이 있는 경우
  if (!isDataSaved && orders.length > 0) {
    e.preventDefault();
    e.returnValue = '';  // Chrome에서 필요
    return '';
  }
});

// 창 닫기 확인 (main process에서 요청)
if (window.api && window.api.onCheckUnsavedData) {
  window.api.onCheckUnsavedData(() => {
    const hasUnsavedData = !isDataSaved && orders.length > 0;

    if (hasUnsavedData) {
      // 저장되지 않은 데이터가 있으면 모달 표시
      pendingAction = 'close';
      showSaveConfirmModal();
    }

    // main process에 응답
    window.api.sendUnsavedDataResponse(hasUnsavedData);
  });
}

// Ctrl+R 새로고침 가로채기
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
    if (!isDataSaved && orders.length > 0) {
      e.preventDefault();
      pendingAction = 'refresh';
      showSaveConfirmModal();
    }
  }
});

// 저장 확인 모달 표시
function showSaveConfirmModal() {
  const modal = document.getElementById('saveConfirmModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

// 저장 확인 모달 닫기
function closeSaveConfirmModal() {
  const modal = document.getElementById('saveConfirmModal');
  if (modal) {
    modal.style.display = 'none';
  }
  pendingAction = null;
}

// 저장 후 종료/새로고침
async function saveAndExit() {
  closeSaveConfirmModal();
  await saveToSupabase();

  if (pendingAction === 'close') {
    // 창 닫기의 경우 main process에 알림
    if (window.api && window.api.closeAfterSave) {
      window.api.closeAfterSave();
    }
  } else {
    executePendingAction();
  }
}

// 저장하지 않고 종료/새로고침
function exitWithoutSave() {
  closeSaveConfirmModal();
  isDataSaved = true;  // 확인 없이 진행하도록 플래그 변경

  if (pendingAction === 'close') {
    // 창 닫기의 경우 main process에 알림
    if (window.api && window.api.forceClose) {
      window.api.forceClose();
    }
  } else {
    executePendingAction();
  }
}

// 앱 재시작 — Electron 메인 프로세스에 종료+재실행 요청
//  현재 작업/창 상태를 모두 버리고 "닫고 새로 연 것" 과 동일한 상태로 복귀.
function restartApp() {
  if (!confirm('앱을 재시작하시겠습니까?\n저장하지 않은 데이터는 사라집니다.')) {
    return;
  }
  if (window.api && window.api.restartApp) {
    window.api.restartApp();
  } else {
    // fallback (Electron 환경이 아닐 경우)
    location.reload();
  }
}

// 대기 중인 액션 실행
function executePendingAction() {
  if (pendingAction === 'refresh') {
    location.reload();
  }
  pendingAction = null;
}

// ============================================================
// [URL 처리] URL 정리 + offer_id 추출 헬퍼 (parseData / 링크수정 공용)
// ============================================================

/**
 * 원본 URL을 정리하고 offer_id를 추출한다.
 * @param {string} rawUrl
 * @returns {{ cleanedUrl: string, offerId: string|null }}
 */
function processUrl(rawUrl) {
  let cleanedUrl = (rawUrl || '').trim();

  // 1688 상세 URL이면 offer/{id}.html 까지만 추출
  if (cleanedUrl.startsWith('https://detail.1688.com')) {
    const match = cleanedUrl.match(/https:\/\/detail\.1688\.com\/offer\/\d+\.html/);
    if (match) cleanedUrl = match[0] + '?';
  }

  // offer_id 추출
  const offerIdMatch = cleanedUrl.match(/offer\/(\d+)\.html/);
  const offerId = offerIdMatch ? offerIdMatch[1] : null;

  return { cleanedUrl, offerId };
}

// 데이터 파싱
async function parseData() {
  console.log('parseData 함수 호출됨');
  const dataInput = document.getElementById('dataInput');
  const input = dataInput.value.trim();

  if (!input) {
    alert('데이터를 입력해주세요.');
    return;
  }

  const lines = input.split('\n').filter(line => line.trim());

  // 누적 모드: 기존 orders는 유지하고 새 데이터를 push
  const newOrders = [];

  // ─── 【주문 탭】 자동 생성 모드 사전 준비 ─────────────────────
  // 체크박스('주문번호 생성') 체크 상태이면 V2 주문 탭과 동일한 헬퍼로
  //   - order_no (이번 추가 작업 전체 공유)
  //   - item_seq (오늘·동일 user 의 max + 1 부터 누적)
  //   - item_no  (각 정상 행마다 generateItemNo)
  // 을 자동 생성. 체크 해제 시 시트 B/S열 값을 그대로 사용 (기존 동작).
  const autoGen = document.getElementById('autoGenOrderNo')?.checked ?? true;
  let autoUserCode = '', autoOrderNo = '', autoBaseSeq = 0;
  if (autoGen) {
    const ftUserSelect = document.getElementById('ftUserSelect');
    const userId = ftUserSelect?.value || '';
    autoUserCode = ftUserSelect?.selectedOptions[0]?.dataset.userCode || '';
    if (!userId || !autoUserCode) {
      alert('자동 생성 모드: 사용자(user_code) 가 선택돼 있어야 합니다.\n체크박스를 해제하거나 사용자를 먼저 선택해주세요.');
      return;
    }
    autoOrderNo = generateOrderNo(autoUserCode);
    autoBaseSeq = await getItemSeqBase(userId);

    // ─ Y(set_total) / Z(set_seq) 사전 검증 (자동 모드 전용) ─
    // 누락된 행이 하나라도 있으면 즉시 에러 → 전체 추가 중단.
    // (행 단위 무효 처리가 아니라 사용자에게 hard 에러로 알림)
    const ztErrors = [];
    for (let i = 0; i < lines.length; i++) {
      const lp = lines[i].split('\t');
      const t = lp[24] ? lp[24].trim() : '';
      const s = lp[25] ? lp[25].trim() : '';
      const tBad = (t === '' || isNaN(parseInt(t)));
      const sBad = (s === '' || isNaN(parseInt(s)));
      if (tBad || sBad) {
        const miss = [];
        if (tBad) miss.push('Y(set_total)');
        if (sBad) miss.push('Z(set_seq)');
        ztErrors.push(`${i + 1}행: ${miss.join(', ')} 누락/형식 오류`);
      }
    }
    if (ztErrors.length > 0) {
      const head = '【자동 생성 모드】 set_total(Y) / set_seq(Z) 는 필수입니다.\n';
      const body = ztErrors.slice(0, 10).join('\n');
      const tail = ztErrors.length > 10 ? `\n…외 ${ztErrors.length - 10}개 행` : '';
      alert(head + '\n' + body + tail + '\n\n추가가 중단되었습니다. 시트를 확인 후 다시 시도해주세요.');
      return;
    }
  }
  let autoSeqCursor = autoBaseSeq; // 정상 행 push 시마다 +1 (무효 행은 건너뜀)

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    // 탭으로 구분 (구글 시트에서 복사하면 탭으로 구분됨)
    const parts = line.split('\t');

    // 최소 12개 컬럼 필요 (A~L까지)
    if (parts.length < 12) {
      // 컬럼 부족 → 무효 행으로 추가 (테이블·미리보기에 빨간색 표시)
      newOrders.push({
        orderNo: '주문 데이터를 확인해주세요',
        quantity: 0, color: '', size: '', url: '',
        orderCode: '', status: 'pending', errorReason: '',
        isInvalid: true,
        invalidReason: `컬럼 부족 (${parts.length}개 / 최소 12개)`,
        dbData: {}, originalData: parts
      });
      continue;
    }

    const orderNo = parts[1].trim();    // B열: 주문번호
    const quantity = parseInt(parts[4]) || 1;  // E열: 수량
    const color = parts[6].trim();      // G열: 색상옵션 (china_option1)
    const size = parts[7].trim();       // H열: 사이즈옵션 (china_option2)
    // L열: site_url — URL 정리 + offer_id 추출 (processUrl 공용 함수)
    const { cleanedUrl: url, offerId } = processUrl(parts[11].trim());

    // 필수 필드 누락 → 무효 행으로 추가
    //  ※ 자동 생성 모드(autoGen)에서는 B열(주문번호) 가 비어있어도 OK (자동값으로 채워짐)
    //  ※ Y/Z 누락은 사전 검증(parseData 진입부)에서 alert 로 중단 처리하므로 여기 안 옴
    const orderNoMissing = !autoGen && !orderNo;
    if (orderNoMissing || !color || !size || !url) {
      const missing = [];
      if (orderNoMissing) missing.push('주문번호(B)');
      if (!color)         missing.push('색상(G)');
      if (!size)          missing.push('사이즈(H)');
      if (!url)           missing.push('URL(L)');
      newOrders.push({
        orderNo: '주문 데이터를 확인해주세요',
        quantity, color, size, url,
        orderCode: parts[18] ? parts[18].trim() : '',
        status: 'pending', errorReason: '',
        isInvalid: true,
        invalidReason: `누락: ${missing.join(', ')}`,
        dbData: {
          order_number: parts[1] ? parts[1].trim() : null,
          item_name: parts[2] ? parts[2].trim() : null,
          option_name: parts[3] ? parts[3].trim() : null,
          order_qty: parseInt(parts[4]) || null,
          barcode: parts[5] ? parts[5].trim() : null,
          china_option1: parts[6] ? parts[6].trim() : null,
          china_option2: parts[7] ? parts[7].trim() : null,
          site_url: parts[11] ? parts[11].trim() : null,
        },
        originalData: parts
      });
      continue;
    }

    // ─── 정상 행: 자동 생성 모드면 B/S 열 값을 생성값으로 대체 ───
    let rowOrderNo   = orderNo;                                  // 기본: 시트 B열
    let rowOrderCode = parts[18] ? parts[18].trim() : '';        // 기본: 시트 S열
    let computedItemSeq = null;
    if (autoGen) {
      autoSeqCursor += 1;
      computedItemSeq = autoSeqCursor;
      const setTotal = parts[24] ? parseInt(parts[24]) : null;
      const setSeq   = parts[25] ? parseInt(parts[25]) : null;
      rowOrderNo   = generateItemNo(autoUserCode, computedItemSeq, setTotal, setSeq);
      rowOrderCode = autoOrderNo;
    }

    // 정상 행
    newOrders.push({
      // 화면 표시용 (기존 필드 유지)
      orderNo: rowOrderNo,    // B열 (자동 모드: 생성된 item_no)
      quantity,               // E열
      color,                  // G열
      size,                   // H열
      url,                    // L열
      orderCode: rowOrderCode,// S열 (자동 모드: 생성된 order_no)
      status: 'pending',
      errorReason: '',

      // Supabase 저장용 전체 데이터
      dbData: {
        date: new Date().toISOString(),                             // 현재 시간 자동 입력
        raw_date: parts[0] ? parts[0].trim() : null,               // A열 (MMDD)
        order_number: rowOrderNo,                                   // B열 (자동 모드: 생성된 item_no)
        item_name: parts[2] ? parts[2].trim() : null,               // C열
        option_name: parts[3] ? parts[3].trim() : null,             // D열
        order_qty: parseInt(parts[4]) || null,                      // E열
        barcode: parts[5] ? parts[5].trim() : null,                 // F열
        china_option1: parts[6] ? parts[6].trim() : null,           // G열 (색상)
        china_option2: parts[7] ? parts[7].trim() : null,           // H열 (사이즈)
        china_price: parts[8] ? parseFloat(parseFloat(parts[8]).toFixed(2)) : null,        // I열
        china_total_price: parts[9] ? parseFloat(parseFloat(parts[9]).toFixed(2)) : null,  // J열
        img_url: parts[10] ? parts[10].trim() : null,               // K열
        site_url: parts[11] ? parts[11].trim() : null,              // L열
        status_ordering: parts[12] ? parseInt(parts[12]) : null,    // M열
        status_import: parts[13] ? parseInt(parts[13]) : null,      // N열
        status_cancel: parts[14] ? parseInt(parts[14]) : null,      // O열
        status_export: parts[15] ? parseInt(parts[15]) : null,      // P열
        korea_note: parts[16] ? parts[16].trim() : null,            // Q열
        china_note: parts[17] ? parts[17].trim() : null,            // R열
        order_code: rowOrderCode || null,                           // S열 (자동 모드: 생성된 order_no)
        shipment_code: parts[19] ? parts[19].trim() : null,         // T열
        option_id: parts[20] ? parts[20].trim() : null,             // U열
        coupang_shipment_size: parts[21] ? parts[21].trim() : null, // V열
        composition: parts[22] ? parts[22].trim() : null,           // W열
        recomanded_age: parts[23] ? parts[23].trim() : null,        // X열
        set_total: parts[24] ? parseInt(parts[24]) : null,          // Y열
        set_seq: parts[25] ? parseInt(parts[25]) : null,            // Z열
        '1688_offer_id': offerId,                                   // URL에서 추출
        '1688_order_id': null,                                      // 나중에 매칭 시 추가
        // 【주문 탭 자동 생성 모드】 V2 저장 시 ft_order_items.item_seq 누적값으로 사용
        ...(computedItemSeq != null && { _computed_item_seq: computedItemSeq })
      },

      // 원본 구글 시트 데이터 전체 저장 (기존 로직 호환)
      originalData: parts
    });
  }

  // 파싱 실패 (이번 입력에서 단 1행도 못 만든 경우)
  if (newOrders.length === 0) {
    alert('유효한 데이터가 없습니다. 형식을 확인해주세요.');
    return;
  }

  // ── 중복 사전 체크 (orders.push 직전) ──
  // Supabase 의 ft_order_items 에 동일 데이터가 이미 존재하는지 조회.
  //   B열 order_number → ft_order_items.item_no
  //   S열 order_code   → ft_order_items.order_no
  // 중복이 있으면 사용자에게 진행 여부를 묻는다.
  const candNumbers = [...new Set(
    newOrders.map(o => o.dbData?.order_number).filter(Boolean)
  )];
  const candCodes = [...new Set(
    newOrders.map(o => o.dbData?.order_code).filter(Boolean)
  )];

  console.log('[중복체크] supabaseClient:', !!supabaseClient,
              '| candNumbers(item_no):', candNumbers,
              '| candCodes(order_no):', candCodes);

  const dupes = { byNumber: [], byCode: [] };
  try {
    if (!supabaseClient) {
      console.warn('[중복체크] supabaseClient 가 초기화되지 않음 — 중복 검사 건너뜀');
    }
    if (candNumbers.length > 0 && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('ft_order_items')
        .select('item_no')
        .in('item_no', candNumbers);
      console.log('[중복체크] item_no 조회 결과:', { data, error });
      if (error) throw error;
      dupes.byNumber = (data || []).map(r => r.item_no);
    }
    if (candCodes.length > 0 && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('ft_order_items')
        .select('order_no')
        .in('order_no', candCodes);
      console.log('[중복체크] order_no 조회 결과:', { data, error });
      if (error) throw error;
      dupes.byCode = (data || []).map(r => r.order_no);
    }
  } catch (e) {
    console.error('중복 사전 조회 실패:', e);
    if (!confirm('중복 사전 조회 중 오류가 발생했습니다. 그대로 진행할까요?')) {
      return;
    }
  }

  console.log('[중복체크] 최종 dupes:', dupes);

  const dupNumberSet = new Set(dupes.byNumber);
  const dupCodeSet = new Set(dupes.byCode);
  if (dupNumberSet.size > 0 || dupCodeSet.size > 0) {
    const sample = [
      ...[...dupNumberSet].slice(0, 3).map(v => `order_number(item_no): ${v}`),
      ...[...dupCodeSet].slice(0, 3).map(v => `order_code(order_no): ${v}`)
    ].join('\n');
    const msg =
      '이미 중복된 데이터가 있습니다. 진행을 원하십니까 ?\n' +
      '중복된 데이터가 존재하며 저장 시 문제가 생길 수 있습니다.\n\n' +
      `중복 ${dupNumberSet.size + dupCodeSet.size}건 발견:\n${sample}`;
    if (!confirm(msg)) {
      return; // '취소' → 추가 중단 (orders/미리보기/입력폼 그대로 유지)
    }
  }

  // ── 누적 추가: 기존 orders 보존, 새 행만 push ──
  const addedCount = newOrders.length;
  orders.push(...newOrders);

  // 데이터가 파싱되면 저장되지 않은 상태로 표시
  isDataSaved = false;

  // 데이터 미리보기 렌더링
  renderDataPreview();

  renderOrderList();
  document.getElementById('btnSkip').disabled = false;
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnReview').disabled = false;
  document.getElementById('btnRefCode').disabled = false;

  // 버튼 상태 업데이트
  stepStatus.parse = true;
  updateButtonSteps();

  // ── 입력폼 초기화 (다음 추가를 위해) ──
  dataInput.value = '';
  console.log(`+ ${addedCount}건 추가됨 (총 ${orders.length}건)`);
}

// ════════════════════════════════════════════════════════════
// 【V2 주문 탭 전용】 ft_carts / ft_cart_items 기반 장바구니 불러오기
// ────────────────────────────────────────────────────────────
//  ★ 호출처 구분 ★
//  - loadFtCartsDropdown        : V2 주문 탭 진입 / 사용자 변경 시 호출
//  - handleCartSelect           : [추가] 버튼 클릭 시 호출 (드롭박스 onchange 는 단순 토글)
//  - reconstructOrderFromCartItem: ft_cart_items 행 → orders[] 객체로 변환
//  - generateOrderNo/ItemNo, getItemSeqBase, mapCartSeqToItemSeq: 생성 규칙 헬퍼
//  - openCartDeleteModal / closeCartDeleteModal / confirmCartDelete: 카트 삭제 (패스워드 모달)
//
//  ▸ V2 저장 흐름과의 관계:
//     1) 사용자가 V2 주문 탭에서 카트를 고르면 위 함수들이 orders[] 를 채움.
//     2) 각 order 의 dbData 에 order_code(=order_no), order_number(=item_no),
//        _computed_item_seq, _cartId 가 미리 세팅됨.
//     3) 사용자가 [V2 저장] 클릭 → saveToSupabaseV2() 가 그 값을 그대로
//        ft_orders / ft_order_items 에 INSERT (주문 탭과 동일한 INSERT 흐름).
//     4) INSERT 성공 후 _cartId 가 있으면 ft_carts.status = 'DONE' UPDATE.
// ════════════════════════════════════════════════════════════

// ─── V2 주문 탭 세션 상태 ──────────────────────────────────────
// 한 번의 주문 작업(= 다음 V2 저장 직전까지)이 공유하는 order_no.
// null → 다음 [추가] 시 새로 생성. 초기화 시점:
//   - saveToSupabaseV2 성공 후
//   - ftUserSelect change (사용자 바뀜)
//   - 페이지 새로고침/재시작
let v2SessionOrderNo = null;

// 카트 추가 잠금 플래그.
//   - [주문 진행] / [주문 생략] 이 한 번이라도 실행되면 true.
//   - V2 저장이 끝나도 잠금 유지 → 다음 묶음은 [재시작] 이후에 시작.
//   - 잠금 상태에서는 드롭박스/[추가]/[삭제] 모두 disabled.
let cartAddLocked = false;

// V2 카트 영역 잠금 상태를 DOM 에 동기화하는 헬퍼.
// 잠금이면 모두 비활성 / 풀려있고 카트가 선택돼 있을 때만 두 버튼 활성.
function applyCartAreaLock() {
  const sel    = document.getElementById('ftOrderSelectV2');
  const btnAdd = document.getElementById('btnCartAdd');
  const btnDel = document.getElementById('btnCartDelete');
  if (sel)    sel.disabled    = cartAddLocked;
  if (btnAdd) btnAdd.disabled = cartAddLocked || !sel?.value;
  if (btnDel) btnDel.disabled = cartAddLocked || !sel?.value;
}

function lockCartArea() {
  cartAddLocked = true;
  applyCartAreaLock();
}

// ─── 생성 규칙 헬퍼 ────────────────────────────────────────────

// order_no 생성: 'OR' + user_code + YYMMDD + '-' + 시간알파벳 + 분(2자리)
// 시간알파벳: 0시=A, 1시=B, …, 13시=N, …, 23시=X
// 예: user_code='BO', 13:31 → ORBO260608-N31
function generateOrderNo(userCode) {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hourLetter = String.fromCharCode(65 + d.getHours());
  const min = String(d.getMinutes()).padStart(2, '0');
  return `OR${userCode}${yy}${mm}${dd}-${hourLetter}${min}`;
}

// 분(分) 자리 +1. 60 → 다음 시간 알파벳. X59 다음은 wrap → random suffix 로 보수적 회피.
function bumpOrderNoByMinute(orderNo) {
  const m = orderNo.match(/^(.+)-([A-X])(\d{2})$/);
  if (!m) return `${orderNo}_${Math.floor(Math.random() * 1000)}`;
  let [, prefix, hourLetter, minStr] = m;
  let min = parseInt(minStr) + 1;
  if (min >= 60) {
    min = 0;
    const nextChar = String.fromCharCode(hourLetter.charCodeAt(0) + 1);
    if (nextChar > 'X') {
      return `${prefix}-${hourLetter}${minStr}_${Math.floor(Math.random() * 1000)}`;
    }
    hourLetter = nextChar;
  }
  return `${prefix}-${hourLetter}${String(min).padStart(2, '0')}`;
}

// ft_orders.order_no 중복 1회 조회. 실패하면 false (보수적으로 "없다고 가정" → 진행).
async function orderNoExists(orderNo) {
  if (!supabaseClient) return false;
  const { data, error } = await supabaseClient
    .from('ft_orders')
    .select('id')
    .eq('order_no', orderNo)
    .limit(1);
  if (error) {
    console.warn('[order_no 중복 체크 실패]', error);
    return false;
  }
  return !!(data && data.length > 0);
}

// 충돌 시 분(分) +1 반복. 최악 60회 시도 후 그대로 반환.
async function generateUniqueOrderNo(userCode) {
  let candidate = generateOrderNo(userCode);
  for (let i = 0; i < 60; i++) {
    if (!(await orderNoExists(candidate))) {
      if (i > 0) console.log(`[order_no 자동 보정] ${i}회 충돌 → ${candidate}`);
      return candidate;
    }
    candidate = bumpOrderNoByMinute(candidate);
  }
  console.warn('[order_no 중복 체크] 60회 시도 후 충돌 — 그대로 사용:', candidate);
  return candidate;
}

// item_no 생성: user_code + '-' + YYMMDD + '-' + item_seq(4자리) + '-' + suffix
//  suffix 규칙:
//    - 단품 (set_total <= 1 또는 null): 'A0' + set_seq  (예: A01)
//    - 세트 (set_total >  1)          : 'S' + set_total + set_seq (예: S21, S22)
// 예: BO-260608-0028-A01
function generateItemNo(userCode, itemSeq, setTotal, setSeq) {
  const d = new Date();
  const yymmdd = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const seqStr = String(itemSeq).padStart(4, '0');
  const total = setTotal || 0;
  const seq = setSeq || 1;
  const suffix = total > 1 ? `S${total}${seq}` : `A0${seq}`;
  return `${userCode}-${yymmdd}-${seqStr}-${suffix}`;
}

// 오늘 날짜(YYYY-MM-DD)에 해당 user_id 의 ft_order_items.item_seq 중 max 값을 가져옴.
// 없으면 0 → 첫 item_seq 가 1 부터 시작.
async function getItemSeqBase(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseClient
    .from('ft_order_items')
    .select('item_seq')
    .eq('user_id', userId)
    .eq('requested_date', today)
    .order('item_seq', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('item_seq base 조회 실패 → 0 으로 fallback:', error);
    return 0;
  }
  if (!data || data.length === 0) return 0;
  return data[0].item_seq || 0;
}

// cart_seq → item_seq 매핑. 같은 cart_seq 는 같은 item_seq.
// cartItems 는 cart_seq 오름차순 정렬되어 있다고 가정.
function mapCartSeqToItemSeq(cartItems, base) {
  const map = new Map();
  let next = base;
  for (const it of cartItems) {
    if (!map.has(it.cart_seq)) {
      next += 1;
      map.set(it.cart_seq, next);
    }
  }
  return map;
}

// shipment 역매핑: ft_cart_items 의 shipment_type/coupang_shipment_size/personal_order_no
// → 시트 V열 원본 형태로 복원 (ft_order_items 와 동일 패턴 — cart 도 같은 컬럼 구조)
function vReverseFromShipment(it) {
  if (it.shipment_type === 'PERSONAL') return `P-${it.personal_order_no || ''}`;
  if (it.shipment_type === 'DIRECT')   return 'DIRECT';
  return it.coupang_shipment_size || ''; // COUPANG 또는 미설정
}

// ─── ft_cart_items 행 → orders[] 객체 변환 ─────────────────────
// 【V2 주문 탭 전용】 parseData 가 만드는 order 구조와 동일한 출력을 만든다.
// 입력 ctx: { userCode, orderNo, itemSeq, cartId }
function reconstructOrderFromCartItem(it, ctx) {
  const { userCode, orderNo, itemSeq, cartId } = ctx;

  // site_url 에서 offer_id 직접 추출
  const { cleanedUrl, offerId } = processUrl(it.site_url || '');

  // 오늘 MMDD (parseData 의 raw_date 형식과 동일)
  const now = new Date();
  const rawDateMMDD = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

  // item_no 생성 (행 단위 고유)
  const itemNo = generateItemNo(userCode, itemSeq, it.set_total, it.set_seq);

  return {
    orderNo: itemNo,                      // 화면 표시용 (= item_no)
    quantity: it.order_qty || 0,
    color: it.china_option1 || '',
    size: it.china_option2 || '',
    url: cleanedUrl,
    orderCode: orderNo,                   // 카트 전체 공유 (= order_no)
    status: 'pending',
    errorReason: '',
    dbData: {
      date: new Date().toISOString(),
      raw_date: rawDateMMDD,
      order_number: itemNo,               // → ft_order_items.item_no
      item_name: it.item_name || null,
      option_name: it.option_name || null,
      order_qty: it.order_qty || null,
      barcode: it.barcode || null,
      china_option1: it.china_option1 || null,
      china_option2: it.china_option2 || null,
      china_price: it.price_cny ?? null,
      china_total_price: it.price_total_cny ?? null,
      img_url: it.img_url || null,
      site_url: cleanedUrl,
      status_ordering: null,
      status_import: null,
      status_cancel: null,
      status_export: null,
      korea_note: it.note_kr || null,
      china_note: it.req_note || null,    // req_note → R열 매핑 (가정)
      order_code: orderNo,                // → ft_order_items.order_no / ft_orders.order_no
      shipment_code: null,
      option_id: it.vendor_option_id || null,
      coupang_shipment_size: vReverseFromShipment(it),
      composition: it.composition || null,
      recomanded_age: it.recommanded_age || null,
      set_total: it.set_total || null,
      set_seq: it.set_seq || null,
      '1688_offer_id': offerId,
      '1688_order_id': null,
      // ── V2 주문 탭 전용 내부 마커 (saveToSupabaseV2 가 참고) ──
      _computed_item_seq: itemSeq,        // → ft_order_items.item_seq (누적값)
      _cartId: cartId,                    // → V2 저장 성공 후 ft_carts.status='DONE'
    },
    originalData: []
  };
}

// ─── 드롭박스 채우기 ───────────────────────────────────────────
// 【V2 주문 탭 전용】 선택된 사용자의 ft_carts.status='ORDER' 행들을 드롭박스에 노출.
//  옵션 value = ft_carts.id, 라벨 = cart_name + 아이템 건수.
async function loadFtCartsDropdown() {
  const sel = document.getElementById('ftOrderSelectV2');
  if (!sel) return;

  const ftUserSelect = document.getElementById('ftUserSelect');
  const userId = ftUserSelect?.value || '';

  sel.innerHTML = '';

  if (!userId) {
    sel.innerHTML = '<option value="">사용자를 먼저 선택하세요</option>';
    return;
  }
  if (!supabaseClient) {
    sel.innerHTML = '<option value="">Supabase 초기화 안됨</option>';
    return;
  }

  // 1) ft_carts 조회 (user_id + status='ORDER')
  const { data, error } = await supabaseClient
    .from('ft_carts')
    .select('id, cart_name, created_at')
    .eq('user_id', userId)
    .eq('status', 'ORDER')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('ft_carts 조회 실패:', error);
    sel.innerHTML = '<option value="">조회 실패</option>';
    return;
  }
  if (!data || data.length === 0) {
    sel.innerHTML = '<option value="">ORDER 상태 카트 없음</option>';
    return;
  }

  // 2) cart_id 별 ft_cart_items 행 수 집계 (한 번에 조회)
  const cartIds = data.map(r => r.id);
  const countMap = new Map();
  try {
    const { data: items, error: itemsErr } = await supabaseClient
      .from('ft_cart_items')
      .select('cart_id')
      .in('cart_id', cartIds);
    if (itemsErr) throw itemsErr;
    (items || []).forEach(it => {
      countMap.set(it.cart_id, (countMap.get(it.cart_id) || 0) + 1);
    });
  } catch (e) {
    console.warn('ft_cart_items 건수 조회 실패:', e);
  }

  sel.innerHTML = '<option value="">선택...</option>';
  data.forEach(row => {
    const itemCount = countMap.get(row.id) ?? 0;
    const opt = document.createElement('option');
    opt.value = row.id;
    opt.dataset.cartName = row.cart_name || '';
    opt.textContent = `${row.cart_name || '(이름 없음)'} (${itemCount}건)`;
    sel.appendChild(opt);
  });

  // 선택 시: [추가]/[삭제] 버튼 활성화 토글. 잠금 상태면 disabled 유지.
  sel.onchange = () => { applyCartAreaLock(); };

  // 새로고침 직후 잠금 상태 즉시 반영 (사용자 변경/탭 진입 직후 안전망)
  applyCartAreaLock();
}

// ─── [추가] 버튼 클릭 시 카트 적재 ─────────────────────────────
// 【V2 주문 탭 전용】 헤더의 [추가] 버튼 onclick 핸들러.
//  ft_cart_items 조회 → order_no/item_seq/item_no 생성 → orders[] push → 화면 렌더.
//  여러 카트를 연속 추가해도 order_no 는 세션 공유 (v2SessionOrderNo).
//  item_seq base 는 DB max + orders[] 내 max 중 큰 값 → 중복 방지.
async function handleCartSelect() {
  const sel = document.getElementById('ftOrderSelectV2');
  const cartId = sel?.value;
  if (!cartId) return;
  if (!supabaseClient) {
    alert('Supabase 초기화 안됨');
    return;
  }

  // ─ user_id / user_code 확보 ─
  const ftUserSelect = document.getElementById('ftUserSelect');
  const userId = ftUserSelect?.value || '';
  const userCode = ftUserSelect?.selectedOptions[0]?.dataset.userCode || '';
  if (!userId) {
    alert('사용자를 먼저 선택하세요.');
    return;
  }
  if (!userCode) {
    alert('선택된 사용자의 user_code 가 비어있습니다.');
    return;
  }

  // 1) ft_cart_items 조회 (cart_seq 오름차순)
  const { data: items, error } = await supabaseClient
    .from('ft_cart_items')
    .select('*')
    .eq('cart_id', cartId)
    // 정렬: cart_seq → set_seq 오름차순
    //  - 같은 cart_seq 안에서 세트 행들이 set_seq 1, 2, 3… 순으로 자연 정렬
    //  - mapCartSeqToItemSeq 의 그룹핑 가정과도 일치 (cart_seq 가 묶음 키)
    .order('cart_seq', { ascending: true })
    .order('set_seq', { ascending: true });

  if (error) {
    console.error('ft_cart_items 조회 실패:', error);
    alert(`ft_cart_items 조회 실패: ${error.message}`);
    return;
  }
  if (!items || items.length === 0) {
    alert('해당 카트에 아이템이 없습니다.');
    return;
  }

  // 2) order_no — 세션 캐시 사용 (여러 카트 [추가] 시에도 같은 값 공유)
  //    첫 호출 시 ft_orders 중복 1회 체크 → 충돌 시 분(分) +1 로 빈 자리 확보.
  //    두 번째 [추가] 부터는 캐시 사용, 재조회 없음.
  if (!v2SessionOrderNo) {
    v2SessionOrderNo = await generateUniqueOrderNo(userCode);
  }
  const orderNo = v2SessionOrderNo;

  // 3) item_seq base — DB max 와 orders[] 내 _computed_item_seq max 중 큰 값
  //    이미 화면에 적재된 행과 중복되지 않도록 누적 보장.
  const dbBase = await getItemSeqBase(userId);
  const ordersMax = orders.reduce(
    (m, o) => Math.max(m, o.dbData?._computed_item_seq ?? 0), 0
  );
  const base = Math.max(dbBase, ordersMax);
  const seqMap = mapCartSeqToItemSeq(items, base);

  // 4) 각 행을 order 객체로 변환 → orders[] 누적
  const newOrders = items.map(it => reconstructOrderFromCartItem(it, {
    userCode,
    orderNo,
    itemSeq: seqMap.get(it.cart_seq),
    cartId,
  }));
  orders.push(...newOrders);

  // 5) 후처리 (parseData / 기존 addFromCartV2 와 동일 흐름)
  isDataSaved = false;
  renderDataPreview();
  renderOrderList();
  const btnSkip = document.getElementById('btnSkip');
  const btnStart = document.getElementById('btnStart');
  const btnReview = document.getElementById('btnReview');
  if (btnSkip) btnSkip.disabled = false;
  if (btnStart) btnStart.disabled = false;
  if (btnReview) btnReview.disabled = false;
  stepStatus.parse = true;
  updateButtonSteps();

  // 6) 사용 완료된 옵션 드롭박스에서 제거 + 선택 초기화 + 두 버튼 비활성화
  const usedOpt = sel.querySelector(`option[value="${cartId}"]`);
  if (usedOpt) usedOpt.remove();
  sel.value = '';
  const btnAdd = document.getElementById('btnCartAdd');
  const btnDel = document.getElementById('btnCartDelete');
  if (btnAdd) btnAdd.disabled = true;
  if (btnDel) btnDel.disabled = true;

  alert(`${newOrders.length}건 추가됨 (총 ${orders.length}건)\norder_no: ${orderNo}\nitem_seq: ${base + 1} ~ ${base + seqMap.size}`);
}

// ─── 카트 삭제 (패스워드 모달) ─────────────────────────────────
// 【V2 주문 탭 전용】 선택된 ft_carts 행 + 연결된 ft_cart_items 모두 영구 삭제.
//  실수 방지를 위해 상단 게이트와 동일한 ORDER_PASSWORD 확인 필요.

function openCartDeleteModal() {
  const sel = document.getElementById('ftOrderSelectV2');
  if (!sel?.value) {
    alert('삭제할 카트를 먼저 선택하세요.');
    return;
  }
  const modal = document.getElementById('cartDeleteModal');
  const input = document.getElementById('cartDeletePwInput');
  if (input) input.value = '';
  if (modal) modal.style.display = 'flex';
  setTimeout(() => input?.focus(), 50);
}

function closeCartDeleteModal() {
  const modal = document.getElementById('cartDeleteModal');
  if (modal) modal.style.display = 'none';
}

async function confirmCartDelete() {
  const input = document.getElementById('cartDeletePwInput');
  const pw = input?.value || '';
  if (ORDER_PASSWORD === '' || pw !== ORDER_PASSWORD) {
    alert('패스워드가 일치하지 않습니다.');
    if (input) { input.value = ''; input.focus(); }
    return;
  }
  const sel = document.getElementById('ftOrderSelectV2');
  const cartId = sel?.value;
  if (!cartId) { closeCartDeleteModal(); return; }
  if (!supabaseClient) { alert('Supabase 초기화 안됨'); return; }

  // ft_cart_items 먼저 삭제 (FK 안전) → ft_carts 행 삭제
  const { error: itemsErr } = await supabaseClient
    .from('ft_cart_items').delete().eq('cart_id', cartId);
  if (itemsErr) {
    alert(`ft_cart_items 삭제 실패: ${itemsErr.message}`);
    return;
  }
  const { error: cartsErr } = await supabaseClient
    .from('ft_carts').delete().eq('id', cartId);
  if (cartsErr) {
    alert(`ft_carts 삭제 실패: ${cartsErr.message}`);
    return;
  }

  closeCartDeleteModal();
  await loadFtCartsDropdown(); // 드롭박스 새로고침 (삭제된 카트 사라짐)
  alert('카트가 삭제되었습니다.');
}

// Supabase 컬럼 매핑 (인덱스 -> 컬럼명)
const supabaseColumnMap = {
  0: '-',                    // A열: 사용안함
  1: 'order_number',         // B열
  2: 'item_name',            // C열
  3: 'option_name',          // D열
  4: 'order_qty',            // E열
  5: 'barcode',              // F열
  6: 'china_option1',        // G열
  7: 'china_option2',        // H열
  8: 'china_price',          // I열
  9: 'china_total_price',    // J열
  10: 'img_url',             // K열
  11: 'site_url',            // L열
  12: 'status_ordering',     // M열
  13: 'status_import',       // N열
  14: 'status_cancel',       // O열
  15: 'status_export',       // P열
  16: 'korea_note',          // Q열
  17: 'china_note',          // R열
  18: 'order_code',          // S열
  19: 'shipment_code',       // T열
  20: 'option_id',           // U열
  21: 'coupang_shipment_size', // V열
  22: 'composition',         // W열
  23: 'recomanded_age',      // X열
  24: 'set_total',           // Y열
  25: 'set_seq'              // Z열
};

// 컬럼명 -> 인덱스 역매핑
const supabaseColumnIndex = Object.entries(supabaseColumnMap).reduce((acc, [idx, col]) => {
  if (col !== '-') acc[col] = parseInt(idx);
  return acc;
}, {});

// ============================================================
// [데이터 미리보기 복사] 수정된 현재 값으로 TSV 생성 → 클립보드
// ============================================================
function copyPreviewData() {
  if (orders.length === 0) { alert('복사할 데이터가 없습니다.'); return; }

  let maxCols = 26;
  orders.forEach(order => {
    if (order.originalData && order.originalData.length > maxCols)
      maxCols = order.originalData.length;
  });

  const rows = orders.map(order => {
    const original = order.originalData || [];
    const dbData   = order.dbData || {};
    const cols = [];
    for (let i = 0; i < maxCols; i++) {
      const colName     = supabaseColumnMap[i];
      const originalVal = original[i] !== undefined ? String(original[i]).trim() : '';
      let val = '';
      if (colName && colName !== '-' && dbData[colName] !== undefined && dbData[colName] !== null) {
        val = String(dbData[colName]);
      } else {
        val = originalVal;
      }
      cols.push(val);
    }
    return cols.join('\t');
  });

  copyToClipboard(rows.join('\n'));
}

// 데이터 미리보기 렌더링 (Supabase에 저장될 데이터 기준)
function renderDataPreview() {
  const previewDiv = document.getElementById('dataPreview');
  const previewTable = document.getElementById('previewTable');
  const rowCountSpan = document.getElementById('previewRowCount');

  if (orders.length === 0) {
    previewDiv.style.display = 'none';
    return;
  }

  previewDiv.style.display = 'block';
  rowCountSpan.textContent = orders.length;

  // 최대 열 수 찾기 (원본 데이터 기준)
  let maxCols = 26; // A~Z
  orders.forEach(order => {
    if (order.originalData && order.originalData.length > maxCols) {
      maxCols = order.originalData.length;
    }
  });

  // 열 헤더 (A, B, C, ...)
  const colHeaders = [''].concat(Array.from({ length: maxCols }, (_, i) => {
    let col = '';
    let n = i;
    do {
      col = String.fromCharCode(65 + (n % 26)) + col;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return col;
  }));

  // 테이블 HTML 생성 (2줄 헤더: 열 이름 + Supabase 컬럼명)
  let html = '<thead>';
  // 첫 번째 줄: A, B, C...
  html += '<tr>';
  colHeaders.forEach(h => {
    html += `<th>${h}</th>`;
  });
  html += '</tr>';
  // 두 번째 줄: Supabase 컬럼명
  html += '<tr>';
  html += '<th></th>'; // 행 번호 열
  for (let i = 0; i < maxCols; i++) {
    const colName = supabaseColumnMap[i] || '-';
    html += `<th style="font-size: 9px; font-weight: normal; color: #666;">${colName}</th>`;
  }
  html += '</tr>';
  html += '</thead><tbody>';

  // 무효 행이 있으면 무효 행만, 없으면 전체 표시
  const hasInvalid = orders.some(o => o.isInvalid);
  const previewOrders = hasInvalid ? orders.filter(o => o.isInvalid) : orders;

  // 각 주문 데이터 렌더링
  previewOrders.forEach((order, rowIdx) => {
    const original = order.originalData || [];
    const dbData = order.dbData || {};

    // 실패 여부 판단 (exportFailedOrders와 동일한 로직)
    let isFailed = false;
    if (order.finalComplete !== undefined) {
      isFailed = order.finalComplete === false;
    } else {
      const hasResult = order.status && order.status !== 'pending';
      const hasReview = order.reviewStatus && order.reviewStatus !== '';
      const resultTrue = order.status === 'success';
      const reviewTrue = order.reviewStatus === 'ok';

      if (hasResult && hasReview) {
        isFailed = !(resultTrue && reviewTrue);
      } else if (hasResult && !hasReview) {
        isFailed = !resultTrue;
      } else if (!hasResult && hasReview) {
        isFailed = !reviewTrue;
      }
    }

    const rowBgStyle = (order.isInvalid || isFailed) ? 'background-color: #ffcccc;' : '';
    html += `<tr style="${rowBgStyle}"><td style="${rowBgStyle}">${rowIdx + 1}</td>`;

    for (let i = 0; i < maxCols; i++) {
      const colName = supabaseColumnMap[i];
      const originalVal = original[i] !== undefined ? String(original[i]).trim() : '';

      // dbData에서 현재 값 가져오기
      let currentVal = '';
      if (colName && colName !== '-' && dbData[colName] !== undefined && dbData[colName] !== null) {
        currentVal = String(dbData[colName]);
      } else if (i === 0) {
        // A열은 사용 안 함
        currentVal = originalVal;
      }

      // 원본과 비교해서 수정됐는지 확인
      const isModified = colName && colName !== '-' && originalVal !== currentVal && currentVal !== '';
      // 수정된 셀은 노란색, 아니면 행 배경색 적용
      const cellBgStyle = isModified ? 'background-color: #fffacd;' : rowBgStyle;

      const displayVal = (colName && colName !== '-') ? currentVal : originalVal;
      html += `<td style="${cellBgStyle}" title="${displayVal.replace(/"/g, '&quot;')}">${displayVal}</td>`;
    }

    html += '</tr>';
  });

  html += '</tbody>';
  previewTable.innerHTML = html;
}

// 미리보기 전체화면 모달 열기
function openPreviewModal() {
  const modal = document.getElementById('previewModal');
  const modalTable = document.getElementById('previewModalTable');
  const modalRowCount = document.getElementById('previewModalRowCount');

  // 기존 미리보기 테이블 내용 복사
  const previewTable = document.getElementById('previewTable');
  modalTable.innerHTML = previewTable.innerHTML;
  modalRowCount.textContent = orders.length;

  modal.style.display = 'flex';
}

// 미리보기 모달 닫기
function closePreviewModal(event) {
  if (!event || event.target.id === 'previewModal') {
    document.getElementById('previewModal').style.display = 'none';
  }
}

// 주문 목록 렌더링 — 공유 영역(#orderListContent) 하나만 갱신
function renderOrderList() {
  const container = document.getElementById('orderListContent');
  const countSpan = document.getElementById('orderCount');

  if (orders.length === 0) {
    container.innerHTML = '<div class="empty-message">데이터를 입력하고 저장 버튼을 클릭하세요</div>';
    countSpan.textContent = '';
    return;
  }

  const successCount = orders.filter(o => o.status === 'success').length;
  const errorCount = orders.filter(o => o.status === 'error').length;
  countSpan.textContent = `(총 ${orders.length}건 | 성공: ${successCount} | 실패: ${errorCount})`;

  let html = `
    <table class="order-table">
      <thead>
        <tr>
          <th style="width: 30px; text-align: center;"><input type="checkbox" onclick="toggleAllCheckboxes(this)"></th>
          <th style="width: 45px; text-align: center;">#</th>
          <th style="width: 220px;">주문번호</th>
          <th style="width: 160px;">색상</th>
          <th style="width: 160px;">사이즈</th>
          <th style="width: 45px; text-align: center;">수량</th>
          <th style="width: 38px; text-align: center;">결과</th>
          <th style="width: 38px; text-align: center;">검수</th>
          <th style="width: 38px; text-align: center;">완료</th>
          <th style="width: 185px;">사유</th>
          <th style="width: 45px; text-align: center;">참조</th>
          <th style="width: 45px; text-align: center;">매칭</th>
        </tr>
      </thead>
      <tbody>
  `;

  orders.forEach((order, index) => {
    let statusHtml = '';
    switch (order.status) {
      case 'pending':
        statusHtml = '<span class="status-pending">대기</span>';
        break;
      case 'processing':
        statusHtml = '<span class="status-processing">⏳</span>';
        break;
      case 'success':
        statusHtml = '<span class="status-success">✅</span>';
        break;
      case 'error':
        statusHtml = `<span class="status-error">❌</span><span class="error-reason">${order.errorReason}</span>`;
        break;
    }

    // 검수 결과 HTML 생성
    let reviewHtml = '-';
    if (order.reviewStatus === 'ok') {
      reviewHtml = '<span class="status-success">✅</span>';
    } else if (order.reviewStatus === 'error') {
      const msg = order.reviewResult?.message || '오류';
      reviewHtml = `<span class="status-error">❌</span><div style="color: #d9534f; font-size: 0.85em;">${msg}</div>`;
    } else if (order.reviewStatus === 'mismatch' && order.reviewResult?.mismatches) {
      const isReversed = order.reviewResult.isReversed || false;
      const mismatchTexts = order.reviewResult.mismatches.map(m => {
        if (m.field === 'quantity') {
          return `수량 : ${m.cart}`;
        } else if (m.field === 'color') {
          // 리버스된 경우 'color' 필드는 실제로는 사이즈
          return isReversed ? `사이즈 : ${m.cart}` : `색상 : ${m.cart}`;
        } else if (m.field === 'size') {
          // 리버스된 경우 'size' 필드는 실제로는 색상
          return isReversed ? `색상 : ${m.cart}` : `사이즈 : ${m.cart}`;
        }
        return '';
      }).filter(t => t);
      reviewHtml = `<span class="status-error">❌</span><div style="color: #d9534f; font-size: 0.85em;">${mismatchTexts.join('<br>')}</div>`;
    }

    // 완료 상태 계산
    let completeHtml = '';

    // 사용자가 수동으로 설정한 경우
    if (order.finalComplete !== undefined) {
      if (order.finalComplete) {
        completeHtml = '<span class="status-success">✅</span>';
      } else {
        completeHtml = '<span class="status-error">❌</span>';
      }
    } else {
      // 자동 계산 로직
      const hasResult = order.status && order.status !== 'pending';
      const hasReview = order.reviewStatus && order.reviewStatus !== '';
      const resultTrue = order.status === 'success';
      const reviewTrue = order.reviewStatus === 'ok';

      if (hasResult && hasReview) {
        // 1. 둘 다 데이터 존재
        if (resultTrue && reviewTrue) {
          completeHtml = '<span class="status-success">✅</span>';
        } else {
          completeHtml = '<span class="status-error">❌</span>';
        }
      } else if (hasResult && !hasReview) {
        // 2. 결과만 존재
        if (resultTrue) {
          completeHtml = '-';  // 비워두기
        } else {
          completeHtml = '<span class="status-error">❌</span>';
        }
      } else if (!hasResult && hasReview) {
        // 3. 검수만 존재
        if (reviewTrue) {
          completeHtml = '<span class="status-success">✅</span>';
        } else {
          completeHtml = '<span class="status-error">❌</span>';
        }
      } else {
        // 4. 둘 다 비어있음
        completeHtml = '-';
      }
    }

    // 사유 필드
    const reasonText = order.reason || order.otherNote || '-';

    // 참조코드 텍스트 생성 (새 형식: 주문코드 | 주문번호날짜부분 | 주문번호뒷부분:수량)
    const orderNo = order.orderNo || '';
    const orderNoParts = orderNo.split('-');
    const orderNoDatePart = orderNoParts.slice(0, 2).join('-');
    const orderNoRestPart = orderNoParts.slice(2).join('-');
    const refCodeText = `${order.orderCode || ''} | ${orderNoDatePart} | ${orderNoRestPart}:${order.quantity}`;

    // 참조 셀 HTML
    let refHtml = '-';
    if (order.refCodeSuccess === true) {
      refHtml = '<span class="status-success">✅</span>';
    } else if (order.refCodeSuccess === false) {
      refHtml = '<span class="status-error">❌</span>';
    }

    // 주문번호 셀 내용 구성
    const offerId    = (order.dbData?.['1688_offer_id']) || '';
    const barcode    = (order.dbData?.barcode) || '';
    const sellerName = order.reviewResult?.cartItem?.sellerName || '';
    const productName = order.reviewResult?.cartItem?.productName || '';
    const itemName   = order.dbData?.item_name || '';
    const optionName = order.dbData?.option_name || '';
    const imgUrl     = order.dbData?.img_url || '';

    const escapedUrl     = order.url.replace(/'/g, "\\'");
    const escapedSeller  = sellerName.replace(/'/g, "\\'");
    const escapedProduct = productName.replace(/'/g, "\\'");
    const escapedImg     = imgUrl.replace(/'/g, "\\'");

    const itemLabel = itemName + (optionName ? ', ' + optionName : '');

    // SET 상품 판별: 주문번호 4번째 파트(index 3)가 'S'로 시작
    const orderNoSplit = (order.orderNo || '').split('-');
    const isSet = orderNoSplit.length >= 4 && orderNoSplit[3].toUpperCase().startsWith('S');

    let orderNoCellContent = `
      ${(itemLabel || isSet) ? `
      <div class="cell-item-label" title="${itemLabel.replace(/"/g, '&quot;')}">
        ${isSet ? '<span class="set-badge">SET</span> ' : ''}${itemLabel}
      </div>` : ''}
      <div style="display:flex; align-items:center; gap:4px;">
        <span class="cell-clickable"
              onclick="copyToClipboard('${escapedUrl}')"
              title="클릭하여 URL 복사">
          ${order.orderNo}
        </span>
        ${imgUrl ? `
        <button class="cell-img-btn"
                onclick="event.stopPropagation(); openImgModal('${escapedImg}');"
                title="이미지 보기">🖼️</button>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:4px; margin-top:3px; flex-wrap:wrap;">
        <span class="cell-clickable"
              onclick="searchByValue('${offerId}')"
              title="offer_id로 검색"
              style="color:#222;">
          ${offerId || '-'}
        </span>
        <span style="color:#ccc; user-select:none;">|</span>
        <span class="cell-clickable"
              onclick="searchByValue('${barcode}')"
              title="바코드로 검색"
              style="color:#222;">
          ${barcode || '-'}
        </span>
      </div>
      ${(sellerName || productName) ? `
      <div style="display:flex; align-items:center; gap:4px; margin-top:3px; flex-wrap:wrap; color:#555;">
        ${sellerName ? `
        <span class="cell-clickable cell-seller"
              onclick="event.stopPropagation(); copyToClipboard('${escapedSeller}');"
              title="클릭하여 판매자명 복사">
          ${sellerName}
        </span>` : ''}
        ${(sellerName && productName) ? `<span style="color:#ccc; user-select:none;">|</span>` : ''}
        ${productName ? `
        <span class="cell-clickable"
              onclick="event.stopPropagation(); copyToClipboard('${escapedProduct}');"
              title="클릭하여 상품명 복사">
          ${productName}
        </span>` : ''}
      </div>` : ''}
    `;

    // 실패 여부 판단 (exportFailedOrders와 동일한 로직)
    let isFailed = false;
    if (order.finalComplete !== undefined) {
      isFailed = order.finalComplete === false;
    } else {
      const hasResult = order.status && order.status !== 'pending';
      const hasReview = order.reviewStatus && order.reviewStatus !== '';
      const resultTrue = order.status === 'success';
      const reviewTrue = order.reviewStatus === 'ok';

      if (hasResult && hasReview) {
        isFailed = !(resultTrue && reviewTrue);
      } else if (hasResult && !hasReview) {
        isFailed = !resultTrue;
      } else if (!hasResult && hasReview) {
        isFailed = !reviewTrue;
      }
    }

    // 무효 행은 테이블에 표시하지 않음 (데이터 미리보기에서만 표시)
    if (order.isInvalid) return;

    // 취소 사유가 있는 행은 회색 배경 (기타 내용만 있는 경우 제외)
    const hasCancelReason = order.reason && order.reasonType !== 'other';

    // 우선순위: 취소사유 회색 > 실패 주황색 > 기본
    const trAttrs = hasCancelReason
      ? ' class="row-gray" style="background-color: #d9d9d9;"'
      : isFailed
        ? ' class="row-orange" style="background-color: #ffcc99;"'
        : '';

    html += `
      <tr data-index="${index}"${trAttrs}>
        <td class="checkbox-cell" style="text-align: center;" onclick="toggleRowCheckbox(${index}, event)"><input type="checkbox" class="row-checkbox" data-index="${index}" ${order.checked ? 'checked' : ''}></td>
        <td style="text-align: center;">${index + 1}</td>
        <td class="order-no-cell">${orderNoCellContent}</td>
        <td class="editable-cell" onclick="makeEditable(this, ${index}, 'color')">${order.color}</td>
        <td class="editable-cell" onclick="makeEditable(this, ${index}, 'size')">${order.size}</td>
        <td class="editable-cell" style="text-align: center;" onclick="makeEditable(this, ${index}, 'quantity')">${order.quantity}</td>
        <td class="result-cell" style="text-align: center; cursor: pointer;" onclick="toggleResultStatus(${index})">${statusHtml}</td>
        <td class="review-cell" style="text-align: center;" onclick="applyCartData(${index})">${reviewHtml}</td>
        <td class="complete-cell" style="text-align: center;" onclick="toggleComplete(${index})">${completeHtml}</td>
        <td class="reason-cell" onclick="openReasonModal(${index})">${reasonText}</td>
        <td class="ref-cell" style="text-align: center; cursor: pointer;" onclick="showRefContextMenu(event, ${index}, '${refCodeText.replace(/'/g, "\\'")}')" title="클릭하여 메뉴 열기">${refHtml}</td>
        <td class="match-cell" style="text-align: center;" onclick="openOrderNumberInput(event, ${index})">${order.matched ? '<span class="status-success">✅</span>' : (order.matched === false ? '<span class="status-error">❌</span>' : '<span style="color:#aaa;">-</span>')}</td>
      </tr>
    `;
  });

  html += '</tbody></table>';

  // 매칭되지 않은 엑셀 데이터 표시
  if (unmatchedExcelData && unmatchedExcelData.length > 0) {
    html += `
      <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 15px; margin-top: 15px;">
        <h4 style="margin: 0 0 10px 0; color: #856404;">⚠️ 매칭되지 않은 엑셀 데이터 (${unmatchedExcelData.length}건)</h4>
        <div style="max-height: 200px; overflow-y: auto;">
          <table style="width: 100%; font-size: 12px;">
            <thead>
              <tr style="background: #ffc107;">
                <th style="padding: 5px; text-align: left;">1688 주문번호</th>
                <th style="padding: 5px; text-align: left;">Offer ID</th>
              </tr>
            </thead>
            <tbody>
              ${unmatchedExcelData.map(item => `
                <tr>
                  <td style="padding: 5px;">${item.orderNumber}</td>
                  <td style="padding: 5px;">${item.offerId}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  // 데이터 미리보기 갱신
  renderDataPreview();

  // 정렬 상태 재적용 (옵션기준 정렬 중이었으면 유지)
  if (currentSortMode !== 'default') {
    sortOrderTable(currentSortMode);
  }

  // 검색 필터 재적용 (두 검색창 상태 유지)
  applyTableFilter();
}

// ============================================================
// [주황색 행 네비게이션] 확인 필요 항목(실패 행) 간 키보드 없이 이동
// ============================================================
let orangeNavCurrentIndex = -1; // 현재 포커스된 주황 행 인덱스

/** renderOrderList / applyTableFilter 완료 후 호출 — 패널 표시·숨김 및 카운트 초기화 */
function updateOrangeNav() {
  const panel = document.getElementById('orangeNavPanel');
  if (!panel) return;
  // 검색 필터로 숨겨진 행은 제외
  const orangeRows = document.querySelectorAll('tr.row-orange:not(.search-hidden)');
  if (orangeRows.length === 0) {
    panel.style.display  = 'none';
    orangeNavCurrentIndex = -1;
    return;
  }
  panel.style.display = 'flex';
  // 렌더링 후 인덱스 리셋 (현재 위치 무효화)
  orangeNavCurrentIndex = -1;
  document.getElementById('orangeNavCount').textContent = `0 / ${orangeRows.length}`;
}

/** ▲(-1) / ▼(+1) 클릭 → 이전/다음 가시 주황 행으로 부드럽게 스크롤 */
function navigateOrangeRows(direction) {
  const orangeRows = Array.from(
    document.querySelectorAll('tr.row-orange:not(.search-hidden)')
  );
  if (orangeRows.length === 0) return;

  orangeNavCurrentIndex =
    (orangeNavCurrentIndex + direction + orangeRows.length) % orangeRows.length;

  orangeRows[orangeNavCurrentIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('orangeNavCount').textContent =
    `${orangeNavCurrentIndex + 1} / ${orangeRows.length}`;
}

// 주문 진행
async function startOrders() {
  if (orders.length === 0) {
    alert('주문 목록이 없습니다.');
    return;
  }
  // 【V2 주문 탭】 진행 시작 시점부터 카트 추가 영역 잠금 → [재시작] 까지 유지
  lockCartArea();

  // 체크된 항목이 있는지 확인
  const checkedOrders = orders.filter(o => o.checked);

  // 원본 인덱스를 포함하여 전송
  const ordersToProcess = checkedOrders.length > 0
    ? checkedOrders.map(o => ({ ...o, originalIndex: orders.indexOf(o) }))
    : orders.map((o, i) => ({ ...o, originalIndex: i }));

  isProcessing = true;

  // 버튼 상태 변경
  // - 주문 진행은 숨김 (중복 클릭 방지)
  // - 중단 버튼은 disabled 해제 → 빨강 활성 (지금 진행 중, 클릭 가능 의미)
  document.getElementById('btnStart').style.display = 'none';
  document.getElementById('btnStop').disabled = false;
  document.getElementById('progressBar').style.display = 'block';

  try {
    // 주문 처리 시작
    await window.api.processOrders(ordersToProcess);
  } catch (error) {
    if (error.message === 'STOPPED_BY_USER') {
      alert('주문 진행이 중단되었습니다.');
    } else {
      alert('오류가 발생했습니다: ' + error.message);
    }
  } finally {
    isProcessing = false;
    // 주문 진행 복원 + 중단 버튼은 다시 disabled (회색)
    document.getElementById('btnStart').style.display = 'inline-block';
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
  }
}

// 주문 중단
function stopOrders() {
  if (confirm('주문 진행을 중단하시겠습니까?\n현재까지 처리된 주문은 유지됩니다.')) {
    window.api.stopProcessing();
    isProcessing = false;
  }
}

// ========== 문의 탭: 정리 ==========
function parseInquiryData() {
  const inquiryDataInput = document.getElementById('inquiryDataInput');
  const raw = inquiryDataInput.value.trim();

  if (!raw) {
    alert('데이터를 붙여넣기 해주세요.');
    return;
  }

  const lines = raw.split('\n').filter(l => l.trim());
  inquiryOrders = [];

  lines.forEach((line, idx) => {
    const parts = line.split('\t');
    if (parts.length < 5) {
      console.warn(`행 ${idx + 1}: 컬럼 부족 (${parts.length}개) — 무시`);
      return;
    }

    const date = (parts[0] || '').trim();
    const productInfo = (parts[1] || '').trim();
    const chinaOption = (parts[2] || '').trim();
    const quantity = parseInt(parts[3]) || 0;
    const rawUrl = (parts[4] || '').trim();
    const inquiryText = (parts[5] || '').trim();
    const replyText = (parts[6] || '').trim();

    const { cleanedUrl, offerId } = processUrl(rawUrl);

    inquiryOrders.push({
      date,
      productInfo,
      chinaOption,
      quantity,
      url: cleanedUrl,
      offerId,
      inquiryText,
      replyText
    });
  });

  renderInquiryList();

  // 문의 버튼 활성화
  const btnAsk = document.getElementById('btnInquiryAsk');
  if (btnAsk) btnAsk.disabled = inquiryOrders.length === 0;

  alert(`${inquiryOrders.length}건 정리 완료`);
}

// ========== 문의 탭: 테이블 렌더링 ==========
function renderInquiryList() {
  const container = document.getElementById('inquiryListContent');
  const countEl = document.getElementById('inquiryCount');

  if (countEl) countEl.textContent = `(${inquiryOrders.length})`;

  if (inquiryOrders.length === 0) {
    container.innerHTML = '<div class="empty-message">데이터를 입력하고 정리 버튼을 클릭하세요</div>';
    return;
  }

  const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let html = '<table class="inquiry-table"><thead><tr>'
    + '<th>date</th><th>상품정보</th><th>중국어 옵션명</th><th>수량</th>'
    + '<th>링크</th><th>문의내용</th><th>답변내용</th>'
    + '</tr></thead><tbody>';

  inquiryOrders.forEach(item => {
    html += '<tr>'
      + `<td>${escapeHtml(item.date)}</td>`
      + `<td>${escapeHtml(item.productInfo)}</td>`
      + `<td>${escapeHtml(item.chinaOption)}</td>`
      + `<td style="text-align:center;">${item.quantity}</td>`
      + `<td><a href="${escapeHtml(item.url)}" target="_blank" style="color:#1a73e8;">${escapeHtml(item.offerId || item.url)}</a></td>`
      + `<td>${escapeHtml(item.inquiryText)}</td>`
      + `<td>${escapeHtml(item.replyText)}</td>`
      + '</tr>';
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ========== 문의 탭: 판매자에게 문의 (첫 offer_id만) ==========
async function startInquiry() {
  if (inquiryOrders.length === 0) {
    alert('문의할 데이터가 없습니다. 먼저 정리하세요.');
    return;
  }

  // offer_id로 그룹화
  const groupMap = new Map();
  inquiryOrders.forEach(item => {
    if (!item.offerId) return;
    if (!groupMap.has(item.offerId)) {
      groupMap.set(item.offerId, { offerId: item.offerId, url: item.url, items: [] });
    }
    groupMap.get(item.offerId).items.push({
      chinaOption: item.chinaOption,
      quantity: item.quantity
    });
  });

  const groups = Array.from(groupMap.values());
  if (groups.length === 0) {
    alert('유효한 offer_id가 없습니다.');
    return;
  }

  console.log(`[문의] ${groups.length}개 그룹 순차 처리 시작`);

  const btn = document.getElementById('btnInquiryAsk');
  if (btn) { btn.disabled = true; }

  let successCount = 0;
  const failedGroups = [];

  try {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (btn) btn.textContent = `문의 중... (${i + 1}/${groups.length})`;
      console.log(`[문의] [${i + 1}/${groups.length}] offer_id=${group.offerId}`);

      try {
        const result = await window.api.askInquiry(group);
        if (result.success) {
          successCount++;
          console.log(`[문의] [${i + 1}/${groups.length}] 성공`);
        } else {
          failedGroups.push({ offerId: group.offerId, error: result.error });
          console.warn(`[문의] [${i + 1}/${groups.length}] 실패: ${result.error}`);
        }
      } catch (e) {
        failedGroups.push({ offerId: group.offerId, error: e.message });
        console.error(`[문의] [${i + 1}/${groups.length}] 예외:`, e);
      }
    }

    let msg = `문의 완료: ${successCount}/${groups.length}건 성공`;
    if (failedGroups.length > 0) {
      msg += '\n\n실패 목록:\n' + failedGroups.map(f => `· ${f.offerId}: ${f.error}`).join('\n');
    }
    alert(msg);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '문의'; }
  }
}

// V2 참조코드 중지
function stopRefCodesV2() {
  if (confirm('V2 참조코드 입력을 중지하시겠습니까?\n현재까지 처리된 주문은 유지됩니다.')) {
    window.api.stopProcessing();
  }
}


// 주문 생략 - 주문 진행 없이 바로 검수 가능하도록
function skipOrders() {
  if (orders.length === 0) {
    alert('주문 목록이 없습니다.');
    return;
  }
  // 【V2 주문 탭】 주문 생략도 한 묶음 확정으로 보고 카트 추가 영역 잠금
  lockCartArea();

  // 체크된 항목이 있으면 체크된 것만, 없으면 전체
  const checkedOrders = orders.filter(o => o.checked);
  const targetOrders = checkedOrders.length > 0 ? checkedOrders : orders;

  // 선택된 주문들의 상태를 'success'로 변경
  targetOrders.forEach(order => {
    order.status = 'success';
  });

  // 화면 갱신
  renderOrderList();

  // 버튼 상태 업데이트
  stepStatus.order = true;
  updateButtonSteps();

  // 안내 메시지
  const skippedCount = targetOrders.length;
  alert(`${skippedCount}건의 주문이 생략 처리되었습니다.\n[검수] 버튼을 클릭하여 검수를 진행하세요.`);
}

// 진행 상황 업데이트
window.api.onProgress((progress) => {
  const { index, status, errorReason } = progress;

  if (index < orders.length) {
    orders[index].status = status;
    if (errorReason) {
      orders[index].errorReason = errorReason;
      if (errorReason === 'Invalid URL' || errorReason === 'Product offline') {
        orders[index].reason = '링크 없음';
      }
    }
  }

  // 진행률 업데이트
  const completed = orders.filter(o => o.status === 'success' || o.status === 'error').length;
  const percent = (completed / orders.length) * 100;
  document.getElementById('progressFill').style.width = percent + '%';

  renderOrderList();

  // 완료 시
  if (completed === orders.length) {
    document.getElementById('progressBar').style.display = 'none';
    // 버튼 상태 업데이트
    stepStatus.order = true;
    updateButtonSteps();
  }
});

// 주문번호 등록용 데이터 저장
let orderNumberData = [];

// 주문번호 등록 - 엑셀 파일 업로드
function registerOrderNumbers() {
  document.getElementById('orderNumberFile').click();
}

// 엑셀 파일 처리
function handleOrderNumberFile(event) {
  console.log('=== 엑셀 파일 업로드 시작 ===');
  const file = event.target.files[0];
  if (!file) {
    console.log('파일이 선택되지 않음');
    return;
  }

  console.log('파일명:', file.name);
  console.log('파일 크기:', file.size, 'bytes');

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      console.log('파일 읽기 완료, 파싱 시작...');
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });

      console.log('시트 이름:', workbook.SheetNames);

      // 첫 번째 시트 읽기
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

      console.log('전체 행 수 (헤더 포함):', jsonData.length);
      console.log('첫 3행 샘플:', jsonData.slice(0, 3));

      // 헤더 제거 (1행)
      const rows = jsonData.slice(1);

      // offer_id(Y열=24), 1688_orderNumber(A열=0), 배송비(G열=6) 추출
      // A열/G열이 병합된 경우 이전 행의 값을 사용
      orderNumberData = [];
      let lastOrderNumber = ''; // 마지막으로 읽은 주문번호 저장
      let lastDeliveryFee = 0;  // 마지막으로 읽은 배송비 저장 (G열, 병합셀)

      rows.forEach((row, idx) => {
        const orderNumber = row[0]; // A열
        const deliveryFee = row[6]; // G열 (배송비 CNY, 병합셀)
        const offerId = row[24];    // Y열

        // A열에 값이 있으면 업데이트 (병합된 셀의 첫 행)
        if (orderNumber) {
          lastOrderNumber = String(orderNumber).trim();
        }
        // G열에 값이 있으면 업데이트 (병합된 셀의 첫 행)
        if (deliveryFee !== undefined && deliveryFee !== null && deliveryFee !== '') {
          lastDeliveryFee = parseFloat(deliveryFee) || 0;
        }

        if (idx < 3) {
          console.log(`행 ${idx + 2}: A열="${orderNumber}", G열="${deliveryFee}", Y열="${offerId}", 주문번호="${lastOrderNumber}", 배송비=${lastDeliveryFee}`);
        }

        // offer_id가 있으면 추가 (주문번호/배송비는 병합된 셀의 값 사용)
        if (offerId && lastOrderNumber) {
          orderNumberData.push({
            orderNumber: lastOrderNumber,
            deliveryFee: lastDeliveryFee,
            offerId: String(offerId).trim()
          });
        }
      });

      console.log(`✓ 총 ${orderNumberData.length}개의 주문번호 로드 완료`);
      console.log('샘플 데이터:', orderNumberData.slice(0, 3));

      if (orderNumberData.length > 0) {
        // 바로 매칭 진행
        saveOrderNumbers();
      } else {
        console.warn('⚠️ 유효한 데이터가 없습니다.');
        alert('유효한 데이터가 없습니다.');
      }
    } catch (error) {
      console.error('파일 읽기 오류:', error);
      alert('파일 읽기 오류: ' + error.message);
    }
  };

  reader.readAsArrayBuffer(file);
}

// 주문번호 저장 - offer_id로 매칭하여 주문번호 열에 추가
function saveOrderNumbers() {
  console.log('=== 주문번호 저장 시작 ===');

  if (orderNumberData.length === 0) {
    console.log('⚠️ 엑셀 데이터 없음');
    alert('먼저 엑셀 파일을 업로드해주세요.');
    return;
  }

  if (orders.length === 0) {
    console.log('⚠️ 주문 데이터 없음');
    alert('주문 데이터가 없습니다. 먼저 데이터를 정리해주세요.');
    return;
  }

  console.log(`주문 데이터: ${orders.length}개`);
  console.log(`엑셀 데이터: ${orderNumberData.length}개`);

  let matchCount = 0;
  const matchedExcelOfferIds = new Set(); // 매칭된 엑셀 데이터 추적

  // 각 주문의 offer_id를 추출하여 매칭
  orders.forEach((order, idx) => {
    const match = order.url.match(/offer\/(\d+)\.html/);
    const offerId = match ? match[1] : '';

    if (!offerId) {
      console.log(`주문 ${idx}: offer_id 추출 실패 (URL: ${order.url})`);
      order.matched = false;
      return;
    }

    // 해당 offer_id와 매칭되는 주문번호 찾기 (첫 번째만)
    const matchingData = orderNumberData.find(data => data.offerId === offerId);

    if (matchingData) {
      // 매칭 성공
      order.matched = true;
      const orderNumber = matchingData.orderNumber;

      console.log(`주문 ${idx}: ✓ 매칭 성공 (offer_id: ${offerId}) → 1688 주문번호: ${orderNumber}`);

      // 엑셀 데이터를 매칭됨으로 표시
      matchedExcelOfferIds.add(`${matchingData.offerId}_${matchingData.orderNumber}`);

      // 기존 주문번호 마지막 줄에 1688 주문번호 추가
      order.orderNo = order.orderNo + '\n' + orderNumber;
      matchCount++;

      // dbData에 1688 주문번호 저장
      if (order.dbData) {
        order.dbData['1688_order_id'] = orderNumber;
      }
    } else {
      // 매칭 실패
      order.matched = false;
      console.log(`주문 ${idx}: ✗ 매칭 실패 (offer_id: ${offerId})`);

      // 디버깅: 엑셀에 해당 offer_id가 있는지 확인
      const allOfferIds = orderNumberData.map(d => d.offerId);
      const uniqueOfferIds = [...new Set(allOfferIds)];
      console.log(`  엑셀에 있는 고유 offer_id 개수: ${uniqueOfferIds.length}`);
      console.log(`  엑셀에 "${offerId}" 존재 여부:`, allOfferIds.includes(offerId));

      // 비슷한 offer_id 찾기
      const similar = orderNumberData.filter(d =>
        d.offerId.includes(offerId.substring(0, 8)) || offerId.includes(d.offerId.substring(0, 8))
      );
      if (similar.length > 0) {
        console.log(`  비슷한 offer_id 발견:`, similar.map(s => s.offerId));
      }
    }
  });

  // 매칭되지 않은 엑셀 데이터 찾기
  unmatchedExcelData = orderNumberData.filter(data => {
    const key = `${data.offerId}_${data.orderNumber}`;
    return !matchedExcelOfferIds.has(key);
  });

  console.log(`\n=== 매칭 결과 요약 ===`);
  console.log(`✓ 매칭 성공: ${matchCount}개`);
  console.log(`✗ 매칭되지 않은 엑셀 데이터: ${unmatchedExcelData.length}개`);

  if (unmatchedExcelData.length > 0) {
    console.log('\n매칭되지 않은 엑셀 데이터 목록:');
    unmatchedExcelData.forEach((data, idx) => {
      console.log(`  ${idx + 1}. offer_id: ${data.offerId}, 주문번호: ${data.orderNumber}`);
    });
  }

  // ─── 배송비(price_delivery_cny) 비례 배분 ───────────────────────────────
  // 동일 주문번호 내 모든 아이템의 수량 합계를 구한 뒤
  // 각 아이템에 (item_qty / total_qty) * delivery_fee 를 배분
  console.log('\n=== 배송비 비례 배분 시작 ===');

  // 1) 주문번호별 매칭된 orders 인덱스 그룹화
  const orderNoGroupMap = new Map(); // orderNumber → [{orderIdx, quantity}]
  orders.forEach((order, idx) => {
    const orderNumber = order.dbData && order.dbData['1688_order_id'];
    if (!orderNumber) return;
    if (!orderNoGroupMap.has(orderNumber)) orderNoGroupMap.set(orderNumber, []);
    orderNoGroupMap.get(orderNumber).push({ orderIdx: idx, quantity: order.quantity || 0 });
  });

  // 2) 주문번호별 배송비 조회 (엑셀 데이터 기준, 첫 번째 매칭 행의 값 사용)
  const deliveryFeeByOrderNo = new Map();
  orderNumberData.forEach(data => {
    if (!deliveryFeeByOrderNo.has(data.orderNumber)) {
      deliveryFeeByOrderNo.set(data.orderNumber, data.deliveryFee || 0);
    }
  });

  // 3) 각 주문에 비례 배송비 저장
  orderNoGroupMap.forEach((items, orderNumber) => {
    const totalShipping = deliveryFeeByOrderNo.get(orderNumber) || 0;
    const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

    console.log(`  주문번호 ${orderNumber}: 배송비=${totalShipping}CNY, 총수량=${totalQty}, 아이템=${items.length}개`);

    items.forEach(({ orderIdx, quantity }) => {
      const fee = totalQty > 0
        ? Math.round((quantity / totalQty) * totalShipping * 100) / 100
        : 0;
      if (orders[orderIdx].dbData) {
        orders[orderIdx].dbData.price_delivery_cny = fee;
      }
      console.log(`    아이템 ${orderIdx}: qty=${quantity}, price_delivery_cny=${fee}`);
    });
  });

  console.log('=== 배송비 비례 배분 완료 ===\n');
  // ────────────────────────────────────────────────────────────────────────

  renderOrderList();

  // 버튼 상태 업데이트
  stepStatus.orderNumber = true;
  updateButtonSteps();

  let message = `${matchCount}개의 주문에 주문번호가 추가되었습니다.`;
  if (unmatchedExcelData.length > 0) {
    message += `\n\n⚠️ ${unmatchedExcelData.length}개의 엑셀 데이터가 매칭되지 않았습니다. 테이블 하단을 확인해주세요.`;
  }
  alert(message);
}


// 매칭 셀 클릭 - 커서 위치에 주문번호 인라인 입력 팝오버 열기
function openOrderNumberInput(event, index) {
  event.stopPropagation();
  closeOrderNumberPopover();

  const order = orders[index];
  // 현재 1688 주문번호 (orderNo의 첫 번째 줄 이후 부분)
  const currentValue = (order.dbData && order.dbData['1688_order_id']) || '';

  const popover = document.createElement('div');
  popover.id = 'orderNumberPopover';
  popover.className = 'order-number-popover';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.placeholder = '1688 주문번호 입력...';

  let saved = false;

  function save() {
    if (saved) return;
    saved = true;
    const value = input.value.trim();
    if (value) {
      // orderNo는 '원본주문번호\n1688주문번호' 형태 — 첫 줄(원본)만 유지 후 새 값 추가
      const baseOrderNo = order.orderNo.split('\n')[0];
      order.orderNo = baseOrderNo + '\n' + value;
      if (!order.dbData) order.dbData = {};
      order.dbData['1688_order_id'] = value;
      order.matched = true;
    }
    closeOrderNumberPopover();
    renderOrderList();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { saved = true; closeOrderNumberPopover(); }
  });

  input.addEventListener('blur', () => {
    setTimeout(save, 150);
  });

  popover.appendChild(input);
  document.body.appendChild(popover);

  // 클릭 위치 바로 위에 팝오버 배치
  const popoverH = 42;
  let top = event.clientY - popoverH - 6;
  let left = event.clientX - 10;
  if (top < 4) top = event.clientY + 6;
  if (left + 270 > window.innerWidth) left = window.innerWidth - 274;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';

  input.focus();
  input.select();
}

function closeOrderNumberPopover() {
  const existing = document.getElementById('orderNumberPopover');
  if (existing) existing.remove();
}

// 완료 상태 토글 함수
function toggleComplete(index) {
  if (index < orders.length) {
    // 토글: 완료 <-> 실패
    orders[index].finalComplete = !orders[index].finalComplete;
    renderOrderList();
  }
}

// ── 범위 체크박스 선택/해제 (우측 사이드바 최상단) ──
// 두 입력폼이 모두 채워졌을 때만 선택/해제 버튼 활성화
function updateRangeButtons() {
  const s = document.getElementById('rangeStart');
  const e = document.getElementById('rangeEnd');
  const btnSel = document.getElementById('btnRangeSelect');
  const btnDes = document.getElementById('btnRangeDeselect');
  if (!s || !e || !btnSel || !btnDes) return;
  const ok = s.value !== '' && e.value !== '' &&
             Number(s.value) >= 1 && Number(e.value) >= 1;
  btnSel.disabled = !ok;
  btnDes.disabled = !ok;
}

// 범위(# 기준, 1-based) 체크박스 일괄 ON/OFF
function applyRangeCheck(checked) {
  const s = Number(document.getElementById('rangeStart').value);
  const e = Number(document.getElementById('rangeEnd').value);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return;
  const lo = Math.min(s, e), hi = Math.max(s, e);
  for (let i = lo - 1; i <= hi - 1 && i < orders.length; i++) {
    if (i < 0) continue;
    orders[i].checked = checked;
  }
  renderOrderList();
}

// 결과 상태 토글 함수 (실패 -> 성공 -> 실패)
function toggleResultStatus(index) {
  if (index < orders.length) {
    const order = orders[index];

    // 현재 상태가 성공이면 원래 상태로 복원
    if (order.originalStatus !== undefined) {
      // 원래 상태로 복원
      order.status = order.originalStatus;
      order.errorReason = order.originalErrorReason || '';
      delete order.originalStatus;
      delete order.originalErrorReason;
    } else {
      // 현재 상태 저장 후 성공으로 변경
      order.originalStatus = order.status;
      order.originalErrorReason = order.errorReason;
      order.status = 'success';
      order.errorReason = '';
    }

    renderOrderList();
  }
}

// 검수 열 클릭 - 카트 데이터 적용/복원 토글
function applyCartData(index) {
  if (index >= orders.length) return;

  const order = orders[index];

  // 검수 결과가 없으면 무시
  if (!order.reviewResult || !order.reviewResult.cartItem) {
    return;
  }

  const mismatches = order.reviewResult.mismatches || [];
  const mismatchFields = mismatches.map(m => m.field);
  const cartItem = order.reviewResult.cartItem;
  const isReversed = order.reviewResult.isReversed || false; // 리버스 검수 여부

  console.log(`[applyCartData] index=${index}, isReversed=${isReversed}`);
  console.log(`  cartItem:`, cartItem);
  console.log(`  mismatchFields:`, mismatchFields);
  console.log(`  current order.color=${order.color}, order.size=${order.size}`);

  // 이미 카트 데이터가 적용된 상태면 원래 값으로 복원
  if (order.appliedCartData && order.originalMismatchData) {
    // 오류난 필드만 원본 데이터로 복원
    if (mismatchFields.includes('color') && order.originalMismatchData.color !== undefined) {
      order.color = order.originalMismatchData.color;
      // dbData도 복원
      if (order.dbData) {
        order.dbData.china_option1 = order.originalMismatchData.color;
      }
    }
    if (mismatchFields.includes('size') && order.originalMismatchData.size !== undefined) {
      order.size = order.originalMismatchData.size;
      // dbData도 복원
      if (order.dbData) {
        order.dbData.china_option2 = order.originalMismatchData.size;
      }
    }
    if (mismatchFields.includes('quantity') && order.originalMismatchData.quantity !== undefined) {
      order.quantity = order.originalMismatchData.quantity;
      // dbData도 복원
      if (order.dbData) {
        order.dbData.order_qty = order.originalMismatchData.quantity;
      }
    }

    // 플래그 해제
    order.appliedCartData = false;

    // 검수 상태를 다시 mismatch로 변경
    order.reviewStatus = 'mismatch';

    renderOrderList();
    return;
  }

  // 불일치 상태일 때만 동작
  if (order.reviewStatus !== 'mismatch') {
    return;
  }

  // 오류난 필드의 원본 데이터만 저장 (처음 적용할 때만)
  if (!order.originalMismatchData) {
    order.originalMismatchData = {};
    if (mismatchFields.includes('color')) {
      order.originalMismatchData.color = order.color;
    }
    if (mismatchFields.includes('size')) {
      order.originalMismatchData.size = order.size;
    }
    if (mismatchFields.includes('quantity')) {
      order.originalMismatchData.quantity = order.quantity;
    }
  }

  // 카트 데이터를 현재 주문 데이터에 적용 (mismatches에 있는 항목만)
  // 리버스 검수된 경우 색상과 사이즈를 반대로 매핑
  if (isReversed) {
    // 리버스된 경우: 색상과 사이즈 모두 교환해서 적용 (mismatch 여부 무관)
    // 왜냐하면 리버스 검수는 색상↔사이즈를 바꿔서 비교한 것이므로
    // 카트 데이터를 적용할 때도 반대로 적용해야 함

    // 색상 mismatch가 있거나, 사이즈 mismatch가 있으면 색상 필드 업데이트
    if ((mismatchFields.includes('color') || mismatchFields.includes('size')) && cartItem.size !== undefined) {
      console.log(`  [REVERSED] Applying cartItem.size (${cartItem.size}) to order.color`);
      order.color = cartItem.size;
      // dbData도 업데이트
      if (order.dbData) {
        order.dbData.china_option1 = cartItem.size;
      }
    }

    // 색상 mismatch가 있거나, 사이즈 mismatch가 있으면 사이즈 필드 업데이트
    if ((mismatchFields.includes('color') || mismatchFields.includes('size')) && cartItem.color !== undefined) {
      console.log(`  [REVERSED] Applying cartItem.color (${cartItem.color}) to order.size`);
      order.size = cartItem.color;
      // dbData도 업데이트
      if (order.dbData) {
        order.dbData.china_option2 = cartItem.color;
      }
    }
  } else {
    // 일반 검수인 경우: 그대로 매핑
    if (mismatchFields.includes('color') && cartItem.color !== undefined) {
      order.color = cartItem.color;
      // dbData도 업데이트
      if (order.dbData) {
        order.dbData.china_option1 = cartItem.color;
      }
    }
    if (mismatchFields.includes('size') && cartItem.size !== undefined) {
      order.size = cartItem.size;
      // dbData도 업데이트
      if (order.dbData) {
        order.dbData.china_option2 = cartItem.size;
      }
    }
  }
  if (mismatchFields.includes('quantity') && cartItem.quantity !== undefined) {
    order.quantity = cartItem.quantity;
    // dbData도 업데이트
    if (order.dbData) {
      order.dbData.order_qty = cartItem.quantity;
    }
  }

  // 카트 데이터 적용 플래그 설정
  order.appliedCartData = true;

  // 검수 상태를 완료로 변경
  order.reviewStatus = 'ok';
  order.reviewResult = { ...order.reviewResult, message: '수동 적용 완료' };

  console.log(`  After apply: order.color=${order.color}, order.size=${order.size}`);

  renderOrderList();
}

// 카트 데이터 일괄 적용 함수
function applyAllCartData() {
  // 불일치 상태인 주문들 필터링
  const mismatchOrders = orders.filter(order =>
    order.reviewStatus === 'mismatch' &&
    order.reviewResult &&
    order.reviewResult.cartItem
  );

  if (mismatchOrders.length === 0) {
    alert('적용할 불일치 데이터가 없습니다.');
    return;
  }

  const confirmMsg = `${mismatchOrders.length}건의 불일치 데이터에 카트 데이터를 일괄 적용하시겠습니까?`;
  if (!confirm(confirmMsg)) {
    return;
  }

  let appliedCount = 0;

  mismatchOrders.forEach(order => {
    const mismatches = order.reviewResult.mismatches || [];
    const mismatchFields = mismatches.map(m => m.field);
    const cartItem = order.reviewResult.cartItem;
    const isReversed = order.reviewResult.isReversed || false;

    // 원본 데이터 백업 (처음 적용할 때만)
    if (!order.originalMismatchData) {
      order.originalMismatchData = {};
      if (mismatchFields.includes('color')) {
        order.originalMismatchData.color = order.color;
      }
      if (mismatchFields.includes('size')) {
        order.originalMismatchData.size = order.size;
      }
      if (mismatchFields.includes('quantity')) {
        order.originalMismatchData.quantity = order.quantity;
      }
    }

    // 카트 데이터 적용
    if (isReversed) {
      // 리버스 검수: 색상과 사이즈 교환 적용
      if ((mismatchFields.includes('color') || mismatchFields.includes('size')) && cartItem.size !== undefined) {
        order.color = cartItem.size;
        if (order.dbData) order.dbData.china_option1 = cartItem.size;
      }
      if ((mismatchFields.includes('color') || mismatchFields.includes('size')) && cartItem.color !== undefined) {
        order.size = cartItem.color;
        if (order.dbData) order.dbData.china_option2 = cartItem.color;
      }
    } else {
      // 일반 검수
      if (mismatchFields.includes('color') && cartItem.color !== undefined) {
        order.color = cartItem.color;
        if (order.dbData) order.dbData.china_option1 = cartItem.color;
      }
      if (mismatchFields.includes('size') && cartItem.size !== undefined) {
        order.size = cartItem.size;
        if (order.dbData) order.dbData.china_option2 = cartItem.size;
      }
    }
    if (mismatchFields.includes('quantity') && cartItem.quantity !== undefined) {
      order.quantity = cartItem.quantity;
      if (order.dbData) order.dbData.order_qty = cartItem.quantity;
    }

    // 상태 업데이트
    order.appliedCartData = true;
    order.reviewStatus = 'ok';
    order.reviewResult = { ...order.reviewResult, message: '일괄 적용 완료' };

    appliedCount++;
  });

  renderOrderList();
  alert(`${appliedCount}건의 카트 데이터가 적용되었습니다.`);
}

// 체크된 행에 한해 검수열(ok) + 완료열(true) 일괄 전환
function markCheckedComplete() {
  const targets = orders.filter(o => o && o.checked === true);
  if (targets.length === 0) {
    alert('체크된 항목이 없습니다. 먼저 체크박스를 선택하세요.');
    return;
  }
  if (!confirm(`체크된 ${targets.length}건을 검수 OK + 완료 상태로 전환하시겠습니까?`)) {
    return;
  }
  targets.forEach(o => {
    o.reviewStatus = 'ok';
    o.finalComplete = true;
  });
  renderOrderList();
}

// 사유 모달 관련 변수
let currentReasonIndex = -1;

// 사유 모달 열기
function openReasonModal(index) {
  currentReasonIndex = index;
  const modal = document.getElementById('reasonModal');
  const order = orders[index];

  // 모든 버튼 선택 해제
  document.querySelectorAll('.modal-btn').forEach(btn => {
    btn.classList.remove('selected');
  });

  // 입력 필드 초기화
  const customInput = document.getElementById('customReasonInput');
  const otherNoteInput = document.getElementById('otherNoteInput');
  customInput.value = '';
  otherNoteInput.value = '';

  // 기존 사유/기타내용 복원
  if (order.reason && order.reasonType !== 'other') {
    const reasonBtn = document.querySelector(`.modal-btn[data-reason="${order.reason}"]`);
    if (reasonBtn) {
      // 프리셋 버튼 선택
      reasonBtn.classList.add('selected');
    } else {
      // 직접 입력 취소사유
      customInput.value = order.reason;
    }
  }
  if (order.otherNote) {
    otherNoteInput.value = order.otherNote;
  }

  modal.classList.add('active');
}

// 사유 모달 닫기
function closeReasonModal() {
  const modal = document.getElementById('reasonModal');
  modal.classList.remove('active');
  currentReasonIndex = -1;
}

// 취소 사유 선택 처리 (프리셋 또는 직접 입력)
function selectReason(reason, isCustom = false) {
  if (currentReasonIndex >= 0 && currentReasonIndex < orders.length) {
    orders[currentReasonIndex].reason = reason;
    orders[currentReasonIndex].reasonType = isCustom ? 'custom' : 'preset';
    orders[currentReasonIndex].otherNote = '';  // 취소사유 선택 시 기타 내용 클리어
    renderOrderList();
  }
  closeReasonModal();
}

// 기타 내용 입력 처리 (배경색 영향 없음)
function selectOtherNote(note) {
  if (currentReasonIndex >= 0 && currentReasonIndex < orders.length) {
    orders[currentReasonIndex].otherNote = note;
    orders[currentReasonIndex].reason = '';      // 기타 내용 입력 시 취소사유 클리어
    orders[currentReasonIndex].reasonType = 'other';
    renderOrderList();
  }
  closeReasonModal();
}

// 사유 지우기 (전체 클리어)
function clearReason() {
  if (currentReasonIndex >= 0 && currentReasonIndex < orders.length) {
    orders[currentReasonIndex].reason = '';
    orders[currentReasonIndex].reasonType = '';
    orders[currentReasonIndex].otherNote = '';
    renderOrderList();
  }
  closeReasonModal();
}

// ── 사유 모달 이벤트 초기화 ──
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('reasonModal');
  const customInput = document.getElementById('customReasonInput');
  const otherNoteInput = document.getElementById('otherNoteInput');

  // ── 모달 외부 클릭 시 닫기 (입력값 저장) ──
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      if (customInput.value.trim()) {
        // 취소 사유 입력값이 있으면 저장
        selectReason(customInput.value.trim(), true);
      } else if (otherNoteInput.value.trim()) {
        // 기타 내용 입력값이 있으면 저장
        selectOtherNote(otherNoteInput.value.trim());
      } else {
        closeReasonModal();
      }
    }
  });

  // ── 취소 사유 프리셋 버튼 클릭 ──
  document.querySelectorAll('.modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const reason = btn.dataset.reason;
      if (!reason) return;  // data-reason 없는 버튼은 무시 (지우기 등)

      // 모든 버튼 선택 해제 + 입력 필드 클리어
      document.querySelectorAll('.modal-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      customInput.value = '';
      otherNoteInput.value = '';

      // 프리셋 선택 - 바로 적용
      selectReason(reason, false);
    });
  });

  // ── 취소 사유 입력 폼 ──
  customInput.addEventListener('focus', () => {
    // 포커스 시 버튼 선택 해제 + 기타 내용 클리어 (상호 배타)
    document.querySelectorAll('.modal-btn').forEach(b => b.classList.remove('selected'));
    otherNoteInput.value = '';
  });

  customInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && customInput.value.trim()) {
      selectReason(customInput.value.trim(), true);
    }
  });

  // ── 기타 내용 입력 폼 ──
  otherNoteInput.addEventListener('focus', () => {
    // 포커스 시 버튼 선택 해제 + 취소 사유 클리어 (상호 배타)
    document.querySelectorAll('.modal-btn').forEach(b => b.classList.remove('selected'));
    customInput.value = '';
  });

  otherNoteInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && otherNoteInput.value.trim()) {
      selectOtherNote(otherNoteInput.value.trim());
    }
  });

  // ── 링크 수정 모달 이벤트 ──
  const linkModal = document.getElementById('linkEditModal');
  const linkInput = document.getElementById('linkEditInput');

  // 모달 외부 클릭 시 닫기
  linkModal.addEventListener('click', (e) => {
    if (e.target === linkModal) closeLinkEditModal();
  });

  // Enter → 저장, Escape → 닫기
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  saveLinkEdit();
    if (e.key === 'Escape') closeLinkEditModal();
  });

  // 이미지 모달 ESC 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('imgPreviewModal').style.display === 'flex')
      closeImgModal();
  });
});

// ============================================================
// [이미지 미리보기 모달] CDN img_url 클릭 시 전체화면 표시
// ============================================================
function openImgModal(url) {
  if (!url) return;
  const modal   = document.getElementById('imgPreviewModal');
  const img     = document.getElementById('imgPreviewImg');
  const loading = document.getElementById('imgPreviewLoading');

  // 로딩 상태로 초기화
  loading.style.display = 'block';
  img.style.display     = 'none';
  img.src = '';

  // 이미지 로드 완료 시 로딩 숨기고 이미지 표시
  img.onload = () => {
    loading.style.display = 'none';
    img.style.display     = 'block';
  };
  img.onerror = () => {
    loading.textContent   = '이미지를 불러올 수 없습니다.';
  };

  img.src = url;
  modal.style.display = 'flex';
}

function closeImgModal() {
  const modal   = document.getElementById('imgPreviewModal');
  const img     = document.getElementById('imgPreviewImg');
  const loading = document.getElementById('imgPreviewLoading');
  modal.style.display   = 'none';
  img.src               = '';
  img.style.display     = 'none';
  loading.style.display = 'block';
  loading.textContent   = '로딩중...';
}

// ============================================================
// [링크 수정 모달] 주문 행의 URL을 수정하고 관련 파생 데이터 재계산
// ============================================================

let linkEditTargetIndex   = -1; // 현재 수정 중인 첫 번째 orders 인덱스 (호환성 유지)
let linkEditTargetIndices = []; // 일괄 수정 대상 인덱스 배열

/** [링크수정] 버튼 클릭 → 체크된 행 전체를 일괄 수정 대상으로 모달 오픈 */
function openLinkEditModal() {
  if (orders.length === 0) { alert('주문 데이터가 없습니다.'); return; }

  // 체크된 행 인덱스 수집
  const checkedIndices = orders.reduce((acc, o, i) => {
    if (o.checked) acc.push(i);
    return acc;
  }, []);

  if (checkedIndices.length === 0) {
    alert('먼저 수정할 행의 체크박스를 선택해주세요.');
    return;
  }

  linkEditTargetIndex   = checkedIndices[0];
  linkEditTargetIndices = checkedIndices;

  // 첫 번째 선택 행의 URL을 입력란에 채우기
  document.getElementById('linkEditInput').value = orders[linkEditTargetIndex].url || '';

  const infoEl     = document.getElementById('linkEditInfo');
  const bulkInfoEl = document.getElementById('linkEditBulkInfo');
  const bulkWarnEl = document.getElementById('linkEditBulkWarning');
  const bulkListEl = document.getElementById('linkEditBulkList');

  if (checkedIndices.length === 1) {
    // 단일 선택: 주문번호만 표시
    infoEl.textContent       = `#${linkEditTargetIndex + 1}  ${orders[linkEditTargetIndex].orderNo}`;
    bulkInfoEl.style.display = 'none';
  } else {
    // 복수 선택: 빨간 경고 + 주문번호 목록
    infoEl.textContent       = '';
    bulkInfoEl.style.display = 'block';
    bulkWarnEl.textContent   = `${checkedIndices.length}개가 현재 선택되었습니다! 모두 일괄 수정됩니다.`;
    bulkListEl.innerHTML     = checkedIndices
      .map(i => `<div>#${i + 1} ${orders[i].orderNo}</div>`)
      .join('');
  }

  document.getElementById('linkEditModal').classList.add('active');
  setTimeout(() => {
    const input = document.getElementById('linkEditInput');
    input.focus();
    input.select();
  }, 50);
}

/** [저장] 클릭 → URL 처리 후 선택된 모든 행에 일괄 적용 + 재렌더 */
function saveLinkEdit() {
  const rawUrl = document.getElementById('linkEditInput').value.trim();
  if (!rawUrl) { alert('URL을 입력해주세요.'); return; }
  if (linkEditTargetIndices.length === 0) return;

  const { cleanedUrl, offerId } = processUrl(rawUrl);

  // 선택된 모든 행에 동일 URL 일괄 적용
  linkEditTargetIndices.forEach(idx => {
    const order = orders[idx];
    order.url                     = cleanedUrl;              // 정리된 URL (자동화·복사용)
    order.dbData.site_url         = rawUrl;                  // 원본 입력값 (Supabase 저장용)
    order.dbData['1688_offer_id'] = offerId;                 // 재추출된 offer_id
    if (order.originalData) order.originalData[11] = rawUrl; // 데이터 미리보기 L열
  });

  closeLinkEditModal();
  renderOrderList(); // renderDataPreview() 내부 자동 호출
}

/** 링크 수정 모달 닫기 */
function closeLinkEditModal() {
  document.getElementById('linkEditModal').classList.remove('active');
  linkEditTargetIndex   = -1;
  linkEditTargetIndices = [];
}

// 검수 시작
async function startReview() {
  try {
    document.getElementById('btnReview').disabled = true;

    // 주문 데이터가 있는지 확인
    if (orders.length === 0) {
      alert('검수할 주문이 없습니다. 먼저 데이터를 정리해주세요.');
      return;
    }

    // 성공한 주문만 필터링
    const successOrders = orders.filter(o => o.status === 'success');

    // 성공한 주문이 없으면 주문진행 먼저 실행
    if (successOrders.length === 0) {
      console.log('성공한 주문이 없음. 주문진행 자동 실행...');

      // 주문진행 실행
      await processOrders();

      // 주문진행 후 성공한 주문 확인
      const newSuccessOrders = orders.filter(o => o.status === 'success');
      if (newSuccessOrders.length === 0) {
        alert('주문진행 후에도 성공한 주문이 없습니다.');
        return;
      }
    }

    // 검수 결과 초기화
    orders.forEach(order => {
      order.reviewStatus = '';
      order.reviewResult = null;
    });

    await window.api.startReview(orders);

    // 검수 완료 후 화면 갱신 (완료 열은 자동 계산됨)
    renderOrderList();

    // 버튼 상태 업데이트
    stepStatus.review = true;
    updateButtonSteps();

  } catch (error) {
    alert('검수 중 오류가 발생했습니다: ' + error.message);
  } finally {
    document.getElementById('btnReview').disabled = false;
  }
}

// 검수 진행 상황 업데이트
window.api.onReviewProgress((progress) => {
  // batch 모드 처리 (한 번에 모든 결과 수신)
  if (progress.batch && progress.results) {
    console.log(`Received batch results: ${progress.results.length} items`);

    progress.results.forEach(result => {
      applyReviewResult(result);
    });

    // 모든 결과 처리 후 한 번만 렌더링
    renderOrderList();
    return;
  }

  // 기존 개별 처리 모드 (하위 호환성)
  applyReviewResult(progress);
  renderOrderList();
});

// 검수 결과 적용 헬퍼 함수
function applyReviewResult(result) {
  const { index, reviewStatus, reviewResult } = result;

  if (index < orders.length) {
    orders[index].reviewStatus = reviewStatus;
    orders[index].reviewResult = reviewResult;

    // 카트 데이터 저장 (있는 경우)
    if (reviewResult && reviewResult.cartItem) {
      orders[index].cartData = reviewResult.cartItem;

      // dbData에 가격, 이미지 URL 등 업데이트
      if (orders[index].dbData && reviewResult.cartItem) {
        const cartItem = reviewResult.cartItem;

        // 단가 계산: 카트 소계(subtotal)를 카트 수량으로 나눠 진짜 단가를 구함
        // 카트 subtotal은 해당 상품의 전체 수량 합계 금액이므로 order_qty가 아닌 cart quantity로 나눠야 함
        if (cartItem.subtotal !== undefined) {
          const cartQty  = cartItem.quantity || 1;
          const unitPrice = cartItem.subtotal / cartQty;
          const orderQty = orders[index].dbData.order_qty || orders[index].quantity || 1;
          orders[index].dbData.china_price       = parseFloat(unitPrice.toFixed(2));
          orders[index].dbData.china_total_price  = parseFloat((unitPrice * orderQty).toFixed(2));
        }

        if (cartItem.imgUrl) {
          orders[index].dbData.img_url = cartItem.imgUrl;
        }
        if (cartItem.productUrl) {
          orders[index].dbData.site_url = cartItem.productUrl;
        }
      }
    }
  }
}

// 클립보드 복사
function copyToClipboard(text) {
  // Fallback 방식: textarea를 사용한 복사
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      // 복사 성공 시 작은 알림
      const originalTitle = document.title;
      document.title = '✓ 복사됨!';
      setTimeout(() => {
        document.title = originalTitle;
      }, 1000);
    } else {
      alert('복사 실패');
    }
  } catch (err) {
    alert('복사 실패: ' + err.message);
  } finally {
    document.body.removeChild(textarea);
  }
}

// 참조 셀 컨텍스트 메뉴 관련 변수
let currentRefIndex = -1;
let currentRefCodeText = '';

// 참조 셀 컨텍스트 메뉴 표시
function showRefContextMenu(event, index, refCodeText) {
  event.stopPropagation();

  currentRefIndex = index;
  currentRefCodeText = refCodeText;

  const menu = document.getElementById('refContextMenu');
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.classList.add('show');
}

// 컨텍스트 메뉴 숨기기
function hideRefContextMenu() {
  const menu = document.getElementById('refContextMenu');
  menu.classList.remove('show');
}

// 문서 클릭 시 컨텍스트 메뉴 숨기기
document.addEventListener('click', function(event) {
  const menu = document.getElementById('refContextMenu');
  if (menu && !menu.contains(event.target)) {
    hideRefContextMenu();
  }
});

// 컨텍스트 메뉴 - 참조코드 복사
function refMenuCopy() {
  hideRefContextMenu();
  copyRefCode(currentRefCodeText);
}

// 컨텍스트 메뉴 - 정상처리
function refMenuMarkSuccess() {
  hideRefContextMenu();
  if (currentRefIndex >= 0 && currentRefIndex < orders.length) {
    orders[currentRefIndex].refCodeSuccess = true;
    renderOrderList();
  }
}

// 참조코드 복사 함수
function copyRefCode(refCodeText) {
  // Fallback 방식: textarea를 사용한 복사
  const textarea = document.createElement('textarea');
  textarea.value = refCodeText;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      // 모달 알림 표시
      showCopyNotification('참조코드가 복사되었습니다!');
    } else {
      alert('복사 실패');
    }
  } catch (err) {
    alert('복사 실패: ' + err.message);
  } finally {
    document.body.removeChild(textarea);
  }
}

// 복사 알림 모달 표시
function showCopyNotification(message) {
  // 기존 알림이 있으면 제거
  const existingNotification = document.getElementById('copyNotification');
  if (existingNotification) {
    existingNotification.remove();
  }

  // 알림 요소 생성
  const notification = document.createElement('div');
  notification.id = 'copyNotification';
  notification.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 20px 40px;
    border-radius: 8px;
    font-size: 16px;
    z-index: 10000;
    animation: fadeInOut 1.5s ease-in-out;
  `;
  notification.textContent = message;

  // 애니메이션 스타일 추가
  if (!document.getElementById('copyNotificationStyle')) {
    const style = document.createElement('style');
    style.id = 'copyNotificationStyle';
    style.textContent = `
      @keyframes fadeInOut {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
        20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(notification);

  // 1.5초 후 자동 제거
  setTimeout(() => {
    notification.remove();
  }, 1500);
}

// 성공 주문 데이터 내보내기 (구글 시트 형식)
function exportSuccessOrders() {
  // '완료' 열이 true인 데이터만 필터링
  const completedOrders = orders.filter(order => {
    // 수동 설정된 경우
    if (order.finalComplete !== undefined) {
      return order.finalComplete === true;
    }

    // 자동 계산 로직 (렌더링과 동일)
    const hasResult = order.status && order.status !== 'pending';
    const hasReview = order.reviewStatus && order.reviewStatus !== '';
    const resultTrue = order.status === 'success';
    const reviewTrue = order.reviewStatus === 'ok';

    if (hasResult && hasReview) {
      return resultTrue && reviewTrue;
    } else if (!hasResult && hasReview) {
      return reviewTrue;
    }
    return false;
  });

  if (completedOrders.length === 0) {
    alert('내보낼 성공 데이터가 없습니다.');
    return;
  }

  // 구글 시트 형식으로 데이터 포맷팅 (dbData 기준 - 미리보기와 동일)
  const rows = completedOrders.map(order => {
    const original = order.originalData || [];
    const dbData = order.dbData || {};

    // 원본 데이터 길이만큼 배열 생성
    const maxCols = Math.max(original.length, 26);
    const row = [];

    for (let i = 0; i < maxCols; i++) {
      const colName = supabaseColumnMap[i];

      // dbData에 값이 있으면 dbData 사용, 없으면 원본 사용
      if (colName && colName !== '-' && dbData[colName] !== undefined && dbData[colName] !== null) {
        row[i] = dbData[colName];
      } else {
        row[i] = original[i] !== undefined ? original[i] : '';
      }
    }

    // R열(17): 사유 추가 (성공 데이터의 경우)
    if (order.reason) {
      row[17] = order.reason;
    }

    return row.join('\t');
  });

  // 클립보드에 복사
  const exportData = rows.join('\n');
  copyToClipboard(exportData);

  // 버튼 상태 업데이트
  stepStatus.success = true;
  updateButtonSteps();

  alert(`${completedOrders.length}건의 성공 데이터가 복사되었습니다.`);
}

// 실패 주문 데이터 내보내기
function exportFailedOrders() {
  // '완료' 열이 false인 데이터만 필터링
  const failedOrders = orders.filter(order => {
    // 수동 설정된 경우
    if (order.finalComplete !== undefined) {
      return order.finalComplete === false;
    }

    // 자동 계산 로직
    const hasResult = order.status && order.status !== 'pending';
    const hasReview = order.reviewStatus && order.reviewStatus !== '';
    const resultTrue = order.status === 'success';
    const reviewTrue = order.reviewStatus === 'ok';

    if (hasResult && hasReview) {
      return !(resultTrue && reviewTrue);
    } else if (hasResult && !hasReview) {
      return !resultTrue;
    } else if (!hasResult && hasReview) {
      return !reviewTrue;
    }
    return false;
  });

  if (failedOrders.length === 0) {
    alert('내보낼 실패 데이터가 없습니다.');
    return;
  }

  // 구글 시트 형식으로 데이터 포맷팅 (dbData 기준 - 미리보기와 동일)
  const rows = failedOrders.map(order => {
    const original = order.originalData || [];
    const dbData = order.dbData || {};

    // 원본 데이터 길이만큼 배열 생성
    const maxCols = Math.max(original.length, 26);
    const row = [];

    for (let i = 0; i < maxCols; i++) {
      const colName = supabaseColumnMap[i];

      // dbData에 값이 있으면 dbData 사용, 없으면 원본 사용
      if (colName && colName !== '-' && dbData[colName] !== undefined && dbData[colName] !== null) {
        row[i] = dbData[colName];
      } else {
        row[i] = original[i] !== undefined ? original[i] : '';
      }
    }

    // R열(17): 사유 추가
    if (order.reason) {
      row[17] = order.reason;
    }

    // M열(12): 진행 열 비우기 (실패 데이터의 경우)
    row[12] = '';

    return row.join('\t');
  });

  const exportData = rows.join('\n');
  copyToClipboard(exportData);

  // 버튼 상태 업데이트
  stepStatus.fail = true;
  updateButtonSteps();

  alert(`${failedOrders.length}건의 실패 데이터가 복사되었습니다.`);
}

// ========== 실패V2: ft_order_items_failed에 실패 데이터 저장 ==========
async function exportFailedOrdersV2() {
  const failBtn = document.getElementById('btnExportFailV2');
  const originalText = failBtn ? failBtn.textContent : '실패V2';

  // ── Supabase 연결 확인 ──
  if (!supabaseClient) {
    alert('Supabase 연결이 초기화되지 않았습니다.');
    return;
  }

  if (orders.length === 0) {
    alert('주문 데이터가 없습니다.');
    return;
  }

  // ── ft_users 유저 선택 확인 ──
  const ftUserSelect = document.getElementById('ftUserSelect');
  if (!ftUserSelect || !ftUserSelect.value) {
    alert('유저를 선택해주세요.');
    return;
  }
  const ftUserId = ftUserSelect.value;

  // ── 실패 건 필터링 (기존 exportFailedOrders와 동일 로직) ──
  const failedOrders = orders.filter(order => {
    if (order.finalComplete !== undefined) {
      return order.finalComplete === false;
    }
    const hasResult = order.status && order.status !== 'pending';
    const hasReview = order.reviewStatus && order.reviewStatus !== '';
    const resultTrue = order.status === 'success';
    const reviewTrue = order.reviewStatus === 'ok';

    if (hasResult && hasReview) {
      return !(resultTrue && reviewTrue);
    } else if (hasResult && !hasReview) {
      return !resultTrue;
    } else if (!hasResult && hasReview) {
      return !reviewTrue;
    }
    return false;
  });

  if (failedOrders.length === 0) {
    alert('저장할 실패 데이터가 없습니다.');
    return;
  }

  // ── 버튼 로딩 상태 ──
  if (failBtn) {
    failBtn.disabled = true;
    failBtn.textContent = '저장 중...';
    failBtn.style.opacity = '0.7';
  }

  console.log(`=== 실패V2 저장 시작: ${failedOrders.length}건 ===`);

  try {
    // ── ft_order_items_failed INSERT 데이터 구성 ──
    const itemsToInsert = failedOrders.map(order => {
      const db = order.dbData || {};
      const original = order.originalData || [];

      return {
        user_id: ftUserId,
        request_date: original[0] || null,                           // A col
        item_no: db.order_number || null,                            // B col
        item_name: db.item_name || null,                             // C col
        option_name: db.option_name || null,                         // D col
        qty: db.order_qty ? parseInt(db.order_qty) : 0,             // E col
        barcode: db.barcode || null,                                 // F col
        china_option1: db.china_option1 || null,                     // G col
        china_option2: db.china_option2 || null,                     // H col
        unit_price_cny: db.china_price ? parseFloat(db.china_price) : 0,       // I col
        total_price_cny: db.china_total_price ? parseFloat(db.china_total_price) : 0, // J col
        img_url: db.img_url || null,                                 // K col
        site_url: db.site_url || null,                               // L col
        note: db.korea_note || null,                                 // Q col
        fail_reason: db.china_note || order.reason || null,          // R col (비고란)
        order_no: db.order_code || null,                             // S col
        option_id: db.option_id || null,                             // U col
        shipment_info: db.coupang_shipment_size || null,             // V col
        composition: db.composition || null,                         // W col
        recommanded_age: db.recomanded_age || null,                  // X col
        set_total: db.set_total ? parseInt(db.set_total) : null,     // Y col
        set_seq: db.set_seq ? parseInt(db.set_seq) : null            // Z col
      };
    });

    console.log('ft_order_items_failed 저장 데이터:', itemsToInsert.length, '건');

    // ── Supabase INSERT ──
    const { data, error } = await supabaseClient
      .from('ft_order_items_failed')
      .insert(itemsToInsert)
      .select();

    if (error) {
      console.error('ft_order_items_failed 저장 오류:', error);
      alert(`실패V2 저장 실패: ${error.message}`);
      return;
    }

    const savedCount = data ? data.length : 0;
    console.log(`✓ ft_order_items_failed 저장 완료: ${savedCount}건`);

    alert(`실패V2 저장 완료!\n\nft_order_items_failed: ${savedCount}건 저장`);

    // ── 버튼 상태 업데이트 ──
    stepStatus.fail = true;
    updateButtonSteps();

  } catch (error) {
    console.error('실패V2 저장 예외:', error);
    alert('실패V2 저장 중 오류: ' + error.message);
  } finally {
    if (failBtn) {
      failBtn.disabled = false;
      failBtn.textContent = originalText;
      failBtn.style.opacity = '1';
    }
  }
}

// 참조코드 입력 (주문 확인 창에서)
async function inputRefCodes() {
  // 성공한 주문만 필터링 (완료 상태인 것)
  const successOrders = orders.filter(order => {
    if (order.finalComplete !== undefined) {
      return order.finalComplete === true;
    }
    const hasResult = order.status && order.status !== 'pending';
    const hasReview = order.reviewStatus && order.reviewStatus !== '';
    const resultTrue = order.status === 'success';
    const reviewTrue = order.reviewStatus === 'ok';
    if (hasResult && hasReview) {
      return resultTrue && reviewTrue;
    } else if (!hasResult && hasReview) {
      return reviewTrue;
    }
    return false;
  });

  if (successOrders.length === 0) {
    alert('참조코드를 입력할 성공 주문이 없습니다.');
    return;
  }

  // offer_id별로 그룹화하여 상세 데이터 수집
  const groupedData = {};
  successOrders.forEach((order, idx) => {
    const match = order.url.match(/offer\/(\d+)\.html/);
    const offerId = match ? match[1] : '';
    if (!offerId) return;

    if (!groupedData[offerId]) {
      groupedData[offerId] = {
        items: [],
        orderIndexes: [] // 원본 orders 배열의 인덱스 저장
      };
    }

    // 참조코드 형식 변경: 주문코드 | 주문번호날짜부분 | 주문번호뒷부분:수량
    // 예: ORBO260125-Q21 | BO-260125 | 0037-A01:10
    const orderNo = order.orderNo || '';
    const orderNoParts = orderNo.split('-');
    // 첫 두 부분: 사업자코드-날짜 (예: BO-260125)
    const orderNoDatePart = orderNoParts.slice(0, 2).join('-');
    // 나머지 부분 (예: 0037-A01)
    const orderNoRestPart = orderNoParts.slice(2).join('-');

    // 원본 인덱스 저장
    const originalIndex = orders.indexOf(order);

    groupedData[offerId].items.push({
      color: order.color,
      size: order.size,
      // 참조코드 컴포넌트 개별 저장 (묶어서 입력하기 위해)
      orderCode: order.orderCode || '',
      orderNoDatePart: orderNoDatePart,
      orderNoRestPart: orderNoRestPart,
      quantity: order.quantity,
      orderIndex: originalIndex  // 각 아이템에 orderIndex 포함
    });

    groupedData[offerId].orderIndexes.push(originalIndex);
  });

  const groupCount = Object.keys(groupedData).length;
  if (groupCount === 0) {
    alert('참조코드가 있는 주문이 없습니다.');
    return;
  }

  console.log('참조코드 그룹:', groupedData);

  // 자동화 시작
  try {
    document.getElementById('btnRefCode').disabled = true;
    const result = await window.api.inputRefCodes(groupedData);

    // 실제 매칭되어 입력된 항목만 성공으로 표시
    // 매칭 안 된 건은 그냥 비워둠 (나중에 다시 실행 가능)
    if (result.successOrderIndexes && result.successOrderIndexes.length > 0) {
      result.successOrderIndexes.forEach(idx => {
        if (idx >= 0 && idx < orders.length) {
          orders[idx].refCodeSuccess = true;
        }
      });
    }

    renderOrderList();

    // 버튼 상태 업데이트
    stepStatus.refCode = true;
    updateButtonSteps();

    // 빈 textarea 경고 표시
    if (result.emptyTextareaCount > 0) {
      showEmptyTextareaWarning(result.emptyTextareaCount, result.totalTextareas, result.emptySellerNames);
    }
  } catch (error) {
    alert('참조코드 입력 중 오류가 발생했습니다: ' + error.message);
  } finally {
    document.getElementById('btnRefCode').disabled = false;
  }
}

// ========== 참조코드 입력 V2 (카트 → 결산 → 참조코드 → 주소 선택 전체 워크플로우) ==========
async function inputRefCodesV2() {
  // ── ft_users 유저 선택 확인 및 user_code 추출 ──
  const ftUserSelect = document.getElementById('ftUserSelect');
  if (!ftUserSelect || !ftUserSelect.value) {
    alert('유저를 선택해주세요.');
    return;
  }
  const userCode = ftUserSelect.selectedOptions[0]?.dataset.userCode || '';
  if (!userCode) {
    alert('선택된 유저의 user_code가 없습니다.');
    return;
  }

  // ── 성공한 주문만 필터링 (기존 inputRefCodes와 동일 기준) ──
  const successOrders = orders.filter(order => {
    if (order.finalComplete !== undefined) {
      return order.finalComplete === true;
    }
    const hasResult = order.status && order.status !== 'pending';
    const hasReview = order.reviewStatus && order.reviewStatus !== '';
    const resultTrue = order.status === 'success';
    const reviewTrue = order.reviewStatus === 'ok';
    if (hasResult && hasReview) {
      return resultTrue && reviewTrue;
    } else if (!hasResult && hasReview) {
      return reviewTrue;
    }
    return false;
  });

  if (successOrders.length === 0) {
    alert('참조코드를 입력할 성공 주문이 없습니다.');
    return;
  }

  // ── offer_id별 그룹화 (기존과 동일) ──
  const groupedData = {};
  successOrders.forEach((order, idx) => {
    const match = order.url.match(/offer\/(\d+)\.html/);
    const offerId = match ? match[1] : '';
    if (!offerId) return;

    if (!groupedData[offerId]) {
      groupedData[offerId] = {
        items: [],
        orderIndexes: []
      };
    }

    const orderNo = order.orderNo || '';
    const orderNoParts = orderNo.split('-');
    const orderNoDatePart = orderNoParts.slice(0, 2).join('-');
    const orderNoRestPart = orderNoParts.slice(2).join('-');
    const originalIndex = orders.indexOf(order);

    groupedData[offerId].items.push({
      color: order.color,
      size: order.size,
      orderCode: order.orderCode || '',
      orderNoDatePart: orderNoDatePart,
      orderNoRestPart: orderNoRestPart,
      quantity: order.quantity,
      orderIndex: originalIndex
    });

    groupedData[offerId].orderIndexes.push(originalIndex);
  });

  const groupCount = Object.keys(groupedData).length;
  if (groupCount === 0) {
    alert('참조코드가 있는 주문이 없습니다.');
    return;
  }

  console.log('V2 참조코드 그룹:', groupedData);
  console.log('V2 user_code:', userCode);

  // userCode를 groupedData에 내장 (V1과 동일한 단일 객체 전달 패턴)
  groupedData._userCode = userCode;

  // ── 버튼 상태: 진행 중 ──
  // - V2 참조코드 버튼은 그대로 보이되 중복 클릭 방지 위해 disabled
  // - V2 중단 버튼은 disabled 해제 → 빨강 활성
  document.getElementById('btnRefCodeV2').disabled = true;
  document.getElementById('btnStopV2').disabled = false;

  // ── 자동화 실행 ──
  try {
    const result = await window.api.inputRefCodesV2(groupedData);

    // 성공한 항목 표시
    if (result.successOrderIndexes && result.successOrderIndexes.length > 0) {
      result.successOrderIndexes.forEach(idx => {
        if (idx >= 0 && idx < orders.length) {
          orders[idx].refCodeSuccess = true;
        }
      });
    }

    renderOrderList();
    stepStatus.refCode = true;
    updateButtonSteps();

    // 결과에 따른 안내
    if (result.stoppedByUser) {
      alert(`V2 참조코드 입력이 중단되었습니다.\n처리 완료: ${result.successOrderIndexes.length}건 (${result.iterationCount}회 반복)`);
    } else if (result.stoppedByEmptyTextarea) {
      showEmptyTextareaWarning(result.emptyTextareaCount, result.totalTextareas, result.emptySellerNames);
      alert(`빈 입력폼 발견으로 제출하지 않고 중단되었습니다.\n빈 항목을 확인해주세요.`);
    } else {
      const reasonText = result.exitReason ? `\n종료 사유: ${result.exitReason}` : '';
      alert(`V2 참조코드 입력 완료!\n처리: ${result.successOrderIndexes.length}건 (${result.iterationCount}회 반복)${reasonText}`);
    }
  } catch (error) {
    alert('V2 참조코드 입력 중 오류가 발생했습니다: ' + error.message);
  } finally {
    // 버튼 상태 복원: V2 참조코드 다시 활성, V2 중단은 회색(비활성)으로
    document.getElementById('btnRefCodeV2').disabled = false;
    document.getElementById('btnStopV2').disabled = true;
  }
}

// 빈 textarea 경고 표시 함수
function showEmptyTextareaWarning(emptyCount, totalCount, emptySellerNames = []) {
  // 기존 경고 제거
  const existingWarning = document.getElementById('emptyTextareaWarning');
  if (existingWarning) {
    existingWarning.remove();
  }

  // 경고 메시지 생성
  const warning = document.createElement('div');
  warning.id = 'emptyTextareaWarning';
  warning.style.cssText = `
    color: #d9534f;
    font-weight: bold;
    padding: 15px;
    margin-top: 10px;
    border: 2px solid #d9534f;
    border-radius: 5px;
    background-color: #f9e4e4;
  `;

  // 메시지 구성
  let messageHTML = `<div style="text-align: center; margin-bottom: 10px;">⚠️ 경고: ${totalCount}개의 입력폼 중 ${emptyCount}개가 비어있습니다!</div>`;

  // 판매자명 리스트 추가
  if (emptySellerNames && emptySellerNames.length > 0) {
    messageHTML += `<div style="margin-top: 10px; padding: 10px; background-color: white; border-radius: 3px;">`;
    messageHTML += `<div style="font-size: 0.9em; margin-bottom: 5px;">비어있는 판매자:</div>`;
    messageHTML += `<ul style="margin: 5px 0; padding-left: 25px; text-align: left; font-weight: normal;">`;
    emptySellerNames.forEach(name => {
      messageHTML += `<li>${name}</li>`;
    });
    messageHTML += `</ul></div>`;
  }

  warning.innerHTML = messageHTML;

  // 주문 목록 섹션(.order-list) 바로 앞에 삽입 (데이터 미리보기 아래, 주문 목록 위)
  const orderListSection = document.querySelector('.order-list');
  if (orderListSection && orderListSection.parentNode) {
    orderListSection.parentNode.insertBefore(warning, orderListSection);
  }
}

// 로그인 설정 - 디버그용 크롬창 열기
async function openLoginSetup() {
  try {
    await window.api.openLoginBrowser();
  } catch (error) {
    alert('브라우저 열기 실패: ' + error.message);
  }
}

// 셀 편집 기능
function makeEditable(cell, index, field) {
  // 이미 편집 중이면 무시
  if (cell.querySelector('input')) return;

  const currentValue = orders[index][field];
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.style.cssText = 'width: 100%; border: none; background: transparent; font-size: inherit; font-family: inherit; padding: 0; margin: 0; outline: none;';

  cell.textContent = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  // 저장 함수
  const saveValue = () => {
    const newValue = input.value.trim();

    // 수량인 경우 숫자로 변환
    if (field === 'quantity') {
      const numValue = parseInt(newValue) || 1;
      orders[index][field] = numValue;
      cell.textContent = numValue;

      // dbData도 업데이트
      if (orders[index].dbData) {
        orders[index].dbData.order_qty = numValue;
      }
    } else {
      orders[index][field] = newValue;
      cell.textContent = newValue;

      // dbData도 업데이트
      if (orders[index].dbData) {
        if (field === 'color') {
          orders[index].dbData.china_option1 = newValue;
        } else if (field === 'size') {
          orders[index].dbData.china_option2 = newValue;
        }
      }
    }

    // 미리보기 갱신
    renderDataPreview();
  };

  // Enter 키로 저장
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveValue();
    } else if (e.key === 'Escape') {
      cell.textContent = currentValue;
    }
  });

  // 포커스 잃으면 저장
  input.addEventListener('blur', saveValue);
}

// 검색/필터로 숨겨지지 않은(보이는) 행의 체크박스만 반환
function getVisibleRowCheckboxes() {
  return Array.from(document.querySelectorAll('.row-checkbox')).filter(cb => {
    const row = cb.closest('tr');
    return !row || !row.classList.contains('search-hidden');
  });
}

// 전체 체크박스 토글 (필터로 조회된 = 보이는 행만 대상)
function toggleAllCheckboxes(headerCheckbox) {
  getVisibleRowCheckboxes().forEach(cb => {
    const index = parseInt(cb.dataset.index);
    cb.checked = headerCheckbox.checked;
    orders[index].checked = headerCheckbox.checked;
  });
}

// 행 체크박스 토글 (셀 클릭 시)
function toggleRowCheckbox(index, event) {
  // 체크박스 자체를 클릭한 경우는 무시 (기본 동작 사용)
  if (event.target.type === 'checkbox') return;

  const checkbox = event.currentTarget.querySelector('input[type="checkbox"]');
  if (checkbox) {
    checkbox.checked = !checkbox.checked;
    orders[index].checked = checkbox.checked;

    // 헤더 체크박스 상태 업데이트
    updateHeaderCheckbox();
  }
}

// 헤더 체크박스 상태 업데이트 (보이는 행 기준)
function updateHeaderCheckbox() {
  const headerCheckbox = document.querySelector('thead input[type="checkbox"]');
  if (!headerCheckbox) return;
  const visible = getVisibleRowCheckboxes();
  const allChecked = visible.length > 0 && visible.every(cb => cb.checked);
  const someChecked = visible.some(cb => cb.checked);
  headerCheckbox.checked = allChecked;
  headerCheckbox.indeterminate = someChecked && !allChecked;
}

// 체크박스 변경 이벤트 리스너 (이벤트 위임)
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('row-checkbox')) {
    const index = parseInt(e.target.dataset.index);
    orders[index].checked = e.target.checked;
    updateHeaderCheckbox();
  }
});

// ========== 검색 기능 ==========
let searchMatches = [];
let currentMatchIndex = -1;

// Ctrl+F로 검색창 열기
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    openSearch();
  }
  if (e.key === 'Escape') {
    closeSearch();
  }
});

// 검색창 열기
function openSearch() {
  console.log('openSearch called');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  console.log('searchBox:', searchBox);
  console.log('searchInput:', searchInput);
  if (searchBox && searchInput) {
    searchBox.classList.add('active');
    searchInput.focus();
    searchInput.select();
  }
}

// 검색창 닫기
function closeSearch() {
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  searchBox.classList.remove('active');
  searchInput.value = '';
  clearHighlights();
  searchMatches = [];
  currentMatchIndex = -1;
  document.getElementById('searchInfo').textContent = '';
}

// 하이라이트 제거
function clearHighlights() {
  const highlights = document.querySelectorAll('.search-highlight, .search-highlight-current');
  highlights.forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

// 검색 실행
function performSearch(searchText) {
  clearHighlights();
  searchMatches = [];
  currentMatchIndex = -1;

  if (!searchText || searchText.trim() === '') {
    document.getElementById('searchInfo').textContent = '';
    return;
  }

  const searchLower = searchText.toLowerCase();
  const table = document.querySelector('.order-table');
  if (!table) return;

  const rows = table.querySelectorAll('tbody tr');

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    cells.forEach(cell => {
      highlightTextInNode(cell, searchText, searchLower);
    });
  });

  searchMatches = document.querySelectorAll('.search-highlight');

  if (searchMatches.length > 0) {
    currentMatchIndex = 0;
    updateCurrentHighlight();
    document.getElementById('searchInfo').textContent = `1 / ${searchMatches.length}`;
  } else {
    document.getElementById('searchInfo').textContent = '0 / 0';
  }
}

// 노드 내 텍스트 하이라이트
function highlightTextInNode(node, searchText, searchLower) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
    const textLower = text.toLowerCase();
    const index = textLower.indexOf(searchLower);

    if (index >= 0) {
      const before = text.substring(0, index);
      const match = text.substring(index, index + searchText.length);
      const after = text.substring(index + searchText.length);

      const span = document.createElement('span');
      span.className = 'search-highlight';
      span.textContent = match;

      const fragment = document.createDocumentFragment();
      if (before) fragment.appendChild(document.createTextNode(before));
      fragment.appendChild(span);
      if (after) {
        const afterNode = document.createTextNode(after);
        fragment.appendChild(afterNode);
        // 재귀적으로 나머지 텍스트도 검색
        node.parentNode.insertBefore(fragment, node);
        node.parentNode.removeChild(node);
        highlightTextInNode(afterNode, searchText, searchLower);
        return;
      }
      node.parentNode.replaceChild(fragment, node);
    }
  } else if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA'].includes(node.tagName)) {
    // 자식 노드들을 배열로 복사 (DOM 변경 중 순회 문제 방지)
    const children = Array.from(node.childNodes);
    children.forEach(child => highlightTextInNode(child, searchText, searchLower));
  }
}

// 현재 매칭 하이라이트 업데이트
function updateCurrentHighlight() {
  // 모든 하이라이트를 기본 색으로
  document.querySelectorAll('.search-highlight-current').forEach(el => {
    el.classList.remove('search-highlight-current');
    el.classList.add('search-highlight');
  });

  // 현재 매칭을 주황색으로
  if (searchMatches.length > 0 && currentMatchIndex >= 0) {
    const current = searchMatches[currentMatchIndex];
    current.classList.remove('search-highlight');
    current.classList.add('search-highlight-current');
    current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// 다음 검색 결과
function searchNext() {
  if (searchMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
  updateCurrentHighlight();
  document.getElementById('searchInfo').textContent = `${currentMatchIndex + 1} / ${searchMatches.length}`;
}

// 이전 검색 결과
function searchPrev() {
  if (searchMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
  updateCurrentHighlight();
  document.getElementById('searchInfo').textContent = `${currentMatchIndex + 1} / ${searchMatches.length}`;
}

// 검색 입력 이벤트
document.getElementById('searchInput').addEventListener('input', (e) => {
  performSearch(e.target.value);
});

// Enter로 다음 검색, Shift+Enter로 이전 검색
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      searchPrev();
    } else {
      searchNext();
    }
  }
});

// Supabase에 저장
async function saveToSupabase() {
  const saveBtn = document.getElementById('btnSaveSupabase');
  const originalText = saveBtn.textContent;

  if (!supabaseClient) {
    alert('Supabase 연결이 초기화되지 않았습니다. .env 파일을 확인해주세요.');
    console.error('Supabase 클라이언트가 초기화되지 않음');
    return;
  }

  if (orders.length === 0) {
    alert('저장할 주문 데이터가 없습니다.');
    return;
  }

  // 버튼 로딩 상태
  saveBtn.disabled = true;
  saveBtn.textContent = '저장 중...';
  saveBtn.style.opacity = '0.7';

  console.log('=== Supabase 저장 시작 ===');
  console.log(`총 ${orders.length}개의 주문 데이터 저장 시작`);

  try {
    // 선택된 사용자 정보 가져오기
    const userSelect = document.getElementById('userSelect');
    const selectedUserId = userSelect ? userSelect.value : '';
    const selectedOption = userSelect ? userSelect.options[userSelect.selectedIndex] : null;
    const selectedUserCode = selectedOption ? selectedOption.dataset.userCode : '';
    const selectedMasterAccount = selectedOption ? selectedOption.dataset.masterAccount : '';

    // dbData만 추출하여 배열로 만들기 (사용자 정보 포함)
    const dataToInsert = orders.map(order => {
      if (!order.dbData) {
        console.warn('dbData가 없는 주문:', order);
        return null;
      }

      // 선택된 사용자 정보 추가
      if (selectedUserId) {
        order.dbData.user_id = selectedUserId;
        order.dbData.user_code = selectedUserCode;
        order.dbData.master_account = selectedMasterAccount;
      }

      // invoiceManager_1688_orders에 없는 컬럼 제외
      const { raw_date, ...dbDataClean } = order.dbData;
      return dbDataClean;
    }).filter(data => data !== null);

    console.log(`저장할 데이터 개수: ${dataToInsert.length}`);
    console.log('샘플 데이터:', dataToInsert[0]);

    // Supabase에 데이터 UPSERT (있으면 업데이트, 없으면 삽입)
    // order_number를 고유 키로 사용
    const { data, error } = await supabaseClient
      .from('invoiceManager_1688_orders')
      .upsert(dataToInsert, {
        onConflict: 'order_number',  // order_number가 중복되면 업데이트
        ignoreDuplicates: false       // 중복 시 업데이트 수행
      })
      .select();

    if (error) {
      console.error('Supabase 저장 오류 (전체):', error);
      console.error('오류 메시지:', error.message);
      console.error('오류 상세:', error.details);
      console.error('오류 힌트:', error.hint);
      console.error('오류 코드:', error.code);
      alert(`저장 실패: ${error.message}\n상세: ${error.details || ''}\n힌트: ${error.hint || ''}`);
      return;
    }

    console.log('✓ Supabase 저장 성공:', data);

    // 저장 확인 - order_number로 조회해서 실제로 저장됐는지 확인
    saveBtn.textContent = '확인 중...';
    const orderNumbers = dataToInsert.map(d => d.order_number).filter(n => n);

    const { data: verifyData, error: verifyError } = await supabaseClient
      .from('invoiceManager_1688_orders')
      .select('order_number')
      .in('order_number', orderNumbers);

    if (verifyError) {
      console.error('저장 확인 오류:', verifyError);
      alert(`저장은 완료되었으나 확인 중 오류 발생: ${verifyError.message}`);
      return;
    }

    const savedCount = verifyData.length;
    console.log(`✓ 저장 확인 완료: ${savedCount}개 확인됨`);
    alert(`저장 완료!\n\n저장된 주문: ${data.length}개\n확인된 주문: ${savedCount}개`);

    // 저장 완료 표시
    isDataSaved = true;

    // 버튼 상태 업데이트
    stepStatus.save = true;
    updateButtonSteps();

  } catch (error) {
    console.error('저장 중 예외 발생:', error);
    alert(`저장 중 오류 발생: ${error.message}`);
  } finally {
    // 버튼 원래 상태로 복구
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
    saveBtn.style.opacity = '1';
  }
}

// ========== V열(배송 사이즈/타입) 파싱 헬퍼 ==========
// V열 원본값을 분석해 shipment_type, coupang_shipment_size, personal_order_no 를 반환
// - Small / Medium / Large / ""  → COUPANG  (coupang_shipment_size 그대로)
// - "P-숫자"                     → PERSONAL (personal_order_no = 숫자 부분)
// - "Direct"                     → DIRECT
function parseShipmentInfo(rawValue) {
  const val = (rawValue || '').trim();

  // PERSONAL: "P-" 뒤에 숫자가 오는 패턴 (뒤에 이름 등 추가 텍스트 허용)
  const personalMatch = val.match(/^P-(\d+)/i);
  if (personalMatch) {
    return {
      shipment_type: 'PERSONAL',
      coupang_shipment_size: null,
      personal_order_no: personalMatch[1]
    };
  }

  // DIRECT
  if (val.toLowerCase() === 'direct') {
    return {
      shipment_type: 'DIRECT',
      coupang_shipment_size: null,
      personal_order_no: null
    };
  }

  // COUPANG: Small / Medium / Large / 빈값 → 대문자 정규화 (SMALL / MEDIUM / LARGE)
  return {
    shipment_type: 'COUPANG',
    coupang_shipment_size: val ? val.toUpperCase() : null,
    personal_order_no: null
  };
}

// ========== V2 저장 (ft_orders + ft_order_items) ==========
async function saveToSupabaseV2() {
  const saveBtn = document.getElementById('btnSaveV2');
  const originalText = saveBtn ? saveBtn.textContent : 'V2 저장';

  if (!supabaseClient) {
    alert('Supabase 연결이 초기화되지 않았습니다.');
    return;
  }

  if (orders.length === 0) {
    alert('저장할 주문 데이터가 없습니다.');
    return;
  }

  // ft_users 드롭박스에서 유저 정보 가져오기
  const ftUserSelect = document.getElementById('ftUserSelect');
  if (!ftUserSelect || !ftUserSelect.value) {
    alert('유저를 선택해주세요.');
    return;
  }

  const ftUserId = ftUserSelect.value;
  const ftUserOption = ftUserSelect.options[ftUserSelect.selectedIndex];
  const ftFullName = ftUserOption.dataset.fullName || '';
  const ftPhone = ftUserOption.dataset.phone || '';
  const ftAddress = ftUserOption.dataset.address || '';

  // 대표 주문코드
  const orderCode = orders[0].orderCode || (orders[0].dbData && orders[0].dbData.order_code) || '';
  if (!orderCode) {
    alert('주문코드(order_code)를 찾을 수 없습니다.');
    return;
  }

  // ── 성공 건만 필터링 ([성공] 버튼과 동일 기준) ──
  const successOrders = orders.filter(order => {
    if (order.finalComplete !== undefined) {
      return order.finalComplete === true;
    }
    const hasResult = order.status && order.status !== 'pending';
    const hasReview = order.reviewStatus && order.reviewStatus !== '';
    const resultTrue = order.status === 'success';
    const reviewTrue = order.reviewStatus === 'ok';

    if (hasResult && hasReview) {
      return resultTrue && reviewTrue;
    } else if (!hasResult && hasReview) {
      return reviewTrue;
    }
    return false;
  });

  if (successOrders.length === 0) {
    alert('저장할 성공 데이터가 없습니다.');
    return;
  }

  // 총 수량 계산 (성공 건 기준)
  const totalQty = successOrders.reduce((sum, order) => sum + (order.quantity || 0), 0);

  // 버튼 로딩 상태
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'V2 저장 중...';
    saveBtn.style.opacity = '0.7';
  }

  console.log('=== V2 저장 시작 ===');

  try {
    // ── Step 1: ft_orders UPSERT (order_no 기준 중복 검사) ──
    const ftOrderData = {
      order_no: orderCode,
      user_id: ftUserId,
      recipient_name: ftFullName,
      recipient_phone: ftPhone,
      recipient_address: ftAddress,
      status: 'PROCESSING',
      total_qty: totalQty
    };

    console.log('ft_orders 저장 데이터:', ftOrderData);

    // order_no 기준 중복 검사
    const { data: existingOrder, error: checkOrderError } = await supabaseClient
      .from('ft_orders')
      .select('id')
      .eq('order_no', orderCode)
      .order('created_at', { ascending: false })
      .limit(1);

    if (checkOrderError) {
      console.error('ft_orders 중복 검사 오류:', checkOrderError);
      alert(`ft_orders 중복 검사 실패: ${checkOrderError.message}`);
      return;
    }

    let ftOrderId;

    if (existingOrder && existingOrder.length > 0) {
      // ── 기존 레코드 UPDATE ──
      ftOrderId = existingOrder[0].id;
      console.log(`ft_orders order_no(${orderCode}) 기존 레코드 발견 → UPDATE (ID: ${ftOrderId})`);

      const { error: updateOrderError } = await supabaseClient
        .from('ft_orders')
        .update(ftOrderData)
        .eq('id', ftOrderId);

      if (updateOrderError) {
        console.error('ft_orders 업데이트 오류:', updateOrderError);
        alert(`ft_orders 업데이트 실패: ${updateOrderError.message}`);
        return;
      }
      console.log('✓ ft_orders 업데이트 완료 (ID:', ftOrderId, ')');
    } else {
      // ── 신규 INSERT ──
      const { data: orderData, error: orderError } = await supabaseClient
        .from('ft_orders')
        .insert([ftOrderData])
        .select();

      if (orderError) {
        console.error('ft_orders 저장 오류:', orderError);
        alert(`ft_orders 저장 실패: ${orderError.message}`);
        return;
      }

      if (!orderData || orderData.length === 0) {
        alert('ft_orders 저장 실패: 데이터가 반환되지 않았습니다.');
        return;
      }

      ftOrderId = orderData[0].id;
      console.log('✓ ft_orders 신규 저장 완료 (ID:', ftOrderId, ')');
    }

    // ── Step 2: ft_order_items (기존 아이템 삭제 후 INSERT) ──
    if (saveBtn) saveBtn.textContent = '아이템 저장 중...';

    // order_id 기준 기존 아이템 삭제 (중복 방지)
    const { error: deleteItemsError } = await supabaseClient
      .from('ft_order_items')
      .delete()
      .eq('order_id', ftOrderId);

    if (deleteItemsError) {
      console.error('ft_order_items 기존 데이터 삭제 오류:', deleteItemsError);
      alert(`ft_order_items 기존 데이터 삭제 실패: ${deleteItemsError.message}`);
      return;
    }
    console.log('✓ ft_order_items 기존 데이터 삭제 완료 (order_id:', ftOrderId, ')');

    // product_no별 UUID 생성 (같은 product_no → 같은 product_id)
    const productIdMap = new Map();
    successOrders.forEach(order => {
      const db = order.dbData || {};
      const productNo = (db.order_number || '').split('-').slice(0, 3).join('-') || null;
      if (productNo && !productIdMap.has(productNo)) {
        productIdMap.set(productNo, crypto.randomUUID());
      }
    });

    const itemsToInsert = successOrders.map((order, index) => {
      const db = order.dbData || {};
      const productNo = (db.order_number || '').split('-').slice(0, 3).join('-') || null;

      // V열 배송 타입 파싱 (COUPANG / PERSONAL / DIRECT)
      console.log(`[V2 item#${index}] coupang_shipment_size 원본값:`, JSON.stringify(db.coupang_shipment_size));
      const shipment = parseShipmentInfo(db.coupang_shipment_size);
      console.log(`[V2 item#${index}] parseShipmentInfo 결과:`, JSON.stringify(shipment));

      return {
        order_id: ftOrderId,
        order_no: db.order_code || orderCode,
        // 【V2 주문 탭】 미리 누적 계산한 _computed_item_seq 우선
        // 【주문 탭】     기존 fallback (index + 1)
        item_seq: db._computed_item_seq ?? (index + 1),
        item_name: db.item_name || null,
        option_name: db.option_name || null,
        order_qty: db.order_qty || null,
        barcode: db.barcode || null,
        china_option1: db.china_option1 || null,
        china_option2: db.china_option2 || null,
        price_cny: db.china_price || null,
        price_total_cny: db.china_total_price || null,
        img_url: db.img_url || null,
        site_url: db.site_url || null,
        note_kr: db.korea_note || null,
        note_cn: db.china_note || null,
        composition: db.composition || null,
        recommanded_age: db.recomanded_age || null,
        set_total: db.set_total || null,
        set_seq: db.set_seq || null,
        // ── 배송 타입 분기 결과 ──
        shipment_type: shipment.shipment_type,
        coupang_shipment_size: shipment.coupang_shipment_size,
        personal_order_no: shipment.personal_order_no,
        item_no: db.order_number || null,
        product_no: productNo,
        product_id: productIdMap.get(productNo) || null,
        '1688_offer_id': db['1688_offer_id'] || null,
        '1688_order_id': db['1688_order_id'] || null,
        price_delivery_cny: db.price_delivery_cny ?? null,
        vendor_option_id: db.option_id || null,              // U열
        requested_date: (() => {                              // A열 (MMDD → YYYY-MM-DD)
          const mmdd = db.raw_date || '';
          if (mmdd.length === 4 && /^\d{4}$/.test(mmdd)) {
            const year = new Date().getFullYear();
            return `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
          }
          return null;
        })(),
        user_id: ftUserId,
        status: 'PROCESSING'
      };
    });

    console.log(`ft_order_items 저장: ${itemsToInsert.length}개`);

    const { data: itemsData, error: itemsError } = await supabaseClient
      .from('ft_order_items')
      .insert(itemsToInsert)
      .select();

    if (itemsError) {
      console.error('ft_order_items 저장 오류:', itemsError);
      alert(`ft_order_items 저장 실패: ${itemsError.message}\n\nft_orders는 저장됨 (ID: ${ftOrderId})`);
      return;
    }

    // ── Step 3: 저장 검증 ──
    if (saveBtn) saveBtn.textContent = '검증 중...';

    const { data: verifyItems, error: verifyError } = await supabaseClient
      .from('ft_order_items')
      .select('id')
      .eq('order_id', ftOrderId);

    if (verifyError) {
      console.error('검증 오류:', verifyError);
      alert(`저장은 완료되었으나 검증 중 오류: ${verifyError.message}`);
      return;
    }

    const savedItemCount = verifyItems ? verifyItems.length : 0;
    console.log(`✓ V2 저장 검증 완료: ft_orders 1건, ft_order_items ${savedItemCount}건`);

    // ── 【V2 주문 탭 전용】 cart 출처 행들의 ft_carts.status = 'DONE' 일괄 UPDATE ──
    // 한 세션에 여러 카트가 같은 order_no 로 묶여 들어올 수 있으므로 _cartId 전부 수집해 in() 사용.
    // 주문 탭(시트 입력)에서 호출된 경우 _cartId 가 없으므로 이 블록은 no-op.
    const cartIdsToFinalize = [...new Set(
      orders.map(o => o?.dbData?._cartId).filter(Boolean)
    )];
    if (cartIdsToFinalize.length > 0) {
      const { error: cartUpdateError } = await supabaseClient
        .from('ft_carts')
        .update({ status: 'DONE' })
        .in('id', cartIdsToFinalize);
      if (cartUpdateError) {
        console.error('ft_carts status UPDATE 실패:', cartUpdateError);
        alert(`ft_orders/ft_order_items 저장은 완료됐으나 ft_carts.status='DONE' 갱신 실패: ${cartUpdateError.message}`);
      } else {
        console.log(`✓ ft_carts(${cartIdsToFinalize.length}개).status → 'DONE'`);
      }
    }

    // 【V2 주문 탭 세션】 V2 저장 성공 → 다음 주문은 새 order_no 로 시작
    v2SessionOrderNo = null;

    alert(`V2 저장 완료!\n\n주문코드: ${orderCode}\nft_orders ID: ${ftOrderId}\n총 ${orders.length}건 중 ${successOrders.length}건 성공 데이터 저장\n총 수량: ${totalQty}`);

    isDataSaved = true;
    stepStatus.save = true;
    updateButtonSteps();

  } catch (error) {
    console.error('V2 저장 예외:', error);
    alert('V2 저장 중 오류: ' + error.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
      saveBtn.style.opacity = '1';
    }
  }
}

// ========== V2 차감 (ft_orders UPSERT) ==========
function deductStockV2() {
  if (orders.length === 0) {
    alert('먼저 주문 데이터를 정리해주세요.');
    return;
  }

  // 파일 입력 요소 생성
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.xlsx,.xls';
  fileInput.style.display = 'none';

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await processDeductExcelV2(file);
    } catch (error) {
      console.error('V2 차감 엑셀 처리 오류:', error);
      alert('엑셀 파일 처리 중 오류: ' + error.message);
    }
  });

  document.body.appendChild(fileInput);
  fileInput.click();
  document.body.removeChild(fileInput);
}

// V2 차감 엑셀 처리 → ft_orders UPSERT
async function processDeductExcelV2(file) {
  const btnDeductV2 = document.getElementById('btnDeductV2');
  const originalText = btnDeductV2 ? btnDeductV2.textContent : 'V2 차감';

  if (btnDeductV2) {
    btnDeductV2.disabled = true;
    btnDeductV2.textContent = '처리 중...';
  }

  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      blankrows: false
    });

    if (jsonData.length < 2) {
      alert('엑셀 파일에 데이터가 없습니다.');
      return;
    }

    // 병합 셀 정보
    const merges = worksheet['!merges'] || [];
    const AD_COL = 29;
    const G_COL = 6;
    const I_COL = 8;
    const U_COL = 20;

    // ── 주문코드 검증 (기존 로직 동일) ──
    const currentOrderCodes = new Set();
    orders.forEach(order => {
      if (order.orderCode) currentOrderCodes.add(order.orderCode);
      else if (order.dbData && order.dbData.order_code) currentOrderCodes.add(order.dbData.order_code);
    });

    if (currentOrderCodes.size === 0) {
      alert('현재 주문 데이터에 주문코드(S열)가 없습니다.');
      return;
    }

    // 병합 셀 헬퍼 함수
    function getMergedValue(rowIdx, colIdx, data, merges) {
      if (data[rowIdx] && data[rowIdx][colIdx] !== undefined && data[rowIdx][colIdx] !== '') {
        return data[rowIdx][colIdx];
      }
      for (const merge of merges) {
        if (rowIdx >= merge.s.r && rowIdx <= merge.e.r &&
            colIdx >= merge.s.c && colIdx <= merge.e.c) {
          if (data[merge.s.r] && data[merge.s.r][merge.s.c] !== undefined) {
            return data[merge.s.r][merge.s.c];
          }
        }
      }
      return '';
    }

    function isFirstRowOfMerge(rowIdx, colIdx, merges) {
      for (const merge of merges) {
        if (rowIdx >= merge.s.r && rowIdx <= merge.e.r &&
            colIdx >= merge.s.c && colIdx <= merge.e.c) {
          return rowIdx === merge.s.r;
        }
      }
      return true;
    }

    // AD열 주문코드 추출 및 검증
    const excelOrderCodes = new Set();
    const mismatchedCodes = [];

    for (let i = 1; i < jsonData.length; i++) {
      const adValue = getMergedValue(i, AD_COL, jsonData, merges);
      if (adValue && adValue.toString().trim()) {
        const parts = adValue.toString().split('|');
        const orderCode = parts[0].trim();
        if (orderCode) {
          excelOrderCodes.add(orderCode);
          if (!currentOrderCodes.has(orderCode)) {
            mismatchedCodes.push(orderCode);
          }
        }
      }
    }

    if (mismatchedCodes.length > 0) {
      alert(`엑셀 파일을 확인해주세요.\n다른 주문코드(AD열)가 확인됩니다.\n\n불일치 코드: ${mismatchedCodes.join(', ')}`);
      return;
    }

    if (excelOrderCodes.size === 0) {
      alert('엑셀 파일의 AD열에서 주문코드를 찾을 수 없습니다.');
      return;
    }

    // ── AD열 user_code 검증 (드롭박스 선택 유저와 일치 확인) ──
    const ftUserSelect = document.getElementById('ftUserSelect');
    const selectedUserCode = ftUserSelect.selectedOptions[0]?.dataset.userCode || '';

    if (selectedUserCode) {
      const firstAdCode = [...excelOrderCodes][0];
      const adPrefix = firstAdCode.replace(/^OR/, '');
      const adUserCode = adPrefix.replace(/\d{6}.*$/, '');

      if (adUserCode && adUserCode !== selectedUserCode) {
        alert(`유저 코드가 일치하지 않습니다.\n\n엑셀 AD열: ${adUserCode}\n선택된 유저: ${selectedUserCode}`);
        return;
      }
    }

    // ── G열, I열, U열 합계 계산 (병합 셀 고려) ──
    let delivery_fee = 0;
    let total_I = 0;
    let item_qty = 0;

    for (let i = 1; i < jsonData.length; i++) {
      if (isFirstRowOfMerge(i, G_COL, merges)) {
        const gValue = getMergedValue(i, G_COL, jsonData, merges);
        delivery_fee += parseFloat(String(gValue).replace(/,/g, '')) || 0;
      }
      if (isFirstRowOfMerge(i, I_COL, merges)) {
        const iValue = getMergedValue(i, I_COL, jsonData, merges);
        total_I += parseFloat(String(iValue).replace(/,/g, '')) || 0;
      }
      const uValue = jsonData[i] && jsonData[i][U_COL];
      item_qty += parseInt(String(uValue).replace(/,/g, '')) || 0;
    }

    // 계산 (소수점 2자리) - 기존 차감과 동일한 로직
    // delivery_fee = G열 합계 (배송비)
    // total_item_price = I열 - G열 (상품가)
    // service_fee = total_item_price * 0.06 (수수료 6%)
    // total_amount = total_item_price + service_fee + delivery_fee + extra_fee
    delivery_fee = Math.round(delivery_fee * 100) / 100;
    const total_item_price = Math.round((total_I - delivery_fee) * 100) / 100;
    const service_fee = Math.round(total_item_price * 0.06 * 100) / 100;
    const total_amount = Math.round((total_item_price + service_fee + delivery_fee) * 100) / 100;

    console.log('=== V2 차감 계산 결과 ===');
    console.log('delivery_fee (G열 배송비):', delivery_fee);
    console.log('total_item_price (I-G 상품가):', total_item_price);
    console.log('service_fee (6%):', service_fee);
    console.log('total_amount (합계):', total_amount);

    // ── 선택된 ft_user 정보 가져오기 (ftUserSelect는 위에서 이미 선언됨) ──
    const selectedOption = ftUserSelect ? ftUserSelect.selectedOptions[0] : null;

    if (!ftUserSelect || !ftUserSelect.value) {
      alert('ft_users에서 사용자를 선택해주세요.');
      return;
    }

    const userId = ftUserSelect.value;
    const balanceId = selectedOption.dataset.balanceId;
    const venderName = selectedOption.dataset.venderName || '';

    if (!balanceId) {
      alert('선택된 사용자에게 balance_id가 없습니다.');
      return;
    }

    // ── ft_orders UPSERT (order_no 기준) ──
    const orderCode = Array.from(excelOrderCodes)[0];

    if (!supabaseClient) {
      alert('Supabase 연결이 초기화되지 않았습니다.');
      return;
    }

    // order_no로 기존 레코드 조회 (중복 행 있어도 에러 안 나게 배열로 받음)
    const { data: existingOrders, error: findError } = await supabaseClient
      .from('ft_orders')
      .select('id')
      .eq('order_no', orderCode)
      .order('created_at', { ascending: false });

    if (findError) {
      console.error('ft_orders 조회 오류:', findError);
      alert(`ft_orders 조회 실패: ${findError.message}`);
      return;
    }

    if (!existingOrders || existingOrders.length === 0) {
      alert(`ft_orders에 주문코드(${orderCode})가 없습니다.\n먼저 V2 저장을 진행해주세요.`);
      return;
    }

    if (existingOrders.length > 1) {
      console.warn(`ft_orders에 order_no(${orderCode}) 중복 ${existingOrders.length}건 — 최신 행 사용`);
    }

    const existingOrder = existingOrders[0]; // 최신 행 사용

    // UPDATE (가격 정보만 업데이트)
    const updateData = {
      delivery_fee: delivery_fee,
      total_item_price: total_item_price,
      service_fee: service_fee,
      total_amount: total_amount
    };

    console.log('ft_orders UPDATE 데이터:', updateData);

    const { data: updatedOrder, error: updateError } = await supabaseClient
      .from('ft_orders')
      .update(updateData)
      .eq('id', existingOrder.id)
      .select();

    if (updateError) {
      console.error('ft_orders 업데이트 오류:', updateError);
      alert(`ft_orders 업데이트 실패: ${updateError.message}`);
      return;
    }

    // 검증
    const { data: verifyData, error: verifyError } = await supabaseClient
      .from('ft_orders')
      .select('delivery_fee, total_item_price, service_fee, total_amount')
      .eq('id', existingOrder.id)
      .single();

    if (verifyError || !verifyData) {
      alert('V2 차감 검증 실패');
      return;
    }

    const isValid =
      parseFloat(verifyData.delivery_fee) === delivery_fee &&
      parseFloat(verifyData.total_item_price) === total_item_price &&
      parseFloat(verifyData.service_fee) === service_fee &&
      parseFloat(verifyData.total_amount) === total_amount;

    if (!isValid) {
      console.error('데이터 불일치:', { saved: verifyData, expected: { delivery_fee, total_item_price, service_fee, total_amount } });
      alert('V2 차감 검증 실패: 저장된 데이터가 일치하지 않습니다.');
      return;
    }

    console.log('✓ ft_orders 업데이트 및 검증 완료');

    // ── ft_user_transactions 중복 검사 (같은 balance_id + amount + 오늘 날짜) ──
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data: existingTx, error: txCheckError } = await supabaseClient
      .from('ft_user_transactions')
      .select('id, created_at')
      .eq('balance_id', balanceId)
      .eq('amount', total_amount)
      .eq('type', 'out')
      .eq('category', '구매')
      .gte('created_at', todayStart.toISOString())
      .limit(1);

    if (txCheckError) {
      console.error('거래 중복 검사 오류:', txCheckError);
    }

    if (existingTx && existingTx.length > 0) {
      const confirmDuplicate = confirm(
        `동일한 차감 내역이 이미 존재합니다.\n` +
        `금액: ${total_amount.toLocaleString()}원\n` +
        `시간: ${new Date(existingTx[0].created_at).toLocaleString()}\n\n` +
        `중복 차감을 진행하시겠습니까?`
      );
      if (!confirmDuplicate) {
        alert('V2 차감이 취소되었습니다.');
        return;
      }
    }

    // ── ft_balances 차감 + ft_user_transactions 기록 (RPC) ──
    const { data: rpcResult, error: rpcError } = await supabaseClient
      .rpc('deduct_balance_and_record_transaction', {
        p_balance_id:    balanceId,
        p_user_id:       userId,
        p_vender_name:   venderName,
        p_amount:        total_amount,
        p_qty:           item_qty,
        p_item_amount:   total_item_price,
        p_shipping_fee:  delivery_fee,
        p_service_fee:   service_fee,
        p_other_fee:     0,
        p_description:   orderCode + ' 주문',
        p_reference_id:  null,
        p_order_no_1688: null,
        p_admin_note:    null
      });

    if (rpcError) {
      console.error('RPC 차감 오류:', rpcError);
      alert(`ft_orders는 업데이트됨.\n하지만 잔액 차감 실패: ${rpcError.message}`);
      return;
    }

    console.log('✓ RPC 차감 결과:', rpcResult);

    // ── 검증: ft_balances 잔액 확인 ──
    const { data: verifyBalance, error: verifyBalanceError } = await supabaseClient
      .from('ft_balances')
      .select('balance')
      .eq('id', balanceId)
      .single();

    if (verifyBalanceError || !verifyBalance) {
      console.error('잔액 검증 조회 오류:', verifyBalanceError);
      alert('차감은 완료되었으나 잔액 검증 조회에 실패했습니다.');
    } else {
      const balanceMatch = parseFloat(verifyBalance.balance) === rpcResult.new_balance;
      if (!balanceMatch) {
        console.warn('잔액 불일치:', { db: verifyBalance.balance, expected: rpcResult.new_balance });
      }
      console.log('✓ 잔액 검증:', balanceMatch ? '일치' : '불일치');
    }

    // ── 완료 ──
    alert(`V2 차감 완료!\n\n` +
      `주문코드: ${orderCode}\n` +
      `차감액: ${total_amount.toLocaleString()}원\n` +
      `상품가: ${total_item_price.toLocaleString()}원\n` +
      `배송비: ${delivery_fee.toLocaleString()}원\n` +
      `수수료: ${service_fee.toLocaleString()}원\n` +
      `수량: ${item_qty}개\n\n` +
      `잔액: ${rpcResult.new_balance.toLocaleString()}원\n` +
      `거래ID: ${rpcResult.transaction_id}`);

    stepStatus.deduct = true;
    updateButtonSteps();

  } finally {
    if (btnDeductV2) {
      btnDeductV2.disabled = false;
      btnDeductV2.textContent = originalText;
    }
  }
}

// ============================================================
// [테이블 검색 / 정렬]
// - 이중 검색창 (AND 조건): Enter 키로 실행
// - 검색 대상: 주문번호, offer_id, 바코드, 색상, 사이즈
// ============================================================

// ---------- 정렬 상태 ----------
let currentSortMode = 'default'; // 'default' | 'option'

// 이중 필터 적용 (검색1 AND 검색2) — 메인 필터 함수
function applyTableFilter() {
  const s1 = (document.getElementById('tableSearchInput')?.value  || '').toLowerCase().trim();
  const s2 = (document.getElementById('tableSearchInput2')?.value || '').toLowerCase().trim();
  const countSpan = document.getElementById('tableSearchCount');
  const table = document.querySelector('.order-table');
  if (!table) return;

  const rows = table.querySelectorAll('tbody tr');

  // 두 검색어 모두 비어있으면 전체 표시
  if (!s1 && !s2) {
    rows.forEach(row => row.classList.remove('search-hidden'));
    if (countSpan) countSpan.textContent = '';
    updateHeaderCheckbox();
    return;
  }

  let visibleCount = 0;

  rows.forEach(row => {
    // data-index로 orders 배열 참조 (정렬 후에도 정확한 매핑)
    const idx = parseInt(row.dataset.index ?? -1);
    const order = orders[idx];
    if (!order) { row.classList.add('search-hidden'); return; }

    // 검색 대상 필드 (주문번호, offer_id, 바코드, 색상, 사이즈, 상품명, 옵션명)
    const fields = [
      order.orderNo,
      order.dbData?.['1688_offer_id'],
      order.dbData?.barcode,
      order.color,
      order.size,
      order.dbData?.item_name,   // 상품명 검색 추가
      order.dbData?.option_name, // 옵션명 검색 추가
    ].map(v => (v || '').toLowerCase());

    const matchS1 = !s1 || fields.some(f => f.includes(s1));
    const matchS2 = !s2 || fields.some(f => f.includes(s2));
    const matched = matchS1 && matchS2;

    row.classList.toggle('search-hidden', !matched);
    if (matched) visibleCount++;
  });

  if (countSpan) countSpan.textContent = `${visibleCount} / ${rows.length}건`;

  // 필터 변경 후 주황색 네비게이션 카운트 갱신
  updateOrangeNav();

  // 헤더 체크박스 상태를 현재 보이는 행 기준으로 갱신
  updateHeaderCheckbox();
}

// 하위 호환 래퍼 (기존 호출부 유지용)
function filterOrderTable(searchText) {
  const input = document.getElementById('tableSearchInput');
  if (input) input.value = searchText || '';
  applyTableFilter();
}

// 검색 초기화 (두 창 모두)
function clearTableSearch() {
  const i1 = document.getElementById('tableSearchInput');
  const i2 = document.getElementById('tableSearchInput2');
  if (i1) i1.value = '';
  if (i2) i2.value = '';
  applyTableFilter();
}

// offer_id / barcode 클릭 시 검색창1에 입력 후 필터 실행
function searchByValue(value) {
  if (!value) return;
  const input = document.getElementById('tableSearchInput');
  if (input) {
    input.value = value;
    applyTableFilter();
    input.focus();
  }
}

// 테이블 정렬 (드롭박스 onchange)
function sortOrderTable(mode) {
  currentSortMode = mode;
  const tbody = document.querySelector('.order-table tbody');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));

  if (mode === 'default') {
    // 원본 삽입 순서 (data-index 기준 오름차순)
    rows.sort((a, b) => parseInt(a.dataset.index || 0) - parseInt(b.dataset.index || 0));
  } else if (mode === 'option') {
    // 색상 오름차순 → 같으면 사이즈 오름차순
    rows.sort((a, b) => {
      const oa = orders[parseInt(a.dataset.index || 0)];
      const ob = orders[parseInt(b.dataset.index || 0)];
      const colorA = (oa?.color || '').toLowerCase();
      const colorB = (ob?.color || '').toLowerCase();
      const sizeA  = (oa?.size  || '').toLowerCase();
      const sizeB  = (ob?.size  || '').toLowerCase();
      return colorA.localeCompare(colorB) || sizeA.localeCompare(sizeB);
    });
  }

  rows.forEach(row => tbody.appendChild(row));

  // 정렬 후 현재 검색 필터 재적용
  applyTableFilter();
}
