/// <reference types="chrome" />

// Throttle: report at most one activity event every 20s to the background.
// Background dedupes again before hitting the network.
const THROTTLE_MS = 20_000;
let lastSent = 0;

function ping(source: string): void {
  const now = Date.now();
  if (now - lastSent < THROTTLE_MS) return;
  lastSent = now;
  chrome.runtime
    .sendMessage({ type: "activity", source })
    .catch(() => {
      // Background may be asleep; it'll get the next one.
    });
}

window.addEventListener("mousemove", () => ping("mouse"), { passive: true });
window.addEventListener("keydown", () => ping("key"), { passive: true });
window.addEventListener("scroll", () => ping("scroll"), { passive: true });
