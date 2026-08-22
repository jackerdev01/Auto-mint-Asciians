require("dotenv").config();
const fs = require("fs");
const { ethers } = require("ethers");
const axios = require("axios");
const { Groq } = require("groq-sdk");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

// ================== CONFIG ==================
const CONTRACT = "0x6156984960ea790F0D16eae1A59dabF11c84f8d0";
const API_BASE = "https://www.asciians.xyz/api/sign";
const CHAIN_ID = 4663;

const QUANTITY = parseInt(process.env.MINT_QUANTITY || "1");
const MAX_PRICE_USD = parseFloat(process.env.MAX_PRICE_USD || "1.10");
const MINT_TIME = new Date(process.env.MINT_TIME_UTC || "2026-08-24T19:00:00Z");

const PRIVATE_KEYS_FILE = "privateKeys.txt";
const PROXIES_FILE = "proxies.txt";
const CACHE_FILE = "cache.json";

const RIDDLE_TEXTS = [
  "I have keys but open no locks, space but no room. You may enter, but never go in.",
  "The more you take, the more you leave behind.",
  "I speak without a mouth and hear without ears. I have no body, but I come alive with wind.",
  "What has an eye but cannot see?",
  "The more it dries, the wetter it becomes.",
  "I am always ahead of you, yet you will never see me.",
  "It travels the world while staying in one corner.",
  "The one who makes it sells it. The one who buys it never uses it.",
  "I have many teeth but cannot bite.",
  "I have cities but no houses, forests but no trees, water but no fish.",
  "It goes up but never comes down.",
  "I have branches, but no fruit, trunk, or leaves.",
  "I have a head and a tail, but no body.",
  "You can break me without ever touching me.",
  "I have hands but cannot clap.",
  "I run but never walk. I have a bed but never sleep.",
  "I am full of holes, yet I still hold water.",
  "It belongs to you, but everyone else uses it more than you do.",
  "I am full of words but have never spoken.",
  "The more of it there is, the less you see.",
  "Say my name and I am gone.",
  "I have a neck but no head.",
  "I am taken before you get me.",
  "Everything I swallow gets larger, not smaller.",
];

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ================== FILE HELPERS ==================
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function parsePrivateKeys() {
  return readLines(PRIVATE_KEYS_FILE).map((k) => {
    k = k.trim();
    return k.startsWith("0x") ? k : "0x" + k;
  });
}

function parseProxies() {
  return readLines(PROXIES_FILE);
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ================== PROXY ==================
function createAgent(proxyStr) {
  if (!proxyStr) return null;
  let url = proxyStr.trim();
  if (!url.includes("://")) {
    url = "http://" + url;
  }
  try {
    if (url.startsWith("socks")) return new SocksProxyAgent(url);
    return new HttpsProxyAgent(url);
  } catch (e) {
    console.warn(`Invalid proxy ${proxyStr}: ${e.message}`);
    return null;
  }
}

function createAxios(proxyStr = null) {
  const agent = createAgent(proxyStr);
  return axios.create({
    timeout: 20000,
    httpsAgent: agent || undefined,
    httpAgent: agent || undefined,
    proxy: false,
  });
}

// ================== RIDDLE ==================
async function solveRiddleWithAI(riddleText) {
  const prompt = `Solve this classic riddle. Reply with ONLY the one-word answer in UPPERCASE:\n\n"${riddleText}"`;
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.3-70b-versatile",
    temperature: 0.05,
    max_tokens: 15,
  });
  return (completion.choices[0]?.message?.content || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

async function getAnswer(riddleId) {
  const cache = loadCache();
  if (cache[riddleId]) {
    return cache[riddleId];
  }

  const text = RIDDLE_TEXTS[riddleId] || `Unknown riddle #${riddleId}`;
  console.log(`    → Cache miss, asking Groq for: ${text}`);
  const answer = await solveRiddleWithAI(text);

  cache[riddleId] = answer;
  saveCache(cache);
  return answer;
}

// ================== API ==================
async function getRiddleId(address, axiosInstance) {
  const res = await axiosInstance.post(API_BASE, { address, which: true });
  return res.data.riddle;
}

async function submitAnswer(address, answer, axiosInstance) {
  const res = await axiosInstance.post(API_BASE, { address, answer, check: true });
  return res.data.checked === true;
}

async function getEthPrice(axiosInstance) {
  try {
    const res = await axiosInstance.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    return res.data.ethereum.usd;
  } catch {
    return 2500;
  }
}

// ================== MINT (PLACEHOLDER) ==================
// ⚠️ Cập nhật calldata thật khi mint mở (lấy từ DevTools)
async function doMint(privateKey, quantity, maxWei) {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, CHAIN_ID);
  const signer = new ethers.Wallet(privateKey, provider);

  // Tạm thời giả định hàm mint(uint256)
  const iface = new ethers.Interface(["function mint(uint256 quantity) payable"]);
  const data = iface.encodeFunctionData("mint", [quantity]);

  const tx = await signer.sendTransaction({
    to: CONTRACT,
    data,
    value: maxWei,
    gasLimit: 400000n,
  });

  console.log(`    Tx: ${tx.hash}`);
  await tx.wait(1);
  console.log(`    ✅ Minted successfully!`);
}

// ================== WORKER ==================
async function runWallet({ privateKey, proxy, index }) {
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address;
  const tag = `[${String(index + 1).padStart(2, "0")}] ${address.slice(0, 10)}…`;

  let axiosInstance = createAxios(proxy);
  let usingProxy = !!proxy;

  console.log(`${tag} | Proxy: ${proxy || "LOCAL"}`);

  try {
    // 1. Lấy riddle ID
    let riddleId;
    try {
      riddleId = await getRiddleId(address, axiosInstance);
    } catch (err) {
      if (usingProxy) {
        console.warn(`${tag} Proxy lỗi → fallback LOCAL`);
        axiosInstance = createAxios(null);
        usingProxy = false;
        riddleId = await getRiddleId(address, axiosInstance);
      } else {
        throw err;
      }
    }

    console.log(`${tag} Riddle ID: ${riddleId}`);

    // 2. Lấy đáp án (cache ưu tiên)
    const answer = await getAnswer(riddleId);
    console.log(`${tag} Answer: ${answer}`);

    // 3. Submit đáp án
    const ok = await submitAnswer(address, answer, axiosInstance);
    if (!ok) {
      console.error(`${tag} ❌ Answer rejected by server`);
      return;
    }
    console.log(`${tag} ✅ Riddle unlocked`);

    // 4. Chờ đến giờ mint
    const waitMs = MINT_TIME.getTime() - Date.now();
    if (waitMs > 1000) {
      console.log(`${tag} Waiting ${Math.round(waitMs / 1000)} seconds...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // 5. Tính max value (trần giá)
    const ethPrice = await getEthPrice(axiosInstance);
    const maxEth = (MAX_PRICE_USD * QUANTITY) / ethPrice;
    const maxWei = ethers.parseEther(maxEth.toFixed(8));
    console.log(`${tag} Max pay: ${ethers.formatEther(maxWei)} ETH (~$${MAX_PRICE_USD * QUANTITY})`);

    // 6. Mint
    await doMint(privateKey, QUANTITY, maxWei);
  } catch (err) {
    console.error(`${tag} ERROR:`, err.message || err);
  }
}

// ================== MAIN ==================
if (isMainThread) {
  const privateKeys = parsePrivateKeys();
  const proxies = parseProxies();

  if (privateKeys.length === 0) {
    console.error("❌ privateKeys.txt is empty or missing");
    process.exit(1);
  }

  console.log("🚀 ASCIAN Auto-Mint Tool (Robinhood Chain)");
  console.log(`Wallets      : ${privateKeys.length}`);
  console.log(`Proxies      : ${proxies.length} (auto fallback local)`);
  console.log(`Quantity     : ${QUANTITY}`);
  console.log(`Max price    : $${MAX_PRICE_USD} / NFT`);
  console.log(`Mint time    : ${MINT_TIME.toISOString()}`);
  console.log("----------------------------------------");

  const jobs = privateKeys.map((pk, i) => {
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    return new Promise((resolve) => {
      const worker = new Worker(__filename, {
        workerData: { privateKey: pk, proxy, index: i },
      });
      worker.on("message", resolve);
      worker.on("error", (e) => {
        console.error(e);
        resolve();
      });
      worker.on("exit", resolve);
    });
  });

  Promise.all(jobs).then(() => {
    console.log("\n✅ All wallets finished");
    process.exit(0);
  });
} else {
  runWallet(workerData)
    .then(() => parentPort.postMessage("done"))
    .catch(() => parentPort.postMessage("error"));
}
