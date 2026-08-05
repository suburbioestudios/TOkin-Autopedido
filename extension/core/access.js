// Control de acceso por lista remota de hashes SHA-256 de emails (tokin-users).
// La lista vive en un repo publico separado y se cachea en chrome.storage.local.
// Los emails en claro nunca salen de la PC: solo se envía el hash del email de sesión.

const REPO = {
  owner: "suburbioestudios",
  repo: "tokin-users",
  branch: "main",
  path: "allowed_users.json",
};

const RAW_URL = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`;
const CACHE_KEY = "tokin_allowed_cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

function extractHashes(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.allowed_hashes)) return data.allowed_hashes;
  if (data && Array.isArray(data.allowed_emails)) return data.allowed_emails;
  return [];
}

async function getAllowedUsers(force) {
  let cached = {};
  try {
    cached = await chrome.storage.local.get(CACHE_KEY);
  } catch (e) {
    cached = {};
  }
  if (!force && cached[CACHE_KEY] && Date.now() - cached[CACHE_KEY].ts < CACHE_TTL) {
    return { ok: true, hashes: cached[CACHE_KEY].hashes, cached: true };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(RAW_URL, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const hashes = extractHashes(data);
      await chrome.storage.local.set({
        [CACHE_KEY]: { hashes, ts: Date.now() },
      });
      return { ok: true, hashes, cached: false };
    }
    throw new Error("HTTP " + res.status);
  } catch (e) {
    const cached = await chrome.storage.local.get(CACHE_KEY);
    if (cached[CACHE_KEY] && Array.isArray(cached[CACHE_KEY].hashes)) {
      return {
        ok: true,
        hashes: cached[CACHE_KEY].hashes,
        cached: true,
        warning: "Sin internet: usando lista guardada.",
      };
    }
    return {
      ok: false,
      hashes: [],
      error: "Sin internet y sin lista guardada. Acceso denegado.",
    };
  }
}

async function hashEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const data = new TextEncoder().encode(e);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

async function isAllowed(email, hashes) {
  if (!email || !Array.isArray(hashes) || !hashes.length) return false;
  const h = await hashEmail(email);
  return hashes.map((x) => String(x || "").trim().toLowerCase()).includes(h);
}

export { getAllowedUsers, isAllowed, hashEmail, RAW_URL };
