require("dotenv").config();
const { Connection, Keypair, VersionedTransaction, PublicKey, Transaction } = require("@solana/web3.js");
const fetch = require("node-fetch");
const bs58 = require("bs58");

// CONFIG
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const BUY_AMOUNT_USD = parseFloat(process.env.BUY_AMOUNT_USD || "10");
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || "30");
const SCAN_INTERVAL_MS = 2 * 60 * 1000; // 2 menit
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const JUP_API_KEY = process.env.JUP_API_KEY || "";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SKIP_SYMBOLS = ["SOL","WSOL","USDC","USDT","ETH","BTC","WBTC","BONK","WIF","JUP","RAY","ORCA"];
const MAX_TOKEN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // max 1 minggu

// Jupiter endpoint
const JUP_BASE = JUP_API_KEY ? "https://api.jup.ag" : "https://public.jupiterapi.com";
const JUP_HEADERS = JUP_API_KEY
  ? { "Content-Type": "application/json", "x-api-key": JUP_API_KEY }
  : { "Content-Type": "application/json" };

if (!PRIVATE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Isi semua variable di .env dulu!"); process.exit(1);
}

const connection = new Connection(RPC_URL, "confirmed");
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletAddress = keypair.publicKey.toBase58();
let activePosition = null;
const scannedTokens = new Set();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomTP() { return Math.floor(Math.random() * (100 - 20 + 1)) + 20; }

// TELEGRAM
async function sendTelegram(msg, keyboard = null) {
  const body = { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) { console.error("Telegram error:", err.message); }
}

async function answerCallback(id, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

async function pollUpdates() {
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=10`);
      const data = await res.json();
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        if (update.callback_query) await handleCallback(update.callback_query);
      }
    } catch (err) { console.error("Poll error:", err.message); }
    await sleep(1000);
  }
}

async function handleCallback(cb) {
  await answerCallback(cb.id, "Diproses...");
  if (cb.data === "sell_now") {
    if (!activePosition) { await sendTelegram("Tidak ada posisi aktif."); return; }
    await sendTelegram("Manual sell dieksekusi...");
    await executeSell("manual");
  }
}

// DEXSCREENER - fetch beberapa endpoint sekaligus
async function getNewPairs() {
  try {
    const endpoints = [
      "https://api.dexscreener.com/latest/dex/search?q=pump&rankBy=trendingScoreH1&order=desc",
      "https://api.dexscreener.com/latest/dex/search?q=sol&rankBy=trendingScoreH1&order=desc",
      "https://api.dexscreener.com/latest/dex/search?q=moon&rankBy=trendingScoreH1&order=desc",
      "https://api.dexscreener.com/latest/dex/search?q=pepe&rankBy=trendingScoreH1&order=desc",
      "https://api.dexscreener.com/token-profiles/latest/v1",
    ];
    const results = await Promise.all(endpoints.map(url =>
      fetch(url).then(r => r.json()).catch(() => ({ pairs: [] }))
    ));
    // endpoint token-profiles ngembaliin array langsung, bukan { pairs: [] }
    const allPairs = results.flatMap(d => Array.isArray(d) ? [] : (d.pairs || []));
    // ambil mint dari token-profiles dan fetch detail pairnya
    const profileMints = Array.isArray(results[4]) ? results[4].map(t => t.tokenAddress).filter(Boolean).slice(0, 20) : [];
    let profilePairs = [];
    if (profileMints.length > 0) {
      try {
        const profileRes = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${profileMints.join(",")}`);
        const profileData = await profileRes.json();
        profilePairs = Array.isArray(profileData) ? profileData : [];
      } catch {}
    }
    const combined = [...allPairs, ...profilePairs];
    const seen = new Set();
    const unique = combined.filter(p => {
      const addr = p.baseToken?.address;
      if (!addr || seen.has(addr)) return false;
      seen.add(addr);
      return p.chainId === "solana";
    });
    console.log(`Pairs fetched: ${unique.length}`);
    return unique;
  } catch (err) { console.error("Dexscreener error:", err.message); return []; }
}

async function getTokenPrice(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    const data = await res.json();
    return parseFloat(data[0]?.priceUsd || 0);
  } catch { return 0; }
}

// RUGCHECK
async function checkRug(mint) {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const risks = data.risks || [];
    const score = data.score || 0;
    const redFlags = risks.filter(r =>
      r.level === "danger" ||
      r.name.toLowerCase().includes("honeypot") ||
      r.name.toLowerCase().includes("freeze") ||
      r.name.toLowerCase().includes("bundle")
    );
    const isSafe = redFlags.length === 0 && score < 5000;
    console.log(`[RugCheck] ${isSafe?"SAFE":"DANGER"} score:${score} risks:${risks.map(r=>r.name).join(",") || "none"}`);
    return { safe: isSafe, score, risks: risks.map(r => r.name), redFlags: redFlags.map(r => r.name) };
  } catch (err) {
    console.error("RugCheck error:", err.message);
    return { safe: false, score: 9999, risks: ["rugcheck_unavailable"], redFlags: ["rugcheck_unavailable"] };
  }
}

// JUPITER SWAP dengan fallback
async function getSOLPrice() {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`);
    const data = await res.json();
    return parseFloat(data[0]?.priceUsd || 150);
  } catch { return 150; }
}

async function swapJupiter(inputMint, outputMint, amount) {
  const quoteRes = await fetch(`${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=1000`, { headers: JUP_HEADERS });
  const quote = await quoteRes.json();
  if (!quote.outAmount) throw new Error("No Jupiter quote");
  const swapRes = await fetch(`${JUP_BASE}/swap`, {
    method: "POST", headers: JUP_HEADERS,
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: walletAddress, wrapAndUnwrapSol: true }),
  });
  const swapData = await swapRes.json();
  if (!swapData.swapTransaction) throw new Error("No Jupiter tx");
  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  return { sig, outAmount: quote.outAmount };
}

async function swapJupiterV2(inputMint, outputMint, amount) {
  // Fallback: slippage lebih tinggi
  const quoteRes = await fetch(`${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=2000&onlyDirectRoutes=false`, { headers: JUP_HEADERS });
  const quote = await quoteRes.json();
  if (!quote.outAmount) throw new Error("No Jupiter v2 quote");
  const swapRes = await fetch(`${JUP_BASE}/swap`, {
    method: "POST", headers: JUP_HEADERS,
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: walletAddress, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  const swapData = await swapRes.json();
  if (!swapData.swapTransaction) throw new Error("No Jupiter v2 tx");
  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  return { sig, outAmount: quote.outAmount };
}

async function swap(inputMint, outputMint, amount) {
  // Coba Jupiter biasa dulu
  try {
    console.log("[Swap] Trying Jupiter...");
    const result = await swapJupiter(inputMint, outputMint, amount);
    console.log("[Swap] Jupiter success");
    return { success: true, ...result };
  } catch (err) {
    console.log(`[Swap] Jupiter failed: ${err.message}, trying fallback...`);
  }
  // Fallback Jupiter dengan slippage lebih tinggi
  try {
    const result = await swapJupiterV2(inputMint, outputMint, amount);
    console.log("[Swap] Jupiter fallback success");
    return { success: true, ...result };
  } catch (err) {
    console.log(`[Swap] All swap methods failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function executeBuy(mint, symbol) {
  const solPrice = await getSOLPrice();
  const lamports = Math.floor((BUY_AMOUNT_USD / solPrice) * 1e9);
  const result = await swap(SOL_MINT, mint, lamports);
  if (!result.success) { await sendTelegram(`❌ Buy gagal *${symbol}*: ${result.error}`); return; }
  const buyPrice = await getTokenPrice(mint);
  const tp = randomTP();
  activePosition = { mint, symbol, buyPrice, tokenAmount: result.outAmount, buyTime: Date.now(), tp };
  await sendTelegram(
    `✅ *Auto Buy: ${symbol}*\n\nBuy price: $${buyPrice.toFixed(8)}\nAmount: $${BUY_AMOUNT_USD}\nTP: *+${tp}%* | SL: *-${STOP_LOSS_PCT}%*\nTX: \`${result.sig}\``,
    [[{ text: "🔴 Manual Sell", callback_data: "sell_now" }]]
  );
  monitorPosition();
}

async function executeSell(reason) {
  if (!activePosition) return;
  const { mint, symbol, tokenAmount, buyPrice } = activePosition;
  const result = await swap(mint, SOL_MINT, tokenAmount);
  const currentPrice = await getTokenPrice(mint);
  const pnlPct = ((currentPrice - buyPrice) / buyPrice * 100).toFixed(2);
  if (!result.success) { await sendTelegram(`❌ Sell gagal: ${result.error}`); return; }
  const emoji = reason === "tp" ? "🟢" : reason === "sl" ? "🔴" : "⚪";
  await sendTelegram(`${emoji} *Sell ${reason.toUpperCase()}: ${symbol}*\nPnL: *${pnlPct}%*\nTX: \`${result.sig}\``);
  activePosition = null;
}

async function monitorPosition() {
  while (activePosition) {
    await sleep(20000);
    if (!activePosition) break;
    const currentPrice = await getTokenPrice(activePosition.mint);
    if (currentPrice === 0) continue;
    const pnlPct = (currentPrice - activePosition.buyPrice) / activePosition.buyPrice * 100;
    console.log(`[Monitor] ${activePosition.symbol} PnL:${pnlPct.toFixed(2)}% TP:+${activePosition.tp}%`);
    if (pnlPct >= activePosition.tp) await executeSell("tp");
    else if (pnlPct <= -STOP_LOSS_PCT) await executeSell("sl");
  }
}

// SCAN
async function scanLoop() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning...`);
  if (activePosition) { console.log(`Posisi aktif: ${activePosition.symbol}`); return; }

  // Reset tiap scan biar token yang sama bisa dicek lagi di siklus berikutnya
  scannedTokens.clear();

  const pairs = await getNewPairs();

  for (const pair of pairs) {
    const mint = pair.baseToken?.address;
    if (!mint || scannedTokens.has(mint)) continue;
    scannedTokens.add(mint);

    const sym = pair.baseToken?.symbol?.toUpperCase() || "";
    if (SKIP_SYMBOLS.includes(sym)) continue;

    const liq = pair.liquidity?.usd || 0;
    const vol = pair.volume?.h24 || 0;
    const buys1h = pair.txns?.h1?.buys || 0;
    const sells1h = pair.txns?.h1?.sells || 0;
    const change1h = pair.priceChange?.h1 || 0;
    const pairAge = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;

    // Skip token lama (lebih dari 1 minggu) atau yang ga ada data umur
    if (!pair.pairCreatedAt || pairAge > MAX_TOKEN_AGE_MS) continue;

    if (liq < 5000 || liq > 500000 || vol < 500) continue;
    if (buys1h <= sells1h) continue;
    if (change1h <= 0) continue;

    const symbol = pair.baseToken?.symbol || "Unknown";
    console.log(`✅ Filter passed: ${symbol} | Liq:$${liq.toFixed(0)} | Vol:$${vol.toFixed(0)} | 1h:${change1h}%`);

    const rug = await checkRug(mint);
    if (!rug.safe) {
      console.log(`[RugCheck] SKIP ${symbol}: ${rug.redFlags.join(", ")}`);
      continue;
    }

    console.log(`[BUY] ${symbol} lolos semua filter!`);
    await sendTelegram(
      `🔍 *Token: ${symbol}*\nLiq: $${liq.toLocaleString()} | Vol: $${vol.toLocaleString()}\nChange 1h: ${change1h}%\nRugCheck: ${rug.score} | ${rug.risks.join(", ") || "clean"}\n\n⚡ Auto buy $${BUY_AMOUNT_USD}...`
    );
    await executeBuy(mint, symbol);
    break;
  }
}

async function main() {
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Buy: $${BUY_AMOUNT_USD} | SL: -${STOP_LOSS_PCT}% | TP: random 20-100%`);
  await sendTelegram(`🚀 *Solana Sniper Bot aktif!*\nWallet: \`${walletAddress}\`\nBuy: *$${BUY_AMOUNT_USD}* | TP: *random 20-100%* | SL: *-${STOP_LOSS_PCT}%*\nScan tiap 2 menit...`);
  pollUpdates();
  await scanLoop();
  setInterval(scanLoop, SCAN_INTERVAL_MS);
}

main().catch(console.error);
