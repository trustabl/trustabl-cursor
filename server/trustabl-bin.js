// Resolves a usable `trustabl` binary for the current machine.
//
// Order: TRUSTABL_BIN override -> already on PATH -> download the release asset
// for this OS/arch and sha256-verify it against the release `checksums.txt`
// (same install contract as the CI plugins), then cache it under
// ~/.trustabl-cursor/<version>/ so later scans skip the download.
//
// NOTE: everything here logs to stderr. stdout is the MCP protocol channel.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "trustabl/trustabl";
const log = (msg) => process.stderr.write(`[trustabl] ${msg}\n`);

/**
 * Optional settings arrive as ${VAR} placeholders that the host substitutes.
 * A host that leaves an unset one unsubstituted would hand us the literal
 * "${TRUSTABL_VERSION}" — treat that as "not set" rather than as a version tag.
 */
export const setting = (value) => {
  const v = value?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
};

function ghHeaders() {
  const h = { "User-Agent": "trustabl-cursor-plugin" };
  const token = setting(process.env.GITHUB_TOKEN);
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** linux/darwin/windows + amd64/arm64, matching the release asset matrix. */
function platformTarget() {
  const osName = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
  if (!osName) throw new Error(`Unsupported OS: ${process.platform}`);

  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);

  // Windows releases are amd64-only (arm64 Windows runs the amd64 build via emulation).
  const assetArch = osName === "windows" ? "amd64" : arch;
  const ext = osName === "windows" ? "zip" : "tar.gz";
  const exe = osName === "windows" ? "trustabl.exe" : "trustabl";
  return { osName, arch: assetArch, ext, exe };
}

/** Returns the path if `trustabl` already runs on this machine, else null. */
function existingBinary() {
  const override = setting(process.env.TRUSTABL_BIN);
  const candidates = override ? [override] : ["trustabl"];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", shell: false });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

async function resolveVersion(requested) {
  if (requested && requested !== "latest") return requested;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: ghHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `Could not resolve the latest trustabl release (HTTP ${res.status}). ` +
        `Set TRUSTABL_VERSION to a tag (e.g. v0.1.6), or set GITHUB_TOKEN if you are rate-limited.`
    );
  }
  const tag = (await res.json()).tag_name;
  if (!tag) throw new Error("Latest release has no tag_name.");
  return tag;
}

async function download(url, dest) {
  const res = await fetch(url, {
    headers: { ...ghHeaders(), Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * sha256-verify the archive against the release checksums.txt. A missing
 * checksums file is a hard failure: we do not run an unverified binary.
 */
async function verifyChecksum(archivePath, assetName, version) {
  const url = `https://github.com/${REPO}/releases/download/${version}/checksums.txt`;
  const res = await fetch(url, { headers: ghHeaders(), redirect: "follow" });
  if (!res.ok) throw new Error(`Could not fetch checksums.txt (HTTP ${res.status}) — refusing to run an unverified binary.`);

  const line = (await res.text()).split("\n").find((l) => l.trim().endsWith(assetName));
  if (!line) throw new Error(`${assetName} is not listed in checksums.txt — refusing to run an unverified binary.`);

  const expected = line.trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`);
  }
  log(`checksum verified: ${assetName}`);
}

/**
 * Windows releases ship a .zip, every other platform a .tar.gz.
 *
 * `tar` is not a safe way to unpack the zip: whichever `tar` is first on PATH
 * may be GNU tar (e.g. under Git Bash/MSYS), which cannot read zip archives.
 * PowerShell's Expand-Archive is always present on Windows 10+, so use that.
 */
function extract(archivePath, destDir) {
  const [cmd, args] =
    process.platform === "win32"
      ? [
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
          ],
        ]
      : ["tar", ["-xf", archivePath, "-C", destDir]];

  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) throw new Error(`Could not extract ${path.basename(archivePath)}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`Could not extract ${path.basename(archivePath)}: ${r.stderr?.trim() || `exit ${r.status}`}`);
  }
}

/**
 * Returns an absolute path to a runnable `trustabl`, downloading + verifying it
 * on first use. Cached per version.
 */
export async function ensureTrustabl(requestedVersion) {
  const onPath = existingBinary();
  if (onPath) {
    log(`using trustabl already on PATH (${onPath})`);
    return onPath;
  }

  const { osName, arch, ext, exe } = platformTarget();
  const version = await resolveVersion(requestedVersion);
  const cacheDir = path.join(os.homedir(), ".trustabl-cursor", version);
  const binPath = path.join(cacheDir, exe);
  if (fs.existsSync(binPath)) return binPath;

  const assetName = `trustabl_${version.replace(/^v/, "")}_${osName}_${arch}.${ext}`;
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, assetName);

  log(`downloading ${assetName} (${version})...`);
  await download(`https://github.com/${REPO}/releases/download/${version}/${assetName}`, archivePath);
  await verifyChecksum(archivePath, assetName, version);
  extract(archivePath, cacheDir);
  fs.rmSync(archivePath, { force: true });

  if (!fs.existsSync(binPath)) {
    throw new Error(`Extracted ${assetName} but ${exe} was not found in ${cacheDir}`);
  }
  if (osName !== "windows") fs.chmodSync(binPath, 0o755);
  log(`installed trustabl ${version}`);
  return binPath;
}
