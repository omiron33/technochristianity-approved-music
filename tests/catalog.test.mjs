import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { deliveredAudio } from "../scripts/media-delivery.mjs";

const catalog = JSON.parse(readFileSync(new URL("../approved-chapters.json", import.meta.url)));
const delivery = JSON.parse(readFileSync(new URL("../media-delivery.json", import.meta.url)));

test("every public song has verified R2 audio or an exact Suno link fallback", () => {
  assert.ok(catalog.songs.length > 0);
  for (const song of catalog.songs) {
    if (song.audioSource === "suno") {
      assert.equal(song.audio, null, song.id);
      assert.match(song.suno, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i, song.id);
    } else {
      assert.equal(song.audio, deliveredAudio({ id: song.studioId, approvedTakeId: song.suno }, delivery), song.id);
      assert.ok(song.audio, song.id);
    }
  }
});
