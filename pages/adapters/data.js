let data = {};
export function setData(value) { data = value; }
export function getData() { return data; }
export function resetData() { data = {}; }
export function getConfig(raw = data) { return raw?.config || null; }
export function getMode(id, raw = data) {
  const modes = getConfig(raw)?.modes;
  return modes && Object.hasOwn(modes, id) ? modes[id] : null;
}
export function lookup(file, id, raw = data) {
  const map = Object.hasOwn(raw, file) ? raw[file] : null;
  return typeof id === 'string' && map && Object.hasOwn(map, id) && typeof map[id] === 'object' ? map[id] : null;
}
