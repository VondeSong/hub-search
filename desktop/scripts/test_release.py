"""Small synthetic checks for the release controller; never invoke a builder."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import shutil
import unittest
import uuid
import release


class ReleaseContract(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / "artifacts/performance-audit-20261011/release-script-tests"
        self.desktop = root / uuid.uuid4().hex
        self.desktop.mkdir(parents=True)
        for name in release.REQUIRED:
            path = self.desktop / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic product input", encoding="utf-8")
        for folder in release.FOLDERS:
            (self.desktop / folder).mkdir(parents=True, exist_ok=True)
        (self.desktop / "src/main.ts").write_text("synthetic source", encoding="utf-8")
        shutil.copyfile(Path(release.__file__), self.desktop / "scripts/release.py")
        self.json("package.json", {"version": "9.8.7", "scripts": {"tauri:portable": "synthetic; never executed"}})
        self.json("package-lock.json", {"version": "9.8.7", "packages": {"": {"version": "9.8.7"}}})
        self.json("src-tauri/tauri.conf.json", {"version": "9.8.7", "productName": "Synthetic Hub", "identifier": "test.synthetic.hub"})
        (self.desktop / "src-tauri/Cargo.toml").write_text('[package]\nname="synthetic-hub"\nversion="9.8.7"\n', encoding="utf-8", newline="\n")
        (self.desktop / "src-tauri/Cargo.lock").write_text('[[package]]\nname="synthetic-hub"\nversion="9.8.7"\n', encoding="utf-8")

    def json(self, name, value):
        (self.desktop / name).write_text(json.dumps(value), encoding="utf-8")

    def test_crlf_manifest_fails_before_freeze_without_mutating_source_or_creating_evidence(self):
        path = self.desktop / "src-tauri/Cargo.toml"
        before = path.read_bytes().replace(b"\n", b"\r\n")
        path.write_bytes(before)
        with self.assertRaisesRegex(ValueError, "LF line endings"):
            release.freeze(self.desktop, "invalid-line-endings")
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.desktop / "artifacts/releases").exists())

    def test_named_freeze_readonly_verify_and_mutation_rejection(self):
        frozen = release.freeze(self.desktop, "candidate")
        run = Path(frozen["run"])
        before = release.sha(run / "source-freeze.json")
        files = sorted(str(p) for p in self.desktop.rglob("*"))
        self.assertTrue(release.verify(self.desktop, run)["sourceFreezeUnchanged"])
        self.assertEqual(files, sorted(str(p) for p in self.desktop.rglob("*")))
        self.assertEqual(before, release.sha(run / "source-freeze.json"))
        with self.assertRaises(FileExistsError):
            release.freeze(self.desktop, "candidate")
        self.assertEqual(before, release.sha(run / "source-freeze.json"))
        (self.desktop / "src/new.ts").write_text("late source", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "changed"):
            release.verify(self.desktop, run)

    def test_version_disagreement_and_run_escape_fail_before_evidence_write(self):
        self.json("package-lock.json", {"version": "9.8.6", "packages": {"": {"version": "9.8.7"}}})
        with self.assertRaisesRegex(ValueError, "disagree"):
            release.freeze(self.desktop, "invalid")
        self.assertFalse((self.desktop / "artifacts/releases").exists())
        with self.assertRaisesRegex(ValueError, "direct child"):
            release.run_root(self.desktop, self.desktop / "src/foreign-run")

    def test_html_entry_and_typecheck_helpers_are_frozen(self):
        helper = self.desktop / "qa/typecheck-helper.mjs"
        helper.write_text("export const value = 1", encoding="utf-8")
        for number, path in enumerate((self.desktop / "index.html", helper)):
            original = path.read_text(encoding="utf-8")
            frozen = release.freeze(self.desktop, f"entry-{number}")
            path.write_text(original + "\nchanged", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "changed"):
                release.verify(self.desktop, Path(frozen["run"]))
            path.write_text(original, encoding="utf-8")

    def test_formal_help_and_unknown_argument_are_readonly(self):
        before = sorted(str(p) for p in self.desktop.rglob("*"))
        for extra, code in [(["--help"], 0), (["freeze", "--unexpected"], 2)]:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as result:
                release.main(["--desktop", str(self.desktop), *extra])
            self.assertEqual(result.exception.code, code)
        self.assertEqual(before, sorted(str(p) for p in self.desktop.rglob("*")))

    def test_runtime_resource_bytes_are_part_of_the_frozen_release(self):
        resource = self.desktop / '.local/runtime.zip'
        resource.parent.mkdir(parents=True)
        resource.write_bytes(b'synthetic runtime resource')
        tauri = json.loads((self.desktop / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
        tauri['bundle'] = {'resources': {'../.local/runtime.zip': 'memory-runtime.zip'}}
        self.json('src-tauri/tauri.conf.json', tauri)
        frozen = release.freeze(self.desktop, 'runtime-resource')
        resource.write_bytes(b'changed runtime resource')
        with self.assertRaisesRegex(ValueError, 'changed'):
            release.verify(self.desktop, Path(frozen['run']))

    @unittest.skipUnless(release.os.name == "nt", "Windows lease protocol")
    def test_windows_shared_output_lock_refuses_concurrent_owner(self):
        with release.windows_lock(self.desktop):
            with self.assertRaisesRegex(RuntimeError, "Another release"):
                with release.windows_lock(self.desktop):
                    self.fail("overlapping build lease")
        with release.windows_lock(self.desktop):
            pass


if __name__ == "__main__":
    unittest.main()
