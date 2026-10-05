import path from 'node:path';

export function requireHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid URL: ${value}`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`HTTPS URL required: ${value}`);
  }
  return url;
}

export function normalizeSha256(value) {
  const digest = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('expected a 64-character SHA-256 digest');
  return digest;
}

export function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  let name = value;
  while (name.startsWith('./')) name = name.slice(2);
  if (!name || name === '.') return '';
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new Error(`absolute archive path: ${value}`);
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '..' || part === '.')) throw new Error(`traversal archive path: ${value}`);
  const normalized = path.posix.normalize(name);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`archive path escapes destination: ${value}`);
  }
  return normalized;
}

export function assertContainedPath(root, archiveName) {
  const name = safeArchivePath(archiveName);
  const base = path.resolve(root);
  const dest = path.resolve(base, ...name.split('/').filter(Boolean));
  const relative = path.relative(base, dest);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`archive path escapes destination: ${archiveName}`);
  }
  return dest;
}

export function parseInReleaseChecksums(text) {
  const start = text.indexOf('\n\n');
  const end = text.indexOf('\n-----BEGIN PGP SIGNATURE-----');
  if (!text.startsWith('-----BEGIN PGP SIGNED MESSAGE-----') || start < 0 || end < start) {
    throw new Error('invalid clear-signed InRelease file');
  }
  const body = text.slice(start + 2, end).replace(/^-(?= )/gm, '');
  const section = /^SHA256:\s*\r?\n([\s\S]*?)(?=^SHA512:|^MD5Sum:|^SHA1:|^-----BEGIN PGP SIGNATURE-----)/m.exec(body);
  if (!section) throw new Error('InRelease has no SHA256 section');
  const hashes = new Map();
  for (const line of section[1].split(/\r?\n/)) {
    const match = /^\s*([a-f0-9]{64})\s+(\d+)\s+(\S+)\s*$/i.exec(line);
    if (match) hashes.set(safeArchivePath(match[3]), { sha256: match[1].toLowerCase(), size: Number(match[2]) });
  }
  if (!hashes.size) throw new Error('InRelease SHA256 section is empty');
  return hashes;
}

export function parseDebianPackages(text) {
  const records = [];
  for (const stanza of text.split(/\r?\n\s*\r?\n/)) {
    const fields = {};
    let current = null;
    for (const line of stanza.split(/\r?\n/)) {
      if (/^[ \t]/.test(line)) {
        if (current) fields[current] += `\n${line.slice(1)}`;
        continue;
      }
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (!match) continue;
      current = match[1];
      fields[current] = match[2];
    }
    if (fields.Package) records.push(fields);
  }
  return records;
}

export function findPackageRecord(records, name, architecture) {
  const entry = records.find((record) => record.Package === name
    && (record.Architecture === architecture || record.Architecture === 'all'));
  if (!entry) throw new Error(`Termux index has no ${name} package for ${architecture}`);
  if (!entry.Filename || !entry.SHA256 || !entry.Version) throw new Error(`Termux index entry for ${name} is incomplete`);
  return {
    version: entry.Version,
    filename: safeArchivePath(entry.Filename),
    sha256: normalizeSha256(entry.SHA256),
    size: entry.Size == null ? null : Number(entry.Size),
    license: entry.License || '',
  };
}

export function hasPinnedValidSignature(status, fingerprint) {
  const expected = String(fingerprint).toUpperCase();
  return String(status).split(/\r?\n/).some((line) => {
    if (!line.startsWith('[GNUPG:] VALIDSIG ')) return false;
    return line.slice('[GNUPG:] VALIDSIG '.length).split(/\s+/).includes(expected);
  });
}
