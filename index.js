// CoinRadar Bot — by geoffry07
// Merged from RugRadar + WalletRadar with new features:
//   /c   — Safety check (contract, liquidity, mint/freeze, age, tx volume)
//   /w   — Top 10 holder concentration chart
//   /p   — Price lookup (price, market cap, 24h change, volume)
//   /trending — Top trending tokens right now
//   /whale — Recent large transfers for a token
//   /start, /help, /upgrade, /mystatus
//   Admin: /broadcast, /status, /testalert

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const { Pool } = require('pg');
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_CACHE_TTL = 10 * 60 * 1000;

// ─── DB ──────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => console.error('Idle DB client error', err));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_users (
      user_id BIGINT PRIMARY KEY,
      expiry BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      user_id BIGINT NOT NULL,
      day TEXT NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_chats (
      chat_id BIGINT PRIMARY KEY,
      expiry BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_announcements (
      announcement_id TEXT PRIMARY KEY
    );
  `);
  console.log('✅ Database tables ready');
}

console.log('DATABASE_URL present:', !!process.env.DATABASE_URL);
initDb().catch((err) => console.error('Database init failed:', err));

// ─── ENV ─────────────────────────────────────────────────────────────────────

const token        = process.env.TELEGRAM_BOT_TOKEN;
const myChatId     = process.env.MY_CHAT_ID;
const coingeckoKey = process.env.COINGECKO_API_KEY;
const etherscanKey = process.env.ETHERSCAN_API_KEY;
const heliusKey    = process.env.HELIUS_API_KEY;
const moralisKey   = process.env.MORALIS_API_KEY;

if (!token) { console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const FREE_DAILY_LIMIT = 3;
const startTime = Date.now();
let lastCheckTime = null;
let listingsSeenToday = 0;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function isAdmin(userId) {
  return String(userId) === String(myChatId);
}

function fmt(n) {
  if (n == null) return 'N/A';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(4)}`;
}

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 && i < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ─── SUBSCRIPTION / USAGE ────────────────────────────────────────────────────

async function canUserCheck(userId, chatId, isGroup) {
  if (isGroup) {
    const r = await pool.query('SELECT expiry FROM paid_chats WHERE chat_id = $1', [chatId]);
    if (r.rows[0]?.expiry && Number(r.rows[0].expiry) > Date.now()) return true;
  }
  const r = await pool.query('SELECT expiry FROM paid_users WHERE user_id = $1', [userId]);
  if (r.rows[0]?.expiry && Number(r.rows[0].expiry) > Date.now()) return true;
  const day = getTodayKey();
  const u = await pool.query('SELECT count FROM usage_log WHERE user_id = $1 AND day = $2', [userId, day]);
  return (u.rows[0]?.count || 0) < FREE_DAILY_LIMIT;
}

async function recordUsage(userId) {
  const day = getTodayKey();
  await pool.query(
    `INSERT INTO usage_log (user_id, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = usage_log.count + 1`,
    [userId, day]
  );
}

async function setPaidUser(userId, expiry) {
  await pool.query(
    `INSERT INTO paid_users (user_id, expiry) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET expiry = $2`,
    [userId, expiry]
  );
}

async function setPaidChat(chatId, expiry) {
  await pool.query(
    `INSERT INTO paid_chats (chat_id, expiry) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET expiry = $2`,
    [chatId, expiry]
  );
}

// ─── TOKEN LOOKUP ─────────────────────────────────────────────────────────────

async function getTokenContract(ticker) {
  try {
    const searchRes = await fetchWithRetry(
      `https://api.coingecko.com/api/v3/search?query=${ticker}`,
      { headers: { 'x-cg-demo-api-key': coingeckoKey } }
    );
    const searchData = await searchRes.json();
    const coin = searchData?.coins?.find((c) => c.symbol.toUpperCase() === ticker.toUpperCase());
    if (!coin) return null;

    const detailRes = await fetchWithRetry(
      `https://api.coingecko.com/api/v3/coins/${coin.id}`,
      { headers: { 'x-cg-demo-api-key': coingeckoKey } }
    );
    const detail = await detailRes.json();
    const platforms   = detail?.platforms || {};
    const logoImage   = detail?.image?.large || detail?.image?.small || null;
    const totalSupply = detail?.market_data?.total_supply || detail?.market_data?.circulating_supply || null;
    const coingeckoId = coin.id;

    // Build list of all available chains
    const chainMap = {
      'ethereum': 'eth',
      'binance-smart-chain': 'bsc',
      'solana': 'sol',
    };
    const candidates = [];
    for (const [platform, chain] of Object.entries(chainMap)) {
      if (platforms[platform]) {
        candidates.push({ chain, address: platforms[platform] });
      }
    }

    if (candidates.length === 0) {
      return { chain: null, address: null, logoImage, totalSupply, coingeckoId };
    }

    if (candidates.length === 1) {
      return { ...candidates[0], logoImage, totalSupply, coingeckoId };
    }

    // Multiple chains — pick the one with highest liquidity on DexScreener
    // Multiple chains — pick the one with highest liquidity, checked in parallel
    const results = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${candidate.address}`);
        const d = await r.json();
        const pairs = d?.pairs || [];
        const liq = pairs.reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0);
        return { candidate, liq };
      })
    );
    let best = candidates[0];
    let bestLiq = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.liq > bestLiq) {
        bestLiq = result.value.liq;
        best = result.value.candidate;
      }
    }
    return { ...best, logoImage, totalSupply, coingeckoId };

  } catch (err) {
    console.error('CoinGecko lookup failed:', err.message);
    return null;
  }
}

async function searchDexScreener(ticker) {
  try {
    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/search?q=${ticker}`);
    const data = await res.json();
    const pairs = data?.pairs || [];
    const match = pairs.find((p) => p.baseToken?.symbol?.toUpperCase() === ticker.toUpperCase());
    if (!match) return null;
    const chainMap = { ethereum: 'eth', bsc: 'bsc', solana: 'sol' };
    const chain = chainMap[match.chainId] || null;
    if (!chain) return null;
    return { chain, address: match.baseToken.address, totalSupply: null, coingeckoId: null };
  } catch (err) {
    console.error('DexScreener search failed:', err.message);
    return null;
  }
}

function extractTicker(title) {
  const match = title.match(/\(([A-Z0-9]{2,10})\)/);
  return match ? match[1] : null;
}

// ─── SAFETY CHECK HELPERS ─────────────────────────────────────────────────────

async function checkContractVerified(chain, address) {
  if (chain === 'sol') return checkSolanaAuthorities(address);
  const chainId = chain === 'eth' ? 1 : 56;
  try {
    const res = await fetchWithRetry(
      `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${etherscanKey}`
    );
    const data = await res.json();
    const source = data?.result?.[0]?.SourceCode;
    return source && source.length > 0 ? '✅ Verified' : '⚠️ Not verified';
  } catch (err) {
    return '❓ Unknown';
  }
}

async function checkSolanaAuthorities(address) {
  try {
    const res = await fetchWithRetry(
      `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'jsonParsed' }] }),
      }
    );
    const data = await res.json();
    const parsed = data?.result?.value?.data?.parsed?.info;
    if (!parsed) return '❓ Unknown';
    const mintStatus   = parsed.mintAuthority   ? '⚠️ Mint authority active'   : '✅ Mint revoked';
    const freezeStatus = parsed.freezeAuthority ? '⚠️ Freeze authority active' : '✅ Freeze revoked';
    return `${mintStatus}, ${freezeStatus}`;
  } catch (err) {
    return '❓ Unknown';
  }
}

async function checkLiquidity(address) {
  try {
    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (pairs.length === 0) return { text: '⚠️ No liquidity pools found', image: null };
    const topPair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const liq = topPair.liquidity?.usd || 0;
    const image = topPair.info?.openGraph || topPair.info?.header || null;
    return { text: `$${liq.toLocaleString()} (${topPair.dexId})`, image };
  } catch (err) {
    return { text: '❓ Unknown', image: null };
  }
}

async function checkTokenAge(chain, address) {
  try {
    if (chain === 'sol') return '❓ Age check not available for Solana';
    const baseUrl = chain === 'eth' ? 'https://api.etherscan.io/api' : 'https://api.bscscan.com/api';
    const res = await fetchWithRetry(
      `${baseUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${etherscanKey}`
    );
    const data = await res.json();
    const firstTx = data?.result?.[0];
    if (!firstTx) return '❓ Unknown';
    const deployDate = new Date(Number(firstTx.timeStamp) * 1000);
    const ageDays = Math.floor((Date.now() - deployDate.getTime()) / (1000 * 60 * 60 * 24));
    const label = ageDays < 7 ? '⚠️' : ageDays < 30 ? '🟡' : '✅';
    return `${label} ${ageDays} day${ageDays === 1 ? '' : 's'} old (deployed ${deployDate.toISOString().slice(0, 10)})`;
  } catch (err) {
    return '❓ Unknown';
  }
}

async function check24hTxVolume(address) {
  try {
    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (pairs.length === 0) return '❓ Unknown';
    const topPair = pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    const vol = topPair.volume?.h24 || 0;
    const txns = topPair.txns?.h24 || {};
    const totalTxns = (txns.buys || 0) + (txns.sells || 0);
    return `$${vol.toLocaleString()} (${totalTxns} txns in 24h)`;
  } catch (err) {
    return '❓ Unknown';
  }
}

function assessSafetyRisk(verified, liquidity, mintBad) {
  const verifiedBad  = verified.includes('⚠️') || verified.includes('❓');
  const liquidityBad = liquidity.includes('⚠️') || liquidity.includes('❓');
  const badSignals   = [verifiedBad, liquidityBad, mintBad].filter(Boolean).length;
  if (badSignals >= 2) return '🔴 HIGH RISK';
  if (badSignals === 1) return '🟡 CAUTION';
  return '🟢 LOW RISK';
}

// ─── HOLDER ANALYSIS HELPERS ──────────────────────────────────────────────────

async function getEthTopHolders(address) {
  try {
    const res = await fetchWithRetry(
      `https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${etherscanKey}`
    );
    const data = await res.json();
    if (data.status === '1' && Array.isArray(data.result)) {
      return data.result.map((h) => ({ address: h.TokenHolderAddress, balance: parseFloat(h.TokenHolderQuantity) }));
    }
    throw new Error('Etherscan Pro required');
  } catch (err) {
    return getTopHoldersMoralis(address, 'eth');
  }
}

async function getBscTopHolders(address) {
  try {
    const res = await fetchWithRetry(
      `https://api.bscscan.com/api?module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${etherscanKey}`
    );
    const data = await res.json();
    if (data.status === '1' && Array.isArray(data.result)) {
      return data.result.map((h) => ({ address: h.TokenHolderAddress, balance: parseFloat(h.TokenHolderQuantity) }));
    }
    throw new Error('BscScan Pro required');
  } catch (err) {
    return getTopHoldersMoralis(address, 'bsc');
  }
}

async function getTopHoldersMoralis(address, chain) {
  if (!moralisKey) throw new Error('No Moralis API key');
  const chainMap = { eth: 'eth', bsc: 'bsc', sol: 'solana' };
  const res = await fetchWithRetry(
    `https://deep-index.moralis.io/api/v2.2/erc20/${address}/owners?chain=${chainMap[chain] || chain}&limit=10`,
    { headers: { 'X-API-Key': moralisKey, 'Accept': 'application/json' } }
  );
  const data = await res.json();
  if (data.result && Array.isArray(data.result)) {
    return data.result.map((h) => ({
      address: h.owner_address || h.address,
      balance: parseFloat(h.balance) / Math.pow(10, h.decimals || 18),
    }));
  }
  throw new Error('No Moralis data');
}

async function getSolTopHolders(address) {
  const res = await fetchWithRetry(
    `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [address] }),
    }
  );
  const data = await res.json();
  if (!data.result?.value) throw new Error('No Solana data');
  return data.result.value.slice(0, 10).map((a) => ({
    address: a.address,
    balance: a.uiAmount || a.amount / Math.pow(10, 9),
  }));
}

 async function getTotalSupply(chain, address) {
  try {
    // Try DexScreener first — most reliable
    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (pairs.length > 0) {
      const fdv = pairs[0].fdv;
      const price = parseFloat(pairs[0].priceUsd || 0);
      if (fdv && price > 0) {
        const supply = fdv / price;
        if (supply > 0) return supply;
      }
    }
  } catch (err) {
    console.error('DexScreener supply fetch failed:', err.message);
  }

  try {
    if (chain === 'sol') {
      const res = await fetchWithRetry(
        `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [address] }),
        }
      );
      const data = await res.json();
      return data.result?.value?.uiAmount || null;
    } else {
      const baseUrl = chain === 'eth' ? 'https://api.etherscan.io/api' : 'https://api.bscscan.com/api';
      const res = await fetchWithRetry(`${baseUrl}?module=stats&action=tokensupply&contractaddress=${address}&apikey=${etherscanKey}`);
      const data = await res.json();
      if (data.status === '1') {
        const dr = await fetchWithRetry(`${baseUrl}?module=token&action=tokeninfo&contractaddress=${address}&apikey=${etherscanKey}`);
        const dd = await dr.json();
        const decimals = parseInt(dd.result?.[0]?.decimals || 18);
        return parseFloat(data.result) / Math.pow(10, decimals);
      }
    }
  } catch (err) {
    console.error('Chain supply fetch failed:', err.message);
  }

  return null;
}

async function getTopHoldersWithPercentage(chain, address) {
  let holders;
  switch (chain) {
    case 'eth': holders = await getEthTopHolders(address); break;
    case 'bsc': holders = await getBscTopHolders(address); break;
    case 'sol': holders = await getSolTopHolders(address); break;
    default: throw new Error('Unsupported chain');
  }

  let totalSupply = await getTotalSupply(chain, address);
  if (!totalSupply) totalSupply = holders.reduce((s, h) => s + h.balance, 0);

  const holdersWithPct = holders.map((h) => ({
    address: h.address,
    balance: h.balance,
    percentage: (h.balance / totalSupply) * 100,
  }));

  return {
    holders: holdersWithPct,
    top10Total: holdersWithPct.reduce((s, h) => s + h.percentage, 0),
    totalSupply,
  };
}

function assessConcentrationRisk(top10Pct) {
  if (top10Pct >= 70) return { level: '🔴 HIGH RISK', description: 'Extreme concentration — high manipulation risk.' };
  if (top10Pct >= 40) return { level: '🟡 MID RISK',  description: 'Significant concentration — exercise caution.' };
  return                     { level: '🟢 LOW RISK',  description: 'Supply is well distributed.' };
}

// ─── CHART ────────────────────────────────────────────────────────────────────


function generatePieChartUrl(holders, top10Total, ticker) {
  const labels = holders.map((_, i) => `Wallet ${i + 1}`);
  const dataValues = holders.map((h) => parseFloat(h.percentage.toFixed(2)));
  const otherPct = parseFloat(Math.max(0, 100 - top10Total).toFixed(2));
  if (otherPct > 0) { labels.push('Others'); dataValues.push(otherPct); }

  const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#FFA07A','#98D8C8','#F7DC6F','#BB8FCE','#85C1E2','#F8B739','#52B788','#E0E0E0'];

  const chartConfig = {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: dataValues, backgroundColor: colors.slice(0, labels.length), borderColor: '#1a1a2e', borderWidth: 2 }],
    },
    options: {
      cutoutPercentage: 65,
      plugins: {
        legend: { position: 'bottom', labels: { fontColor: '#ffffff', fontSize: 11, padding: 10 } },
        title: { display: true, text: `${ticker} — Top 10 Holder Distribution`, fontColor: '#ffffff', fontSize: 15 },
        doughnutlabel: {
          labels: [
            { text: `${top10Total.toFixed(1)}%`, font: { size: 38, weight: 'bold' }, color: '#ffffff' },
            { text: 'Top 10', font: { size: 14 }, color: '#aaaaaa' },
          ],
        },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encoded}&backgroundColor=%231a1a2e&width=800&height=600`;
}

// ─── PRICE LOOKUP ─────────────────────────────────────────────────────────────

async function fetchPrice(ticker) {
  // Try CoinGecko first
  try {
    const searchRes = await fetchWithRetry(
      `https://api.coingecko.com/api/v3/search?query=${ticker}`,
      { headers: { 'x-cg-demo-api-key': coingeckoKey } }
    );
    const searchData = await searchRes.json();
    const coin = searchData?.coins?.find((c) => c.symbol.toUpperCase() === ticker.toUpperCase());
    if (coin) {
      const r = await fetchWithRetry(
        `https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&community_data=false&developer_data=false`,
        { headers: { 'x-cg-demo-api-key': coingeckoKey } }
      );
      const d = await r.json();
      const md = d?.market_data;
      return {
        name:       d.name,
        symbol:     d.symbol?.toUpperCase(),
        price:      md?.current_price?.usd,
        change24h:  md?.price_change_percentage_24h,
        change7d:   md?.price_change_percentage_7d,
        marketCap:  md?.market_cap?.usd,
        volume24h:  md?.total_volume?.usd,
        ath:        md?.ath?.usd,
        logoImage:  d?.image?.large || null,
      };
    }
  } catch (err) {
    console.error('CoinGecko price fetch failed:', err.message);
  }

  // Fallback: DexScreener
  try {
    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/search?q=${ticker}`);
    const data = await res.json();
    const match = data?.pairs?.find((p) => p.baseToken?.symbol?.toUpperCase() === ticker.toUpperCase());
    if (match) {
      return {
        name:      match.baseToken.name,
        symbol:    match.baseToken.symbol.toUpperCase(),
        price:     parseFloat(match.priceUsd || 0),
        change24h: match.priceChange?.h24,
        change7d:  null,
        marketCap: match.marketCap || null,
        volume24h: match.volume?.h24 || null,
        ath:       null,
        logoImage: match.info?.imageUrl || null,
      };
    }
  } catch (err) {
    console.error('DexScreener price fetch failed:', err.message);
  }

  return null;
}

// ─── TRENDING ─────────────────────────────────────────────────────────────────

async function fetchTrending() {
  if (trendingCache && Date.now() - trendingCacheTime < TRENDING_CACHE_TTL) {
    return trendingCache;
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending');
    const text = await res.text();
    console.log('Trending raw response:', text.slice(0, 200));
    const data = JSON.parse(text);
    if (!data?.coins?.length) throw new Error('No coins in response');
    trendingCache = data.coins.slice(0, 10).map((entry, i) => {
      const c = entry.coin;
      return {
        rank:      i + 1,
        name:      c.name,
        symbol:    c.symbol?.toUpperCase(),
        change24h: c.data?.price_change_percentage_24h?.usd,
        price:     c.data?.price,
      };
    });
    trendingCacheTime = Date.now();
    return trendingCache;
  } catch (err) {
    console.error('Trending fetch failed:', err.message);
    return trendingCache || null;
  }
}
// ─── WHALE TRACKER ────────────────────────────────────────────────────────────

async function fetchWhaleTransfers(chain, address, ticker) {
  try {
    if (chain === 'sol') {
      const res = await fetchWithRetry(
        `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getSignaturesForAddress',
            params: [address, { limit: 20 }],
          }),
        }
      );
      const data = await res.json();
      const sigs = (data.result || []).slice(0, 5);
      if (sigs.length === 0) return '⚠️ No recent transactions found.';
      return sigs.map((s, i) =>
        `${i + 1}. \`${s.signature.slice(0, 16)}...\` — ${new Date(s.blockTime * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      ).join('\n') + '\n\n_Full amounts require a Helius paid plan._';
    }

    // Try Moralis first for ETH/BSC
    if (moralisKey) {
      const chainId = chain === 'eth' ? 'eth' : 'bsc';
      const res = await fetchWithRetry(
        `https://deep-index.moralis.io/api/v2.2/erc20/${address}/transfers?chain=${chainId}&limit=50`,
        { headers: { 'X-API-Key': moralisKey, 'Accept': 'application/json' } }
      );
      const data = await res.json();
      const txs = data?.result;
      if (Array.isArray(txs) && txs.length > 0) {
        const parsed = txs.map((tx) => ({
          from:  tx.from_address,
          to:    tx.to_address,
          value: parseFloat(tx.value) / Math.pow(10, parseInt(tx.token_decimals || 18)),
          time:  new Date(tx.block_timestamp),
          hash:  tx.transaction_hash,
        }));
        const whales = parsed.sort((a, b) => b.value - a.value).slice(0, 5);
        return whales.map((tx, i) => {
          const val = tx.value >= 1e6 ? `${(tx.value / 1e6).toFixed(2)}M`
                    : tx.value >= 1e3 ? `${(tx.value / 1e3).toFixed(2)}K`
                    : tx.value.toFixed(2);
          return `${i + 1}. 🐋 ${val} ${ticker}\n   From: \`${tx.from.slice(0, 8)}...\` → \`${tx.to.slice(0, 8)}...\`\n   ${tx.time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        }).join('\n\n');
      }
    }

    // Fallback to Etherscan
    const baseUrl = chain === 'eth' ? 'https://api.etherscan.io/api' : 'https://api.bscscan.com/api';
    const res = await fetchWithRetry(
      `${baseUrl}?module=account&action=tokentx&contractaddress=${address}&page=1&offset=50&sort=desc&apikey=${etherscanKey}`
    );
    const data = await res.json();
    const txs = data?.result;
    if (!Array.isArray(txs) || txs.length === 0) return '⚠️ No recent transfers found.';
    const decimals = parseInt(txs[0]?.tokenDecimal || 18);
    const parsed = txs.map((tx) => ({
      from:  tx.from,
      to:    tx.to,
      value: parseFloat(tx.value) / Math.pow(10, decimals),
      time:  new Date(Number(tx.timeStamp) * 1000),
    }));
    const whales = parsed.sort((a, b) => b.value - a.value).slice(0, 5);
    return whales.map((tx, i) => {
      const val = tx.value >= 1e6 ? `${(tx.value / 1e6).toFixed(2)}M`
                : tx.value >= 1e3 ? `${(tx.value / 1e3).toFixed(2)}K`
                : tx.value.toFixed(2);
      return `${i + 1}. 🐋 ${val} ${ticker}\n   From: \`${tx.from.slice(0, 8)}...\` → \`${tx.to.slice(0, 8)}...\`\n   ${tx.time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    }).join('\n\n');

  } catch (err) {
    console.error('Whale fetch failed:', err.message);
    return '❓ Could not fetch whale data.';
  }
}

// ─── BYBIT LISTING MONITOR ────────────────────────────────────────────────────

async function hasSeenAnnouncement(id) {
  const r = await pool.query('SELECT 1 FROM seen_announcements WHERE announcement_id = $1', [id]);
  return r.rows.length > 0;
}

async function markAnnouncementSeen(id) {
  await pool.query('INSERT INTO seen_announcements (announcement_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

async function countSeenAnnouncements() {
  const r = await pool.query('SELECT COUNT(*) FROM seen_announcements');
  return Number(r.rows[0].count);
}

async function runSafetyCheckByTitle(title) {
  const ticker = extractTicker(title);
  if (!ticker) return null;
  let contract = await getTokenContract(ticker);
  if (!contract) contract = await searchDexScreener(ticker);
  if (!contract || !contract.address) return { text: `🔍 Safety check: couldn't find ${ticker} on-chain yet — be extra cautious.`, image: null };

  const [verified, liquidityResult] = await Promise.all([
    checkContractVerified(contract.chain, contract.address),
    checkLiquidity(contract.address),
  ]);
  const mintBad   = verified.includes('Mint authority active') || verified.includes('Freeze authority active');
  const riskScore = assessSafetyRisk(verified, liquidityResult.text, mintBad);
  const image     = liquidityResult.image || contract.logoImage || null;

  return {
    text: `🔍 Safety Check (${ticker} on ${contract.chain.toUpperCase()}):\nContract: ${verified}\nLiquidity: ${liquidityResult.text}\n\n${riskScore}`,
    image,
  };
}

async function checkBybitListings() {
  try {
    const res = await fetch(
      'https://api.bybit.com/v5/announcements/index?locale=en-US&type=new_crypto&limit=10',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoinRadarBot/1.0)', 'Accept': 'application/json' } }
    );
    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { console.error('Non-JSON from Bybit:', rawText.slice(0, 200)); return; }

    const items = data?.result?.list || [];
    lastCheckTime = Date.now();

    const alreadySeen = await countSeenAnnouncements();
    if (alreadySeen === 0) {
      for (const item of items) await markAnnouncementSeen(item.id);
      console.log(`Initialized with ${items.length} existing Bybit announcements.`);
      return;
    }

    for (const item of items) {
      if (await hasSeenAnnouncement(item.id)) continue;
      await markAnnouncementSeen(item.id);
      listingsSeenToday++;
      if (!myChatId) continue;

      const safetyResult = await runSafetyCheckByTitle(item.title);
      const caption = `🚨 New Bybit Listing\n\n${item.title}\n\n🔗 ${item.url || 'No link available'}${safetyResult ? `\n\n${safetyResult.text}` : ''}`;
      if (safetyResult?.image) bot.sendPhoto(myChatId, safetyResult.image, { caption });
      else bot.sendMessage(myChatId, caption);
      console.log(`New listing: ${item.title}`);
    }
  } catch (err) {
    console.error('Bybit check error:', err.message);
  }
}

// ─── BOT SETUP ────────────────────────────────────────────────────────────────

const bot = new TelegramBot(token, { polling: true });

bot.deleteMyCommands()
  .then(() => bot.setMyCommands([
    { command: 'start',    description: 'Start CoinRadar' },
    { command: 'c',        description: 'Safety check — /c pepe' },
    { command: 'w',        description: 'Top 10 holder chart — /w pepe' },
    { command: 'p',        description: 'Price lookup — /p pepe' },
    { command: 'trending', description: 'Top trending tokens right now' },
    { command: 'whale',    description: 'Recent whale transfers — /whale pepe' },
    { command: 'upgrade',  description: 'Unlimited checks subscription' },
    { command: 'mystatus', description: 'Your subscription status' },
    { command: 'help',     description: 'All commands' },
  ]))
  .then(() => console.log('✅ Bot commands set'))
  .catch((err) => console.error('Failed to set commands:', err.message));

// ─── PAYMENT HANDLERS ────────────────────────────────────────────────────────

bot.on('pre_checkout_query', (query) => {
  bot.answerPreCheckoutQuery(query.id, true).catch((err) => console.error('pre_checkout error:', err.message));
});

bot.on('successful_payment', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const payment = msg.successful_payment;
  const isGroupPayload = payment?.invoice_payload === 'coinradar_unlimited_group';
  const expiry = payment?.subscription_expiration_date
    ? payment.subscription_expiration_date * 1000
    : Date.now() + 30 * 24 * 60 * 60 * 1000;

  if (isGroupPayload) {
    await setPaidChat(chatId, expiry);
    bot.sendMessage(chatId, '✅ Payment successful! This group now has unlimited checks for 30 days. Thanks for supporting CoinRadar 📡');
  } else {
    await setPaidUser(userId, expiry);
    bot.sendMessage(chatId, '✅ Payment successful! You now have unlimited checks for 30 days. Thanks for supporting CoinRadar 📡');
  }
});

// ─── GATE HELPER ─────────────────────────────────────────────────────────────

async function gate(msg) {
  const userId  = msg.from.id;
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (isAdmin(userId)) return true;
  if (!(await canUserCheck(userId, chatId, isGroup))) {
    bot.sendMessage(chatId, `🚫 You've used your ${FREE_DAILY_LIMIT} free checks today.\n\nUpgrade with /upgrade for unlimited checks.`);
    return false;
  }
  await recordUsage(userId);
  return true;
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📡 *CoinRadar is online.*\n\nYour all-in-one crypto intelligence bot.\n\n` +
    `*/c <ticker>* — Safety check (contract, liquidity, age, tx volume)\n` +
    `*/w <ticker>* — Top 10 holder concentration chart\n` +
    `*/p <ticker>* — Price, market cap, 24h change\n` +
    `*/trending*    — Top 10 trending tokens right now\n` +
    `*/whale <ticker>* — Recent large transfers\n\n` +
    `Free users get ${FREE_DAILY_LIMIT} checks/day. Use /upgrade for unlimited.\n` +
    `Use /help to see all commands.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📡 *CoinRadar Commands*\n\n` +
    `*/c <ticker>*     — Safety check\n` +
    `*/w <ticker>*     — Holder concentration chart\n` +
    `*/p <ticker>*     — Price lookup\n` +
    `*/trending*       — Trending tokens\n` +
    `*/whale <ticker>* — Whale transfers\n` +
    `*/upgrade*        — Subscribe for unlimited checks\n` +
    `*/mystatus*       — Your subscription & usage\n\n` +
    `Free users: ${FREE_DAILY_LIMIT} checks/day across /c, /w, /p, and /whale.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /c — SAFETY CHECK ────────────────────────────────────────────────────────

bot.onText(/^\/c$/, (msg) => bot.sendMessage(msg.chat.id, '🔍 Include a ticker, e.g. /c pepe'));

bot.onText(/\/c (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();
  if (!(await gate(msg))) return;

  bot.sendMessage(chatId, `🔍 Running safety check on *${ticker}*...`, { parse_mode: 'Markdown' });

  let contract = await getTokenContract(ticker);
  if (!contract) contract = await searchDexScreener(ticker);

  if (!contract || !contract.address) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find *${ticker}* on-chain. Try the exact ticker (e.g. PEPE, not Pepecoin).`, { parse_mode: 'Markdown' });
  }

  const [verified, liquidityResult, age, volume] = await Promise.all([
    checkContractVerified(contract.chain, contract.address),
    checkLiquidity(contract.address),
    checkTokenAge(contract.chain, contract.address),
    check24hTxVolume(contract.address),
  ]);

  const mintBad   = verified.includes('Mint authority active') || verified.includes('Freeze authority active');
  const riskScore = assessSafetyRisk(verified, liquidityResult.text, mintBad);
  const image     = liquidityResult.image || contract.logoImage || null;

  const caption =
    `🔍 *Safety Check — ${ticker} (${contract.chain.toUpperCase()})*\n\n` +
    `Contract:  ${verified}\n` +
    `Liquidity: ${liquidityResult.text}\n` +
    `Age:       ${age}\n` +
    `24h Vol:   ${volume}\n\n` +
    `*${riskScore}*`;

  if (image) bot.sendPhoto(chatId, image, { caption, parse_mode: 'Markdown' });
  else bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
});

// ─── /w — HOLDER CHART ────────────────────────────────────────────────────────

bot.onText(/^\/w$/, (msg) => bot.sendMessage(msg.chat.id, '📊 Include a ticker, e.g. /w pepe'));

bot.onText(/\/w (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();
  if (!(await gate(msg))) return;

  bot.sendMessage(chatId, `📊 Fetching holder data for *${ticker}*...`, { parse_mode: 'Markdown' });

  try {
    let contract = await getTokenContract(ticker);
    if (!contract) contract = await searchDexScreener(ticker);
    if (!contract || !contract.address) {
      return bot.sendMessage(chatId, `⚠️ Couldn't find *${ticker}* on-chain.`, { parse_mode: 'Markdown' });
    }

    const { holders, top10Total, totalSupply } = await getTopHoldersWithPercentage(contract.chain, contract.address);
    const risk      = assessConcentrationRisk(top10Total);
    const chartUrl = generatePieChartUrl(holders, top10Total, ticker);

    const holderLines = holders.slice(0, 5).map((h, i) =>
      `  ${i + 1}. \`${h.address.slice(0, 6)}...${h.address.slice(-4)}\` — ${h.percentage.toFixed(2)}%`
    ).join('\n');

    const caption =
      `📊 *${ticker} Holder Analysis (${contract.chain.toUpperCase()})*\n\n` +
      `Top 10 hold: *${top10Total.toFixed(2)}%* of supply\n` +
      `Total supply: ${totalSupply ? totalSupply.toLocaleString() : 'Unknown'}\n\n` +
      `Top 5 wallets:\n${holderLines}\n\n` +
      `*${risk.level}*\n${risk.description}`;

    await bot.sendPhoto(chatId, chartUrl, { caption, parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/w error:', err.message);
    bot.sendMessage(chatId, `⚠️ Failed to analyze ${ticker}. Possible cause: API limit, token too new, or unsupported chain.`);
  }
});

// ─── /p — PRICE ───────────────────────────────────────────────────────────────

bot.onText(/^\/p$/, (msg) => bot.sendMessage(msg.chat.id, '💰 Include a ticker, e.g. /p pepe'));

bot.onText(/\/p (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();
  if (!(await gate(msg))) return;

  bot.sendMessage(chatId, `💰 Fetching price for *${ticker}*...`, { parse_mode: 'Markdown' });

  const data = await fetchPrice(ticker);
  if (!data) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find price data for *${ticker}*.`, { parse_mode: 'Markdown' });
  }

  const change24hStr = data.change24h != null
    ? `${data.change24h >= 0 ? '📈' : '📉'} ${data.change24h.toFixed(2)}%`
    : '❓ N/A';

  const change7dStr = data.change7d != null
    ? `${data.change7d >= 0 ? '📈' : '📉'} ${data.change7d.toFixed(2)}%`
    : '❓ N/A';

  const caption =
    `💰 *${data.name} (${data.symbol})*\n\n` +
    `Price:      $${data.price != null ? data.price.toLocaleString(undefined, { maximumSignificantDigits: 6 }) : 'N/A'}\n` +
    `24h change: ${change24hStr}\n` +
    `7d change:  ${change7dStr}\n` +
    `Market cap: ${fmt(data.marketCap)}\n` +
    `24h volume: ${fmt(data.volume24h)}\n` +
    `ATH:        ${data.ath != null ? `$${data.ath.toLocaleString()}` : 'N/A'}`;

  if (data.logoImage) bot.sendPhoto(chatId, data.logoImage, { caption, parse_mode: 'Markdown' });
  else bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
});

// ─── /trending ────────────────────────────────────────────────────────────────

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🔥 Fetching trending tokens...`);

  const coins = await fetchTrending();
  if (!coins || coins.length === 0) {
    return bot.sendMessage(chatId, '⚠️ Could not fetch trending data right now. Try again shortly.');
  }

  const lines = coins.map((c, i) => {
    const changeStr = c.change24h != null ? ` (${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(1)}%)` : '';
    const priceStr  = c.price ? ` — $${parseFloat(c.price).toLocaleString(undefined, { maximumSignificantDigits: 4 })}` : '';
    return `${i + 1}. *${c.name}* (${c.symbol})${priceStr}${changeStr}`;
  }).join('\n');

  bot.sendMessage(chatId, `🔥 *Top Gainers (24h)*\n\n${lines}`, { parse_mode: 'Markdown' });
});

// ─── /whale ───────────────────────────────────────────────────────────────────

bot.onText(/^\/whale$/, (msg) => bot.sendMessage(msg.chat.id, '🐋 Include a ticker, e.g. /whale pepe'));

bot.onText(/\/whale (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();
  if (!(await gate(msg))) return;

  bot.sendMessage(chatId, `🐋 Looking up whale transfers for *${ticker}*...`, { parse_mode: 'Markdown' });

  let contract = await getTokenContract(ticker);
  if (!contract) contract = await searchDexScreener(ticker);
  if (!contract || !contract.address) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find *${ticker}* on-chain.`, { parse_mode: 'Markdown' });
  }

  const result = await fetchWhaleTransfers(contract.chain, contract.address, ticker);
  bot.sendMessage(
    chatId,
    `🐋 *Whale Transfers — ${ticker} (${contract.chain.toUpperCase()})*\n\n${result}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /upgrade ─────────────────────────────────────────────────────────────────

bot.onText(/\/upgrade/, async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const title   = isGroup ? 'CoinRadar Unlimited — Group' : 'CoinRadar Unlimited';
  const desc    = isGroup
    ? 'Unlimited checks for everyone in this group. Billed monthly via Telegram Stars, cancel anytime.'
    : 'Unlimited checks. Billed monthly via Telegram Stars, cancel anytime.';
  const payload = isGroup ? 'coinradar_unlimited_group' : 'coinradar_unlimited';
  const amount  = isGroup ? 2500 : 550;
  const label   = isGroup ? 'Monthly — Group' : 'Monthly';

  try {
    const link = await bot.createInvoiceLink(title, desc, payload, '', 'XTR', [{ label, amount }], { subscription_period: 2592000 });
    bot.sendMessage(chatId, '📡 Subscribe to CoinRadar Unlimited:', {
      reply_markup: { inline_keyboard: [[{ text: `⭐ Subscribe (${amount} Stars/mo)`, url: link }]] },
    });
  } catch (err) {
    console.error('Invoice link error:', err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong generating the subscription link. Please try again.');
  }
});

// ─── /mystatus ────────────────────────────────────────────────────────────────

bot.onText(/\/mystatus/, async (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  try {
    const lines = [];

    if (isGroup) {
      const r = await pool.query('SELECT expiry FROM paid_chats WHERE chat_id = $1', [chatId]);
      const exp = r.rows[0]?.expiry;
      if (exp && Number(exp) > Date.now()) {
        const d = Math.ceil((Number(exp) - Date.now()) / 86400000);
        lines.push(`✅ Group subscription active (${d} day${d === 1 ? '' : 's'} left).`);
      } else {
        lines.push('🚫 No active group subscription.');
      }
    }

    if (isAdmin(userId)) {
      lines.push('👑 You are the bot admin — unlimited checks, no limits.');
    } else {
      const r = await pool.query('SELECT expiry FROM paid_users WHERE user_id = $1', [userId]);
      const exp = r.rows[0]?.expiry;
      if (exp && Number(exp) > Date.now()) {
        const d = Math.ceil((Number(exp) - Date.now()) / 86400000);
        lines.push(`✅ Personal subscription active (${d} day${d === 1 ? '' : 's'} left).`);
      } else {
        const u = await pool.query('SELECT count FROM usage_log WHERE user_id = $1 AND day = $2', [userId, getTodayKey()]);
        const used = u.rows[0]?.count || 0;
        const left = Math.max(FREE_DAILY_LIMIT - used, 0);
        lines.push(`🆓 Free tier: ${left} check${left === 1 ? '' : 's'} remaining today.`);
        if (left === 0) lines.push('Use /upgrade for unlimited checks.');
      }
    }

    bot.sendMessage(chatId, `📡 *Your CoinRadar Status*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/mystatus error:', err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────

bot.onText(/\/status/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const uptime   = Math.floor((Date.now() - startTime) / 60000);
  const lastCheck = lastCheckTime ? `${Math.floor((Date.now() - lastCheckTime) / 60000)} min ago` : 'not yet run';
  bot.sendMessage(
    msg.chat.id,
    `📡 *CoinRadar Status*\n\nUptime: ${uptime} min\nLast Bybit check: ${lastCheck}\nNew listings this session: ${listingsSeenToday}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/testalert/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const title = 'Pepe (PEPE) Gets Listed on Bybit Spot';
  const safetyResult = await runSafetyCheckByTitle(title);
  const caption = `🚨 TEST ALERT — Bybit Listing\n\n${title}\n\n🔗 https://announcements.bybit.com/example${safetyResult ? `\n\n${safetyResult.text}` : ''}`;
  if (safetyResult?.image) bot.sendPhoto(msg.chat.id, safetyResult.image, { caption });
  else bot.sendMessage(msg.chat.id, caption);
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const text = match[1].trim();
  // Get all unique user_ids who have ever used the bot
  try {
    const r = await pool.query('SELECT DISTINCT user_id FROM usage_log');
    const users = r.rows.map((row) => row.user_id);
    let sent = 0, failed = 0;
    for (const uid of users) {
      try {
        await bot.sendMessage(uid, `📡 *CoinRadar Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
        sent++;
        await new Promise((r) => setTimeout(r, 50)); // respect Telegram rate limits
      } catch (_) {
        failed++;
      }
    }
    bot.sendMessage(msg.chat.id, `✅ Broadcast complete.\nSent: ${sent}\nFailed: ${failed}`);
  } catch (err) {
    console.error('/broadcast error:', err.message);
    bot.sendMessage(msg.chat.id, '⚠️ Broadcast failed.');
  }
});

// ─── BYBIT POLLING ────────────────────────────────────────────────────────────

checkBybitListings();
setInterval(checkBybitListings, 5 * 60 * 1000);

// ─── BOOT ─────────────────────────────────────────────────────────────────────

console.log('📡 CoinRadar bot is running...');
if (myChatId) {
  bot.sendMessage(myChatId, '✅ CoinRadar started and is online. 📡');
}
