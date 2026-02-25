console.log('=== renderer.js 로드 완료 ===');

let orders = [];
let isProcessing = false;  // 주문 진행 중 플래그
let unmatchedExcelData = [];  // 매칭되지 않은 엑셀 데이터
let isDataSaved = true;  // 데이터 저장 여부 플래그
let pendingAction = null;  // 대기 중인 액션 ('refresh' 또는 'close')

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

// 버튼 상태 업데이트
function updateButtonSteps() {
  const btnSave = document.getElementById('btnSave');
  const btnSkip = document.getElementById('btnSkip');
  const btnStart = document.getElementById('btnStart');
  const btnReview = document.getElementById('btnReview');
  const btnRefCode = document.getElementById('btnRefCode');
  const btnOrderNumber = document.getElementById('btnOrderNumber');
  const btnSaveSupabase = document.getElementById('btnSaveSupabase');
  const btnDeduct = document.getElementById('btnDeduct');
  const btnExportSuccess = document.getElementById('btnExportSuccess');
  const btnExportFail = document.getElementById('btnExportFail');

  // 모든 버튼에서 상태 클래스 제거
  const allBtns = [btnSave, btnSkip, btnStart, btnReview, btnRefCode, btnOrderNumber, btnSaveSupabase, btnDeduct, btnExportSuccess, btnExportFail];
  allBtns.forEach(btn => {
    if (btn) {
      btn.classList.remove('completed', 'next', 'active');
    }
  });

  // 단계별 상태 적용
  if (stepStatus.parse) {
    btnSave.classList.add('completed');
    // 다음 단계 표시
    if (!stepStatus.order) {
      btnSkip.classList.add('next');
      btnStart.classList.add('next');
    }
  } else {
    btnSave.classList.add('next');
  }

  if (stepStatus.order) {
    btnSkip.classList.add('completed');
    btnStart.classList.add('completed');
    if (!stepStatus.review) {
      btnReview.classList.add('next');
    }
  }

  if (stepStatus.review) {
    btnReview.classList.add('completed');
    if (!stepStatus.refCode) {
      btnRefCode.classList.add('next');
    }
  }

  if (stepStatus.refCode) {
    btnRefCode.classList.add('completed');
    if (!stepStatus.orderNumber) {
      btnOrderNumber.classList.add('next');
    }
  }

  if (stepStatus.orderNumber) {
    btnOrderNumber.classList.add('completed');
    if (!stepStatus.save) {
      btnSaveSupabase.classList.add('next');
    }
  }

  if (stepStatus.save) {
    btnSaveSupabase.classList.add('completed');
    if (!stepStatus.deduct) {
      btnDeduct.classList.add('next');
    }
  }

  if (stepStatus.deduct) {
    btnDeduct.classList.add('completed');
    if (!stepStatus.success && !stepStatus.fail) {
      btnExportSuccess.classList.add('next');
      btnExportFail.classList.add('next');
    }
  }

  if (stepStatus.success) {
    btnExportSuccess.classList.add('completed');
  }

  if (stepStatus.fail) {
    btnExportFail.classList.add('completed');
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
    const AD_COL = 29;
    const G_COL = 6;
    const I_COL = 8;

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

    // G열과 I열 합계 계산 (병합 셀: 첫 번째 행에서만 값 가져오기)
    let delivery_fee = 0;
    let total_I = 0;

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

    // 대표 주문코드 (첫 번째 코드 사용)
    const orderCode = Array.from(excelOrderCodes)[0];

    // Supabase에 저장
    await saveDeductTransaction({
      order_code: orderCode,
      delivery_fee: delivery_fee,
      price: price,
      service_fee: service_fee,
      amount: amount
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
    date: dateStr
  };

  console.log('=== 차감 트랜잭션 저장 ===');
  console.log('저장할 데이터:', transactionData);

  try {
    const { data, error } = await supabaseClient
      .from('invoiceManager_transactions')
      .insert([transactionData])
      .select();

    if (error) {
      console.error('차감 저장 오류:', error);
      alert(`차감 저장 실패: ${error.message}`);
      return;
    }

    console.log('✓ 차감 저장 완료:', data);

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

// users_api 데이터 저장
let usersApiData = [];

// Supabase 클라이언트 초기화 (페이지 로드 후)
window.addEventListener('DOMContentLoaded', () => {
  if (window.api && window.supabase) {
    const SUPABASE_URL = window.api.getEnv('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = window.api.getEnv('SUPABASE_SERVICE_ROLE_KEY');

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      console.log('✓ Supabase 클라이언트 초기화 완료');

      // users_api 데이터 로드
      loadUsersApi();
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

// 사용자 드롭박스 채우기
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

// 사용자 선택 여부에 따라 데이터 입력 활성화/비활성화
function updateDataInputState() {
  const select = document.getElementById('userSelect');
  const dataInput = document.getElementById('dataInput');
  const btnSave = document.getElementById('btnSave');

  if (!select || !dataInput) return;

  const isUserSelected = select.value !== '';

  if (isUserSelected) {
    dataInput.disabled = false;
    dataInput.style.opacity = '1';
    dataInput.placeholder = '구글 시트에서 행 전체를 선택하고 복사(Ctrl+C) 후 여기에 붙여넣기(Ctrl+V)';
    if (btnSave) btnSave.disabled = false;
  } else {
    dataInput.disabled = true;
    dataInput.style.opacity = '0.5';
    dataInput.placeholder = '먼저 위에서 사용자를 선택해주세요';
    if (btnSave) btnSave.disabled = true;
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

// 대기 중인 액션 실행
function executePendingAction() {
  if (pendingAction === 'refresh') {
    location.reload();
  }
  pendingAction = null;
}

// 데이터 파싱
function parseData() {
  console.log('parseData 함수 호출됨');
  const input = document.getElementById('dataInput').value.trim();

  if (!input) {
    alert('데이터를 입력해주세요.');
    return;
  }

  const lines = input.split('\n').filter(line => line.trim());
  orders = [];

  for (const line of lines) {
    // 탭으로 구분 (구글 시트에서 복사하면 탭으로 구분됨)
    const parts = line.split('\t');

    // 최소 12개 컬럼 필요 (A~L까지)
    if (parts.length >= 12) {
      const orderNo = parts[1].trim();    // B열: 주문번호
      const quantity = parseInt(parts[4]) || 1;  // E열: 수량
      const color = parts[6].trim();      // G열: 색상옵션 (china_option1)
      const size = parts[7].trim();       // H열: 사이즈옵션 (china_option2)
      let url = parts[11].trim();         // L열: site_url

      // URL 정리: https://detail.1688.com으로 시작하면 offer/{id}.html까지만 추출
      if (url.startsWith('https://detail.1688.com')) {
        const match = url.match(/https:\/\/detail\.1688\.com\/offer\/\d+\.html/);
        if (match) {
          url = match[0] + '?';
        }
      }

      // offer_id 추출
      const offerIdMatch = url.match(/offer\/(\d+)\.html/);
      const offerId = offerIdMatch ? offerIdMatch[1] : null;

      if (orderNo && color && size && url) {
        orders.push({
          // 화면 표시용 (기존 필드 유지)
          orderNo,          // B열
          quantity,         // E열
          color,            // G열
          size,             // H열
          url,              // L열
          orderCode: parts[18] ? parts[18].trim() : '',  // S열
          status: 'pending',
          errorReason: '',

          // Supabase 저장용 전체 데이터
          dbData: {
            date: new Date().toISOString(),                             // 현재 시간 자동 입력
            order_number: parts[1] ? parts[1].trim() : null,            // B열
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
            order_code: parts[18] ? parts[18].trim() : null,            // S열
            shipment_code: parts[19] ? parts[19].trim() : null,         // T열
            option_id: parts[20] ? parts[20].trim() : null,             // U열
            coupang_shipment_size: parts[21] ? parts[21].trim() : null, // V열
            composition: parts[22] ? parts[22].trim() : null,           // W열
            recomanded_age: parts[23] ? parts[23].trim() : null,        // X열
            set_total: parts[24] ? parseInt(parts[24]) : null,          // Y열
            set_seq: parts[25] ? parseInt(parts[25]) : null,            // Z열
            '1688_offer_id': offerId,                                   // URL에서 추출
            '1688_order_id': null                                       // 나중에 매칭 시 추가
          },

          // 원본 구글 시트 데이터 전체 저장 (기존 로직 호환)
          originalData: parts
        });
      }
    }
  }

  if (orders.length === 0) {
    alert('유효한 데이터가 없습니다. 형식을 확인해주세요.');
    return;
  }

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

  // 각 주문 데이터 렌더링
  orders.forEach((order, rowIdx) => {
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

    const rowBgStyle = isFailed ? 'background-color: #ffcccc;' : '';
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

// 주문 목록 렌더링
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
          <th style="width: 135px;">주문번호</th>
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
    const reasonText = order.reason || '-';

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

    // 주문번호 셀 내용 구성 (검수 후 판매자명 추가)
    let orderNoCellContent = '';
    if (order.reviewResult && order.reviewResult.cartItem && order.reviewResult.cartItem.sellerName) {
      const sellerName = order.reviewResult.cartItem.sellerName;
      orderNoCellContent = `
        <div onclick="copyToClipboard('${order.url.replace(/'/g, "\\'")}')" title="클릭하여 URL 복사" style="cursor: pointer;">
          ${order.orderNo}
        </div>
        <div onclick="event.stopPropagation(); copyToClipboard('${sellerName.replace(/'/g, "\\'")}'); event.target.style.backgroundColor='#ffffcc'; setTimeout(() => event.target.style.backgroundColor='', 200);"
             title="클릭하여 판매자명 복사"
             style="font-size: 0.85em; color: #666; cursor: pointer; margin-top: 2px;">
          ${sellerName}
        </div>
      `;
    } else {
      orderNoCellContent = `<div onclick="copyToClipboard('${order.url.replace(/'/g, "\\'")}')" title="클릭하여 URL 복사" style="cursor: pointer;">${order.orderNo}</div>`;
    }

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

    // 실패 건은 주황색 배경
    const rowStyle = isFailed ? ' style="background-color: #ffcc99;"' : '';

    html += `
      <tr${rowStyle}>
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
        <td style="text-align: center;">${order.matched ? '<span class="status-success">✅</span>' : (order.matched === false ? '<span class="status-error">❌</span>' : '-')}</td>
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
}

// 주문 진행
async function startOrders() {
  if (orders.length === 0) {
    alert('주문 목록이 없습니다.');
    return;
  }

  // 체크된 항목이 있는지 확인
  const checkedOrders = orders.filter(o => o.checked);

  // 원본 인덱스를 포함하여 전송
  const ordersToProcess = checkedOrders.length > 0
    ? checkedOrders.map(o => ({ ...o, originalIndex: orders.indexOf(o) }))
    : orders.map((o, i) => ({ ...o, originalIndex: i }));

  isProcessing = true;

  // 버튼 상태 변경
  document.getElementById('btnStart').style.display = 'none';
  document.getElementById('btnStop').style.display = 'inline-block';
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
    document.getElementById('btnStart').style.display = 'inline-block';
    document.getElementById('btnStop').style.display = 'none';
    document.getElementById('btnStart').disabled = false;
  }
}

// 주문 중단
function stopOrders() {
  if (confirm('주문 진행을 중단하시겠습니까?\n현재까지 처리된 주문은 유지됩니다.')) {
    window.api.stopProcessing();
    isProcessing = false;
  }
}

// 주문 생략 - 주문 진행 없이 바로 검수 가능하도록
function skipOrders() {
  if (orders.length === 0) {
    alert('주문 목록이 없습니다.');
    return;
  }

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

      // offer_id(Y열=24)와 1688_orderNumber(A열=0) 추출
      // A열이 병합된 경우 이전 행의 주문번호를 사용
      orderNumberData = [];
      let lastOrderNumber = ''; // 마지막으로 읽은 주문번호 저장

      rows.forEach((row, idx) => {
        const orderNumber = row[0]; // A열
        const offerId = row[24];    // Y열

        // A열에 값이 있으면 업데이트 (병합된 셀의 첫 행)
        if (orderNumber) {
          lastOrderNumber = String(orderNumber).trim();
        }

        if (idx < 3) {
          console.log(`행 ${idx + 2}: A열="${orderNumber}", Y열="${offerId}", 사용할 주문번호="${lastOrderNumber}"`);
        }

        // offer_id가 있으면 추가 (주문번호는 병합된 셀의 값 사용)
        if (offerId && lastOrderNumber) {
          orderNumberData.push({
            orderNumber: lastOrderNumber,
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

// 완료 상태 토글 함수
function toggleComplete(index) {
  if (index < orders.length) {
    // 토글: 완료 <-> 실패
    orders[index].finalComplete = !orders[index].finalComplete;
    renderOrderList();
  }
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
  customInput.value = '';
  customInput.disabled = true;

  // 기존 사유가 있으면 해당 버튼 선택
  if (order.reason) {
    const reasonBtn = document.querySelector(`.modal-btn[data-reason="${order.reason}"]`);
    if (reasonBtn) {
      reasonBtn.classList.add('selected');
    } else if (order.reasonType === 'custom') {
      // 직접 입력인 경우
      document.getElementById('btnCustomReason').classList.add('selected');
      customInput.disabled = false;
      customInput.value = order.reason;
    }
  }

  modal.classList.add('active');
}

// 사유 모달 닫기
function closeReasonModal() {
  const modal = document.getElementById('reasonModal');
  modal.classList.remove('active');
  currentReasonIndex = -1;
}

// 사유 선택 처리
function selectReason(reason, isCustom = false) {
  if (currentReasonIndex >= 0 && currentReasonIndex < orders.length) {
    orders[currentReasonIndex].reason = reason;
    orders[currentReasonIndex].reasonType = isCustom ? 'custom' : 'preset';
    renderOrderList();
  }
  closeReasonModal();
}

// 사유 지우기
function clearReason() {
  if (currentReasonIndex >= 0 && currentReasonIndex < orders.length) {
    orders[currentReasonIndex].reason = '';
    orders[currentReasonIndex].reasonType = '';
    renderOrderList();
  }
  closeReasonModal();
}

// 모달 이벤트 초기화
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('reasonModal');
  const customInput = document.getElementById('customReasonInput');

  // 모달 외부 클릭 시 닫기 (직접 입력 값 저장)
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      // 직접 입력 모드이고 값이 있으면 저장
      if (!customInput.disabled && customInput.value.trim()) {
        selectReason(customInput.value.trim(), true);
      } else {
        closeReasonModal();
      }
    }
  });

  // 사유 버튼 클릭
  document.querySelectorAll('.modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const reason = btn.dataset.reason;

      // 모든 버튼 선택 해제
      document.querySelectorAll('.modal-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      if (reason === '직접입력') {
        // 직접 입력 활성화
        customInput.disabled = false;
        customInput.focus();
      } else {
        // 프리셋 선택 - 바로 적용
        customInput.disabled = true;
        customInput.value = '';
        selectReason(reason, false);
      }
    });
  });

  // 입력 필드에서 Enter 키 누르면 저장
  customInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && customInput.value.trim()) {
      selectReason(customInput.value.trim(), true);
    }
  });
});

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

        // china_total_price를 먼저 저장
        if (cartItem.subtotal !== undefined) {
          orders[index].dbData.china_total_price = parseFloat(cartItem.subtotal.toFixed(2));

          // china_price는 china_total_price / order_qty로 계산
          const orderQty = orders[index].dbData.order_qty || orders[index].quantity || 1;
          orders[index].dbData.china_price = parseFloat((cartItem.subtotal / orderQty).toFixed(2));
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

  // 주문 목록 컨테이너 아래에 추가
  const orderListContainer = document.getElementById('orderListContent');
  if (orderListContainer && orderListContainer.parentNode) {
    orderListContainer.parentNode.insertBefore(warning, orderListContainer.nextSibling);
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

// 전체 체크박스 토글
function toggleAllCheckboxes(headerCheckbox) {
  const checkboxes = document.querySelectorAll('.row-checkbox');
  checkboxes.forEach(cb => {
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

// 헤더 체크박스 상태 업데이트
function updateHeaderCheckbox() {
  const allCheckboxes = document.querySelectorAll('.row-checkbox');
  const headerCheckbox = document.querySelector('thead input[type="checkbox"]');
  if (headerCheckbox) {
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    const someChecked = Array.from(allCheckboxes).some(cb => cb.checked);
    headerCheckbox.checked = allChecked;
    headerCheckbox.indeterminate = someChecked && !allChecked;
  }
}

// 체크박스 변경 이벤트 리스너 (이벤트 위임)
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('row-checkbox')) {
    const index = parseInt(e.target.dataset.index);
    orders[index].checked = e.target.checked;

    // 헤더 체크박스 상태 업데이트
    const allCheckboxes = document.querySelectorAll('.row-checkbox');
    const headerCheckbox = document.querySelector('thead input[type="checkbox"]');
    if (headerCheckbox) {
      const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
      const someChecked = Array.from(allCheckboxes).some(cb => cb.checked);
      headerCheckbox.checked = allChecked;
      headerCheckbox.indeterminate = someChecked && !allChecked;
    }
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

      return order.dbData;
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

// ========== 테이블 검색 기능 ==========

// 테이블 필터링 함수
function filterOrderTable(searchText) {
  const searchLower = searchText.toLowerCase().trim();
  const countSpan = document.getElementById('tableSearchCount');
  const table = document.querySelector('.order-table');

  if (!table) {
    countSpan.textContent = '';
    return;
  }

  const rows = table.querySelectorAll('tbody tr');

  if (!searchLower) {
    // 검색어가 없으면 모든 행 표시
    rows.forEach(row => row.classList.remove('search-hidden'));
    countSpan.textContent = '';
    return;
  }

  let visibleCount = 0;
  let totalCount = rows.length;

  rows.forEach((row, index) => {
    const order = orders[index];
    if (!order) {
      row.classList.add('search-hidden');
      return;
    }

    // 주문번호 검색
    const orderNo = (order.orderNo || '').toLowerCase();

    // 판매자명 검색 (카트 데이터에서)
    let sellerName = '';
    if (order.reviewResult && order.reviewResult.cartItem && order.reviewResult.cartItem.sellerName) {
      sellerName = order.reviewResult.cartItem.sellerName.toLowerCase();
    }

    // 주문번호 또는 판매자명에 검색어가 포함되면 표시
    if (orderNo.includes(searchLower) || sellerName.includes(searchLower)) {
      row.classList.remove('search-hidden');
      visibleCount++;
    } else {
      row.classList.add('search-hidden');
    }
  });

  countSpan.textContent = `${visibleCount} / ${totalCount}건`;
}

// 테이블 검색 초기화
function clearTableSearch() {
  const searchInput = document.getElementById('tableSearchInput');
  const countSpan = document.getElementById('tableSearchCount');
  const table = document.querySelector('.order-table');

  if (searchInput) {
    searchInput.value = '';
  }

  if (countSpan) {
    countSpan.textContent = '';
  }

  if (table) {
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(row => row.classList.remove('search-hidden'));
  }
}
