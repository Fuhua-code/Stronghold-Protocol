#!/usr/bin/env node
// mobile/tools/patch-elf-sonames.mjs — make an Android-legal library layout out of the Termux runtime.
//
//   node mobile/tools/patch-elf-sonames.mjs <dir> [--dry-run]
//
// Why this exists (measured on a real device and on MuMu Player):
//   Android's package manager only extracts `lib/<abi>/` entries whose name has the shape `lib*.so` — a bare
//   executable (`node`) or a versioned soname (`libcrypto.so.3`, `libicuuc.so.78`, `libz.so.1`) is **skipped**,
//   so it never lands in `nativeLibraryDir` and the app cannot run it. The Termux runtime Node ships consists
//   entirely of such names, so the packager rewrites the names and the ELF records that point at them:
//
//     node                 -> libnode.so      (the executable itself; DT_SONAME patched to match)
//     libcrypto.so.3       -> libcrypto.so    (DT_NEEDED in every library + the executable patched)
//     libssl.so.3          -> libssl.so
//     libicuuc.so.78       -> libicuuc.so
//     libicui18n.so.78     -> libicui18n.so
//     libicudata.so.78     -> libicudata.so
//     libz.so.1            -> libz.so
//
// A renamed library keeps working because the dynamic linker matches a `DT_NEEDED` entry against the target's
// `DT_SONAME` (both rewritten here, as an in-place, same-length-or-shorter string so no ELF offset moves).
// Names that already match `lib*.so` (`libc++_shared.so`, `libcares.so`, `libsqlite3.so`) are left alone.
//
// The rewrite is byte-level and conservative: only the `DT_NEEDED` and `DT_SONAME` string table slots are
// touched, every other byte (including the rest of `.dynstr`) is preserved, and the file is only written when
// something actually changed. `--dry-run` prints the plan without touching anything.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The short, Android-legal name for a Termux runtime file (or null when the name is already fine). */
export function androidLibName(name) {
  if (name === 'node') return 'libnode.so';
  // `libcrypto.so.3` -> `libcrypto.so`, `libicudata.so.78.3` -> `libicudata.so`; already short names stay as they are
  const m = /^(lib[^/]+?\.so)(?:\.[0-9][^/]*)?$/.exec(name);
  if (!m) return null;              // not a `lib*.so*` name (a plain executable, a data file, …)
  return m[1] === name ? null : m[1];
}

const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_SONAME = 14;

/**
 * Rewrite the `DT_NEEDED`/`DT_SONAME` strings of an ELF shared object or executable — ELF64 and ELF32, both
 * little-endian (aarch64/x86_64 and arm/x86 respectively, which is what the Termux runtime consists of).
 * @param {Buffer} buf
 * @param {(name: string) => string | null} rename maps a name to its replacement (null = keep)
 * @returns {{ buf: Buffer, changed: string[] }}
 */
export function patchElfSonames(buf, rename) {
  if (buf.length < 64 || buf.readUInt32LE(0) !== 0x464c457f) throw new Error('not an ELF file');
  const is64 = buf[4] === 2;
  if (!is64 && buf[4] !== 1) throw new Error(`unsupported ELF class ${buf[4]}`);
  if (buf[5] !== 1) throw new Error('only little-endian ELF is supported');

  // ELF32 (arm, x86) and ELF64 (aarch64, x86_64) differ in every field width *and* in the section-header layout.
  const SH_OFFSET = is64 ? 0x28 : 0x20;   // e_shoff
  const SH_ENTSIZE = is64 ? 0x3a : 0x2e;  // e_shentsize
  const SH_NUM = is64 ? 0x3c : 0x30;      // e_shnum
  const SH_TYPE = 4;                      // sh_type   (same offset in both classes)
  const SH_ADDR = is64 ? 0x10 : 0x0c;     // sh_addr
  const SH_FILE = is64 ? 0x18 : 0x10;     // sh_offset
  const SH_SIZE = is64 ? 0x20 : 0x14;     // sh_size
  const DYN_ENTSIZE = is64 ? 16 : 8;
  const readWord = (off) => (is64 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off));

  const eShoff = readWord(SH_OFFSET);
  const eShentsize = buf.readUInt16LE(SH_ENTSIZE);
  const eShnum = buf.readUInt16LE(SH_NUM);

  let dyn = null;
  for (let i = 0; i < eShnum; i++) {
    const off = eShoff + i * eShentsize;
    if (buf.readUInt32LE(off + SH_TYPE) === 6 /* SHT_DYNAMIC */) {
      dyn = { offset: readWord(off + SH_FILE), size: readWord(off + SH_SIZE) };
      break;
    }
  }
  if (!dyn) throw new Error('no .dynamic section');

  const entries = [];
  for (let p = dyn.offset; p + DYN_ENTSIZE <= dyn.offset + dyn.size; p += DYN_ENTSIZE) {
    const tag = is64 ? Number(buf.readBigInt64LE(p)) : buf.readInt32LE(p);
    if (tag === DT_NULL) break;
    entries.push({ tag, val: readWord(p + (is64 ? 8 : 4)) });
  }
  const strtabVaddr = entries.find((e) => e.tag === DT_STRTAB)?.val;
  const strsz = entries.find((e) => e.tag === DT_STRSZ)?.val;
  if (strtabVaddr == null || strsz == null) throw new Error('no DT_STRTAB / DT_STRSZ');

  // virtual address -> file offset, via the section headers (sufficient for .dynstr)
  let strtabOff = null;
  for (let i = 0; i < eShnum; i++) {
    const off = eShoff + i * eShentsize;
    if (buf.readUInt32LE(off + SH_TYPE) !== 3 /* SHT_STRTAB */) continue;
    if (readWord(off + SH_ADDR) === strtabVaddr) { strtabOff = readWord(off + SH_FILE); break; }
  }
  // fall back: .dynstr usually sits right after .dynamic
  if (strtabOff == null) strtabOff = dyn.offset + dyn.size;
  const strEnd = strtabOff + strsz;

  const readStr = (offset) => {
    const end = buf.indexOf(0, offset);
    if (end < 0 || end >= strEnd) return '';
    return buf.toString('utf8', offset, end);
  };
  const writeStr = (offset, value) => {
    const end = buf.indexOf(0, offset);
    const room = end - offset;
    if (value.length > room) throw new Error(`"${value}" does not fit in the ${room} bytes reserved at ${offset}`);
    buf.write(value, offset, 'utf8');
    buf.fill(0, offset + value.length, end); // clear the tail so nothing reads a stale suffix
  };

  const changed = [];
  for (const e of entries) {
    if (e.tag !== DT_NEEDED && e.tag !== DT_SONAME) continue;
    const offset = strtabOff + e.val;
    const current = readStr(offset);
    if (!current) continue;
    const next = rename(current);
    if (!next || next === current) continue;
    writeStr(offset, next);
    changed.push(`${e.tag === DT_SONAME ? 'SONAME' : 'NEEDED'} ${current} -> ${next}`);
  }
  return { buf, changed };
}

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: node mobile/tools/patch-elf-sonames.mjs <runtime dir> [--dry-run]');
    return 2;
  }
  const result = await patchRuntimeDir(dir, { dryRun });
  console.log(`▶ ${path.resolve(dir)}`);
  console.log(`  ${result.renamed.length ? `renaming ${result.renamed.map(([a, b]) => `${a}->${b}`).join(', ')}` : 'nothing to rename'}`);
  for (const line of result.log) console.log(`  ${line}`);
  console.log(`  ${dryRun ? '(dry run) ' : ''}${result.patched} ELF files patched, ${result.renamed.length} renamed`);
  return 0;
}

/**
 * Apply the Android-legal layout to a directory of runtime files (used by the packager and by this CLI).
 * @param {string} dir
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function patchRuntimeDir(dir, { dryRun = false } = {}) {
  const root = path.resolve(dir);
  const files = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  const renames = new Map();
  for (const f of files) {
    const to = androidLibName(f);
    if (to) renames.set(f, to);
  }
  const rename = (name) => renames.get(path.posix.basename(name)) ?? null;

  const log = [];
  let patched = 0;
  for (const f of files) {
    const p = path.join(root, f);
    const buf = await fsp.readFile(p);
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x464c457f) continue; // not ELF (e.g. the ICU data blob): skip
    let out;
    try {
      out = patchElfSonames(Buffer.from(buf), rename);
    } catch (e) {
      log.push(`! ${f}: ${e.message}`);
      continue;
    }
    if (out.changed.length) {
      patched++;
      log.push(`${f}: ${out.changed.join(', ')}`);
      if (!dryRun) await fsp.writeFile(p, out.buf);
    }
  }
  if (!dryRun) {
    for (const [from, to] of renames) {
      const src = path.join(root, from);
      const dst = path.join(root, to);
      if (fs.existsSync(dst)) await fsp.rm(dst, { force: true });
      await fsp.rename(src, dst);
    }
  }
  return { patched, renamed: [...renames], log };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
}
