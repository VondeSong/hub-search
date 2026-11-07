//! Opt-in test diagnostics: process facts and fixed marker names only.
//! Never persists stderr, model messages, prompts, reasoning or credentials.
use serde_json::json;
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Instant,
};

struct State {
    started: Instant,
    last_flush: Instant,
    file: PathBuf,
    output: PathBuf,
    process: Option<u32>,
    stderr_bytes: usize,
    phases: Vec<(&'static str, u128)>,
}
pub(super) struct Probe {
    state: Arc<Mutex<State>>,
    owner: bool,
}
impl Clone for Probe {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            owner: false,
        }
    }
}
impl Probe {
    pub(super) fn start(cmd: &Command) -> Option<Self> {
        let root = std::env::var_os("HUB_CODEX_TEST_CAPTURE_ROOT")?;
        let args = cmd.get_args().collect::<Vec<_>>();
        let index = args.iter().position(|a| *a == "--output-last-message")?;
        let output = PathBuf::from(args.get(index + 1)?);
        Self::create(PathBuf::from(root), output)
    }
    fn create(root: PathBuf, output: PathBuf) -> Option<Self> {
        let root = std::fs::canonicalize(root).ok()?;
        let temporary = std::fs::canonicalize(std::env::temp_dir()).ok()?;
        if !root.starts_with(temporary) {
            return None;
        }
        let folder = root.join("process");
        std::fs::create_dir_all(&folder).ok()?;
        let name = output.parent()?.file_name()?.to_string_lossy();
        let file = folder.join(format!("{name}.json"));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .ok()?;
        let now = Instant::now();
        let probe = Self {
            state: Arc::new(Mutex::new(State {
                started: now,
                last_flush: now,
                file,
                output,
                process: None,
                stderr_bytes: 0,
                phases: vec![("adapterStarted", 0)],
            })),
            owner: true,
        };
        probe.flush(true);
        Some(probe)
    }
    pub(super) fn spawned(&self, id: u32) {
        if let Ok(mut s) = self.state.lock() {
            s.process = Some(id);
        }
        self.phase("childSpawned");
    }
    pub(super) fn phase(&self, name: &'static str) {
        if let Ok(mut s) = self.state.lock() {
            if s.phases.len() < 64 && !s.phases.iter().any(|p| p.0 == name) {
                let elapsed = s.started.elapsed().as_millis();
                s.phases.push((name, elapsed));
            }
        }
    }
    pub(super) fn stderr(&self, bytes: &[u8]) {
        if let Ok(mut s) = self.state.lock() {
            s.stderr_bytes += bytes.len();
        }
        let text = String::from_utf8_lossy(bytes);
        for (marker, name) in [
            ("thinking", "humanThinkingMarker"),
            ("codex\n", "humanAnswerMarker"),
            ("tokens used", "usageMarker"),
            ("Reconnecting", "reconnectMarker"),
            ("stream disconnected", "streamDisconnectMarker"),
            ("429", "quotaMarker"),
            ("401", "authMarker"),
        ] {
            if text.contains(marker) {
                self.phase(name);
            }
        }
    }
    pub(super) fn flush(&self, force: bool) {
        let snapshot = if let Ok(mut s) = self.state.lock() {
            if !force && s.last_flush.elapsed().as_secs() < 1 {
                return;
            }
            s.last_flush = Instant::now();
            let output_bytes = std::fs::metadata(&s.output).ok().map(|m| m.len());
            Some((
                s.file.clone(),
                json!({"processId":s.process,"elapsedMs":s.started.elapsed().as_millis(),"stderrBytes":s.stderr_bytes,"outputBytes":output_bytes,"phases":s.phases}),
            ))
        } else {
            None
        };
        if let Some((path, value)) = snapshot {
            let _ = std::fs::write(path, value.to_string());
        }
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        if self.owner {
            self.phase("adapterReturned");
            self.flush(true);
        }
    }
}

#[test]
fn probe_keeps_only_process_facts_and_fixed_markers() {
    let root =
        std::env::temp_dir().join(format!("hub-process-probe-{}", crate::random_url_safe(12)));
    std::fs::create_dir(&root).unwrap();
    let probe = Probe::create(root.clone(), root.join("result.json")).unwrap();
    let file = probe.state.lock().unwrap().file.clone();
    probe.spawned(123);
    probe.stderr(b"thinking\nPRIVATE_REASONING_MUST_NOT_BE_SAVED\nReconnecting");
    drop(probe);
    let saved = std::fs::read_to_string(file).unwrap();
    assert!(!saved.contains("PRIVATE_REASONING_MUST_NOT_BE_SAVED"));
    assert!(saved.contains("reconnectMarker") && saved.contains("adapterReturned"));
    assert!(Probe::create(
        std::env::temp_dir().parent().unwrap().into(),
        root.join("outside.json")
    )
    .is_none());
    assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
    std::fs::remove_dir_all(root).unwrap();
}
