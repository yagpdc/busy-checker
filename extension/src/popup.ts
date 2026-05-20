/// <reference types="chrome" />

type BgResponse<T> = { ok: true; data: T } | { ok: false; error: string };

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: BgResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error ?? "unknown_error"));
    });
  });
}

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

async function refreshUser(): Promise<void> {
  const { user, session } = await chrome.storage.local.get(["user", "session"]);
  const emailEl = $<HTMLSpanElement>("user-email");
  const inBtn = $<HTMLButtonElement>("sign-in");
  const outBtn = $<HTMLButtonElement>("sign-out");
  if (session && user) {
    emailEl.textContent = (user as { email: string }).email;
    inBtn.hidden = true;
    outBtn.hidden = false;
  } else {
    emailEl.textContent = "não conectado";
    inBtn.hidden = false;
    outBtn.hidden = true;
  }
}

function showError(msg: string): void {
  const el = $<HTMLParagraphElement>("error");
  el.textContent = msg;
  el.hidden = false;
}

function clearError(): void {
  $<HTMLParagraphElement>("error").hidden = true;
}

$<HTMLButtonElement>("sign-in").addEventListener("click", async () => {
  clearError();
  try {
    await send<{ email: string }>({ type: "signIn" });
    await refreshUser();
  } catch (err) {
    showError((err as Error).message);
  }
});

$<HTMLButtonElement>("sign-out").addEventListener("click", async () => {
  await send({ type: "signOut" });
  await refreshUser();
});

$<HTMLButtonElement>("ask").addEventListener("click", async () => {
  clearError();
  const q = $<HTMLTextAreaElement>("question").value.trim();
  if (!q) return;
  // Input strategy:
  //  - contains '@' → treat as email
  //  - looks like a plain name (no spaces fancy chars) → send as targetName
  //    so the backend resolves via local users / Workspace directory
  //  - everything else → send as free-text question (needs OpenAI)
  const emailMatch = q.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  let payload: { type: "query"; targetEmail?: string; targetName?: string; question?: string };
  if (emailMatch) {
    payload = { type: "query", targetEmail: emailMatch[0] };
  } else if (/^[\p{L}\s.'-]{2,80}$/u.test(q)) {
    payload = { type: "query", targetName: q };
  } else {
    payload = { type: "query", question: q };
  }
  try {
    const data = await send<{ reply: string; facts: unknown }>(payload);
    $<HTMLParagraphElement>("reply").textContent = data.reply;
    $<HTMLPreElement>("facts").textContent = JSON.stringify(data.facts, null, 2);
    $<HTMLElement>("result").hidden = false;
  } catch (err) {
    showError((err as Error).message);
  }
});

refreshUser();
