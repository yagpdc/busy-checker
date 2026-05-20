import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const dist = "dist";
await mkdir(dist, { recursive: true });

const assets = [
  "manifest.json",
  "src/popup.html",
  "src/popup.css",
];

for (const a of assets) {
  const dest = join(dist, a.split("/").pop());
  await copyFile(a, dest);
  console.log(`copied ${a} -> ${dest}`);
}
