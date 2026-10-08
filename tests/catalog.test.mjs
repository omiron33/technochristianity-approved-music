import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { deliveredAudio } from "../scripts/media-delivery.mjs";

const catalog = JSON.parse(readFileSync(new URL("../approved-chapters.json", import.meta.url)));
const delivery = JSON.parse(readFileSync(new URL("../media-delivery.json", import.meta.url)));

test("every public song uses the verified R2 copy of its approved take", () => {
  assert.ok(catalog.songs.length > 0);
  for (const song of catalog.songs) {
    assert.equal(song.audio, deliveredAudio({ id: song.studioId, approvedTakeId: song.suno }, delivery), song.id);
    assert.ok(song.audio, song.id);
  }
});
