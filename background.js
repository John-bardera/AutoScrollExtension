// background.js — Service Worker。単一の真実源として ON 状態と
// スクロール中のタブ ID を管理し、アクティブタブの追従を行う。

// --- 状態(メモリ上のみ。永続化は設定値だけ) --------------------------------
let active = false;        // スクロール実行中か
let activeTabId = null;    // スクロール中のタブ ID
let speed = 60;            // px/s(storage.sync から復元)
let behavior = 'resume';   // タブ切替時: 'resume' | 'pause'

const SPEED_MIN = 10;
const SPEED_MAX = 1000;
const DEFAULT_SPEED = 60;
const DEFAULT_BEHAVIOR = 'resume';

// --- 設定の読み込み --------------------------------------------------------
chrome.storage.sync
  .get({ speed: DEFAULT_SPEED, tabSwitchBehavior: DEFAULT_BEHAVIOR })
  .then((items) => {
    speed = items.speed;
    behavior = items.tabSwitchBehavior;
  })
  .catch(() => {
    /* デフォルト値のまま使う */
  });

// --- ヘルパー --------------------------------------------------------------
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

// --- トグル -----------------------------------------------------------------
const startOnTab = (tabId) => {
  sendToTab(tabId, { type: 'SCROLL_START', speed });
  activeTabId = tabId;
  active = true;
};

const stopOnTab = (tabId) => {
  sendToTab(tabId, { type: 'SCROLL_STOP' });
};

const toggleScroll = async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  if (active) {
    stopOnTab(activeTabId);
    active = false;
    activeTabId = null;
  } else {
    startOnTab(tab.id);
  }
};

// --- キーボードコマンド(Alt+S) ----------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-scroll') {
    toggleScroll();
  }
});

// --- タブ追従 ---------------------------------------------------------------
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!active) return;
  // 旧タブは必ず停止する。
  stopOnTab(activeTabId);
  if (behavior === 'resume') {
    // 新アクティブタブで即時に同速で再開。
    startOnTab(tabId);
  } else {
    // 一旦停止。Alt+S で再開できる。
    active = false;
    activeTabId = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    active = false;
    activeTabId = null;
  }
});

// --- content からの報告 -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SCROLL_STATE') {
    // 末尾到達など content 側で停止した場合の報告。
    if (!msg.active && sender.tab && sender.tab.id === activeTabId) {
      active = false;
      activeTabId = null;
    }
    return;
  }

  if (msg.type === 'SPEED_CHANGED') {
    if (typeof msg.speed === 'number') {
      speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, msg.speed));
      chrome.storage.sync.set({ speed }).catch(() => {});
    }
    return;
  }

  // --- popup からの要求 -------------------------------------------------------
  if (msg.type === 'GET_STATE') {
    sendResponse({ active, speed, behavior });
    return;
  }

  if (msg.type === 'SET_SPEED') {
    if (typeof msg.speed === 'number') {
      speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, msg.speed));
      chrome.storage.sync.set({ speed }).catch(() => {});
      // 実行中なら即時反映のため再送(startScroll の二重開始ガードで速度更新になる)。
      if (active && activeTabId !== null) {
        sendToTab(activeTabId, { type: 'SCROLL_START', speed });
      }
    }
    sendResponse({ active, speed, behavior });
    return;
  }

  if (msg.type === 'SET_BEHAVIOR') {
    if (msg.behavior === 'resume' || msg.behavior === 'pause') {
      behavior = msg.behavior;
      chrome.storage.sync.set({ tabSwitchBehavior: behavior }).catch(() => {});
    }
    sendResponse({ active, speed, behavior });
    return;
  }

  if (msg.type === 'TOGGLE') {
    toggleScroll().then(() => sendResponse({ active, speed, behavior }));
    return true; // 非同期応答
  }
});
