import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const outputDir = "www";
const files = [
  "index.html",
  "styles.css",
  "app.js",
  "aerox_ml_rules.js",
  "manifest.webmanifest",
  "service-worker.js",
  "assets/icon.svg",
  ".nojekyll"
];

await rm(outputDir, { recursive: true, force: true });

for (const file of files) {
  const target = join(outputDir, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
}

console.log(`Prepared ${files.length} web assets in ${outputDir}/`);
