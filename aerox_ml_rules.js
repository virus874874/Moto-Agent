// 由 train_aerox_baseline.py 自動產生。
// 此檔案把 sklearn DecisionTreeClassifier 轉成手機端可執行的 if-else。

function rms(values) {
  if (!values.length) return 0;
  const meanSquare = values.reduce((sum, value) => sum + value * value, 0) / values.length;
  return Math.sqrt(meanSquare);
}

function variance(values) {
  if (!values.length) return 0;
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

function buildResult(label, features) {
  const level = label === "critical_like" ? 2 : label === "fatigue" ? 1 : 0;
  return { label, level, features };
}

export function classifyMotoRisk(samples) {
  const safeSamples = Array.isArray(samples) ? samples : [];
  const pick = (key) => safeSamples.map((sample) => Number(sample[key] || 0));
  const speedValues = pick("speed");
  const absAccValues = pick("absoluteAcceleration");
  const absGyroValues = pick("absoluteGyroscope");
  const gyroZValues = pick("gyroscopeZ");

  const features = {
    speedMean: speedValues.reduce((sum, value) => sum + value, 0) / Math.max(speedValues.length, 1),
    speedMax: Math.max(0, ...speedValues),
    absAccMean: absAccValues.reduce((sum, value) => sum + value, 0) / Math.max(absAccValues.length, 1),
    absAccRms: rms(absAccValues),
    absAccVar: variance(absAccValues),
    absAccMax: Math.max(0, ...absAccValues),
    accXRms: rms(pick("linearAccelerationX")),
    accYRms: rms(pick("linearAccelerationY")),
    accZRms: rms(pick("linearAccelerationZ")),
    gyroXRms: rms(pick("gyroscopeX")),
    gyroYRms: rms(pick("gyroscopeY")),
    gyroZRms: rms(gyroZValues),
    yawVar: variance(gyroZValues),
    absGyroMean: absGyroValues.reduce((sum, value) => sum + value, 0) / Math.max(absGyroValues.length, 1),
    absGyroRms: rms(absGyroValues),
    absGyroVar: variance(absGyroValues),
    absGyroMax: Math.max(0, ...absGyroValues),
    yawZeroCrossings: zeroCrossings(gyroZValues),
    durationS: safeSamples.length > 1
      ? Number(safeSamples[safeSamples.length - 1].time || 0) - Number(safeSamples[0].time || 0)
      : 0
  };

  if (features.absGyroRms <= 0.543145) {
    return buildResult("normal", features);
  } else {
    if (features.gyroZRms <= 0.350258) {
      return buildResult("critical_like", features);
    } else {
      return buildResult("fatigue", features);
    }
  }
}
