import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "approved-chapters.json");
const publicMedia = "https://omiron33.github.io/technochristianity-approved-music/";
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const tokenFile = join(process.env.STUDIO_DATA_DIR || join(homedir(), "Library", "Application Support", "Music Studio"), "api-token");
const token = (await readFile(tokenFile, "utf8")).trim();
const headers = { Authorization: `Bearer ${token}` };
const get = async (path) => {
  const response = await fetch(`http://127.0.0.1:4319/api/v1${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Music Studio ${path} returned ${response.status}`);
  return response.json();
};
const studio = await get("/studio");
if (studio.settings?.paused) {
  console.log("Music Studio runner is paused; catalog sync skipped.");
  process.exit(0);
}
const label = { genesis: "Genesis", psalms: "Psalms", matthew: "Matthew" };
const publicIntros = {
  "genesis-5": "From Adam's generations to Noe's birth, this song follows the long line of lives in Genesis 5 and the hope carried through it.",
  "matthew-5": "Jesus calls his followers to be salt and light in the Sermon on the Mount.",
};
const approved = studio.works.filter((work) =>
  work.kind === "chapter" && work.audioStatus === "approved" &&
  work.sunoFinalization?.status === "verified" &&
  uuid.test(work.approvedTakeId || "") &&
  work.takes?.some((take) => take.id === work.approvedTakeId && take.approved) &&
  label[work.book] && Number.isInteger(Number(work.chapter)));
const songs = await Promise.all(approved.map(async (work) => {
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
    audio: typeof work.audioUrl === "string" && work.audioUrl.startsWith(publicMedia) ? work.audioUrl : null,
    poster: typeof work.coverUrl === "string" && work.coverUrl.startsWith(publicMedia) ? work.coverUrl : null,
    lyric: work.lyrics ? { label: "Song adaptation", text: work.lyrics } : null,
    source,
  };
}));
songs.sort((a, b) => Object.keys(label).indexOf(a.book.toLowerCase()) - Object.keys(label).indexOf(b.book.toLowerCase()) || Number(a.chapter) - Number(b.chapter));
const contents = { formatVersion: 1, songs };
const readCurrent = async () => { try { return JSON.parse(await readFile(target, "utf8")); } catch { return null; } };
const same = (a, b) => JSON.stringify(a?.songs) === JSON.stringify(b.songs) && a?.formatVersion === b.formatVersion;
if (same(await readCurrent(), contents)) {
  console.log(`Approved catalog current (${songs.length} finalized songs).`);
  process.exit(0);
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (!process.argv.includes("--write-only")) {
  if (git("status", "--porcelain", "--", "approved-chapters.json"))
    throw new Error("Catalog file has local changes; inspect before syncing.");
  if (git("diff", "--cached", "--name-only"))
    throw new Error("Asset repository has staged changes; inspect before syncing.");
  git("pull", "--ff-only", "origin", "main");
  if (same(await readCurrent(), contents)) process.exit(0);
}
await writeFile(target, JSON.stringify({ ...contents, generatedAt: new Date().toISOString() }, null, 2) + "\n");
if (!process.argv.includes("--write-only")) {
  git("add", "--", "approved-chapters.json");
  git("commit", "-m", "Sync Music Studio approved songs for public catalog");
  git("push", "origin", "HEAD:main");
}
console.log(`Published catalog with ${songs.length} finalized songs: ${songs.map((song) => song.reference).join(", ")}.`);
