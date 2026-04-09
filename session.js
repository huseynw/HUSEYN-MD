import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32);
}

function ensurePassword(password) {
  if (!password || password.length !== 8) {
    throw new Error("Şifrə tam olaraq 8 simvol olmalıdır.");
  }
}

async function readDirRecursive(dir) {
  const result = {};
  if (!(await fs.pathExists(dir))) return result;

  async function walk(current, base) {
    const items = await fs.readdir(current);
    for (const item of items) {
      const full = path.join(current, item);
      const rel = path.relative(base, full);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(full, base);
      } else {
        const data = await fs.readFile(full);
        result[rel] = data.toString("base64");
      }
    }
  }

  await walk(dir, dir);
  return result;
}

async function writeDirRecursive(dir, filesObj) {
  await fs.ensureDir(dir);
  for (const [rel, b64] of Object.entries(filesObj)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, Buffer.from(b64, "base64"));
  }
}

export async function exportSessionString(authDir, password, prefix = "HUSEYN-MD") {
  ensurePassword(password);

  const files = await readDirRecursive(authDir);
  const payload = JSON.stringify({
    createdAt: Date.now(),
    files
  });

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(payload, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
  return `${prefix}:${blob}`;
}

export async function importSessionString(sessionString, password, authDir, prefix = "HUSEYN-MD") {
  ensurePassword(password);

  if (!sessionString.startsWith(prefix + ":")) {
    throw new Error(`Session ${prefix}: ilə başlamalıdır.`);
  }

  const blob = Buffer.from(sessionString.slice(prefix.length + 1), "base64");
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 28);
  const tag = blob.subarray(28, 44);
  const encrypted = blob.subarray(44);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString("utf8");

  const parsed = JSON.parse(decrypted);

  await fs.emptyDir(authDir);
  await writeDirRecursive(authDir, parsed.files || {});
}
