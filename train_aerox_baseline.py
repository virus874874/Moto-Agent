#!/usr/bin/env python3
"""
Moto-Agent Aerox 機器學習訓練腳本。

這支程式會讀取 archive/aerox 內的 CSV 檔案，計算機車動態感測器特徵，
再用 scikit-learn 訓練決策樹與隨機森林模型。決策樹模型會被轉成可放進
Web App 的 JavaScript if-else 判斷式，方便在手機端做邊緣推論。

注意：
目前 Aerox CSV 沒有人工標籤欄位，所以此版仍會先根據 Moto-Agent 文件中的
物理意義建立「弱標籤」。之後若你整理出人工標註資料，只要替換
create_weak_label() 或加入 label CSV，就能使用同一套訓練流程。
"""

from __future__ import annotations

import argparse
import json
import pickle
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier, export_text

try:
    import joblib
except ImportError:
    joblib = None


# 原始 CSV 中會使用到的感測器欄位。
SENSOR_COLUMNS = [
    "Linear Acceleration x",
    "Linear Acceleration y",
    "Linear Acceleration z",
    "Absolute acceleration",
    "gyroscope x",
    "gyroscope y",
    "gyroscope z",
    "Absolute gyroscope",
    "Speed (m/s)",
]


# 模型訓練使用的特徵欄位。
FEATURE_COLUMNS = [
    "speed_mean",
    "speed_max",
    "abs_acc_mean",
    "abs_acc_rms",
    "abs_acc_var",
    "abs_acc_max",
    "acc_x_rms",
    "acc_y_rms",
    "acc_z_rms",
    "gyro_x_rms",
    "gyro_y_rms",
    "gyro_z_rms",
    "gyro_z_var",
    "abs_gyro_mean",
    "abs_gyro_rms",
    "abs_gyro_var",
    "abs_gyro_max",
    "yaw_zero_crossings",
    "duration_s",
]


JS_FEATURE_NAMES = {
    "speed_mean": "speedMean",
    "speed_max": "speedMax",
    "abs_acc_mean": "absAccMean",
    "abs_acc_rms": "absAccRms",
    "abs_acc_var": "absAccVar",
    "abs_acc_max": "absAccMax",
    "acc_x_rms": "accXRms",
    "acc_y_rms": "accYRms",
    "acc_z_rms": "accZRms",
    "gyro_x_rms": "gyroXRms",
    "gyro_y_rms": "gyroYRms",
    "gyro_z_rms": "gyroZRms",
    "gyro_z_var": "yawVar",
    "abs_gyro_mean": "absGyroMean",
    "abs_gyro_rms": "absGyroRms",
    "abs_gyro_var": "absGyroVar",
    "abs_gyro_max": "absGyroMax",
    "yaw_zero_crossings": "yawZeroCrossings",
    "duration_s": "durationS",
}


def rms(values: pd.Series) -> float:
    """計算 RMS，用來表示一段時間窗內的訊號能量。"""
    array = values.dropna().to_numpy(dtype=float)
    if len(array) == 0:
        return 0.0
    return float(np.sqrt(np.mean(array**2)))


def variance(values: pd.Series) -> float:
    """計算變異數，用來表示訊號晃動程度。"""
    array = values.dropna().to_numpy(dtype=float)
    if len(array) == 0:
        return 0.0
    return float(np.var(array))


def count_zero_crossings(values: pd.Series) -> int:
    """計算正負號切換次數，可用來描述 yaw rate 是否頻繁左右擺動。"""
    array = values.dropna().to_numpy(dtype=float)
    if len(array) == 0:
        return 0

    signs = np.sign(array)
    signs = signs[signs != 0]
    if len(signs) <= 1:
        return 0
    return int(np.sum(signs[1:] != signs[:-1]))


def scenario_from_filename(path: Path) -> str:
    """由檔名取出情境名稱，例如 AA_0_1.csv -> AA_0。"""
    parts = path.stem.split("_")
    return "_".join(parts[:-1]) if len(parts) > 1 else path.stem


def read_sensor_csv(path: Path) -> pd.DataFrame:
    """讀取單一感測器 CSV，並移除 pandas 讀入 index 欄位後產生的 Unnamed 欄。"""
    frame = pd.read_csv(path)
    frame = frame.loc[:, ~frame.columns.str.contains(r"^Unnamed")]

    missing_columns = [column for column in SENSOR_COLUMNS if column not in frame.columns]
    if missing_columns:
        raise ValueError(f"{path} 缺少欄位：{missing_columns}")

    return frame


def create_weak_label(features: dict[str, float]) -> str:
    """
    依照 Moto-Agent 文件中的物理意義建立弱標籤。

    - critical_like：整體加速度 RMS 偏高，或旋轉晃動與加速度同時偏高。
    - fatigue：yaw variance 或整體 gyroscope RMS 偏高，代表連續微小蛇行。
    - normal：其餘較穩定狀態。
    """
    if features["abs_acc_rms"] >= 13.5:
        return "critical_like"
    if features["abs_gyro_rms"] >= 0.58 and features["abs_acc_rms"] >= 13.0:
        return "critical_like"
    if features["gyro_z_var"] >= 0.12:
        return "fatigue"
    if features["abs_gyro_rms"] >= 0.65:
        return "fatigue"
    return "normal"


def extract_features(path: Path) -> dict[str, float | int | str]:
    """把一個 CSV 檔轉成一列模型可訓練的特徵。"""
    frame = read_sensor_csv(path)
    time_values = frame["Time (s)"].astype(float)

    features: dict[str, float | int | str] = {
        "file": path.name,
        "scenario": scenario_from_filename(path),
        "samples": int(len(frame)),
        "duration_s": float(time_values.max() - time_values.min()),
        "speed_mean": float(frame["Speed (m/s)"].mean()),
        "speed_max": float(frame["Speed (m/s)"].max()),
        "abs_acc_mean": float(frame["Absolute acceleration"].mean()),
        "abs_acc_rms": rms(frame["Absolute acceleration"]),
        "abs_acc_var": variance(frame["Absolute acceleration"]),
        "abs_acc_max": float(frame["Absolute acceleration"].max()),
        "acc_x_rms": rms(frame["Linear Acceleration x"]),
        "acc_y_rms": rms(frame["Linear Acceleration y"]),
        "acc_z_rms": rms(frame["Linear Acceleration z"]),
        "gyro_x_rms": rms(frame["gyroscope x"]),
        "gyro_y_rms": rms(frame["gyroscope y"]),
        "gyro_z_rms": rms(frame["gyroscope z"]),
        "gyro_z_var": variance(frame["gyroscope z"]),
        "abs_gyro_mean": float(frame["Absolute gyroscope"].mean()),
        "abs_gyro_rms": rms(frame["Absolute gyroscope"]),
        "abs_gyro_var": variance(frame["Absolute gyroscope"]),
        "abs_gyro_max": float(frame["Absolute gyroscope"].max()),
        "yaw_zero_crossings": count_zero_crossings(frame["gyroscope z"]),
    }
    features["risk_label"] = create_weak_label(features)  # type: ignore[arg-type]
    return features


def build_feature_table(data_dir: Path) -> pd.DataFrame:
    """讀取資料夾內所有 CSV，整理成模型訓練用的 DataFrame。"""
    csv_files = sorted(data_dir.glob("*.csv"))
    if not csv_files:
        raise FileNotFoundError(f"找不到 CSV 檔案：{data_dir}")

    rows = [extract_features(path) for path in csv_files]
    return pd.DataFrame(rows)


def split_dataset(feature_table: pd.DataFrame, test_size: float, random_state: int):
    """切分訓練集與測試集；若資料太少導致 stratify 失敗，會自動改用一般切分。"""
    x = feature_table[FEATURE_COLUMNS]
    y = feature_table["risk_label"]

    try:
        return train_test_split(
            x,
            y,
            test_size=test_size,
            random_state=random_state,
            stratify=y,
        )
    except ValueError:
        return train_test_split(
            x,
            y,
            test_size=test_size,
            random_state=random_state,
        )


def train_models(
    feature_table: pd.DataFrame,
    test_size: float,
    random_state: int,
) -> dict[str, object]:
    """訓練決策樹與隨機森林，並回傳模型與評估結果。"""
    x_train, x_test, y_train, y_test = split_dataset(feature_table, test_size, random_state)

    # 決策樹容易轉成 if-else，適合放回 Web App 做即時判斷。
    decision_tree = DecisionTreeClassifier(
        max_depth=4,
        min_samples_leaf=2,
        class_weight="balanced",
        random_state=random_state,
    )
    decision_tree.fit(x_train, y_train)

    # 隨機森林較穩定，可用來比較重要特徵與整體分類效果。
    random_forest = RandomForestClassifier(
        n_estimators=300,
        max_depth=6,
        min_samples_leaf=1,
        class_weight="balanced",
        random_state=random_state,
    )
    random_forest.fit(x_train, y_train)

    tree_pred = decision_tree.predict(x_test)
    forest_pred = random_forest.predict(x_test)

    labels = sorted(feature_table["risk_label"].unique())
    return {
        "x_train": x_train,
        "x_test": x_test,
        "y_train": y_train,
        "y_test": y_test,
        "labels": labels,
        "decision_tree": decision_tree,
        "random_forest": random_forest,
        "tree_accuracy": accuracy_score(y_test, tree_pred),
        "forest_accuracy": accuracy_score(y_test, forest_pred),
        "tree_report": classification_report(y_test, tree_pred, labels=labels, zero_division=0),
        "forest_report": classification_report(y_test, forest_pred, labels=labels, zero_division=0),
        "tree_confusion": confusion_matrix(y_test, tree_pred, labels=labels),
        "forest_confusion": confusion_matrix(y_test, forest_pred, labels=labels),
    }


def feature_importance_table(model: RandomForestClassifier) -> pd.DataFrame:
    """整理隨機森林的重要特徵排序。"""
    return (
        pd.DataFrame(
            {
                "feature": FEATURE_COLUMNS,
                "importance": model.feature_importances_,
            }
        )
        .sort_values("importance", ascending=False)
        .reset_index(drop=True)
    )


def js_value_for_feature(name: str) -> str:
    """把 Python 特徵名稱轉成 JavaScript 物件中的欄位名稱。"""
    return JS_FEATURE_NAMES.get(name, name)


def save_model(model: object, path: Path) -> None:
    """
    儲存模型檔案。

    如果環境有 joblib，就使用 joblib；如果沒有，就改用 Python 內建的 pickle。
    這樣可以避免終端機因為缺少 joblib 而整支程式不能執行。
    """
    if joblib is not None:
        joblib.dump(model, path)
        return

    with path.open("wb") as file:
        pickle.dump(model, file)


def tree_to_js_conditions(
    model: DecisionTreeClassifier,
    node_id: int,
    indent: int = 2,
) -> str:
    """將 sklearn 決策樹遞迴轉換成 JavaScript if-else。"""
    tree = model.tree_
    classes = list(model.classes_)
    prefix = " " * indent

    left_id = tree.children_left[node_id]
    right_id = tree.children_right[node_id]

    if left_id == right_id:
        class_index = int(np.argmax(tree.value[node_id][0]))
        label = classes[class_index]
        return f'{prefix}return buildResult("{label}", features);\n'

    feature_index = tree.feature[node_id]
    feature_name = FEATURE_COLUMNS[feature_index]
    js_feature = js_value_for_feature(feature_name)
    threshold = tree.threshold[node_id]

    code = f"{prefix}if (features.{js_feature} <= {threshold:.6f}) {{\n"
    code += tree_to_js_conditions(model, left_id, indent + 2)
    code += f"{prefix}}} else {{\n"
    code += tree_to_js_conditions(model, right_id, indent + 2)
    code += f"{prefix}}}\n"
    return code


def write_js_classifier(path: Path, model: DecisionTreeClassifier) -> None:
    """輸出由決策樹模型生成的 JavaScript 分類器。"""
    code = f"""// 由 train_aerox_baseline.py 自動產生。
// 此檔案把 sklearn DecisionTreeClassifier 轉成手機端可執行的 if-else。

function rms(values) {{
  if (!values.length) return 0;
  const meanSquare = values.reduce((sum, value) => sum + value * value, 0) / values.length;
  return Math.sqrt(meanSquare);
}}

function variance(values) {{
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}}

function zeroCrossings(values) {{
  let previous = 0;
  let changes = 0;
  for (const value of values) {{
    const current = value > 0 ? 1 : value < 0 ? -1 : 0;
    if (current && previous && current !== previous) changes += 1;
    if (current) previous = current;
  }}
  return changes;
}}

function buildResult(label, features) {{
  const level = label === "critical_like" ? 2 : label === "fatigue" ? 1 : 0;
  return {{ label, level, features }};
}}

export function classifyMotoRisk(samples) {{
  const safeSamples = Array.isArray(samples) ? samples : [];
  const pick = (key) => safeSamples.map((sample) => Number(sample[key] || 0));
  const speedValues = pick("speed");
  const absAccValues = pick("absoluteAcceleration");
  const absGyroValues = pick("absoluteGyroscope");
  const gyroZValues = pick("gyroscopeZ");

  const features = {{
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
  }};

{tree_to_js_conditions(model, 0, 2).rstrip()}
}}
"""
    path.write_text(code, encoding="utf-8")


def write_markdown_report(
    path: Path,
    feature_table: pd.DataFrame,
    results: dict[str, object],
    importance: pd.DataFrame,
) -> None:
    """輸出 Markdown 報告，方便放進專題文件或簡報。"""
    labels = [str(label) for label in results["labels"]]  # type: ignore[union-attr]
    tree_model = results["decision_tree"]
    scenario_summary = (
        feature_table.groupby("scenario")
        .agg(
            files=("file", "count"),
            speed_mean=("speed_mean", "mean"),
            abs_acc_rms=("abs_acc_rms", "mean"),
            gyro_z_var=("gyro_z_var", "mean"),
            abs_gyro_rms=("abs_gyro_rms", "mean"),
        )
        .reset_index()
    )

    lines = [
        "# Moto-Agent Aerox 機器學習訓練報告",
        "",
        "本報告由 `train_aerox_baseline.py` 產生。流程包含 CSV 讀取、RMS/Variance 特徵工程、弱標籤建立、決策樹訓練、隨機森林訓練，以及 JavaScript 邊緣推論規則輸出。",
        "",
        "## 類別數量",
        "",
        "| 類別 | 數量 |",
        "|---|---:|",
    ]

    for label, count in Counter(feature_table["risk_label"]).items():
        lines.append(f"| `{label}` | {count} |")

    lines += [
        "",
        "## 情境統計",
        "",
        "| Scenario | Files | Speed Mean | Abs Acc RMS | Gyro Z Var | Abs Gyro RMS |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in scenario_summary.to_dict("records"):
        lines.append(
            f"| `{row['scenario']}` | {row['files']} | {row['speed_mean']:.2f} | "
            f"{row['abs_acc_rms']:.2f} | {row['gyro_z_var']:.4f} | {row['abs_gyro_rms']:.3f} |"
        )

    lines += [
        "",
        "## 模型效果",
        "",
        f"- Decision Tree Accuracy: `{results['tree_accuracy']:.3f}`",
        f"- Random Forest Accuracy: `{results['forest_accuracy']:.3f}`",
        "",
        "### Decision Tree Classification Report",
        "",
        "```text",
        str(results["tree_report"]).rstrip(),
        "```",
        "",
        "### Random Forest Classification Report",
        "",
        "```text",
        str(results["forest_report"]).rstrip(),
        "```",
        "",
        "## Confusion Matrix",
        "",
        f"Labels: `{', '.join(labels)}`",
        "",
        "Decision Tree:",
        "",
        "```text",
        np.array2string(results["tree_confusion"]),  # type: ignore[arg-type]
        "```",
        "",
        "Random Forest:",
        "",
        "```text",
        np.array2string(results["forest_confusion"]),  # type: ignore[arg-type]
        "```",
        "",
        "## 隨機森林重要特徵",
        "",
        "| Rank | Feature | Importance |",
        "|---:|---|---:|",
    ]

    for index, row in importance.head(10).iterrows():
        lines.append(f"| {index + 1} | `{row['feature']}` | {row['importance']:.4f} |")

    lines += [
        "",
        "## 決策樹規則",
        "",
        "```text",
        export_text(tree_model, feature_names=FEATURE_COLUMNS).rstrip(),  # type: ignore[arg-type]
        "```",
        "",
        "## 備註",
        "",
        "目前資料沒有人工標籤，所以模型學到的是由文件物理意義產生的弱標籤。若後續能補上人工標註，這支程式可以保留特徵工程與模型訓練流程，只替換標籤來源即可。",
    ]

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def save_outputs(
    output_dir: Path,
    feature_table: pd.DataFrame,
    results: dict[str, object],
    app_rules_path: Path | None = None,
) -> None:
    """儲存訓練產物：特徵表、模型、報告、JS 分類器與 metadata。"""
    output_dir.mkdir(parents=True, exist_ok=True)

    decision_tree = results["decision_tree"]
    random_forest = results["random_forest"]
    importance = feature_importance_table(random_forest)  # type: ignore[arg-type]

    feature_table.to_csv(output_dir / "aerox_ml_features.csv", index=False, encoding="utf-8")
    importance.to_csv(output_dir / "aerox_feature_importance.csv", index=False, encoding="utf-8")
    model_extension = ".joblib" if joblib is not None else ".pkl"
    save_model(decision_tree, output_dir / f"aerox_decision_tree_model{model_extension}")
    save_model(random_forest, output_dir / f"aerox_random_forest_model{model_extension}")
    write_js_classifier(output_dir / "aerox_ml_rules.js", decision_tree)  # type: ignore[arg-type]
    if app_rules_path is not None:
        app_rules_path.parent.mkdir(parents=True, exist_ok=True)
        write_js_classifier(app_rules_path, decision_tree)  # type: ignore[arg-type]
    write_markdown_report(output_dir / "aerox_ml_report.md", feature_table, results, importance)

    metadata = {
        "feature_columns": FEATURE_COLUMNS,
        "labels": [str(label) for label in results["labels"]],  # type: ignore[union-attr]
        "model_format": "joblib" if joblib is not None else "pickle",
        "tree_accuracy": results["tree_accuracy"],
        "forest_accuracy": results["forest_accuracy"],
    }
    (output_dir / "aerox_ml_metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="訓練 Moto-Agent Aerox 機器學習模型")
    parser.add_argument("--data-dir", default="archive/aerox", help="Aerox CSV 資料夾")
    parser.add_argument("--output-dir", default="output", help="輸出資料夾")
    parser.add_argument(
        "--app-rules-path",
        default="aerox_ml_rules.js",
        help="同步輸出給 Web/App 使用的 JavaScript 規則；傳入空字串可略過",
    )
    parser.add_argument("--test-size", type=float, default=0.3, help="測試集比例")
    parser.add_argument("--random-state", type=int, default=42, help="隨機種子")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    app_rules_path = Path(args.app_rules_path) if args.app_rules_path else None

    feature_table = build_feature_table(data_dir)
    results = train_models(feature_table, args.test_size, args.random_state)
    save_outputs(output_dir, feature_table, results, app_rules_path)

    print(f"已讀取 {len(feature_table)} 份 CSV：{data_dir}")
    print("弱標籤數量：")
    for label, count in Counter(feature_table["risk_label"]).items():
        print(f"  {label}: {count}")

    print("\n模型效果：")
    print(f"  Decision Tree Accuracy: {results['tree_accuracy']:.3f}")
    print(f"  Random Forest Accuracy: {results['forest_accuracy']:.3f}")

    print("\n輸出檔案：")
    print(f"  {output_dir / 'aerox_ml_features.csv'}")
    print(f"  {output_dir / 'aerox_feature_importance.csv'}")
    model_extension = ".joblib" if joblib is not None else ".pkl"
    print(f"  {output_dir / f'aerox_decision_tree_model{model_extension}'}")
    print(f"  {output_dir / f'aerox_random_forest_model{model_extension}'}")
    print(f"  {output_dir / 'aerox_ml_rules.js'}")
    if app_rules_path is not None:
        print(f"  {app_rules_path}")
    print(f"  {output_dir / 'aerox_ml_report.md'}")
    print(f"  {output_dir / 'aerox_ml_metadata.json'}")


if __name__ == "__main__":
    main()
