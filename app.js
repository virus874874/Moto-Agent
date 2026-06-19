import { classifyMotoRisk } from "./aerox_ml_rules.js";

const SAMPLE_WINDOW_LIMIT = 160;
const YAW_WINDOW_LIMIT = 80;
const MIN_ML_SAMPLES = 60;
const MIN_LEVEL1_ML_SAMPLES = 100;
const LEVEL1_CONFIRM_MS = 2200;
const LEVEL2_CONFIRM_MS = 700;
const LEVEL0_COOLDOWN_MS = 5000;
const CRITICAL_CUE_INTERVAL_MS = 1300;
const ROLL_DISPLAY_INTERVAL_MS = 1000;
const JERK_COLOR_BANDS = [
  { zone: "calm", max: 4 },
  { zone: "watch", max: 8 },
  { zone: "caution", max: 14 },
  { zone: "high", max: Infinity },
];

const app = document.querySelector("#app");
const permissionButton = document.querySelector("#permissionButton");
const calibrateButton = document.querySelector("#calibrateButton");
const mountButtons = [...document.querySelectorAll(".mount-button")];
const logBox = document.querySelector("#log");

const ui = {
  gpsState: document.querySelector("#gpsState"),
  routeHint: document.querySelector("#routeHint"),
  riskTitle: document.querySelector("#riskTitle"),
  speed: document.querySelector("#speed"),
  speedBar: document.querySelector("#speedBar"),
  roll: document.querySelector("#roll"),
  jerkMetric: document.querySelector("#jerkMetric"),
  jerk: document.querySelector("#jerk"),
};

const state = {
  hasSensorPermission: false,
  hasGpsPermission: false,
  gpsWatchId: null,
  speedMps: 0,
  lastPosition: null,
  mountMode: "handlebar",
  orientation: {
    alpha: 0,
    beta: 0,
    gamma: 0,
  },
  offset: {
    beta: 0,
    gamma: 0,
  },
  motion: {
    accelerationMagnitude: 0,
    lastAccelerationMagnitude: null,
    lastMotionTime: null,
    jerk: 0,
    yawRateDeg: 0,
  },
  sensorSamples: [],
  yawWindowDeg: [],
  riskActiveSince: {
    level1: null,
    level2: null,
  },
  lastLevel0At: 0,
  lastRollRenderAt: 0,
  audioContext: null,
  lastCriticalCueAt: 0,
};

permissionButton.addEventListener("click", async () => {
  await primeAudio();
  const sensorReady = await requestSensorPermission();
  requestGpsPermission();

  calibrateButton.disabled = !sensorReady;
  permissionButton.disabled = sensorReady;
  permissionButton.textContent = sensorReady ? "監測中" : "重新授權";
  writeLog("已送出感測器與 GPS 權限請求。");
});

calibrateButton.addEventListener("click", () => {
  state.offset.beta = state.orientation.beta;
  state.offset.gamma = state.orientation.gamma;
  writeLog(`已歸零：beta=${state.offset.beta.toFixed(2)}, gamma=${state.offset.gamma.toFixed(2)}`);
  updateInference();
});

mountButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.mountMode = button.dataset.mount;
    mountButtons.forEach((item) => item.classList.toggle("active", item === button));
    writeLog(`固定位置切換：${button.textContent.trim()}`);
  });
});

async function requestSensorPermission() {
  try {
    const orientationEvent = window.DeviceOrientationEvent;
    const motionEvent = window.DeviceMotionEvent;
    let orientationGranted = Boolean(orientationEvent);
    let motionGranted = Boolean(motionEvent);

    if (orientationEvent && typeof orientationEvent.requestPermission === "function") {
      orientationGranted = (await orientationEvent.requestPermission()) === "granted";
    }

    if (motionEvent && typeof motionEvent.requestPermission === "function") {
      motionGranted = (await motionEvent.requestPermission()) === "granted";
    }

    state.hasSensorPermission = orientationGranted && motionGranted;

    if (!state.hasSensorPermission) {
      writeLog("感測器權限未允許，請在手機瀏覽器或 App 權限設定中開啟。");
      return false;
    }

    window.addEventListener("deviceorientation", handleOrientation, { passive: true });
    window.addEventListener("devicemotion", handleMotion, { passive: true });
    writeLog("IMU 監聽已啟動。");
    return true;
  } catch (error) {
    writeLog(`感測器授權失敗：${error.message}`);
    return false;
  }
}

function requestGpsPermission() {
  if (!("geolocation" in navigator)) {
    ui.gpsState.textContent = "GPS 不支援";
    writeLog("此環境不支援 geolocation。");
    return;
  }

  state.gpsWatchId = navigator.geolocation.watchPosition(
    handlePosition,
    (error) => {
      ui.gpsState.textContent = "GPS 權限待確認";
      writeLog(`GPS 錯誤：${error.message}`);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 500,
      timeout: 8000,
    }
  );
}

function handlePosition(position) {
  state.hasGpsPermission = true;
  const speedFromGps = position.coords.speed;

  if (typeof speedFromGps === "number" && Number.isFinite(speedFromGps)) {
    state.speedMps = Math.max(0, speedFromGps);
  } else if (state.lastPosition) {
    state.speedMps = estimateSpeedFromPosition(state.lastPosition, position);
  }

  state.lastPosition = position;
  ui.gpsState.textContent = `GPS ${Math.round(position.coords.accuracy)} m`;
  updateInference();
}

function estimateSpeedFromPosition(previous, current) {
  const distanceMeters = haversineMeters(
    previous.coords.latitude,
    previous.coords.longitude,
    current.coords.latitude,
    current.coords.longitude
  );
  const deltaSeconds = (current.timestamp - previous.timestamp) / 1000;

  if (deltaSeconds <= 0) {
    return state.speedMps;
  }

  return distanceMeters / deltaSeconds;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function handleOrientation(event) {
  state.orientation.alpha = numberOr(event.alpha, state.orientation.alpha);
  state.orientation.beta = numberOr(event.beta, state.orientation.beta);
  state.orientation.gamma = numberOr(event.gamma, state.orientation.gamma);
  updateInference();
}

function handleMotion(event) {
  const linearAcceleration = event.acceleration ?? event.accelerationIncludingGravity;
  const absoluteAccelerationSource = event.accelerationIncludingGravity ?? event.acceleration;
  const rotationRate = event.rotationRate;

  const linear = vectorFromAcceleration(linearAcceleration);
  const absolute = vectorFromAcceleration(absoluteAccelerationSource);
  const absoluteAcceleration = magnitude(absolute);
  const now = performance.now();

  if (absoluteAcceleration > 0) {
    if (state.motion.lastAccelerationMagnitude !== null && state.motion.lastMotionTime !== null) {
      const deltaSeconds = (now - state.motion.lastMotionTime) / 1000;
      if (deltaSeconds > 0) {
        state.motion.jerk = Math.abs(absoluteAcceleration - state.motion.lastAccelerationMagnitude) / deltaSeconds;
      }
    }

    state.motion.accelerationMagnitude = absoluteAcceleration;
    state.motion.lastAccelerationMagnitude = absoluteAcceleration;
    state.motion.lastMotionTime = now;
  }

  const gyroDeg = {
    x: numberOr(rotationRate?.beta, 0),
    y: numberOr(rotationRate?.gamma, 0),
    z: numberOr(rotationRate?.alpha, 0),
  };
  const gyroRad = {
    x: toRadians(gyroDeg.x),
    y: toRadians(gyroDeg.y),
    z: toRadians(gyroDeg.z),
  };

  state.motion.yawRateDeg = gyroDeg.z;
  pushWindow(state.yawWindowDeg, gyroDeg.z, YAW_WINDOW_LIMIT);
  pushWindow(
    state.sensorSamples,
    {
      time: now / 1000,
      speed: state.speedMps,
      linearAccelerationX: linear.x,
      linearAccelerationY: linear.y,
      linearAccelerationZ: linear.z,
      absoluteAcceleration,
      gyroscopeX: gyroRad.x,
      gyroscopeY: gyroRad.y,
      gyroscopeZ: gyroRad.z,
      absoluteGyroscope: magnitude(gyroRad),
    },
    SAMPLE_WINDOW_LIMIT
  );

  updateInference();
}

function updateInference() {
  const features = calculateFeatures();
  const risk = inferRisk(features);
  render(features, risk);
}

function calculateFeatures() {
  const rollDeg = state.orientation.gamma - state.offset.gamma;
  const pitchDeg = state.orientation.beta - state.offset.beta;
  const yawRateRms = rms(state.yawWindowDeg);
  const yawRateVariance = variance(state.yawWindowDeg);
  const lateralGProxy = Math.abs(Math.sin(toRadians(rollDeg)));
  const mlResult = classifyMotoRisk(state.sensorSamples);

  return {
    timestamp: Date.now(),
    speedMps: state.speedMps,
    speedKmh: state.speedMps * 3.6,
    rollDeg,
    pitchDeg,
    jerk: state.motion.jerk,
    yawRateDeg: state.motion.yawRateDeg,
    yawRateRms,
    yawRateVariance,
    lateralGProxy,
    yawZeroCrossings: zeroCrossings(state.yawWindowDeg),
    mlLabel: mlResult.label,
    mlLevel: mlResult.level,
    mlReady: state.sensorSamples.length >= MIN_ML_SAMPLES,
    level1MlReady: state.sensorSamples.length >= MIN_LEVEL1_ML_SAMPLES,
    mlFeatures: mlResult.features,
    samples: state.sensorSamples.length,
  };
}

function inferRisk(features) {
  const highSpeed = features.speedKmh >= 60;
  const citySpeed = features.speedKmh >= 30;
  const highLean = Math.abs(features.rollDeg) >= 38;
  const heavyJerk = features.jerk >= 11;
  const unstableYaw =
    features.yawRateRms >= 55 ||
    features.yawRateVariance >= 1200 ||
    features.yawZeroCrossings >= 8;
  const movingEvidence =
    features.speedKmh >= 8 ||
    Math.abs(features.rollDeg) >= 12 ||
    features.yawRateRms >= 18 ||
    (features.mlFeatures?.absAccRms ?? 0) >= 11.8;
  const level1RideEvidence =
    features.speedKmh >= 15 ||
    (Math.abs(features.rollDeg) >= 18 && features.yawRateRms >= 24) ||
    (features.yawRateRms >= 34 && (features.mlFeatures?.absAccRms ?? 0) >= 11.8);
  const modelCritical = features.mlReady && movingEvidence && features.mlLabel === "critical_like";
  const modelFatigue = features.level1MlReady && level1RideEvidence && features.mlLabel === "fatigue";
  const rawLevel2 =
    modelCritical ||
    (highSpeed && highLean) ||
    (citySpeed && highLean && heavyJerk) ||
    (highSpeed && unstableYaw) ||
    (features.lateralGProxy >= 0.78 && citySpeed);
  const rawLevel1 =
    modelFatigue ||
    (features.speedKmh >= 35 &&
      ((features.yawRateRms >= 36 && features.yawZeroCrossings >= 3) ||
        features.yawRateVariance >= 650));

  if (confirmedRisk("level2", rawLevel2, LEVEL2_CONFIRM_MS)) {
    return {
      level: 2,
      key: "level2",
      title: "Level 2 高風險",
      message: "高速大傾角、重煞或連續左右擺振已觸發最高優先警示。",
    };
  }

  if (confirmedRisk("level1", rawLevel1, LEVEL1_CONFIRM_MS)) {
    return {
      level: 1,
      key: "level1",
      title: "Level 1 疲勞晃動",
      message: "短時間 yaw rate 變化偏高，可能有微幅蛇行或路面碎震。",
    };
  }

  if (features.jerk >= 7) {
    const now = Date.now();
    const inCooldown = now - state.lastLevel0At < LEVEL0_COOLDOWN_MS;
    if (!inCooldown) {
      state.lastLevel0At = now;
    }

    return {
      level: 0,
      key: "level0",
      title: "Level 0 平順度提醒",
      message: inCooldown ? "平順度提示冷卻中，持續監測車身動態。" : "加減速變化偏大，建議放緩油門或煞車操作。",
    };
  }

  return {
    level: 0,
    key: state.hasSensorPermission ? "level0" : "idle",
    title: state.hasSensorPermission ? "Level 0 狀態正常" : "尚未啟動",
    message: state.hasSensorPermission ? "GPS 速度區間與 IMU 高頻資料持續監測中。" : "請先啟動感測器、GPS，並完成歸零校正。",
  };
}

function confirmedRisk(key, active, durationMs) {
  const now = Date.now();
  if (!active) {
    state.riskActiveSince[key] = null;
    return false;
  }

  if (state.riskActiveSince[key] === null) {
    state.riskActiveSince[key] = now;
    return false;
  }

  return now - state.riskActiveSince[key] >= durationMs;
}

function render(features, risk) {
  app.dataset.risk = risk.key;
  ui.riskTitle.textContent = risk.title;
  ui.speed.textContent = features.speedKmh > 0 ? features.speedKmh.toFixed(0) : "--";
  ui.speedBar.style.width = `${Math.min(100, Math.max(4, (features.speedKmh / 120) * 100))}%`;
  renderRoll(features.rollDeg);
  ui.jerk.textContent = features.jerk.toFixed(1);
  ui.jerkMetric.dataset.jerkZone = jerkZone(features.jerk);

  if (risk.level === 2) {
    triggerCriticalCue();
  }
}

function renderRoll(rollDeg) {
  const now = Date.now();
  if (now - state.lastRollRenderAt < ROLL_DISPLAY_INTERVAL_MS) return;
  state.lastRollRenderAt = now;
  ui.roll.textContent = rollDeg.toFixed(1);
}

function jerkZone(jerk) {
  return JERK_COLOR_BANDS.find((band) => jerk < band.max)?.zone ?? "high";
}

async function primeAudio() {
  if (state.audioContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  state.audioContext = new AudioContext();
  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

function triggerCriticalCue() {
  const now = Date.now();
  if (now - state.lastCriticalCueAt < CRITICAL_CUE_INTERVAL_MS) return;
  state.lastCriticalCueAt = now;

  if (navigator.vibrate) {
    navigator.vibrate([80, 50, 80]);
  }

  if (!state.audioContext) return;
  const oscillator = state.audioContext.createOscillator();
  const gain = state.audioContext.createGain();
  oscillator.frequency.setValueAtTime(880, state.audioContext.currentTime);
  oscillator.frequency.setValueAtTime(660, state.audioContext.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, state.audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, state.audioContext.currentTime + 0.28);
  oscillator.connect(gain);
  gain.connect(state.audioContext.destination);
  oscillator.start();
  oscillator.stop(state.audioContext.currentTime + 0.3);
}

function vectorFromAcceleration(acceleration) {
  return {
    x: numberOr(acceleration?.x, 0),
    y: numberOr(acceleration?.y, 0),
    z: numberOr(acceleration?.z, 0),
  };
}

function magnitude(vector) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function pushWindow(values, value, limit) {
  values.push(value);
  while (values.length > limit) {
    values.shift();
  }
}

function rms(values) {
  if (values.length === 0) return 0;
  const meanSquares = values.reduce((sum, value) => sum + value * value, 0) / values.length;
  return Math.sqrt(meanSquares);
}

function variance(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function zeroCrossings(values) {
  let previous = 0;
  let changes = 0;
  for (const value of values) {
    const current = value > 0 ? 1 : value < 0 ? -1 : 0;
    if (current && previous && current !== previous) changes += 1;
    if (current) previous = current;
  }
  return changes;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function writeLog(message) {
  const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  logBox.textContent = `[${time}] ${message}\n${logBox.textContent}`;
}

updateInference();
