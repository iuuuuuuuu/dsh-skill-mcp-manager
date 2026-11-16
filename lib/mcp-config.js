// Parsing pasted MCP config documents. People paste whatever their other tool
// exports — `{ servers: {…} }`, `{ mcpServers: {…} }`, or a bare map — so the parser
// accepts all three and reports every problem it finds instead of only the first.

const WRAPPER_KEYS = ['servers', 'mcpServers', 'mcp_servers'];
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

// The transport names other tools use, mapped onto the two this plugin speaks.
const TRANSPORT_ALIASES = new Map([
  ['http', 'streamable-http'],
  ['https', 'streamable-http'],
  ['streamable-http', 'streamable-http'],
  ['streamableHttp', 'streamable-http'],
  ['streamable_http', 'streamable-http'],
  ['stdio', 'stdio'],
]);

export function normalizeTransport(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return TRANSPORT_ALIASES.get(raw.trim());
}

function asStringMap(value, errors, path) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: '必须是对象（键值都为字符串）' });
    return {};
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      errors.push({ path: path + '.' + key, message: '值必须是字符串' });
      continue;
    }
    out[key] = item;
  }
  return out;
}

// One server entry → the arguments registerServerEntry() expects. `type`/`transport`
// decide the mode: a url means streamable-http, a command means stdio.
export function normalizeServerEntry(name, raw, errors, basePath) {
  const path = basePath === '' ? name : basePath + '.' + name;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path, message: '必须是一个对象' });
    return null;
  }
  if (!NAME_RE.test(name)) {
    errors.push({ path, message: '名字只能用 [A-Za-z0-9_-]，1-32 个字符' });
    return null;
  }
  const declaredRaw = raw.type !== undefined ? raw.type : raw.transport;
  const declared = normalizeTransport(declaredRaw);
  if (declaredRaw !== undefined && declared === undefined) {
    errors.push({ path: path + '.type', message: '不支持的传输 ' + JSON.stringify(declaredRaw) + '（只认 http / streamable-http / stdio）' });
    return null;
  }
  const hasUrl = typeof raw.url === 'string' && raw.url !== '';
  const hasCommand = typeof raw.command === 'string' && raw.command !== '';
  const transport = declared !== undefined ? declared : hasUrl ? 'streamable-http' : hasCommand ? 'stdio' : undefined;
  if (transport === undefined) {
    errors.push({ path, message: '缺少 url 或 command——看不出这是远程服务器还是本地命令' });
    return null;
  }
  const entry = { name, transport };
  if (transport === 'streamable-http') {
    if (!hasUrl) {
      errors.push({ path: path + '.url', message: 'streamable-http 必须给 url' });
      return null;
    }
    entry.url = raw.url;
    entry.headers = asStringMap(raw.headers, errors, path + '.headers');
  } else {
    if (!hasCommand) {
      errors.push({ path: path + '.command', message: 'stdio 必须给 command' });
      return null;
    }
    entry.command = raw.command;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== 'string')) {
        errors.push({ path: path + '.args', message: '必须是字符串数组' });
      } else {
        entry.args = raw.args;
      }
    }
    entry.env = asStringMap(raw.env, errors, path + '.env');
    if (typeof raw.cwd === 'string' && raw.cwd !== '') entry.cwd = raw.cwd;
  }
  if (typeof raw.notes === 'string' && raw.notes !== '') entry.notes = raw.notes;
  return entry;
}

// What people paste is often a FRAGMENT rather than a document: one pair out of a
// larger file (`\"ardot\": { … },`), or a single entry object with no name. Repair
// those into a document before giving up — and only then report a parse error.
function stripTrailingCommas(text) {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function candidateDocuments(text) {
  const trimmed = text.trim();
  // A pasted pair usually ends with the comma that separated it from the next one,
  // so the comma has to go AFTER wrapping too: `{ …, }` is still invalid.
  const wrapped = '{' + trimmed + '}';
  return [trimmed, stripTrailingCommas(trimmed), wrapped, stripTrailingCommas(wrapped)];
}

// A single entry object (`{ name: "ardot", url: …, type: "http" }`) has everything
// except the key, so take the name from the field and drop it from the body.
function liftInlineName(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null;
  const keys = Object.keys(document);
  if (!keys.includes('name')) return null;
  const looksLikeEntry = keys.some((key) => ['url', 'command', 'type', 'transport'].includes(key));
  if (!looksLikeEntry) return null;
  const name = document.name;
  if (typeof name !== 'string' || name === '') return null;
  const body = {};
  for (const [key, value] of Object.entries(document)) if (key !== 'name') body[key] = value;
  return { [name]: body };
}

export function parseMcpConfigDocument(input) {
  const errors = [];
  const servers = [];
  if (typeof input !== 'string' || input.trim() === '') {
    return { servers, errors: [{ path: '', message: '粘贴的配置是空的' }] };
  }
  let document;
  let repaired = false;
  let lastError = null;
  for (const candidate of candidateDocuments(input)) {
    try {
      document = JSON.parse(candidate);
      repaired = candidate !== input.trim();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError !== null) {
    return { servers, errors: [{ path: '', message: '不是合法 JSON：' + lastError.message }] };
  }
  // A single entry object carries its name as a field, not as a key.
  const lifted = liftInlineName(document);
  if (lifted !== null) {
    document = lifted;
    repaired = true;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { servers, errors: [{ path: '', message: '顶层必须是一个对象' }] };
  }
  let basePath = '';
  let map = document;
  for (const key of WRAPPER_KEYS) {
    if (document[key] !== undefined) {
      basePath = key;
      map = document[key];
      break;
    }
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return { servers, errors: [{ path: basePath, message: '必须是一个对象（名字 → 配置）' }] };
  }
  for (const [name, raw] of Object.entries(map)) {
    const entry = normalizeServerEntry(name, raw, errors, basePath);
    if (entry !== null) servers.push(entry);
  }
  if (servers.length === 0 && errors.length === 0) {
    errors.push({ path: basePath, message: '里面没有任何服务器' });
  }
  return { servers, errors, repaired };
}

// Pretty-printing is what the paste handler shows: same content, 2-space indent, so a
// one-line paste becomes reviewable before it is imported.
export function formatMcpConfig(input) {
  for (const candidate of candidateDocuments(input)) {
    try {
      const document = JSON.parse(candidate);
      const lifted = liftInlineName(document);
      return JSON.stringify(lifted === null ? document : lifted, null, 2);
    } catch {
      // try the next repair
    }
  }
  return input;
}
