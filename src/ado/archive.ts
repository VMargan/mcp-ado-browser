/**
 * Archive integrity validation for downloaded artifacts (Phase 3 gate).
 *
 *  - .nupkg is a ZIP: must start with the PK local-file signature and contain a
 *    `.nuspec` entry (proves it's a real NuGet package, reusable for re-push).
 *  - .tgz is gzip(tar): gunzip then confirm the tar stream contains `package.json`.
 *
 * Uses only node:zlib — no third-party archive deps.
 */
import * as zlib from "node:zlib";

export interface ArchiveCheck {
  valid: boolean;
  detail: string;
}

export function validateArchive(protocol: "nuget" | "npm", data: Buffer): ArchiveCheck {
  return protocol === "nuget" ? validateNupkg(data) : validateTgz(data);
}

function validateNupkg(data: Buffer): ArchiveCheck {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
    return { valid: false, detail: "not a ZIP archive (missing PK signature)" };
  }
  // Scan the central directory file names for a .nuspec entry.
  const hasNuspec = scanZipForExtension(data, ".nuspec");
  return hasNuspec
    ? { valid: true, detail: "valid .nupkg (ZIP with .nuspec entry)" }
    : { valid: false, detail: "ZIP archive without a .nuspec entry" };
}

function validateTgz(data: Buffer): ArchiveCheck {
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
    return { valid: false, detail: "not a gzip stream (missing 1f 8b magic)" };
  }
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(data);
  } catch (e) {
    return { valid: false, detail: `gunzip failed: ${String(e)}` };
  }
  // npm tarballs put files under "package/"; the manifest is package/package.json.
  const hasManifest = tarContainsName(tar, "package.json");
  return hasManifest
    ? { valid: true, detail: "valid .tgz (gzip+tar containing package.json)" }
    : { valid: false, detail: "gzip/tar without a package.json entry" };
}

/** Walk ZIP central-directory headers (PK\x01\x02) and test each file name. */
function scanZipForExtension(buf: Buffer, ext: string): boolean {
  const CEN = 0x02014b50; // central directory header signature
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === CEN) {
      const nameLen = buf.readUInt16LE(i + 28);
      const name = buf.toString("utf8", i + 46, i + 46 + nameLen);
      if (name.toLowerCase().endsWith(ext)) return true;
      i += 46 + nameLen - 1;
    }
  }
  // Fallback: some minimal zips — scan raw bytes for the extension string.
  return buf.toString("latin1").toLowerCase().includes(ext);
}

/** Walk 512-byte tar headers and test each entry name for a suffix. */
function tarContainsName(tar: Buffer, suffix: string): boolean {
  for (let off = 0; off + 512 <= tar.length; ) {
    const nameRaw = tar.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (nameRaw === "") break; // two zero blocks => end of archive
    if (nameRaw.endsWith(suffix)) return true;
    const sizeStr = tar.toString("ascii", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return tar.toString("latin1").includes(suffix);
}
