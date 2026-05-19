// index_fvg_final.js – FVG 15m Strategy with Trailing Stop (Final Version with Low KV Usage)
const CONFIG = {
  SYMBOLS: ["BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","LINKUSDT","ADAUSDT","XRPUSDT","MATICUSDT","AVAXUSDT","DOTUSDT"],
  TREND_TF: "4h", ENTRY_TF: "15m",
  RISK_PERCENT: 10, MAX_LEVERAGE: 20,
  COOLDOWN_AFTER_LOSSES: 4, COOLDOWN_BARS: 40,
  RESET_STREAK_AFTER_COOLDOWN: 0,
  PENDING_TTL: 10,
};

const BASE_URL = 'https://fapi.binance.com';

// ==================== HMAC ====================
async function hmacSha256(key, data) {
  const enc = new TextEncoder();
  const keyData = enc.encode(key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== Binance Request ====================
async function binanceRequest(env, endpoint, params = {}, method = 'GET') {
  const apiKey = env.API_KEY, secretKey = env.API_SECRET;
  const ts = Date.now();
  const qp = new URLSearchParams({ ...params, timestamp: ts });
  qp.append('signature', await hmacSha256(secretKey, qp.toString()));
  const url = `${BASE_URL}${endpoint}?${qp.toString()}`;
  const resp = await fetch(url, { method, headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/json' } });
  if (!resp.ok) { const text = await resp.text(); throw new Error(`Binance API ${resp.status}: ${text}`); }
  return resp.json();
}

// ==================== KV Helpers ====================
async function kvGet(env, key) { const v = await env.BOT_STATE.get(key); return v ? JSON.parse(v) : null; }
async function kvSet(env, key, value, ttlSeconds = null) {
  const options = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
  await env.BOT_STATE.put(key, JSON.stringify(value), options);
}

// ==================== Klines ====================
async function fetchKlines(env, symbol, interval, limit = 100) {
  const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Klines fail');
  const data = await resp.json();
  return data.map(c => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
}

// ==================== Indicators ====================
function computeEMA(data, period) {
  if (data.length < period) return null;
  const k = 2/(period+1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = data[i]*k + ema*(1-k);
  return ema;
}

function getSwings(candles) {
  const highs = [], lows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i], p = candles[i-1], n = candles[i+1];
    if (c.high >= p.high && c.high >= n.high) highs.push({ index: i, price: c.high, time: c.time });
    if (c.low <= p.low && c.low <= n.low) lows.push({ index: i, price: c.low, time: c.time });
  }
  return { highs, lows };
}

function detectFVG(candles, i) {
  if (i < 2) return null;
  const b2 = candles[i], b0 = candles[i-2];
  // فجوة صاعدة: قاع الشمعة الأولى أعلى من قمة الشمعة الثالثة
  if (b2.low > b0.high) {
    return { type: 'bullish', high: b2.low, low: b0.high, time: b0.time, index: i };
  }
  // فجوة هابطة: قمة الشمعة الأولى أقل من قاع الشمعة الثالثة
  if (b2.high < b0.low) {
    return { type: 'bearish', high: b0.low, low: b2.high, time: b0.time, index: i };
  }
  return null;
}

function roundToTick(price, tickSize, dir) {
  const prec = (tickSize.toString().split('.')[1] || '').length;
  let r;
  if (dir === 'up') r = Math.ceil(price / tickSize) * tickSize;
  else if (dir === 'down') r = Math.floor(price / tickSize) * tickSize;
  else r = Math.round(price / tickSize) * tickSize;
  return parseFloat(r.toFixed(prec));
}

// ==================== Exchange Info ====================
async function getExchangeInfo(env) {
  let info = await kvGet(env, 'symbolsInfo');
  if (info) return info;
  const url = `${BASE_URL}/fapi/v1/exchangeInfo`;
  const resp = await fetch(url);
  const data = await resp.json();
  info = {};
  for (const sym of CONFIG.SYMBOLS) {
    const s = data.symbols.find(x => x.symbol === sym);
    if (s) info[sym] = {
      tickSize: parseFloat(s.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize),
      stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
      minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL').notional),
    };
  }
  await kvSet(env, 'symbolsInfo', info, 604800);
  return info;
}

async function getUSDTBalance(env) {
  try {
    const balances = await binanceRequest(env, '/fapi/v2/balance');
    const usdt = balances.find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.balance) : null;
  } catch (e) { console.error(e.message); return null; }
}

// ==================== Signal Scanner ====================
async function scanForEntry(env) {
  let idx = (await kvGet(env, 'scanIndex')) || 0;
  const batchSize = 3;
  for (let i = 0; i < batchSize; i++) {
    const sym = CONFIG.SYMBOLS[(idx + i) % CONFIG.SYMBOLS.length];
    try {
      const candles = await fetchKlines(env, sym, CONFIG.ENTRY_TF, 80);
      if (candles.length < 70) continue;

      const c4 = await fetchKlines(env, sym, CONFIG.TREND_TF, 60);
      if (c4.length < 50) continue;
      const ema50_4h = computeEMA(c4.map(b => b.close), 50);
      if (!ema50_4h) continue;

      const priceNow = candles[candles.length-1].close;
      const { highs, lows } = getSwings(candles);

      // LONG
      if (priceNow > ema50_4h) {
        const recentHighs = highs.filter(h => h.index <= candles.length - 4);
        if (recentHighs.length === 0) continue;
        const lastHigh = recentHighs[recentHighs.length-1];
        let mother = null;
        for (let j = lastHigh.index - 1; j >= 2; j--) {
          const f = detectFVG(candles, j);
          if (f && f.type === 'bullish') { mother = f; break; }
        }
        if (!mother) continue;
        let swept = false;
        for (let j = lastHigh.index + 1; j < candles.length; j++) {
          if (candles[j].low <= mother.low) { swept = true; break; }
        }
        if (!swept) continue;
        for (let j = candles.length-1; j >= lastHigh.index + 1; j--) {
          const nf = detectFVG(candles, j);
          if (nf && nf.type === 'bullish' && nf.index > lastHigh.index && nf.low > mother.low) {
            const entry = nf.high, stop = nf.low, riskDist = entry - stop;
            if (riskDist <= 0) continue;
            const newIdx = (idx + i + 1) % CONFIG.SYMBOLS.length;
            // كتابة فورية عند إيجاد إشارة
            await kvSet(env, 'scanIndex', newIdx);
            return { sym, dir: 'LONG', entry, stop, riskDist };
          }
        }
      }
      // SHORT
      if (priceNow < ema50_4h) {
        const recentLows = lows.filter(l => l.index <= candles.length - 4);
        if (recentLows.length === 0) continue;
        const lastLow = recentLows[recentLows.length-1];
        let mother = null;
        for (let j = lastLow.index - 1; j >= 2; j--) {
          const f = detectFVG(candles, j);
          if (f && f.type === 'bearish') { mother = f; break; }
        }
        if (!mother) continue;
        let swept = false;
        for (let j = lastLow.index + 1; j < candles.length; j++) {
          if (candles[j].high >= mother.high) { swept = true; break; }
        }
        if (!swept) continue;
        for (let j = candles.length-1; j >= lastLow.index + 1; j--) {
          const nf = detectFVG(candles, j);
          if (nf && nf.type === 'bearish' && nf.index > lastLow.index && nf.high < mother.high) {
            // تصحيح: للفجوة الهابطة، الدخول عند nf.low (القاع)، والوقف عند nf.high (القمة)
            const entry = nf.low, stop = nf.high, riskDist = stop - entry;
            if (riskDist <= 0) continue;
            const newIdx = (idx + i + 1) % CONFIG.SYMBOLS.length;
            await kvSet(env, 'scanIndex', newIdx);
            return { sym, dir: 'SHORT', entry, stop, riskDist };
          }
        }
      }
    } catch (e) {}
  }
  const newIdx = (idx + batchSize) % CONFIG.SYMBOLS.length;
  // كتابة scanIndex كل 15 دقيقة فقط (باستخدام الطابع الزمني)
  if (Math.floor(Date.now() / 60000) % 15 === 0) {
    await kvSet(env, 'scanIndex', newIdx);
  }
  return null;
}

// ==================== Open Limit Order with Immediate SL ====================
async function openLimitOrder(env, sig) {
  const info = await getExchangeInfo(env);
  const symInfo = info[sig.sym];
  if (!symInfo) throw new Error('No symbol info');
  const { tickSize, stepSize, minNotional } = symInfo;

  const balance = await getUSDTBalance(env);
  if (!balance || balance <= 0) throw new Error('Balance unavailable');

  const riskAmt = balance * (CONFIG.RISK_PERCENT / 100); // مبلغ المخاطرة (10% من الرصيد)

  // ✅ 1. الكمية التي تجعل الخسارة عند الوقف = 10% بالضبط
  let qty = riskAmt / sig.riskDist;
  
  // ✅ 2. جلب أقصى رافعة متاحة لهذا الزوج
  let symbolMaxLeverage = 50;
  try {
    const bracket = await binanceRequest(env, '/fapi/v1/leverageBracket', { symbol: sig.sym });
    if (bracket && bracket[0]) {
      symbolMaxLeverage = bracket[0].maxLeverage || 50;
    }
  } catch (e) {}

  // ✅ 3. حساب الرافعة المطلوبة لجعل سعر التصفية = سعر الوقف
  // معادلة التصفية (للشراء والبيع): riskDist = (entryPrice / leverage) - (entryPrice * mmr)
  // حيث mmr = maintenanceMarginRate (نستخدم قيمة تقريبية 0.5%)
  const mmr = 0.005;
  const requiredLeverage = sig.entry / (sig.riskDist + sig.entry * mmr);
  
  console.log(`🔍 DEBUG: requiredLeverage=${requiredLeverage.toFixed(2)}x, maxLeverage=${symbolMaxLeverage}x`);
  
  // ✅ 4. إذا كانت الرافعة المطلوبة غير متاحة، نرفض الصفقة
  if (requiredLeverage > symbolMaxLeverage) {
    console.log(`⚠️ Cannot set liquidation to stop price. Required leverage ${requiredLeverage.toFixed(1)}x exceeds max ${symbolMaxLeverage}x. Skipping.`);
    throw new Error('Leverage too high for stop=liquidation');
  }

  // ✅ 5. نستخدم الرافعة المطلوبة بالضبط
  const usedLeverage = Math.floor(requiredLeverage);
  
  // ✅ 6. ضبط الكمية لتناسب stepSize
  qty = Math.floor(qty / stepSize) * stepSize;
  
  let notional = qty * sig.entry;
  if (notional < minNotional) {
    console.log(`⚠️ Notional too low (${notional}) for ${sig.sym}. Skipping.`);
    throw new Error('Notional too low');
  }

  // ✅ 7. ضبط الرافعة والهامش
  await binanceRequest(env, '/fapi/v1/leverage', { symbol: sig.sym, leverage: usedLeverage }, 'POST');
  try { await binanceRequest(env, '/fapi/v1/marginType', { symbol: sig.sym, marginType: 'ISOLATED' }, 'POST'); } catch(e) {}

  // ✅ 8. إرسال أمر الدخول
  const side = sig.dir === 'LONG' ? 'BUY' : 'SELL';
  const order = await binanceRequest(env, '/fapi/v1/order', {
    symbol: sig.sym, side, type: 'LIMIT', price: sig.entry, quantity: qty,
    timeInForce: 'GTC', newOrderRespType: 'RESULT'
  }, 'POST');

  const executedQty = parseFloat(order.executedQty || 0);
  if (executedQty <= 0) {
    console.log(`🔵 Limit ${sig.dir} ${sig.sym} @ ${sig.entry} qty=${qty} (pending)`);
    await kvSet(env, 'pendingOrder', {
      sym: sig.sym, dir: sig.dir, entry: sig.entry, stopPrice: sig.stop,
      trailDistance: sig.riskDist, trailActive: false,
      qty, orderId: order.orderId, createdAt: Date.now()
    });
    return;
  }

  // ✅ 9. تنفيذ فوري ووضع وقف الخسارة
  const avgPrice = parseFloat(order.avgPrice || sig.entry);
  const sl = sig.stop;
  const slRound = roundToTick(sl, tickSize, sig.dir === 'LONG' ? 'down' : 'up');

  let slOrderId = null;
  try {
    const slRes = await binanceRequest(env, '/fapi/v1/algoOrder', {
      symbol: sig.sym,
      side: sig.dir === 'LONG' ? 'SELL' : 'BUY',
      type: 'STOP_MARKET', algoType: 'CONDITIONAL', triggerPrice: slRound,
      closePosition: 'true', timeInForce: 'GTC', workingType: 'CONTRACT_PRICE'
    }, 'POST');
    slOrderId = slRes.orderId;
    console.log(`✅ Initial SL placed for ${sig.sym} @ ${slRound} (ID=${slOrderId})`);
  } catch (e) {
    if (!e.message?.includes?.('-4130')) console.error('Initial SL error:', e.message);
  }

  await kvSet(env, 'currentTrade', {
    symbol: sig.sym, side: sig.dir, entryPrice: avgPrice,
    qty: executedQty, stopPrice: sl, trailDistance: sig.riskDist,
    trailActive: false, protectionPlaced: true,
    slOrderId: slOrderId,
    trailingHigh: avgPrice,
    trailingLow: avgPrice
  });
  console.log(`✅ Trade opened: ${sig.dir} ${sig.sym} @ ${avgPrice} | Initial SL=${slRound}`);
}

// ==================== Manage Open Position (Trailing Stop) ====================
async function manageOpenPosition(env) {
  const posArr = await binanceRequest(env, '/fapi/v2/positionRisk');
  const activePos = posArr.find(p => Math.abs(parseFloat(p.positionAmt)) > 0);
  if (!activePos) {
    console.log("🔴 No open position");
    // لا نكتب null إلى KV لتجنب استنزاف الكتابات
    return false;
  }

  const sym = activePos.symbol;
  const qty = Math.abs(parseFloat(activePos.positionAmt));
  const entryPrice = parseFloat(activePos.entryPrice);
  const side = parseFloat(activePos.positionAmt) > 0 ? 'LONG' : 'SHORT';
  let stored = await kvGet(env, 'currentTrade');
  
  // --- وضع الطوارئ: لا يوجد currentTrade أو لا يطابق المركز ---
  if (!stored || stored.symbol !== sym) {
    console.log("⚠️ currentTrade missing/mismatch. Reconstructing from Binance data.");
    
    // 1. جلب أمر STOP_MARKET الحالي من Binance
    let actualStop = null, actualAlgoId = null;
    try {
      const algoOrders = await binanceRequest(env, '/fapi/v1/openAlgoOrders');
      const sl = algoOrders.find(o => o.symbol === sym);
      if (sl) {
        actualStop = parseFloat(sl.triggerPrice || sl.price);
        actualAlgoId = sl.algoId || sl.orderId;
      }
    } catch (e) { console.error("openAlgoOrders error:", e.message); }
    
    // 2. إذا لم نجد أمر SL، لا يمكننا الإدارة
    if (!actualStop) {
      console.error("Cannot reconstruct: no SL order found on Binance!");
      return true;
    }
    
    // 3. حساب trailDistance بناءً على المسافة الحالية بين الدخول والوقف
    const dist = side === 'LONG' ? entryPrice - actualStop : actualStop - entryPrice;
    if (dist <= 0) {
      console.error("Cannot determine trail distance. Skipping management.");
      return true;
    }
    
    // 4. بناء كائن stored مؤقت
    stored = {
      symbol: sym,
      side,
      entryPrice,
      qty,
      stopPrice: actualStop,
      trailDistance: dist,
      trailActive: false,            // افتراض أن التتبع لم يُفعّل بعد
      protectionPlaced: true,        // لأن هناك أمر STOP_MARKET
      slOrderId: actualAlgoId,
      trailingHigh: entryPrice,      // نبدأ من سعر الدخول
      trailingLow: entryPrice
    };
    
    // 5. نخزّن هذا الكائن في KV للمرات القادمة (إن كانت الكتابة ممكنة)
    try {
      await kvSet(env, 'currentTrade', stored);
    } catch (e) {
      console.error("Could not save reconstructed currentTrade to KV:", e.message);
    }
  }

  const info = await getExchangeInfo(env);
  const tickSize = info[sym]?.tickSize || 0.01;

  let currentPrice;
  try {
    const ticker = await binanceRequest(env, '/fapi/v1/ticker/price', { symbol: sym });
    currentPrice = parseFloat(ticker.price);
  } catch (e) { console.error("Price fetch error:", e.message); return true; }

  // قراءة الوقف الفعلي من Binance
  let actualStopPrice = stored.stopPrice;
  let actualSlAlgoId = stored.slOrderId;
  try {
    const algoOrders = await binanceRequest(env, '/fapi/v1/openAlgoOrders');
    const slOrder = algoOrders.find(o => o.symbol === sym);
    if (slOrder) {
      actualStopPrice = parseFloat(slOrder.triggerPrice || slOrder.price);
      actualSlAlgoId = slOrder.algoId || slOrder.orderId;
    } else {
      actualStopPrice = null;
    }
  } catch (e) { console.error("openAlgoOrders error:", e.message); }

  if (actualStopPrice !== null && actualStopPrice !== stored.stopPrice) {
    stored.stopPrice = actualStopPrice;
    stored.slOrderId = actualSlAlgoId;
  }
  if (actualStopPrice === null) {
    console.error("No SL order found on Binance!");
    return true;
  }

  let newStop = stored.stopPrice;
  let trailActive = stored.trailActive;
  const trailDist = stored.trailDistance;

  if (stored.trailingHigh === undefined) stored.trailingHigh = entryPrice;
  if (stored.trailingLow === undefined) stored.trailingLow = entryPrice;

  if (!trailActive) {
    const activationPrice = side === 'LONG'
      ? entryPrice + trailDist
      : entryPrice - trailDist;
    if ((side === 'LONG' && currentPrice >= activationPrice) ||
        (side === 'SHORT' && currentPrice <= activationPrice)) {
      trailActive = true;
      newStop = entryPrice;
      stored.trailingHigh = currentPrice;
      stored.trailingLow = currentPrice;
      console.log(`🟢 Trailing activated for ${sym} – moved stop to entry ${entryPrice}`);
    }
  }

  if (trailActive) {
    if (side === 'LONG') {
      if (currentPrice > stored.trailingHigh) stored.trailingHigh = currentPrice;
      const potential = stored.trailingHigh - trailDist;
      if (potential > newStop) newStop = potential;
    } else {
      if (currentPrice < stored.trailingLow) stored.trailingLow = currentPrice;
      const potential = stored.trailingLow + trailDist;
      if (potential < newStop) newStop = potential;
    }
  }

  const newStopRound = roundToTick(newStop, tickSize, side === 'LONG' ? 'down' : 'up');
  const oldStopRound = roundToTick(stored.stopPrice, tickSize, side === 'LONG' ? 'down' : 'up');

  if (newStopRound !== oldStopRound) {
    if (actualSlAlgoId) {
      try {
        await binanceRequest(env, '/fapi/v1/algoOrder', { symbol: sym, algoId: actualSlAlgoId }, 'DELETE');
        console.log(`🗑️ Old SL cancelled (algoId=${actualSlAlgoId})`);
      } catch (e) { console.error("Cancel SL error:", e.message); }
    }

    let newOrderId = null;
    try {
      const newSL = await binanceRequest(env, '/fapi/v1/algoOrder', {
        symbol: sym, side: side === 'LONG' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET', algoType: 'CONDITIONAL', triggerPrice: newStopRound,
        closePosition: 'true', timeInForce: 'GTC', workingType: 'CONTRACT_PRICE'
      }, 'POST');
      newOrderId = newSL.orderId;
      console.log(`✅ SL updated for ${sym}: ${newStopRound} (${trailActive ? 'Trailing' : 'Initial'})`);
    } catch (e) {
      if (!e.message?.includes?.('-4130')) console.error('Place SL error:', e.message);
    }

    await kvSet(env, 'currentTrade', {
      ...stored,
      stopPrice: newStop,
      trailActive: trailActive,
      protectionPlaced: true,
      slOrderId: newOrderId || stored.slOrderId,
      trailingHigh: stored.trailingHigh,
      trailingLow: stored.trailingLow
    });
  } else {
    // كتابة دورية فقط كل 30 دقيقة لتحديث trailingHigh/Low
    if (Math.floor(Date.now() / 60000) % 30 === 0 || trailActive !== stored.trailActive) {
      await kvSet(env, 'currentTrade', {
        ...stored,
        stopPrice: newStop,
        trailActive: trailActive,
        protectionPlaced: true,
        slOrderId: stored.slOrderId,
        trailingHigh: stored.trailingHigh,
        trailingLow: stored.trailingLow
      });
    }
  }

  return true;
}

// ==================== Filter feasible symbols ====================
async function getFeasibleSymbols(env) {
  const balance = await getUSDTBalance(env);
  if (!balance || balance <= 0) return [];

  const info = await getExchangeInfo(env);
  const feasible = [];
  
  for (const sym of CONFIG.SYMBOLS) {
    const symInfo = info[sym];
    if (!symInfo) continue;
    
    // ✅ جلب أقصى رافعة حقيقية للزوج
    let symbolMaxLeverage = 20; // قيمة افتراضية
    try {
      const bracket = await binanceRequest(env, '/fapi/v1/leverageBracket', { symbol: sym });
      if (bracket && bracket[0] && bracket[0].brackets) {
        // أقصى رافعة هي initialLeverage لأعلى شريحة
        const lastBracket = bracket[0].brackets[bracket[0].brackets.length - 1];
        symbolMaxLeverage = lastBracket.initialLeverage || 20;
      }
    } catch (e) {
      // تجاهل واستخدم القيمة الافتراضية
    }
    
    const minBalance = symInfo.minNotional / symbolMaxLeverage;
    if (balance >= minBalance) {
      feasible.push(sym);
    }
  }
  return feasible.length > 0 ? feasible : CONFIG.SYMBOLS;
}

// ==================== Main Scheduled Handler ====================
async function handleScheduled(env) {
  try {
    // Cooldown
    let cd = (await kvGet(env, 'cooldownRemaining')) || 0;
    if (cd > 0) {
      await kvSet(env, 'cooldownRemaining', cd - 1);
      if (cd - 1 === 0 && CONFIG.RESET_STREAK_AFTER_COOLDOWN !== null) {
        await kvSet(env, 'lossStreak', CONFIG.RESET_STREAK_AFTER_COOLDOWN);
      }
      return;
    }

    const pending = await kvGet(env, 'pendingOrder');
    const activeExists = await manageOpenPosition(env);

    if (pending && activeExists) {
      const posArr = await binanceRequest(env, '/fapi/v2/positionRisk');
      const pos = posArr.find(p => p.symbol === pending.sym && Math.abs(parseFloat(p.positionAmt)) > 0);
      if (pos) {
        const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
        const info = await getExchangeInfo(env);
        const tickSize = info[pending.sym]?.tickSize || 0.01;
        const slRound = roundToTick(pending.stopPrice, tickSize, side === 'LONG' ? 'down' : 'up');

        let slOrderId = null;
        try {
          const slRes = await binanceRequest(env, '/fapi/v1/algoOrder', {
            symbol: pending.sym, side: side === 'LONG' ? 'SELL' : 'BUY',
            type: 'STOP_MARKET', algoType: 'CONDITIONAL', triggerPrice: slRound,
            closePosition: 'true', timeInForce: 'GTC', workingType: 'CONTRACT_PRICE'
          }, 'POST');
          slOrderId = slRes.orderId;
        } catch (e) {
          if (!e.message?.includes?.('-4130')) console.error('Pending SL error:', e.message);
        }

        await kvSet(env, 'currentTrade', {
          symbol: pending.sym, side: pending.dir, entryPrice: parseFloat(pos.entryPrice),
          qty: Math.abs(parseFloat(pos.positionAmt)), stopPrice: pending.stopPrice,
          trailDistance: pending.trailDistance, trailActive: false,
          protectionPlaced: true, slOrderId: slOrderId,
          trailingHigh: parseFloat(pos.entryPrice),
          trailingLow: parseFloat(pos.entryPrice)
        });
        await kvSet(env, 'pendingOrder', null);
        console.log(`📈 Pending order filled for ${pending.sym} – SL placed`);
      }
      return;
    }

    if (pending) {
      const ageMin = (Date.now() - pending.createdAt) / 60000;
      if (ageMin > CONFIG.PENDING_TTL) {
        try { await binanceRequest(env, '/fapi/v1/order', { symbol: pending.sym, orderId: pending.orderId }, 'DELETE'); } catch(e) {}
        await kvSet(env, 'pendingOrder', null);
        console.log(`⏰ Pending order expired: ${pending.sym}`);
      }
      return;
    }

    if (!activeExists && !pending) {
      const currentMinute = new Date().getMinutes();
      if (currentMinute % 15 === 0) {
        const feasibleSymbols = await getFeasibleSymbols(env);
        if (feasibleSymbols.length === 0) {
          console.log('⚠️ No feasible symbols for current balance');
          return;
        }
        const originalSymbols = CONFIG.SYMBOLS;
        CONFIG.SYMBOLS = feasibleSymbols;
        const signal = await scanForEntry(env);
        CONFIG.SYMBOLS = originalSymbols;

        if (signal) {
          console.log(`🔎 Signal: ${signal.dir} ${signal.sym} @ ${signal.entry}`);
          await openLimitOrder(env, signal);
        } else {
          console.log('No signal found');
        }
      }
    }
  } catch (e) {
    console.error('Scheduled error:', e.message);
  }
}

export default {
  async scheduled(_, env, ctx) { ctx.waitUntil(handleScheduled(env)); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      const pending = await kvGet(env, 'pendingOrder');
      const trade = await kvGet(env, 'currentTrade');
      const log = (await kvGet(env, 'tradeLog')) || [];
      return new Response(JSON.stringify({ currentTrade: trade, pendingOrder: pending, recentTrades: log.slice(-5) }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('FVG Trailing Bot running', { status: 200 });
  }
};
