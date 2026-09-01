// Control de acceso por lista remota de emails permitidos (tokin-users).
// La lista vive en un repo publico separado y se cachea en chrome.storage.local.

const REPO = {
  owner: "suburbioestudios",
  repo: "tokin-users",
  branch: "main",
  path: "allowed_users.json",
};

const RAW_URL = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`;
const CACHE_KEY = "tokin_allowed_cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

function extractEmails(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.allowed_emails)) return data.allowed_emails;
  if (data && Array.isArray(data.allowed_hashes)) return data.allowed_hashes;
  return [];
}

async function getAllowedUsers(force) {
  let cached = {};
  try {
    cached = await chrome.storage.local.get(CACHE_KEY);
  } catch (e) {
    cached = {};
  }
  if (!force && cached[CACHE_KEY] && Array.isArray(cached[CACHE_KEY].emails) && Date.now() - cached[CACHE_KEY].ts < CACHE_TTL) {
    return { ok: true, emails: cached[CACHE_KEY].emails, cached: true };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(RAW_URL, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const emails = extractEmails(data);
      await chrome.storage.local.set({
        [CACHE_KEY]: { emails, ts: Date.now() },
      });
      return { ok: true, emails, cached: false };
    }
    throw new Error("HTTP " + res.status);
  } catch (e) {
    const cached = await chrome.storage.local.get(CACHE_KEY);
    if (cached[CACHE_KEY] && Array.isArray(cached[CACHE_KEY].emails)) {
      return {
        ok: true,
        emails: cached[CACHE_KEY].emails,
        cached: true,
        warning: "Sin internet: usando lista guardada.",
      };
    }
    return {
      ok: false,
      emails: [],
      error: "Sin internet y sin lista guardada. Acceso denegado.",
    };
  }
}

function isAllowed(email, emails) {
  if (!email || !Array.isArray(emails) || !emails.length) return false;
  const normalized = String(email || "").trim().toLowerCase();
  return emails.map((x) => String(x || "").trim().toLowerCase()).includes(normalized);
}

const GRANTED_KEY = "tokin_access_granted";
const GRANTED_TTL = 24 * 60 * 60 * 1000;

async function grantAccess(email) {
  if (!email) return;
  try {
    await chrome.storage.local.set({
      [GRANTED_KEY]: { email: String(email).trim().toLowerCase(), ts: Date.now() },
    });
  } catch (_) {}
}

async function checkCachedAccess(email) {
  if (!email) return false;
  try {
    const data = await chrome.storage.local.get(GRANTED_KEY);
    const g = data[GRANTED_KEY];
    if (g && g.email === String(email).trim().toLowerCase() && Date.now() - g.ts < GRANTED_TTL) {
      return true;
    }
  } catch (_) {}
  return false;
}

async function revokeAccess() {
  try {
    await chrome.storage.local.remove(GRANTED_KEY);
  } catch (_) {}
}

export { getAllowedUsers, isAllowed, grantAccess, checkCachedAccess, revokeAccess, RAW_URL };
