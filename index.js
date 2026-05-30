require("dotenv").config();
const { Connection, Keypair, PublicKey, VersionedTransaction } = require("@solana/web3.js");
const fetch = require("node-fetch");
const bs58 = require("bs58");

// CONFIG
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BUY_AMOUNT_USD = parseFloat(process.env.BUY_AMOUNT_USD || "10");
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || "50");
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || "30");
const SCAN_INTERVAL_MS = 3 * 60 * 1000;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

if (!PRIVATE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !GEMINI_API_KEY) {
  console.error("Isi semua variable di .env dulu!"); process.exit(1);
}

const connection = new Connection(RPC_URL, "confirmed");
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletAddress = keypair.publicKey.toBase58();

let activePosition = null;
const pendingApprovals = {};
const scannedTokens = new Set();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  const data = cb.data;
  await answerCallback(cb.id, "Diproses...");
  if (data.startsWith("buy_")) {
    const mint = data.replace("buy_", "");
    const pending = pendingApprovals[mint];
    if (!pending) { await sendTelegram("Token sudah expired."); return; }
    if (activePosition) { await sendTelegram("Masih ada posisi aktif!"); return; }
    await sendTelegram(`Executing buy *${pending.symbol}*...`);
    await executeBuy(mint, pending);
    delete pendingApprovals[mint];
  } else if (data.startsWith("skip_")) {
    delete pendingApprovals[data.replace("skip_", "")];
    await sendTelegram("Token di-skip.");
  } else if (data === "sell_now") {
    if (!activePosition) { await sendTelegram("Tidak ada posisi aktif."); return; }
    await sendTelegram("Manual sell dieksekusi...");
    await executeSell("manual");
  }
}

// DEXSCREENER
async function getNewTokens() {
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
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
async function analyzeToken(tokenData) {
  const prompt = `Kamu adalah crypto analyst Solana meme coin. Analisis token ini dan berikan verdict apakah worth trade short term.

Token: ${tokenData.baseToken?.symbol}
Price Change 5m: ${tokenData.priceChange?.m5 || 0}%
Price Change 1h: ${tokenData.priceChange?.h1 || 0}%
Volume 24h: $${tokenData.volume?.h24 || 0}
Liquidity: $${tokenData.liquidity?.usd || 0}
Market Cap: $${tokenData.marketCap || 0}
Buys 5m: ${tokenData.txns?.m5?.buys || 0} | Sells 5m: ${tokenData.txns?.m5?.sells || 0}
Buys 1h: ${tokenData.txns?.h1?.buys || 0} | Sells 1h: ${tokenData.txns?.h1?.sells || 0}

Jawab HANYA dengan JSON ini:
{"verdict":"BUY atau SKIP","score":1-10,"reason":"alasan singkat","risk":"LOW/MEDIUM/HIGH","target":persen_potensi_naik}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 300 } }),
      }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) { console.error("Gemini error:", err.message); return null; }
}

// JUPITER SWAP
async function getSOLPrice() {
  try {
    const res = await fetch("https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112");
    const data = await res.json();
    return parseFloat(data[0]?.priceUsd || 150);
  } catch { return 150; }
}

async function swap(inputMint, outputMint, amount) {
  try {
    const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=500`);
    const quote = await quoteRes.json();
    if (!quote.outAmount) throw new Error("No quote");

    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: walletAddress, wrapAndUnwrapSol: true }),
    });
    const swapData = await swapRes.json();
    if (!swapData.swapTransaction) throw new Error("No tx");

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
    tx.sign([keypair]);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return { success: true, sig, outAmount: quote.outAmount };
  } catch (err) { return { success: false, error: err.message }; }
}

async function executeBuy(mint, tokenInfo) {
  const solPrice = await getSOLPrice();
  const lamports = Math.floor((BUY_AMOUNT_USD / solPrice) * 1e9);
  const result = await swap("So11111111111111111111111111111111111111112", mint, lamports);

  if (!result.success) { await sendTelegram(`Buy gagal: ${result.error}`); return; }

  const buyPrice = await getTokenPrice(mint);
  activePosition = { mint, symbol: tokenInfo.symbol, buyPrice, tokenAmount: result.outAmount, buyTime: Date.now() };

  await sendTelegram(
    `*Buy berhasil!*\nToken: *${tokenInfo.symbol}*\nBuy price: $${buyPrice.toFixed(8)}\nAmount: $${BUY_AMOUNT_USD}\nTP: +${TAKE_PROFIT_PCT}% | SL: -${STOP_LOSS_PCT}%\nTX: \`${result.sig}\``,
    [[{ text: "Manual Sell", callback_data: "sell_now" }]]
  );
  monitorPosition();
}

async function executeSell(reason) {
  if (!activePosition) return;
  const { mint, symbol, tokenAmount, buyPrice } = activePosition;
  const result = await swap(mint, "So11111111111111111111111111111111111111112", tokenAmount);
  const currentPrice = await getTokenPrice(mint);
  const pnlPct = ((currentPrice - buyPrice) / buyPrice * 100).toFixed(2);

  if (!result.success) { await sendTelegram(`Sell gagal: ${result.error}`); return; }

  const emoji = reason === "tp" ? "🟢" : reason === "sl" ? "🔴" : "⚪";
  await sendTelegram(`${emoji} *Sell ${reason.toUpperCase()}*\nToken: *${symbol}*\nPnL: *${pnlPct}%*\nTX: \`${result.sig}\``);
  activePosition = null;
}

async function monitorPosition() {
  while (activePosition) {
    await sleep(30000);
    if (!activePosition) break;
    const currentPrice = await getTokenPrice(activePosition.mint);
    if (currentPrice === 0) continue;
    const pnlPct = (currentPrice - activePosition.buyPrice) / activePosition.buyPrice * 100;
    console.log(`[Monitor] ${activePosition.symbol} PnL: ${pnlPct.toFixed(2)}%`);
    if (pnlPct >= TAKE_PROFIT_PCT) await executeSell("tp");
    else if (pnlPct <= -STOP_LOSS_PCT) await executeSell("sl");
  }
}

// SCAN
async function scanLoop() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning...`);
  if (activePosition) { console.log(`Posisi aktif: ${activePosition.symbol}`); return; }

  const tokens = await getNewTokens();
  for (const token of tokens) {
    const mint = token.tokenAddress;
    if (!mint || scannedTokens.has(mint)) continue;
    scannedTokens.add(mint);

    const details = await getTokenDetails(mint);
    if (!details) continue;

    const liq = details.liquidity?.usd || 0;
    const vol = details.volume?.h24 || 0;
    if (liq < 10000 || liq > 15000 || vol < 500) continue;
    // Filter: buys harus lebih banyak dari sells di 1h
    const buys1h = details.txns?.h1?.buys || 0;
    const sells1h = details.txns?.h1?.sells || 0;
    if (buys1h <= sells1h) continue;
    // Filter: price change 1h harus positif
    if ((details.priceChange?.h1 || 0) <= 0) continue;

    console.log(`Analyzing: ${details.baseToken?.symbol} | Liq: $${liq} | Vol: $${vol}`);
    const analysis = await analyzeToken(details);
    if (!analysis) continue;

    console.log(`Verdict: ${analysis.verdict} (${analysis.score}/10)`);

    if (analysis.verdict === "BUY" && analysis.score >= 6) {
      const symbol = details.baseToken?.symbol || "Unknown";
      pendingApprovals[mint] = { symbol, details, analysis };

      await sendTelegram(
        `*Token Baru Ditemukan!*\n\nToken: *${symbol}*\nPrice: $${details.priceUsd || 0}\nLiquidity: $${liq.toLocaleString()}\nVolume 24h: $${vol.toLocaleString()}\nChange 1h: ${details.priceChange?.h1 || 0}%\n\n*AI Analysis:*\nScore: ${analysis.score}/10\nRisk: ${analysis.risk}\nTarget: +${analysis.target}%\nReason: ${analysis.reason}\n\nBuy $${BUY_AMOUNT_USD}?`,
        [[{ text: `Buy $${BUY_AMOUNT_USD}`, callback_data: `buy_${mint}` }, { text: "Skip", callback_data: `skip_${mint}` }]]
      );

      setTimeout(() => { delete pendingApprovals[mint]; }, 10 * 60 * 1000);
    }
    await sleep(2000);
  }
}

async function main() {
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Buy: $${BUY_AMOUNT_USD} | TP: +${TAKE_PROFIT_PCT}% | SL: -${STOP_LOSS_PCT}%`);

  await sendTelegram(
    `*Solana Sniper Bot aktif!*\n\nWallet: \`${walletAddress}\`\nBuy per trade: *$${BUY_AMOUNT_USD}*\nTP: *+${TAKE_PROFIT_PCT}%* | SL: *-${STOP_LOSS_PCT}%*\n\nScan tiap 3 menit...`
  );

  pollUpdates();
  await scanLoop();
  setInterval(scanLoop, SCAN_INTERVAL_MS);
}

main().catch(console.error);
