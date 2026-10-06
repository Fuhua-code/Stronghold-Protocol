export const WIRE = 'stronghold-pages-v1';
export function sameBuild(expected, actual) {
  return !!actual && actual.wire === WIRE && actual.app === expected.app
    && actual.protocol === expected.protocol && actual.compat === expected.compat;
}
export function peerId(code) {
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('Invalid alliance key');
  return `stronghold-pages-${code}`;
}
