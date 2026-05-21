import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const dist = "dist";
await mkdir(dist, { recursive: true });

const files = [
  "manifest.json",
  "src/popup.html",
  "src/popup.css",
];

for (const f of files) {
  const dest = join(dist, f.split("/").pop());
  await copyFile(f, dest);
  console.log(`copied ${f} -> ${dest}`);
}

// Recursively copy fonts/ → dist/fonts/
const fontsSrc = "fonts";
const fontsDest = join(dist, "fonts");
await mkdir(fontsDest, { recursive: true });
for (const entry of await readdir(fontsSrc)) {
  await copyFile(join(fontsSrc, entry), join(fontsDest, entry));
  console.log(`copied ${fontsSrc}/${entry} -> ${fontsDest}/${entry}`);
}
