#!/usr/bin/env node
// One chapter delivery, invoked by the one-shot local website publication agent.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const option = (flag) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null;
const workId = option("--work-id");
let sourceWav = option("--source-wav");
const sourceReceipt = option("--source-receipt");
const receiptOut = option("--receipt-out");
const statusOnly = process.argv.includes("--status");
if (!workId || !/^[a-z0-9:-]+$/.test(workId) || (statusOnly && (sourceWav || sourceReceipt)) ||
    (sourceWav && sourceReceipt))
  throw new Error("Usage: node scripts/ensure-r2-chapter.mjs --work-id chapter:genesis:11 [--status | --source-wav /absolute/export.wav | --source-receipt /absolute/export.json] [--receipt-out /absolute/receipt.json]");
if (sourceWav && !sourceWav.startsWith("/")) throw new Error("--source-wav needs an absolute path.");
if (sourceReceipt && !sourceReceipt.startsWith("/")) throw new Error("--source-receipt needs an absolute path.");
if (receiptOut && !receiptOut.startsWith("/")) throw new Error("--receipt-out needs an absolute path.");

const dataDir = process.env.STUDIO_DATA_DIR || join(homedir(), "Library", "Application Support", "Music Studio");
const token = (await readFile(join(dataDir, "api-token"), "utf8")).trim();
const response = await fetch("http://127.0.0.1:4319/api/v1/works/" + encodeURIComponent(workId), {
  headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Music Studio returned ${response.status} for ${workId}.`);
const work = await response.json();
const take = work.takes?.find((item) => item.id === work.approvedTakeId && item.approved);
if (work.kind !== "chapter" || work.audioStatus !== "approved" || !take ||
    take.url !== `https://suno.com/song/${take.id}`)
  throw new Error("Website delivery needs the exact current approved Suno chapter take.");
if (work.sunoFinalization?.status !== "verified" && work.publications?.website?.status !== "verified")
  throw new Error("Finish Suno finalization for this approved chapter before website delivery.");
if (sourceReceipt) {
  const exportRecord = JSON.parse(await readFile(sourceReceipt, "utf8"));
  if (exportRecord.songId !== take.id || !exportRecord.sourceWav?.startsWith("/") ||
      !/^[a-f0-9]{64}$/.test(exportRecord.sha256 || "") ||
      !(exportRecord.bytes > 1_000_000) || !(exportRecord.durationSeconds > 10) ||
      !Number.isFinite(Date.parse(exportRecord.observedAt)) ||
      (take.durationSeconds > 0 && Math.abs(exportRecord.durationSeconds - take.durationSeconds) > 5))
    throw new Error("The Suno export receipt does not match the current approved take.");
  const file = await stat(exportRecord.sourceWav);
  if (!file.isFile() || file.size !== exportRecord.bytes ||
      createHash("sha256").update(await readFile(exportRecord.sourceWav)).digest("hex") !== exportRecord.sha256)
    throw new Error("The fresh Suno WAV differs from its browser export receipt.");
  sourceWav = exportRecord.sourceWav;
}

const manifestPath = join(root, "media-delivery.json");
const baseUrl = "https://technochristianity-audio.sjfisher33.workers.dev";
const bucket = "technochristianity-audio";
const readManifest = async () => JSON.parse(await readFile(manifestPath, "utf8"));
const currentItem = async () => {
  const manifest = await readManifest();
  return manifest.baseUrl === baseUrl && manifest.provider === "cloudflare-r2"
    ? manifest.objects?.find((item) => item.workId === work.id && item.approvedTakeId === take.id)
    : null;
};
const publicBytesMatch = async (item) => {
  if (!item?.audioUrl?.startsWith(baseUrl + "/audio/") || !/^[a-f0-9]{64}$/.test(item.sha256 || ""))
    return false;
  try {
    const served = await fetch(item.audioUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!served.ok || served.headers.get("content-type")?.split(";")[0] !== item.contentType) return false;
    const bytes = Buffer.from(await served.arrayBuffer());
    return bytes.length === item.bytes && createHash("sha256").update(bytes).digest("hex") === item.sha256;
  } catch { return false; }
};
const receipt = (item) => ({ provider: "cloudflare-r2", url: item.audioUrl,
  sha256: item.sha256, approvedTakeId: item.approvedTakeId, verifiedAt: item.verifiedAt });
const saveReceipt = async (item) => {
  if (receiptOut) await writeFile(receiptOut, JSON.stringify(receipt(item), null, 2) + "\n", { flag: "wx", mode: 0o600 });
};
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", timeout: 300_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.error?.message || result.status}).`);
};

const changed = spawnSync("git", ["status", "--porcelain", "--", "media-delivery.json", "approved-chapters.json"],
  { cwd: root, encoding: "utf8" });
if (changed.status !== 0 || changed.stdout.trim())
  throw new Error("The audio delivery manifest or catalog has local changes. Reconcile them before another publication.");
run("git", ["pull", "--ff-only", "origin", "main"]);

let item = await currentItem();
if (item && await publicBytesMatch(item)) {
  await saveReceipt(item);
  console.log(`R2 delivery already verified for ${workId} (${take.id}).`);
} else if (statusOnly || !sourceWav) {
  console.log(`NEEDS_SUNO_WAV ${workId} ${take.url}`);
  process.exitCode = 3;
} else {
  const staging = join(dataDir, "r2-staging");
  run("python3", ["scripts/prepare-r2-audio.py", "--work-id", workId,
    "--source-wav", sourceWav, "--staging", staging]);
  const staged = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
  if (staged.objects?.length !== 1 || staged.objects[0].workId !== workId ||
      staged.objects[0].approvedTakeId !== take.id ||
      staged.objects[0].sourceCodec?.startsWith("pcm_") !== true)
    throw new Error("The staged Suno WAV does not belong to the requested approved take.");
  run(process.execPath, ["scripts/upload-r2-audio.mjs", "--manifest", join(staging, "manifest.json"), "--bucket", bucket]);
  run(process.execPath, ["scripts/verify-r2-delivery.mjs", "--manifest", join(staging, "manifest.json"),
    "--base-url", baseUrl]);
  item = await currentItem();
  if (!item || item.approvedTakeId !== take.id || !(await publicBytesMatch(item)))
    throw new Error("The current approved take does not have a verified R2 delivery.");
  // Keep the approved WAV in Music Studio's private local masters directory.
  run("git", ["add", "--", "media-delivery.json"]);
  run("git", ["commit", "-m", `Record verified R2 audio for ${work.book} ${work.chapter}`]);
  run("git", ["push", "origin", "HEAD:main"]);
  await saveReceipt(item);
  console.log(`Verified local WAV master and public audio in R2 for ${workId}.`);
}

if (item && !statusOnly) {
  run(process.execPath, ["scripts/sync-approved-music.mjs"]);
  const slug = `${work.book}-${Number(work.chapter)}`;
  let live = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const feed = await fetch("https://omiron33.github.io/technochristianity-approved-music/approved-chapters.json",
        { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (feed.ok) {
        const catalog = await feed.json();
        live = catalog.songs?.some((song) => song.id === slug && song.audio === item.audioUrl);
      }
    } catch { /* GitHub Pages may still be updating. */ }
    if (live) break;
    await new Promise((done) => setTimeout(done, 15_000));
  }
  if (!live) throw new Error("The R2 audio is verified, but the live chapter catalog has not caught up.");
  console.log(`Live chapter catalog includes ${slug} with its verified R2 audio.`);
}
