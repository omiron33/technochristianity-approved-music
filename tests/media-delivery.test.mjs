import assert from "node:assert/strict";
import test from "node:test";
import { deliveredAudio, queuedSunoFallback, verifiedYouTube } from "../scripts/media-delivery.mjs";

test("a prior take cannot replace the current approved recording on the public site", () => {
  const work = { id: "chapter:genesis:6", approvedTakeId: "current" };
  const delivery = { formatVersion: 1, provider: "cloudflare-r2", baseUrl: "https://media.example.com",
    objects: [{ workId: work.id, approvedTakeId: "prior", sha256: "a".repeat(64), bytes: 6000000,
      audioUrl: "https://media.example.com/audio/genesis-6/aaaaaaaaaaaaaaaa.mp3", verifiedAt: "2026-10-04T11:00:00Z" }] };
  assert.equal(deliveredAudio(work, delivery), null);
  delivery.objects[0].approvedTakeId = "current";
  assert.equal(deliveredAudio(work, delivery), delivery.objects[0].audioUrl);
});

test("verified YouTube short and watch links export a canonical film URL", () => {
  const canonical = "https://www.youtube.com/watch?v=Ri8hBJK5uSs";
  for (const url of [
    canonical,
    "https://youtube.com/watch?v=Ri8hBJK5uSs",
    "https://youtu.be/Ri8hBJK5uSs",
    "https://youtu.be/Ri8hBJK5uSs?si=share-code&t=15#fragment",
    "https://www.youtube.com/watch?feature=shared&v=Ri8hBJK5uSs&t=15",
  ]) {
    assert.equal(verifiedYouTube({ publications: { youtube: { status: "verified", url } } }), canonical, url);
  }
});

test("film links require Studio's verified current YouTube publication", () => {
  const work = { publications: { youtube: { status: "verified", url: "https://www.youtube.com/watch?v=RhDDU1YHzi0" } } };
  assert.equal(verifiedYouTube(work), work.publications.youtube.url);
  work.publications.youtube.mediaChangePending = { reason: "media_changed" };
  assert.equal(verifiedYouTube(work), null);
  delete work.publications.youtube.mediaChangePending;
  for (const status of ["requested", "publishing", "failed", "unverified", undefined]) {
    work.publications.youtube.status = status;
    assert.equal(verifiedYouTube(work), null, status);
  }
  assert.equal(verifiedYouTube({}), null);
});

test("film URL normalization rejects lookalike hosts, invalid IDs and unsupported URLs", () => {
  for (const url of [
    "https://youtu.be.evil.example/Ri8hBJK5uSs",
    "https://www.youtube.com.evil.example/watch?v=Ri8hBJK5uSs",
    "https://evil.example/watch?v=Ri8hBJK5uSs",
    "https://youtube.com@evil.example/watch?v=Ri8hBJK5uSs",
    "https://evil.example@www.youtube.com/watch?v=Ri8hBJK5uSs",
    "https://www.youtube.com:444/watch?v=Ri8hBJK5uSs",
    "http://youtu.be/Ri8hBJK5uSs",
    "https://youtu.be/short",
    "https://youtu.be/Ri8hBJK5uSsX",
    "https://youtu.be/Ri8hBJK5uSs/extra",
    "https://youtu.be/Ri8hBJK5uS!",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=Ri8hBJK5uSsX",
    "https://www.youtube.com/watch?v=Ri8hBJK5uS!",
    "https://www.youtube.com/watch?v=Ri8hBJK5uSs&v=RhDDU1YHzi0",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/embed/Ri8hBJK5uSs",
    "not a URL",
  ]) {
    assert.equal(verifiedYouTube({ publications: { youtube: { status: "verified", url } } }), null, url);
  }
});

test("only an exact approved take with observed exhausted downloads gets a Suno fallback", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const url = `https://suno.com/song/${id}`;
  const work = { id: "chapter:genesis:15", approvedTakeId: id,
    takes: [{ id, url, approved: true }],
    audioDownloadQueue: { status: "queued", approvedTakeId: id, url,
      reason: "download_limit", source: "suno_download_dialog", observedAt: "2026-10-09T10:00:00Z" } };
  assert.equal(queuedSunoFallback(work, null), url);
  work.audioDownloadQueue.approvedTakeId = "another-take";
  assert.equal(queuedSunoFallback(work, null), null);
  work.audioDownloadQueue.approvedTakeId = id;
  work.audioDownloadQueue.status = "delivered";
  assert.equal(queuedSunoFallback(work, null), null);
  work.audioDownloadQueue.status = "retrying";
  assert.equal(queuedSunoFallback(work, null), url);
});
