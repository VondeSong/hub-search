"""Contract tests for distribution boundaries; no heavy runtime preparation."""
import hashlib,json,pathlib,tempfile,unittest,zipfile
import memory_distribution as distribution

class RuntimeArchive(unittest.TestCase):
    def test_archive_rejects_unknown_files_duplicates_and_changed_bytes(self):
        with tempfile.TemporaryDirectory(dir=distribution.ROOT/'.local/memory-distribution') as directory:
            archive=pathlib.Path(directory)/'runtime.zip'
            payload=b'qualified bytes'
            manifest=json.dumps({'files':{'python/test.py':{'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}}}).encode()
            def pack(extra=False,changed=False):
                with zipfile.ZipFile(archive,'w') as bundle:
                    bundle.writestr('manifest.json',manifest)
                    bundle.writestr('python/test.py',b'changed bytes' if changed else payload)
                    if extra:bundle.writestr('unlisted.py',b'extra')
                return {'archiveSha256':distribution.digest(archive),'archiveBytes':archive.stat().st_size,'id':hashlib.sha256(manifest).hexdigest()}
            self.assertEqual(distribution.verify_archive(archive,pack())['id'],hashlib.sha256(manifest).hexdigest())
            with self.assertRaisesRegex(ValueError,'extra'):distribution.verify_archive(archive,pack(extra=True))
            with self.assertRaisesRegex(ValueError,'integrity'):distribution.verify_archive(archive,pack(changed=True))
            pinned=pack();archive.write_bytes(archive.read_bytes()+b'stale')
            with self.assertRaisesRegex(ValueError,'identity'):distribution.verify_archive(archive,pinned)

if __name__=='__main__':unittest.main()
