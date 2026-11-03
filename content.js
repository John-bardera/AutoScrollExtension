// content.js — 自動スクロール本体。
// background からの SCROLL_START / SCROLL_STOP メッセージで開始・停止する。
// rAF ループで speed × dt を加算し、小数残差を蓄積して整数 px でのみ
// scrollBy を発行する(丸め誤差が溜まらず速度が揺れない)。

(() => {
  'use strict';

  // chrome.scripting による再注入ガード(manifest 注入と二重になるのを防ぐ)。
  if (window.__autoScrollInjected) return;
  window.__autoScrollInjected = true;

  // --- 状態 ---------------------------------------------------------------
  let running = false;
  let speed = 60;        // px/s
  let residual = 0;      // 整数化できなかった小数の残差(px)
  let lastTime = 0;
  let rafId = null;
  let lang = 'ja';       // 表示言語(storage.sync から復元)

  const SPEED_MIN = 10;
  const SPEED_MAX = 1000;
  const SPEED_ADJUST = 10; // ↑↓ 1押下あたりの変化量
  const DT_MAX = 0.1;      // dt の上限秒(rAF 復帰時の急移動を防ぐ)

  // --- 言語 ---------------------------------------------------------------
  chrome.storage.sync
    .get({ language: 'en' })
    .then((items) => {
      lang = items.language;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.language) lang = changes.language.newValue;
  });

  // --- 送信ヘルパー --------------------------------------------------------
  // background が無い場面(拡張再読み込み直後など)でも落ちないように握り潰す。
  const sendToBackground = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {
      /* 拡張コンテキスト無効化済み */
    }
  };

  // --- オーバーレイ --------------------------------------------------------
  let overlayEl = null;
  let overlayTimer = null;

  const showOverlay = (text, duration = 1200) => {
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'padding:6px 12px;border-radius:8px;background:rgba(20,20,20,0.75);' +
        'color:#fff;font:13px/1.4 sans-serif;pointer-events:none;' +
        'transition:opacity 0.4s ease;opacity:1;';
      document.documentElement.appendChild(overlayEl);
    }
    overlayEl.textContent = text;
    overlayEl.style.opacity = '1';
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      overlayEl.style.opacity = '0';
    }, duration);
  };

  // --- スクロール本体 ------------------------------------------------------
  const tick = (now) => {
    if (!running) return;
    const dt = Math.min((now - lastTime) / 1000, DT_MAX);
    lastTime = now;
    residual += speed * dt;
    const whole = Math.floor(residual);
    if (whole >= 1) {
      residual -= whole;
      window.scrollBy(0, whole);
    }
    // 末尾では特に停止しない。ユーザーが上へ戻ればそこから再び流れる。
    rafId = requestAnimationFrame(tick);
  };

  const startScroll = (newSpeed) => {
    if (typeof newSpeed === 'number') speed = newSpeed;
    if (running) {
      // 二重開始ガード:速度だけ更新する(冪等)
      return;
    }
    residual = 0;
    lastTime = performance.now();
    running = true;
    rafId = requestAnimationFrame(tick);
    sendToBackground({ type: 'SCROLL_STATE', active: true });
    showOverlay(AutoScrollT(lang, 'overlayStart', { speed }));
  };

  const stopScroll = () => {
    if (!running) return;
    running = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    residual = 0;
    sendToBackground({ type: 'SCROLL_STATE', active: false });
    showOverlay(AutoScrollT(lang, 'overlayStop'));
  };

  // --- メッセージ受信 ------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'SCROLL_START') {
      startScroll(msg.speed);
    } else if (msg.type === 'SCROLL_STOP') {
      stopScroll();
    } else if (msg.type === 'SCROLL_QUERY') {
      // background がトグル判定に使う実行状態の問い合わせ。
      sendResponse({ running });
    }
  });

  // --- キーボード速度調整(スクロール中のみ) --------------------------------
  const clampSpeed = (v) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));

  const isTypingContext = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      el.isContentEditable
    );
  };

  document.addEventListener('keydown', (e) => {
    if (!running || e.isComposing || isTypingContext()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 修飾キー付きは素通し
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    speed = clampSpeed(speed + (e.key === 'ArrowUp' ? SPEED_ADJUST : -SPEED_ADJUST));
    // 永続化は background が SPEED_CHANGED で行う(書き込み二重化を避ける)。
    sendToBackground({ type: 'SPEED_CHANGED', speed });
    showOverlay(AutoScrollT(lang, 'overlaySpeed', { speed }));
  });
})();
