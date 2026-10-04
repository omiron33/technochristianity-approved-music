#!/usr/bin/env node
// Verify locally staged and publicly served bytes before recording an R2 delivery.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--manifest") || !process.argv.includes("--base-url"))
  throw new Error("Usage: node scripts/verify-r2-delivery.mjs --manifest /path/to/staging/manifest.json --base-url https://media.example.com");
const manifestPath = resolve(option("--manifest"));
const staging = dirname(manifestPath);
const baseUrl = option("--base-url").replace(/\/+$/, "");
const origin = new URL(baseUrl);
if (origin.protocol !== "https:" || origin.search || origin.hash || origin.pathname !== "/")
  throw new Error("Use the HTTPS root URL of the public R2 delivery domain.");
const staged = JSON.parse(await readFile(manifestPath, "utf8"));
if (staged.formatVersion !== 1 || staged.provider !== "cloudflare-r2" || !Array.isArray(staged.objects))
  throw new Error("Invalid staged R2 manifest.");
const tokenFile = join(process.env.STUDIO_DATA_DIR || join(homedir(), "Library", "Application Support", "Music Studio"), "api-token");
const token = (await readFile(tokenFile, "utf8")).trim();
const studioResponse = await fetch("http://127.0.0.1:4319/api/v1/studio", {
  headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
});
if (!studioResponse.ok) throw new Error(`Music Studio returned ${studioResponse.status}`);
const studio = await studioResponse.json();
if (studio.settings?.paused) throw new Error("Music Studio global runner is paused.");
const works = new Map(studio.works.map((work) => [work.id, work]));
const seen = new Set();
const verified = [];
for (const item of staged.objects) {
  const work = works.get(item.workId);
  if (!work || work.audioStatus !== "approved" || work.approvedTakeId !== item.approvedTakeId)
    throw new Error(`Approved take changed or disappeared: ${item.workId}`);
  if (seen.has(item.workId) || !/^audio\/[a-z0-9-]+\/[a-f\d]{16}\.(mp3|m4a)$/.test(item.key))
    throw new Error(`Duplicate work or unsafe R2 key: ${item.workId}`);
  seen.add(item.workId);
  const local = resolve(staging, item.key);
  if (!isAbsolute(local) || !local.startsWith(staging + "/")) throw new Error(`Unsafe local path: ${item.key}`);
  const bytes = await readFile(local);
  const localHash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== item.bytes || localHash !== item.sha256)
    throw new Error(`Staged file changed: ${item.workId}`);
  const audioUrl = `${baseUrl}/${item.key}`;
  const response = await fetch(audioUrl, { signal: AbortSignal.timeout(60000), redirect: "error" });
  if (!response.ok) throw new Error(`${item.workId}: public R2 returned ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0];
  if (contentType !== item.contentType)
    throw new Error(`${item.workId}: expected ${item.contentType}, got ${contentType || "no Content-Type"}`);
  const remote = Buffer.from(await response.arrayBuffer());
  const remoteHash = createHash("sha256").update(remote).digest("hex");
  if (remote.length !== item.bytes || remoteHash !== item.sha256)
    throw new Error(`${item.workId}: R2 bytes do not match the staged file`);
  verified.push({ ...item, audioUrl, verifiedAt: new Date().toISOString() });
  console.log(`${item.workId}: R2 bytes and type verified`);
}
const target = join(root, "media-delivery.json");
let prior = null;
try { prior = JSON.parse(await readFile(target, "utf8")); } catch { /* First delivery. */ }
const retained = prior?.baseUrl === baseUrl && Array.isArray(prior.objects)
  ? prior.objects.filter((item) => !seen.has(item.workId)) : [];
await writeFile(target, JSON.stringify({ formatVersion: 1, provider: "cloudflare-r2", baseUrl,
  objects: [...retained, ...verified].sort((a, b) => a.workId.localeCompare(b.workId)) }, null, 2) + "\n");
console.log(`Recorded ${verified.length} verified R2 deliveries.`);
