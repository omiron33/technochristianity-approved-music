import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { deliveredAudio, queuedSunoFallback, verifiedYouTube } from "./media-delivery.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "approved-chapters.json");
const legacyPosterMedia = "https://omiron33.github.io/technochristianity-approved-music/";
const delivery = await readFile(join(root, "media-delivery.json"), "utf8")
  .then(JSON.parse, () => null);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const tokenFile = join(process.env.STUDIO_DATA_DIR || join(homedir(), "Library", "Application Support", "Music Studio"), "api-token");
const token = (await readFile(tokenFile, "utf8")).trim();
const headers = { Authorization: `Bearer ${token}` };
const get = async (path) => {
  const response = await fetch(`http://127.0.0.1:4319/api/v1${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Music Studio ${path} returned ${response.status}`);
  return response.json();
};
const patch = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:4319/api/v1${path}`, {
    method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Music Studio ${path} returned ${response.status}`);
};
const studio = await get("/studio");
if (studio.settings?.paused) {
  console.log("Music Studio runner is paused; catalog sync skipped.");
  process.exit(0);
}
const label = { genesis: "Genesis", judges: "Judges", psalms: "Psalms", matthew: "Matthew" };
const publicIntros = {
  "genesis-5": "From Adam's generations to Noe's birth, this song follows the long line of lives in Genesis 5 and the hope carried through it.",
  "judges-3": "A comic country-funk retelling of Ehud and Eglon in Judges 3:12–30. This is a loose adaptation, not a verse-by-verse setting.",
  "matthew-5": "Jesus calls his followers to be salt and light in the Sermon on the Mount.",
};
const approved = studio.works.filter((work) =>
  work.kind === "chapter" && work.audioStatus === "approved" &&
  (work.sunoFinalization?.status === "verified" || work.publications?.website?.status === "verified") &&
  uuid.test(work.approvedTakeId || "") &&
  work.takes?.some((take) => take.id === work.approvedTakeId && take.approved) &&
  label[work.book] && Number.isInteger(Number(work.chapter)) && Number(work.chapter) > 0);
// A current R2 copy plays here. An observed Suno download limit keeps the
// exact approved song discoverable through its Suno link until R2 is ready.
const songs = (await Promise.all(approved.map(async (work) => {
  const book = label[work.book], chapter = Number(work.chapter);
  const reference = `${book} ${chapter}`;
  const bible = await get(`/bible/${encodeURIComponent(work.book)}/${chapter}`);
  const source = bible.available && Array.isArray(bible.verses) && bible.verses.length
    ? { sourceReference: reference, verses: bible.verses.map(({ number, text }) => ({ number, text })) }
    : null;
  const title = work.title.replace(new RegExp(`\\s*[—-]\\s*${book}\\s+${chapter}$`, "i"), "").trim();
  return {
    id: `${work.book}-${chapter}`, studioId: work.id, book, chapter: String(chapter), reference,
    title: work.title, shortTitle: title,
    intro: publicIntros[`${work.book}-${chapter}`] || `A song inspired by ${reference}.`,
    suno: work.approvedTakeId,
    audio: deliveredAudio(work, delivery),
    audioSource: deliveredAudio(work, delivery) ? "cloudflare-r2" :
      queuedSunoFallback(work, delivery) ? "suno" : null,
    poster: typeof work.coverUrl === "string" && work.coverUrl.startsWith(legacyPosterMedia) ? work.coverUrl : null,
    youtube: verifiedYouTube(work),
    lyric: work.lyrics ? { label: "Song adaptation", text: work.lyrics } : null,
    source,
  };
}))).filter((song) => Boolean(song.audio || song.audioSource === "suno"));
songs.sort((a, b) => Object.keys(label).indexOf(a.book.toLowerCase()) - Object.keys(label).indexOf(b.book.toLowerCase()) || Number(a.chapter) - Number(b.chapter));
const contents = { formatVersion: 1, songs };
const readCurrent = async () => { try { return JSON.parse(await readFile(target, "utf8")); } catch { return null; } };
const same = (a, b) => JSON.stringify(a?.songs) === JSON.stringify(b.songs) && a?.formatVersion === b.formatVersion;
const writeOnly = process.argv.includes("--write-only");
const recordWebsiteHandoff = async () => {
  if (writeOnly) return;
  for (const work of approved) {
    if (!songs.some((song) => song.studioId === work.id && (song.audio || song.audioSource === "suno"))) continue;
    if (studio.jobs.some((job) => job.workId === work.id && job.stage === "website" &&
        ["queued", "awaiting_agent", "running"].includes(job.status))) continue;
    if (work.publications?.website?.status && work.publications.website.status !== "untracked") continue;
    const slug = `${work.book}-${Number(work.chapter)}`;
    await patch(`/works/${encodeURIComponent(work.id)}/publications/website`, {
      status: "submitted", url: `https://technochristianity.com/music/?work=${slug}`,
      note: songs.find((song) => song.studioId === work.id)?.audioSource === "suno"
        ? "Approved Suno link exported while download slots are exhausted; R2 delivery remains queued. Live link verification pending."
        : "Approved song with verified R2 compressed audio exported to the public catalog; live page verification pending.",
    });
  }
};
if (same(await readCurrent(), contents)) {
  await recordWebsiteHandoff();
  console.log(`Approved catalog current (${songs.length} finalized songs).`);
  process.exit(0);
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (!writeOnly) {
  if (git("status", "--porcelain", "--", "approved-chapters.json"))
    throw new Error("Catalog file has local changes; inspect before syncing.");
  if (git("diff", "--cached", "--name-only"))
    throw new Error("Asset repository has staged changes; inspect before syncing.");
  git("pull", "--ff-only", "origin", "main");
  if (same(await readCurrent(), contents)) {
    await recordWebsiteHandoff();
    process.exit(0);
  }
}
await writeFile(target, JSON.stringify({ ...contents, generatedAt: new Date().toISOString() }, null, 2) + "\n");
if (!writeOnly) {
  git("add", "--", "approved-chapters.json");
  git("commit", "-m", "Sync Music Studio approved songs for public catalog");
  git("push", "origin", "HEAD:main");
}
await recordWebsiteHandoff();
console.log(`Published catalog with ${songs.length} finalized songs: ${songs.map((song) => song.reference).join(", ")}.`);
