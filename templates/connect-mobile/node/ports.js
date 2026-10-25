export function portCandidates(preferred = 3000) {
  const port = Number(preferred);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
  if (port < 3000 || port > 3009) return [port]; // Explicit 0 is reserved for tests.
  return [port, ...Array.from({ length: 10 }, (_, i) => 3000 + i).filter(p => p !== port)];
}

export async function startOnAvailablePort(start, options) {
  for (const port of portCandidates(options.port ?? 3000)) {
    try { return await start({ ...options, port }); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('Local ports 3000–3009 are occupied; close the conflicting application and retry.');
}
