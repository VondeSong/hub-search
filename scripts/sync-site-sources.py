#!/usr/bin/env python3
"""Import committed Sites source snapshots and verify them, without network access."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from datetime import datetime, timezone
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ".source-snapshot.json"
SITES = {
    "mobile": ("hub-mobile-lab", "appgprj_6af1d2dc12308191acc37e5566699c2d",
               "https://hub-mobile-lab-von11.song02211368537057.chatgpt.site"),
    "workspace": ("hub-workspace", "appgprj_6aeffedbff408191858a4bbb6643e4f6",
                  "https://hub-workspace-von11.song02211368537057.chatgpt.site"),
    "taskflow": ("hub-task-flow-lab", "appgprj_6af7b8ca80448191ac76b1a03eaa73dd",
                 "https://hub-task-flow-lab-von11.song02211368537057.chatgpt.site"),
}
CACHES = {".git", "node_modules", "__pycache__", ".next", ".vinext",
          ".wrangler", ".sites-runtime", ".pnpm-store", ".cache", ".venv"}
SECRET_NAMES = {"credentials.json", "auth.json", "tokens.json", "secrets.json"}
SECRET_CONTENT = re.compile(
    rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|"
    rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|"
    rb"sk-proj-[A-Za-z0-9_-]{30,})\b"
)


def fail(message):
    raise ValueError(message)


def git(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args], capture_output=True)
    if result.returncode:
        fail("Git source read failed: " + " ".join(args[:2]))
    return result.stdout


def safe_path(name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or ".." in path.parts
            or str(path) != name or "\\" in name):
        fail(f"Unsafe snapshot path: {name!r}")
    return path


def check_source_path(name, site):
    path = safe_path(name)
    if any(part in CACHES for part in path.parts):
        fail(f"Tracked cache or Git metadata must be removed at source: {name}")
    lower = path.name.lower()
    is_example = lower.endswith((".example", ".sample", ".template"))
    if ((lower.startswith((".env", ".dev.vars")) and not is_example)
            or lower in SECRET_NAMES
            or lower.endswith((".pem", ".key", ".p12", ".pfx", ".keystore"))):
        fail(f"Potential credential file requires review at source: {name}")
    if site == "workspace" and path.parts[0] in {"dist", "out", "build"}:
        fail(f"Generated workspace output must not enter the source snapshot: {name}")


def destination(site):
    root = ROOT / "sites" / SITES[site][0]
    for path in (ROOT / "sites", root):
        if path.is_symlink():
            fail(f"Destination may not be a symlink: {path}")
    return root


def checked_target(root, name):
    path = root.joinpath(*safe_path(name).parts)
    for current in [path, *path.parents]:
        if current == root.parent:
            break
        if current.is_symlink():
            fail(f"Destination contains a symlink: {name}")
    return path


@contextmanager
def import_lock(site):
    directory = destination(site).parent
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / f".sync-site-sources-{site}.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        fail(f"{site}: source import is already running (lock: {lock}); do not remove another process's lock")
    identity = os.fstat(fd)
    try:
        os.write(fd, f"pid={os.getpid()}\n".encode())
        yield
    finally:
        os.close(fd)
        try:
            current = lock.lstat()
        except FileNotFoundError:
            pass
        else:
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                lock.unlink()


def target_state(root, name):
    path = checked_target(root, name)
    try:
        before = path.stat()
    except FileNotFoundError:
        return None
    key = lambda stat: (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size,
                        stat.st_mtime_ns, stat.st_ctime_ns)
    digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    after = path.stat()
    if key(before) != key(after):
        fail(f"Destination changed while being inspected: {name}")
    return (*key(after), digest)


def ensure_unchanged(root, observed, names=None):
    for name in observed if names is None else names:
        if target_state(root, name) != observed[name]:
            fail(f"Destination changed during import; preserving the concurrent edit: {name}")


def read_snapshot(root, site):
    path = checked_target(root, SNAPSHOT)
    data = json.loads(path.read_text(encoding="utf-8"))
    if (data.get("schema_version") != 1 or data.get("site") != site
            or data.get("project_id") != SITES[site][1]
            or not isinstance(data.get("files"), dict)):
        fail(f"Invalid source snapshot: {path}")
    for name, info in data["files"].items():
        safe_path(name)
        if (name == SNAPSHOT or info.get("mode") not in {"100644", "100755"}
                or not re.fullmatch(r"[a-f0-9]{64}", info.get("sha256", ""))):
            fail(f"Invalid snapshot entry: {name}")
    return data


def matches_file(path, info):
    return (path.is_file()
            and hashlib.sha256(path.read_bytes()).hexdigest() == info["sha256"]
            and (os.name == "nt" or bool(path.stat().st_mode & 0o111) == (info["mode"] == "100755")))


def verify(site, announce=True):
    root = destination(site)
    data = read_snapshot(root, site)
    changed = []
    for name, info in data["files"].items():
        path = checked_target(root, name)
        if not matches_file(path, info):
            changed.append(name)
    if changed:
        fail(f"{site}: {len(changed)} managed files differ or are missing: " + ", ".join(changed[:12]))
    if announce:
        print(f"{site}: verified {len(data['files'])} files, source {data['source_commit']}, version {data['published_version']}")
    return data


def import_source(args):
    with import_lock(args.site):
        import_locked(args)


def import_locked(args):
    if not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        fail("--commit must be a full 40-character Git commit SHA")
    if args.version < 1 or not args.deployment_id:
        fail("A published version and deployment ID are required")
    source = Path(args.source).resolve()
    actual = git(source, "rev-parse", "--verify", args.commit + "^{commit}").decode().strip()
    if actual != args.commit:
        fail("The source reference is not the requested commit")
    root = destination(args.site)
    observed = {SNAPSHOT: target_state(root, SNAPSHOT)}
    old, previous = {}, None
    if (root / SNAPSHOT).exists():
        previous = read_snapshot(root, args.site)
        old = previous["files"]
        observed.update({name: target_state(root, name) for name in old})
        if not args.accept_matching_changes:
            verify(args.site, announce=False)
    elif root.exists() and any(root.iterdir()):
        fail(f"Nonempty destination has no snapshot; refusing to overwrite: {root}")

    contents, files, entries = {}, {}, []
    records = git(source, "ls-tree", "-r", "-z", "--full-tree", args.commit)
    for record in records.split(b"\0"):
        if not record:
            continue
        meta, raw_name = record.split(b"\t", 1)
        mode, kind, blob = meta.decode("ascii").split()
        name = raw_name.decode("utf-8")
        if name == SNAPSHOT:
            continue
        check_source_path(name, args.site)
        if kind != "blob" or mode not in {"100644", "100755"}:
            fail(f"Unsupported tracked entry (symlink or submodule): {name}")
        if name not in observed:
            observed[name] = target_state(root, name)
        entries.append((name, mode, blob))
    for name, mode, blob in entries:
        content = git(source, "cat-file", "blob", blob)
        if SECRET_CONTENT.search(content):
            fail(f"Potential secret detected; review source file: {name}")
        info = {"sha256": hashlib.sha256(content).hexdigest(), "mode": mode, "bytes": len(content)}
        target = checked_target(root, name)
        if (target.exists() and name not in old
                and not (args.accept_matching_changes and matches_file(target, info))):
            fail(f"Source would overwrite an unrelated destination: {name}")
        for parent in target.parents:
            if parent == root:
                break
            if parent.is_file():
                fail(f"Destination parent is a file: {name}")
        contents[name] = content
        files[name] = info
    manifest = json.loads(contents.get(".openai/hosting.json", b"{}"))
    if manifest.get("project_id") != SITES[args.site][1]:
        fail("Source hosting manifest does not match this site's project ID")

    if args.accept_matching_changes:
        for name, info in old.items():
            target = checked_target(root, name)
            if matches_file(target, info):
                continue
            if not target.exists() and name not in files:
                continue  # A local deletion is accepted only if also absent at source.
            if name in files and matches_file(target, files[name]):
                continue  # The local edit must already match the new published source.
            fail(f"Local change does not match the requested source commit: {name}")

    snapshot = {
        "schema_version": 1, "site": args.site, "project_id": SITES[args.site][1],
        "site_url": SITES[args.site][2], "source_commit": args.commit,
        "published_version": args.version, "deployment_id": args.deployment_id,
        "files": dict(sorted(files.items())),
    }
    ensure_unchanged(root, observed)
    if previous and all(previous.get(key) == value for key, value in snapshot.items()):
        print(f"{args.site}: already synchronized; no files or snapshot timestamp changed")
        return

    # Complete every read and conflict check before the first destination write.
    root.mkdir(parents=True, exist_ok=True)
    for name in sorted(set(old) - set(files)):
        ensure_unchanged(root, observed, [name])
        checked_target(root, name).unlink(missing_ok=True)
        observed[name] = None
    for name, content in contents.items():
        target = checked_target(root, name)
        ensure_unchanged(root, observed, [name])
        if matches_file(target, files[name]):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        ensure_unchanged(root, observed, [name])
        target.write_bytes(content)
        target.chmod(0o755 if files[name]["mode"] == "100755" else 0o644)
        observed[name] = target_state(root, name)
    snapshot["imported_at"] = datetime.now(timezone.utc).isoformat()
    ensure_unchanged(root, observed)
    (root / SNAPSHOT).write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify(args.site)


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog="No credentials, network calls or Git pushes. Mobile and taskflow dist/ contain authored source and are preserved.")
    actions = parser.add_subparsers(dest="action", required=True)
    importer = actions.add_parser("import", help="Copy one published Git commit into its managed snapshot")
    importer.add_argument("--site", choices=SITES, required=True)
    importer.add_argument("--source", required=True, help="Local Sites Git checkout (read-only)")
    importer.add_argument("--commit", required=True, help="Full published source commit SHA")
    importer.add_argument("--version", type=int, required=True, help="Sites published version number")
    importer.add_argument("--deployment-id", required=True, help="Verified successful Sites deployment ID")
    importer.add_argument("--accept-matching-changes", action="store_true",
                          help="Accept local edits, additions or deletions only when they already match the requested source commit")
    verifier = actions.add_parser("verify", help="Verify mirrored content and executable modes against saved hashes")
    verifier.add_argument("--site", choices=SITES, help="Omit to verify all registered sites")
    args = parser.parse_args()
    try:
        if args.action == "import":
            import_source(args)
        else:
            for site in [args.site] if args.site else SITES:
                verify(site)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"Source sync failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
