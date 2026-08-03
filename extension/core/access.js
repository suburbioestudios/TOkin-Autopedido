// Control de acceso por lista remota de emails (allowed_users.json en el repo).
// La lista vive en el repo publico y se cachea en chrome.storage.local.
// Sin internet y sin cache -> denegar (fallback seguro, no permisivo).

export const REPO = {
  owner: "suburbioestudios",
  repo: "TOkin-Autopedido",
  branch: "main",
  path: "allowed_users.json",
};

const RAW_URL = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${REPO.path}`;
const CACHE_KEY = "tokin_allowed_cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

function extractEmails(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.allowed_emails)) return data.allowed_emails;
  return [];
}

async function getAllowedUsers(force) {
  if (!force) {
    const cached = await chrome.storage.local.get(CACHE_KEY);
    if (cached[CACHE_KEY] && Date.now() - cached[CACHE_KEY].ts < CACHE_TTL) {
      return { ok: true, emails: cached[CACHE_KEY].emails, cached: true };
    }
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
  const e = String(email || "").trim().toLowerCase();
  return (
    e !== "" &&
    emails.map((x) => String(x || "").trim().toLowerCase()).includes(e)
  );
}

export { getAllowedUsers, isAllowed, RAW_URL };
