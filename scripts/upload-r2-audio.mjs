#!/usr/bin/env node
// Upload locally verified immutable copies. Verification of public delivery is a separate step.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--manifest") || !process.argv.includes("--bucket"))
  throw new Error("Usage: node scripts/upload-r2-audio.mjs --manifest /path/to/manifest.json --bucket technochristianity-audio");
const manifestPath = resolve(flag("--manifest"));
const bucket = flag("--bucket");
if (!/^[a-z0-9-]{3,63}$/.test(bucket)) throw new Error("Invalid R2 bucket name.");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.formatVersion !== 1 || manifest.provider !== "cloudflare-r2" || !Array.isArray(manifest.objects))
  throw new Error("Invalid staged R2 manifest.");
const seen = new Set();
for (const item of manifest.objects) {
  if (!/^audio\/[a-z0-9-]+\/[a-f0-9]{16}\.(mp3|m4a)$/.test(item.key) ||
      !["audio/mpeg", "audio/mp4"].includes(item.contentType) || seen.has(item.key))
    throw new Error(`Invalid or duplicate audio key: ${item.key}`);
  seen.add(item.key);
  const path = resolve(dirname(manifestPath), item.key);
  if (!path.startsWith(dirname(manifestPath) + "/")) throw new Error(`Unsafe path: ${item.key}`);
  const bytes = await readFile(path);
  if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
    throw new Error(`Staged audio has changed: ${item.key}`);
}

for (const item of manifest.objects) {
  const path = resolve(dirname(manifestPath), item.key);
  console.log(`Uploading ${item.key} (${item.bytes} bytes)`);
  const result = spawnSync("npx", ["--yes", "wrangler", "r2", "object", "put", `${bucket}/${item.key}`,
    "--file", path, "--remote", "--content-type", item.contentType,
    "--cache-control", "public, max-age=31536000, immutable"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`R2 upload failed for ${item.key} (exit ${result.status})`);
}
console.log(`Uploaded ${manifest.objects.length} objects. Run verify-r2-delivery.mjs against the public URL next.`);
