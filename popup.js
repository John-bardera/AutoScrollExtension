// popup.js — background とだけ会話する。状態は GET_STATE で取得し、
// 変更は SET_* / TOGGLE で background に任せる。表示言語は i18n.js の
// カタログで切替える。

const SPEED_MIN = 10;
const SPEED_MAX = 1000;

const toggleBtn = document.getElementById('toggle-btn');
const speedRange = document.getElementById('speed-range');
const speedNumber = document.getElementById('speed-number');
const behaviorRadios = document.querySelectorAll('input[name="behavior"]');
const languageSelect = document.getElementById('language-select');

const sendMessage = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        // ポートが閉じている場合などは undefined。最後に void で
        // チェックされた lastError を握り潰す。
        void chrome.runtime.lastError;
        resolve(res);
      });
    } catch (_) {
      resolve(undefined);
    }
  });

const clampSpeed = (v) =>
  Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(Number(v) || 0)));

// 静的ラベルを現在の言語で書き込む。
const applyLanguage = (lang) => {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = AutoScrollT(lang, el.dataset.i18n);
  }
};

const applyState = (state) => {
  if (!state) return;
  applyLanguage(state.language);
  toggleBtn.textContent = state.active
    ? AutoScrollT(state.language, 'btnStop')
    : AutoScrollT(state.language, 'btnStart');
  speedRange.value = state.speed;
  speedNumber.value = state.speed;
  languageSelect.value = state.language;
  for (const radio of behaviorRadios) {
    radio.checked = radio.value === state.behavior;
  }
};

const refresh = async () => {
  applyState(await sendMessage({ type: 'GET_STATE' }));
};

// --- イベント ---------------------------------------------------------------

toggleBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'TOGGLE' });
  await refresh();
});

// スライダーはドラッグ中リアルタイムに反映。
speedRange.addEventListener('input', async () => {
  const speed = clampSpeed(speedRange.value);
  speedNumber.value = speed;
  applyState(await sendMessage({ type: 'SET_SPEED', speed }));
});

// 数値入力は確定時(change)に反映。
speedNumber.addEventListener('change', async () => {
  const speed = clampSpeed(speedNumber.value);
  applyState(await sendMessage({ type: 'SET_SPEED', speed }));
});

for (const radio of behaviorRadios) {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    applyState(await sendMessage({ type: 'SET_BEHAVIOR', behavior: radio.value }));
  });
}

languageSelect.addEventListener('change', async () => {
  applyState(await sendMessage({ type: 'SET_LANGUAGE', language: languageSelect.value }));
});

// --- 初期化 ------------------------------------------------------------------
applyLanguage('ja'); // 状態取得前に一旦既定語で埋める(ちらつき防止)
refresh();
