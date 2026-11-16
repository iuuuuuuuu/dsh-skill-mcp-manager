// OAuth support for MCP servers that refuse plain requests (Ardot, and anything else
// built on the MCP authorization spec). The flow is the standard one: discover the
// protected-resource metadata, discover the authorization server, register a public
// client with PKCE, send the user to the browser, catch the redirect on loopback and
// exchange the code for a bearer token.
//
// Everything here is pure or takes its fetch, so a test can drive the whole flow
// against a fake authorization server without a browser.

import { createHash, randomBytes } from "node:crypto";

// RFC 9728: the metadata lives next to the resource (`/mcp` →
// `/.well-known/oauth-protected-resource/mcp`), and the bare host path is the fallback
// every server also implements.
export function protectedResourceCandidates(resourceUrl) {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const list = [];
  if (path !== "") list.push(url.origin + "/.well-known/oauth-protected-resource" + path);
  list.push(url.origin + "/.well-known/oauth-protected-resource");
  return list;
}

export function authorizationServerCandidates(issuer) {
  const base = String(issuer).replace(/\/+$/, "");
  return [base + "/.well-known/oauth-authorization-server", base + "/.well-known/openid-configuration"];
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomState() {
  return randomBytes(16).toString("hex");
}

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, ...init });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, text };
}

// Reads the 401 challenge: `WWW-Authenticate: Bearer realm=…, resource_metadata=…`.
export function parseWwwAuthenticate(header) {
  if (typeof header !== "string" || header === "") return {};
  const out = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g;
  let match = re.exec(header);
  while (match !== null) {
    out[match[1]] = match[2];
    match = re.exec(header);
  }
  if (out.realm === undefined && /^\s*Bearer\b/i.test(header) === false) return {};
  return out;
}

// One round trip that tells us whether a server wants OAuth, and where to ask.
export async function probeAuthorization(resourceUrl, { fetchImpl = fetch } = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dsh-skill-mcp-manager", version: "1" } },
  });
  const res = await fetchImpl(resourceUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  const header = res.headers.get("www-authenticate") ?? "";
  return { status: res.status, needsOAuth: res.status === 401 || res.status === 403, challenge: parseWwwAuthenticate(header) };
}

export async function discoverProtectedResource(resourceUrl, { fetchImpl = fetch, resourceMetadataUrl } = {}) {
  const candidates = resourceMetadataUrl === undefined
    ? protectedResourceCandidates(resourceUrl)
    : [resourceMetadataUrl];
  for (const url of candidates) {
    const { ok, body } = await getJson(fetchImpl, url);
    if (!ok || body === null) continue;
    const servers = Array.isArray(body.authorization_servers) ? body.authorization_servers.filter((s) => typeof s === "string") : [];
    return {
      resource: typeof body.resource === "string" ? body.resource : resourceUrl,
      authorizationServers: servers.length === 0 ? [new URL(resourceUrl).origin] : servers,
      scopes: Array.isArray(body.scopes_supported) ? body.scopes_supported.filter((s) => typeof s === "string") : [],
      metadataUrl: url,
    };
  }
  return null;
}

export async function discoverAuthorizationServer(issuer, { fetchImpl = fetch } = {}) {
  for (const url of authorizationServerCandidates(issuer)) {
    const { ok, body } = await getJson(fetchImpl, url);
    if (!ok || body === null) continue;
    if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") continue;
    return {
      issuer: typeof body.issuer === "string" ? body.issuer : issuer,
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      registrationEndpoint: typeof body.registration_endpoint === "string" ? body.registration_endpoint : null,
      scopes: Array.isArray(body.scopes_supported) ? body.scopes_supported.filter((s) => typeof s === "string") : [],
      metadataUrl: url,
    };
  }
  return null;
}

export async function registerClient({ registrationEndpoint, redirectUri, scope, fetchImpl = fetch, clientName = "dsh-skill-mcp-manager" }) {
  if (typeof registrationEndpoint !== "string" || registrationEndpoint === "") return null;
  const { ok, status, body, text } = await getJson(fetchImpl, registrationEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(typeof scope === "string" && scope !== "" ? { scope } : {}),
    }),
  });
  if (!ok || body === null || typeof body.client_id !== "string") {
    throw new Error("client registration failed (" + status + "): " + String(text).slice(0, 200));
  }
  return { clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : null };
}

export function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, scope, challenge, state }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (typeof scope === "string" && scope !== "") url.searchParams.set("scope", scope);
  if (typeof challenge === "string" && challenge !== "") {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (typeof state === "string" && state !== "") url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri, verifier, fetchImpl = fetch }) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  if (typeof verifier === "string" && verifier !== "") form.set("code_verifier", verifier);
  if (typeof clientSecret === "string" && clientSecret !== "") form.set("client_secret", clientSecret);
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || body === null || typeof body.access_token !== "string") {
    throw new Error("token exchange failed (" + res.status + "): " + String(text).slice(0, 300));
  }
  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

// The whole discovery half of the flow, in one call: 401 challenge → protected resource →
// authorization server. Returns everything the caller needs to start a browser flow.
export async function planOAuth(resourceUrl, { fetchImpl = fetch, resourceMetadataUrl } = {}) {
  const resource = await discoverProtectedResource(resourceUrl, { fetchImpl, resourceMetadataUrl });
  if (resource === null) throw new Error("这个地址没有提供 OAuth 保护元数据（.well-known/oauth-protected-resource）");
  const issuer = resource.authorizationServers[0];
  const server = await discoverAuthorizationServer(issuer, { fetchImpl });
  if (server === null) throw new Error("授权服务器没有提供元数据（" + issuer + "）");
  const scope = resource.scopes.length > 0 ? resource.scopes.join(" ") : server.scopes.join(" ");
  return { resource, server, scope };
}
