require("dotenv").config();
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const fetch = require("node-fetch");
const bs58 = require("bs58");

// CONFIG
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const BUY_AMOUNT_USD = parseFloat(process.env.BUY_AMOUNT_USD || "10");
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || "30");
const SCAN_INTERVAL_MS = 3 * 60 * 1000;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

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

// DEXSCREENER
async function getNewTokens() {
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    const data = await res.json();
    return (data || []).filter(t => t.chainId === "solana").slice(0, 20);
  } catch (err) { console.error("Dexscreener error:", err.message); return []; }
}

async function getTokenDetails(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    const data = await res.json();
    return data[0] || null;
  } catch { return null; }
}

async function getTokenPrice(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    const data = await res.json();
    return parseFloat(data[0]?.priceUsd || 0);
  } catch { return 0; }
}

// GEMINI

// RUGCHECK
async function checkRug(mint) {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const risks = data.risks || [];
    const score = data.score || 0; // higher = more risky

    // Red flags yang langsung skip
    const redFlags = risks.filter(r =>
      r.name.toLowerCase().includes("mint") ||
      r.name.toLowerCase().includes("freeze") ||
      r.name.toLowerCase().includes("honeypot") ||
      r.name.toLowerCase().includes("bundle") ||
      r.name.toLowerCase().includes("sniper") ||
      r.level === "danger"
    );

    // Top holder concentration > 30% = skip
    const topHolderRisk = risks.find(r => r.name.toLowerCase().includes("top holder") || r.name.toLowerCase().includes("concentration"));

    console.log(`[RugCheck] ${mint.slice(0,8)}... Score: ${score} | Risks: ${risks.map(r=>r.name).join(", ") || "none"}`);

    const isSafe = redFlags.length === 0 && score < 5000;
    console.log(`[RugCheck] safe: ${isSafe} | redFlags: ${redFlags.length} | score: ${score}`);
    return {
      safe: isSafe,
      score,
      risks: risks.map(r => r.name),
      redFlags: redFlags.map(r => r.name),
    };
  } catch (err) {
    console.error("RugCheck error:", err.message);
    return { safe: true, score: 0, risks: [], redFlags: [], failed: true };
  }
}

  await sendTelegram(
    `✅ *Auto Buy: ${symbol}*\n\n` +
    `Buy price: $${buyPrice.toFixed(8)}\n` +
    `Amount: $${BUY_AMOUNT_USD}\n` +
    `TP: *+${tp}%* | SL: *-${STOP_LOSS_PCT}%*\n` +
    `Score AI: ${analysis.score}/10\n` +
    `Reason: ${analysis.reason}\n` +
    `TX: \`${result.sig}\``,
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
    await sleep(30000);
    if (!activePosition) break;
    const currentPrice = await getTokenPrice(activePosition.mint);
    if (currentPrice === 0) continue;
    const pnlPct = (currentPrice - activePosition.buyPrice) / activePosition.buyPrice * 100;
    console.log(`[Monitor] ${activePosition.symbol} PnL: ${pnlPct.toFixed(2)}% | TP: +${activePosition.tp}%`);
    if (pnlPct >= activePosition.tp) await executeSell("tp");
    else if (pnlPct <= -STOP_LOSS_PCT) await executeSell("sl");
  }
}

// SCAN
async function scanLoop() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning...`);
  if (activePosition) { console.log(`Posisi aktif: ${activePosition.symbol}`); return; }

  const tokens = await getNewTokens();
  scannedTokens.clear();
  console.log(`Dexscreener: ${tokens.length} token baru`);
  for (const token of tokens) {
    const mint = token.tokenAddress;
    if (!mint || scannedTokens.has(mint)) continue;
    scannedTokens.add(mint);

    const details = await getTokenDetails(mint);
    if (!details) continue;

    const liq = details.liquidity?.usd || 0;
    const vol = details.volume?.h24 || 0;
    const buys1h = details.txns?.h1?.buys || 0;
    const sells1h = details.txns?.h1?.sells || 0;
    const change1h = details.priceChange?.h1 || 0;

    if (liq < 10000 || liq > 15000 || vol < 500) continue;
    if (buys1h <= sells1h) continue;
    if (change1h <= 0) continue;
    console.log(`Filter passed: ${details.baseToken?.symbol} | Liq: $${liq.toFixed(0)} | Vol: $${vol.toFixed(0)} | Change1h: ${change1h}%`);

    const symbol = details.baseToken?.symbol || "Unknown";
    console.log(`Analyzing: ${symbol} | Liq: $${liq} | Vol: $${vol}`);

    // RugCheck dulu
    const rug = await checkRug(mint);
    if (!rug.safe) {
      console.log(`[RugCheck] SKIP ${symbol} - red flags: ${rug.redFlags.join(", ")}`);
      continue;
    }

    if (true) {
      await sendTelegram(
        `🔍 *Token Ditemukan: ${symbol}*\n\n` +
        `Liq: $${liq.toLocaleString()} | Vol: $${vol.toLocaleString()}\n` +
        `Change 1h: ${change1h}%\n` +
        `RugCheck Score: ${rug.score} | Risks: ${rug.risks.join(", ") || "none"}\n` +
        `Score AI: ${analysis.score}/10 | Risk: ${analysis.risk}\n` +
        `Target: +${analysis.target}%\n\n` +
        `⚡ Auto buy $${BUY_AMOUNT_USD}...`
      );
      await executeBuy(mint, symbol, analysis);
      break; // 1 token per scan
    }
    await sleep(2000);
  }
}

async function main() {
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Buy: $${BUY_AMOUNT_USD} | SL: -${STOP_LOSS_PCT}% | TP: random 20-100%`);

  await sendTelegram(
    `🚀 *Solana Sniper Bot aktif!*\n\n` +
    `Wallet: \`${walletAddress}\`\n` +
    `Buy per trade: *$${BUY_AMOUNT_USD}*\n` +
    `TP: *random 20-100%*\n` +
    `SL: *-${STOP_LOSS_PCT}%*\n\n` +
    `Auto buy aktif, scan tiap 3 menit...`
  );

  pollUpdates();
  await scanLoop();
  setInterval(scanLoop, SCAN_INTERVAL_MS);
}

main().catch(console.error);
