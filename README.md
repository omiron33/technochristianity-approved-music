# TechnoChristianity approved music

Public audio and catalog entries for songs approved in the private Music Studio. The static TechnoChristianity music page reads `approved-chapters.json` so finalized chapter songs appear in Scripture order. The local `scripts/sync-approved-music.mjs` reads Studio's authenticated API, publishes only finalized approved takes, and honors the Studio global pause. It never exports the Studio token.

Media releases are immutable. Each release has a manifest with source song ID and file hashes.
