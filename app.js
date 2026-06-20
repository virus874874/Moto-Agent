import { classifyMotoRisk } from "./aerox_ml_rules.js";

const SAMPLE_WINDOW_LIMIT = 160;
const YAW_WINDOW_LIMIT = 80;
const MIN_ML_SAMPLES = 60;
const MIN_LEVEL1_ML_SAMPLES = 100;
const MIN_LEVEL2_ML_SAMPLES = 120;
const LEVEL1_CONFIRM_MS = 2200;
const LEVEL2_CONFIRM_MS = 1800;
const CRITICAL_CUE_INTERVAL_MS = 1300;
const ROLL_DISPLAY_INTERVAL_MS = 1000;
const JERK_DISPLAY_INTERVAL_MS = 1000;
const LEVEL1_JERK_THRESHOLD = 500;
const LEVEL2_JERK_THRESHOLD = 700;
const LEVEL2_STRONG_SPEED_THRESHOLD = 60;
const LEVEL2_OVERSPEED_KMH = 80;
const LEVEL1_RELEASE_HOLD_MS = 500;
const SWING_MIN_YAW_ZERO_CROSSINGS = 5;
const SWING_YAW_VARIANCE_THRESHOLD = 650;
const LEVEL1_TRANSIENT_OVERLAY_MS = 1000;
const SPEED_TREND_FRESH_MS = 3000;
const SPEED_TREND_DELTA_KMH = 0.8;
const SPEED_TREND_RATE_KMHPS = 0.7;
const PLOMMET_WINDOW_MS = 800;
const PLOMMET_CONFIRM_MS = 700;
const PLOMMET_MIN_SPEED_KMH = 25;
const PLOMMET_MIN_HITS = 6;
const PLOMMET_MIN_RATIO = 0.55;
const PLOMMET_JERK_MIN_SPEED_KMH = 35;
const PLOMMET_JERK_ACCELERATION_FACTOR = 1.25;
const PLOMMET_DYNAMIC_BASE = 5.8;
const PLOMMET_DYNAMIC_SPEED_FACTOR = 0.015;
const PLOMMET_DYNAMIC_MIN = 3.5;
const PLOMMET_SMOOTHING_ALPHA = 0.12;
const SURGE_MIN_SPEED_KMH = 30;
const SURGE_MIN_HITS = 7;
const SURGE_MIN_RATIO = 0.7;
const SURGE_JERK_MIN_SPEED_KMH = 40;
const SURGE_JERK_ACCELERATION_FACTOR = 1.55;
const SURGE_THRESHOLD_FACTOR = 1.35;
const ORIENTATION_LOCK = "portrait";
const RISK_DISPLAY_HOLD_MS = 2500;
const LEVEL2_RECOVERY_HOLD_MS = 1400;

const app = document.querySelector("#app");
const permissionButton = document.querySelector("#permissionButton");
const calibrateButton = document.querySelector("#calibrateButton");
const mountButtons = [...document.querySelectorAll(".mount-button")];

const ui = {
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
  speedDeltaKmh: 0,
  speedChangeRateKmhps: 0,
  speedTrendUpdatedAt: 0,
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
    bodyJerk: 0,
    yawRateDeg: 0,
    bodyAccelerationFiltered: null,
    lastBodyAccelerationMagnitude: null,
    lastBodyMotionTime: null,
  },
  sensorSamples: [],
  yawWindowDeg: [],
  riskActiveSince: {
    plommet: null,
    surge: null,
    level1: null,
    level2: null,
  },
  lastRollRenderAt: 0,
  lastJerkRenderAt: 0,
  displayedRisk: null,
  pendingRisk: null,
  pendingRiskSince: 0,
  level1TransientOverlayUntil: 0,
  level1TransientOverlayConsumed: false,
  level1TransientOverlayKey: "",
  audioContext: null,
  lastCriticalCueAt: 0,
};

permissionButton.addEventListener("click", async () => {
  await primeAudio();
  await lockScreenOrientation();
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
    writeLog("此環境不支援 geolocation。");
    return;
  }

  state.gpsWatchId = navigator.geolocation.watchPosition(
    handlePosition,
    (error) => {
      writeLog(`GPS 錯誤：${error.message}`);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 500,
      timeout: 8000,
    }
  );
}

async function lockScreenOrientation() {
  const orientation = window.screen?.orientation;
  if (!orientation || typeof orientation.lock !== "function") {
    writeLog("此瀏覽器不支援直向鎖定，已保留 PWA 直向顯示設定。");
    return;
  }

  try {
    await orientation.lock(ORIENTATION_LOCK);
    writeLog("已請求鎖定直向顯示。");
  } catch {
    writeLog("瀏覽器未允許鎖定螢幕方向，建議從主畫面 PWA 開啟測試。");
  }
}

function handlePosition(position) {
  state.hasGpsPermission = true;
  const speedFromGps = position.coords.speed;
  const previousSpeedMps = state.speedMps;
  const previousTimestamp = state.lastPosition?.timestamp;
  let nextSpeedMps = state.speedMps;

  if (typeof speedFromGps === "number" && Number.isFinite(speedFromGps)) {
    nextSpeedMps = Math.max(0, speedFromGps);
  } else if (state.lastPosition) {
    nextSpeedMps = estimateSpeedFromPosition(state.lastPosition, position);
  }

  if (typeof previousTimestamp === "number") {
    const deltaSeconds = (position.timestamp - previousTimestamp) / 1000;
    if (deltaSeconds > 0) {
      state.speedDeltaKmh = (nextSpeedMps - previousSpeedMps) * 3.6;
      state.speedChangeRateKmhps = state.speedDeltaKmh / deltaSeconds;
      state.speedTrendUpdatedAt = Date.now();
    }
  }

  state.speedMps = nextSpeedMps;
  state.lastPosition = position;
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
  const bodyAcceleration = hasAccelerationVector(event.acceleration)
    ? magnitude(vectorFromAcceleration(event.acceleration))
    : Math.max(0, absoluteAcceleration - 9.80665);
  state.motion.bodyAccelerationFiltered =
    state.motion.bodyAccelerationFiltered === null
      ? bodyAcceleration
      : state.motion.bodyAccelerationFiltered +
        (bodyAcceleration - state.motion.bodyAccelerationFiltered) * PLOMMET_SMOOTHING_ALPHA;
  const bodyAccelerationFiltered = state.motion.bodyAccelerationFiltered;
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

  if (Number.isFinite(bodyAccelerationFiltered)) {
    if (state.motion.lastBodyAccelerationMagnitude !== null && state.motion.lastBodyMotionTime !== null) {
      const deltaSeconds = (now - state.motion.lastBodyMotionTime) / 1000;
      if (deltaSeconds > 0) {
        state.motion.bodyJerk =
          Math.abs(bodyAccelerationFiltered - state.motion.lastBodyAccelerationMagnitude) / deltaSeconds;
      }
    }
    state.motion.lastBodyAccelerationMagnitude = bodyAccelerationFiltered;
    state.motion.lastBodyMotionTime = now;
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
      bodyAcceleration,
      bodyAccelerationFiltered,
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
  const risk = stabilizeRisk(inferRisk(features));
  render(features, risk);
}

function calculateFeatures() {
  const rollDeg = state.orientation.gamma - state.offset.gamma;
  const pitchDeg = state.orientation.beta - state.offset.beta;
  const yawRateRms = rms(state.yawWindowDeg);
  const yawRateVariance = variance(state.yawWindowDeg);
  const lateralGProxy = Math.abs(Math.sin(toRadians(rollDeg)));
  const mlResult = classifyMotoRisk(state.sensorSamples);
  const speedKmh = state.speedMps * 3.6;
  const plommetThreshold = Math.max(
    PLOMMET_DYNAMIC_MIN,
    PLOMMET_DYNAMIC_BASE - speedKmh * PLOMMET_DYNAMIC_SPEED_FACTOR
  );
  const surgeThreshold = plommetThreshold * SURGE_THRESHOLD_FACTOR;
  const plommetAccelerationValues = recentSampleValues("bodyAccelerationFiltered", PLOMMET_WINDOW_MS);
  const plommetAccelerationMax = Math.max(0, ...plommetAccelerationValues);
  const plommetAccelerationHits = plommetAccelerationValues.filter((value) => value >= plommetThreshold).length;
  const surgeAccelerationHits = plommetAccelerationValues.filter((value) => value >= surgeThreshold).length;
  const plommetAccelerationSamples = plommetAccelerationValues.length;
  const plommetAccelerationRatio =
    plommetAccelerationSamples > 0 ? plommetAccelerationHits / plommetAccelerationSamples : 0;
  const surgeAccelerationRatio =
    plommetAccelerationSamples > 0 ? surgeAccelerationHits / plommetAccelerationSamples : 0;
  const speedTrendAgeMs = state.speedTrendUpdatedAt ? Date.now() - state.speedTrendUpdatedAt : Number.POSITIVE_INFINITY;
  const speedTrendFresh = speedTrendAgeMs <= SPEED_TREND_FRESH_MS;

  return {
    timestamp: Date.now(),
    speedMps: state.speedMps,
    speedKmh,
    speedDeltaKmh: state.speedDeltaKmh,
    speedChangeRateKmhps: state.speedChangeRateKmhps,
    speedTrendFresh,
    rollDeg,
    pitchDeg,
    jerk: state.motion.jerk,
    bodyJerk: state.motion.bodyJerk,
    plommetThreshold,
    surgeThreshold,
    plommetAccelerationMax,
    plommetAccelerationHits,
    plommetAccelerationSamples,
    plommetAccelerationRatio,
    surgeAccelerationHits,
    surgeAccelerationRatio,
    yawRateDeg: state.motion.yawRateDeg,
    yawRateRms,
    yawRateVariance,
    lateralGProxy,
    yawZeroCrossings: zeroCrossings(state.yawWindowDeg),
    mlLabel: mlResult.label,
    mlLevel: mlResult.level,
    mlReady: state.sensorSamples.length >= MIN_ML_SAMPLES,
    level1MlReady: state.sensorSamples.length >= MIN_LEVEL1_ML_SAMPLES,
    level2MlReady: state.sensorSamples.length >= MIN_LEVEL2_ML_SAMPLES,
    mlFeatures: mlResult.features,
    samples: state.sensorSamples.length,
  };
}

function inferRisk(features) {
  const highSpeed = features.speedKmh >= 60;
  const citySpeed = features.speedKmh >= 30;
  const level2Speed = features.speedKmh >= 40;
  const overspeed = features.speedKmh > LEVEL2_OVERSPEED_KMH;
  const highLean = Math.abs(features.rollDeg) >= 40;
  const extremeLean = Math.abs(features.rollDeg) >= 46;
  const heavyJerk = features.jerk >= LEVEL1_JERK_THRESHOLD;
  const extremeJerk = features.jerk >= LEVEL2_JERK_THRESHOLD;
  const extremeYaw =
    features.yawRateRms >= 68 ||
    features.yawRateVariance >= 1700 ||
    features.yawZeroCrossings >= 10;
  const repeatedYawSwing =
    features.yawZeroCrossings >= SWING_MIN_YAW_ZERO_CROSSINGS &&
    (features.yawRateRms >= 44 || features.yawRateVariance >= SWING_YAW_VARIANCE_THRESHOLD);
  const movingEvidence =
    features.speedKmh >= 8 ||
    Math.abs(features.rollDeg) >= 12 ||
    features.yawRateRms >= 18 ||
    (features.mlFeatures?.absAccRms ?? 0) >= 11.8;
  const level1RideEvidence =
    features.speedKmh >= 15 ||
    (Math.abs(features.rollDeg) >= 18 && features.yawRateRms >= 24) ||
    (features.yawRateRms >= 34 && (features.mlFeatures?.absAccRms ?? 0) >= 11.8);
  const modelCritical = features.level2MlReady && movingEvidence && features.mlLabel === "critical_like";
  const modelFatigue = features.level1MlReady && level1RideEvidence && features.mlLabel === "fatigue";
  const severeModelCritical =
    modelCritical &&
    (features.speedKmh >= LEVEL2_STRONG_SPEED_THRESHOLD ||
      extremeLean ||
      extremeJerk ||
      extremeYaw ||
      (features.mlFeatures?.absAccRms ?? 0) >= 13.8);
  const rawLevel2 =
    overspeed ||
    (level2Speed &&
    (severeModelCritical ||
      (features.speedKmh >= 75 && highLean) ||
      (highSpeed && extremeLean) ||
      (features.speedKmh >= LEVEL2_STRONG_SPEED_THRESHOLD && highLean && extremeJerk) ||
      (highSpeed && extremeYaw) ||
      (features.lateralGProxy >= 0.84 && features.speedKmh >= LEVEL2_STRONG_SPEED_THRESHOLD)));
  const speedTrendDecelerating =
    features.speedTrendFresh &&
    (features.speedDeltaKmh <= -SPEED_TREND_DELTA_KMH ||
      features.speedChangeRateKmhps <= -SPEED_TREND_RATE_KMHPS);
  const speedTrendAccelerating =
    features.speedTrendFresh &&
    (features.speedDeltaKmh >= SPEED_TREND_DELTA_KMH ||
      features.speedChangeRateKmhps >= SPEED_TREND_RATE_KMHPS);
  const rawLongitudinalEvent =
    (features.speedKmh >= PLOMMET_MIN_SPEED_KMH &&
      features.plommetAccelerationSamples >= PLOMMET_MIN_HITS &&
      features.plommetAccelerationHits >= PLOMMET_MIN_HITS &&
      features.plommetAccelerationRatio >= PLOMMET_MIN_RATIO) ||
    (features.speedKmh >= PLOMMET_JERK_MIN_SPEED_KMH &&
      features.bodyJerk >= LEVEL1_JERK_THRESHOLD &&
      features.plommetAccelerationMax >= features.plommetThreshold * PLOMMET_JERK_ACCELERATION_FACTOR &&
      features.plommetAccelerationRatio >= PLOMMET_MIN_RATIO * 0.5);
  const rawPlommet = rawLongitudinalEvent && (speedTrendDecelerating || !speedTrendAccelerating);
  const rawSurge =
    rawLongitudinalEvent &&
    speedTrendAccelerating &&
    ((features.speedKmh >= SURGE_MIN_SPEED_KMH &&
      features.plommetAccelerationSamples >= SURGE_MIN_HITS &&
      features.surgeAccelerationHits >= SURGE_MIN_HITS &&
      features.surgeAccelerationRatio >= SURGE_MIN_RATIO) ||
      (features.speedKmh >= SURGE_JERK_MIN_SPEED_KMH &&
        features.bodyJerk >= LEVEL1_JERK_THRESHOLD &&
        features.plommetAccelerationMax >= features.surgeThreshold * SURGE_JERK_ACCELERATION_FACTOR &&
        features.surgeAccelerationRatio >= SURGE_MIN_RATIO * 0.5));
  const rawLevel1 =
    features.speedKmh >= 15 &&
    (modelCritical ||
      modelFatigue ||
      (citySpeed && highLean) ||
      (citySpeed && heavyJerk) ||
      (features.speedKmh >= 28 && repeatedYawSwing));
  const swingConfirmed = confirmedRisk("level1", rawLevel1, LEVEL1_CONFIRM_MS);
  const plommetConfirmed = confirmedRisk("plommet", rawPlommet, PLOMMET_CONFIRM_MS);
  const surgeConfirmed = confirmedRisk("surge", rawSurge, PLOMMET_CONFIRM_MS);
  const transientRisk = plommetConfirmed ? plommetRisk() : surgeConfirmed ? surgeRisk() : null;
  const transientOverlayRisk = updateLevel1TransientOverlay(transientRisk, swingConfirmed);

  if (confirmedRisk("level2", rawLevel2, LEVEL2_CONFIRM_MS)) {
    return {
      level: 2,
      key: "level2",
      priority: overspeed ? 4 : 3,
      title: overspeed ? "Level 2 Overspeed" : "Level 2 Reckless Driving",
      message: overspeed ? "速度超過 80 km/h，已觸發超速紅標。" : "高風險動態已觸發危險駕駛紅標。",
    };
  }

  if (transientOverlayRisk) return transientOverlayRisk;

  if (swingConfirmed) {
    return {
      level: 1,
      key: "level1",
      priority: 1,
      title: "Level 1 Swing",
      message: "短時間 yaw rate 變化偏高，可能有左右擺動或鑽車動態。",
    };
  }

  if (transientRisk) return transientRisk;

  return {
    level: 0,
    key: state.hasSensorPermission ? "level0" : "idle",
    priority: 0,
    title: state.hasSensorPermission ? "Level 0 狀態正常" : "尚未啟動",
    message: state.hasSensorPermission ? "GPS 速度區間與 IMU 高頻資料持續監測中。" : "請先啟動感測器、GPS，並完成歸零校正。",
  };
}

function plommetRisk() {
  return {
    level: 1,
    key: "level1",
    priority: 1,
    title: "Level 1 Plommet",
    message: "短時間內連續急煞車，已觸發煞車提醒。",
  };
}

function surgeRisk() {
  return {
    level: 1,
    key: "level1",
    priority: 1,
    title: "Level 1 Surge",
    message: "短時間內連續急加速，已觸發加速提醒。",
  };
}

function updateLevel1TransientOverlay(transientRisk, swingConfirmed) {
  const now = Date.now();

  if (!transientRisk || !swingConfirmed) {
    state.level1TransientOverlayUntil = 0;
    state.level1TransientOverlayConsumed = false;
    state.level1TransientOverlayKey = "";
    return null;
  }

  if (state.level1TransientOverlayKey && state.level1TransientOverlayKey !== transientRisk.title) {
    state.level1TransientOverlayUntil = 0;
    state.level1TransientOverlayConsumed = false;
  }

  state.level1TransientOverlayKey = transientRisk.title;

  if (!state.level1TransientOverlayUntil && !state.level1TransientOverlayConsumed) {
    state.level1TransientOverlayUntil = now + LEVEL1_TRANSIENT_OVERLAY_MS;
  }

  if (state.level1TransientOverlayUntil && now < state.level1TransientOverlayUntil) {
    return {
      ...transientRisk,
      immediate: true,
    };
  }

  state.level1TransientOverlayUntil = 0;
  state.level1TransientOverlayConsumed = true;
  return {
    level: 1,
    key: "level1",
    priority: 1,
    immediate: true,
    title: "Level 1 Swing",
    message: "短時間 yaw rate 變化偏高，可能有左右擺動或鑽車動態。",
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

function stabilizeRisk(nextRisk) {
  const now = Date.now();
  const currentRisk = state.displayedRisk;

  if (nextRisk.immediate) {
    state.displayedRisk = nextRisk;
    state.pendingRisk = null;
    state.pendingRiskSince = 0;
    return nextRisk;
  }

  if (!currentRisk || currentRisk.key === "idle" || nextRisk.level > currentRisk.level) {
    state.displayedRisk = nextRisk;
    state.pendingRisk = null;
    state.pendingRiskSince = 0;
    return nextRisk;
  }

  if (nextRisk.level === currentRisk.level && riskPriority(nextRisk) > riskPriority(currentRisk)) {
    state.displayedRisk = nextRisk;
    state.pendingRisk = null;
    state.pendingRiskSince = 0;
    return nextRisk;
  }

  if (nextRisk.key === currentRisk.key && nextRisk.title === currentRisk.title) {
    state.pendingRisk = null;
    state.pendingRiskSince = 0;
    return currentRisk;
  }

  if (!state.pendingRisk || !sameDisplayBand(state.pendingRisk, nextRisk)) {
    state.pendingRisk = nextRisk;
    state.pendingRiskSince = now;
    return currentRisk;
  }

  state.pendingRisk = nextRisk;
  const holdMs = displayHoldMs(currentRisk, nextRisk);

  if (now - state.pendingRiskSince >= holdMs) {
    state.displayedRisk = nextRisk;
    state.pendingRisk = null;
    state.pendingRiskSince = 0;
    return nextRisk;
  }

  return currentRisk;
}

function sameDisplayBand(leftRisk, rightRisk) {
  return leftRisk.level === rightRisk.level && leftRisk.key === rightRisk.key;
}

function riskPriority(risk) {
  return Number(risk.priority ?? risk.level ?? 0);
}

function displayHoldMs(currentRisk, nextRisk) {
  if (currentRisk.level === 2 && nextRisk.level < 2) return LEVEL2_RECOVERY_HOLD_MS;
  if (currentRisk.level === 1 && nextRisk.level <= 1) return LEVEL1_RELEASE_HOLD_MS;
  return RISK_DISPLAY_HOLD_MS;
}

function render(features, risk) {
  app.dataset.risk = risk.key;
  ui.riskTitle.textContent = risk.title;
  ui.speed.textContent = features.speedKmh > 0 ? features.speedKmh.toFixed(0) : "--";
  ui.speedBar.style.width = `${Math.min(100, Math.max(4, (features.speedKmh / 120) * 100))}%`;
  renderRoll(features.rollDeg);
  renderJerk(features.jerk);

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

function renderJerk(jerk) {
  const now = Date.now();
  const nextZone = jerkZone(jerk);
  const zoneChanged = ui.jerkMetric.dataset.jerkZone !== nextZone;
  if (!zoneChanged && now - state.lastJerkRenderAt < JERK_DISPLAY_INTERVAL_MS) return;
  state.lastJerkRenderAt = now;
  ui.jerk.textContent = jerk.toFixed(1);
  ui.jerkMetric.dataset.jerkZone = nextZone;
}

function jerkZone(jerk) {
  if (jerk > LEVEL2_JERK_THRESHOLD) return "high";
  if (jerk > LEVEL1_JERK_THRESHOLD) return "watch";
  return "calm";
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

function hasAccelerationVector(acceleration) {
  if (!acceleration) return false;
  return ["x", "y", "z"].some((axis) => typeof acceleration[axis] === "number" && Number.isFinite(acceleration[axis]));
}

function magnitude(vector) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function recentSampleValues(key, windowMs) {
  const latestSample = state.sensorSamples[state.sensorSamples.length - 1];
  if (!latestSample) return [];

  const since = latestSample.time - windowMs / 1000;
  return state.sensorSamples
    .filter((sample) => sample.time >= since)
    .map((sample) => Number(sample[key] || 0))
    .filter((value) => Number.isFinite(value));
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
  console.info(`[${time}] ${message}`);
}

updateInference();
