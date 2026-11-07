import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const executable = process.argv[2];
const dataDirectory = process.argv[3];
if (!executable) {
  console.error("Usage: node scripts/probe-hub-mcp.mjs <hub-exe> [hub-data-directory]");
  process.exit(2);
}

const childArguments = dataDirectory ? ["--mcp", "--data-dir", dataDirectory] : ["--mcp"];
const child = spawn(executable, childArguments, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let sequence = 0;
let stderr = "";

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

lines.on("line", (line) => {
  const response = JSON.parse(line);
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
    }, 10_000);
    pending.set(id, (response) => {
      clearTimeout(timeout);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  const initialized = await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "hub-mcp-probe", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const listed = await call("tools/list");
  const libraries = await call("tools/call", { name: "hub_list_libraries", arguments: {} });
  const searched = await call("tools/call", { name: "hub_search_notes", arguments: { query: "AI", limit: 3 } });
  const searchData = searched.structuredContent;
  let read = null;
  if (searchData?.results?.[0]) {
    const result = searchData.results[0];
    read = await call("tools/call", {
      name: "hub_read_note",
      arguments: {
        libraryId: result.libraryId,
        documentId: result.documentId,
        blockId: result.blockId,
        maxChars: 4000,
      },
    });
  }
  console.log(JSON.stringify({
    server: initialized.serverInfo,
    protocolVersion: initialized.protocolVersion,
    tools: listed.tools.map((tool) => tool.name),
    libraryCount: libraries.structuredContent?.count,
    searchCount: searchData?.count,
    readTitle: read?.structuredContent?.title ?? null,
    readChars: read?.structuredContent?.content?.length ?? 0,
  }, null, 2));
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 1000).unref();
  if (stderr.trim()) console.error(stderr.trim());
}
