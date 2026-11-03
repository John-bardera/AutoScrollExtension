// i18n.js — 表示言語カタログ。content / popup で共有する。
// classic script として最初に読み込ませること(manifest の js 順序、
// popup.html の script 順序)。
// トップレベルの宣言(const/let/var)は行わない。chrome.scripting に
// よる再注入時に、以前のバージョンの const 宣言と衝突して
// SyntaxError になるのを防ぐため、window プロパティとして公開する。

(() => {
  if (window.AutoScrollT) return; // 再注入ガード

  const I18N = {
    ja: {
      title: '自動スクロール',
      btnStart: '開始',
      btnStop: '停止',
      secSpeed: '速度',
      secLanguage: '言語',
      footer: 'トグル: Alt+S(変更可)/ 速度調整: ↑↓(スクロール中)',
      overlayStart: '自動スクロール開始(速度: {speed} px/s)',
      overlayStop: '自動スクロール停止',
      overlaySpeed: '速度: {speed} px/s',
    },
    en: {
      title: 'Auto Scroll',
      btnStart: 'Start',
      btnStop: 'Stop',
      secSpeed: 'Speed',
      secLanguage: 'Language',
      footer: 'Toggle: Alt+S (configurable) / Speed: ↑↓ (while scrolling)',
      overlayStart: 'Auto scroll started (speed: {speed} px/s)',
      overlayStop: 'Auto scroll stopped',
      overlaySpeed: 'Speed: {speed} px/s',
    },
  };

  // 翻訳取得。未対応言語・未知キーは英語にフォールバックする。
  window.AutoScrollT = (lang, key, vars = {}) => {
    const cat = I18N[lang] || I18N.en;
    let text = cat[key] ?? I18N.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v));
    }
    return text;
  };
})();
