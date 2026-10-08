import hashlib
import http.server
import json
import os
import subprocess
import tempfile
import threading
import unittest
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAKE_ID = "11111111-1111-4111-8111-111111111111"


class StudioHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/api/v1/studio":
            self.send_error(404)
            return
        body = json.dumps({"settings": {"paused": False}, "works": [{
            "id": "chapter:genesis:11", "kind": "chapter", "book": "genesis", "chapter": 11,
            "title": "Tower of Babel", "audioStatus": "approved", "approvedTakeId": TAKE_ID,
            "sunoFinalization": {"status": "verified"},
            "takes": [{"id": TAKE_ID, "approved": True}],
        }]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class PrepareR2AudioTest(unittest.TestCase):
    def test_local_wav_is_preserved_and_only_mp3_is_staged_for_r2(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            data = home / "studio"
            data.mkdir()
            (data / "api-token").write_text("test-token")
            source = home / "approved.wav"
            with wave.open(str(source), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(22050)
                output.writeframes(b"\0\0" * 22050)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StudioHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                staging = home / "staging"
                environment = {**os.environ, "STUDIO_DATA_DIR": str(data),
                               "STUDIO_ORIGIN": f"http://127.0.0.1:{server.server_port}"}
                subprocess.run(["python3", str(ROOT / "scripts/prepare-r2-audio.py"),
                                "--work-id", "chapter:genesis:11", "--source-wav", str(source),
                                "--staging", str(staging)], env=environment, check=True,
                               capture_output=True, text=True)
                manifest = json.loads((staging / "manifest.json").read_text())
                self.assertEqual(len(manifest["objects"]), 1)
                item = manifest["objects"][0]
                self.assertEqual(item["approvedTakeId"], TAKE_ID)
                self.assertEqual(item["sourceSha256"], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertEqual(item["contentType"], "audio/mpeg")
                self.assertTrue((staging / item["key"]).is_file())
                self.assertFalse((staging / "masters").exists())
                masters = list((data / "suno-wav-masters").glob("*.wav"))
                self.assertEqual(len(masters), 1)
                self.assertEqual(masters[0].read_bytes(), source.read_bytes())
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
