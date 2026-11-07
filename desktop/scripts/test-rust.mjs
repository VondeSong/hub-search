// The Windows unit harness needs the same Common Controls activation as the app.
// Build with Cargo, then supply that dependency to a verified byte-identical harness.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("node scripts/test-rust.mjs [--collect-only] [--features FEATURES] [-- LIBTEST_ARGUMENTS]");
  process.exit(0);
}
const separator = argv.indexOf("--");
const options = separator < 0 ? argv : argv.slice(0, separator);
const tests = separator < 0 ? ["--test-threads=1"] : argv.slice(separator + 1);
let collectOnly = false;
const features = [];
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--collect-only") collectOnly = true;
  else if (options[i] === "--features" && options[i + 1]) features.push("--features", options[++i]);
  else throw new Error(`Unsupported runner argument: ${options[i]}`);
}
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// Match the formal release's bounded build policy. Avoid loading/writing a large
// incremental query cache during CI on a slow data drive; expert callers may opt in.
const buildEnvironment = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "1", CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0" };
const state = path.join(root, ".local", "rust-test-runs", randomUUID());
fs.mkdirSync(state, { recursive: true });
const receipt = { format: "hub-native-test-run-v1", startedAt: new Date().toISOString(), cwd: root, features, tests, collectOnly, buildEnvironment: { CARGO_BUILD_JOBS: buildEnvironment.CARGO_BUILD_JOBS, CARGO_INCREMENTAL: buildEnvironment.CARGO_INCREMENTAL }, status: "building" };
const save = () => fs.writeFileSync(path.join(state, "receipt.json"), JSON.stringify(receipt, null, 2));
save();
async function execute(executable, args, name, onLine) {
  const log = fs.createWriteStream(path.join(state, `${name}.log`), { flags: "wx" });
  const child = spawn(executable, args, { cwd: root, env: buildEnvironment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  receipt.activePid = child.pid; receipt.activeCommand = [executable, ...args]; save();
  let pending = "", output = "";
  const read = async (stream, primary) => {
    for await (const chunk of stream) {
      log.write(chunk);
      if (!onLine) { process.stdout.write(chunk); output += chunk.toString("utf8"); }
      else if (primary) {
        pending += chunk.toString("utf8");
        let end;
        while ((end = pending.indexOf("\n")) >= 0) { onLine(pending.slice(0, end)); pending = pending.slice(end + 1); }
      } else process.stderr.write(chunk);
    }
  };
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code: code ?? 1, signal })); });
  const drained = Promise.all([read(child.stdout, true), read(child.stderr, false)]);
  const result = await exited;
  await drained;
  if (onLine && pending) onLine(pending);
  await new Promise(resolve => log.end(resolve));
  delete receipt.activePid; delete receipt.activeCommand;
  return { ...result, output };
}
try {
  const artifacts = [];
  const built = await execute(process.env.CARGO || "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--no-run", "--message-format=json-render-diagnostics", ...features], "build", line => {
    let event; try { event = JSON.parse(line); } catch { if (line.trim()) console.log(line); return; }
    if (event.reason === "compiler-message" && event.message?.rendered) process.stderr.write(event.message.rendered);
    if (event.reason === "compiler-artifact" && event.profile?.test && event.target?.name === "craft_search_lib" && event.executable) artifacts.push(path.resolve(event.executable));
  });
  receipt.buildExitCode = built.code;
  if (built.code) throw Object.assign(new Error("Cargo test build failed"), { exitCode: built.code });
  if (new Set(artifacts).size !== 1) throw new Error("Cargo did not identify one unique library harness");
  const source = artifacts[0], digest = hash(source);
  let executable = source;
  if (process.platform === "win32") {
    const runtime = path.join(root, ".local", "rust-test-runtime", digest);
    fs.mkdirSync(runtime, { recursive: true });
    executable = path.join(runtime, "tests.exe");
    const manifest = fs.readFileSync(path.join(root, "scripts", "windows-test.manifest"));
    if (!fs.existsSync(executable)) fs.copyFileSync(source, executable, fs.constants.COPYFILE_EXCL);
    if (hash(executable) !== digest) throw new Error("Native runtime content identity mismatch");
    if (!fs.existsSync(executable + ".manifest")) fs.writeFileSync(executable + ".manifest", manifest, { flag: "wx" });
    if (!fs.readFileSync(executable + ".manifest").equals(manifest)) throw new Error("Native runtime manifest mismatch");
    receipt.manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  }
  Object.assign(receipt, { sourceExecutable: source, executable, binarySha256: digest, byteIdentical: true, status: "collecting" }); save();
  const listed = await execute(executable, [...tests, "--list"], "collection");
  if (listed.code) throw Object.assign(new Error("Native test collection failed"), { exitCode: listed.code });
  const identities = listed.output.split(/\r?\n/).filter(line => line.endsWith(": test")).map(line => line.slice(0, -6));
  if (!identities.length || new Set(identities).size !== identities.length) throw new Error("Empty or non-unique native test collection");
  fs.writeFileSync(path.join(state, "collected.json"), JSON.stringify(identities, null, 2));
  receipt.collected = identities.length;
  console.log(`Native harness: ${identities.length} unique tests; evidence: ${state}`);
  if (collectOnly) { Object.assign(receipt, { status: "collected", exitCode: 0 }); }
  else {
    receipt.status = "running"; save();
    const result = await execute(executable, tests, "tests");
    Object.assign(receipt, { status: result.code ? "failed" : "passed", exitCode: result.code, signal: result.signal });
    process.exitCode = result.code;
  }
} catch (error) {
  Object.assign(receipt, { status: "failed", exitCode: error.exitCode || 1, error: String(error.message) });
  process.stderr.write(`${error.message}\n`); process.exitCode = receipt.exitCode;
} finally {
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(`Native test receipt: ${path.join(state, "receipt.json")}`);
}
