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
- 風險狀態包含 Level 0、Level 1 Plommet、Level 1 Surge、Level 1 Swing、Level 2

## Risk Levels

### Level 0 狀態正常

一般穩定狀態。  
此時 Jerk 卡片為綠色。

### Level 1 Swing

代表連續晃動、蛇行或鑽車時的左右擺動傾向。  
Level 1 條件需要連續達成約 `2.2 秒` 才會顯示。
速度低於 `15 km/h` 時不會觸發 Swing。
Yaw 類 Swing 需要更明確的連續左右擺動，避免龍頭來回一次就觸發。

主要參考：

- ML 判斷為 `fatigue`，在 App 顯示為 `Swing`
- ML 判斷為 `critical_like` 但未達 Level 2
- 中速以上大傾角
- 中速以上高 Jerk
- yaw zero crossings `>= 5`，且 yaw RMS 或 yaw variance 偏高

### Level 1 Plommet

代表短時間明顯急煞車。  
Plommet 使用不含重力的 body acceleration；若手機沒有提供該資料，則以 `accelerationIncludingGravity - 9.80665` 近似補償。
為了避免行車碎震誤判，Plommet 會使用低通平滑後的 body acceleration，並要求條件持續約 `0.7 秒`。
若 Plommet 與 Swing 同時成立，App 會先顯示 `Level 1 Plommet` 約 `1 秒`，之後若 Swing 仍成立會立刻回到 `Level 1 Swing`，不會重新計算 Swing 的確認時間。
Plommet 會用 GPS 速度差輔助判斷方向；若速度趨勢明確上升，會改交給 Surge 的高門檻判斷。

動態門檻：

```js
threshold = 5.8 - speedKmh * 0.015;
if (threshold < 3.5) threshold = 3.5;
```

符合任一條件即觸發：

- 速度 `>= 25 km/h`，且最近 `0.8 秒` 內至少 `6` 筆平滑後 body acceleration `>= threshold`，且達標比例 `>= 55%`
- 速度 `>= 35 km/h`，且平滑後 body jerk `>= 500`，最近 `0.8 秒` 內平滑後 body acceleration 最大值 `>= threshold * 1.25`，且達標比例 `>= 27.5%`

Level 1 的 Swing / Plommet / Surge 特徵消失後，約 `0.5 秒` 內會切回目前狀態。

### Level 1 Surge

代表短時間明顯急加速。  
Surge 會先使用與 Plommet 相同的縱向變化偵測，再要求 GPS 速度趨勢為上升，最後以較高門檻審核後才顯示。

Surge 主要提高：

- 平滑後 body acceleration 門檻為 Plommet 的 `1.35` 倍
- 至少 `7` 筆達標
- 達標比例 `>= 70%`
- Jerk 輔助條件需速度 `>= 40 km/h`

若 Surge 與 Swing 同時成立，App 會先顯示 `Level 1 Surge` 約 `1 秒`，之後若 Swing 仍成立會立刻回到 `Level 1 Swing`，不會重新計算 Swing 的確認時間。

### Level 2 高風險

代表高風險動態。  
Level 2 條件需要連續達成約 `1.8 秒` 才會顯示。
速度 `> 80 km/h` 時顯示 `Level 2 Overspeed`；其他 Level 2 觸發則顯示 `Level 2 Reckless Driving`。
Reckless Driving 主要綜合速度、傾角、Jerk、yaw 與 ML `critical_like` 判斷。
穩定巡航超過 `60 km/h` 不會單獨觸發 Reckless Driving；需同時伴隨大傾角、極端 Jerk、極端 yaw 或高加速度 RMS。

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


