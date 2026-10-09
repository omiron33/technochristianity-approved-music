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

test("film links require Studio's verified current YouTube publication", () => {
  const work = { publications: { youtube: { status: "verified", url: "https://www.youtube.com/watch?v=RhDDU1YHzi0" } } };
  assert.equal(verifiedYouTube(work), work.publications.youtube.url);
  work.publications.youtube.mediaChangePending = { reason: "media_changed" };
  assert.equal(verifiedYouTube(work), null);
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
