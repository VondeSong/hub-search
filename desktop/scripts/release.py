"""Freeze and attest the existing npm portable build; never prune old evidence."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import tomllib
import uuid

FOLDERS = ("src", "public", "assets", "scripts", "qa", "src-tauri/src", "src-tauri/vendor",
           "src-tauri/capabilities", "src-tauri/icons", "src-tauri/gen/android/app/src/main")
REQUIRED = ("index.html", "package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
            "src-tauri/tauri.conf.json", "scripts/build-portable.ps1", "scripts/release.py",
            "src-tauri/build.rs", "vite.config.ts", "tsconfig.json", "tsconfig.node.json")
OPTIONAL = ("src-tauri/.cargo/config.toml", ".env", ".env.local", ".env.production", ".env.production.local",
            "rust-toolchain", "rust-toolchain.toml", "src-tauri/rust-toolchain", "src-tauri/rust-toolchain.toml",
            "src-tauri/gen/android/app/build.gradle.kts", "src-tauri/gen/android/build.gradle.kts",
            "src-tauri/gen/android/gradle.properties", "src-tauri/gen/android/settings.gradle")
PRODUCER = "hub-release-v1"


def sha(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(part)
    return result.hexdigest()


def versions(desktop: Path) -> tuple[str, dict]:
    manifest = (desktop / "src-tauri/Cargo.toml").read_bytes()
    if b"\r\n" in manifest:
        raise ValueError("Cargo.toml must use LF line endings before freezing; Tauri rewrites CRLF during the formal build")
    package = json.loads((desktop / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((desktop / "package-lock.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((desktop / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))["package"]
    cargo_lock = tomllib.loads((desktop / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
    tauri = json.loads((desktop / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    native = [p["version"] for p in cargo_lock["package"] if p["name"] == cargo["name"]]
    version = package["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", version):
        raise ValueError("Unsupported product version")
    values = [lock["version"], lock["packages"][""]["version"], cargo["version"], tauri["version"], *native]
    if len(native) != 1 or any(v != version for v in values):
        raise ValueError("Product version sources disagree; no release evidence created")
    if "tauri:portable" not in package.get("scripts", {}):
        raise ValueError("Missing formal npm run tauri:portable entry")
    return version, tauri


def inputs(desktop: Path) -> dict[str, str]:
    paths = {desktop / name for name in REQUIRED}
    paths.update(desktop / name for name in OPTIONAL if (desktop / name).is_file())
    tauri = json.loads((desktop / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    for name in tauri.get("bundle", {}).get("resources", {}):
        resource = (desktop / "src-tauri" / name).resolve()
        if not resource.is_relative_to(desktop):
            raise ValueError("Bundled resource resolves outside the product root")
        paths.add(resource)
    for folder in FOLDERS:
        for path in (desktop / folder).rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                paths.add(path)
    if any(not p.is_file() for p in paths):
        raise ValueError("Required product input is missing")
    # Do not freeze an external symlink as if it belonged to the product tree.
    if any(not p.resolve().is_relative_to(desktop) for p in paths):
        raise ValueError("Product input resolves outside the desktop root")
    return {p.relative_to(desktop).as_posix(): sha(p) for p in sorted(paths)}


def write_json(path: Path, value: dict, exclusive: bool = False) -> None:
    if exclusive:
        with path.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)


def run_root(desktop: Path, run: Path) -> Path:
    root = (desktop / "artifacts/releases").resolve()
    if not root.is_relative_to(desktop):
        raise ValueError("Release evidence root resolves outside the desktop root")
    run = run.resolve()
    if run.parent != root:
        raise ValueError("Run must be one direct child of desktop/artifacts/releases")
    return run


def freeze(desktop: Path, run_id: str | None) -> dict:
    version, tauri = versions(desktop)
    frozen = inputs(desktop)
    run_id = run_id or f"{version}-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", run_id):
        raise ValueError("Invalid run ID")
    run = run_root(desktop, desktop / "artifacts/releases" / run_id)
    run.parent.mkdir(parents=True, exist_ok=True)
    run.mkdir()  # Existing evidence is immutable, even for a repeated freeze.
    value = {"schemaVersion": 1, "producer": PRODUCER, "runId": run_id,
             "desktop": str(desktop), "version": version, "applicationId": tauri["identifier"],
             "productName": tauri["productName"], "createdAt": time.time(), "inputs": frozen}
    write_json(run / "source-freeze.json", value, exclusive=True)
    return {"run": str(run), "version": version, "productInputs": len(frozen),
            "sourceFreezeSha256": sha(run / "source-freeze.json")}


def verify(desktop: Path, run: Path) -> dict:
    run = run_root(desktop, run)
    frozen = json.loads((run / "source-freeze.json").read_text(encoding="utf-8"))
    if frozen.get("schemaVersion") != 1 or frozen.get("producer") != PRODUCER or frozen.get("runId") != run.name or frozen.get("desktop") != str(desktop):
        raise ValueError("Release evidence owner or source root does not match")
    version, _ = versions(desktop)
    current = inputs(desktop)
    if frozen["version"] != version or frozen["inputs"] != current:
        raise ValueError("Product inputs changed after release freeze")
    return {"run": str(run), "version": version, "productInputs": len(current),
            "sourceFreezeUnchanged": True, "sourceFreezeSha256": sha(run / "source-freeze.json")}


@contextmanager
def windows_lock(desktop: Path):
    if os.name != "nt":
        raise ValueError("The windows stage requires Windows")
    import msvcrt
    path = desktop / "artifacts/windows-build.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError("Another release job owns the shared frontend output") from error
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def build_plan(desktop: Path, args) -> dict:
    version, tauri = versions(desktop)
    if any(os.environ.get(key) for key in ("CARGO_BUILD_TARGET", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "TAURI_CONFIG", "NODE_OPTIONS")):
        raise ValueError("Undeclared build overrides are set; clear them before freezing the Windows plan")
    node = Path(args.node or shutil.which("node") or "")
    if not node.is_absolute() or not node.is_file():
        raise ValueError("Node executable unavailable; provide --node with an absolute file path")
    npm = Path(args.npm_cli) if args.npm_cli else node.parent / "node_modules/npm/bin/npm-cli.js"
    if not npm.is_absolute() or not npm.is_file():
        raise ValueError("npm CLI unavailable; provide --npm-cli with an absolute file path")
    target = Path(args.cargo_target or os.environ.get("CARGO_TARGET_DIR") or desktop / "src-tauri/target")
    if not target.is_absolute():
        raise ValueError("Cargo target must be absolute")
    # Record only declared build controls, never the complete environment or PATH.
    controls = {"CARGO_NET_OFFLINE": "false" if args.online else "true",
                "CARGO_BUILD_JOBS": "1", "CARGO_INCREMENTAL": "0", "CARGO_TARGET_DIR": str(target.resolve())}
    product = re.sub(r'[\\/:*?"<>|]', "_", tauri["productName"]).strip()
    native_name = tomllib.loads((desktop / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))["package"]["name"]
    return {"version": version, "platform": "windows-x64", "profile": "release", "feature": "custom-protocol",
            "command": [str(node.resolve()), str(npm.resolve()), "run", "tauri:portable"],
            "cwd": str(desktop), "target": str(target.resolve()), "environment": controls,
            "sourceExecutable": str(target.resolve() / f"release/{native_name}.exe"),
            "portableExecutable": str(desktop / "src-tauri/target/release/bundle/portable" / f"{product}_{version}_x64_portable.exe"),
            "toolInputs": {"node": sha(node), "npmCli": sha(npm)}}


def windows(desktop: Path, run: Path, args) -> dict:
    run = run_root(desktop, run)
    plan = build_plan(desktop, args)
    with windows_lock(desktop):
        evidence = verify(desktop, run)  # Recheck after obtaining the shared output lease.
        record, log = run / "windows.json", run / "windows.log"
        if record.exists() or log.exists():
            raise ValueError("Earlier build evidence is retained; freeze a new run before retrying")
        value = {"schemaVersion": 1, "producer": PRODUCER, "runId": run.name, **plan,
                 "freezeSha256": evidence["sourceFreezeSha256"], "startedAt": time.time(), "status": "starting"}
        write_json(record, value, exclusive=True)
        env = os.environ.copy()
        env.update(plan["environment"])
        env["PATH"] = str(Path(plan["command"][0]).parent) + os.pathsep + env.get("PATH", "")
        try:
            with log.open("x", encoding="utf-8") as stream:
                process = subprocess.Popen(plan["command"], cwd=desktop, env=env, stdout=stream, stderr=subprocess.STDOUT)
                value.update(pid=process.pid, status="running")
                write_json(record, value)
                while True:
                    try:
                        code = process.wait()
                        break
                    except KeyboardInterrupt:
                        # Retain the lease until the physical producer ends. A stopped
                        # observer must not allow a second build into shared dist.
                        value["interruptionObserved"] = True
                        write_json(record, value)
            value.update(exitCode=code, status="failed" if code else "verifying")
            verify(desktop, run)
            if code == 0:
                source, portable = Path(plan["sourceExecutable"]), Path(plan["portableExecutable"])
                source_hash, portable_hash = sha(source), sha(portable)
                if source_hash != portable_hash:
                    raise ValueError("Portable artifact differs from the formal production executable")
                # Independent immutable evidence copy; no old version or shared build output is removed.
                retained = run / portable.name
                with portable.open("rb") as source_stream, retained.open("xb") as target_stream:
                    shutil.copyfileobj(source_stream, target_stream, 1024 * 1024)
                    target_stream.flush()
                    os.fsync(target_stream.fileno())
                if sha(retained) != portable_hash:
                    raise ValueError("Retained artifact verification failed")
                verify(desktop, run)
                portable_zip = portable.with_suffix(".zip")
                retained_zip = run / portable_zip.name
                with portable_zip.open("rb") as incoming, retained_zip.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                # Carry resource closure beside the retained executable too. An
                # EXE copied on its own is not the complete portable product.
                resources = {}
                tauri = json.loads((desktop / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
                for name in tauri["bundle"]["resources"].values():
                    incoming = portable.parent / name
                    outgoing = run / name
                    with incoming.open("rb") as source_stream, outgoing.open("xb") as target_stream:
                        shutil.copyfileobj(source_stream, target_stream, 1024 * 1024)
                    resources[name] = {"sha256": sha(outgoing), "bytes": outgoing.stat().st_size}
                value.update(status="success", sourceFreezeUnchanged=True,
                             artifact={"path": str(retained), "sha256": portable_hash, "bytes": retained.stat().st_size},
                             portablePackage={"path": str(retained_zip), "sha256": sha(retained_zip), "bytes": retained_zip.stat().st_size},
                             resources=resources)
        except Exception as error:
            value.update(status="failed", error=str(error))
        finally:
            value.update(endedAt=time.time(), seconds=round(time.time() - value["startedAt"], 2))
            write_json(record, value)
        return value


def installer(desktop: Path, run: Path, args) -> dict:
    """Bundle the already verified production binary; never compile it again."""
    run = run_root(desktop, run)
    plan = build_plan(desktop, args)
    with windows_lock(desktop):
        evidence = verify(desktop, run)
        prior = json.loads((run / "windows.json").read_text(encoding="utf-8"))
        source = Path(plan["sourceExecutable"])
        if prior.get("status") != "success" or sha(source) != prior["artifact"]["sha256"]:
            raise ValueError("Installer requires the exact successful production binary")
        record, log = run / "installer.json", run / "installer.log"
        if record.exists() or log.exists():
            raise ValueError("Earlier installer evidence retained; use a new release identity")
        command = [plan["command"][0], str(desktop / "node_modules/@tauri-apps/cli/tauri.js"),
                   "bundle", "--bundles", "nsis", "--features", "custom-protocol", "--ci", "--no-sign"]
        value = dict(schemaVersion=1, producer=PRODUCER, runId=run.name, command=command,
                     freezeSha256=evidence["sourceFreezeSha256"], status="running", startedAt=time.time())
        env = os.environ.copy(); env.update(plan["environment"])
        env["PATH"] = str(Path(command[0]).parent) + os.pathsep + env.get("PATH", "")
        write_json(record, value, exclusive=True)
        try:
            with log.open("x", encoding="utf-8") as stream:
                process = subprocess.Popen(command, cwd=desktop, env=env, stdout=stream, stderr=subprocess.STDOUT)
                value["pid"] = process.pid; write_json(record, value)
                code = process.wait()
            value["exitCode"] = code
            if code: raise ValueError("NSIS bundler failed; see installer.log")
            verify(desktop, run)
            if sha(source) != prior["artifact"]["sha256"]:
                raise ValueError("Bundler changed the verified executable")
            artifact = Path(plan["target"]) / "release/bundle/nsis" / f'Hub_{plan["version"]}_x64-setup.exe'
            retained = run / artifact.name
            with artifact.open("rb") as incoming, retained.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            value.update(status="success", artifact=dict(path=str(retained), sha256=sha(retained), bytes=retained.stat().st_size),
                         codeSigned=False, runtimeClosure=prior["resources"])
        except Exception as error:
            value.update(status="failed", error=str(error))
        finally:
            value.update(endedAt=time.time(), seconds=round(time.time()-value["startedAt"], 2)); write_json(record, value)
        return value


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop", type=Path, default=Path(__file__).resolve().parents[1])
    sub = parser.add_subparsers(dest="stage", required=True)
    freeze_parser = sub.add_parser("freeze", help="create a new immutable source freeze; no build")
    freeze_parser.add_argument("--run-id")
    verify_parser = sub.add_parser("verify", help="read-only verification of a named freeze")
    verify_parser.add_argument("--run", type=Path, required=True)
    for stage in ("plan", "windows", "installer"):
        command = sub.add_parser(stage, help="read-only build plan" if stage == "plan" else "execute the existing portable build")
        if stage in ("windows", "installer"):
            command.add_argument("--run", type=Path, required=True)
        command.add_argument("--node")
        command.add_argument("--npm-cli")
        command.add_argument("--cargo-target")
        command.add_argument("--online", action="store_true", help="allow the formal builder to retrieve dependencies")
    args = parser.parse_args(argv)
    try:
        desktop = args.desktop.resolve(strict=True)
        if args.stage == "freeze":
            result = freeze(desktop, args.run_id)
        elif args.stage == "verify":
            result = verify(desktop, args.run)
        elif args.stage == "plan":
            result = build_plan(desktop, args)
        elif args.stage == "installer":
            result = installer(desktop, args.run, args)
        else:
            result = windows(desktop, args.run, args)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get("status") == "failed" else 0
    except (OSError, ValueError, KeyError, RuntimeError, tomllib.TOMLDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
