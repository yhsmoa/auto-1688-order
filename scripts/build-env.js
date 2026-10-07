// ════════════════════════════════════════════════════════════
// 빌드 전 .env 검사 + 설치 파일용 .env 생성  (build / build:dir / publish 앞에서 실행)
//
//  1) 필수 키가 없거나 비어 있으면 빌드를 중단한다.
//     - 설치 파일은 빌드한 PC 의 .env 를 그대로 품고 가므로, 어느 PC 에서 빌드하든
//       ORDER_PASSWORD 가 빠지면 모든 설치 PC 에서 패스워드가 통하지 않는다 (v1.0.65~66 사고).
//  2) 설치 파일(resources/.env)에는 앱 실행에 필요한 키만 담는다.
//     - GH_TOKEN(배포용), GEMINI_API_KEY 등 빌드·개발 전용 비밀은 설치 PC 에 배포하지 않는다.
//
//  출력: .build-env/.env  → package.json build.extraResources 가 이 파일을 resources/.env 로 복사
// ════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.BUILD_ENV_SRC || path.join(ROOT, '.env');   // BUILD_ENV_SRC: 테스트용 입력 경로 override
const OUT_DIR = path.join(ROOT, '.build-env');
const OUT = path.join(OUT_DIR, '.env');

// 앱 실행에 필요한 키 — 전부 필수이며, 이 키들만 설치 파일에 포함된다
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ORDER_PASSWORD'];

function parseEnv(text) {
  const map = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    map[key] = val;
  }
  return map;
}

if (!fs.existsSync(SRC)) {
  console.error(`\n[build-env] ✗ .env 파일이 없습니다: ${SRC}\n`);
  process.exit(1);
}

const env = parseEnv(fs.readFileSync(SRC, 'utf8'));
const missing = REQUIRED.filter(k => !env[k]);

if (missing.length > 0) {
  console.error('\n[build-env] ✗ 빌드 중단 — .env 에 필수 키가 없거나 비어 있습니다:');
  for (const k of missing) console.error(`    - ${k}`);
  console.error(`\n  파일: ${SRC}`);
  console.error('  위 키를 추가한 뒤 다시 빌드하세요. (예: ORDER_PASSWORD=주문탭_패스워드)');
  console.error('  ※ 이 검사가 없으면 패스워드가 빠진 설치 파일이 모든 PC 로 배포됩니다.\n');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const body = REQUIRED.map(k => `${k}=${env[k]}`).join('\n') + '\n';
fs.writeFileSync(OUT, body, 'utf8');

const excluded = Object.keys(env).filter(k => !REQUIRED.includes(k));
console.log(`[build-env] ✓ 설치 파일용 .env 생성: ${path.relative(ROOT, OUT)}`);
console.log(`[build-env]   포함: ${REQUIRED.join(', ')}`);
if (excluded.length) console.log(`[build-env]   제외(빌드/개발 전용): ${excluded.join(', ')}`);
