import { Contract, Provider } from "koilib";
import stakingAbiRaw from "./abi/staking.json";
import lockAbiRaw from "./abi/token-lock.json";
import upAbiRaw from "./abi/up-token.json";

// Mainnet JSON-RPC. Both nodes returned the same head block when checked.
export const RPC_NODES = [
  "https://api.koinosblocks.com",
  "https://api.koinos.io",
];

// Liquidity (UP). Supplied by Carl as the token contract, confirmed on chain.
export const UP_TOKEN = "17t977jJZ7DYKPQsjqtStbpvmde1DditXW";

// Koincity staking map. Address is in the March 2025 koincity.com bundle.
// Pools are uint32 ids inside this contract, not separate addresses.
export const STAKING_CONTRACT = "1JpcbhG3PtPyDS8yumjoBC4EPHnN9tQVwQ";

// Koincity token lock. Address is in the same bundle (export Zn).
export const LOCK_CONTRACT = "1FT1D2jLKeeEFcfG5Zo7WKfYNHH9MMeK5N";

const PAGE = 8;
const SEND = { rcLimit: "1000000000" };

function normalizeAbi(abi) {
  const copy = structuredClone(abi);
  for (const method of Object.values(copy.methods || {})) {
    if (method["read-only"] != null && method.read_only == null) {
      method.read_only = method["read-only"];
    }
    if (method.entry_point == null && method["entry-point"] != null) {
      const raw = method["entry-point"];
      method.entry_point =
        typeof raw === "string" ? Number.parseInt(raw, 16) : raw;
    }
  }
  return copy;
}

const stakingAbi = normalizeAbi(stakingAbiRaw);
const lockAbi = normalizeAbi(lockAbiRaw);
const upAbi = normalizeAbi(upAbiRaw);

export function makeProvider() {
  return new Provider(RPC_NODES);
}

function makeContract(id, abi, provider, signer) {
  return new Contract({ id, abi, provider, signer });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(fn) {
  let last;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const message = String(error?.message || error);
      const retry =
        message.includes("invalid json") ||
        message.includes("bandwidth") ||
        message.includes("Failed to fetch") ||
        message.includes("ECONN") ||
        message.includes("timeout") ||
        message.includes("429") ||
        message.includes("403");
      if (!retry || i === 3) throw error;
      await sleep(350 * (i + 1));
    }
  }
  throw last;
}

export function formatUnits(raw, decimals) {
  const dec = Number(decimals || 0);
  let value = String(raw ?? "0");
  if (!/^\d+$/.test(value)) return "0";
  value = value.replace(/^0+/, "") || "0";
  if (dec <= 0) return value;
  value = value.padStart(dec + 1, "0");
  const whole = value.slice(0, -dec);
  const frac = value.slice(-dec).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function parseUnits(human, decimals) {
  const text = String(human ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error("Enter a positive amount, using digits and an optional decimal point.");
  }
  const dec = Number(decimals || 0);
  const [whole, frac = ""] = text.split(".");
  if (frac.length > dec) {
    throw new Error(`This token uses ${dec} decimal places.`);
  }
  const padded = `${frac}${"0".repeat(dec)}`.slice(0, dec);
  return `${whole}${padded}`.replace(/^0+/, "") || "0";
}

export function formatTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString();
}

function normalizePool(entry) {
  const info = entry.stake_contract_info_result || {};
  const created = info.create_arguments || {};
  const user = entry.user_info_result || {};
  return {
    id: Number(entry.contract),
    title: created.title || `Pool ${entry.contract}`,
    description: created.description || "",
    stakingToken: created.stakingToken || "",
    rewardsToken: created.rewardsToken || "",
    stakeSymbol: info.staking_token?.symbol || "",
    stakeName: info.staking_token?.name || "",
    stakeDecimals: Number(info.staking_token?.decimals || 0),
    rewardSymbol: info.rewards_token?.symbol || "",
    rewardName: info.rewards_token?.name || "",
    rewardDecimals: Number(info.rewards_token?.decimals || 0),
    totalStaked: info.totalStaked || "0",
    rewardsStart: created.rewardsStart || "0",
    rewardsEnd: created.rewardsEnd || "0",
    totalRewards: created.totalRewards || "0",
    active: Boolean(entry.active),
    ended: Boolean(entry.ended),
    upcoming: Boolean(entry.upcoming),
    staked: user.staked || "0",
    claimable: user.current_user_rewards || "0",
    totalClaimed: user.total_claimed || "0",
    reasons: [],
  };
}

async function fetchStakePages(provider, userAddress) {
  const staking = makeContract(STAKING_CONTRACT, stakingAbi, provider);
  const totalResult = await attempt(() => staking.functions.getTotalStakes({}));
  const total = Number(totalResult.result?.value || 0);
  const pools = [];
  let start = total;
  while (start >= 1) {
    const limit = Math.min(PAGE, start);
    const args = { start, limit };
    if (userAddress) args.user = userAddress;
    let page;
    try {
      page = await attempt(() => staking.functions.getStakes(args));
    } catch (error) {
      const message = String(error?.message || error);
      if (!message.includes("bandwidth")) throw error;
      page = null;
    }
    if (!page) {
      for (let id = start; id > start - limit && id >= 1; id -= 1) {
        const singleArgs = { start: id, limit: 1 };
        if (userAddress) singleArgs.user = userAddress;
        const single = await attempt(() => staking.functions.getStakes(singleArgs));
        for (const entry of single.result?.stake_info_entry || []) {
          pools.push(normalizePool(entry));
        }
      }
      start -= limit;
      continue;
    }
    const entries = page.result?.stake_info_entry || [];
    if (entries.length !== limit) {
      for (let id = start; id > start - limit && id >= 1; id -= 1) {
        const single = await attempt(() =>
          staking.functions.getStakes(
            userAddress
              ? { start: id, limit: 1, user: userAddress }
              : { start: id, limit: 1 }
          )
        );
        for (const entry of single.result?.stake_info_entry || []) {
          pools.push(normalizePool(entry));
        }
      }
    } else {
      for (const entry of entries) pools.push(normalizePool(entry));
    }
    start -= limit;
  }
  const byId = new Map();
  for (const pool of pools) byId.set(pool.id, pool);
  return { total, pools: [...byId.values()].sort((a, b) => a.id - b.id) };
}

async function pairTokens(provider, tokenAddress) {
  const token = new Contract({ id: tokenAddress, provider });
  const abi = normalizeAbi(await attempt(() => token.fetchAbi()));
  if (!abi?.methods?.get_tokens) return null;
  token.abi = abi;
  token.updateFunctionsFromAbi();
  const result = await attempt(() => token.functions.get_tokens({}));
  return {
    tokenA: result.result?.token_a || "",
    tokenB: result.result?.token_b || "",
  };
}

function annotate(pools, pairs) {
  for (const pool of pools) {
    const reasons = [];
    if (pool.stakingToken === UP_TOKEN) reasons.push("Stake token is Liquidity UP");
    if (pool.rewardsToken === UP_TOKEN) reasons.push("Reward token is Liquidity UP");
    const stakePair = pairs.get(pool.stakingToken);
    const rewardPair = pairs.get(pool.rewardsToken);
    if (
      stakePair &&
      (stakePair.tokenA === UP_TOKEN || stakePair.tokenB === UP_TOKEN)
    ) {
      reasons.push("Staked LP includes Liquidity UP");
    }
    if (
      rewardPair &&
      (rewardPair.tokenA === UP_TOKEN || rewardPair.tokenB === UP_TOKEN)
    ) {
      reasons.push("Reward LP includes Liquidity UP");
    }
    pool.reasons = reasons;
    pool.usesUp = reasons.length > 0;
  }
  return pools;
}

export async function loadUpToken(provider) {
  const token = makeContract(UP_TOKEN, upAbi, provider);
  const [name, symbol, decimals] = await Promise.all([
    attempt(() => token.functions.name({})),
    attempt(() => token.functions.symbol({})),
    attempt(() => token.functions.decimals({})),
  ]);
  return {
    address: UP_TOKEN,
    name: name.result?.value || "",
    symbol: symbol.result?.value || "",
    decimals: Number(decimals.result?.value ?? 0),
  };
}

export async function loadUpBalance(provider, owner) {
  const token = makeContract(UP_TOKEN, upAbi, provider);
  const result = await attempt(() => token.functions.balance_of({ owner }));
  return result.result?.value || "0";
}

export async function loadPools(provider, onProgress) {
  onProgress?.("Reading staking pools…");
  const { total, pools } = await fetchStakePages(provider);
  const tokenIds = [
    ...new Set(
      pools.flatMap((pool) => [pool.stakingToken, pool.rewardsToken]).filter(Boolean)
    ),
  ].filter((id) => id !== UP_TOKEN);
  const pairs = new Map();
  let done = 0;
  const queue = [...tokenIds];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const tokens = await pairTokens(provider, id);
        if (tokens) pairs.set(id, tokens);
      } catch {
        // Not a pair, or the contract has no uploaded ABI.
      }
      done += 1;
      onProgress?.(`Checking tokens used by pools (${done}/${tokenIds.length})…`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return { total, pools: annotate(pools, pairs) };
}

export async function loadPositions(provider, userAddress) {
  const { pools } = await fetchStakePages(provider, userAddress);
  return pools;
}

function normalizeLock(row) {
  const params = row.lock_params || {};
  const item = params.locks_item || {};
  return {
    id: Number(row.lock_id),
    token: item.token || "",
    owner: item.owner || "",
    receiver: item.receiver || "",
    startDate: item.startDate || "0",
    endDate: item.endDate || "0",
    amount: item.amount || "0",
    description: item.description || "",
    claimed: Boolean(item.claimed),
    locked: params.locked !== false && params.locked !== undefined ? Boolean(params.locked) : Number(item.endDate) > Date.now(),
    symbol: row.token_info?.symbol || "",
    name: row.token_info?.name || "",
    decimals: Number(row.token_info?.decimals || 0),
  };
}

async function locksFor(provider, address) {
  const lock = makeContract(LOCK_CONTRACT, lockAbi, provider);
  const countResult = await attempt(() =>
    lock.functions.getMyTokenLocksCount({ value: address })
  );
  const count = Number(countResult.result?.value || 0);
  const rows = [];
  let start = 1;
  while (start <= count) {
    const limit = Math.min(20, count - start + 1);
    const page = await attempt(() =>
      lock.functions.getMyTokenLocks({
        address,
        start,
        limit,
        direction: 0,
      })
    );
    rows.push(...(page.result?.value || []));
    start += limit;
  }
  return rows.map(normalizeLock);
}

export async function loadWalletLocks(provider, userAddress) {
  if (!userAddress) return [];
  const locks = await locksFor(provider, userAddress);
  return locks
    .map((lock) => ({ ...lock, indexedBy: "wallet" }))
    .sort((a, b) => a.id - b.id);
}

export async function loadLocks(provider, userAddress) {
  const byToken = await locksFor(provider, UP_TOKEN);
  const byUser = userAddress ? await locksFor(provider, userAddress) : [];
  const merged = new Map();
  for (const lock of byToken) merged.set(lock.id, { ...lock, indexedBy: "token" });
  for (const lock of byUser) {
    const existing = merged.get(lock.id);
    if (existing) existing.indexedBy = "token-and-wallet";
    else merged.set(lock.id, { ...lock, indexedBy: "wallet" });
  }
  return [...merged.values()].sort((a, b) => a.id - b.id);
}

async function waitFor(transaction) {
  if (transaction?.wait) {
    await transaction.wait("byBlock", 90000);
  }
  return transaction?.id || "";
}

export async function claimRewards(provider, signer, poolId, user) {
  const staking = makeContract(STAKING_CONTRACT, stakingAbi, provider, signer);
  const { transaction } = await staking.functions.claim(
    { contract: Number(poolId), user },
    SEND
  );
  return waitFor(transaction);
}

export async function unstake(provider, signer, poolId, user, amount) {
  const staking = makeContract(STAKING_CONTRACT, stakingAbi, provider, signer);
  const { transaction } = await staking.functions.unstake(
    { contract: Number(poolId), user, amount },
    SEND
  );
  return waitFor(transaction);
}

export async function releaseLock(provider, signer, lockId) {
  const lock = makeContract(LOCK_CONTRACT, lockAbi, provider, signer);
  const { transaction } = await lock.functions.unlockTokenLock(
    { value: Number(lockId) },
    SEND
  );
  return waitFor(transaction);
}
