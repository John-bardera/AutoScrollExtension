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
const DEFAULT_LANGUAGE = 'ja';
const SAVE_DEBOUNCE_MS = 300;   // storage.sync 書き込み制限対策
const QUERY_TIMEOUT_MS = 500;    // content への実行状態問い合わせの猶予(タブのスロトルを吸収)
const START_RETRY_INTERVAL_MS = 300; // content 注入待ちの再送間隔
const START_RETRY_MAX = 10;           // 再送回数(計約3秒)

// content script が注入される(=トグルが機能する)URL スキーム。
const SCROLLABLE_SCHEMES = ['http:', 'https:', 'file:'];

// --- 診断ログ -----------------------------------------------------------------
// SW コンソール(arc://extensions → Auto Scroll → service worker)で
// 経路を追跡できるようにする。Arc 等での切り分け用。
const diag = (...args) => console.debug('[AutoScroll]', ...args);

// --- 状態 ---------------------------------------------------------------------
let active = false;        // スクロール実行中か(storage.session にミラー)
let activeTabId = null;    // スクロール中のタブ ID(storage.session にミラー)
let speed = DEFAULT_SPEED; // px/s(storage.sync から復元)
let behavior = DEFAULT_BEHAVIOR; // 'resume' | 'pause'
let language = DEFAULT_LANGUAGE; // 'ja' | 'en'

// --- 初期化: SW 起動時に設定と実行状態を復元 ------------------------------------
// GET_STATE 等の応答はこの Promise の完了を待つ(起動レース防止)。
const ready = (async () => {
  try {
    const [sync, session] = await Promise.all([
      chrome.storage.sync.get({
        speed: DEFAULT_SPEED,
        tabSwitchBehavior: DEFAULT_BEHAVIOR,
        language: DEFAULT_LANGUAGE,
      }),
      chrome.storage.session.get({ active: false, activeTabId: null }),
    ]);
    speed = sync.speed;
    behavior = sync.tabSwitchBehavior;
    language = sync.language;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SCROLL_START を送り、content の注入・開始を確認できなければ再送する。
// onActivated が content script 注入(document_idle)より先に発火して
// 「受信者なし」で握り潰される race をここで回収する。
// 各試行でタブの URL を確認し、chrome:// 等の非スクロール可能なページと
// 判明したら中断する(生成直後で URL が空・about:blank の場合は読み込み
// 待ちとして再送を続ける)。
const abortStart = () => {
  active = false;
  activeTabId = null;
  persistSession();
};

const startOnTab = async (tabId) => {
  activeTabId = tabId;
  active = true;
  persistSession();
  for (let attempt = 0; attempt <= START_RETRY_MAX; attempt++) {
    if (!active || activeTabId !== tabId) return; // 停止/別タブへ移った
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return; // タブが閉じられた
    }
    const url = tab.url || '';
    diag(`startOnTab 試行${attempt}: url=${url}`);
    if (url.startsWith('chrome-extension://')) {
      diag('startOnTab 中断: 拡張自身の UI');
      abortStart(); // 拡張自身の UI では開始しない
      return;
    }
    // 生成直後のタブは URL が空または about:blank のことがあり、遷移を
    // 待つ必要があるため pending 扱いとする。
    if (url && url !== 'about:blank' && !isScrollableTab(tab)) {
      diag('startOnTab 中断: 非スクロール可能な URL(サイトへのアクセス権やスキームを確認)');
      abortStart(); // chrome:// 等では開始しない
      return;
    }
    sendToTab(tabId, { type: 'SCROLL_START', speed });
    await sleep(START_RETRY_INTERVAL_MS);
    if (!active || activeTabId !== tabId) return;
    if (await queryTabRunning(tabId)) {
      diag(`startOnTab 確認: 開始済み(${attempt + 1} 回目)`);
      return; // 開始を確認
    }
  }
  diag('startOnTab 期限切れ: content の開始を確認できません(注入されていない可能性)');
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
  diag(`toggleScroll: url=${tab ? tab.url : '(タブなし)'}`);
  if (!tab || !isScrollableTab(tab)) {
    diag('toggleScroll 何もしない: スクロール不可能なページ');
    return; // chrome:// 等では何もしない
  }
  if (await queryTabRunning(tab.id)) {
    stopScroll();
  } else {
    await startOnTab(tab.id);
  }
};

// --- キーボードコマンド(Alt+S) ---------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  diag(`onCommand: ${command}`);
  if (command === 'toggle-scroll') {
    toggleScroll();
  }
});

// --- タブ追従 --------------------------------------------------------------------
// タブまたはウィンドウのフォーカス移動の共通処理。
// requireSameWindow: onActivated 経由では、スクロール中タブと同一ウィンドウの
// 活性化のみを扱う。別ウィンドウのタブ活性化(拡張の popup ウィンドウ生成や
// 他ウィンドウでのプログラマティックな切替)はフォーカスを伴わない可能性が
// あり、フォーカス移動は onFocusChanged が別途処理するため無視する。
const handleTabChange = async (tabId, requireSameWindow = false) => {
  await ready;
  diag(`handleTabChange: tabId=${tabId} requireSameWindow=${requireSameWindow} active=${active}`);
  if (!active) return;
  if (tabId === activeTabId) return; // 二重発火ガード

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return; // 取得できないタブ:何もしない
  }

  if (requireSameWindow && activeTabId !== null) {
    let cur = null;
    try {
      cur = await chrome.tabs.get(activeTabId);
    } catch (_) {
      /* スクロール中タブが消えた場合は通常の経路へ */
    }
    if (cur && cur.windowId !== tab.windowId) {
      diag('handleTabChange 無視: 別ウィンドウの活性化');
      return; // 別ウィンドウ:無視
    }
  }

  if (tab) {
    diag(`handleTabChange: 新タブ url=${tab.url || '(空)'}`);
  }
  // 旧タブは必ず停止する。
  stopScroll();
  if (behavior === 'resume') {
    // 新アクティブタブで即時に同速で再開する。URL の判定(生成直後は空や
    // about:blank のことがある)と注入待ちは startOnTab の再送ループが
    // 行う:chrome:// 等と判明すれば中断、読み込み中なら待つ。
    await startOnTab(tabId);
  }
  // 'pause' の場合や非スクロール可能タブ(chrome:// 等)への移動は
  // 一旦停止。Alt+S で再開できる。
};

chrome.tabs.onActivated.addListener(({ tabId }) => {
  handleTabChange(tabId, true);
});

// スクロール中タブの再読み込み・遷移でも再開する(content が一度消えるため)。
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  if (!active || tabId !== activeTabId) return;
  diag(`onUpdated 再開: tabId=${tabId}`);
  startOnTab(tabId); // 冪等(二重開始ガード)+ 注入待ち再送
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
const getState = () => ({ active, speed, behavior, language });

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

    case 'SET_LANGUAGE':
      if (msg.language === 'ja' || msg.language === 'en') {
        language = msg.language;
        chrome.storage.sync.set({ language }).catch(() => {});
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
    msg.type === 'SET_LANGUAGE' ||
    msg.type === 'TOGGLE'
  ) {
    (async () => {
      await ready;
      sendResponse(await handleCommand(msg));
    })();
    return true; // sendResponse を非同期で呼ぶ
  }
});
