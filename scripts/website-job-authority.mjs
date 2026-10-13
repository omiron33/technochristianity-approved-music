#!/usr/bin/env node
// A paused runner permits only the exact website delivery already claimed by Studio.
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = () => new Error("The exact current claimed website delivery is not authorized.");
const sameSecret = (a, b) => typeof a === "string" && typeof b === "string" &&
  a.length > 0 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const studioDataDir = () => process.env.STUDIO_DATA_DIR ||
  join(homedir(), "Library", "Application Support", "Music Studio");

export async function studioReader(dataDir = studioDataDir()) {
  const token = (await readFile(join(dataDir, "api-token"), "utf8")).trim();
  const origin = process.env.STUDIO_ORIGIN || "http://127.0.0.1:4319";
  return async (suffix) => {
    const response = await fetch(origin + "/api/v1" + suffix, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Music Studio read failed (${response.status}).`);
    return response.json();
  };
}

async function privateClaim(dataDir, jobId) {
  const base = await realpath(dataDir);
  const claimPath = join(base, "publication-dispatch", jobId, "claim.json");
  if (await realpath(claimPath) !== claimPath) throw fail();
  const file = await open(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077)) throw fail();
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function authorizeWebsiteJob({ jobId, workId, approvedTakeId, artifactVersion,
  dataDir = studioDataDir(), get, now = Date.now }) {
  if (!uuid.test(jobId || "") || typeof get !== "function") throw fail();
  const claim = await privateClaim(dataDir, jobId);
  const job = await get(`/jobs/${jobId}`);
  if (job.id !== jobId || job.stage !== "website" || job.status !== "running" || job.uncertain ||
      job.workerId !== `mac-publication-${jobId}` || claim.workerId !== job.workerId ||
      !sameSecret(claim.claimToken, job.claimToken) ||
      !(Date.parse(job.leaseExpiresAt) > now()) ||
      job.payload?.websiteDelivery !== true || job.payload?.directIntent !== true ||
      job.payload?.onDemandPublication !== true || (workId && job.workId !== workId)) throw fail();
  const work = await get(`/works/${encodeURIComponent(job.workId)}`);
  const take = work.takes?.find((entry) => entry.id === work.approvedTakeId && entry.approved);
  if (work.id !== job.workId || work.mergedInto || work.kind !== "chapter" ||
      work.audioStatus !== "approved" || !uuid.test(take?.id || "") ||
      take.url !== `https://suno.com/song/${take.id}` ||
      job.payload.approvedTakeId !== take.id || job.payload.sunoUrl !== take.url ||
      job.snapshot?.approvedTakeId !== take.id ||
      !job.snapshot?.takes?.some((entry) => entry.id === take.id && entry.approved && entry.url === take.url) ||
      !work.artifactVersion || job.workFingerprint !== work.artifactVersion ||
      (approvedTakeId && approvedTakeId !== take.id) ||
      (artifactVersion && artifactVersion !== work.artifactVersion)) throw fail();
  const options = { jobId, workId: work.id, approvedTakeId: take.id,
    artifactVersion: work.artifactVersion, dataDir, get, now };
  return { jobId, workId: work.id, approvedTakeId: take.id, work,
    revalidate: () => authorizeWebsiteJob(options) };
}

export function assertWebsiteManifest(authority, staged) {
  if (authority && (staged.objects?.length !== 1 || staged.objects[0].workId !== authority.workId ||
      staged.objects[0].approvedTakeId !== authority.approvedTakeId))
    throw new Error("Scoped R2 verification accepts only its claimed chapter.");
}

export function mergeWebsiteDelivery(current, baseUrl, verified, authority) {
  assertWebsiteManifest(authority, { objects: verified });
  if (current?.formatVersion !== 1 || current.provider !== "cloudflare-r2" ||
      current.baseUrl !== baseUrl || !Array.isArray(current.objects) ||
      current.objects.some((entry) => !entry || typeof entry.workId !== "string") ||
      current.objects.filter((entry) => entry.workId === authority.workId).length > 1)
    throw new Error("Scoped verification needs the valid existing R2 delivery manifest for this origin.");
  const objects = [...current.objects];
  const existing = objects.findIndex((entry) => entry.workId === authority.workId);
  if (existing >= 0) objects[existing] = verified[0];
  else objects.push(verified[0]);
  return { ...current, objects };
}

// Preserve every unrelated catalog entry, including data absent from current Studio imports.
export function mergeWebsiteCatalog(current, songs, work) {
  if (current?.formatVersion !== 1 || !Array.isArray(current.songs) || songs.length !== 1 ||
      songs[0].studioId !== work.id || songs[0].suno !== work.approvedTakeId ||
      songs[0].id !== `${work.book}-${Number(work.chapter)}`) throw new Error("Scoped sync needs one delivered current chapter and an existing catalog.");
  const song = songs[0];
  if (current.songs.some((entry) => entry.id === song.id && entry.studioId !== work.id) ||
      current.songs.filter((entry) => entry.studioId === work.id).length > 1)
    throw new Error("The current catalog has a conflicting chapter identity.");
  const existing = current.songs.findIndex((entry) => entry.studioId === work.id);
  const merged = [...current.songs];
  if (existing >= 0) merged[existing] = song;
  else {
    const books = ["genesis", "judges", "psalms", "matthew"];
    const order = (entry) => [books.indexOf(String(entry.book).toLowerCase()), Number(entry.chapter)];
    const [book, chapter] = order(song);
    const next = merged.findIndex((entry) => {
      const [otherBook, otherChapter] = order(entry);
      return otherBook >= 0 && (otherBook > book || (otherBook === book && otherChapter > chapter));
    });
    merged.splice(next < 0 ? merged.length : next, 0, song);
  }
  return { ...current, songs: merged };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (flag) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
  const authority = await authorizeWebsiteJob({ jobId: value("--website-job"), workId: value("--work-id"),
    approvedTakeId: value("--take-id"), artifactVersion: value("--artifact-version"),
    get: await studioReader() });
  console.log(JSON.stringify({ jobId: authority.jobId, workId: authority.workId,
    approvedTakeId: authority.approvedTakeId }));
}
