// bot.js
// بوت تداول Binance Futures - استراتيجية EMA200 + BB + RSI + ADX + EMA50 يومي
// وقف ATR (1.5x بحد أقصى 1%)، هدف 1:3
// يعمل على Node.js (Fly.io / VPS)

const crypto = require('crypto');
const https = require('https');

// ==================== CONFIG ====================
const CONFIG = {
  SYMBOLS: [
    "XRPUSDT", "BTCUSDT", "ETHUSDT", "SUIUSDT", "ADAUSDT",
    "DOGEUSDT", "LTCUSDT", "UNIUSDT", "INJUSDT", "SOLUSDT"
  ],
  RISK_PERCENT: 5,
  MAX_OPEN_TRADES: 1,
  COOLDOWN_AFTER_LOSSES: 4,
  COOLDOWN_BARS: 40,
  SCAN_INTERVAL_MINUTES: 15,
  EMA_PERIOD: 200,
  BB_PERIOD: 20,
  RSI_PERIOD: 14,
  FIXED_TARGET_R: 3,
  MAX_STOP_PERCENT: 1,
  ADX_PERIOD: 14,
  ADX_MIN: 25,
  ATR_PERIOD: 14,
  ATR_STOP_MULT: 1.5,
  DAILY_EMA50: 50,
};

// ⚠️ استبدل هذه القيم بمفاتيح API الحقيقية
const API_KEY = 'YOUR_API_KEY';
const API_SECRET = 'YOUR_API_SECRET';
const BASE_URL = 'https://fapi.binance.com';

// ==================== STATE ====================
let openTrades = {};
let smartState = {};
let scanIndex = 0;
let dailyCache = { data: {}, timestamp: 0 };

// ==================== UTILS ====================
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function buildQuery(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function binanceRequest(endpoint, params = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const qp = { ...params, timestamp: ts, recvWindow: 10000 };
    const queryString = buildQuery(qp);
    const signature = hmacSha256(API_SECRET, queryString);
    const fullUrl = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

    const options = {
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    };

    const req = https.request(fullUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.substring(0, 100)}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (method === 'POST' && Object.keys(params).length > 0) {
      req.write(queryString);
    }
    req.end();
  });
}

function fetchKlines(symbol, interval, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const candles = JSON.parse(data).map(c => ({
            time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5]
          }));
          resolve(candles);
        } else {
          reject(new Error('Klines fail'));
        }
      });
    }).on('error', reject);
  });
}

function roundToTick(price, tickSize, dir) {
  const prec = (tickSize.toString().split('.')[1] || '').length;
  let r;
  if (dir === 'up') r = Math.ceil(price / tickSize) * tickSize;
  else if (dir === 'down') r = Math.floor(price / tickSize) * tickSize;
  else r = Math.round(price / tickSize) * tickSize;
  return parseFloat(r.toFixed(prec));
}

// ==================== INDICATORS ====================
function calcEMA(data, period) {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}
function calcSMA(values, period) {
  if (values.length < period) return 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}
function calcADX(candles, period) {
  if (candles.length < period * 2) return 0;
  let trSum = 0, plusDMSum = 0, minusDMSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low;
    const pH = candles[i - 1].high, pL = candles[i - 1].low, pC = candles[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pC), Math.abs(l - pC));
    const upMove = h - pH, downMove = pL - l;
    trSum += tr;
    if (upMove > downMove && upMove > 0) plusDMSum += upMove;
    if (downMove > upMove && downMove > 0) minusDMSum += downMove;
  }
  const atr = trSum / period;
  const plusDI = (plusDMSum / period / atr) * 100;
  const minusDI = (minusDMSum / period / atr) * 100;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
}
function calcATR(candles, period, index) {
  if (index < period) return 0;
  let trSum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const h = candles[i].high, l = candles[i].low, prevClose = candles[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trSum += tr;
  }
  return trSum / period;
}
function getDailyBias(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < CONFIG.DAILY_EMA50) return null;
  const closes = dailyCandles.map(c => c.close);
  const ema50 = calcEMA(closes, CONFIG.DAILY_EMA50);
  if (!ema50) return null;
  return closes[closes.length - 1] > ema50 ? 'ABOVE' : 'BELOW';
}

function getSymbolState(sym) {
  if (!smartState[sym]) {
    smartState[sym] = { cooldownUntil: 0, watchMode: false, pendingTrade: false, consecutiveLosses: 0 };
  }
  return smartState[sym];
}

// ==================== CORE ====================
async function placeAlgoOrder(sym, side, type, triggerPrice, qty) {
  const orderSide = (side === 'LONG' && type === 'STOP_MARKET') ||
                    (side === 'SHORT' && type === 'TAKE_PROFIT_MARKET') ? 'SELL' : 'BUY';
  try {
    const result = await binanceRequest('/fapi/v1/algoOrder', {
      symbol: sym, side: orderSide, type, algoType: 'CONDITIONAL',
      triggerPrice: String(triggerPrice), quantity: String(qty),
      reduceOnly: 'true', timeInForce: 'GTE_GTC', workingType: 'CONTRACT_PRICE'
    }, 'POST');
    console.log(`✅ ${type} @ ${triggerPrice} (ID: ${result.algoId})`);
    return { success: true, algoId: result.algoId };
  } catch (e) {
    if (e.message.includes('-4130')) { console.log(`⚠️ ${type} موجود`); return { success: true, algoId: null }; }
    console.error(`❌ ${type}: ${e.message}`);
    return { success: false, algoId: null };
  }
}

async function openMarketOrder(sig) {
  try {
    const balances = await binanceRequest('/fapi/v2/balance');
    const usdt = balances.find(b => b.asset === 'USDT');
    if (!usdt) return console.log('❌ فشل جلب الرصيد');
    const availableBalance = parseFloat(usdt.availableBalance);

    let riskAmt = availableBalance * (CONFIG.RISK_PERCENT / 100);
    let qty = riskAmt / sig.riskDist;

    const side = sig.dir === 'LONG' ? 'BUY' : 'SELL';
    const order = await binanceRequest('/fapi/v1/order', {
      symbol: sig.sym, side, type: 'MARKET', quantity: String(qty), newOrderRespType: 'RESULT'
    }, 'POST');

    const executedQty = parseFloat(order.executedQty || 0);
    if (executedQty <= 0) return console.log('❌ أمر السوق لم ينفذ');

    const avgPrice = parseFloat(order.avgPrice || order.cummulativeQuoteQty / executedQty);
    console.log(`✅ صفقة: ${sig.dir} ${sig.sym} @ ${avgPrice}`);

    const actualRiskDist = sig.riskDist;
    const targetPrice = sig.dir === 'LONG'
      ? avgPrice + CONFIG.FIXED_TARGET_R * actualRiskDist
      : avgPrice - CONFIG.FIXED_TARGET_R * actualRiskDist;

    const slRounded = roundToTick(sig.stop, 0.01, sig.dir === 'LONG' ? 'down' : 'up');
    const tpRounded = roundToTick(targetPrice, 0.01, sig.dir === 'LONG' ? 'down' : 'up');

    const slResult = await placeAlgoOrder(sig.sym, sig.dir, 'STOP_MARKET', slRounded, executedQty);
    const tpResult = await placeAlgoOrder(sig.sym, sig.dir, 'TAKE_PROFIT_MARKET', tpRounded, executedQty);

    openTrades[sig.sym] = {
      symbol: sig.sym, side: sig.dir, entryPrice: avgPrice, qty: executedQty,
      stopPrice: slRounded, targetPrice: tpRounded, riskDist: actualRiskDist,
      slAlgoId: slResult.algoId, tpAlgoId: tpResult.algoId,
      slPlaced: slResult.success, tpPlaced: tpResult.success,
    };
  } catch (e) {
    console.error('❌ فشل فتح الصفقة:', e.message);
  }
}

async function manageOpenPositions() {
  console.log('🔄 إدارة المراكز...');
  try {
    const posArr = await binanceRequest('/fapi/v2/positionRisk');
    const activePositions = posArr.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
    const algoOrders = await binanceRequest('/fapi/v1/openAlgoOrders');

    console.log(`   المراكز النشطة: ${activePositions.length}, المخزنة: ${Object.keys(openTrades).length}`);

    for (const sym of Object.keys(openTrades)) {
      if (!activePositions.find(p => p.symbol === sym)) {
        console.log(`🔴 صفقة مغلقة: ${sym}`);
        const symAlgos = algoOrders.filter(o => o.symbol === sym);
        for (const o of symAlgos) {
          try { await binanceRequest('/fapi/v1/algoOrder', { symbol: sym, algoId: o.algoId }, 'DELETE'); } catch (e) {}
        }

        const closedTrade = openTrades[sym];
        const isProfit = closedTrade.side === 'LONG'
          ? (closedTrade.exitPrice || 0) > closedTrade.entryPrice
          : (closedTrade.exitPrice || 0) < closedTrade.entryPrice;

        const symState = getSymbolState(sym);
        if (!isProfit) {
          symState.consecutiveLosses = (symState.consecutiveLosses || 0) + 1;
          if (symState.consecutiveLosses >= CONFIG.COOLDOWN_AFTER_LOSSES) {
            symState.cooldownUntil = Date.now() + CONFIG.COOLDOWN_BARS * 15 * 60 * 1000;
          }
        } else {
          symState.consecutiveLosses = 0;
        }
        delete openTrades[sym];
      }
    }

    for (const pos of activePositions) {
      const sym = pos.symbol;
      const qty = Math.abs(parseFloat(pos.positionAmt));
      const entryPrice = parseFloat(pos.entryPrice);
      const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
      let trade = openTrades[sym];

      if (!trade || !trade.stopPrice || !trade.targetPrice) {
        const defaultStop = side === 'LONG' ? entryPrice * 0.99 : entryPrice * 1.01;
        const defaultRisk = Math.abs(entryPrice - defaultStop);
        const defaultTarget = side === 'LONG'
          ? entryPrice + CONFIG.FIXED_TARGET_R * defaultRisk
          : entryPrice - CONFIG.FIXED_TARGET_R * defaultRisk;
        trade = { symbol: sym, side, entryPrice, qty, stopPrice: defaultStop, targetPrice: defaultTarget, riskDist: defaultRisk, slAlgoId: null, tpAlgoId: null, slPlaced: false, tpPlaced: false };
        openTrades[sym] = trade;
      }

      const slExists = trade.slAlgoId && algoOrders.some(o => o.algoId === trade.slAlgoId);
      const tpExists = trade.tpAlgoId && algoOrders.some(o => o.algoId === trade.tpAlgoId);

      if (!slExists || !tpExists) {
        console.log(`🔄 إصلاح أوامر ${sym}`);
        const symAlgos = algoOrders.filter(o => o.symbol === sym);
        for (const o of symAlgos) {
          try { await binanceRequest('/fapi/v1/algoOrder', { symbol: sym, algoId: o.algoId }, 'DELETE'); } catch (e) {}
        }

        const slRounded = roundToTick(trade.stopPrice, 0.01, side === 'LONG' ? 'down' : 'up');
        const tpRounded = roundToTick(trade.targetPrice, 0.01, side === 'LONG' ? 'down' : 'up');

        const slResult = await placeAlgoOrder(sym, side, 'STOP_MARKET', slRounded, qty);
        const tpResult = await placeAlgoOrder(sym, side, 'TAKE_PROFIT_MARKET', tpRounded, qty);

        trade.slAlgoId = slResult.algoId; trade.tpAlgoId = tpResult.algoId;
        trade.slPlaced = slResult.success; trade.tpPlaced = tpResult.success;
        openTrades[sym] = trade;
        console.log(`✅ تم تحديث أوامر ${sym}.`);
      } else console.log(`   أوامر ${sym} مطابقة.`);
    }
  } catch (e) {
    console.error('❌ فشل إدارة المراكز:', e.message);
  }
}

async function scanForEntry() {
  const batchSize = 4;
  let idx = scanIndex || 0;

  // تحديث جزئي للكاش اليومي (زوج واحد كل دورة)
  if (!dailyCache.timestamp || (Date.now() - dailyCache.timestamp) > 86400000) {
    if (!dailyCache.updateIndex) dailyCache.updateIndex = 0;
    if (dailyCache.updateIndex < CONFIG.SYMBOLS.length) {
      const sym = CONFIG.SYMBOLS[dailyCache.updateIndex];
      try {
        const candles = await fetchKlines(sym, '1d', 100);
        if (candles.length >= 50) dailyCache.data[sym] = candles;
      } catch (e) {}
      dailyCache.updateIndex++;
      if (dailyCache.updateIndex >= CONFIG.SYMBOLS.length) {
        dailyCache.timestamp = Date.now();
        dailyCache.updateIndex = 0;
        console.log('📅 تم تحديث الكاش اليومي بالكامل');
      }
    }
  }

  for (let i = 0; i < batchSize; i++) {
    const sym = CONFIG.SYMBOLS[(idx + i) % CONFIG.SYMBOLS.length];
    const symState = getSymbolState(sym);

    if (Date.now() < symState.cooldownUntil) continue;
    if (symState.cooldownUntil > 0 && Date.now() >= symState.cooldownUntil) {
      symState.cooldownUntil = 0;
    }

    try {
      const candles = await fetchKlines(sym, '15m', 500);
      if (candles.length < CONFIG.EMA_PERIOD + CONFIG.BB_PERIOD + 10) continue;
      const now = Date.now();
      if (candles.length > 0 && (now - candles[candles.length - 1].time) < 15 * 60 * 1000) candles.pop();

      const dailyCandles = dailyCache.data[sym];
      if (!dailyCandles) continue;
      const dailyBias = getDailyBias(dailyCandles);
      if (!dailyBias) continue;

      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const lastIdx = candles.length - 1;
      const curCandle = candles[lastIdx], prevCandle = candles[lastIdx - 1];
      if (!prevCandle) continue;

      const ema = calcEMA(closes, CONFIG.EMA_PERIOD);
      const sma = calcSMA(closes.slice(0, lastIdx + 1), CONFIG.BB_PERIOD);
      const rsi = calcRSI(closes.slice(0, lastIdx + 1), CONFIG.RSI_PERIOD);
      const adx = calcADX(candles, CONFIG.ADX_PERIOD);
      if (adx < CONFIG.ADX_MIN) continue;

      if (closes[lastIdx - 1] > ema && prevCandle.close <= sma && rsi >= 35 && rsi <= 50 && curCandle.close > curCandle.open && dailyBias === 'ABOVE') {
        const entry = curCandle.close;
        const atr = calcATR(candles, CONFIG.ATR_PERIOD, lastIdx);
        if (atr <= 0) continue;
        let stopDist = atr * CONFIG.ATR_STOP_MULT;
        const maxDist = entry * (CONFIG.MAX_STOP_PERCENT / 100);
        if (stopDist > maxDist) stopDist = maxDist;
        if (stopDist <= 0) continue;
        console.log(`💡 إشارة شراء على ${sym} (ADX=${adx.toFixed(1)})`);
        return { sym, dir: 'LONG', entry, stop: entry - stopDist, riskDist: stopDist };
      }
      else if (closes[lastIdx - 1] < ema && prevCandle.close >= sma && rsi >= 50 && rsi <= 65 && curCandle.close < curCandle.open && dailyBias === 'BELOW') {
        const entry = curCandle.close;
        const atr = calcATR(candles, CONFIG.ATR_PERIOD, lastIdx);
        if (atr <= 0) continue;
        let stopDist = atr * CONFIG.ATR_STOP_MULT;
        const maxDist = entry * (CONFIG.MAX_STOP_PERCENT / 100);
        if (stopDist > maxDist) stopDist = maxDist;
        if (stopDist <= 0) continue;
        console.log(`💡 إشارة بيع على ${sym} (ADX=${adx.toFixed(1)})`);
        return { sym, dir: 'SHORT', entry, stop: entry + stopDist, riskDist: stopDist };
      }
    } catch (e) { console.error(`Scan error ${sym}: ${e.message}`); }
  }

  scanIndex = (idx + batchSize) % CONFIG.SYMBOLS.length;
  return null;
}

async function tick() {
  console.log(`⏰ ${new Date().toISOString()} - بدء دورة`);
  try {
    await manageOpenPositions();

    const currentMinute = new Date().getMinutes();
    const shouldScan = currentMinute % CONFIG.SCAN_INTERVAL_MINUTES === 0;
    const busySlots = Object.keys(openTrades).length;

    if (shouldScan && busySlots < CONFIG.MAX_OPEN_TRADES) {
      const signal = await scanForEntry();
      if (signal) await openMarketOrder(signal);
      else console.log('⛔ لا إشارة');
    } else {
      console.log('⏭️ تخطي الفحص');
    }
  } catch (e) {
    console.error('❌ خطأ:', e.message);
  }
  console.log('✅ انتهت الدورة');
}

// ==================== تشغيل ====================
console.log('🚀 بوت التداول يعمل...');
tick();
setInterval(tick, 5 * 60 * 1000); // كل 5 دقائق