# Moto-Agent PWA App

這個專案現在以 Web/PWA 為主要方案。它可以部署成 HTTPS 網頁，手機第一次連線後會快取必要檔案，之後即使離線也可以開啟 App 介面與執行本機 ML 推論。

## 本機測試

```bash
python -m http.server 4173 --bind 127.0.0.1
```

開啟 `http://localhost:4173/index.html`。手機實測時請部署到 HTTPS，因為 GPS 與 IMU 權限需要安全環境。

## 手機 PWA 測試

1. 將整個專案部署到 HTTPS，例如 GitHub Pages。
2. 手機瀏覽器開啟部署後的網址。
3. 第一次在線上完整載入一次 App，讓 service worker 快取 `index.html`、CSS、JS、ML 規則與 icon。
4. Android Chrome 可選「安裝應用程式」或「加到主畫面」。
5. iPhone Safari 使用分享按鈕，選「加入主畫面」。
6. 之後從主畫面開啟，即使沒有網路也能載入 App。

離線可用範圍：

- App UI、風險狀態機與 JavaScript 決策樹推論可離線執行。
- IMU 感測器可在使用者授權後本機讀取。
- GPS 是否能離線取得速度，會依手機、系統與定位狀態而定；沒有網路時定位首次收斂可能比較慢。
- 沒有使用外部地圖或外部字型，因此離線畫面不會缺圖示。

## GitHub Pages 部署

本專案已包含 `.github/workflows/deploy-pages.yml`。推送到 GitHub 後，GitHub Actions 會執行 `npm run build:web`，把 `www/` 發佈到 GitHub Pages。

第一次設定：

1. 在 GitHub 建立一個 repository，例如 `moto-agent`。
2. 將這個專案推送到 GitHub。
3. 到 repository 的 `Settings` -> `Pages`。
4. 在 `Build and deployment` 的 `Source` 選 `GitHub Actions`。
5. 到 `Actions` 分頁，等待 `Deploy PWA to GitHub Pages` 成功。
6. 回到 `Settings` -> `Pages`，打開 `Visit site`。

常見網址格式：

```text
https://你的GitHub帳號.github.io/你的repository名稱/
```

手機第一次打開這個 HTTPS 網址後，就可以加入主畫面並測試離線模式。

## 重新訓練並同步 App 規則

```bash
python train_aerox_baseline.py
```

這會輸出訓練報告到 `output/`，並同步更新 App 使用的 `aerox_ml_rules.js`。手機端會匯入這個 JavaScript 決策樹進行邊緣推論。

## Capacitor 打包

Capacitor 現在是可選方案。如果要改回 native shell，可使用以下流程。

依照 Capacitor v8 文件，現有 Web 專案需要 `package.json`、獨立 web assets 目錄與 assets 目錄內的 `index.html`。本專案用 `www/` 作為 `webDir`。

```bash
npm install
npm run build:web
npm run cap:add:android
npm run cap:add:ios
npm run cap:sync
```

Android 可用 Android Studio 開啟 `android/` 建置 APK。iOS 需要在 macOS 上用 Xcode 開啟 `ios/` 建置與簽章。

本 workspace 路徑含中文時，Windows 上的 Capacitor CLI 可能會在載入 npm 套件時靜默退出。因此 `package.json` 的 `cap:*` 指令會透過 `scripts/capacitor-from-ascii-temp.ps1` 先複製到 ASCII 暫存路徑，再把生成或同步後的 `android/`、`ios/` 複製回專案。

官方流程參考：https://capacitorjs.com/docs/getting-started
