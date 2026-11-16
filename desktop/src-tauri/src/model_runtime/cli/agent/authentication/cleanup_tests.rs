use super::*;
use crate::source_evidence::tests::Fixture;
use std::os::windows::process::CommandExt;
use std::{
    fs::{self, File},
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn report(name: &str, value: Value) {
    if let Some(out) = std::env::var_os("HUB_AUTH_CLEANUP_REPORTS") {
        let path = PathBuf::from(out).join(format!("{name}.json"));
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        f.write_all(&serde_json::to_vec_pretty(&value).unwrap())
            .unwrap();
    }
}
#[test]
fn core_auth_cleanup_normal_collision_and_legacy_snapshot() {
    let f = Fixture::new();
    let source = f.root.join("original-auth.json");
    let path = f.root.join("auth.json");
    fs::write(&source, b"SYNTHETIC_SOURCE_UNCHANGED").unwrap();
    fs::write(&path, b"SYNTHETIC_OLD_SNAPSHOT").unwrap();
    let held = snapshot(&path, b"SYNTHETIC_NEW_SNAPSHOT").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"SYNTHETIC_NEW_SNAPSHOT");
    assert!(snapshot(&path, b"MUST_NOT_OVERWRITE").is_err());
    assert!(fs::remove_file(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"SYNTHETIC_NEW_SNAPSHOT");
    drop(held);
    assert!(!path.exists());
    let reused = snapshot(&path, b"{}").unwrap();
    drop(reused);
    assert!(!path.exists());
    assert_eq!(fs::read(&source).unwrap(), b"SYNTHETIC_SOURCE_UNCHANGED");
    let bad = f.root.join("directory");
    fs::create_dir(&bad).unwrap();
    assert!(snapshot(&bad, b"not a file").is_err());
    assert!(bad.is_dir());
    report(
        "normal",
        json!({"passed":true,"concurrentWriteAndDeleteDenied":true,"legacySnapshotReplacedAndRemoved":true,"sourcePreserved":true,"directoryRejected":true}),
    );
}

#[test]
#[ignore = "owned subprocess helper only; explicit directory and mode required"]
fn core_auth_cleanup_child() {
    let root = PathBuf::from(std::env::var_os("HUB_AUTH_CLEANUP_CHILD_ROOT").unwrap());
    let installed = std::env::var("HUB_AUTH_CLEANUP_CHILD_MODE").unwrap() == "installed";
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    let mut process = None;
    let mut guard = None;
    if installed {
        std::env::remove_var("OPENAI_API_KEY");
        std::env::remove_var("CODEX_API_KEY");
        let prepared = Prepared::decode(
            br#"{"auth_mode":"apikey","OPENAI_API_KEY":"SYNTHETIC_NO_NETWORK_KEY"}"#,
        )
        .unwrap();
        let identity = prepared.identity.clone();
        let control = crate::model_runtime::Control::bounded(Duration::from_secs(25));
        let mut p = super::super::spawn(
            &root,
            &identity,
            prepared,
            "",
            "",
            false,
            &control,
            Default::default(),
        )
        .unwrap();
        p.rpc(
            "initialize",
            "initialize",
            json!({"clientInfo":{"name":"hub_auth_cleanup_test","version":"1"}}),
            &control,
        )
        .unwrap();
        p.send(json!({"method":"initialized"})).unwrap();
        let account = p
            .rpc(
                "account",
                "account/read",
                json!({"refreshToken":false}),
                &control,
            )
            .unwrap();
        assert_eq!(account["account"]["type"], "apiKey");
        process = Some(p);
    } else {
        guard = Some(snapshot(&home.join("auth.json"), b"SYNTHETIC_CRASH_SNAPSHOT").unwrap());
    }
    let marker = json!({"pid":std::process::id(),"nativePid":process.as_ref().map(|p|p.child.id()),"installed":installed,"authReadable":File::open(home.join("auth.json")).is_ok()});
    fs::write(root.join("ready.tmp"), serde_json::to_vec(&marker).unwrap()).unwrap();
    fs::rename(root.join("ready.tmp"), root.join("ready.json")).unwrap();
    // Keep the file and runtime owners alive; the parent kills this exact child without Rust Drop.
    loop {
        std::hint::black_box((&process, &guard));
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn killed_child(installed: bool) {
    let f = Fixture::new();
    let root = f.root.join("runtime");
    fs::create_dir(&root).unwrap();
    let sentinel = root.join("conversation.json");
    fs::write(&sentinel, b"saved answer and budget").unwrap();
    let log = File::create(f.root.join("child.log")).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "core_auth_cleanup_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("HUB_AUTH_CLEANUP_CHILD_ROOT", &root)
        .env(
            "HUB_AUTH_CLEANUP_CHILD_MODE",
            if installed { "installed" } else { "synthetic" },
        )
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .creation_flags(0x08000000);
    let mut child = command.spawn().unwrap();
    let start = Instant::now();
    let ready = root.join("ready.json");
    while !ready.exists()
        && start.elapsed() < Duration::from_secs(35)
        && child.try_wait().unwrap().is_none()
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!(
            "child did not become ready: {}",
            fs::read_to_string(f.root.join("child.log")).unwrap()
        );
    }
    let marker: Value = serde_json::from_slice(&fs::read(&ready).unwrap()).unwrap();
    assert_eq!(marker["pid"], child.id());
    assert_eq!(marker["authReadable"], true);
    let auth = root.join("home/auth.json");
    assert!(auth.exists());
    // A concurrent reader is allowed; deletion completes only when every reader has closed.
    let mut reader = if installed {
        None
    } else {
        Some(File::open(&auth).unwrap())
    };
    child.kill().unwrap();
    let exit = child.wait().unwrap();
    assert!(!exit.success());
    if let Some(mut reader) = reader.take() {
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "SYNTHETIC_CRASH_SNAPSHOT");
    }
    let stopped = Instant::now();
    while auth.exists() && stopped.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !auth.exists(),
        "snapshot remains after owned process termination"
    );
    assert_eq!(fs::read(&sentinel).unwrap(), b"saved answer and budget");
    let report_name = if installed {
        "installed-runtime"
    } else {
        "forced-exit"
    };
    report(
        report_name,
        json!({"passed":true,"childPid":child.id(),"nativePid":marker["nativePid"],"installedRuntime":installed,"credentialSource":"synthetic only","authReadableBeforeKill":true,"authRemovedWithoutRestart":true,"sentinelPreserved":true,"seconds":start.elapsed().as_secs_f64(),"modelTasks":0,"userAuthRead":false}),
    );
}
#[test]
fn core_auth_cleanup_forced_exit_without_restart() {
    killed_child(false);
}
#[test]
#[ignore = "installed Codex account/read with synthetic key; no turn/start or model; explicit opt-in"]
fn core_auth_cleanup_installed_runtime_reads_then_host_is_killed() {
    killed_child(true);
}
