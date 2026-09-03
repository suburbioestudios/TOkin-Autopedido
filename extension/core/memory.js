// Memoria de mapeo, portada de server/memory.py pero en chrome.storage.local.
// Formato: { [fingerprint]: { [field_key]: {type:"static",value} | {type:"doc_source",source} } }

const KEY = "tokin_memory";

async function getMemory() {
  const data = await chrome.storage.local.get(KEY);
  return data[KEY] || {};
}

async function setMapping(fingerprint, fieldKey, source, value) {
  const mem = await getMemory();
  const entry = !source && value ? { type: "static", value } : { type: "doc_source", source };
  mem[fingerprint] = mem[fingerprint] || {};
  mem[fingerprint][fieldKey] = entry;
  await chrome.storage.local.set({ [KEY]: mem });
  return mem;
}

async function clearMemory(fingerprint) {
  const mem = await getMemory();
  if (fingerprint == null) {
    await chrome.storage.local.set({ [KEY]: {} });
    return {};
  }
  delete mem[fingerprint];
  await chrome.storage.local.set({ [KEY]: mem });
  return mem;
}

export { getMemory, setMapping, clearMemory };
