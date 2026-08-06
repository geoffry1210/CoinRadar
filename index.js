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
const http = require('http');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');

// Disable keep-alive to avoid stale sockets causing "Premature close" errors
// on long-running processes (node-fetch v2 known issue)
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
const { Pool } = require('pg');
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_CACHE_TTL = 10 * 60 * 1000;

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});
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
      expiry BIGINT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'regular'
    );
  `);
  await pool.query(`ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'regular';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      user_id BIGINT NOT NULL,
      day TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, command)
    );
  `);
  await pool.query(`ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS command TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE usage_log DROP CONSTRAINT IF EXISTS usage_log_pkey;`);
  await pool.query(`ALTER TABLE usage_log ADD CONSTRAINT usage_log_pkey PRIMARY KEY (user_id, day, command);`);
  // Tracks EVERY user who has ever sent the bot a message, regardless of
  // which command (free or premium) or whether they're the admin.
  // usage_log only ever gets a row from the premium free-trial path
  // (and admin is explicitly exempted from it), so it badly undercounts
  // real users — this table is the actual source of truth for /broadcast.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS known_users (
      user_id BIGINT PRIMARY KEY,
      chat_id BIGINT,
      username TEXT,
      first_seen BIGINT,
      last_seen BIGINT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_chats (
      chat_id BIGINT PRIMARY KEY,
      expiry BIGINT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'regular'
    );
  `);
  await pool.query(`ALTER TABLE paid_chats ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'regular';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_announcements (
      announcement_id TEXT PRIMARY KEY
    );
  `);
await pool.query(`
  ALTER TABLE price_alerts 
  ADD COLUMN IF NOT EXISTS recurring BOOLEAN DEFAULT false
`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO bot_settings (key, value) VALUES ('early_access_remaining', '5')
    ON CONFLICT (key) DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_alerts (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      username TEXT,
      ticker TEXT NOT NULL,
      target_price NUMERIC NOT NULL,
      direction TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      triggered BOOLEAN NOT NULL DEFAULT FALSE,
      recurring BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  // Origin message_id so delayed alert triggers (fired later from the
  // background checker, not from a live incoming message) can still
  // reply-thread to the message that created them and ping the user.
  await pool.query(`ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS message_id BIGINT;`);
await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      ticker TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, ticker)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_okx_announcements (
      announcement_id TEXT PRIMARY KEY
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holder_snapshots (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      chain TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      percentage NUMERIC NOT NULL,
      checked_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_holder_wallet ON holder_snapshots (wallet_address);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dev_watches (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      chat_id BIGINT NOT NULL,
      username TEXT,
      ticker TEXT NOT NULL,
      chain TEXT NOT NULL,
      dev_address TEXT NOT NULL,
      last_tx_hash TEXT,
      last_checked_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, ticker)
    );
  `);
  await pool.query(`ALTER TABLE dev_watches ADD COLUMN IF NOT EXISTS message_id BIGINT;`);
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

async function setPaidUser(userId, expiry, tier = 'regular') {
  await pool.query(
    `INSERT INTO paid_users (user_id, expiry, tier) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET expiry = $2, tier = $3`,
    [userId, expiry, tier]
  );
}

async function setPaidChat(chatId, expiry, tier = 'regular') {
  await pool.query(
    `INSERT INTO paid_chats (chat_id, expiry, tier) VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET expiry = $2, tier = $3`,
    [chatId, expiry, tier]
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

// Pulls a token ticker out of an exchange announcement title.
// Different exchanges (and different announcement types on the same exchange)
// format tickers in different ways, so we try each known pattern in order
// until one matches:
//   "Pepe (PEPE) Gets Listed on Bybit Spot"            -> parenthesis format
//   "$GROVE is officially listed on Bybit Spot..."      -> dollar-sign format
//   "OKX to list TAO/USDT (Bittensor) for spot trading" -> slash-pair format (OKX's most common pattern)
// Returns null if none of the patterns match.
function extractTicker(title) {
  const parenMatch = title.match(/\(([A-Z0-9]{2,10})\)/);
  if (parenMatch) return parenMatch[1];

  const dollarMatch = title.match(/\$([A-Z0-9]{2,10})\b/);
  if (dollarMatch) return dollarMatch[1];

  // Matches the base asset in a pair like "TAO/USDT" or "TAO/USD" — takes
  // the left-hand side only, since that's the newly listed token.
  const slashMatch = title.match(/\b([A-Z0-9]{2,10})\/(USDT|USD|USDC)\b/);
  if (slashMatch) return slashMatch[1];

  return null;
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
    const chainId = chain === 'eth' ? 1 : 56;
    const baseUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}`;
    const res = await fetchWithRetry(
      `${baseUrl}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${etherscanKey}`
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



async function getDevWalletHistory(chain, address) {
  if (chain === 'sol') return null;

  try {
    const chainId = chain === 'eth' ? 1 : 56;
    const baseUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}`;

    const creatorRes = await fetchWithRetry(
      `${baseUrl}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${etherscanKey}`
    );
    const creatorData = await creatorRes.json();
    console.log('DevCheck creatorData:', JSON.stringify(creatorData).slice(0, 300));

    const creator = creatorData?.result?.[0]?.contractCreator;
    if (!creator) {
      console.log('DevCheck: no creator found, aborting');
      return null;
    }

    const txRes = await fetchWithRetry(
      `${baseUrl}&module=account&action=txlist&address=${creator}&startblock=0&endblock=99999999&page=1&offset=200&sort=asc&apikey=${etherscanKey}`
    );
    const txData = await txRes.json();
    console.log('DevCheck txData status:', txData?.status, 'message:', txData?.message, 'result count:', Array.isArray(txData?.result) ? txData.result.length : 'not array');

    const txs = txData?.result;
    if (!Array.isArray(txs)) return { creator, deployCount: null };

    const deployments = txs.filter((tx) => tx.to === '' || tx.to === null);
    const uniqueContracts = new Set(deployments.map((tx) => tx.contractAddress).filter(Boolean));

    console.log(`DevCheck complete — creator: ${creator}, deployCount: ${uniqueContracts.size}`);
    return {
      creator,
      deployCount: uniqueContracts.size,
      firstTxDate: txs[0] ? new Date(Number(txs[0].timeStamp) * 1000) : null,
    };
  } catch (err) {
    console.error('DevCheck exception:', err.message);
    return null;
  }
}

function assessSafetyRisk(verified, liquidity, mintBad, devRiskFlag = false) {
  const verifiedBad  = verified.includes('⚠️') || verified.includes('❓');
  const liquidityBad = liquidity.includes('⚠️') || liquidity.includes('❓');
  const badSignals   = [verifiedBad, liquidityBad, mintBad, devRiskFlag].filter(Boolean).length;
  if (badSignals >= 2) return '🔴 HIGH RISK';
  if (badSignals === 1) return '🟡 CAUTION';
  return '🟢 LOW RISK';
}

function assessDevRisk(deployCount) {
  if (deployCount == null) return null;
  if (deployCount >= 10) return '🔴 Serial deployer — this wallet has launched 10+ contracts';
  if (deployCount >= 4) return '🟡 Repeat deployer — this wallet has launched multiple contracts';
  return null;
}
// ─── HOLDER ANALYSIS HELPERS ──────────────────────────────────────────────────

async function getEthTopHolders(address) {
  try {
    const res = await fetchWithRetry(
      `https://api.etherscan.io/v2/api?chainid=1&module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${etherscanKey}`
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
      `https://api.etherscan.io/v2/api?chainid=56&module=token&action=tokenholderlist&contractaddress=${address}&page=1&offset=10&apikey=${etherscanKey}`
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithRetry(
      `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenLargestAccounts',
          params: [address, { commitment: 'finalized' }],
        }),
      }
    );
    const data = await res.json();

    if (data.error) {
      const isOverloaded = data.error.message?.includes('overloaded');
      if (isOverloaded && attempt < 2) {
        console.log(`Helius overloaded, retrying (attempt ${attempt + 1})...`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`Helius error: ${data.error.message}`);
    }

    if (!data.result?.value?.length) throw new Error('No Solana holder data returned');
    return data.result.value.slice(0, 10).map((a) => ({
      address: a.address,
      balance: parseFloat(a.uiAmountString || a.uiAmount || 0),
    }));
  }
  throw new Error('Helius service unavailable after retries');
}
async function getTotalSupply(chain, address, ticker) {
  let dexSupply = null;
  try {
    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (pairs.length > 0) {
      const fdv = pairs[0].fdv;
      const price = parseFloat(pairs[0].priceUsd || 0);
      if (fdv && price > 0) {
        const supply = fdv / price;
        if (supply > 0) dexSupply = supply;
      }
    }
  } catch (err) {
    console.error('DexScreener supply fetch failed:', err.message);
  }

  let chainSupply = null;
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
      chainSupply = data.result?.value?.uiAmount || null;
    } else {
      const chainId = chain === 'eth' ? 1 : 56;
      const baseUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}`;
      const res = await fetchWithRetry(`${baseUrl}&module=stats&action=tokensupply&contractaddress=${address}&apikey=${etherscanKey}`);
      const data = await res.json();
      if (data.status === '1') {
        const dr = await fetchWithRetry(`${baseUrl}&module=token&action=tokeninfo&contractaddress=${address}&apikey=${etherscanKey}`);
        const dd = await dr.json();
        const decimals = parseInt(dd.result?.[0]?.decimals || 18);
        chainSupply = parseFloat(data.result) / Math.pow(10, decimals);
      }
    }
  } catch (err) {
    console.error('Chain supply fetch failed:', err.message);
  }

  // Prefer chain-native supply — it's the ground truth.
  if (chainSupply && chainSupply > 0) return chainSupply;
  if (dexSupply && dexSupply > 0) return dexSupply;

  // Final fallback: CMC — useful for BTC and majors with no DEX pair
  try {
    const res = await fetchWithRetry(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${ticker || ''}&convert=USD`,
      { headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY, 'Accept': 'application/json' } }
    );
    const data = await res.json();
    const entries = data?.data?.[(ticker || '').toUpperCase()];
    const coin = Array.isArray(entries) ? entries[0] : entries;
    const supply = coin?.total_supply || coin?.circulating_supply;
    if (supply && supply > 0) return supply;
  } catch (err) {
    console.error('CMC supply fallback failed:', err.message);
  }

  return null;
}

async function getTopHoldersWithPercentage(chain, address, ticker) {
  let holders;
  switch (chain) {
    case 'eth': holders = await getEthTopHolders(address); break;
    case 'bsc': holders = await getBscTopHolders(address); break;
    case 'sol':
      try {
        holders = await getSolTopHolders(address);
      } catch (err) {
        console.error('Helius holder fetch failed:', err.message);
        throw new Error('Could not fetch Solana holders — check Helius API key');
      }
      break;
    default: throw new Error('Unsupported chain');
  }

  let totalSupply = await getTotalSupply(chain, address, ticker);
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
  // Try CoinMarketCap first — best coverage for BTC and high-cap alts
  try {
    const res = await fetchWithRetry(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${ticker}&convert=USD`,
      { headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY, 'Accept': 'application/json' } }
    );
    const data = await res.json();
    if (data?.status?.error_code) {
      console.error('CMC error:', data.status.error_code, data.status.error_message);
    }
    const entries = data?.data?.[ticker.toUpperCase()];
    const coin = Array.isArray(entries) ? entries[0] : entries;
    if (coin) {
      const q = coin.quote?.USD;
      return {
        name:      coin.name,
        symbol:    coin.symbol,
        price:     q?.price,
        change24h: q?.percent_change_24h,
        change7d:  q?.percent_change_7d,
        marketCap: q?.market_cap,
        volume24h: q?.volume_24h,
        ath:       null,
        logoImage: coin.id ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${coin.id}.png` : null,
      };
    }
  } catch (err) {
    console.error('CMC price fetch failed:', err.message);
  }

  // Fallback: CoinGecko
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

  // Final fallback: DexScreener
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
    const res = await fetchWithRetry(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=10&sort=percent_change_24h&sort_dir=desc&convert=USD',
      { headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY, 'Accept': 'application/json' } }
    );
    const data = await res.json();
    if (!data?.data?.length) throw new Error(`No CMC data: ${JSON.stringify(data?.status)}`);
    trendingCache = data.data.map((c, i) => ({
      rank:      i + 1,
      name:      c.name,
      symbol:    c.symbol,
      change24h: c.quote?.USD?.percent_change_24h,
      price:     c.quote?.USD?.price,
    }));
    trendingCacheTime = Date.now();
    return trendingCache;
  } catch (err) {
    console.error('CMC trending fetch failed:', err.message);
  }

  // Fallback: CoinCap — free, no key needed
  try {
    const res = await fetch('https://api.coincap.io/v2/assets?limit=10&sort=changePercent24Hr&direction=desc');
    const data = await res.json();
    if (!data?.data?.length) throw new Error('No CoinCap data');
    trendingCache = data.data.map((c, i) => ({
      rank:      i + 1,
      name:      c.name,
      symbol:    c.symbol,
      change24h: parseFloat(c.changePercent24Hr || 0),
      price:     parseFloat(c.priceUsd || 0),
    }));
    trendingCacheTime = Date.now();
    return trendingCache;
  } catch (err) {
    console.error('CoinCap trending fallback failed:', err.message);
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
        // Collapse chains where the same funds hop through multiple wallets
    // (A→B→C counted as 2 separate "whale moves" when it's really 1 actor)
    const toAddresses = new Set(parsed.map((tx) => tx.to));
    const filtered = parsed.filter((tx) => !toAddresses.has(tx.from));
        const whales = filtered.sort((a, b) => b.value - a.value).slice(0, 5);
        return whales.map((tx, i) => {
          const val = tx.value >= 1e6 ? `${(tx.value / 1e6).toFixed(2)}M`
                    : tx.value >= 1e3 ? `${(tx.value / 1e3).toFixed(2)}K`
                    : tx.value.toFixed(2);
          return `${i + 1}. 🐋 ${val} ${ticker}\n   From: \`${tx.from.slice(0, 8)}...\` → \`${tx.to.slice(0, 8)}...\`\n   ${tx.time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        }).join('\n\n');
      }
    }

    // Fallback to Etherscan
    const chainId = chain === 'eth' ? 1 : 56;
    const baseUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}`;
    const res = await fetchWithRetry(
      `${baseUrl}&module=account&action=tokentx&contractaddress=${address}&page=1&offset=50&sort=desc&apikey=${etherscanKey}`
    );
    const data = await res.json();
    const txs = data?.result;
    if (!Array.isArray(txs) || txs.length === 0) return '⚠️ No recent transfers found.';
    const decimals = parseInt(txs[0]?.tokenDecimal || 18);

    // Dedupe by transaction hash — a single tx can emit multiple transfer events (router hops)
    const seenHashes = new Set();
    const parsed = [];
    for (const tx of txs) {
      if (seenHashes.has(tx.hash)) continue;
      seenHashes.add(tx.hash);
      parsed.push({
        from:  tx.from,
        to:    tx.to,
        value: parseFloat(tx.value) / Math.pow(10, decimals),
        time:  new Date(Number(tx.timeStamp) * 1000),
      });
    }

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

async function hasSeenOkxAnnouncement(id) {
  const r = await pool.query('SELECT 1 FROM seen_okx_announcements WHERE announcement_id = $1', [id]);
  return r.rows.length > 0;
}

async function markOkxAnnouncementSeen(id) {
  await pool.query('INSERT INTO seen_okx_announcements (announcement_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

async function countSeenOkxAnnouncements() {
  const r = await pool.query('SELECT COUNT(*) FROM seen_okx_announcements');
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

// ─── UNIVERSAL MESSAGE STYLING ─────────────────────────────────────────────
//
// Every message CoinRadar sends — results, confirmations, loading messages,
// errors, everything — gets wrapped in the same bordered/monospace look so
// the bot's replies are visually distinct from a normal Telegram chat.
//
// What Telegram's Bot API actually supports (and doesn't):
//   - NO custom fonts. NO CSS-style borders. The platform doesn't expose
//     either of those to bots — no formatting trick can fake them.
//   - <code> DOES render in a real monospace font, which reads as visually
//     different from Telegram's normal proportional text.
//   - <blockquote> DOES render as a block with a vertical accent line down
//     the left edge — the closest real equivalent Telegram has to a "border".
// This is built on those two real features: a monospace box-drawn header,
// then the message body inside a blockquote.
//
// Because the rest of the file was written using Markdown-style formatting
// (*bold*, `code`, etc.) before this system existed, wrapBoxed() below also
// converts basic Markdown to the HTML tags this box format requires, so
// every existing message keeps working without having to rewrite all ~100
// send calls throughout the file by hand.

// Escapes characters that would otherwise break Telegram's HTML parser.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Converts the small subset of Markdown used throughout this file
// (*bold*, `code`) into the equivalent HTML tags. Runs AFTER escapeHtml
// on the raw text is not correct here — instead we escape first, then
// reintroduce only the specific tags we generate ourselves, so any HTML-like
// text the user or an API response contains can't be misinterpreted as a tag.
function markdownFragmentsToHtml(text) {
  let result = escapeHtml(text);
  result = result.replace(/\*(.+?)\*/g, '<b>$1</b>');   // *bold* -> <b>bold</b>
  result = result.replace(/`(.+?)`/g, '<code>$1</code>'); // `code` -> <code>code</code>
  result = result.replace(/_(.+?)_/g, '<i>$1</i>');      // _italic_ -> <i>italic</i>
  return result;
}

// The single shared box header. Kept identical across every message type
// per design — one universal look, not a different accent per category.
const BOX_TOP    = '┏━━━━━━━━━━━━━━━━━━━━━┓';
const BOX_BOTTOM = '┗━━━━━━━━━━━━━━━━━━━━━┛';

// Wraps any message text in the bordered/monospace box. `label` is a short
// all-caps line shown inside the header bar (e.g. "COINRADAR", "ALERT",
// "SAFETY CHECK") — kept generic and reused everywhere rather than a
// per-command custom header, per the "one universal style" design choice.
// The "COINRADAR" header bar has been removed globally — every message
// funnels through this one function (via the universal sendMessage/
// sendPhoto wrapper below), so this single change drops it everywhere at
// once, including listing alerts, without touching individual call sites.
// `label` is kept as a no-op parameter so existing call sites (which still
// pass e.g. 'NEW LISTING ALERT') don't need to be edited.
function wrapBoxed(text, _label = 'COINRADAR') {
  const body = markdownFragmentsToHtml(text);
  return `<blockquote>${body}</blockquote>`;
}

// Kept as an alias for clarity at call sites that never had a header to
// begin with (like /p) — functionally identical to wrapBoxed() now.
function wrapBoxedNoHeader(text) {
  const body = markdownFragmentsToHtml(text);
  return `<blockquote>${body}</blockquote>`;
}

// Coin logo images are intentionally NOT sent for price/safety-style
// commands (see isChartImage() and the sendPhoto wrapper below). Telegram
// renders photo bubbles at close to full chat width regardless of the
// image's actual pixel dimensions — only height responds to aspect ratio —
// so there was no way to make these visually smaller/narrower without
// dropping them. Charts (candlestick/TradingView snapshots) are real data
// visualizations and are still sent as photos.
function isChartImage(photo) {
  if (typeof photo !== 'string') return true; // Buffers are always chart snapshots here
  return /quickchart\.io|chart-img|tradingview/i.test(photo);
}

// Listing alerts have their own shape (exchange name, title, url, safety
// text) so they get a thin wrapper around wrapBoxed rather than reusing its
// generic single-text-block signature directly.
function formatListingAlert(exchangeName, title, url, safetyText) {
  const bodyText = `*${exchangeName}*\n${title}\n\n🔗 ${url || 'No link available'}${safetyText ? `\n\n${safetyText}` : ''}`;
  return wrapBoxed(bodyText, 'NEW LISTING ALERT');
}


async function broadcastToSubscribers(sendFn) {
  try {
    const now = Date.now();
    const users = await pool.query('SELECT user_id FROM paid_users WHERE expiry > $1', [now]);
    const chats = await pool.query('SELECT chat_id FROM paid_chats WHERE expiry > $1', [now]);

    const targets = new Set();
    for (const row of users.rows) targets.add(Number(row.user_id));
    for (const row of chats.rows) targets.add(Number(row.chat_id));
    if (myChatId) targets.add(Number(myChatId));

    for (const targetId of targets) {
      try {
        await sendFn(targetId);
        await new Promise((r) => setTimeout(r, 40)); // respect Telegram rate limits
      } catch (err) {
        console.error(`Broadcast failed for ${targetId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('broadcastToSubscribers error:', err.message);
  }
}

// Polls Bybit's public announcements feed every 5 minutes (see setInterval
// near the bottom of this file) looking for genuinely new token listings.
//
// How it avoids re-alerting on the same listing every poll:
//   1. Every announcement ID we've ever seen is stored in the
//      `seen_announcements` table.
//   2. On the very first run (empty table), we mark everything currently on
//      the feed as "seen" WITHOUT alerting — otherwise the bot would blast
//      out 20 alerts for listings that happened before it ever started.
//   3. On every run after that, only IDs not already in the table trigger
//      an alert, and immediately get marked seen so they never fire twice.
//
// Filtering: Bybit's feed mixes real listings in with promos, competitions,
// and maintenance notices, so we only act on titles matching listingKeywords.
async function checkBybitListings() {
  try {
    const res = await fetch(
      'https://api.bybit.com/v5/announcements/index?locale=en-US&limit=20',
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
      for (const item of items) {
        if (item.id) await markAnnouncementSeen(item.id);
      }
      console.log(`Initialized with ${items.length} existing Bybit announcements.`);
      return;
    }

    for (const item of items) {
      if (!item.id) continue;
      const titleLower = (item.title || '').toLowerCase();
      // Listing announcements come in many phrasings depending on category
      // (spot, innovation zone, perpetual contracts, margin/loans). We match
      // broadly on root words rather than exact phrases so we don't miss
      // variations like "Bybit to List X", "New listing: X", "has listed X".
      const listingKeywords = [
        'listing', 'listed', 'will list', 'to list',
        'new spot', 'innovation zone', 'perpetual contract',
        'new asset', 'launch', 'now live', 'now open', 'now available',
      ];
      const isListing = listingKeywords.some((kw) => titleLower.includes(kw));
      if (!isListing) continue;
      if (await hasSeenAnnouncement(item.id)) continue;
      await markAnnouncementSeen(item.id);
      listingsSeenToday++;

      // Run the safety check based on the ticker extracted from the title.
      // If extraction or the on-chain lookup fails, safetyResult is null and
      // the alert still sends — just without a safety section attached.
      const safetyResult = await runSafetyCheckByTitle(item.title);

      // Use the bordered/monospace formatting (see formatListingAlert) so
      // listing alerts are visually distinct from normal bot replies.
      const caption = formatListingAlert('Bybit', item.title, item.url, safetyResult?.text);

      await broadcastToSubscribers(async (targetId) => {
        if (safetyResult?.image) await bot.sendPhoto(targetId, safetyResult.image, { caption, parse_mode: 'HTML' });
        else await bot.sendMessage(targetId, caption, { parse_mode: 'HTML' });
      });
      console.log(`New listing: ${item.title}`);
    }
  } catch (err) {
    console.error('Bybit check error:', err.message);
  }
}
// Same pattern as checkBybitListings above, but against OKX's public
// announcements API. OKX doesn't give each announcement a clean numeric ID
// the way Bybit does, so we use the publish timestamp (pTime) — or the
// title itself as a last resort — as the dedup key instead, stored in its
// own `seen_okx_announcements` table (kept separate from Bybit's so IDs
// from the two exchanges can never collide with each other).
async function checkOkxListings() {
  try {
    const res = await fetch(
      'https://www.okx.com/api/v5/support/announcements?annType=announcements-new-listings',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoinRadarBot/1.0)', 'Accept': 'application/json' } }
    );
    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { console.error('Non-JSON from OKX:', rawText.slice(0, 200)); return; }

    const items = data?.data?.[0]?.details || data?.data || [];
    if (!Array.isArray(items) || items.length === 0) return;

    const alreadySeen = await countSeenOkxAnnouncements();
    if (alreadySeen === 0) {
      for (const item of items) {
        const id = item.pTime || item.title;
        if (id) await markOkxAnnouncementSeen(id);
      }
      console.log(`Initialized with ${items.length} existing OKX announcements.`);
      return;
    }

    for (const item of items) {
      const id = item.pTime || item.title;
      if (!id) continue;
      const titleLower = (item.title || '').toLowerCase();
      // OKX's announcement titles are fairly consistent ("OKX to list X for
      // spot trading" / "OKX will launch X for spot trading"), but we widen
      // the match slightly to also catch perpetuals, migrations, and other
      // listing-adjacent announcements without over-matching unrelated posts.
      const okxListingKeywords = ['list', 'launch', 'now live', 'now open', 'now available'];
      const isListing = okxListingKeywords.some((kw) => titleLower.includes(kw));
      if (!isListing) continue;
      if (await hasSeenOkxAnnouncement(id)) continue;
      await markOkxAnnouncementSeen(id);

      // Same safety-check + distinct-formatting treatment as Bybit above —
      // kept identical between the two so alerts feel consistent regardless
      // of which exchange triggered them.
      const safetyResult = await runSafetyCheckByTitle(item.title);
      const caption = formatListingAlert('OKX', item.title, item.url, safetyResult?.text);

      await broadcastToSubscribers(async (targetId) => {
        if (safetyResult?.image) await bot.sendPhoto(targetId, safetyResult.image, { caption, parse_mode: 'HTML' });
        else await bot.sendMessage(targetId, caption, { parse_mode: 'HTML' });
      });
      console.log(`New OKX listing: ${item.title}`);
    }
  } catch (err) {
    console.error('OKX check error:', err.message);
  }
}

// ─── BOT SETUP ────────────────────────────────────────────────────────────────

const bot = new TelegramBot(token, { polling: true });

// ─── AUTO REPLY-THREADING ──────────────────────────────────────────────────
//
// Every response the bot sends should reply-thread (Telegram's native
// "reply to" feature) to whichever incoming message triggered it. This is
// what actually pings the user — a plain "@username" written into message
// text is NOT a real mention entity and never notifies anyone, but a
// Telegram reply always notifies the author of the message being replied
// to (assuming they haven't muted the chat). This matters most for
// commands like /c or /chart where the real result comes some seconds
// after the "Fetching..." message — without threading, that delayed
// result is just an unlinked message the user can easily miss.
//
// IMPORTANT: this used to be implemented by wrapping bot.emit() for the
// 'message' event, on the assumption that onText() handlers were dispatched
// through that event. They are NOT — node-telegram-bot-api's onText() just
// pushes {regexp, callback} into an internal array, and processUpdate()
// calls matching callbacks directly, as a completely separate step AFTER
// (not nested inside) its emit('message', ...) call. So the previous
// version never actually wrapped any command handler and silently did
// nothing. The fix is to wrap onText() itself, since that's the actual
// dispatch path every command in this file goes through.
const messageReplyContext = new AsyncLocalStorage();
const originalOnText = bot.onText.bind(bot);
bot.onText = function (regexp, callback) {
  return originalOnText(regexp, (msg, match) => {
    return messageReplyContext.run(msg, () => callback(msg, match));
  });
};

// known_users tracking rides on the real 'message' event, which IS emitted
// normally by the library (it's onText specifically that skips it) — this
// part always worked correctly.
bot.on('message', (msg) => {
  if (msg.from?.id) recordKnownUser(msg);
});

// Fire-and-forget upsert — never blocks message handling, and a failure
// here shouldn't break the bot, just gets logged.
function recordKnownUser(msg) {
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || null);
  const now = Date.now();
  pool.query(
    `INSERT INTO known_users (user_id, chat_id, username, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (user_id) DO UPDATE SET chat_id = $2, username = $3, last_seen = $4`,
    [userId, msg.chat.id, username, now]
  ).catch((err) => console.error('recordKnownUser error:', err.message));
}

// ─── APPLY BOXED STYLING TO EVERY MESSAGE, EVERYWHERE ─────────────────────
//
// Rather than editing all ~100 bot.sendMessage/bot.sendPhoto calls scattered
// throughout this file by hand (error-prone, easy to miss one), we wrap the
// two methods themselves right here, once. From this point on, EVERY call
// to bot.sendMessage(...) or bot.sendPhoto(...) anywhere below this line —
// results, confirmations, loading messages, errors, everything — is
// automatically boxed before it goes out. Individual call sites don't need
// to know this is happening; they just call bot.sendMessage(chatId, text)
// exactly as before.
//
// We intentionally do NOT box messages that already set their own
// parse_mode to 'HTML' with pre-built markup (like the listing alerts,
// which build their own box via formatListingAlert) — otherwise they'd end
// up double-boxed.
const originalSendMessage = bot.sendMessage.bind(bot);
const originalSendPhoto   = bot.sendPhoto.bind(bot);

// Adds reply_to_message_id from the current async context, unless the
// call site already set one explicitly, or the target chat isn't the
// same chat the triggering message came from (e.g. an admin notification
// fired while handling someone else's command — can't reply across chats).
function withAutoReply(chatId, options) {
  if (options.reply_to_message_id !== undefined) return options;
  const currentMsg = messageReplyContext.getStore();
  if (!currentMsg || String(currentMsg.chat.id) !== String(chatId)) return options;
  return {
    ...options,
    reply_to_message_id: currentMsg.message_id,
    allow_sending_without_reply: true, // don't fail if original got deleted
  };
}

bot.sendMessage = function (chatId, text, options = {}) {
  const alreadyBoxed = options.parse_mode === 'HTML';
  const finalText = alreadyBoxed ? text : wrapBoxed(text);
  const finalOptions = withAutoReply(chatId, { ...options, parse_mode: 'HTML' });
  return originalSendMessage(chatId, finalText, finalOptions);
};

bot.sendPhoto = function (chatId, photo, options = {}) {
  const caption = options.caption || '';

  if (!isChartImage(photo)) {
    // Coin logo — drop the image, send just the boxed text. Forward all
    // other options as-is (parse_mode, reply_to_message_id, etc.) so a
    // caption that's already pre-boxed HTML (like /p's) doesn't get
    // wrapped a second time.
    const forwardOptions = { ...options };
    delete forwardOptions.caption;
    return bot.sendMessage(chatId, caption, forwardOptions);
  }

  const alreadyBoxed = options.parse_mode === 'HTML';
  const finalCaption = alreadyBoxed ? caption : wrapBoxed(caption);
  const finalOptions = withAutoReply(chatId, { ...options, caption: finalCaption, parse_mode: 'HTML' });
  return originalSendPhoto(chatId, photo, finalOptions);
};

bot.deleteMyCommands()
  .then(() => bot.setMyCommands([
    { command: 'start',    description: 'Start CoinRadar' },
    { command: 'c',        description: 'Safety check — /c pepe' },
    { command: 'w',        description: 'Top 10 holder chart — /w pepe' },
    { command: 'connections', description: 'Find shared whale wallets — /connections pepe' },
    { command: 'watchdev',   description: 'Watch a token\'s dev wallet' },
    { command: 'mywatches',  description: 'View your dev wallet watches' },
    { command: 'p',        description: 'Price lookup — /p pepe' },
    { command: 'chart',    description: 'Price chart — /chart BTCUSDT BINANCE 1h' },
    { command: 'trending', description: 'Top trending tokens right now' },
    { command: 'whale',    description: 'Recent whale transfers — /whale pepe' },
    { command: 'track',     description: 'Track a holding — /track BTC 0.5' },
    { command: 'portfolio', description: 'View your portfolio value' },
    { command: 'alert',    description: 'Set a price alert — /alert BTC 70000' },
    { command: 'myalerts', description: 'View your active alerts' },
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
  const payload = payment?.invoice_payload || '';
  const isGroupPayload = payload.includes('_group');
  const tier = payload.includes('pro') ? 'pro' : 'regular';
  const expiry = payment?.subscription_expiration_date
    ? payment.subscription_expiration_date * 1000
    : Date.now() + 30 * 24 * 60 * 60 * 1000;

  const tierLabel = tier === 'pro' ? 'Pro' : 'Regular';

  if (isGroupPayload) {
    await setPaidChat(chatId, expiry, tier);
    bot.sendMessage(chatId, `✅ Payment successful! This group now has *${tierLabel}* access for 30 days. Thanks for supporting CoinRadar 📡`, { parse_mode: 'Markdown' });
  } else {
    await setPaidUser(userId, expiry, tier);
    bot.sendMessage(chatId, `✅ Payment successful! You now have *${tierLabel}* access for 30 days. Thanks for supporting CoinRadar 📡`, { parse_mode: 'Markdown' });
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
const PREMIUM_COMMANDS = ['chart', 'whale', 'trending', 'alert', 'track', 'portfolio', 'watchdev', 'connections'];
const FREE_PREMIUM_TRIES = 2;

async function getUserTier(userId, chatId, isGroup) {
  if (isGroup) {
    const r = await pool.query('SELECT expiry, tier FROM paid_chats WHERE chat_id = $1', [chatId]);
    if (r.rows[0]?.expiry && Number(r.rows[0].expiry) > Date.now()) return r.rows[0].tier;
  }
  const r = await pool.query('SELECT expiry, tier FROM paid_users WHERE user_id = $1', [userId]);
  if (r.rows[0]?.expiry && Number(r.rows[0].expiry) > Date.now()) return r.rows[0].tier;
  return null;
}

async function premiumGate(msg, commandName) {
  const userId  = msg.from.id;
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (isAdmin(userId)) return true;

  const tier = await getUserTier(userId, chatId, isGroup);
  if (tier) return true;

const day = getTodayKey();
  const u = await pool.query(
    'SELECT count FROM usage_log WHERE user_id = $1 AND day = $2 AND command = $3',
    [userId, day, commandName]
  );
  const used = u.rows[0]?.count || 0;

  if (used >= FREE_PREMIUM_TRIES) {
    bot.sendMessage(
      chatId,
      `🔒 */${commandName}* is a Premium feature.\n\nYou've used your ${FREE_PREMIUM_TRIES} free daily tries. Use /upgrade for unlimited access.`,
      { parse_mode: 'Markdown' }
    );
    return false;
  }

  await pool.query(
    `INSERT INTO usage_log (user_id, day, command, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, day, command) DO UPDATE SET count = usage_log.count + 1`,
    [userId, day, commandName]
  );

  const remaining = FREE_PREMIUM_TRIES - used - 1;
  bot.sendMessage(chatId, `🎁 Free try of */${commandName}* (${remaining} left today). Use /upgrade for unlimited access.`);
  return true;
  }
// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const existing = await pool.query('SELECT 1 FROM paid_users WHERE user_id = $1', [userId]);
    const alreadyHasRecord = existing.rows.length > 0;

    const seenBefore = await pool.query('SELECT 1 FROM usage_log WHERE user_id = $1 LIMIT 1', [userId]);
    const isNewUser = seenBefore.rows.length === 0 && !alreadyHasRecord;

    if (isNewUser) {
      const settingRes = await pool.query(`SELECT value FROM bot_settings WHERE key = 'early_access_remaining'`);
      const remaining = parseInt(settingRes.rows[0]?.value || '0');

      if (remaining > 0) {
        const trialExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await pool.query(
          `INSERT INTO paid_users (user_id, expiry, tier) VALUES ($1, $2, 'pro')
           ON CONFLICT (user_id) DO UPDATE SET expiry = $2, tier = 'pro'`,
          [userId, trialExpiry]
        );
        await pool.query(
          `UPDATE bot_settings SET value = $1 WHERE key = 'early_access_remaining'`,
          [String(remaining - 1)]
        );

        bot.sendMessage(
          chatId,
          `📡 *Welcome to CoinRadar!*\n\n🎉 You're one of our first users — you've been granted *30 days of free Pro access* as a thank you!\n\nTrack prices, set alerts, check token safety, and monitor your portfolio — all from Telegram.\n\nType */help* to see everything CoinRadar can do.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }
  } catch (err) {
    console.error('/start early-access check failed:', err.message);
  }

  bot.sendMessage(
    chatId,
    `📡 *CoinRadar is online.*\n\nYour all-in-one crypto intelligence bot.\n\n` +
    `Track prices, set alerts, check token safety, and monitor your portfolio — all from Telegram.\n\n` +
    `Type */help* to see everything CoinRadar can do.`,
    { parse_mode: 'Markdown' }
  );
});
// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/^\/help$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📡 *CoinRadar Help*\n\n` +
    `Choose a topic for details:\n\n` +
    `*/help market* — Price, charts & safety checks\n` +
    `*/help alerts* — Price alerts\n` +
    `*/help portfolio* — Portfolio tracking\n` +
    `*/help account* — Subscription & usage\n\n` +
    `Free users: ${FREE_DAILY_LIMIT} checks/day across /c, /w, /p, and /whale.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help (.+)/, (msg, match) => {
  const topic = match[1].trim().toLowerCase();
  const chatId = msg.chat.id;

  if (topic === 'market') {
    return bot.sendMessage(
      chatId,
      `📡 *Market Commands*\n\n` +
      `*/whale <ticker>* — Recent large transfers\n` +
      `*/connections <ticker>* — Find shared whale wallets across tokens\n\n` +
      `*/w <ticker>* — Top 10 holder concentration chart\n` +
      `*/p <ticker>* — Price, market cap, 24h/7d change\n` +
      `*/watchdev <ticker>* — Alert on deployer wallet activity\n` +
      `*/mywatches* — View your dev wallet watches\n` +
      `*/chart <ticker> <exchange> <tf>* — Live TradingView chart\n` +
      `*/trending* — Top 10 gainers right now\n` +
      `*/whale <ticker>* — Recent large transfers\n\n` +
      `Chart example: \`/chart BTCUSDT BINANCE 1h\`\n` +
      `Timeframes: 1m 5m 15m 1h 4h 1D 1W`,
      { parse_mode: 'Markdown' }
    );
  }

  if (topic === 'alerts') {
    return bot.sendMessage(
      chatId,
      `🔔 *Price Alerts*\n\n` +
      `*/alert <ticker> <price> [recurring]* — Set an alert\n` +
      `*/myalerts* — View your active alerts\n` +
      `*/removealert <id>* — Cancel an alert\n\n` +
      `Example: \`/alert BTC 70000\`\n` +
      `Recurring example: \`/alert BTC 70000 recurring\`\n\n` +
      `Recurring alerts fire again each time the price crosses your target, instead of only once.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (topic === 'portfolio') {
    return bot.sendMessage(
      chatId,
      `💼 *Portfolio Tracking*\n\n` +
      `*/track <ticker> <amount>* — Add or update a holding\n` +
      `*/portfolio* — View your holdings & total value\n` +
      `*/untrack <ticker>* — Remove a holding\n\n` +
      `Example: \`/track BTC 0.5\`\n\n` +
      `Running /track again for the same ticker updates the amount instead of duplicating it.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (topic === 'account') {
    return bot.sendMessage(
      chatId,
      `👤 *Account & Subscription*\n\n` +
      `*/upgrade* — Subscribe for unlimited checks\n` +
      `*/mystatus* — Your subscription & usage today\n\n` +
      `Free users: ${FREE_DAILY_LIMIT} checks/day across /c, /w, /p, and /whale.\n` +
      `Alerts, portfolio, and trending don't count against your daily limit.`,
      { parse_mode: 'Markdown' }
    );
  }

  bot.sendMessage(chatId, `⚠️ Unknown help topic. Try /help to see available topics.`);
});

// ─── /c — SAFETY CHECK ────────────────────────────────────────────────────────

bot.onText(/^\/c$/, (msg) => bot.sendMessage(msg.chat.id, '🔍 Include a ticker, e.g. /c pepe'));

bot.onText(/\/c (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();

  bot.sendMessage(chatId, `🔍 Running safety check on *${ticker}*...`, { parse_mode: 'Markdown' });

  let contract = await getTokenContract(ticker);
  if (!contract) contract = await searchDexScreener(ticker);

  const nativeCoins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'LTC', 'AVAX', 'DOT', 'MATIC', 'TRX', 'XMR', 'ZEC'];

  if (!contract || !contract.address) {
    if (nativeCoins.includes(ticker)) {
      return bot.sendMessage(
        chatId,
        `ℹ️ *${ticker}* is a native blockchain asset, not a smart contract token — there's no contract, mint authority, or liquidity pool to check.\n\nTry */p ${ticker.toLowerCase()}* for price data instead.`,
        { parse_mode: 'Markdown' }
      );
    }
    return bot.sendMessage(chatId, `⚠️ Couldn't find *${ticker}* on-chain. Try the exact ticker (e.g. PEPE, not Pepecoin).`, { parse_mode: 'Markdown' });
  }
  const [verified, liquidityResult, age, volume, devHistory] = await Promise.all([
    checkContractVerified(contract.chain, contract.address),
    checkLiquidity(contract.address),
    checkTokenAge(contract.chain, contract.address),
    check24hTxVolume(contract.address),
    getDevWalletHistory(contract.chain, contract.address),
  ]);

  const devRisk = devHistory ? assessDevRisk(devHistory.deployCount) : null;
  const mintBad   = verified.includes('Mint authority active') || verified.includes('Freeze authority active');
  const riskScore = assessSafetyRisk(verified, liquidityResult.text, mintBad, !!devRisk);
  const image     = liquidityResult.image || contract.logoImage || null;

  const devLine = devRisk ? `\nDev wallet: ${devRisk} (${devHistory.deployCount} contracts)\n` : '';

  const caption =
    `🔍 *Safety Check — ${ticker} (${contract.chain.toUpperCase()})*\n\n` +
    `Contract:  ${verified}\n` +
    `Liquidity: ${liquidityResult.text}\n` +
    `Age:       ${age}\n` +
    `24h Vol:   ${volume}\n${devLine}\n` +
    `*${riskScore}*`;
  if (image) bot.sendPhoto(chatId, image, { caption, parse_mode: 'Markdown' });
  else bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
});

// ─── /w — HOLDER CHART ────────────────────────────────────────────────────────

bot.onText(/^\/w$/, (msg) => bot.sendMessage(msg.chat.id, '📊 Include a ticker, e.g. /w pepe'));

bot.onText(/\/w (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();
  bot.sendMessage(chatId, `📊 Fetching holder data for *${ticker}*...`, { parse_mode: 'Markdown' });

  try {
    let contract = await getTokenContract(ticker);
    if (!contract) contract = await searchDexScreener(ticker);
    if (!contract || !contract.address) {
      return bot.sendMessage(chatId, `⚠️ Couldn't find *${ticker}* on-chain.`, { parse_mode: 'Markdown' });
    }

    const { holders, top10Total, totalSupply } = await getTopHoldersWithPercentage(contract.chain, contract.address, ticker);
    // Save this snapshot for cross-token wallet correlation
    try {
      const checkedAt = Date.now();
      for (const h of holders) {
        await pool.query(
          `INSERT INTO holder_snapshots (ticker, chain, wallet_address, percentage, checked_at) VALUES ($1, $2, $3, $4, $5)`,
          [ticker, contract.chain, h.address, h.percentage, checkedAt]
        );
      }
    } catch (err) {
      console.error('Failed to save holder snapshot:', err.message);
           }
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

// ─── /connections ─────────────────────────────────────────────────────────────

bot.onText(/^\/connections$/, (msg) => bot.sendMessage(msg.chat.id, '🕸️ Usage: /connections <ticker>\nExample: /connections pepe\n\nFinds other tokens sharing the same top wallets.\n\nNote: only works on tokens someone has already run /w on.'));

bot.onText(/\/connections (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();

  if (!(await premiumGate(msg, 'connections'))) return;

  bot.sendMessage(chatId, `🕸️ Checking wallet connections for *${ticker}*...`, { parse_mode: 'Markdown' });

  try {
    // Get the most recent snapshot's wallets for this ticker
    const latestCheck = await pool.query(
      `SELECT MAX(checked_at) as latest FROM holder_snapshots WHERE ticker = $1`,
      [ticker]
    );
    const latestTime = latestCheck.rows[0]?.latest;

    if (!latestTime) {
      return bot.sendMessage(
        chatId,
        `⚠️ No holder data found for *${ticker}*.\n\nRun */w ${ticker.toLowerCase()}* first, then try /connections again.`,
        { parse_mode: 'Markdown' }
      );
    }

    const ourWallets = await pool.query(
      `SELECT wallet_address, percentage FROM holder_snapshots WHERE ticker = $1 AND checked_at = $2`,
      [ticker, latestTime]
    );
    const walletAddresses = ourWallets.rows.map((r) => r.wallet_address);

    if (walletAddresses.length === 0) {
      return bot.sendMessage(chatId, `⚠️ No wallet data found for *${ticker}*.`, { parse_mode: 'Markdown' });
    }

    // Find these same wallets holding OTHER tokens
    const matches = await pool.query(
      `SELECT DISTINCT ticker, wallet_address, percentage
       FROM holder_snapshots
       WHERE wallet_address = ANY($1) AND ticker != $2
       ORDER BY percentage DESC`,
      [walletAddresses, ticker]
    );

    if (matches.rows.length === 0) {
      return bot.sendMessage(
        chatId,
        `🕸️ *${ticker} Wallet Connections*\n\nNo shared top-holder wallets found with other tracked tokens yet.\n\nThis grows as more people run /w on different tokens.`,
        { parse_mode: 'Markdown' }
      );
    }

    // Group by ticker to avoid duplicate spam if a wallet appears in multiple old snapshots of the same token
    const seen = new Set();
    const lines = [];
    for (const row of matches.rows) {
      const key = `${row.ticker}-${row.wallet_address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`*${row.ticker}* — \`${row.wallet_address.slice(0, 6)}...${row.wallet_address.slice(-4)}\` holds ${Number(row.percentage).toFixed(2)}%`);
      if (lines.length >= 10) break;
    }

    bot.sendMessage(
      chatId,
      `🕸️ *${ticker} Wallet Connections*\n\nTop holders of ${ticker} also appear in:\n\n${lines.join('\n')}\n\n_Shared whale wallets across tokens can indicate common backers, insider coordination, or unrelated coincidence — always verify independently._`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('/connections error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to check wallet connections.');
  }
});

// ─── /watchdev ────────────────────────────────────────────────────────────────

bot.onText(/^\/watchdev$/, (msg) => bot.sendMessage(msg.chat.id, '👁️ Usage: /watchdev <ticker>\nExample: /watchdev pepe\n\nGet notified if the token\'s deployer wallet moves funds after being inactive.'));

bot.onText(/\/watchdev (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'there');
  const ticker = match[1].trim().toUpperCase();

  if (!(await premiumGate(msg, 'watchdev'))) return;
  const tierForLimits = await getUserTier(userId, chatId, msg.chat.type === 'group' || msg.chat.type === 'supergroup');
  if (tierForLimits !== 'pro' && !isAdmin(userId)) {
    const countRes = await pool.query('SELECT COUNT(*) FROM dev_watches WHERE user_id = $1', [userId]);
    const activeCount = Number(countRes.rows[0].count);
    const maxSlots = tierForLimits === 'regular' ? 3 : 1;
    if (activeCount >= maxSlots) {
      return bot.sendMessage(chatId, `🔒 You've reached your limit of ${maxSlots} active dev watch${maxSlots === 1 ? '' : 'es'}.\n\nUpgrade to *Pro* for unlimited watch slots.`, { parse_mode: 'Markdown' });
    }
  }

  bot.sendMessage(chatId, `👁️ Looking up deployer for *${ticker}*...`, { parse_mode: 'Markdown' });

  let contract = await getTokenContract(ticker);
  if (!contract) contract = await searchDexScreener(ticker);
  if (!contract || !contract.address) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find *${ticker}* on-chain.`, { parse_mode: 'Markdown' });
  }

  if (contract.chain === 'sol') {
    return bot.sendMessage(chatId, `⚠️ Dev wallet watching isn't available for Solana tokens yet — this feature currently supports ETH and BSC only.`);
  }

  const devHistory = await getDevWalletHistory(contract.chain, contract.address);
  if (!devHistory || !devHistory.creator) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find the deployer wallet for *${ticker}*.`, { parse_mode: 'Markdown' });
  }

  try {
    await pool.query(
      `INSERT INTO dev_watches (user_id, chat_id, username, ticker, chain, dev_address, last_tx_hash, last_checked_at, created_at, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7, $8)
       ON CONFLICT (user_id, ticker) DO UPDATE SET dev_address = $6, chain = $5, last_tx_hash = NULL, last_checked_at = $7, message_id = $8`,
      [userId, chatId, username, ticker, contract.chain, devHistory.creator, Date.now(), msg.message_id]
    );

    bot.sendMessage(
      chatId,
      `👁️ *Dev Watch Active* — ${ticker}\n\nDeployer wallet:\n\`${devHistory.creator}\`\n\nThis wallet is now being monitored continuously. If it moves funds after a period of silence — often a signal worth acting on before others notice — you'll be alerted immediately.\n\nUse /mywatches to see all your watched tokens.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('/watchdev error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to set up dev wallet watch.');
  }
});

// ─── /mywatches ───────────────────────────────────────────────────────────────

bot.onText(/\/mywatches/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const r = await pool.query('SELECT id, ticker, dev_address FROM dev_watches WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    if (r.rows.length === 0) {
      return bot.sendMessage(chatId, '👁️ You have no dev wallet watches.\n\nUse /watchdev <ticker> to add one.');
    }

    const lines = r.rows.map((w) => `#${w.id} — *${w.ticker}* — \`${w.dev_address.slice(0, 8)}...${w.dev_address.slice(-4)}\``).join('\n');
    bot.sendMessage(chatId, `👁️ *Your Dev Wallet Watches*\n\n${lines}\n\nUse /unwatchdev <id> to remove one.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/mywatches error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to fetch your watches.');
  }
});

// ─── /unwatchdev ──────────────────────────────────────────────────────────────

bot.onText(/\/unwatchdev (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const watchId = parseInt(match[1]);

  try {
    const r = await pool.query('DELETE FROM dev_watches WHERE id = $1 AND user_id = $2 RETURNING ticker', [watchId, userId]);
    if (r.rows.length === 0) {
      return bot.sendMessage(chatId, `⚠️ Watch #${watchId} not found.`);
    }
    bot.sendMessage(chatId, `✅ Stopped watching *${r.rows[0].ticker}*'s dev wallet.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/unwatchdev error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to remove watch.');
  }
});
// ─── /p — PRICE ───────────────────────────────────────────────────────────────

bot.onText(/^\/p$/, (msg) => bot.sendMessage(msg.chat.id, '💰 Include a ticker, e.g. /p pepe'));

bot.onText(/\/p (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ticker = match[1].trim().toUpperCase();

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

  const priceStr = data.price != null ? `$${data.price.toLocaleString(undefined, { maximumSignificantDigits: 6 })}` : 'N/A';

  const rawCaption =
    `💰 *${data.name} (${data.symbol})*\n\n` +
    `Price:      *${priceStr}*\n` +
    `24h change: ${change24hStr}\n` +
    `7d change:  ${change7dStr}\n` +
    `Market cap: ${fmt(data.marketCap)}\n` +
    `24h volume: ${fmt(data.volume24h)}\n` +
    `ATH:        ${data.ath != null ? `$${data.ath.toLocaleString()}` : 'N/A'}`;

  // Built as pre-boxed HTML (no header bar) so we bypass the universal
  // auto-wrap that would otherwise add the "COINRADAR" header on top.
  const caption = wrapBoxedNoHeader(rawCaption);

  if (data.logoImage) bot.sendPhoto(chatId, data.logoImage, { caption, parse_mode: 'HTML' });
  else bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
});

// ─── /trending ────────────────────────────────────────────────────────────────

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🔥 Fetching trending tokens...`);
if (!(await premiumGate(msg, 'trending'))) return;
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
if (!(await premiumGate(msg, 'whale'))) return;
  
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


// ─── /track ───────────────────────────────────────────────────────────────────

bot.onText(/^\/track$/, (msg) => bot.sendMessage(msg.chat.id, '💼 Usage: /track <ticker> <amount>\nExample: /track BTC 0.5\n\nUse /portfolio to view your holdings.'));

bot.onText(/\/track (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const parts = match[1].trim().split(/\s+/);
if (!(await premiumGate(msg, 'track'))) return;
  if (parts.length < 2) {
    return bot.sendMessage(chatId, '💼 Usage: /track <ticker> <amount>\nExample: /track BTC 0.5');
  }

  const ticker = parts[0].toUpperCase();
  const amount = parseFloat(parts[1]);

  if (isNaN(amount) || amount <= 0) {
    return bot.sendMessage(chatId, '⚠️ Please enter a valid amount, e.g. /track BTC 0.5');
  }

  const priceData = await fetchPrice(ticker);
  if (!priceData || !priceData.price) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find price data for *${ticker}*.`, { parse_mode: 'Markdown' });
  }

  try {
    await pool.query(
      `INSERT INTO holdings (user_id, ticker, amount, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, ticker) DO UPDATE SET amount = $3`,
      [userId, ticker, amount, Date.now()]
    );

    const value = amount * priceData.price;
    bot.sendMessage(
      chatId,
      `💼 Tracking *${amount} ${ticker}*\n\nCurrent price: $${priceData.price.toLocaleString(undefined, { maximumSignificantDigits: 6 })}\nValue: $${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n\nUse /portfolio to view your full portfolio.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('/track error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to save holding. Please try again.');
  }
});

// ─── /untrack ─────────────────────────────────────────────────────────────────

bot.onText(/\/untrack (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ticker = match[1].trim().toUpperCase();

  try {
    const r = await pool.query('DELETE FROM holdings WHERE user_id = $1 AND ticker = $2 RETURNING ticker', [userId, ticker]);
    if (r.rows.length === 0) {
      return bot.sendMessage(chatId, `⚠️ You're not tracking *${ticker}*.`, { parse_mode: 'Markdown' });
    }
    bot.sendMessage(chatId, `✅ Removed *${ticker}* from your portfolio.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/untrack error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to remove holding.');
  }
});
// ─── /portfolio ───────────────────────────────────────────────────────────────

bot.onText(/\/portfolio/, async (msg) => {  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const r = await pool.query('SELECT ticker, amount FROM holdings WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
    if (r.rows.length === 0) {
      return bot.sendMessage(chatId, '💼 You have no tracked holdings.\n\nUse /track <ticker> <amount> to add one.');
    }
if (!(await premiumGate(msg, 'portfolio'))) return;
    bot.sendMessage(chatId, '💼 Fetching your portfolio...');

    let totalValue = 0;
    const lines = [];

    for (const holding of r.rows) {
      const priceData = await fetchPrice(holding.ticker);
      if (!priceData || !priceData.price) {
        lines.push(`*${holding.ticker}*: ${holding.amount} — ❓ price unavailable`);
        continue;
      }
      const value = Number(holding.amount) * priceData.price;
      totalValue += value;
      const changeStr = priceData.change24h != null
        ? ` (${priceData.change24h >= 0 ? '+' : ''}${priceData.change24h.toFixed(1)}%)`
        : '';
      lines.push(`*${holding.ticker}*: ${holding.amount} — $${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${changeStr}`);
    }

    const caption =
      `💼 *Your Portfolio*\n\n${lines.join('\n')}\n\n` +
      `*Total value: $${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}*`;

    bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/portfolio error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to fetch your portfolio.');
  }
});
// ─── /alert ───────────────────────────────────────────────────────────────────

bot.onText(/^\/alert$/, (msg) => bot.sendMessage(msg.chat.id, '🔔 Usage: /alert <ticker> <target price> [recurring]\nExample: /alert BTC 70000\nExample (recurring): /alert BTC 70000 recurring\n\nUse /myalerts to see your active alerts.'));

bot.onText(/\/alert (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'there');
  const parts = match[1].trim().split(/\s+/);

  if (parts.length < 2) {
    return bot.sendMessage(chatId, '🔔 Usage: /alert <ticker> <target price> [recurring]\nExample: /alert BTC 70000');
  }

  const ticker = parts[0].toUpperCase();
  const targetPrice = parseFloat(parts[1]);
  const isRecurring = parts[2]?.toLowerCase() === 'recurring';

  if (isNaN(targetPrice) || targetPrice <= 0) {
    return bot.sendMessage(chatId, '⚠️ Please enter a valid target price, e.g. /alert BTC 70000');
  }

  if (!(await premiumGate(msg, 'alert'))) return;

  const tierForLimits = await getUserTier(userId, chatId, msg.chat.type === 'group' || msg.chat.type === 'supergroup');
  if (tierForLimits !== 'pro' && !isAdmin(userId)) {
    const countRes = await pool.query('SELECT COUNT(*) FROM price_alerts WHERE user_id = $1 AND triggered = FALSE', [userId]);
    const activeCount = Number(countRes.rows[0].count);
    const maxSlots = tierForLimits === 'regular' ? 3 : 1;
    if (activeCount >= maxSlots) {
      return bot.sendMessage(chatId, `🔒 You've reached your limit of ${maxSlots} active alert${maxSlots === 1 ? '' : 's'}.\n\nUpgrade to *Pro* for unlimited alert slots.`, { parse_mode: 'Markdown' });
    }
  }

  const priceData = await fetchPrice(ticker);
  if (!priceData || !priceData.price) {
    return bot.sendMessage(chatId, `⚠️ Couldn't find price data for *${ticker}*.`, { parse_mode: 'Markdown' });
  }

  const direction = targetPrice >= priceData.price ? 'above' : 'below';

  try {
    await pool.query(
      `INSERT INTO price_alerts (user_id, chat_id, username, ticker, target_price, direction, created_at, recurring, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, chatId, username, ticker, targetPrice, direction, Date.now(), isRecurring, msg.message_id]
    );

    const arrow = direction === 'above' ? '📈' : '📉';
    const recurringNote = isRecurring ? '\n\n🔁 *Recurring* — this alert fires every time the price crosses this level, not just once.' : '';
    bot.sendMessage(
      chatId,
      `🔔 *Alert Armed* — ${ticker}\n\nWatching 24/7. You'll be pinged the instant price crosses your target — no need to check back.\n\nCurrent: $${priceData.price.toLocaleString(undefined, { maximumSignificantDigits: 6 })}\nTarget: $${targetPrice.toLocaleString()} ${arrow}${recurringNote}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('/alert error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to set alert. Please try again.');
  }
});

// ─── /myalerts ────────────────────────────────────────────────────────────────

bot.onText(/\/myalerts/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const r = await pool.query(
      'SELECT id, ticker, target_price, direction, recurring FROM price_alerts WHERE user_id = $1 AND chat_id = $2 AND triggered = FALSE ORDER BY created_at DESC',
      [userId, chatId]
    );

    if (r.rows.length === 0) {
      return bot.sendMessage(chatId, '🔔 You have no active alerts.\n\nUse /alert <ticker> <price> to set one.');
    }

    const lines = r.rows.map((a) => {
      const arrow = a.direction === 'above' ? '📈' : '📉';
      const badge = a.recurring ? ' 🔁' : '';
      return `#${a.id} — *${a.ticker}* ${arrow} $${Number(a.target_price).toLocaleString()}${badge}`;
    }).join('\n');

    bot.sendMessage(
      chatId,
      `🔔 *Your Active Alerts*\n\n${lines}\n\nUse /removealert <id> to cancel one.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('/myalerts error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to fetch your alerts.');
  }
});

// ─── /removealert ─────────────────────────────────────────────────────────────

bot.onText(/\/removealert (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const alertId = parseInt(match[1]);

  try {
    const r = await pool.query(
      'DELETE FROM price_alerts WHERE id = $1 AND user_id = $2 AND chat_id = $3 RETURNING ticker',
      [alertId, userId, chatId]
    );
    if (r.rows.length === 0) {
      return bot.sendMessage(chatId, `⚠️ Alert #${alertId} not found.`);
    }
    bot.sendMessage(chatId, `✅ Removed alert for *${r.rows[0].ticker}*.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('/removealert error:', err.message);
    bot.sendMessage(chatId, '⚠️ Failed to remove alert.');
  }
});
// ─── /chart ───────────────────────────────────────────────────────────────────

bot.onText(/\/chart (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().toUpperCase().split(/\s+/);

  if (!(await premiumGate(msg, 'chart'))) return;
  
  if (parts.length < 3) {
    return bot.sendMessage(chatId, '📈 Usage: /chart <ticker> <exchange> <timeframe>\nExample: /chart BTCUSDT BINANCE 1h\n\nTimeframes: 1m 5m 15m 30m 1h 4h 1D 1W');
  }

  const [symbol, exchange, interval] = parts;

  const intervalMap = {
    '1M': '1m', '3M': '3m', '5M': '5m', '15M': '15m', '30M': '30m',
    '1H': '1h', '2H': '2h', '4H': '4h', '1D': '1D', '1W': '1W',
  };
  const tvInterval = intervalMap[interval] || interval.toLowerCase();

  bot.sendMessage(chatId, `📈 Fetching chart for *${symbol}* on *${exchange}* (${interval})...`, { parse_mode: 'Markdown' });

  try {
    const res = await fetchWithRetry('https://api.chart-img.com/v2/tradingview/advanced-chart', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.CHARTIMG_API_KEY || '',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        symbol: `${exchange}:${symbol}`,
        interval: tvInterval,
        theme: 'dark',
        width: 800,
        height: 500,
        studies: [{ name: 'Volume', forceOverlay: true }, { name: 'MACD' }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Chart API returned ${res.status}: ${errText.slice(0, 200)}`);
    }

    const buffer = await res.buffer();
    await bot.sendPhoto(chatId, buffer, {
      caption: `📈 *${symbol}* — ${exchange} — ${interval}\n_Powered by TradingView_`,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('/chart error:', err.message);
    const tvLink = `https://www.tradingview.com/chart/?symbol=${exchange}:${symbol}&interval=${tvInterval}`;
    bot.sendMessage(
      chatId,
      `📈 *${symbol}* on *${exchange}* (${interval})\n\n🔗 [Open chart on TradingView](${tvLink})\n\n_Live screenshot not available — open the link to view the chart._`,
      { parse_mode: 'Markdown', disable_web_page_preview: false }
    );
  }
});

// ─── /upgrade ─────────────────────────────────────────────────────────────────

bot.onText(/\/upgrade/, async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  const regularAmount = isGroup ? 1350 : 550;
  const proAmount     = isGroup ? 2500 : 900;
  const scopeLabel    = isGroup ? 'Group' : 'Individual';

  try {
    const regularLink = await bot.createInvoiceLink(
      `CoinRadar Regular — ${scopeLabel}`,
      'Unlimited use of all Premium commands. Up to 3 active alerts and 3 dev watches. Billed monthly via Telegram Stars, cancel anytime.',
      isGroup ? 'coinradar_regular_group' : 'coinradar_regular',
      '', 'XTR', [{ label: 'Regular — Monthly', amount: regularAmount }],
      { subscription_period: 2592000 }
    );
    const proLink = await bot.createInvoiceLink(
      `CoinRadar Pro — ${scopeLabel}`,
      'Everything in Regular, plus unlimited alerts & dev watches, and 10-minute dev wallet check speed. Billed monthly via Telegram Stars, cancel anytime.',
      isGroup ? 'coinradar_pro_group' : 'coinradar_pro',
      '', 'XTR', [{ label: 'Pro — Monthly', amount: proAmount }],
      { subscription_period: 2592000 }
    );

    bot.sendMessage(chatId, `📡 *Choose your CoinRadar plan:*\n\n*Regular* — ${regularAmount}⭐/mo\nUnlimited Premium commands, 3 alert & 3 dev-watch slots.\n\n*Pro* — ${proAmount}⭐/mo\nEverything in Regular, plus unlimited slots & faster dev-watch checks.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `⭐ Regular (${regularAmount} Stars/mo)`, url: regularLink }],
          [{ text: `⭐ Pro (${proAmount} Stars/mo)`, url: proLink }],
        ],
      },
    });
  } catch (err) {
    console.error('Invoice link error:', err.message);
    bot.sendMessage(chatId, '⚠️ Something went wrong generating the subscription links. Please try again.');
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

bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    console.log(`/broadcast blocked — from.id ${msg.from.id} does not match MY_CHAT_ID`);
    return bot.sendMessage(msg.chat.id, '⛔ Admins only.');
  }
  const text = (match[1] || '').trim();
  if (!text) {
    return bot.sendMessage(msg.chat.id, 'Usage: /broadcast <message>');
  }
  // Get every user who has ever messaged the bot. usage_log undercounts
  // badly — it only gets a row from the premium free-trial path, and the
  // admin is explicitly exempt from that logging — so known_users (updated
  // on every incoming message) is the real source of truth here.
  try {
    const r = await pool.query('SELECT DISTINCT user_id FROM known_users');
    const users = new Set(r.rows.map((row) => Number(row.user_id)));
    if (myChatId) users.add(Number(myChatId));
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

setTimeout(() => {
  checkBybitListings();
  setInterval(checkBybitListings, 5 * 60 * 1000);
}, 5000);
setTimeout(() => {
  checkOkxListings();
  setInterval(checkOkxListings, 5 * 60 * 1000);
}, 5000);
//----–—----------------------DEV WATCH BG CHECKER---------------------------------------------_-------------------------
async function checkDevWatches() {
  try {
    const r = await pool.query('SELECT * FROM dev_watches');
    if (r.rows.length === 0) return;

    for (const watch of r.rows) {
      try {
        const chainId = watch.chain === 'eth' ? 1 : 56;
        const baseUrl = `https://api.etherscan.io/v2/api?chainid=${chainId}`;
        const res = await fetchWithRetry(
          `${baseUrl}&module=account&action=txlist&address=${watch.dev_address}&startblock=0&endblock=99999999&page=1&offset=1&sort=desc&apikey=${etherscanKey}`
        );
        const data = await res.json();
        const latestTx = data?.result?.[0];
        if (!latestTx) continue;

        const isNewTx = watch.last_tx_hash && latestTx.hash !== watch.last_tx_hash;
        const silenceDays = watch.last_checked_at
          ? Math.floor((Date.now() - Number(latestTx.timeStamp) * 1000) / (1000 * 60 * 60 * 24))
          : null;

        if (isNewTx) {
          const mention = watch.username || 'there';
          const message =
            `👁️ *Dev Wallet Activity Detected!*\n\n` +
            `${mention} — *${watch.ticker}*'s deployer wallet just moved funds after a period of inactivity.\n\n` +
            `Wallet: \`${watch.dev_address.slice(0, 10)}...${watch.dev_address.slice(-4)}\`\n` +
            `Tx: \`${latestTx.hash.slice(0, 10)}...\`\n\n` +
            `_This can be routine activity or may precede a sell-off. Always verify independently._`;

          await bot.sendMessage(watch.chat_id, message, {
            parse_mode: 'Markdown',
            ...(watch.message_id ? { reply_to_message_id: watch.message_id, allow_sending_without_reply: true } : {}),
          });
        }

        await pool.query(
          'UPDATE dev_watches SET last_tx_hash = $1, last_checked_at = $2 WHERE id = $3',
          [latestTx.hash, Date.now(), watch.id]
        );
      } catch (err) {
        console.error(`Dev watch check failed for #${watch.id} (${watch.ticker}):`, err.message);
      }
    }
  } catch (err) {
    console.error('checkDevWatches error:', err.message);
  }
}
//------------ALERT BG CHECKER-----------------------------------------------------------------------&&&-&&&&&-&&&&&&--------
async function checkPriceAlerts() {
  try {
    const r = await pool.query('SELECT * FROM price_alerts WHERE triggered = FALSE');
    if (r.rows.length === 0) return;

    const byTicker = {};
    for (const alert of r.rows) {
      if (!byTicker[alert.ticker]) byTicker[alert.ticker] = [];
      byTicker[alert.ticker].push(alert);
    }

    for (const [ticker, alerts] of Object.entries(byTicker)) {
      const priceData = await fetchPrice(ticker);
      if (!priceData || !priceData.price) continue;
      const currentPrice = priceData.price;

      for (const alert of alerts) {
        const target = Number(alert.target_price);
        const hit = alert.direction === 'above' ? currentPrice >= target : currentPrice <= target;
        if (!hit) continue;

        const mention = alert.username || 'there';
        const arrow = alert.direction === 'above' ? '📈' : '📉';
        const message =
          `🔔 *Price Alert Triggered!*\n\n` +
          `${mention} ${arrow} *${ticker}* just went ${alert.direction} your target!\n\n` +
          `Target: $${target.toLocaleString()}\n` +
          `Current: $${currentPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;

        try {
          await bot.sendMessage(alert.chat_id, message, {
            parse_mode: 'Markdown',
            ...(alert.message_id ? { reply_to_message_id: alert.message_id, allow_sending_without_reply: true } : {}),
          });

          if (alert.recurring) {
            // Flip direction so it must cross back before firing again
            const newDirection = alert.direction === 'above' ? 'below' : 'above';
            await pool.query(
              'UPDATE price_alerts SET direction = $1 WHERE id = $2',
              [newDirection, alert.id]
            );
          } else {
            await pool.query('UPDATE price_alerts SET triggered = TRUE WHERE id = $1', [alert.id]);
          }
        } catch (err) {
          console.error(`Failed to notify alert #${alert.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('checkPriceAlerts error:', err.message);
  }
}

checkPriceAlerts();
setInterval(checkPriceAlerts, 60 * 1000);

setTimeout(() => {
  checkDevWatches();
  setInterval(checkDevWatches, 40 * 60 * 1000); // every 40 minutes
}, 8000);
// ─── BOOT ─────────────────────────────────────────────────────────────────────

console.log('📡 CoinRadar bot is running...');
if (myChatId) {
  bot.sendMessage(myChatId, '✅ CoinRadar started and is online. 📡');
}
