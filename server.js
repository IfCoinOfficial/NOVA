import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: true, credentials: false, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'x-admin-key'] }));
app.use(express.json());

const CMC_API_KEY = process.env.CMC_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'your-secure-admin-key-change-this';
const PORT = process.env.PORT || 3001;
const PRICES_FILE = path.join(__dirname, 'prices.json');

let cachedPolPrice = 0.182;
let lastPolFetchTime = 0;
const POL_CACHE_DURATION = 30 * 60 * 1000;
const NOVA_PRICE = 0.00007;

const DEFAULT_PRICES_USD = {
  passes: { basic: 8, premium: 15, ultimate: 22 },
  cores: {
    boost: {
      0: 5, 1: 8, 2: 10, 3: 12, 4: 14, 5: 16, 6: 18, 7: 21, 8: 24, 9: 27,
      10: 30, 11: 35, 12: 40, 13: 45, 14: 50, 15: 60, 16: 65, 17: 70, 18: 75, 19: 80,
      20: 85, 21: 90, 22: 95, 23: 100, 24: 110, 25: 120, 26: 130, 27: 140, 28: 150, 29: 200
    },
    nft: 5,
    point: 20
  }
};

function calculateWei(usdAmount, tokenPrice) {
  const WEI = BigInt(10) ** BigInt(18);
  const usdBig = BigInt(Math.round(usdAmount * 1_000_000));
  const priceBig = BigInt(Math.round(tokenPrice * 1_000_000));
  const result = (usdBig * WEI) / priceBig;
  return result.toString();
}

function convertPricesUsdToWei(pricesUsd, polPrice = cachedPolPrice) {
  const out = {};
  for (const [category, items] of Object.entries(pricesUsd)) {
    out[category] = {};
    for (const [k, v] of Object.entries(items)) {
      if (typeof v === 'object' && v !== null) {
        out[category][k] = {};
        for (const [idx, usd] of Object.entries(v)) {
          out[category][k][idx] = {
            polWei: calculateWei(Number(usd), polPrice),
            novaWei: calculateWei(Number(usd), NOVA_PRICE)
          };
        }
      } else {
        out[category][k] = {
          polWei: calculateWei(Number(v), polPrice),
          novaWei: calculateWei(Number(v), NOVA_PRICE)
        };
      }
    }
  }
  return out;
}

const DEFAULT_PRICES = convertPricesUsdToWei(DEFAULT_PRICES_USD, cachedPolPrice);

function initPricesFile() {
  if (!fs.existsSync(PRICES_FILE)) {
    fs.writeFileSync(PRICES_FILE, JSON.stringify(DEFAULT_PRICES, null, 2));
  }
}

function readPrices() {
  try {
    if (fs.existsSync(PRICES_FILE)) {
      return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
    }
  } catch {}
  return DEFAULT_PRICES;
}

function savePrices(prices) {
  fs.writeFileSync(PRICES_FILE, JSON.stringify(prices, null, 2));
}

function authenticateAdminKey(req, res, next) {
  const providedKey = req.headers['x-admin-key'];
  if (!providedKey || providedKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized', timestamp: new Date().toISOString() });
  }
  next();
}

initPricesFile();

app.get('/api/prices/pol', async (req, res) => {
  try {
    const now = Date.now();
    if (now - lastPolFetchTime < POL_CACHE_DURATION) {
      return res.json({ price: cachedPolPrice, timestamp: new Date().toISOString(), cached: true });
    }
    if (!CMC_API_KEY) {
      return res.json({ price: cachedPolPrice, warning: 'no_api_key', cached: true });
    }
    const r = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD', {
      headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' }
    });
    const p = r.data?.data?.POL?.quote?.USD?.price;
    if (typeof p === 'number' && isFinite(p) && p > 0) {
      cachedPolPrice = p;
      lastPolFetchTime = now;
    }
    return res.json({ price: cachedPolPrice, timestamp: new Date().toISOString(), cached: false });
  } catch (e) {
    return res.json({ price: cachedPolPrice, error: String(e?.message || e), timestamp: new Date().toISOString() });
  }
});

app.get('/api/prices/all', (req, res) => {
  try {
    const prices = readPrices();
    res.json(prices);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), prices: DEFAULT_PRICES });
  }
});

app.get('/api/prices/passes', (req, res) => {
  try {
    const prices = readPrices();
    res.json(prices.passes);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), passes: DEFAULT_PRICES.passes });
  }
});

app.get('/api/prices/passes/nova-only', (req, res) => {
  try {
    const prices = readPrices();
    const out = {};
    for (const [k, v] of Object.entries(prices.passes || {})) {
      out[k] = { novaWei: v.novaWei };
    }
    res.json(out);
  } catch (e) {
    const fallback = {};
    for (const [k, v] of Object.entries(DEFAULT_PRICES.passes)) {
      fallback[k] = { novaWei: v.novaWei };
    }
    res.status(500).json({ error: String(e?.message || e), passes: fallback });
  }
});

app.get('/api/prices/cores', (req, res) => {
  try {
    const prices = readPrices();
    res.json(prices.cores);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), cores: DEFAULT_PRICES.cores });
  }
});

app.post('/api/prices/passes', authenticateAdminKey, async (req, res) => {
  try {
    const { basic, premium, ultimate } = req.body || {};
    if (basic === undefined || premium === undefined || ultimate === undefined) {
      return res.status(400).json({ error: 'missing_fields', required: ['basic', 'premium', 'ultimate'] });
    }
    let polPrice = cachedPolPrice;
    try {
      if (CMC_API_KEY) {
        const r = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD', {
          headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' }
        });
        const p = r.data?.data?.POL?.quote?.USD?.price;
        if (typeof p === 'number' && isFinite(p) && p > 0) polPrice = p;
      }
    } catch {}
    const passesUsd = { basic: Number(basic), premium: Number(premium), ultimate: Number(ultimate) };
    const converted = convertPricesUsdToWei({ passes: passesUsd }, polPrice).passes;
    const prices = readPrices();
    prices.passes = converted;
    savePrices(prices);
    res.json({ success: true, prices: prices.passes, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/prices/cores', authenticateAdminKey, async (req, res) => {
  try {
    const { boost, nft, point } = req.body || {};
    if (boost === undefined || nft === undefined || point === undefined) {
      return res.status(400).json({ error: 'missing_fields', required: ['boost(object)', 'nft', 'point'] });
    }
    if (typeof boost !== 'object' || boost === null || Array.isArray(boost)) {
      return res.status(400).json({ error: 'boost_must_be_object' });
    }
    let polPrice = cachedPolPrice;
    try {
      if (CMC_API_KEY) {
        const r = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD', {
          headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' }
        });
        const p = r.data?.data?.POL?.quote?.USD?.price;
        if (typeof p === 'number' && isFinite(p) && p > 0) polPrice = p;
      }
    } catch {}
    const normalizedBoost = {};
    for (const [k, v] of Object.entries(boost)) normalizedBoost[k] = Number(v);
    const coresUsd = { boost: normalizedBoost, nft: Number(nft), point: Number(point) };
    const converted = convertPricesUsdToWei({ cores: coresUsd }, polPrice).cores;
    const prices = readPrices();
    prices.cores = converted;
    savePrices(prices);
    res.json({ success: true, prices: prices.cores, boostTiers: Object.keys(normalizedBoost).length, polRate: polPrice, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/prices/reset', authenticateAdminKey, (req, res) => {
  try {
    savePrices(DEFAULT_PRICES);
    res.json({ success: true, prices: DEFAULT_PRICES, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    polCacheDuration: `${Math.max(0, Math.round((POL_CACHE_DURATION - (Date.now() - lastPolFetchTime)) / 60000))}m`,
    cachedPolPrice,
    novaPrice: NOVA_PRICE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log('======================================================');
  console.log('NOVA Price Proxy Server Running');
  console.log('======================================================');
  console.log(`URL: http://0.0.0.0:${PORT}`);
  console.log(`Prices File: ${PRICES_FILE}`);
  console.log(`CMC API: ${CMC_API_KEY ? 'ON' : 'OFF'}`);
  console.log(`Admin Key: ${ADMIN_API_KEY ? 'SET' : 'DEFAULT'}`);
  console.log(`POL Cache: 30m`);
  console.log(`NOVA USD: $${NOVA_PRICE}`);
  console.log('Endpoints:');
  console.log('GET  /api/prices/pol');
  console.log('GET  /api/prices/all');
  console.log('GET  /api/prices/passes');
  console.log('GET  /api/prices/passes/nova-only');
  console.log('GET  /api/prices/cores');
  console.log('POST /api/prices/passes   (x-admin-key)');
  console.log('POST /api/prices/cores    (x-admin-key)');
  console.log('POST /api/prices/reset    (x-admin-key)');
  console.log('GET  /health');
  console.log('======================================================');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// 🔄 서버 시작 1초 후 POL → USDT 시세 자동 조회
setTimeout(async () => {
  try {
    console.log('\n🔍 [STARTUP] POL → USDT 시세 자동 조회 중...\n');

    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const quoteUrl = `${baseUrl}/swap/quote?tokenIn=0x0000000000000000000000000000000000001010&tokenOut=0xc2132d05d31c914a87c6611c10748aeb04b58e8f&amountIn=1000000000000000000&slippage=0.5`;
    
    console.log(`   📍 요청 URL: ${quoteUrl}`);
    console.log(`   📍 BASE_URL: ${baseUrl}`);
    console.log(`   📍 PORT: ${PORT}`);
    console.log(`   📍 CMC_API_KEY: ${CMC_API_KEY ? '✅ SET' : '❌ NOT SET'}`);

    const response = await axios.get(quoteUrl);

    console.log(`   ✅ HTTP 상태: ${response.status}`);
    console.log(`   ✅ 응답 데이터:`, JSON.stringify(response.data, null, 2));

    if (response.data.route === 'UNISWAP_V3' && response.data.amountOut) {

      const usdtAmount = (BigInt(response.data.amountOut) / BigInt(1_000_000)).toString();

      console.log(`\n💰 [PRICE] 1 POL = ${usdtAmount} USDT`);

      console.log(`📊 가격 영향: ${response.data.priceImpact}%`);

      console.log(`🛣️  경로: ${response.data.bestPath}\n`);

    } else {

      console.log(`\n⚠️  가격 조회 실패 - Route: ${response.data?.route || 'unknown'}\n`);

    }

  } catch (e) {

    console.log(`\n❌ [ERROR] 시작 가격 조회 오류`);
    console.log(`   📍 에러 메시지: ${e.message}`);
    
    // axios 에러인 경우
    if (e.response) {
      console.log(`   🔴 HTTP 상태코드: ${e.response.status}`);
      console.log(`   🔴 응답 데이터:`, JSON.stringify(e.response.data, null, 2));
      console.log(`   🔴 응답 헤더:`, JSON.stringify(e.response.headers, null, 2));
    } else if (e.request) {
      console.log(`   🔴 요청은 전송되었으나 응답 없음`);
      console.log(`   🔴 요청 정보:`, e.request);
    } else {
      console.log(`   🔴 요청 설정 중 오류`);
    }
    
    console.log(`   📍 스택 트레이스:`, e.stack);
    console.log(`   ⏰ 타임스탬프: ${new Date().toISOString()}\n`);

  }

}, 1000);

// ===============================================================

// 🔄 Uniswap 스왑 API (QuoterV2 + AlphaRouter 통합 안정화 버전)

// ===============================================================

import { ethers } from "ethers";

import JSBI from "jsbi";

import sorPkg from "@uniswap/smart-order-router";

const { AlphaRouter, ChainId } = sorPkg;

// 🔧 CommonJS 호환성 처리 (@uniswap/sdk-core는 CommonJS 모듈)
import sdkCorePkg from "@uniswap/sdk-core";

const { Token, CurrencyAmount, TradeType, Percent, SwapType } = sdkCorePkg;

// POLYGON RPC

const POLYGON_RPC = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";

const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);

// 라우터 생성

const router = new AlphaRouter({

  chainId: 137,

  provider,

});

// QuoterV2 (멀티홉 지원) - fs로 JSON 로드 (Node 25 호환)

let QuoterABI;

try {

  const quoterPath = path.join(process.cwd(), "node_modules/@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");

  QuoterABI = JSON.parse(fs.readFileSync(quoterPath, "utf8"));

} catch (error) {

  console.error("QuoterV2 ABI 로드 실패:", error.message);

  QuoterABI = { abi: [] };

}

const QUOTER_V2 = "0x61fFE014bA1793bC6C236E6bF60A4e37fE404E38";

const quoter = new ethers.Contract(QUOTER_V2, QuoterABI.abi, provider);

// NOVA 주소

const NOVA = {

  address: "0x6bB838eb66BD035149019083fc6Cc84Ea327Eb99".toLowerCase(),

};

// 미리 정의된 토큰 목록

const KNOWN_TOKENS = {

  "0x0000000000000000000000000000000000001010": {

    symbol: "POL",

    decimals: 18,

    name: "Polygon",

  },

  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F": {

    symbol: "USDT",

    decimals: 6,

    name: "Tether USD",

  },

  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {

    symbol: "WETH",

    decimals: 18,

    name: "Wrapped Ether",

  },

  "0x6bB838eb66BD035149019083fc6Cc84Ea327Eb99": {

    symbol: "NOVA",

    decimals: 18,

    name: "NOVA Token",

  },

};

// decimals 조회용 ABI

const ERC20_ABI = ["function decimals() view returns (uint8)"];

// 동적 토큰 생성

async function getToken(addr) {

  const a = addr.toLowerCase();

  if (KNOWN_TOKENS[a]) {

    const info = KNOWN_TOKENS[a];

    return new Token(137, a, info.decimals, info.symbol, info.name);

  }

  try {

    const c = new ethers.Contract(a, ERC20_ABI, provider);

    const decimals = await c.decimals();

    return new Token(137, a, decimals, `TOKEN_${a.slice(2, 8)}`, "Token");

  } catch (e) {

    throw new Error(`Invalid token: ${addr}, ${e.message}`);

  }

}

// ---------------------------------------------------------------

// GET /swap/quote

// ---------------------------------------------------------------

app.get("/swap/quote", async (req, res) => {

  try {

    let { tokenIn, tokenOut, amountIn, slippage = "0.5" } = req.query;

    console.log(`\n📡 [/swap/quote] 요청 수신`);
    console.log(`   📍 tokenIn: ${tokenIn}`);
    console.log(`   📍 tokenOut: ${tokenOut}`);
    console.log(`   📍 amountIn: ${amountIn}`);
    console.log(`   📍 slippage: ${slippage}`);

    if (!tokenIn || !tokenOut || !amountIn) {

      console.log(`   ❌ 필수 파라미터 누락`);
      return res.status(400).json({

        error: "missing_parameters",

        required: ["tokenIn", "tokenOut", "amountIn"],

      });

    }

    console.log(

      `   ✅ 파라미터 검증 완료: ${tokenIn} → ${tokenOut}, amount: ${amountIn}`

    );

    // NOVA 커스텀 경로 제외

    if (

      tokenIn.toLowerCase() === NOVA.address ||

      tokenOut.toLowerCase() === NOVA.address

    ) {

      return res.json({

        route: "NOVA_CUSTOM_CONTRACT",

        message: "NOVA는 커스텀 라우팅을 사용합니다",

      });

    }

    const amountJSBI = JSBI.BigInt(amountIn.toString());

    const tokenA = await getToken(tokenIn);

    const tokenB = await getToken(tokenOut);

    // ------------------------------

    // 🔥 Step1: AlphaRouter 시도

    // ------------------------------

    const options = {

      recipient: "0x0000000000000000000000000000000000000000",

      slippageTolerance: new Percent(

        JSBI.BigInt(Math.round(parseFloat(slippage) * 100)),

        JSBI.BigInt(10000)

      ),

      deadline: Math.floor(Date.now() / 1000) + 1800,

      type: SwapType.SWAP_ROUTER_02,

    };

    const alphaRoute = await router.route(

      CurrencyAmount.fromRawAmount(tokenA, amountJSBI),

      tokenB,

      TradeType.EXACT_INPUT,

      options

    );

    // AlphaRouter 성공 → 사용

    if (alphaRoute && alphaRoute.trade) {

      const trade = alphaRoute.trade;

      const amountOut = trade.outputAmount.quotient.toString();

      const priceImpact = trade.priceImpact

        ? parseFloat(trade.priceImpact.toSignificant(4)) * 100

        : 0;

      let path = "unknown";

      try {

        const r = trade.swaps[0].route.path;

        path = r.map((t) => t.symbol ?? t.address).join("→");

      } catch {}

      return res.json({

        route: "UNISWAP_V3",

        amountOut,

        minimumAmountOut: amountOut,

        priceImpact,

        executionPrice: trade.executionPrice

          ? trade.executionPrice.toSignificant(6)

          : "0",

        bestPath: path,

        timestamp: new Date().toISOString(),

      });

    }

    // ------------------------------

    // 🔥 Step2: QuoterV2 fallback (멀티홉 강제)

    // ------------------------------

    const quote = await quoter.callStatic.quoteExactInputSingle({

      tokenIn,

      tokenOut,

      amountIn,

      fee: 3000,

      sqrtPriceLimitX96: 0,

    });

    // 🔧 표준 반환값 처리 (QuoterV2 docs 기준)
    // Returns: (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    const amountOut = quote[0];
    const sqrtPriceX96After = quote[1];
    const initializedTicksCrossed = quote[2];
    const gasEstimate = quote[3];

    const out = amountOut.toString();

    console.log(`   ✅ QuoterV2 응답 (표준 처리)`);
    console.log(`      - amountOut: ${out}`);
    console.log(`      - sqrtPriceX96After: ${sqrtPriceX96After.toString()}`);
    console.log(`      - initializedTicksCrossed: ${initializedTicksCrossed}`);
    console.log(`      - gasEstimate: ${gasEstimate.toString()}`);

    return res.json({

      route: "UNISWAP_QUOTER_V2",

      amountOut: out,

      minimumAmountOut: out,

      priceImpact: 0,

      executionPrice: "0",

      bestPath: "QuoterV2(single)",

      gasEstimate: gasEstimate.toString(),

      timestamp: new Date().toISOString(),

    });

  } catch (e) {

    console.log(`\n❌ [SWAP QUOTE ERROR] 상세 진단`);
    console.log(`   📍 에러 메시지: ${e.message}`);
    console.log(`   📍 에러 타입: ${e.constructor.name}`);
    console.log(`   📍 스택 트레이스:\n${e.stack}`);
    
    // RPC 오류인지 확인
    if (e.message.includes('JsonRpcProvider') || e.message.includes('RPC')) {
      console.log(`   🔴 RPC 연결 오류 - POLYGON_RPC_URL 확인 필요`);
      console.log(`   📍 RPC URL: ${POLYGON_RPC}`);
    }
    
    // Token 조회 오류
    if (e.message.includes('Invalid token')) {
      console.log(`   🔴 토큰 주소 오류 또는 존재하지 않음`);
    }

    return res.status(500).json({ error: "quote_failed", details: e.message, timestamp: new Date().toISOString() });

  }

});

// ---------------------------------------------------------------

// POST /swap/execute

// ---------------------------------------------------------------

app.post("/swap/execute", async (req, res) => {

  try {

    const { tokenIn, tokenOut, amountIn, userAddress, slippage = 0.5 } =

      req.body;

    if (!tokenIn || !tokenOut || !amountIn || !userAddress) {

      return res.status(400).json({

        error: "missing_parameters",

        required: ["tokenIn", "tokenOut", "amountIn", "userAddress"],

      });

    }

    // NOVA → 커스텀 라우터 필요

    if (

      tokenIn.toLowerCase() === NOVA.address ||

      tokenOut.toLowerCase() === NOVA.address

    ) {

      return res.json({

        route: "NOVA_CUSTOM_CONTRACT",

        status: "custom_contract_required",

      });

    }

    const tokenA = await getToken(tokenIn);

    const tokenB = await getToken(tokenOut);

    const amountJSBI = JSBI.BigInt(amountIn.toString());

    const alphaRoute = await router.route(

      CurrencyAmount.fromRawAmount(tokenA, amountJSBI),

      tokenB,

      TradeType.EXACT_INPUT,

      {

        recipient: userAddress,

        slippageTolerance: new Percent(

          JSBI.BigInt(Math.round(slippage * 100)),

          JSBI.BigInt(10000)

        ),

        deadline: Math.floor(Date.now() / 1000) + 1800,

      }

    );

    if (!alphaRoute || !alphaRoute.methodParameters) {

      return res.status(400).json({

        error: "execution_data_failed",

      });

    }

    return res.json({

      route: "UNISWAP_V3",

      status: "ready_to_sign",

      txData: {

        to: alphaRoute.methodParameters.to,

        from: userAddress,

        data: alphaRoute.methodParameters.calldata,

        value: alphaRoute.methodParameters.value,

      },

    });

  } catch (e) {

    console.log("[SWAP EXECUTE ERROR]", e);

    return res.status(500).json({

      error: "execution_failed",

      details: e.message,

    });

  }

});

