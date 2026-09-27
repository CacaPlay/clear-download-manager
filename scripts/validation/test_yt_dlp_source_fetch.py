import hashlib
import importlib.util
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.request import Request


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
FETCHER_PATH = ROOT / "scripts/fetch-yt-dlp-corresponding-source-inputs.py"
if FETCHER_PATH.is_file():
    spec = importlib.util.spec_from_file_location("fetch_yt_dlp_corresponding_source_inputs", FETCHER_PATH)
    fetcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fetcher)
else:
    fetcher = None


MANIFEST = ROOT / "third-party-source/reviews/yt-dlp-2026.08.19-win64-download-inputs.json"


class FakeResponse:
    def __init__(self, content: bytes, final_url: str):
        self.content = content
        self.final_url = final_url
        self.offset = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self.content) - self.offset
        block = self.content[self.offset : self.offset + size]
        self.offset += len(block)
        return block

    def geturl(self) -> str:
        return self.final_url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeOpener:
    def __init__(self, response: FakeResponse):
        self.response = response

    def open(self, _request, timeout=None):
        return self.response


class YtDlpSourceFetchTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(fetcher, "pinned corresponding-source fetcher is not implemented")

    def test_manifest_pins_all_assembler_inputs_and_official_pyinstaller_release(self):
        manifest = fetcher.load_manifest(MANIFEST, ROOT)
        entries = {entry["path"]: entry for entry in manifest["inputs"]}

        assembler = runpy.run_path(str(ROOT / "scripts/assemble-yt-dlp-corresponding-source.py"))
        self.assertTrue(set(assembler["PINNED_INPUT_HASHES"]).issubset(entries))
        for path, expected_hash in assembler["PINNED_INPUT_HASHES"].items():
            self.assertEqual(entries[path]["sha256"], expected_hash, path)
        zlib = entries["native/dependencies/zlib-1.3.1.tar.gz"]
        self.assertEqual(zlib["url"], "https://zlib.net/fossils/zlib-1.3.1.tar.gz")
        self.assertEqual(zlib["bytes"], 1512791)
        wheel = entries["build-wheels/pyinstaller-6.22.0-py3-none-win_amd64.whl"]
        self.assertEqual(wheel["url"], "https://github.com/yt-dlp/Pyinstaller-Builds/releases/download/2026.08.19.215425/pyinstaller-6.22.0-py3-none-win_amd64.whl")
        self.assertEqual(wheel["bytes"], 1101025)
        self.assertEqual(wheel["sha256"], "294099ecb5fdd2a13ae4c29006d4e335b697a63b6a16cf052b90ec2b40bef05a")

        pyinstaller_source = entries["verification-only/pyinstaller-6.22.0.tar.gz"]
        self.assertEqual(pyinstaller_source["url"], "https://github.com/yt-dlp/Pyinstaller-Builds/releases/download/2026.08.19.215425/pyinstaller-6.22.0.tar.gz")
        self.assertEqual(pyinstaller_source["bytes"], 3527013)
        self.assertEqual(pyinstaller_source["sha256"], "2fadbed5d951d53f003ed899312823a07dbba59990a223cbe538933e1c42a168")
        self.assertEqual(pyinstaller_source["sourceCommit"], "70fc17210920bce17f4ab09bbf8104b0dbd45338")
        self.assertEqual(len(manifest["inputs"]), 40)

        inventory = json.loads((ROOT / manifest["sourceDistributionInventory"]["sourcePath"]).read_text(encoding="utf-8"))
        self.assertEqual(len(inventory["packages"]), 21)
        self.assertEqual(manifest["sourceDistributionInventory"]["sha256"], "8b0c6b75efe58709558ab7631eae3e981bccf72962df8005a67526b395fab294")

    def test_http_sources_are_rejected(self):
        with self.assertRaises(fetcher.FetchError):
            fetcher.validate_entry({"path": "upstream/source.tgz", "url": "http://example.test/source.tgz", "bytes": 1, "sha256": "0" * 64})

    def test_paths_cannot_escape_staging_directory(self):
        with self.assertRaises(fetcher.FetchError):
            fetcher.validate_entry({"path": "../escape.tgz", "url": "https://example.test/source.tgz", "bytes": 1, "sha256": "0" * 64})

    def test_wrong_size_or_hash_is_rejected(self):
        content = b"expected bytes"
        entry = {"path": "upstream/source.tgz", "url": "https://example.test/source.tgz", "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "source.tgz"
            file.write_bytes(content + b"!")
            with self.assertRaises(fetcher.FetchError):
                fetcher.verify_file(file, entry)
            file.write_bytes(content)
            fetcher.verify_file(file, entry)

    def test_redirects_must_remain_https_and_on_the_allowlist(self):
        handler = fetcher.RestrictedRedirectHandler({"objects.githubusercontent.com"})
        request = Request("https://github.com/owner/repo/archive.tar.gz")
        self.assertIsNotNone(handler.redirect_request(request, None, 302, "Found", {}, "https://objects.githubusercontent.com/archive"))
        for target in ("http://objects.githubusercontent.com/archive", "https://attacker.test/archive"):
            with self.subTest(target=target), self.assertRaises(fetcher.FetchError):
                handler.redirect_request(request, None, 302, "Found", {}, target)

    def test_download_verifies_before_atomic_placement(self):
        content = b"verified corresponding source input"
        entry = {"path": "upstream/source.tgz", "url": "https://example.test/source.tgz", "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "allowedRedirectHosts": []}
        with tempfile.TemporaryDirectory() as directory:
            target = fetcher.download_entry(entry, Path(directory), FakeOpener(FakeResponse(content, entry["url"])))
            self.assertEqual(target.read_bytes(), content)
            self.assertFalse(target.with_name(target.name + ".partial").exists())

    def test_failed_download_leaves_no_final_or_partial_file(self):
        content = b"wrong source input"
        entry = {"path": "upstream/source.tgz", "url": "https://example.test/source.tgz", "bytes": len(content) + 1, "sha256": hashlib.sha256(content).hexdigest(), "allowedRedirectHosts": []}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(fetcher.FetchError):
                fetcher.download_entry(entry, Path(directory), FakeOpener(FakeResponse(content, entry["url"])))
            self.assertFalse((Path(directory) / entry["path"]).exists())
            self.assertFalse((Path(directory) / entry["path"]).with_name("source.tgz.partial").exists())


if __name__ == "__main__":
    unittest.main()
