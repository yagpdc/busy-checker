import { Router } from "express";

// Bump this on every extension release. The popup compares it against
// chrome.runtime.getManifest().version and shows an update banner when
// it sees a newer one. The downloadUrl must point to a built .zip
// served from this same backend (see src/index.ts static mount).
//
// On a new release:
//   1. bump version in extension/manifest.json
//   2. bump the LATEST_VERSION below
//   3. rebuild extension + create zip
//   4. scp the zip to services.kipflow.io:/home/ubuntu/busy-checker/public/
//   5. deploy backend
export const LATEST_VERSION = "0.3.0";
const PUBLIC_BASE =
  process.env.PUBLIC_BASE_URL ?? "https://services.kipflow.io/busy-checker";

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    version: LATEST_VERSION,
    downloadUrl: `${PUBLIC_BASE}/extension/toki-latest.zip`,
    // Optional: short PT-BR changelog the banner can show on hover.
    releaseNotes:
      "v0.2.0: popup virou chat real com histórico, widget detecta o novo " +
      "esquema de URL do Chat (/app/chat/), botões de minimizar e fechar, " +
      "disambiguation de nomes ambíguos.",
  });
});

export default router;
