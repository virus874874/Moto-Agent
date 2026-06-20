# Moto-Agent

Moto-Agent 是一個以機車騎乘安全監測為主題的 Web/PWA 專題。  
使用手機上的 **GPS 與 IMU 感測器資料**，結合 Aerox 資料集訓練出的決策樹規則與即時風險判斷，提供速度、傾角、Jerk 與風險 Level 顯示。

目前專案以 GitHub Pages + PWA 為主要部署方式。手機第一次載入後會快取必要檔案，之後可離線開啟 App 介面與執行本機推論。

## Demo

GitHub Pages:

```text
https://virus874874.github.io/Moto-Agent/
```


## Features

- PWA 網頁版 App，可加入 Android / iOS 主畫面
- 離線快取 App 介面、CSS、JS、icon 與 ML 推論規則
- 使用 GPS 估算車速
- 使用 DeviceMotion / DeviceOrientation 取得 IMU 資料
- 即時顯示速度、傾角與 Jerk
- 使用 Aerox 感測器資料訓練出的 JavaScript 決策樹做本機推論
- 風險狀態包含 Level 0、Level 1 疲勞晃動、Level 2

## Risk Levels

### Level 0 狀態正常

一般穩定狀態。  
此時 Jerk 卡片為綠色。

### Level 1 疲勞晃動

代表連續晃動或蛇行傾向。  
Level 1 條件需要連續達成約 `2.2 秒` 才會顯示。

主要參考：

- ML 判斷為 `fatigue`
- ML 判斷為 `critical_like` 但未達 Level 2
- 中速以上大傾角
- 中速以上高 Jerk
- yaw RMS / yaw variance / yaw zero crossings 偏高

### Level 2 高風險

代表高風險動態。  
Level 2 條件需要連續達成約 `1.8 秒` 才會顯示，主要綜合速度、傾角、Jerk、yaw 與 ML `critical_like` 判斷。

## Machine Learning

本專案的機器學習不是在網頁中載入 `.pkl` 或 `.h5` 模型，而是採用「訓練後轉成 JavaScript 規則」的方式。

訓練程式：

```text
train_aerox_baseline.py
```

流程：

1. 讀取 Aerox CSV 感測器資料
2. 抽取速度、加速度、陀螺儀、yaw variance、zero crossings 等特徵
3. 依照專題文件建立弱標籤
4. 訓練 `DecisionTreeClassifier` 與 `RandomForestClassifier`
5. 將決策樹輸出為前端可執行的 JavaScript

App 實際使用的推論檔：

```text
aerox_ml_rules.js
```

網頁端在 `app.js` 中匯入：

```js
import { classifyMotoRisk } from "./aerox_ml_rules.js";
```

推論結果包含：

- `normal`
- `fatigue`
- `critical_like`

這些結果會再和即時速度、傾角、Jerk、yaw、重煞規則整合成 App 顯示的 Level。

## Local Test

使用 Python HTTP server：

```bash
python -m http.server 4173 --bind 127.0.0.1
```

開啟：

```text
http://localhost:4173/index.html
```

手機實測建議使用 HTTPS，例如 GitHub Pages。  
GPS 與 IMU 權限在手機瀏覽器中通常需要安全環境。

## Build PWA Assets

```bash
npm install
npm run build:web
```

`build:web` 會把部署需要的檔案複製到 `www/`。

## Deploy to GitHub Pages

本專案已包含 GitHub Actions workflow：

```text
.github/workflows/deploy-pages.yml
```

部署流程：

1. Push 到 GitHub repository
2. 到 repository 的 `Settings` -> `Pages`
3. `Build and deployment` 的 Source 選 `GitHub Actions`
4. 到 `Actions` 查看 `Deploy PWA to GitHub Pages`
5. 成功後開啟 GitHub Pages 網址

## Retrain ML Rules

重新訓練並同步 App 規則：

```bash
python train_aerox_baseline.py
```

輸出內容會放在 `output/`，並更新 App 使用的 `aerox_ml_rules.js`。

## Project Structure

```text
.
├── index.html                 # PWA 主頁
├── UI                         # 與 index.html 同步的 UI 檔案
├── styles.css                 # App 介面樣式
├── app.js                     # 感測器、風險判斷、畫面更新
├── aerox_ml_rules.js          # 決策樹轉出的前端推論規則
├── train_aerox_baseline.py    # Aerox 資料訓練與 JS 規則輸出
├── manifest.webmanifest       # PWA manifest
├── service-worker.js          # 離線快取與更新策略
├── scripts/
│   └── prepare-web-assets.mjs # 產生 www 部署目錄
├── assets/
│   └── icon.svg               # PWA icon
└── .github/workflows/
    └── deploy-pages.yml       # GitHub Pages 部署流程
```


