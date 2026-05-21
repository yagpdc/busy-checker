import { copyFile, mkdir, readdir } from "node:fs/promises";
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

// Copy icons/ → dist/icons/ if any files are present
try {
  const iconFiles = await readdir("icons");
  if (iconFiles.length > 0) {
    await mkdir(join(dist, "icons"), { recursive: true });
    for (const f of iconFiles) {
      await copyFile(join("icons", f), join(dist, "icons", f));
      console.log(`copied icons/${f} -> ${join(dist, "icons", f)}`);
    }
  }
} catch {
  // icons/ doesn't exist yet — nothing to copy
}

// Copy src/themes/*.css → dist/themes/. These are loaded:
//   - by the popup via <link rel="stylesheet" href="themes/X.css">
//   - by the widget via chrome.runtime.getURL into the shadow root
// All of them MUST also appear in manifest.json's
// web_accessible_resources so chrome.runtime.getURL doesn't 404.
try {
  const themeFiles = await readdir("src/themes");
  if (themeFiles.length > 0) {
    await mkdir(join(dist, "themes"), { recursive: true });
    for (const f of themeFiles) {
      if (!f.endsWith(".css")) continue;
      await copyFile(join("src/themes", f), join(dist, "themes", f));
      console.log(`copied src/themes/${f} -> ${join(dist, "themes", f)}`);
    }
  }
} catch (err) {
  console.warn("themes copy skipped:", err.message);
}
