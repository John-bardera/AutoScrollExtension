# 自動スクロール Chrome 拡張機能 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 長文読書支援のための、アクティブタブ追従型・速度永続化・滑らかスクロールの Chrome 拡張機能 (MV3)

**Architecture:** 全ページに常駐する content script が rAF ループでスクロールを実行し、background Service Worker が「アクティブタブの ID」を単一の真実源として ON/OFF を管理・中継する。タブ切替は background が検知して旧タブ停止・新タブ開始(設定次第)を行う。設定は storage.sync に永続化。

**Tech Stack:** Chrome Extension Manifest V3 / vanilla JS / chrome.commands / chrome.storage.sync / chrome.tabs

**Spec:** `docs/superpowers/specs/2026-11-02-auto-scroll-extension-design.md`

## Global Constraints

- Manifest V3(`"manifest_version": 3`)。Service Worker 形式の background
- 速度範囲は 10〜1000 px/s、デフォルト 60 px/s(初期値)
- スクロール対象は常に「アクティブウィンドウのアクティブタブ」のみ
- タブ切替時の挙動設定: `resume`(即時同速開始・デフォルト) / `pause`(一旦停止)
- トグルキーは `Alt+S`(chrome.commands 経由、ユーザーが chrome://extensions/shortcuts で変更可能)
- スクロール中の速度調整キーは `↑`/`↓`(±10 px/s)。テキスト入力中(input/textarea/contentEditable へのフォーカス)は無視
- 設定は `chrome.storage.sync` に保存(キー: `speed: number`、`tabSwitchBehavior: 'resume'|'pause'`)
- 外部ライブラリ・ビルドツールなし。全ファイルピュア JS/HTML/CSS
- すべてのコメント・UI 文言・README は日本語

## メッセージプロトコル(全タスク共通の契約)

background → content (`chrome.tabs.sendMessage`):
- `{type: 'SCROLL_START', speed: number}`
- `{type: 'SCROLL_STOP'}`

content → background (`chrome.runtime.sendMessage`):
- `{type: 'SCROLL_STATE', active: boolean}`(状態変化時に報告。末尾自動停止でも報告)
- `{type: 'SPEED_CHANGED', speed: number}`(↑↓で速度変更時に報告)

popup → background (`chrome.runtime.sendMessage`):
- `{type: 'GET_STATE'}` → 応答 `{active: boolean, speed: number, behavior: 'resume'|'pause'}`
- `{type: 'SET_SPEED', speed: number}`
- `{type: 'SET_BEHAVIOR', behavior: 'resume'|'pause'}`
- `{type: 'TOGGLE'}`(アクティブタブのスクロールをトグル)

## Review Focus

- **chrome:// ページ等、content script が注入されないページでの Alt+S**: エラーを出さず何も起こらない(送信失敗を握り潰す)。Task 3 で確認
- **速度境界値**: ↑↓連打やスライダー入力で 10 未満 / 1000 超にならないようクランプ。Task 2 と Task 4 で確認
- **ページ末尾到達後の Alt+S**: 末尾で停止した状態で再トグルした場合、スクロール位置が末尾のままなら即再停止(異常動作しない)。手動確認(TASK 5 チェックリストに記載)
- **エラーページ・空白タブ(new tab)** での Alt+S: 拡張が落ちない。Task 3 で確認
- **ポップアップと content の速度の食い違い**: ↑↓で変えた速度を popup を開き直したとき正しく表示される(SPEED_CHANGED を storage に反映している限り発生しない)。Task 4 で確認

---

### Task 1: プロジェクト雛形と manifest

**Files:**
- Create: `manifest.json`
- Create: `README.md`(雛形のみ。フルのチェックリストは Task 5)

**Interfaces:**
- Consumes: なし(最初のタスク)
- Produces: manifest.json の構造(commands、permissions、content_scripts)。Task 2〜4 が参照する

- [ ] **Step 1: git リポジトリ初期化と manifest.json 作成**

`git init` を実行。`manifest.json` を作成:
`"manifest_version": 3`、`"name": "Auto Scroll"`、`"version": "0.1.0"`、`"description"`(日本語で一行)、`"permissions": ["storage", "tabs"]`、`"background": {"service_worker": "background.js"}`、`"content_scripts": [{"matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle"}]`、`"action": {"default_popup": "popup.html", "default_title": "Auto Scroll"}`、`"commands": {"toggle-scroll": {"suggested_key": {"default": "Alt+S"}, "description": "自動スクロールの ON/OFF 切替"}}`
(この時点で background.js / content.js / popup は未作成だが、Task 2〜4 で作成するため manifest は最終形を書く)

- [ ] **Step 2: README.md 雛形作成**

プロジェクト名・目的(設計書へのリンク)のみ記載。

- [ ] **Step 3: 構文検証**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('OK')"` (auto-scroll-extension ディレクトリで)
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add manifest.json README.md
git commit -m "feat: manifest雛形とREADME作成"
```

---

### Task 2: content.js スクロールエンジン

**Files:**
- Create: `content.js`

**Interfaces:**
- Consumes: メッセージ `SCROLL_START {speed}` / `SCROLL_STOP`(Task 1 のプロトコル)
- Produces: 送信 `SCROLL_STATE {active}` / `SPEED_CHANGED {speed}`。Task 3 の background が受信する

- [ ] **Step 1: スクロールエンジン本体を実装**

`content.js` に以下を実装(1 ファイル、関数は小分けにする):
- モジュール状態: `running: boolean`、`speed: number`、`residual: number`(小数残差)、`rafId: number|null`
- `startScroll(newSpeed)`: speed を設定し rAF ループ開始(running 二重開始のガード付き)。`SCROLL_STATE {active: true}` を送信
- rAF ループ: `dt = (now - lastTime) / 1000` を計算し `residual += speed * dt`。`whole = Math.floor(residual)` が 1 以上のとき `window.scrollBy(0, whole)` して `residual -= whole`。`window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1` で末尾到達と判定し `stopScroll()`(残差もリセット)
- `stopScroll()`: rAF キャンセル、running=false、`SCROLL_STATE {active: false}` 送信
- メッセージ受信: `SCROLL_START` → `startScroll(msg.speed)`、`SCROLL_STOP` → `stopScroll()`。応答として `true` を返さない(非同期応答なし)
- キー操作(`keydown` を document でリスン、`running` 中のみ有効): `ArrowUp` なら `speed = clamp(speed + 10, 10, 1000)`、`ArrowDown` なら `speed = clamp(speed - 10, 10, 1000)`。`e.isComposing` または `document.activeElement` が `input`/`textarea`/`isContentEditable` の場合は無視。変更時 `storage.sync.set({speed})` し `SPEED_CHANGED {speed}` を送信し、オーバーレイ表示
- 速度オーバーレイ: 画面右下に固定配置の小さな div(`position: fixed`、半透明、pointer-events なし)、`速度: 120 px/s` の形式。表示から 1.2 秒後に fadeout して除去(`setTimeout`、連続押下時はタイマー再設定)
- 末尾停止時もオーバーレイに「ページ末尾で停止しました」を一時表示

- [ ] **Step 2: 動作確認(手動)**

`chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込み」でディレクトリを読み込む。長い適当なページ(例: 任意のドキュメントサイト)の DevTools コンソールで `chrome.runtime.sendMessage` の代替として、直接 `SCROLL_START` 相当を確認できないため、一時的に `window.dispatchEvent(new KeyboardEvent(...))` 等は使わず、**次のタスクで background が揃ってから確認する**。この時点ではコンソールに content.js の構文エラーが出ていないことのみ確認(拡張機能ページの「エラー」ボタンが赤くならない)。
Expected: 拡張機能読み込みエラーなし

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: content.js スクロールエンジン実装"
```

---

### Task 3: background.js 状態管理とタブ追従

**Files:**
- Create: `background.js`

**Interfaces:**
- Consumes: Task 2 の `SCROLL_STATE` / `SPEED_CHANGED` 受信、Task 1 の commands。`tabs.query({active: true, lastFocusedWindow: true})` でアクティブタブを取得
- Produces: `GET_STATE` / `SET_SPEED` / `SET_BEHAVIOR` / `TOGGLE` への応答。Task 4 の popup が利用

- [ ] **Step 1: background.js を実装**

- メモリ状態: `activeTabId: number|null`(スクロール実行中のタブ)、`active: boolean`(全体の ON 状態)、`speed: number`、`behavior: 'resume'|'pause'`(起動時に storage.sync から読み込み、未設定なら 60 / 'resume')
- `sendToTab(tabId, msg)`: `chrome.tabs.sendMessage` を try/catch なしの `.catch(()=>{})` で呼ぶ(chrome:// ページ等での送信失敗を静かに無視)
- コマンド `toggle-scroll` 受信: アクティブタブを取得。`active` が true なら `SCROLL_STOP` を activeTabId へ送り停止。false なら `SCROLL_START {speed}` を送り activeTabId を記録
- `tabs.onActivated` 受信: 旧 activeTabId に `SCROLL_STOP` を送信。`behavior === 'resume'` かつ `active` が true なら新タブに `SCROLL_START {speed}` を送り activeTabId を更新。`pause` なら active を false にする(移動先は停止状態。Alt+S で再開)
- `tabs.onRemoved` 受信: 閉じられたタブが activeTabId なら状態をリセット
- content からの `SCROLL_STATE {active: false}` 受信(末尾自動停止): 送信元が activeTabId なら全体の `active` も false に
- content からの `SPEED_CHANGED {speed}` 受信: `speed` を更新し `storage.sync.set({speed})`
- popup からの `GET_STATE`: `Promise.resolve({active, speed, behavior})` を返す。`SET_SPEED` / `SET_BEHAVIOR`: storage に保存し、動作中なら `SET_SPEED` のときアクティブタブへ `SCROLL_START {speed}` を送り直す(速度を即時反映)。`TOGGLE`: コマンドと同じ処理を共通関数 `toggleScroll()` に切り出して呼ぶ

- [ ] **Step 2: 動作確認(手動)**

拡張機能を再読み込みし、長いページで確認:
1. Alt+S → スクロール開始。もう一度 → 停止
2. スクロール中に ↑/↓ → 速度が変わりオーバーレイ表示
3. スクロール中に別タブへ Ctrl+Tab → 旧タブは停止、新タブが即同じ速度でスクロール(デフォルト 'resume')
4. chrome://extensions タブを開いた状態で Alt+S → 何も起こらずエラーも出ない
5. 空の新規タブで Alt+S → エラーが出ない
Expected: すべて確認できる

- [ ] **Step 3: Commit**

```bash
git add background.js
git commit -m "feat: background.js 状態管理とタブ追従実装"
```

---

### Task 4: popup UI

**Files:**
- Create: `popup.html`
- Create: `popup.css`
- Create: `popup.js`

**Interfaces:**
- Consumes: background の `GET_STATE` / `SET_SPEED` / `SET_BEHAVIOR` / `TOGGLE`(Task 3 の応答形式)
- Produces: なし(最終 UI)

- [ ] **Step 1: popup.html / popup.css を作成**

縦 260px × 幅 300px 程度のパネル:
- ヘッダ(タイトル「自動スクロール」)と ON/OFF トグルボタン(状態に応じてラベル「開始」/「停止」)
- 速度セクション: `<input type="range" min="10" max="1000" step="10">` と `<input type="number" min="10" max="1000">` を横並びにし、単位「px/s」表示。両者は双方向同期
- タブ切替時の挙動セクション: ラジオボタン 2 つ「切り替え先でも同じ速度で続ける(resume)」「切り替え先では停止する(pause)」
- フッタに小さく「トグル: Alt+S / 速度調整: ↑↓(スクロール中)」の操作ガイド
- デザインは余白・行間を丁寧に、控えめな配色。`prefers-reduced-motion` があればアニメーションなし

- [ ] **Step 2: popup.js を実装**

- 開いたとき `GET_STATE` で `active / speed / behavior` を取得し UI に反映(トグルボタン ラベル、スライダー・数値、ラジオ)
- トグルボタン → `TOGGLE` 送信後、再度 `GET_STATE` でボタン ラベルを更新
- スライダー `input` イベント・数値 `change` イベント → `clamp(10, 1000)` して `SET_SPEED` 送信(スライダーはドラッグ中リアルタイム、数値入力は確定時)
- ラジオ → `SET_BEHAVIOR` 送信
- ↑↓で速度を変えた後に popup を開き直し、表示速度が最新になっていることを確認(Review Focus 項目)

- [ ] **Step 3: 動作確認(手動)**

1. popup で速度を 200 に変更 → 開いているスクロールの速度が即変わる
2. popup で「停止する」を選びタブ切替 → 移動先ではスクロールしない。Alt+S で前回速度で開始
3. スクロール中 ↑↓ で速度変更 → popup を開き直すとその値が表示されている
4. 数値入力に 5000 と入力 → 1000 にクランプされる
Expected: すべて確認できる

- [ ] **Step 4: Commit**

```bash
git add popup.html popup.css popup.js
git commit -m "feat: popup UI 実装"
```

---

### Task 5: テストページ・README・最終検証

**Files:**
- Create: `test-page.html`
- Modify: `README.md`(チェックリストを追記)

**Interfaces:**
- Consumes: 完成した拡張機能全体
- Produces: なし(検証)

- [ ] **Step 1: test-page.html を作成**

`test-page.html` を開くだけで長文スクロール試験ができるページ: 見出し付きの日本語ダミー段落を 30 程度(`scrollHeight` が確実に viewport を超える量)、スクロール位置を把握しやすいよう各セクションに番号。外部リソースなし。

- [ ] **Step 2: README.md にインストール手順とチェックリストを追記**

- インストール: chrome://extensions → デベロッパーモード → パッケージ化されていない拡張機能を読み込み → ディレクトリ選択
- キー割り当て変更方法: chrome://extensions/shortcuts
- 手動確認チェックリスト(設計書「テスト方針」の項目すべて):
  1. Alt+S トグル(開始/停止)
  2. ↑↓での速度変化(±10、クランプ 10〜1000)とオーバーレイ
  3. 末尾到達での自動停止と、その後の Alt+S 再開(末尾のままなら即停止でも正常)
  4. タブ切替: resume / pause 両挙動
  5. popup のスライダー・数値入力・ラジオの反映
  6. ブラウザ再起動後、Alt+S で前回速度で開始するか(storage.sync 検証)
  7. テキスト入力中は ↑↓ が無視されるか
  8. chrome:// ページ・新規タブで Alt+S を押してもエラーにならないか

- [ ] **Step 3: 最終検証(手動)**

`test-page.html` を file:// で開き、上記チェックリスト 1〜8 を実施。
Expected: すべてパス

- [ ] **Step 4: Commit**

```bash
git add test-page.html README.md
git commit -m "feat: テストページとREADMEチェックリスト追加"
```
