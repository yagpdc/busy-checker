/// <reference types="chrome" />

// Throttle: report at most one activity event every 20s to the background.
// Background dedupes again before hitting the network.
const THROTTLE_MS = 20_000;
let lastSent = 0;

function ping(source: string): void {
  const now = Date.now();
  if (now - lastSent < THROTTLE_MS) return;
  lastSent = now;
  // sendMessage can throw synchronously ("Extension context invalidated")
  // when the page survived an extension reload — the content script is
  // orphaned. Nothing useful we can do; the next page reload re-injects.
  try {
    chrome.runtime
      .sendMessage({ type: "activity", source })
      .catch(() => {
        /* background asleep or gone — next ping will retry */
      });
  } catch {
    /* orphaned context */
  }
}

window.addEventListener("mousemove", () => ping("mouse"), { passive: true });
window.addEventListener("keydown", () => ping("key"), { passive: true });
window.addEventListener("scroll", () => ping("scroll"), { passive: true });
