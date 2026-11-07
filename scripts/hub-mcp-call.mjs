import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const executable = process.argv[2];
const toolName = process.argv[3];
const rawArgumentInput = process.argv[4] ?? "{}";
const rawArguments = rawArgumentInput.startsWith("@")
  ? readFileSync(rawArgumentInput.slice(1), "utf8")
  : rawArgumentInput;
const saveImagePath = process.argv[5] ?? "";
if (!executable || !toolName) {
  console.error("Usage: node scripts/hub-mcp-call.mjs <hub-exe> <tool-name> [arguments-json]");
  process.exit(2);
}

let toolArguments;
try {
  toolArguments = JSON.parse(rawArguments);
} catch (error) {
  console.error(`Invalid arguments JSON: ${error}`);
  process.exit(2);
}

const child = spawn(executable, ["--mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let sequence = 0;
let stderr = "";

child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
lines.on("line", (line) => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const waiter = pending.get(response.id);
  if (waiter) {
    pending.delete(response.id);
    waiter(response);
  }
});

function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 30_000);
    pending.set(id, (response) => {
      clearTimeout(timeout);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "hub-mcp-call", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const result = await call("tools/call", { name: toolName, arguments: toolArguments });
  if (saveImagePath) {
    const image = result.content?.find((item) => item.type === "image" && item.data);
    if (!image) throw new Error("Tool result did not include image data");
    writeFileSync(saveImagePath, Buffer.from(image.data, "base64"));
  }
  process.stdout.write(`${JSON.stringify(result.structuredContent ?? result)}\n`);
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 1000).unref();
  if (stderr.trim()) console.error(stderr.trim());
}
