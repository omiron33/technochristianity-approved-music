# TechnoChristianity approved music

Public audio and catalog entries for songs approved in the private Music Studio. The static TechnoChristianity music page reads `approved-chapters.json` so finalized chapter songs appear in Scripture order. The local `scripts/sync-approved-music.mjs` reads Studio's authenticated API, publishes only finalized approved takes, and honors the Studio global pause. It never exports the Studio token.

Media releases are immutable. Each release has a manifest with source song ID and file hashes.

## Compressed audio delivery

Music Studio remains the authority for take approval and website/YouTube publication. The public site uses Cloudflare R2 for compressed audio and YouTube for films; WAV masters stay in private source storage. A public film URL is exported only when Studio marks its current YouTube publication verified.

1. Run `python3 scripts/prepare-r2-audio.py --work-id 'chapter:genesis:6'` for a new song, or omit `--work-id` for a batch. The script stages only Studio-approved audio, checks the selected take and source SHA-256, and encodes uncompressed masters to an MP3 delivery copy. It leaves masters unchanged and creates immutable, hash-based `audio/<song>/<hash>.mp3` keys (or `.m4a` for existing AAC files). The default staging directory is `~/Library/Application Support/Music Studio/r2-staging`; use `--staging` to select another location.
2. Upload the staged files: `node scripts/upload-r2-audio.mjs --manifest /absolute/path/to/staging/manifest.json --bucket technochristianity-audio`. The upload script checks every local hash before sending anything and sets the correct audio type. The bucket is private; `worker/audio.js` exposes only immutable audio keys over a read-only Cloudflare Worker with byte-range support. Deploy it with `npx wrangler deploy` after the bucket exists. Do not use the rate-limited `r2.dev` development URL as the production site origin.
3. Verify the public bytes and content type: `node scripts/verify-r2-delivery.mjs --manifest /absolute/path/to/staging/manifest.json --base-url https://YOUR-PUBLIC-AUDIO-DOMAIN`. This writes `media-delivery.json` only after every staged object matches its public copy and the Studio-approved take is still current.
4. Run `node scripts/sync-approved-music.mjs --write-only` to inspect the catalog, then run it without the flag to push the reviewed catalog. The sync exports an R2 URL only for a matching approved take. A new song without verified R2 delivery remains listed but has no on-site audio until delivery succeeds.
5. Deploy the site, test the exact song and film in a browser, and record fresh website evidence in Music Studio. A successful R2 upload or catalog push alone is not a verified website publication. Keep previous releases and WAV masters for provenance and future lossless access.

The global Music Studio pause is honored by both delivery verification and catalog sync. Neither script creates, approves, or changes a Suno take.
