// background.js — Service Worker。単一の真実源として ON 状態と
// スクロール中のタブ ID を管理し、アクティブタブの追従を行う。
// MV3 の SW はアイドルで落とされるため、実行状態は storage.session
// にミラーして SW 再起動後も復元する。トグル判定は content への
// 問い合わせ(query)を真実源とし、メモリ状態のズレに依存しない。

// --- 定数 -------------------------------------------------------------------
const SPEED_MIN = 10;
const SPEED_MAX = 1000;
const DEFAULT_SPEED = 60;
const DEFAULT_BEHAVIOR = 'resume';
const SAVE_DEBOUNCE_MS = 300;   // storage.sync 書き込み制限対策
const QUERY_TIMEOUT_MS = 200;    // content への実行状態問い合わせの猶予

// content script が注入される(=トグルが機能する)URL スキーム。
const SCROLLABLE_SCHEMES = ['http:', 'https:', 'file:'];

// --- 状態 ---------------------------------------------------------------------
let active = false;        // スクロール実行中か(storage.session にミラー)
let activeTabId = null;    // スクロール中のタブ ID(storage.session にミラー)
let speed = DEFAULT_SPEED; // px/s(storage.sync から復元)
let behavior = DEFAULT_BEHAVIOR; // 'resume' | 'pause'

// --- 初期化: SW 起動時に設定と実行状態を復元 ------------------------------------
// GET_STATE 等の応答はこの Promise の完了を待つ(起動レース防止)。
const ready = (async () => {
  try {
    const [sync, session] = await Promise.all([
      chrome.storage.sync.get({
        speed: DEFAULT_SPEED,
        tabSwitchBehavior: DEFAULT_BEHAVIOR,
      }),
      chrome.storage.session.get({ active: false, activeTabId: null }),
    ]);
    speed = sync.speed;
    behavior = sync.tabSwitchBehavior;
    active = session.active;
    activeTabId = session.activeTabId;
  } catch (_) {
    /* 既定値のまま使う */
  }
})();

// --- ヘルパー ------------------------------------------------------------------
// chrome:// ページや注入前のタブへの送信失敗は静かに無視する。
const sendToTab = (tabId, msg) => {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
};

// アクティブウィンドウのアクティブタブを取得する。
const getActiveTab = async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab || null;
  } catch (_) {
    return null;
  }
};

// 実行状態を storage.session へミラーする(SW 再起動対策)。
const persistSession = () => {
  chrome.storage.session.set({ active, activeTabId }).catch(() => {});
};

// storage.sync への速度保存はデバウンスする(書き込みレート制限対策)。
let saveTimer = null;
const scheduleSpeedSave = () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.sync.set({ speed }).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
};

// content script が注入されるページかどうか。
const isScrollableTab = (tab) => {
  if (!tab.url) return false;
  try {
    return SCROLLABLE_SCHEMES.includes(new URL(tab.url).protocol);
  } catch (_) {
    return false;
  }
};

// タブの content script に実行中か問い合わせる。応答のないタブ
// (chrome:// 等、注入されていない)は停止中扱い。
const queryTabRunning = async (tabId) => {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'SCROLL_QUERY' }),
      new Promise((resolve) => setTimeout(() => resolve(null), QUERY_TIMEOUT_MS)),
    ]);
    return !!(res && res.running);
  } catch (_) {
    return false;
  }
};

// --- トグル ---------------------------------------------------------------------
const startOnTab = (tabId) => {
  sendToTab(tabId, { type: 'SCROLL_START', speed });
  activeTabId = tabId;
  active = true;
  persistSession();
};

const stopScroll = () => {
  if (activeTabId !== null) {
    sendToTab(activeTabId, { type: 'SCROLL_STOP' });
  }
  active = false;
  activeTabId = null;
  persistSession();
};

// トグルはタブへの問い合わせ結果で決める(メモリ状態のズれに依存しない)。
const toggleScroll = async () => {
  await ready;
  const tab = await getActiveTab();
  if (!tab || !isScrollableTab(tab)) return; // chrome:// 等では何もしない
  if (await queryTabRunning(tab.id)) {
    stopScroll();
  } else {
    startOnTab(tab.id);
  }
};

// --- キーボードコマンド(Alt+S) ---------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-scroll') {
    toggleScroll();
  }
});

// --- タブ追従 --------------------------------------------------------------------
const handleTabChange = async (tabId) => {
  await ready;
  if (!active) return;
  if (tabId === activeTabId) return; // 二重発火ガード
  // 旧タブは必ず停止する。
  stopScroll();
  if (behavior === 'resume') {
    // 新アクティブタブで即時に同速で再開。
    startOnTab(tabId);
  }
  // 'pause' の場合は一旦停止。Alt+S で再開できる。
};

chrome.tabs.onActivated.addListener(({ tabId }) => {
  handleTabChange(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    active = false;
    activeTabId = null;
    persistSession();
  }
});

// ウィンドウ間のフォーカス移動。タブ切替を伴わないウィンドウ切替では
// tabs.onActivated が発火しないため、こちらでも追従する。
// フォーカスが Chrome 外へ移った場合(WINDOW_ID_NONE)も停止する。
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ready;
  if (!active) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    stopScroll();
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await handleTabChange(tab.id);
  } catch (_) {
    /* 握り潰し */
  }
});

// --- メッセージ受信 ------------------------------------------------------------------
const getState = () => ({ active, speed, behavior });

// popup からの要求。戻り値で応答する。
const handleCommand = async (msg) => {
  switch (msg.type) {
    case 'GET_STATE':
      return getState();

    case 'TOGGLE':
      await toggleScroll();
      return getState();

    case 'SET_SPEED':
      if (typeof msg.speed === 'number') {
        speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, msg.speed));
        scheduleSpeedSave();
        // 実行中なら即時反映のため再送(startScroll の二重開始ガードで速度更新になる)。
        if (active && activeTabId !== null) {
          sendToTab(activeTabId, { type: 'SCROLL_START', speed });
        }
      }
      return getState();

    case 'SET_BEHAVIOR':
      if (msg.behavior === 'resume' || msg.behavior === 'pause') {
        behavior = msg.behavior;
        chrome.storage.sync.set({ tabSwitchBehavior: behavior }).catch(() => {});
      }
      return getState();

    default:
      return undefined;
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // content からの報告(応答不要)。
  if (msg.type === 'SCROLL_STATE') {
    if (msg.active && sender.tab) {
      // 開始報告:送信元タブを実行中タブとして再同期する。
      active = true;
      activeTabId = sender.tab.id;
      persistSession();
    } else if (!msg.active && sender.tab && sender.tab.id === activeTabId) {
      // 末尾到達など content 側で停止した場合の報告。
      active = false;
      activeTabId = null;
      persistSession();
    }
    return;
  }

  if (msg.type === 'SPEED_CHANGED') {
    if (typeof msg.speed === 'number') {
      speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, msg.speed));
      scheduleSpeedSave();
    }
    return;
  }

  // popup からの要求(非同期応答)。
  if (
    msg.type === 'GET_STATE' ||
    msg.type === 'SET_SPEED' ||
    msg.type === 'SET_BEHAVIOR' ||
    msg.type === 'TOGGLE'
  ) {
    (async () => {
      await ready;
      sendResponse(await handleCommand(msg));
    })();
    return true; // sendResponse を非同期で呼ぶ
  }
});
