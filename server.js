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
  passes: { basic: 50, premium: 150, ultimate: 300 },
  cores: {
    boost: {
      0: 5, 1: 8, 2: 10, 3: 12, 4: 14, 5: 16, 6: 18, 7: 21, 8: 24, 9: 27,
      10: 30, 11: 35, 12: 40, 13: 45, 14: 50, 15: 60, 16: 70, 17: 80, 18: 90, 19: 100,
      20: 120, 21: 150, 22: 180, 23: 210, 24: 250, 25: 300, 26: 350, 27: 400, 28: 450, 29: 500
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

// ============================================
// 🔄 Uniswap 스왑 API 추가 (아래에 덧붙임)
// ============================================

import { ethers } from 'ethers';
import { AlphaRouter } from '@uniswap/smart-order-router';
import { Token, CurrencyAmount, TradeType } from '@uniswap/sdk-core';

const POLYGON_RPC = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
const router = new AlphaRouter({ chainId: 137, provider });

const POL = new Token(137, '0x0000000000000000000000000000000000001010', 18, 'POL', 'Polygon');
const WETH = new Token(137, '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18, 'WETH', 'Wrapped Ether');
const USDT = new Token(137, '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 'USDT', 'Tether USD');
const NOVA = new Token(137, '0x6bB838eb66BD035149019083fc6Cc84Ea327Eb99', 18, 'NOVA', 'NOVA Token');

/**
 * GET /swap/quote
 * 쿼리: tokenIn, tokenOut, amountIn, slippage
 */
app.get('/swap/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn, slippage = '0.5' } = req.query;
    
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ 
        error: 'missing_parameters',
        required: ['tokenIn', 'tokenOut', 'amountIn']
      });
    }

    console.log(`[SWAP QUOTE] ${tokenIn} → ${tokenOut}, amount: ${amountIn}`);

    // NOVA 거래쌍 감지
    if (tokenIn.toLowerCase() === NOVA.address.toLowerCase() || 
        tokenOut.toLowerCase() === NOVA.address.toLowerCase()) {
      console.log('[SWAP QUOTE] NOVA 커스텀 컨트랙트');
      return res.json({
        route: 'NOVA_CUSTOM_CONTRACT',
        tokenIn,
        tokenOut,
        message: 'NOVA는 커스텀 컨트랙트를 사용합니다',
        timestamp: new Date().toISOString()
      });
    }

    let amountInBigInt;
    try {
      amountInBigInt = BigInt(amountIn);
    } catch (e) {
      return res.status(400).json({ 
        error: 'invalid_amount',
        details: `amountIn must be a valid BigInt string: ${e.message}`
      });
    }

    const amount = CurrencyAmount.fromRawAmount(
      tokenIn.toLowerCase() === POL.address.toLowerCase() ? POL : USDT,
      amountInBigInt
    );

    const route = await router.route(
      amount,
      tokenOut.toLowerCase() === POL.address.toLowerCase() ? POL : USDT,
      TradeType.EXACT_INPUT,
      {
        recipient: '0x0000000000000000000000000000000000000000',
        slippageTolerance: new (await import('@uniswap/sdk-core')).Percent(Math.round(parseFloat(slippage) * 100), 10000),
        deadline: Math.floor(Date.now() / 1000) + 60 * 20
      }
    );

    if (!route || !route.trade) {
      return res.status(400).json({ error: 'no_route_found' });
    }

    const outputAmount = route.trade.outputAmount.quotient.toString();
    const minimumOutput = route.trade.minimumAmountOut.quotient.toString();
    const priceImpact = parseFloat(route.trade.priceImpact.toSignificant(4)) * 100;

    res.json({
      route: 'UNISWAP_V3',
      amountOut: outputAmount,
      minimumAmountOut: minimumOutput,
      priceImpact,
      executionPrice: route.trade.executionPrice.toSignificant(6),
      bestPath: route.route.map(r => r.tokenPath.map(t => t.symbol).join('→')).join(' + '),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('[SWAP QUOTE ERROR]', e.message);
    res.status(500).json({ error: 'quote_failed', details: e.message });
  }
});

/**
 * POST /swap/execute
 * 바디: tokenIn, tokenOut, amountIn, slippage, userAddress
 */
app.post('/swap/execute', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn, slippage = 0.5, userAddress } = req.body;
    
    if (!tokenIn || !tokenOut || !amountIn || !userAddress) {
      return res.status(400).json({ 
        error: 'missing_parameters',
        required: ['tokenIn', 'tokenOut', 'amountIn', 'userAddress']
      });
    }

    console.log(`[SWAP EXECUTE] ${tokenIn} → ${tokenOut}, user: ${userAddress}`);

    // NOVA 거래쌍 감지
    if (tokenIn.toLowerCase() === NOVA.address.toLowerCase() || 
        tokenOut.toLowerCase() === NOVA.address.toLowerCase()) {
      console.log('[SWAP EXECUTE] NOVA 커스텀 컨트랙트');
      return res.json({
        route: 'NOVA_CUSTOM_CONTRACT',
        status: 'custom_contract_required',
        timestamp: new Date().toISOString()
      });
    }

    let amountInBigInt;
    try {
      amountInBigInt = BigInt(amountIn);
    } catch (e) {
      return res.status(400).json({ 
        error: 'invalid_amount',
        details: `amountIn must be a valid BigInt string: ${e.message}`
      });
    }

    const amount = CurrencyAmount.fromRawAmount(
      tokenIn.toLowerCase() === POL.address.toLowerCase() ? POL : USDT,
      amountInBigInt
    );

    const route = await router.route(
      amount,
      tokenOut.toLowerCase() === POL.address.toLowerCase() ? POL : USDT,
      TradeType.EXACT_INPUT,
      {
        recipient: userAddress,
        slippageTolerance: new (await import('@uniswap/sdk-core')).Percent(Math.round(slippage * 100), 10000),
        deadline: Math.floor(Date.now() / 1000) + 60 * 20
      }
    );

    if (!route || !route.methodParameters) {
      return res.status(400).json({ error: 'execution_data_generation_failed' });
    }

    res.json({
      route: 'UNISWAP_V3',
      status: 'ready_to_sign',
      txData: {
        to: route.methodParameters.to,
        from: userAddress,
        data: route.methodParameters.calldata,
        value: route.methodParameters.value,
        gasEstimate: route.gasPriceWei ? route.gasPriceWei.toString() : '0'
      },
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('[SWAP EXECUTE ERROR]', e.message);
    res.status(500).json({ error: 'execution_failed', details: e.message });
  }
});

