import http from 'node:http';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSpilliService,
  parseHarmonyOutput,
  renderHarmonyForDisplay,
  resolveSpilliKeyFile
} from '@synaptrix/spilli';

const DEFAULT_PORT = 8888;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL_CACHE_TTL_MS = 30_000;
const DEFAULT_SPILLI_KEY_PATH = '~/.spilli';
const SPILLI_BACKEND_API_URL = 'https://sig.synaptrix.org';
const SPILLI_HOST_NODES_PATH = '/api/getuserhosts';
const SPILLI_HOST_NODE_DETAILS_PATH = '/api/gethostinfo';
const SPILLI_TIER_PEM_FILENAMES = [
  'SpiLLI_Enterprise.pem',
  'SpiLLI_Team.pem',
  'SpiLLI_Personal.pem',
  'SpiLLI_Community.pem'
];

const state = {
  service: undefined,
  keyPath: undefined,
  modelCache: undefined,
  pendingModelFetch: undefined,
  loadedEnvFiles: [],
  modelScope: 'public'
};


function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
    return undefined;
  }
  const separator = trimmed.indexOf('=');
  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  } else {
    const commentAt = value.indexOf(' #');
    if (commentAt >= 0) {
      value = value.slice(0, commentAt).trim();
    }
  }
  return { key, value };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed && typeof process.env[parsed.key] === 'undefined') {
      process.env[parsed.key] = parsed.value;
    }
  }
  return true;
}

function loadEnvFiles() {
  const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [path.join(serviceDir, '.env'), path.join(process.cwd(), '.env')];
  for (const candidate of [...new Set(candidates)]) {
    if (loadEnvFile(candidate)) {
      state.loadedEnvFiles.push(candidate);
    }
  }
}

function readEnv(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function expandHome(input) {
  if (!input || input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function normalizeScopeInput(scope) {
  const normalized = scope.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'community' || normalized === 'commmunity') {
    return 'public';
  }
  if (normalized === 'personal') {
    return 'private';
  }
  if (normalized === 'team.*') {
    return 'enterprise';
  }
  if (normalized === 'public' || normalized === 'private' || normalized === 'team' || normalized === 'enterprise') {
    return normalized;
  }
  if (normalized.startsWith('team.') && normalized.slice('team.'.length).trim()) {
    return normalized;
  }
  return undefined;
}

function normalizeConfiguredScope(scope) {
  const normalized = normalizeScopeInput(scope);
  if (normalized) {
    return normalized;
  }
  console.warn(
    `Unknown model scope "${scope}". Expected public, private, team, team.<name>, or enterprise. Falling back to private.`
  );
  return 'private';
}

function getConfig() {
  const requestTimeoutMs = Number.parseInt(readEnv('SPILLI_BRIDGE_REQUEST_TIMEOUT_MS'), 10);
  const modelCacheTtlMs = Number.parseInt(readEnv('SPILLI_BRIDGE_MODEL_CACHE_TTL_MS'), 10);
  const scope = normalizeConfiguredScope(state.modelScope);
  return {
    host: readEnv('SPILLI_BRIDGE_HOST', '127.0.0.1'),
    port: Number.parseInt(readEnv('SPILLI_BRIDGE_PORT'), 10) || DEFAULT_PORT,
    keyPath: expandHome(readEnv('SPILLI_KEY_PATH', DEFAULT_SPILLI_KEY_PATH)),
    scope,
    team: readEnv('SPILLI_BRIDGE_TEAM'),
    authToken: readEnv('SPILLI_BRIDGE_AUTH_TOKEN'),
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : DEFAULT_TIMEOUT_MS,
    modelCacheTtlMs:
      Number.isFinite(modelCacheTtlMs) && modelCacheTtlMs > 0 ? modelCacheTtlMs : DEFAULT_MODEL_CACHE_TTL_MS,
    reuseSessions: readEnv('SPILLI_BRIDGE_REUSE_SESSIONS', '1') !== '0',
    nativeCacheDir: readEnv('SPILLI_BRIDGE_NATIVE_CACHE_DIR')
  };
}

function resolveHighestTierSpilliKeyFile(configuredPath) {
  const resolved = resolveSpilliKeyFile(configuredPath);
  const configured = configuredPath?.trim();
  if (configured?.toLowerCase().endsWith('.pem')) {
    return resolved;
  }

  for (const filename of SPILLI_TIER_PEM_FILENAMES) {
    const candidate = path.join(resolved.keyDirectory, filename);
    if (fs.existsSync(candidate)) {
      return {
        ...resolved,
        keyFilePath: candidate
      };
    }
  }

  return resolved;
}

function getService(config) {
  const resolved = resolveHighestTierSpilliKeyFile(config.keyPath);
  if (state.service && state.keyPath === resolved.keyFilePath) {
    return state.service;
  }
  const options = {};
  if (config.nativeCacheDir) {
    options.nativeCacheDir = path.resolve(expandHome(config.nativeCacheDir));
  }
  state.service = createSpilliService(resolved.keyFilePath, options);
  state.keyPath = resolved.keyFilePath;
  return state.service;
}

function buildApiUrl(baseUrl, apiPath) {
  const base = new URL(baseUrl);
  const normalizedBasePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  const normalizedApiPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  base.pathname = `${normalizedBasePath}${normalizedApiPath}`;
  return base;
}

function readPemContent(config) {
  const resolved = resolveHighestTierSpilliKeyFile(config.keyPath);
  return {
    keyFilePath: resolved.keyFilePath,
    pemContent: fs.readFileSync(resolved.keyFilePath, 'utf8')
  };
}

function requestJsonWithPem(url, payload, pemContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload ?? {});
    const parsed = new URL(url);
    const req = https.request(
      parsed,
      {
        method: 'POST',
        key: pemContent,
        cert: pemContent,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsedBody = text ? tryParseJson(text) : {};
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              Object.assign(new Error(`SpiLLI backend request failed (${res.statusCode}): ${text.slice(0, 500)}`), {
                statusCode: 502
              })
            );
            return;
          }
          resolve(parsedBody ?? text);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getBaseScope(scope) {
  const normalized = scope?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'team.*') {
    return 'enterprise';
  }
  if (['public', 'private', 'team', 'enterprise'].includes(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('team.') && normalized.slice('team.'.length).trim()) {
    return 'team';
  }
  return undefined;
}

function getTeamNameFromScope(scope) {
  const normalized = scope?.trim();
  if (!normalized || normalized === 'team.*' || !normalized.startsWith('team.')) {
    return undefined;
  }
  return normalized.slice('team.'.length).trim() || undefined;
}

function normalizeTeamName(team) {
  return team?.trim().toLowerCase() || undefined;
}

function toVisibility(value) {
  const normalized = value?.trim();
  if (!normalized) {
    return 'private';
  }
  if (normalized === 'team.*') {
    return 'enterprise';
  }
  if (normalized === 'public' || normalized === 'private' || normalized === 'team' || normalized === 'enterprise') {
    return normalized;
  }
  if (normalized.startsWith('team.') && normalized.slice('team.'.length).trim()) {
    return normalized;
  }
  return 'private';
}

function stripModelScopeSuffix(modelName) {
  const trimmed = modelName.trim();
  if (!trimmed) {
    return '';
  }
  const match = trimmed.match(/^(?<name>.+)\.(?:public|private|enterprise|team(?:\..+)?)$/);
  return match?.groups?.name?.trim() || trimmed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanHostModelDisplayName(label, identifiers) {
  const original = label?.trim();
  if (!original) {
    return undefined;
  }
  const candidates = [...new Set(identifiers.map(value => value?.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  let cleaned = original;
  for (const candidate of candidates) {
    cleaned = cleaned.replace(new RegExp(`(?:\\s*[\\r\\n]+\\s*|\\s+)?${escapeRegExp(candidate)}(?:\\s*[\\r\\n]+\\s*|\\s+)?`, 'g'), ' ');
  }
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/^[\s:|,;()[\]-]+|[\s:|,;()[\]-]+$/g, '')
    .trim();
  return cleaned || undefined;
}

function basenameFromPath(value) {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

function parseHostModelString(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const scoped = /^(?<name>.+)\.(?<scope>public|private|enterprise|team(?:\.[^\s]+)?)$/i.exec(trimmed);
  if (scoped?.groups?.name) {
    return {
      modelName: scoped.groups.name.trim(),
      visibility: toVisibility(scoped.groups.scope)
    };
  }
  return { modelName: trimmed, visibility: 'private' };
}

function extractHostNodes(response) {
  const candidates = [];
  if (Array.isArray(response)) {
    candidates.push(response);
  }
  if (isRecord(response)) {
    candidates.push(response);
    if (isRecord(response.data)) {
      candidates.push(response.data);
    }
  }
  const nodes = [];
  const addNode = nodeId => {
    const normalized = nodeId.trim();
    if (normalized) {
      nodes.push(normalized);
    }
  };
  for (const container of candidates) {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (typeof item === 'string') {
          addNode(item);
        } else if (isRecord(item)) {
          const nodeId =
            readString(item.node_name) ??
            readString(item.nodeName) ??
            readString(item.node_id) ??
            readString(item.nodeId) ??
            readString(item.hostname) ??
            readString(item.host) ??
            readString(item.host_id) ??
            readString(item.hostId) ??
            readString(item.peerId) ??
            readString(item.peer_id) ??
            readString(item.id) ??
            readString(item.name);
          if (nodeId) {
            addNode(nodeId);
          }
        }
      }
      continue;
    }
    if (!isRecord(container)) {
      continue;
    }
    for (const key of ['nodes', 'hosts', 'hostnodes', 'hostNodes', 'data']) {
      if (!Array.isArray(container[key])) {
        continue;
      }
      for (const item of container[key]) {
        if (typeof item === 'string') {
          addNode(item);
          continue;
        }
        if (!isRecord(item)) {
          continue;
        }
        const nodeId =
          readString(item.node_name) ??
          readString(item.nodeName) ??
          readString(item.nodeId) ??
          readString(item.node_id) ??
          readString(item.hostname) ??
          readString(item.host) ??
          readString(item.host_id) ??
          readString(item.hostId) ??
          readString(item.peerId) ??
          readString(item.peer_id) ??
          readString(item.id) ??
          readString(item.name);
        if (nodeId) {
          addNode(nodeId);
        }
      }
    }
    for (const key of ['node_names', 'nodeNames', 'node_ids', 'nodeIds', 'host_ids', 'hostIds']) {
      if (!Array.isArray(container[key])) {
        continue;
      }
      for (const item of container[key]) {
        if (typeof item === 'string') {
          addNode(item);
        }
      }
    }
  }
  return [...new Set(nodes)];
}

function extractHostNodeDetails(nodeId, response) {
  const containers = [];
  if (isRecord(response)) {
    containers.push(response);
    for (const key of ['data', 'node', 'host']) {
      if (isRecord(response[key])) {
        containers.push(response[key]);
      }
    }
  }
  const models = [];
  const dedupe = new Set();
  for (const container of containers) {
    for (const key of ['models', 'model_list', 'modelList', 'entries', 'data']) {
      const list = container[key];
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list) {
        let model;
        if (typeof item === 'string') {
          model = parseHostModelString(item);
        } else if (isRecord(item)) {
          const modelName =
            readString(item.model_name) ??
            readString(item.modelName) ??
            readString(item.resource_id) ??
            readString(item.resourceId) ??
            readString(item.name) ??
            readString(item.id);
          if (!modelName) {
            continue;
          }
          const resourceId = readString(item.resource_id) ?? readString(item.resourceId);
          const artifactHash = readString(item.artifact_hash) ?? readString(item.artifactHash);
          const uidModelName = /^gguf:sha256:/i.test(modelName) ? modelName : undefined;
          const rawDisplayName =
            readString(item.display_name) ??
            readString(item.displayName) ??
            readString(item.label) ??
            readString(item.friendly_name) ??
            readString(item.friendlyName);
          model = {
            modelName,
            displayName: cleanHostModelDisplayName(rawDisplayName, [resourceId, uidModelName, artifactHash]),
            providerModel: readString(item.model) ?? readString(item.provider_model) ?? readString(item.providerModel),
            resourceId,
            artifactHash,
            hfFilename: readString(item.hf_filename) ?? readString(item.hfFilename),
            localPath: readString(item.local_path) ?? readString(item.localPath),
            assetName: readString(item.assetname) ?? readString(item.assetName),
            visibility: toVisibility(
              readString(item.visibility) ??
                readString(item.visibility_scope) ??
                readString(item.visibilityScope) ??
                readString(item.scope)
            ),
            teamName: readString(item.team_name) ?? readString(item.teamName)
          };
        }
        if (!model?.modelName || dedupe.has(model.modelName)) {
          continue;
        }
        dedupe.add(model.modelName);
        models.push(model);
      }
    }
  }
  return { nodeId, models };
}

function hostModelMatchesScope(model, requestedScope, requestedTeam) {
  const requestedBaseScope = getBaseScope(requestedScope);
  const modelBaseScope = getBaseScope(model.visibility);
  if (requestedBaseScope && modelBaseScope && requestedBaseScope !== modelBaseScope) {
    return false;
  }
  if (requestedBaseScope !== 'team') {
    return true;
  }
  const targetTeam = normalizeTeamName(getTeamNameFromScope(requestedScope) ?? requestedTeam);
  const modelTeam = normalizeTeamName(getTeamNameFromScope(model.visibility) ?? model.teamName);
  return !targetTeam || !modelTeam || targetTeam === modelTeam;
}

function normalizeHostInventoryModelName(model) {
  const rawName = (model.resourceId || model.modelName || model.assetName || '').trim();
  return stripModelScopeSuffix(rawName);
}

function normalizeHostInventoryDisplayName(model) {
  const uidCandidates = [
    model.resourceId,
    /^gguf:sha256:/i.test(model.modelName) ? model.modelName : undefined,
    model.artifactHash
  ];
  const displayName = cleanHostModelDisplayName(model.displayName, uidCandidates);
  const providerModel = cleanHostModelDisplayName(model.providerModel, uidCandidates);
  return (displayName || providerModel || model.hfFilename || basenameFromPath(model.localPath) || '').trim();
}

function normalizeModelLookupName(value) {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

async function fetchAvailableModels(config, { forceRefresh = false } = {}) {
  const cacheKey = `${config.keyPath}|${config.scope}|${config.team}`;
  const now = Date.now();
  if (
    !forceRefresh &&
    state.modelCache &&
    state.modelCache.cacheKey === cacheKey &&
    state.modelCache.expiresAt > now
  ) {
    return state.modelCache.catalog;
  }
  if (!forceRefresh && state.pendingModelFetch) {
    return state.pendingModelFetch;
  }
  state.pendingModelFetch = (async () => {
    const { pemContent } = readPemContent(config);
    const nodesUrl = buildApiUrl(SPILLI_BACKEND_API_URL, SPILLI_HOST_NODES_PATH).toString();
    const nodesResponse = await requestJsonWithPem(nodesUrl, {}, pemContent);
    const nodeIds = extractHostNodes(nodesResponse);
    const detailsUrl = buildApiUrl(SPILLI_BACKEND_API_URL, SPILLI_HOST_NODE_DETAILS_PATH).toString();
    const details = await Promise.all(
      nodeIds.map(async nodeId => extractHostNodeDetails(nodeId, await requestJsonWithPem(detailsUrl, { hostname: nodeId }, pemContent)))
    );
    const byUid = new Map();
    for (const detail of details) {
      const seenOnNode = new Set();
      for (const model of detail.models) {
        if (!hostModelMatchesScope(model, config.scope, config.team)) {
          continue;
        }
        const uid = normalizeHostInventoryModelName(model);
        if (!uid) {
          continue;
        }
        seenOnNode.add(uid);
        const displayName = normalizeHostInventoryDisplayName(model);
        const existing = byUid.get(uid) ?? {
          uid,
          displayName: displayName || uid,
          count: 0
        };
        if (displayName && existing.displayName === uid) {
          existing.displayName = displayName;
        }
        byUid.set(uid, existing);
      }
      for (const uid of seenOnNode) {
        const existing = byUid.get(uid);
        if (existing) {
          existing.count += 1;
        }
      }
    }
    const models = [...byUid.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    );
    const displayNameCounts = new Map();
    for (const model of models) {
      displayNameCounts.set(model.displayName, (displayNameCounts.get(model.displayName) ?? 0) + 1);
    }
    for (const model of models) {
      model.apiName =
        (displayNameCounts.get(model.displayName) ?? 0) > 1
          ? `${model.displayName} [${model.uid}]`
          : model.displayName;
    }
    const catalog = {
      scope: config.scope,
      team: config.team,
      models,
      fetchedAt: new Date().toISOString()
    };
    state.modelCache = {
      cacheKey,
      expiresAt: Date.now() + config.modelCacheTtlMs,
      catalog
    };
    return catalog;
  })();
  try {
    return await state.pendingModelFetch;
  } finally {
    state.pendingModelFetch = undefined;
  }
}

function resolveModelFromCatalog(requestedModel, catalog) {
  const requested = requestedModel.trim();
  if (!catalog.models.length) {
    throw Object.assign(new Error(`No SpiLLI models are available for scope "${catalog.scope}".`), { statusCode: 503 });
  }
  if (!requested) {
    return catalog.models[0];
  }
  const exactUid = catalog.models.find(model => model.uid === requested);
  if (exactUid) {
    return exactUid;
  }
  const exactApiName = catalog.models.find(model => model.apiName === requested);
  if (exactApiName) {
    return exactApiName;
  }
  const exactDisplayMatches = catalog.models.filter(model => model.displayName === requested);
  if (exactDisplayMatches.length === 1) {
    return exactDisplayMatches[0];
  }
  if (exactDisplayMatches.length > 1) {
    const choices = exactDisplayMatches.map(model => model.apiName).join(', ');
    throw Object.assign(new Error(`Model display name "${requested}" is ambiguous. Use one of: ${choices}`), {
      statusCode: 404
    });
  }
  const normalized = normalizeModelLookupName(requested);
  const normalizedApiName = catalog.models.find(model => normalizeModelLookupName(model.apiName) === normalized);
  if (normalizedApiName) {
    return normalizedApiName;
  }
  const normalizedDisplayMatches = catalog.models.filter(model => normalizeModelLookupName(model.displayName) === normalized);
  if (normalizedDisplayMatches.length === 1) {
    return normalizedDisplayMatches[0];
  }
  if (normalizedDisplayMatches.length > 1) {
    const choices = normalizedDisplayMatches.map(model => model.apiName).join(', ');
    throw Object.assign(new Error(`Model display name "${requested}" is ambiguous. Use one of: ${choices}`), {
      statusCode: 404
    });
  }
  const available = catalog.models.map(model => model.apiName).join(', ');
  throw Object.assign(new Error(`Unknown model "${requested}". Available ${catalog.scope} models: ${available}`), {
    statusCode: 404
  });
}

async function resolveRequestedModel(requestedModel, config) {
  let catalog = await fetchAvailableModels(config);
  try {
    return resolveModelFromCatalog(requestedModel, catalog);
  } catch (err) {
    if (err?.statusCode !== 404) {
      throw err;
    }
    catalog = await fetchAvailableModels(config, { forceRefresh: true });
    return resolveModelFromCatalog(requestedModel, catalog);
  }
}

function extractJsonObjectRanges(body) {
  const ranges = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        ranges.push(body.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return ranges;
}

function parseToolArguments(value) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  const parsed = tryParseJson(value.trim());
  return isRecord(parsed) ? parsed : {};
}

function toToolCall(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  const responseFunctionName =
    value.type === 'function_call' || typeof value.call_id === 'string' || typeof value.arguments !== 'undefined'
      ? value.name
      : undefined;
  const toolName = asString(value.toolName || responseFunctionName).trim();
  if (!toolName) {
    return undefined;
  }
  const callId =
    asString(value.callId).trim() ||
    asString(value.call_id).trim() ||
    asString(value.id).trim() ||
    `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const args = parseToolArguments(
    typeof value.args !== 'undefined' ? value.args : typeof value.arguments !== 'undefined' ? value.arguments : undefined
  );
  return { id: callId, name: toolName, input: args };
}

function collectToolCalls(value, calls) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCalls(item, calls);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const direct = toToolCall(value);
  if (direct) {
    calls.push(direct);
  }
  if (isRecord(value.function)) {
    const chatToolCall = toToolCall({
      type: 'function_call',
      id: value.id,
      call_id: value.id,
      name: value.function.name,
      arguments: value.function.arguments
    });
    if (chatToolCall) {
      calls.push(chatToolCall);
    }
  }
  for (const key of ['toolCalls', 'tool_calls', 'output', 'items', 'choices']) {
    if (Array.isArray(value[key])) {
      collectToolCalls(value[key], calls);
    }
  }
  for (const key of ['item', 'message']) {
    if (isRecord(value[key])) {
      collectToolCalls(value[key], calls);
    }
  }
}

function parseToolCallsFromOutput(raw) {
  const calls = [];
  const parsedHarmony = parseHarmonyOutput(raw);
  if (parsedHarmony.isHarmony) {
    for (const segment of parsedHarmony.messages) {
      const hasRecipient = typeof segment.recipient === 'string' && segment.recipient.trim();
      const isToolish = segment.terminator === 'call' || (hasRecipient && segment.terminator === 'end');
      if (!isToolish) {
        continue;
      }
      const parsedContent = tryParseJson(segment.content.trim());
      if (!isRecord(parsedContent)) {
        continue;
      }
      const name = asString(parsedContent.toolName || segment.recipient).trim();
      if (!name) {
        continue;
      }
      calls.push({
        id:
          asString(parsedContent.callId).trim() ||
          `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name,
        input: isRecord(parsedContent.args) ? parsedContent.args : parsedContent
      });
    }
  }
  const jsonBlockRegex = /```json\s*([\s\S]*?)```/gi;
  let match;
  while ((match = jsonBlockRegex.exec(raw)) !== null) {
    const parsed = tryParseJson((match[1] ?? '').trim());
    collectToolCalls(parsed, calls);
  }
  for (const candidate of extractJsonObjectRanges(raw)) {
    collectToolCalls(tryParseJson(candidate), calls);
  }
  const seen = new Set();
  return calls.filter(call => {
    const key = `${call.name}|${JSON.stringify(call.input ?? {})}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function renderText(raw, toolCalls) {
  const rendered = renderHarmonyForDisplay(raw);
  const stripDisplaySections = text => {
    const normalized = text.trim();
    const finalMatch = normalized.match(/^(?:#+\s*)?Final Response\s*\n([\s\S]*?)(?:\n\s*(?:#+\s*)?(?:Analysis|Tool Calls|Tool Results|Commentary)\s*\n[\s\S]*)?$/i);
    return finalMatch?.[1]?.trim() || normalized;
  };
  if (toolCalls.length > 0) {
    const text = rendered.isHarmony ? rendered.finalText : raw;
    const trimmed = stripDisplaySections(text);
    if (!trimmed.startsWith('{') && !trimmed.startsWith('```json')) {
      return trimmed;
    }
    return '';
  }
  return rendered.isHarmony ? rendered.finalText : stripDisplaySections(rendered.display);
}

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(part => {
      if (typeof part === 'string') {
        return part;
      }
      if (!isRecord(part)) {
        return '';
      }
      if (part.type === 'text') {
        return asString(part.text);
      }
      if (part.type === 'tool_result') {
        return `Tool result for ${asString(part.tool_use_id) || 'tool'}:\n${normalizeContent(part.content)}`;
      }
      if (part.type === 'tool_use') {
        return `Tool call ${asString(part.name)}(${JSON.stringify(part.input ?? {})})`;
      }
      if (part.type === 'image') {
        return '[Image input omitted by SpiLLI API bridge]';
      }
      return asString(part.text || part.content);
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeSystem(system) {
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return normalizeContent(system);
  }
  return '';
}

function formatToolsForPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  const lines = [
    'Tools are available. When you need a tool, respond with a tool call rather than final prose.',
    'Tool call JSON shape: {"toolName":"name","callId":"optional-id","args":{...}}',
    'Available tools:'
  ];
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const name = asString(tool.name || tool.function?.name).trim();
    if (!name) {
      continue;
    }
    const description = asString(tool.description || tool.function?.description).trim();
    const schema = tool.input_schema || tool.parameters || tool.function?.parameters || {};
    lines.push(`- ${name}: ${description || 'No description'} Schema: ${JSON.stringify(schema)}`);
  }
  return lines.join('\n');
}

function anthropicToSpilliPayload(body) {
  const systemPrompt = [normalizeSystem(body.system), formatToolsForPrompt(body.tools)].filter(Boolean).join('\n\n');
  const query = Array.isArray(body.messages)
    ? body.messages
        .map(message => {
          if (!isRecord(message)) {
            return '';
          }
          const role = asString(message.role) || 'user';
          return `${role.toUpperCase()}:\n${normalizeContent(message.content)}`;
        })
        .filter(Boolean)
        .join('\n\n')
    : '';
  return {
    requestedModel: asString(body.model).trim(),
    prompt: systemPrompt,
    query
  };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(asString(text).length / 4));
}

function openAiToSpilliPayload(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompt = [
    messages
      .filter(message => isRecord(message) && message.role === 'system')
      .map(message => normalizeContent(message.content))
      .filter(Boolean)
      .join('\n\n'),
    formatToolsForPrompt(body.tools)
  ]
    .filter(Boolean)
    .join('\n\n');
  const query = messages
    .filter(message => isRecord(message) && message.role !== 'system')
    .map(message => `${asString(message.role || 'user').toUpperCase()}:\n${normalizeContent(message.content)}`)
    .filter(Boolean)
    .join('\n\n');
  return {
    requestedModel: asString(body.model).trim(),
    prompt: systemPrompt,
    query
  };
}

async function runInference({ requestedModel, prompt, query }, config) {
  const resolvedModel = await resolveRequestedModel(requestedModel, config);
  const service = getService(config);
  const resource = { model: resolvedModel.uid, scope: config.scope };
  if (config.team) {
    resource.team = config.team;
  }
  let session = config.reuseSessions
    ? service.getOrCreateSession(resource, config.requestTimeoutMs)
    : service.request(resource, config.requestTimeoutMs);
  if (!session.isLive()) {
    session = service.request(resource, config.requestTimeoutMs);
  }
  if (!session.isLive()) {
    throw Object.assign(new Error('SpiLLI model session is not live.'), { statusCode: 503 });
  }
  const raw = await session.run({ prompt, query }, { timeoutMs: config.requestTimeoutMs });
  return {
    raw,
    requestedModel: requestedModel || resolvedModel.displayName,
    resolvedModel
  };
}

function json(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(),
    ...headers
  });
  res.end(body);
}

function errorJson(res, err) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  json(res, status, {
    error: {
      type: status === 401 ? 'authentication_error' : 'api_error',
      message: err instanceof Error ? err.message : String(err)
    }
  });
}


function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers':
      'authorization,content-type,x-api-key,api-key,anthropic-version,anthropic-beta,openai-organization'
  };
}

function authorize(req, config) {
  if (!config.authToken) {
    return true;
  }
  const authorization = asString(req.headers.authorization);
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const xApiKey = asString(req.headers['x-api-key']).trim();
  const apiKey = asString(req.headers['api-key']).trim();
  return [bearer, xApiKey, apiKey].includes(config.authToken);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) {
    return {};
  }
  const parsed = tryParseJson(text);
  if (!isRecord(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  }
  return parsed;
}

function toAnthropicMessage({ id, model, raw }) {
  const toolCalls = parseToolCallsFromOutput(raw);
  const text = renderText(raw, toolCalls);
  const content = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const call of toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input ?? {}
    });
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: Math.max(1, Math.ceil(raw.length / 4))
    }
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleAnthropicMessages(req, res, config) {
  const body = await readBody(req);
  const payload = anthropicToSpilliPayload(body);
  const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders()
    });
    const ping = setInterval(() => writeSse(res, 'ping', { type: 'ping' }), 15_000);
    try {
      const result = await runInference(payload, config);
      const message = toAnthropicMessage({ id, model: result.requestedModel, raw: result.raw });
      writeSse(res, 'message_start', {
        type: 'message_start',
        message: { ...message, content: [], stop_reason: null, stop_sequence: null }
      });
      message.content.forEach((block, index) => {
        const emptyBlock =
          block.type === 'text'
            ? { type: 'text', text: '' }
            : { type: 'tool_use', id: block.id, name: block.name, input: {} };
        writeSse(res, 'content_block_start', {
          type: 'content_block_start',
          index,
          content_block: emptyBlock
        });
        if (block.type === 'text') {
          writeSse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text }
          });
        } else if (block.type === 'tool_use') {
          writeSse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
          });
        }
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
      });
      writeSse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: message.usage
      });
      writeSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    } catch (err) {
      writeSse(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) }
      });
      res.end();
    } finally {
      clearInterval(ping);
    }
    return;
  }
  const result = await runInference(payload, config);
  json(res, 200, toAnthropicMessage({ id, model: result.requestedModel, raw: result.raw }));
}

async function handleAnthropicCountTokens(req, res, config) {
  const body = await readBody(req);
  const payload = anthropicToSpilliPayload(body);
  json(res, 200, {
    input_tokens: estimateTokens(`${payload.prompt}\n\n${payload.query}`)
  });
}

function toOpenAiChatCompletion({ id, model, raw }) {
  const toolCalls = parseToolCallsFromOutput(raw);
  const text = renderText(raw, toolCalls);
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {})
            }
          }))
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.max(1, Math.ceil(raw.length / 4)),
      total_tokens: Math.max(1, Math.ceil(raw.length / 4))
    }
  };
}

async function handleOpenAiChatCompletions(req, res, config) {
  const body = await readBody(req);
  const payload = openAiToSpilliPayload(body);
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const result = await runInference(payload, config);
  const completion = toOpenAiChatCompletion({ id, model: result.requestedModel, raw: result.raw });
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders()
    });
    const choice = completion.choices[0];
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model: result.requestedModel,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    })}\n\n`);
    if (choice.message.content) {
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: result.requestedModel,
        choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }]
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: completion.created,
      model: result.requestedModel,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  json(res, 200, completion);
}

async function handleModels(req, res, config) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const forceRefresh = url.searchParams.get('refresh') === 'true' || url.searchParams.get('force') === 'true';
  const catalog = await fetchAvailableModels(config, { forceRefresh });
  json(res, 200, {
    object: 'list',
    data: catalog.models.map(model => ({
      id: model.apiName,
      object: 'model',
      type: 'model',
      created: 0,
      created_at: '1970-01-01T00:00:00.000Z',
      owned_by: 'spilli',
      uid: model.uid,
      display_name: model.displayName,
      host_count: model.count
    })),
    has_more: false,
    first_id: catalog.models[0]?.apiName ?? null,
    last_id: catalog.models[catalog.models.length - 1]?.apiName ?? null
  });
}


function scopePayload(config, message) {
  return {
    ok: true,
    scope: config.scope,
    team: config.team || null,
    valid_scopes: ['public', 'private', 'team', 'team.<name>', 'enterprise'],
    message
  };
}

async function handleScope(req, res, config) {
  if (req.method === 'GET') {
    json(res, 200, scopePayload(config));
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: { type: 'invalid_request_error', message: 'Method not allowed.' } });
    return;
  }
  const body = await readBody(req);
  const requested = asString(body.scope || body.model_scope || body.visibility).trim();
  const normalized = normalizeScopeInput(requested);
  if (!normalized) {
    json(res, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Scope must be one of public, private, team, team.<name>, enterprise, community, or personal.'
      }
    });
    return;
  }
  state.modelScope = normalized;
  state.modelCache = undefined;
  state.pendingModelFetch = undefined;
  json(res, 200, scopePayload(getConfig(), `Model scope set to "${normalized}".`));
}

async function route(req, res) {
  const config = getConfig();
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (!authorize(req, config)) {
    json(res, 401, { error: { type: 'authentication_error', message: 'Invalid bridge API token.' } });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      service: 'spilli-api-bridge',
      scope: config.scope,
      team: config.team || null,
      scope_configurable: true,
      dynamic_models: true
    });
    return;
  }
  if ((req.method === 'GET' || req.method === 'POST') && (url.pathname === '/v1/scope' || url.pathname === '/scope')) {
    await handleScope(req, res, config);
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    await handleModels(req, res, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await handleAnthropicMessages(req, res, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    await handleAnthropicCountTokens(req, res, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleOpenAiChatCompletions(req, res, config);
    return;
  }
  json(res, 404, { error: { type: 'not_found_error', message: `No route for ${req.method} ${url.pathname}` } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => errorJson(res, err));
});

loadEnvFiles();
const config = getConfig();
server.listen(config.port, config.host, () => {
  console.log(`SpiLLI API bridge listening at http://${config.host}:${config.port}`);
});
