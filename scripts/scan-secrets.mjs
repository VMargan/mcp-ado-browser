/**
 * Pre-push secret / sensitive-data scanner.
 *
 * Scans every file that would be committed (git-tracked + untracked-not-ignored) for:
 *   - generic secret patterns (emails, home paths, PAT/JWT-like tokens,
 *     *.visualstudio.com/<org>, private keys);
 *   - any concrete values supplied at runtime via SECRET_VALUES (comma-separated)
 *     e.g. your org/project/repo/feed/ids. These are NEVER hardcoded here, so the
 *     scanner itself leaks nothing.
 *
 * Exit 0 = clean; exit 1 = potential leak(s) found (blocks the push).
 *
 * Usage:
 *   node scripts/scan-secrets.mjs
 *   SECRET_VALUES="myorg,MyProject,my-repo,my-feed,12345" node scripts/scan-secrets.mjs
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SELF = "scripts/scan-secrets.mjs";
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".bin", ".nupkg", ".tgz", ".zip", ".sqlite", ".lock"]);
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", SELF]);
// Example/fictional domains that are safe (Microsoft docs use contoso/fabrikam).
const EMAIL_ALLOW = /@(example\.(com|org|net|invalid)|contoso\.com|fabrikam\.com)$/i;

const RULES = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, allow: (m) => EMAIL_ALLOW.test(m) },
  { name: "home-path", re: /\/(Users|home)\/[A-Za-z0-9._-]+\//g, allow: () => false },
  { name: "ado-pat", re: /\b[a-z2-7]{52}\b/g, allow: () => false },
  { name: "jwt/bearer", re: /(Bearer\s+[A-Za-z0-9._-]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, allow: () => false },
  { name: "visualstudio-org", re: /\b([A-Za-z0-9-]{2,})\.visualstudio\.com/g, allow: () => false },
  { name: "private-key", re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/g, allow: () => false },
];

/** True if the text contains a NUL byte (a binary file we should skip). */
function isBinary(content) {
  const n = Math.min(content.length, 8000);
  for (let i = 0; i < n; i++) if (content.charCodeAt(i) === 0) return true;
  return false;
}

function listFiles() {
  const out = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const userValues = (process.env.SECRET_VALUES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length >= 3);

const findings = [];
let scanned = 0;

for (const file of listFiles()) {
  const base = path.basename(file);
  if (SKIP_FILES.has(file) || SKIP_FILES.has(base)) continue;
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
  let content;
  try {
    if (fs.statSync(file).size > 512 * 1024) continue;
    content = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (isBinary(content)) continue;
  scanned++;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(content)) !== null) {
      if (rule.allow(m[0])) continue;
      findings.push({ file, rule: rule.name, snippet: m[0].slice(0, 60) });
    }
  }
  // Strip Microsoft product brand tokens before the value check: a project literally
  // named e.g. "DevOps" collides with "Azure DevOps"/"azure-devops" everywhere.
  const lower = content.replace(/azure devops|azure artifacts|azure-devops/gi, "").toLowerCase();
  for (const v of userValues) {
    if (lower.includes(v.toLowerCase())) findings.push({ file, rule: "SECRET_VALUES", snippet: v });
  }
}

if (findings.length) {
  console.error(`FAILED secret scan: ${findings.length} potential leak(s) across ${scanned} files:`);
  for (const f of findings) console.error(`  ${f.file}  [${f.rule}]  ${f.snippet}`);
  process.exit(1);
}
console.log(`OK secret scan clean (${scanned} files scanned, ${userValues.length} extra value(s) checked)`);
