import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// ============ 환경 변수 설정 ============
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'your-secure-admin-key-change-this';
const PORT = process.env.PORT || 3001;

// 가격 저장 파일 경로
const PRICES_FILE = path.join(__dirname, 'prices.json');

// ============ POL 가격 캐싱 (30분 주기) ============
let cachedPolPrice = 0.182;
let lastPolFetchTime = 0;
const POL_CACHE_DURATION = 30 * 60 * 1000;  // 30분

// ============ 상수 ============
const NOVA_PRICE = 0.00007;  // 고정 (상장 전)

// 기본 가격 (USD)
const DEFAULT_PRICES_USD = {
  passes: {
    basic: 50,      // USDT
    premium: 150,   // USDT
    ultimate: 300   // USDT
  },
  cores: {
    boost: {
      // 부스트 코어 차등 가격 (0~29개)
      0: 5,
      1: 8,
      2: 10,
      3: 12,
      4: 14,
      5: 16,
      6: 18,
      7: 21,
      8: 24,
      9: 27,
      10: 30,
      11: 35,
      12: 40,
      13: 45,
      14: 50,
      15: 60,
      16: 70,
      17: 80,
      18: 90,
      19: 100,
      20: 120,
      21: 150,
      22: 180,
      23: 210,
      24: 250,
      25: 300,
      26: 350,
      27: 400,
      28: 450,
      29: 500
    },
    nft: 2,         // USDT
    point: 3        // USDT
  }
};

// USD → POL/NOVA 변환 함수
function convertPricesToTokens(pricesUsd, polPrice = cachedPolPrice) {
  const converted = {};
  
  for (const [category, items] of Object.entries(pricesUsd)) {
    converted[category] = {};
    
    if (typeof items === 'object' && items !== null) {
      for (const [key, usdAmount] of Object.entries(items)) {
        // boost가 객체(차등 가격)인 경우
        if (typeof usdAmount === 'object' && usdAmount !== null && !Array.isArray(usdAmount)) {
          converted[category][key] = {};
          for (const [idx, price] of Object.entries(usdAmount)) {
            const pol = price / polPrice;
            const nova = price / NOVA_PRICE;
            converted[category][key][idx] = { pol: pol, nova: nova };
          }
        } 
        // 단일 숫자값
        else if (typeof usdAmount === 'number') {
          const pol = usdAmount / polPrice;
          const nova = usdAmount / NOVA_PRICE;
          converted[category][key] = { pol: pol, nova: nova };
        }
      }
    }
  }
  
  return converted;
}

// 기본 가격 (변환됨)
const DEFAULT_PRICES = convertPricesToTokens(DEFAULT_PRICES_USD, cachedPolPrice);

// ============ 파일 관리 함수 ============
function initPricesFile() {
  if (!fs.existsSync(PRICES_FILE)) {
    fs.writeFileSync(PRICES_FILE, JSON.stringify(DEFAULT_PRICES, null, 2));
    console.log('✅ prices.json 파일 생성됨');
  }
}

function readPrices() {
  try {
    if (fs.existsSync(PRICES_FILE)) {
      return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('❌ 가격 파일 읽기 실패:', error.message);
  }
  return DEFAULT_PRICES;
}

function savePrices(prices) {
  try {
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices, null, 2));
    console.log('✅ 가격 저장 완료');
  } catch (error) {
    console.error('❌ 가격 저장 실패:', error.message);
  }
}

// ============ 보안: API 키 인증 미들웨어 ============
function authenticateAdminKey(req, res, next) {
  const providedKey = req.headers['x-admin-key'];
  
  if (!providedKey || providedKey !== ADMIN_API_KEY) {
    console.warn('⚠️ 미인증 요청 거부:', providedKey);
    return res.status(401).json({ 
      error: '미인증 요청입니다. x-admin-key 헤더를 확인해주세요.',
      timestamp: new Date().toISOString()
    });
  }
  
  next();
}

initPricesFile();

// ============ API 엔드포인트 ============

/**
 * 1️⃣ POL 가격 프록시 (CoinMarketCap API - 30분 캐싱)
 */
app.get('/api/prices/pol', async (req, res) => {
  try {
    const now = Date.now();
    
    // ✅ 캐시 확인: 30분 이내면 캐시된 가격 사용
    if (now - lastPolFetchTime < POL_CACHE_DURATION) {
      const remainingMinutes = Math.round((POL_CACHE_DURATION - (now - lastPolFetchTime)) / 60000);
      console.log(`💾 캐시된 POL 가격 사용: $${cachedPolPrice} (${remainingMinutes}분 후 갱신)`);
      return res.json({ 
        price: cachedPolPrice,
        timestamp: new Date().toISOString(),
        cached: true
      });
    }

    if (!CMC_API_KEY) {
      console.warn('⚠️ CMC_API_KEY 환경변수가 설정되지 않았습니다');
      return res.json({ price: cachedPolPrice, warning: 'API key not configured' });
    }

    console.log('🔄 CoinMarketCap에서 POL 가격 신규 조회 중...');
    
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD',
      {
        headers: {
          'X-CMC_PRO_API_KEY': CMC_API_KEY,
          'Accept': 'application/json'
        }
      }
    );
    
    cachedPolPrice = response.data.data?.POL?.quote?.USD?.price || 0.182;
    lastPolFetchTime = now;
    
    console.log(`✅ POL 가격 신규 업데이트: $${cachedPolPrice}`);
    
    res.json({ 
      price: cachedPolPrice,
      timestamp: new Date().toISOString(),
      cached: false
    });
  } catch (error) {
    console.error('❌ POL 가격 조회 실패:', error.message);
    res.json({ 
      price: cachedPolPrice,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * 2️⃣ 모든 가격 조회 (앱용, 누구나 접근)
 */
app.get('/api/prices/all', (req, res) => {
  try {
    const prices = readPrices();
    console.log('✅ 모든 가격 조회');
    res.json(prices);
  } catch (error) {
    console.error('❌ 가격 조회 실패:', error.message);
    res.status(500).json({ 
      error: error.message,
      prices: DEFAULT_PRICES
    });
  }
});

/**
 * 3️⃣ 패스 가격 조회 (누구나 접근) - 앱용 GET
 * 반환: { basic: {pol: X, nova: Y}, premium: {pol: X, nova: Y}, ... }
 */
app.get('/api/prices/passes', (req, res) => {
  try {
    const prices = readPrices();
    console.log('✅ 패스 가격 조회');
    res.json(prices.passes);
  } catch (error) {
    console.error('❌ 패스 가격 조회 실패:', error.message);
    res.status(500).json({ 
      error: error.message,
      passes: DEFAULT_PRICES.passes
    });
  }
});

/**
 * 4️⃣ 코어 가격 조회 (누구나 접근) - 앱용 GET
 * 반환: { boost: {pol: X, nova: Y} 또는 {0: {pol, nova}, 1: {pol, nova}, ...}, nft: {pol, nova}, ... }
 */
app.get('/api/prices/cores', (req, res) => {
  try {
    const prices = readPrices();
    console.log('✅ 코어 가격 조회');
    res.json(prices.cores);
  } catch (error) {
    console.error('❌ 코어 가격 조회 실패:', error.message);
    res.status(500).json({ 
      error: error.message,
      cores: DEFAULT_PRICES.cores
    });
  }
});

/**
 * 5️⃣ 패스 가격 업데이트 (관리자만 - API 키 필수)
 * 입력: USD 값 → 서버가 POL/NOVA로 변환해서 저장
 */
app.post('/api/prices/passes', authenticateAdminKey, async (req, res) => {
  try {
    const { basic, premium, ultimate } = req.body;
    
    if (basic === undefined || premium === undefined || ultimate === undefined) {
      return res.status(400).json({ 
        error: '모든 가격(basic, premium, ultimate)을 USDT로 입력해주세요',
        received: req.body
      });
    }
    
    // POL 가격 동적으로 가져오기 (최신 환율)
    let polPrice = cachedPolPrice;
    try {
      const response = await axios.get(
        'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD',
        {
          headers: {
            'X-CMC_PRO_API_KEY': CMC_API_KEY,
            'Accept': 'application/json'
          }
        }
      );
      polPrice = response.data.data?.POL?.quote?.USD?.price || cachedPolPrice;
    } catch (error) {
      console.warn('⚠️ POL 가격 조회 실패, 캐시된 가격 사용:', cachedPolPrice);
    }
    
    // USD → POL/NOVA 변환
    const passesUsd = { basic: parseFloat(basic), premium: parseFloat(premium), ultimate: parseFloat(ultimate) };
    const convertedPasses = convertPricesToTokens({ passes: passesUsd }, polPrice).passes;
    
    const prices = readPrices();
    prices.passes = convertedPasses;
    savePrices(prices);
    
    console.log('✅ 패스 가격 업데이트:', passesUsd, '→ POL/NOVA 변환 완료');
    res.json({ 
      success: true, 
      prices: prices.passes,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 패스 가격 업데이트 실패:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 6️⃣ 코어 가격 업데이트 (관리자만 - API 키 필수)
 * 입력: USD 값 (boost는 객체) → 서버가 POL/NOVA로 변환해서 저장
 */
app.post('/api/prices/cores', authenticateAdminKey, async (req, res) => {
  try {
    const { boost, nft, point } = req.body;
    
    if (boost === undefined || nft === undefined || point === undefined) {
      return res.status(400).json({ 
        error: '모든 가격(boost 객체, nft, point)을 USDT로 입력해주세요',
        example: {
          boost: { 0: 5, 1: 10, 2: 11, "...": 38, 29: 500 },
          nft: 2,
          point: 3
        },
        received: req.body
      });
    }
    
    // boost가 객체인지 확인
    if (typeof boost !== 'object' || Array.isArray(boost)) {
      return res.status(400).json({ 
        error: 'boost는 { "0": 5, "1": 10, ... } 형식의 객체여야 합니다',
        received: typeof boost
      });
    }
    
    // POL 가격 동적으로 가져오기 (최신 환율)
    let polPrice = cachedPolPrice;
    try {
      const response = await axios.get(
        'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD',
        {
          headers: {
            'X-CMC_PRO_API_KEY': CMC_API_KEY,
            'Accept': 'application/json'
          }
        }
      );
      polPrice = response.data.data?.POL?.quote?.USD?.price || cachedPolPrice;
    } catch (error) {
      console.warn('⚠️ POL 가격 조회 실패, 캐시된 가격 사용:', cachedPolPrice);
    }
    
    // boost 가격 정규화 (문자열 → 숫자)
    const normalizedBoost = {};
    for (const [count, price] of Object.entries(boost)) {
      normalizedBoost[count] = parseFloat(price);
    }
    
    // USD → POL/NOVA 변환
    const coresUsd = { boost: normalizedBoost, nft: parseFloat(nft), point: parseFloat(point) };
    const convertedCores = convertPricesToTokens({ cores: coresUsd }, polPrice).cores;
    
    const prices = readPrices();
    prices.cores = convertedCores;
    savePrices(prices);
    
    console.log('✅ 코어 가격 업데이트 완료');
    console.log('   부스트 코어 차등 가격:', Object.keys(normalizedBoost).length + '개 단계');
    console.log('   NFT:', nft, 'USDT, 포인트:', point, 'USDT');
    console.log('   POL 환율:', polPrice);
    
    res.json({ 
      success: true, 
      prices: prices.cores,
      boostTiers: Object.keys(normalizedBoost).length,
      polRate: polPrice,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 코어 가격 업데이트 실패:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 7️⃣ 가격 초기화 (관리자만 - API 키 필수)
 */
app.post('/api/prices/reset', authenticateAdminKey, (req, res) => {
  try {
    savePrices(DEFAULT_PRICES);
    console.log('✅ 가격 초기화 완료');
    
    res.json({ 
      success: true, 
      prices: DEFAULT_PRICES,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 가격 초기화 실패:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 헬스 체크
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    polCacheDuration: `${Math.round((POL_CACHE_DURATION - (Date.now() - lastPolFetchTime)) / 60000)}분 남음`,
    cachedPolPrice: cachedPolPrice,
    novaPrice: NOVA_PRICE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============ 서버 시작 ============
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('✅ NOVA 가격 프록시 서버 실행 중');
  console.log('='.repeat(70));
  console.log(`🌐 서버 URL: https://nova-sfyz.onrender.com`);
  console.log(`📊 가격 파일: ${PRICES_FILE}`);
  console.log(`🔑 CMC API: ${CMC_API_KEY ? '✅ 설정됨' : '⚠️ 설정 안 됨'}`);
  console.log(`🔐 Admin API Key: ${ADMIN_API_KEY ? '✅ 설정됨' : '⚠️ 기본값 사용 중'}`);
  console.log(`⏱️ POL 가격 캐시 주기: 30분`);
  console.log(`💱 NOVA 고정 가격: $${NOVA_PRICE}`);
  console.log(`🎯 부스트 코어: 차등 가격 시스템 (0~29개) + 자동 POL/NOVA 변환 ⭐`);
  console.log('='.repeat(70));
  console.log('\n📋 사용 가능한 엔드포인트:');
  console.log(`  GET  /api/prices/pol       - POL 실시간 가격 (30분 캐시, 인증 불필요)`);
  console.log(`  GET  /api/prices/all       - 모든 가격 조회 (이미 POL/NOVA로 변환됨, 인증 불필요)`);
  console.log(`  GET  /api/prices/passes    - 패스 가격 조회 (POL/NOVA, 인증 불필요) ⭐`);
  console.log(`  GET  /api/prices/cores     - 코어 가격 조회 (POL/NOVA, 부스트 차등 포함, 인증 불필요) ⭐`);
  console.log(`  POST /api/prices/passes    - 패스 가격 업데이트 (USDT 입력 → POL/NOVA 자동 변환) (🔐 API 키 필수) ⭐`);
  console.log(`  POST /api/prices/cores     - 코어 가격 업데이트 (USDT 입력 → POL/NOVA 자동 변환) (🔐 API 키 필수) ⭐`);
  console.log(`  POST /api/prices/reset     - 기본값으로 초기화 (🔐 API 키 필수)`);
  console.log(`  GET  /health               - 헬스 체크`);
  console.log('\n🔐 POST 요청 시 헤더에 다음을 추가:');
  console.log(`  Header: x-admin-key: ${ADMIN_API_KEY}`);
  console.log('\n💡 부스트 코어 POST 요청 예시 (USDT로 입력):');
  console.log(`  {
    "boost": { "0": 5, "1": 8, "2": 10, ..., "29": 500 },
    "nft": 2,
    "point": 3
  }`);
  console.log('\n✅ 반환 예시 (자동으로 POL/NOVA 변환됨):');
  console.log(`  {
    "boost": {
      "0": { "pol": 27.47, "nova": 71428 },
      "1": { "pol": 43.96, "nova": 114286 },
      ...
    },
    "nft": { "pol": 10.98, "nova": 28571 },
    "point": { "pol": 16.48, "nova": 42857 }
  }`);
  console.log('\n');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
