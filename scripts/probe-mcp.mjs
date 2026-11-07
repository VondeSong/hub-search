import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const mcpUrl = process.env.CRAFT_MCP_URL || process.argv[2];

if (!mcpUrl) {
  console.error("Usage: npm run probe:mcp -- <craft-mcp-url>");
  process.exit(1);
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomUrlSafe(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function parseSseOrJson(text, contentType) {
  if (!text) return null;
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

function protectedResourceMetadataUrl(wwwAuthenticate) {
  const match = wwwAuthenticate?.match(/resource_metadata="([^"]+)"/);
  if (!match) {
    throw new Error("MCP server did not advertise OAuth protected-resource metadata.");
  }
  return match[1];
}

async function discoverOAuth() {
  const probe = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "Craft Search MCP Probe", version: "0.1.0" },
      },
    }),
  });

  if (probe.status !== 401) {
    throw new Error(`Expected OAuth challenge, received HTTP ${probe.status}.`);
  }

  const resourceMetadataUrl = protectedResourceMetadataUrl(
    probe.headers.get("www-authenticate"),
  );
  const resourceResult = await requestJson(resourceMetadataUrl, {
    headers: { Accept: "application/json" },
  });
  if (!resourceResult.response.ok) {
    throw new Error(`Unable to read protected-resource metadata: HTTP ${resourceResult.response.status}`);
  }

  const resource = resourceResult.body.resource;
  const issuer = resourceResult.body.authorization_servers?.[0];
  if (!resource || !issuer) {
    throw new Error("OAuth metadata is missing resource or authorization server information.");
  }

  const issuerUrl = new URL(issuer);
  const candidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  ];

  for (const candidate of candidates) {
    const result = await requestJson(candidate, {
      headers: { Accept: "application/json" },
    });
    if (result.response.ok && result.body?.authorization_endpoint) {
      return { resource, metadata: result.body };
    }
  }

  throw new Error("Unable to discover the Craft OAuth authorization server.");
}

function createCallbackServer(expectedState) {
  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");

    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Craft authorization failed: ${error}`);
      rejectCallback(new Error(`Craft authorization failed: ${error}`));
      return;
    }

    if (state !== expectedState || !code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback. You can close this page.");
      rejectCallback(new Error("OAuth callback state or authorization code is invalid."));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Craft Search</title>
      <style>body{font:16px system-ui;display:grid;place-items:center;min-height:90vh;color:#222}main{max-width:520px;text-align:center}</style>
      <main><h1>Craft 授权完成</h1><p>可以关闭这个页面并返回 Codex。</p></main>`);
    resolveCallback(code);
  });

  return {
    server,
    callbackPromise,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}/oauth/callback`);
        });
      });
    },
    close() {
      server.close();
    },
  };
}

async function registerClient(metadata, redirectUri) {
  const result = await requestJson(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: "Craft Search Desktop",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });

  if (!result.response.ok) {
    throw new Error(`OAuth client registration failed: HTTP ${result.response.status} ${result.text}`);
  }
  return result.body;
}

function openBrowser(url) {
  const child = spawn("explorer.exe", [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

async function exchangeCode(metadata, client, values) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: values.code,
    redirect_uri: values.redirectUri,
    client_id: client.client_id,
    code_verifier: values.codeVerifier,
    resource: values.resource,
  });
  if (client.client_secret) form.set("client_secret", client.client_secret);

  const result = await requestJson(metadata.token_endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!result.response.ok) {
    throw new Error(`Token exchange failed: HTTP ${result.response.status} ${result.text}`);
  }
  return result.body;
}

async function mcpRpc(accessToken, method, params, id, sessionId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-03-26",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP ${method} failed: HTTP ${response.status} ${text}`);
  }
  return {
    body: parseSseOrJson(text, response.headers.get("content-type")),
    sessionId: response.headers.get("mcp-session-id") || sessionId,
  };
}

async function sendInitialized(accessToken, sessionId) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  if (!response.ok) {
    throw new Error(`MCP initialized notification failed: HTTP ${response.status}`);
  }
}

async function main() {
  console.log("Discovering Craft OAuth configuration...");
  const { resource, metadata } = await discoverOAuth();
  const state = randomUrlSafe(24);
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  const callback = createCallbackServer(state);
  const redirectUri = await callback.listen();

  try {
    const client = await registerClient(metadata, redirectUri);
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      resource,
    });

    console.log("Opening Craft authorization in your browser...");
    console.log(`Authorization URL: ${authorizationUrl}`);
    await mkdir(".local", { recursive: true });
    await writeFile(".local/authorization-url.txt", authorizationUrl.toString(), {
      encoding: "utf8",
      mode: 0o600,
    });
    openBrowser(authorizationUrl.toString());
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Authorization timed out after 10 minutes.")), 600_000),
    );
    const code = await Promise.race([callback.callbackPromise, timeout]);
    console.log("Authorization received. Connecting to MCP...");

    const token = await exchangeCode(metadata, client, {
      code,
      redirectUri,
      codeVerifier,
      resource,
    });
    const initialized = await mcpRpc(
      token.access_token,
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "Craft Search MCP Probe", version: "0.1.0" },
      },
      1,
    );
    if (initialized.body?.error) {
      throw new Error(`MCP initialize error: ${JSON.stringify(initialized.body.error)}`);
    }
    await sendInitialized(token.access_token, initialized.sessionId);
    const toolsResult = await mcpRpc(
      token.access_token,
      "tools/list",
      {},
      2,
      initialized.sessionId,
    );
    if (toolsResult.body?.error) {
      throw new Error(`MCP tools/list error: ${JSON.stringify(toolsResult.body.error)}`);
    }

    const tools = toolsResult.body?.result?.tools || [];
    console.log(`MCP connected. ${tools.length} tool(s) available:`);
    for (const tool of tools) {
      console.log(`\n- ${tool.name}`);
      if (tool.description) console.log(`  ${tool.description.replace(/\s+/g, " ").trim()}`);
      const properties = Object.keys(tool.inputSchema?.properties || {});
      if (properties.length) console.log(`  Inputs: ${properties.join(", ")}`);
    }

    // Optional scripted calls for local, task-scoped Craft operations.
    if (process.env.CRAFT_CALLS) {
      const calls = JSON.parse(process.env.CRAFT_CALLS);
      for (const call of calls) {
        const result = await mcpRpc(
          token.access_token,
          "tools/call",
          { name: call.name, arguments: call.arguments ?? { command: call.command } },
          100 + calls.indexOf(call),
          initialized.sessionId,
        );
        console.log(JSON.stringify({ call, result: result.body }));
      }
    }

    if (process.env.CRAFT_INSPECT_WHITEBOARD) {
      const whiteboardId = process.env.CRAFT_INSPECT_WHITEBOARD;
      const result = await mcpRpc(
        token.access_token,
        "tools/call",
        {
          name: "craft_read",
          arguments: { command: `whiteboards elements get --whiteboard ${whiteboardId}` },
        },
        400,
        initialized.sessionId,
      );
      const resultText = result.body?.result?.content?.find((item) => item.type === "text")?.text;
      if (!resultText) throw new Error(`Whiteboard inspection failed: ${JSON.stringify(result.body)}`);
      await writeFile(".local/whiteboard-inspection.json", resultText, "utf8");
      const parsed = JSON.parse(resultText);
      const byType = Object.fromEntries(
        Object.entries(Object.groupBy(parsed.elements || [], (element) => element.type))
          .map(([type, items]) => [type, items.length]),
      );
      console.log(JSON.stringify({
        whiteboardId,
        elementCount: parsed.elements?.length || 0,
        byType,
        appState: parsed.appState,
        samples: Object.values(Object.groupBy(parsed.elements || [], (element) => element.type))
          .map((items) => items[0]),
      }));
    }

  } finally {
    callback.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
