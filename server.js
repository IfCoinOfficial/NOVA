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
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'your-secure-admin-key-change-this';  // 👈 여기 수정!
const PORT = process.env.PORT || 3001;

// 가격 저장 파일 경로
const PRICES_FILE = path.join(__dirname, 'prices.json');

// ============ POL 가격 캐싱 (30분 주기) ============
let cachedPolPrice = 0.45;
let lastPolFetchTime = 0;
const POL_CACHE_DURATION = 30 * 60 * 1000;  // 30분

// 기본 가격
const DEFAULT_PRICES = {
  passes: {
    basic: 50,      // USDT
    premium: 150,   // USDT
    ultimate: 300   // USDT
  },
  cores: {
    boost: 1,       // USDT
    nft: 2,         // USDT
    point: 3        // USDT
  },
  novaPrice: 0.00007  // 고정
};

// ============ 파일 관리 함수 ============

// 가격 파일 초기화
function initPricesFile() {
  if (!fs.existsSync(PRICES_FILE)) {
    fs.writeFileSync(PRICES_FILE, JSON.stringify(DEFAULT_PRICES, null, 2));
    console.log('✅ prices.json 파일 생성됨');
  }
}

// 저장된 가격 읽기
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

// 가격 저장
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

// 초기화
initPricesFile();

// ============ API 엔드포인트 ============

/**
 * 1️⃣ POL 가격 프록시 (CoinMarketCap API - 30분 캐싱)
 * 누구나 접근 가능 (GET만 허용)
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
    
    cachedPolPrice = response.data.data?.POL?.quote?.USD?.price || 0.45;
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
    console.log('✅ 모든 가격 조회:', prices);
    
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
 * 3️⃣ 패스 가격 업데이트 (관리자만 - API 키 필수)
 */
app.post('/api/prices/passes', authenticateAdminKey, (req, res) => {
  try {
    const { basic, premium, ultimate } = req.body;
    
    if (basic === undefined || premium === undefined || ultimate === undefined) {
      return res.status(400).json({ 
        error: '모든 가격(basic, premium, ultimate)을 입력해주세요',
        received: req.body
      });
    }
    
    const prices = readPrices();
    prices.passes = { 
      basic: parseFloat(basic), 
      premium: parseFloat(premium), 
      ultimate: parseFloat(ultimate) 
    };
    savePrices(prices);
    
    console.log('✅ 패스 가격 업데이트:', prices.passes);
    res.json({ 
      success: true, 
      prices: prices.passes,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 패스 가격 업데이트 실패:', error.message);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

/**
 * 4️⃣ 코어 가격 업데이트 (관리자만 - API 키 필수)
 */
app.post('/api/prices/cores', authenticateAdminKey, (req, res) => {
  try {
    const { boost, nft, point } = req.body;
    
    if (boost === undefined || nft === undefined || point === undefined) {
      return res.status(400).json({ 
        error: '모든 가격(boost, nft, point)을 입력해주세요',
        received: req.body
      });
    }
    
    const prices = readPrices();
    prices.cores = { 
      boost: parseFloat(boost), 
      nft: parseFloat(nft), 
      point: parseFloat(point) 
    };
    savePrices(prices);
    
    console.log('✅ 코어 가격 업데이트:', prices.cores);
    res.json({ 
      success: true, 
      prices: prices.cores,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 코어 가격 업데이트 실패:', error.message);
    res.status(500).json({ 
      error: error.message 
    });
  }
});

/**
 * 5️⃣ 가격 초기화 (관리자만 - API 키 필수)
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
    res.status(500).json({ 
      error: error.message 
    });
  }
});

/**
 * 헬스 체크
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    polCacheDuration: `${Math.round((POL_CACHE_DURATION - (Date.now() - lastPolFetchTime)) / 60000)}분 남음`,
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
  console.log('='.repeat(70));
  console.log('\n📋 사용 가능한 엔드포인트:');
  console.log(`  GET  https://nova-sfyz.onrender.com/api/prices/pol       - POL 실시간 가격 (30분 캐시, 인증 불필요)`);
  console.log(`  GET  https://nova-sfyz.onrender.com/api/prices/all       - 모든 가격 조회 (인증 불필요)`);
  console.log(`  POST https://nova-sfyz.onrender.com/api/prices/passes    - 패스 가격 업데이트 (🔐 API 키 필수)`);
  console.log(`  POST https://nova-sfyz.onrender.com/api/prices/cores     - 코어 가격 업데이트 (🔐 API 키 필수)`);
  console.log(`  POST https://nova-sfyz.onrender.com/api/prices/reset     - 기본값으로 초기화 (🔐 API 키 필수)`);
  console.log(`  GET  https://nova-sfyz.onrender.com/health               - 헬스 체크`);
  console.log('\n🔐 POST 요청 시 헤더에 다음을 추가:');
  console.log(`  Header: x-admin-key: ${ADMIN_API_KEY}`);
  console.log('\n');
});

// 에러 처리
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
