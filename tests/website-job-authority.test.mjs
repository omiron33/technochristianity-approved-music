import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authorizeWebsiteJob, assertWebsiteManifest, mergeWebsiteDelivery, mergeWebsiteCatalog } from "../scripts/website-job-authority.mjs";

const run = promisify(execFile);
const id = "11111111-1111-4111-8111-111111111111";
const takeId = "22222222-2222-4222-8222-222222222222";
const workId = "chapter:genesis:13";
const work = { id: workId, kind: "chapter", book: "genesis", chapter: 13,
  title: "The Land Before You - Genesis 13", audioStatus: "approved", approvedTakeId: takeId,
  artifactVersion: "current-fingerprint", sunoFinalization: { status: "verified" },
  takes: [{ id: takeId, url: `https://suno.com/song/${takeId}`, approved: true }], publications: {} };
const job = { id, stage: "website", status: "running", workId, workerId: `mac-publication-${id}`,
  claimToken: "valid-test-claim", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  workFingerprint: work.artifactVersion, snapshot: structuredClone(work),
  payload: { directIntent: true, websiteDelivery: true, onDemandPublication: true,
    approvedTakeId: takeId, sunoUrl: work.takes[0].url } };

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "website-job-authority-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const dir = join(dataDir, "publication-dispatch", id);
  await mkdir(dir, { recursive: true });
  const claimPath = join(dir, "claim.json");
  await writeFile(claimPath, JSON.stringify({ workerId: job.workerId, claimToken: job.claimToken }), { mode: 0o600 });
  const state = { job: structuredClone(job), work: structuredClone(work) };
  const get = async (url) => url === `/jobs/${id}` ? state.job :
    url === `/works/${encodeURIComponent(workId)}` ? state.work : assert.fail(url);
  return { dataDir, claimPath, state, get };
}

test("only the private exact live claim authorizes a paused one-work delivery", async (t) => {
  const f = await fixture(t);
  const authorized = await authorizeWebsiteJob({ jobId: id, workId, dataDir: f.dataDir, get: f.get });
  assert.equal(authorized.workId, workId);
  assert.equal(authorized.approvedTakeId, takeId);
  f.state.job.status = "cancelled";
  await assert.rejects(authorized.revalidate(), /not authorized/);
});

test("owner, lease, identity, approval and explicit intent cannot be forged or reused", async (t) => {
  const f = await fixture(t);
  const cases = [
    (s) => { s.job.claimToken = "another-claim"; },
    (s) => { s.job.workerId = "another-worker"; },
    (s) => { s.job.leaseExpiresAt = new Date(0).toISOString(); },
    (s) => { s.job.status = "needs_attention"; },
    (s) => { s.job.uncertain = true; },
    (s) => { s.job.stage = "suno_finalize"; },
    (s) => { s.job.payload.directIntent = false; },
    (s) => { s.job.payload.websiteDelivery = false; },
    (s) => { s.job.payload.onDemandPublication = false; },
    (s) => { s.job.payload.approvedTakeId = id; },
    (s) => { s.job.snapshot.approvedTakeId = id; },
    (s) => { s.job.workFingerprint = "stale"; },
    (s) => { s.work.takes[0].approved = false; },
    (s) => { s.work.takes[0].url = `https://suno.com/song/${id}`; },
    (s) => { s.work.audioStatus = "review"; },
    (s) => { s.work.mergedInto = "other-work"; },
  ];
  for (const mutate of cases) {
    f.state.job = structuredClone(job);
    f.state.work = structuredClone(work);
    mutate(f.state);
    await assert.rejects(authorizeWebsiteJob({ jobId: id, dataDir: f.dataDir, get: f.get }), /not authorized/);
  }
  f.state.job = structuredClone(job);
  f.state.work = structuredClone(work);
  await assert.rejects(authorizeWebsiteJob({ jobId: id, workId: "chapter:genesis:19",
    dataDir: f.dataDir, get: f.get }), /not authorized/);
  await chmod(f.claimPath, 0o644);
  await assert.rejects(authorizeWebsiteJob({ jobId: id, dataDir: f.dataDir, get: f.get }), /not authorized/);
});

test("scoped merge retains unrelated rows and inserts only the authorized current take", () => {
  const unrelated = [
    { id: "genesis-12", studioId: "legacy-12", book: "Genesis", chapter: "12", custom: "keep", audio: "old-audio" },
    { id: "genesis-19", studioId: "legacy-19", book: "Genesis", chapter: "19", custom: { evidence: "keep" } },
  ];
  const current = { formatVersion: 1, custom: "keep", songs: unrelated };
  const song = { id: "genesis-13", studioId: workId, book: "Genesis", chapter: "13", suno: takeId, audio: "new-audio" };
  const merged = mergeWebsiteCatalog(current, [song], work);
  assert.deepEqual(merged.songs, [unrelated[0], song, unrelated[1]]);
  assert.deepEqual(current.songs, unrelated);
  assert.equal(merged.custom, "keep");
  assert.throws(() => mergeWebsiteCatalog(current, [], work), /one delivered/);
  assert.throws(() => mergeWebsiteCatalog(current, [{ ...song, suno: id }], work), /one delivered/);
  assert.throws(() => mergeWebsiteCatalog({ ...current, songs: [...unrelated, { ...song, studioId: "another" }] }, [song], work), /conflicting/);
});

test("a scoped delivery cannot verify a wider batch or another take", () => {
  const authority = { workId, approvedTakeId: takeId };
  const selected = { workId, approvedTakeId: takeId };
  assertWebsiteManifest(authority, { objects: [selected] });
  for (const objects of [[], [selected, selected], [{ ...selected, workId: "another" }],
    [{ ...selected, approvedTakeId: id }]])
    assert.throws(() => assertWebsiteManifest(authority, { objects }), /only its claimed chapter/);
});

test("scoped R2 receipts retain unrelated history and reject missing or different-origin manifests", () => {
  const authority = { workId, approvedTakeId: takeId };
  const baseUrl = "https://media.example.com";
  const unrelated = { workId: "chapter:genesis:19", approvedTakeId: id, evidence: { keep: true } };
  const current = { formatVersion: 1, provider: "cloudflare-r2", baseUrl, metadata: "keep",
    objects: [unrelated, { workId, approvedTakeId: "prior" }] };
  const receipt = { workId, approvedTakeId: takeId, sha256: "a".repeat(64) };
  const changed = mergeWebsiteDelivery(current, baseUrl, [receipt], authority);
  assert.deepEqual(changed.objects, [unrelated, receipt]);
  assert.equal(changed.metadata, "keep");
  assert.equal(current.objects[1].approvedTakeId, "prior");
  for (const prior of [null, {}, { ...current, baseUrl: "https://other.example.com" },
    { ...current, provider: "other" }, { ...current, objects: [unrelated, null] }])
    assert.throws(() => mergeWebsiteDelivery(prior, baseUrl, [receipt], authority), /valid existing/);
});

test("paused scoped catalog sync writes one current chapter and never records unrelated handoffs", async (t) => {
  const f = await fixture(t);
  const repo = join(f.dataDir, "asset-repo");
  await mkdir(repo);
  await cp(new URL("../scripts", import.meta.url), join(repo, "scripts"), { recursive: true });
  await writeFile(join(f.dataDir, "api-token"), "test-token");
  const existing = { formatVersion: 1, songs: [{ id: "genesis-19", studioId: "unrelated",
    book: "Genesis", chapter: "19", suno: id, audio: "retain-without-import", custom: "retain" }] };
  const catalogPath = join(repo, "approved-chapters.json");
  await writeFile(catalogPath, JSON.stringify(existing));
  await writeFile(join(repo, "media-delivery.json"), JSON.stringify({ formatVersion: 1, provider: "cloudflare-r2",
    baseUrl: "https://media.example.com", objects: [{ workId, approvedTakeId: takeId,
      sha256: "a".repeat(64), bytes: 100, verifiedAt: new Date().toISOString(),
      audioUrl: "https://media.example.com/audio/genesis-13/aaaaaaaaaaaaaaaa.mp3" }] }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    assert.equal(req.headers.authorization, "Bearer test-token");
    const body = req.url === "/api/v1/studio" ? { settings: { paused: true }, works: [f.state.work], jobs: [f.state.job] } :
      req.url === `/api/v1/jobs/${id}` ? f.state.job :
      req.url === `/api/v1/works/${encodeURIComponent(workId)}` ? f.state.work :
      req.url === "/api/v1/bible/genesis/13" ? { available: true, verses: [{ number: 1, text: "Test source." }] } : null;
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const env = { ...process.env, STUDIO_DATA_DIR: f.dataDir, STUDIO_ORIGIN: `http://127.0.0.1:${server.address().port}` };
  const script = join(repo, "scripts/sync-approved-music.mjs");
  await run(process.execPath, [script, "--write-only"], { env });
  assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), existing);
  await run(process.execPath, [script, "--write-only", "--website-job", id], { env });
  const changed = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(changed.songs.length, 2);
  assert.equal(changed.songs[0].studioId, workId);
  assert.equal(changed.songs[0].suno, takeId);
  assert.deepEqual(changed.songs[1], existing.songs[0]);
  assert.ok(requests.every((entry) => entry.method === "GET"));
  const source = join(f.dataDir, "approved.wav");
  const audio = Buffer.alloc(44 + 22050 * 2);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(22050, 24); audio.writeUInt32LE(44100, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  await writeFile(source, audio);
  const prepare = join(repo, "scripts/prepare-r2-audio.py");
  const staging = join(f.dataDir, "staging");
  const prepareArgs = [prepare, "--work-id", workId, "--source-wav", source, "--staging", staging];
  await assert.rejects(run("python3", prepareArgs, { env }), /global runner is paused/);
  await run("python3", [...prepareArgs, "--website-job", id], { env });
  const staged = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
  assert.equal(staged.objects.length, 1);
  assert.equal(staged.objects[0].approvedTakeId, takeId);
  f.state.job.status = "cancelled";
  await assert.rejects(run(process.execPath, [script, "--write-only", "--website-job", id], { env }), /not authorized/);
  assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), changed);
});
