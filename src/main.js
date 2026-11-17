import { Signer } from "koilib";
import { getAccounts, getSigner } from "kondor-js";
import {
  LOCK_CONTRACT,
  STAKING_CONTRACT,
  UP_TOKEN,
  claimRewards,
  formatTime,
  formatUnits,
  loadAllLocks,
  loadPools,
  loadPositions,
  loadUpBalance,
  loadUpToken,
  makeProvider,
  parseUnits,
  releaseLock,
  unstake,
} from "./chain.js";

const provider = makeProvider();
const session = new Map();
const drafts = {};

const state = {
  status: "Loading Liquidity UP, staking pools, and token locks…",
  error: "",
  token: null,
  pools: [],
  poolTotal: 0,
  locks: [],
  lockTotal: 0,
  locksLoaded: false,
  filter: "all",
  lockFilter: "all",
  selectedPoolId: "",
  selectedLockId: "",
  account: "",
  accounts: [],
  balance: "",
  positionsLoaded: false,
  busy: false,
};

const app = document.querySelector("#app");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function short(address) {
  if (!address) return "—";
  if (address.length < 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function activeSigner() {
  return state.account ? session.get(state.account) || null : null;
}

function setStatus(text, isError = false) {
  state.status = text;
  state.error = isError ? text : "";
  const node = document.querySelector(".status");
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("error", isError);
}

function forgetSigner(signer) {
  if (signer && Object.prototype.hasOwnProperty.call(signer, "privateKey")) {
    signer.privateKey = null;
  }
}

function remember(address, signer) {
  session.set(address, signer);
  if (!state.accounts.includes(address)) state.accounts.push(address);
  state.account = address;
}

async function connectKondor() {
  setStatus("Waiting for Kondor…");
  let accounts;
  try {
    accounts = await getAccounts();
  } catch {
    setStatus("Kondor did not respond. Install the extension, or open a wallet below.", true);
    return;
  }
  const list = (Array.isArray(accounts) ? accounts : [accounts])
    .map((item) => (typeof item === "string" ? item : item?.address))
    .filter(Boolean);
  if (!list.length) {
    setStatus("Kondor did not return an account.", true);
    return;
  }
  for (const address of list) {
    const signer = getSigner(address, { provider });
    signer.provider = provider;
    session.set(address, signer);
    if (!state.accounts.includes(address)) state.accounts.push(address);
  }
  state.account = list[0];
  await refreshPositions();
}

function openLocalWallet() {
  const input = document.querySelector("#secret");
  const mode = document.querySelector("#secret-mode").value;
  const text = input.value.trim();
  input.value = "";
  if (!text) {
    setStatus("Enter a private key or seed first.", true);
    return;
  }
  let signer;
  try {
    if (mode === "seed") {
      signer = Signer.fromSeed(text);
    } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
      signer = new Signer({ privateKey: text.replace(/^0x/i, "") });
    } else {
      signer = Signer.fromWif(text);
    }
    signer.provider = provider;
  } catch {
    setStatus("Could not open that wallet. Check the key or seed and try again.", true);
    return;
  }
  const address = signer.getAddress();
  remember(address, signer);
  render();
  refreshPositions();
}

function disconnect() {
  for (const signer of session.values()) forgetSigner(signer);
  session.clear();
  state.accounts = [];
  state.account = "";
  state.balance = "";
  state.positionsLoaded = false;
  for (const pool of state.pools) {
    pool.staked = "0";
    pool.claimable = "0";
    pool.totalClaimed = "0";
  }
  render();
  setStatus("Wallet closed in this tab.");
}

async function refreshPositions() {
  if (!state.account) return;
  state.busy = true;
  render();
  setStatus("Reading this wallet's positions…");
  try {
    const [positions, balance, locks] = await Promise.all([
      loadPositions(provider, state.account),
      loadUpBalance(provider, state.account),
      loadAllLocks(provider),
    ]);
    const byId = new Map(positions.map((pool) => [pool.id, pool]));
    for (const pool of state.pools) {
      const fresh = byId.get(pool.id);
      if (!fresh) continue;
      pool.staked = fresh.staked;
      pool.claimable = fresh.claimable;
      pool.totalClaimed = fresh.totalClaimed;
    }
    state.balance = balance;
    state.locks = locks.locks;
    state.lockTotal = locks.total;
    state.locksLoaded = true;
    if (!locks.locks.some((lock) => String(lock.id) === state.selectedLockId)) {
      state.selectedLockId = locks.locks[0] ? String(locks.locks[0].id) : "";
    }
    state.positionsLoaded = true;
    setStatus("Positions updated.");
  } catch (error) {
    setStatus(error.message || "Could not read positions.", true);
  } finally {
    state.busy = false;
    render();
  }
}

async function runTx(label, fn) {
  const signer = activeSigner();
  if (!signer || !state.account) {
    setStatus("Open a wallet before sending a transaction.", true);
    return;
  }
  state.busy = true;
  render();
  setStatus(`${label} Waiting for approval…`);
  try {
    const id = await fn(signer);
    setStatus(id ? `${label} Submitted. Transaction ${id}` : `${label} Submitted.`);
    await refreshPositions();
  } catch (error) {
    state.busy = false;
    setStatus(error.message || `${label} was rejected.`, true);
    render();
  }
}

function visiblePools() {
  const pools = [...state.pools];
  pools.sort((a, b) => Number(b.usesUp) - Number(a.usesUp) || a.id - b.id);
  if (state.filter === "up") return pools.filter((pool) => pool.usesUp);
  if (state.filter === "mine") {
    return pools.filter((pool) => pool.staked !== "0" || pool.claimable !== "0");
  }
  return pools;
}

function poolStatus(pool) {
  if (pool.active) return "Active";
  if (pool.upcoming) return "Not started";
  if (pool.ended) return "Ended";
  return "Pool";
}

function lockStatus(lock) {
  if (lock.claimed) return "Already released";
  if (lock.locked) return "Still locked";
  return "Ready to release";
}

function renderWallet(root) {
  const panel = el("section", "panel");
  panel.append(el("h2", "", "Wallet"));
  const actions = el("div", "wallet-actions");
  const kondor = el("button", "", "Connect Kondor");
  kondor.disabled = state.busy;
  kondor.addEventListener("click", connectKondor);
  actions.append(kondor);

  if (state.accounts.length) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Wallet account");
    for (const address of state.accounts) {
      const option = document.createElement("option");
      option.value = address;
      option.textContent = address;
      if (address === state.account) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      state.account = select.value;
      refreshPositions();
    });
    actions.append(select);
    const close = el("button", "secondary", "Close wallet");
    close.addEventListener("click", disconnect);
    actions.append(close);
  }
  panel.append(actions);

  if (state.account) {
    const who = el("p", "meta");
    who.append(el("span", "", "Using "));
    const code = el("span", "address", state.account);
    who.append(code);
    panel.append(who);
    if (state.positionsLoaded && state.token) {
      panel.append(
        el(
          "p",
          "meta",
          `Liquidity UP in this wallet: ${formatUnits(state.balance || "0", state.token.decimals)} ${state.token.symbol}`
        )
      );
    }
  }

  const local = el("div", "wallet-actions");
  const mode = document.createElement("select");
  mode.id = "secret-mode";
  mode.setAttribute("aria-label", "Secret type");
  for (const [value, label] of [
    ["key", "Private key (WIF or hex)"],
    ["seed", "Seed phrase"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }
  const secret = document.createElement("input");
  secret.id = "secret";
  secret.className = "secret";
  secret.type = "password";
  secret.autocomplete = "off";
  secret.spellcheck = false;
  secret.setAttribute("aria-label", "Private key or seed phrase");
  secret.placeholder = "Stays in this tab";
  const open = el("button", "secondary", "Open wallet in this tab");
  open.disabled = state.busy;
  open.addEventListener("click", openLocalWallet);
  local.append(mode, secret, open);
  panel.append(local);
  panel.append(
    el(
      "p",
      "note",
      "A seed uses the Koinos method: the private key is the SHA-256 of the exact text. If that is not how the wallet was created, paste the private key instead."
    )
  );
  root.append(panel);
}

function poolOptionLabel(pool) {
  const pair = `${pool.stakeSymbol || "stake"} → ${pool.rewardSymbol || "reward"}`;
  const up = pool.usesUp ? " · UP" : "";
  return `#${pool.id} ${pair}${up} — ${pool.title}`;
}

function choosePool(id) {
  state.selectedPoolId = String(id);
  render();
}

function renderPools(root) {
  const section = el("section", "");
  section.append(el("h2", "", "Staking pools"));
  section.append(
    el(
      "p",
      "note",
      `Every pool id returned by getStakes on ${STAKING_CONTRACT}. Pick any pool, including ones that are not Liquidity UP. A pool is marked UP when its stake token, reward token, or a KoinDX LP pair includes ${UP_TOKEN}.`
    )
  );

  const filters = el("div", "filters");
  const filter = document.createElement("select");
  filter.setAttribute("aria-label", "Jump to a group of pools");
  const upCount = state.pools.filter((pool) => pool.usesUp).length;
  const mineCount = state.pools.filter((pool) => pool.staked !== "0" || pool.claimable !== "0").length;
  for (const [value, label] of [
    ["all", `All pools (${state.pools.length})`],
    ["up", `Jump to Liquidity UP (${upCount})`],
    ["mine", `Jump to my positions (${state.positionsLoaded ? mineCount : "connect a wallet"})`],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === state.filter) option.selected = true;
    filter.append(option);
  }
  filter.addEventListener("change", () => {
    state.filter = filter.value;
    const match = visiblePools()[0];
    if (match) state.selectedPoolId = String(match.id);
    render();
  });
  filters.append(filter);

  const pools = [...state.pools].sort((a, b) => a.id - b.id);

  // A group filter ("up" or "mine") lists every matching pool as its own card.
  // Previously the page only ever showed the first match, so one pool with a
  // failing claim blocked access to all the other positions.
  if (state.filter !== "all") {
    section.append(filters);
    const matches = visiblePools();
    if (!matches.length) {
      section.append(
        el(
          "p",
          "note",
          state.filter === "mine" && !state.positionsLoaded
            ? "Connect a wallet to see your positions."
            : "No pools match this group."
        )
      );
    }
    for (const pool of matches) section.append(renderPoolSafe(pool));
    root.append(section);
    return;
  }

  const picker = document.createElement("select");
  picker.id = "pool-picker";
  picker.setAttribute("aria-label", "Staking pool");
  if (!pools.length) {
    const option = document.createElement("option");
    option.textContent = "No pools loaded";
    picker.append(option);
    picker.disabled = true;
  } else {
    if (!pools.some((pool) => String(pool.id) === state.selectedPoolId)) {
      state.selectedPoolId = String(pools[0].id);
    }
    for (const pool of pools) {
      const option = document.createElement("option");
      option.value = String(pool.id);
      option.textContent = poolOptionLabel(pool);
      if (option.value === state.selectedPoolId) option.selected = true;
      picker.append(option);
    }
  }
  picker.addEventListener("change", () => choosePool(picker.value));
  filters.append(picker);
  section.append(filters);

  const selected = pools.find((pool) => String(pool.id) === state.selectedPoolId);
  if (selected) section.append(renderPoolSafe(selected));
  else section.append(el("p", "note", "No pool selected."));
  root.append(section);
}

// One pool that fails to render must not take down the rest of the list.
function renderPoolSafe(pool) {
  try {
    return renderPool(pool);
  } catch (error) {
    const card = el("article", "card");
    card.append(el("h3", "", `#${pool.id} ${pool.title || "Pool"}`));
    card.append(el("p", "note", `This pool could not be displayed: ${error.message || error}`));
    return card;
  }
}

function renderPool(pool) {
  const hasPosition = pool.staked !== "0" || pool.claimable !== "0";
  const card = el("article", `card${hasPosition ? " has-position" : ""}`);
  card.append(el("h3", "", `#${pool.id} ${pool.title}`));
  const badges = el("div", "badges");
  badges.append(el("span", "badge", poolStatus(pool)));
  for (const reason of pool.reasons) badges.append(el("span", "badge up", reason));
  if (hasPosition) badges.append(el("span", "badge mine", "You have a position"));
  card.append(badges);
  if (pool.description) card.append(el("p", "", pool.description));

  const stats = el("div", "stats");
  const cells = [
    ["Stake token", `${pool.stakeSymbol || "Token"} · ${short(pool.stakingToken)}`],
    ["Reward token", `${pool.rewardSymbol || "Token"} · ${short(pool.rewardsToken)}`],
    ["Total staked", `${formatUnits(pool.totalStaked, pool.stakeDecimals)} ${pool.stakeSymbol}`],
    ["Rewards window", `${formatTime(pool.rewardsStart)} – ${formatTime(pool.rewardsEnd)}`],
    [
      "Your stake",
      state.positionsLoaded
        ? `${formatUnits(pool.staked, pool.stakeDecimals)} ${pool.stakeSymbol}`
        : "Connect a wallet",
    ],
    [
      "Claimable",
      state.positionsLoaded
        ? `${formatUnits(pool.claimable, pool.rewardDecimals)} ${pool.rewardSymbol}`
        : "Connect a wallet",
    ],
  ];
  for (const [label, value] of cells) {
    const box = el("div", "");
    box.append(el("span", "", label));
    box.append(document.createTextNode(value));
    stats.append(box);
  }
  card.append(stats);
  card.append(el("p", "small", `Stake ${pool.stakingToken}`));
  card.append(el("p", "small", `Reward ${pool.rewardsToken}`));

  const actions = el("div", "actions");
  const claim = el("button", "", "Claim rewards");
  claim.disabled = state.busy || !state.account || pool.claimable === "0";
  claim.addEventListener("click", () =>
    runTx("Claim", (signer) => claimRewards(provider, signer, pool.id, state.account))
  );
  const amount = document.createElement("input");
  amount.inputMode = "decimal";
  amount.placeholder = "Amount to unstake";
  amount.setAttribute("aria-label", `Amount to unstake from pool ${pool.id}`);
  amount.value = drafts[pool.id] || "";
  amount.addEventListener("input", () => {
    drafts[pool.id] = amount.value;
  });
  const withdraw = el("button", "", "Unstake");
  withdraw.disabled = state.busy || !state.account;
  withdraw.addEventListener("click", () => {
    let raw;
    try {
      raw = parseUnits(drafts[pool.id] || amount.value, pool.stakeDecimals);
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
    if (raw === "0") {
      setStatus("Enter an amount to unstake.", true);
      return;
    }
    runTx("Unstake", (signer) => unstake(provider, signer, pool.id, state.account, raw));
  });
  const all = el("button", "secondary", "Unstake all");
  all.disabled = state.busy || !state.account || pool.staked === "0";
  all.addEventListener("click", () =>
    runTx("Unstake", (signer) => unstake(provider, signer, pool.id, state.account, pool.staked))
  );
  actions.append(claim, amount, withdraw, all);
  card.append(actions);
  return card;
}

function lockOptionLabel(lock) {
  const symbol = lock.symbol || "token";
  const name = lock.description || lock.name || "Lock";
  let mine = "";
  if (state.account && lock.receiver === state.account) mine = " · you can release";
  else if (state.account && lock.owner === state.account) mine = " · you launched";
  return `#${lock.id} ${symbol} — ${name} — ${lockStatus(lock)}${mine}`;
}

function lockJumpMatch(lock, filter) {
  if (filter === "mine") {
    return Boolean(state.account) && (lock.receiver === state.account || lock.owner === state.account);
  }
  if (filter === "ready") return !lock.claimed && !lock.locked;
  return true;
}

function renderLocks(root) {
  const section = el("section", "");
  section.append(el("h2", "", "Token locks"));
  section.append(
    el(
      "p",
      "note",
      `Every lock id from getTokenLocks on ${LOCK_CONTRACT}. A launch is not listed by getMyTokenLocks for the owner: that call only indexes the receiver and the token address. Release calls unlockTokenLock and pays the full amount to the receiver after the end time. Only the receiver can send it.`
    )
  );
  const locks = [...state.locks].sort((a, b) => a.id - b.id);
  const filters = el("div", "filters");
  const filter = document.createElement("select");
  filter.setAttribute("aria-label", "Jump to a group of locks");
  const mineCount = locks.filter((lock) => lockJumpMatch(lock, "mine")).length;
  const readyCount = locks.filter((lock) => lockJumpMatch(lock, "ready")).length;
  for (const [value, label] of [
    ["all", `All locks (${state.locksLoaded ? locks.length : "…"})`],
    ["mine", `Jump to this wallet (${state.account ? mineCount : "connect a wallet"})`],
    ["ready", `Jump to ready to release (${state.locksLoaded ? readyCount : "…"})`],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === state.lockFilter) option.selected = true;
    filter.append(option);
  }
  filter.addEventListener("change", () => {
    state.lockFilter = filter.value;
    const match = locks.find((lock) => lockJumpMatch(lock, filter.value));
    if (match) state.selectedLockId = String(match.id);
    render();
  });
  filters.append(filter);

  const picker = document.createElement("select");
  picker.id = "lock-picker";
  picker.setAttribute("aria-label", "Token lock");
  if (!state.locksLoaded) {
    const option = document.createElement("option");
    option.textContent = "Loading token locks…";
    picker.append(option);
    picker.disabled = true;
  } else if (!locks.length) {
    const option = document.createElement("option");
    option.textContent = "No locks returned by getTokenLocks";
    picker.append(option);
    picker.disabled = true;
  } else {
    if (!locks.some((lock) => String(lock.id) === state.selectedLockId)) {
      state.selectedLockId = String(locks[0].id);
    }
    for (const lock of locks) {
      const option = document.createElement("option");
      option.value = String(lock.id);
      option.textContent = lockOptionLabel(lock);
      if (option.value === state.selectedLockId) option.selected = true;
      picker.append(option);
    }
  }
  picker.addEventListener("change", () => {
    state.selectedLockId = picker.value;
    render();
  });
  filters.append(picker);
  section.append(filters);
  if (state.locksLoaded && !locks.length) {
    section.append(el("p", "note", "getTokenLocks returned no locks."));
    root.append(section);
    return;
  }

  const lock = locks.find((item) => String(item.id) === state.selectedLockId);
  if (!lock) {
    root.append(section);
    return;
  }
  const mine = Boolean(state.account) && (lock.receiver === state.account || lock.owner === state.account);
  const box = el("article", `lock${mine ? " has-position" : ""}`);
  const decimals = lock.decimals || 8;
  box.append(el("h3", "", `#${lock.id} ${lock.description || lock.symbol || "Lock"}`));
  const badges = el("div", "badges");
  badges.append(el("span", "badge", lockStatus(lock)));
  if (lock.token === UP_TOKEN) badges.append(el("span", "badge up", "Liquidity UP"));
  else if (lock.symbol) badges.append(el("span", "badge", lock.symbol));
  if (state.account && lock.receiver === state.account) {
    badges.append(el("span", "badge mine", "You are the receiver"));
  } else if (state.account && lock.owner === state.account) {
    badges.append(el("span", "badge mine", "You launched this lock"));
  }
  box.append(badges);
  const stats = el("div", "stats");
  for (const [label, value] of [
    ["Amount", `${formatUnits(lock.amount, decimals)} ${lock.symbol}`],
    ["Unlocks", formatTime(lock.endDate)],
    ["Token", lock.token],
    ["Owner", lock.owner],
    ["Receiver", lock.receiver],
  ]) {
    const cell = el("div", "");
    cell.append(el("span", "", label));
    cell.append(document.createTextNode(value));
    stats.append(cell);
  }
  box.append(stats);
  const release = el("button", "", "Release");
  const canRelease = state.account === lock.receiver && !lock.claimed && !lock.locked;
  release.disabled = state.busy || !canRelease;
  release.addEventListener("click", () =>
    runTx("Release", (signer) => releaseLock(provider, signer, lock.id))
  );
  box.append(release);
  if (!canRelease) {
    let why = "Connect the receiver's wallet to release this lock.";
    if (!state.account) why = "Connect the receiver's wallet to release this lock.";
    else if (state.account !== lock.receiver) why = "Only the receiver can release this lock. The owner who launched it cannot, unless that address is also the receiver.";
    else if (lock.claimed) why = "This lock is already released.";
    else if (lock.locked) why = "This lock has not reached its end time.";
    box.append(el("p", "note", why));
  }
  section.append(box);
  root.append(section);
}

function render() {
  const pendingSecret = document.querySelector("#secret")?.value || "";
  const pendingMode = document.querySelector("#secret-mode")?.value;
  app.replaceChildren();
  const header = el("header", "");
  header.append(el("h1", "", "Koincity recovery"));
  const tokenLine = state.token
    ? `${state.token.name} (${state.token.symbol}), ${state.token.decimals} decimals. Token contract ${state.token.address}.`
    : `Token contract ${UP_TOKEN}.`;
  header.append(el("p", "", tokenLine));
  header.append(
    el(
      "p",
      "note",
      "Claim rewards, unstake, and release vested tokens. Nothing is sent until you approve it in Kondor or this tab's wallet."
    )
  );
  app.append(header);

  const warning = el("div", "warning");
  warning.append(
    el(
      "p",
      "",
      "Keep this computer private. A private key or seed typed here stays in this browser tab. It is not saved, not put in the page address, and not uploaded. Kondor is the safer way to connect. Do not paste a key into chat, and do not let the browser save it."
    )
  );
  app.append(warning);

  renderWallet(app);
  if (pendingSecret) {
    const secret = document.querySelector("#secret");
    if (secret) secret.value = pendingSecret;
  }
  if (pendingMode) {
    const mode = document.querySelector("#secret-mode");
    if (mode) mode.value = pendingMode;
  }
  const status = el("p", `status${state.error ? " error" : ""}`, state.status);
  app.append(status);
  renderPools(app);
  renderLocks(app);
}

async function boot() {
  render();
  try {
    const [token, pools] = await Promise.all([
      loadUpToken(provider),
      loadPools(provider, (text) => setStatus(text)),
    ]);
    state.token = token;
    state.pools = pools.pools;
    state.poolTotal = pools.total;
    if (pools.pools.length && !state.selectedPoolId) {
      state.selectedPoolId = String(pools.pools[0].id);
    }
    const upCount = pools.pools.filter((pool) => pool.usesUp).length;
    render();
    const locks = await loadAllLocks(provider, (text) => setStatus(text));
    state.locks = locks.locks;
    state.lockTotal = locks.total;
    state.locksLoaded = true;
    if (locks.locks.length && !state.selectedLockId) {
      state.selectedLockId = String(locks.locks[0].id);
    }
    const ready = locks.locks.filter((lock) => !lock.claimed && !lock.locked).length;
    setStatus(
      `Loaded ${pools.total} staking pools (${upCount} use Liquidity UP) and ${locks.total} token locks. ${ready} are ready for the receiver to release.`
    );
  } catch (error) {
    setStatus(error.message || "Could not read Koinos.", true);
  }
  render();
}

boot();
