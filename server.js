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
const PORT = process.env.PORT || 3001;

// 가격 저장 파일 경로
const PRICES_FILE = path.join(__dirname, 'prices.json');

// 기본 가격
const DEFAULT_PRICES = {
  passes: {
    basic: 10,      // USDT
    premium: 15,   // USDT
    ultimate: 22   // USDT
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

// 초기화
initPricesFile();

// ============ API 엔드포인트 ============

/**
 * 1️⃣ POL 가격 프록시 (CoinMarketCap API)
 */
app.get('/api/prices/pol', async (req, res) => {
  try {
    if (!CMC_API_KEY) {
      console.warn('⚠️ CMC_API_KEY 환경변수가 설정되지 않았습니다');
      return res.json({ price: 0.45, warning: 'API key not configured' });
    }

    console.log('🔄 CoinMarketCap에서 POL 가격 조회 중...');
    
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD',
      {
        headers: {
          'X-CMC_PRO_API_KEY': CMC_API_KEY,
          'Accept': 'application/json'
        }
      }
    );
    
    const polPrice = response.data.data?.POL?.quote?.USD?.price || 0.45;
    console.log(`✅ POL 가격: $${polPrice}`);
    
    res.json({ 
      price: polPrice,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ POL 가격 조회 실패:', error.message);
    res.json({ 
      price: 0.45, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * 2️⃣ 모든 가격 조회 (앱용)
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
 * 3️⃣ 패스 가격 업데이트
 */
app.post('/api/prices/passes', (req, res) => {
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
 * 4️⃣ 코어 가격 업데이트
 */
app.post('/api/prices/cores', (req, res) => {
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
 * 5️⃣ 가격 초기화
 */
app.post('/api/prices/reset', (req, res) => {
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
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============ 서버 시작 ============

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('✅ NOVA 가격 프록시 서버 실행 중');
  console.log('='.repeat(60));
  console.log(`🌐 서버 URL: http://localhost:${PORT}`);
  console.log(`📊 가격 파일: ${PRICES_FILE}`);
  console.log(`🔑 CMC API: ${CMC_API_KEY ? '✅ 설정됨' : '⚠️ 설정 안 됨'}`);
  console.log('='.repeat(60));
  console.log('\n📋 사용 가능한 엔드포인트:');
  console.log(`  GET  /api/prices/pol       - POL 실시간 가격`);
  console.log(`  GET  /api/prices/all       - 모든 가격 조회`);
  console.log(`  POST /api/prices/passes    - 패스 가격 업데이트`);
  console.log(`  POST /api/prices/cores     - 코어 가격 업데이트`);
  console.log(`  POST /api/prices/reset     - 기본값으로 초기화`);
  console.log(`  GET  /health               - 헬스 체크`);
  console.log('\n');
});

// 에러 처리
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
