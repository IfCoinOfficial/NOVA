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

const PRICES_FILE = path.join(__dirname, 'prices.json');

const DEFAULT_PRICES = {
  passes: {
    basic: 50,
    premium: 150,
    ultimate: 300
  },
  cores: {
    boost: 1,
    nft: 2,
    point: 3
  },
  novaPrice: 0.00007
};

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
  } catch (error) {
    console.error('Error reading prices:', error.message);
  }
  return DEFAULT_PRICES;
}

function savePrices(prices) {
  try {
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices, null, 2));
  } catch (error) {
    console.error('Error saving prices:', error.message);
  }
}

initPricesFile();

app.get('/api/prices/pol', async (req, res) => {
  try {
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=POL&convert=USD',
      {
        headers: {
          'X-CMC_PRO_API_KEY': 'e4e8b247c32b4d56a7759f9691f197f7'
        }
      }
    );
    
    const polPrice = response.data.data?.POL?.quote?.USD?.price || 0.45;
    res.json({ price: polPrice });
  } catch (error) {
    console.error('POL Price Error:', error.message);
    res.json({ price: 0.45, error: error.message });
  }
});

app.get('/api/prices/all', (req, res) => {
  const prices = readPrices();
  res.json(prices);
});

app.post('/api/prices/passes', (req, res) => {
  const { basic, premium, ultimate } = req.body;
  
  if (!basic || !premium || !ultimate) {
    return res.status(400).json({ error: '모든 가격을 입력해주세요' });
  }
  
  const prices = readPrices();
  prices.passes = { basic, premium, ultimate };
  savePrices(prices);
  
  res.json({ success: true, prices: prices.passes });
});

app.post('/api/prices/cores', (req, res) => {
  const { boost, nft, point } = req.body;
  
  if (!boost || !nft || !point) {
    return res.status(400).json({ error: '모든 가격을 입력해주세요' });
  }
  
  const prices = readPrices();
  prices.cores = { boost, nft, point };
  savePrices(prices);
  
  res.json({ success: true, prices: prices.cores });
});

app.post('/api/prices/reset', (req, res) => {
  savePrices(DEFAULT_PRICES);
  res.json({ success: true, prices: DEFAULT_PRICES });
});

app.listen(3001, () => {
  console.log('✅ Proxy server running on http://localhost:3001');
});
