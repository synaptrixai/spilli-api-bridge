import http from 'node:http';
import crypto from 'node:crypto';
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
const DEFAULT_REQUEST_LOG_PATH = path.join(os.homedir(), '.spilli', 'spilli-api-bridge-requests.jsonl');
const MAX_LOG_STRING_LENGTH = 20_000;
const SPILLI_BACKEND_API_URL = 'https://sig.synaptrix.org';
const SPILLI_AVAILABLE_MODELS_PATH = '/api/getavailablemodels';
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
  modelScope: 'public',
  modelTeam: undefined,
  resourceRunQueues: new Map(),
  lastResolvedModelByScope: new Map(),
  // Maps bridge-managed client session keys to live SpiLLI sessions.
  chatSessions: new Map()
};

function getNamespacedSessionKey(prefix, key) {
  const normalized = typeof key === 'string' ? key.trim() : '';
  return normalized ? `${prefix}:${normalized}` : undefined;
}

function stableBridgeId(prefix, value) {
  const digest = crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function getCodexSessionKey(req) {
  const metaHeader = req.headers['x-codex-turn-metadata'];
  if (!metaHeader) {
    return undefined;
  }

  let meta;
  try {
    meta = typeof metaHeader === 'string' ? JSON.parse(metaHeader) : metaHeader;
  } catch {
    return undefined;
  }

  const windowId = asString(meta?.window_id).trim();
  const sessionId = asString(meta?.session_id).trim();
  const threadId = asString(meta?.thread_id).trim();
  if (!windowId || !sessionId || !threadId) {
    return undefined;
  }

  const key = getNamespacedSessionKey('codex', `${windowId}:${sessionId}:${threadId}`);
  return key
    ? { key, windowId, sessionId, contextId: threadId }
    : undefined;
}

function getClaudeSessionKey(req) {
  const externalId = asString(req.headers['x-claude-code-session-id']).trim();
  const key = getNamespacedSessionKey('claude', externalId);
  return key
    ? {
        key,
        windowId: 'claude-code',
        sessionId: externalId,
        contextId: stableBridgeId('claude-context', externalId)
      }
    : undefined;
}

function getExplicitSessionKey(req) {
  const externalId = asString(req.headers['x-spilli-session-id']).trim();
  const key = getNamespacedSessionKey('spilli', externalId);
  return key
    ? {
        key,
        windowId: 'api-bridge',
        sessionId: externalId,
        contextId: stableBridgeId('api-context', externalId)
      }
    : undefined;
}

/**
 * Determine a client session key from request metadata when the client exposes one.
 *
 * Codex provides `x-codex-turn-metadata` with `window_id`, `session_id`, and
 * `thread_id`. Claude Code provides `x-claude-code-session-id`.
 *
 * @param {import('node:http').IncomingMessage} req - HTTP request
 * @returns {{key:string,windowId:string,sessionId:string,contextId:string}|undefined} Session identity when present
 */
function getSpilliSessionIdentity(req) {
  return getCodexSessionKey(req) ?? getClaudeSessionKey(req) ?? getExplicitSessionKey(req);
}


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

function normalizeResponseMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'raw') {
    return 'raw';
  }
  if (normalized === 'compat') {
    return 'compat';
  }
  console.warn(`Unknown response mode "${value}". Expected raw or compat. Falling back to raw.`);
  return 'raw';
}

function parseModelAliases(value) {
  const aliases = new Map();
  const raw = String(value ?? '').trim();
  if (!raw) {
    return aliases;
  }
  for (const entry of raw.split(/[;,]/)) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = entry.slice(0, index).trim();
    const target = entry.slice(index + 1).trim();
    if (key && target) {
      aliases.set(key, target);
    }
  }
  return aliases;
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
    team: state.modelTeam ?? readEnv('SPILLI_BRIDGE_TEAM'),
    authToken: readEnv('SPILLI_BRIDGE_AUTH_TOKEN'),
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : DEFAULT_TIMEOUT_MS,
    modelCacheTtlMs:
      Number.isFinite(modelCacheTtlMs) && modelCacheTtlMs > 0 ? modelCacheTtlMs : DEFAULT_MODEL_CACHE_TTL_MS,
    nativeCacheDir: readEnv('SPILLI_BRIDGE_NATIVE_CACHE_DIR'),
    modelAliases: parseModelAliases(readEnv('SPILLI_BRIDGE_MODEL_ALIASES')),
    responseMode: normalizeResponseMode(readEnv('SPILLI_BRIDGE_RESPONSE_MODE', 'raw'))
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

function readInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readObject(value) {
  return isRecord(value) ? value : undefined;
}

function extractAllocationMetadata(candidate) {
  if (!isRecord(candidate)) {
    return undefined;
  }
  const directProtocol = readInteger(candidate.allocation_protocol) ?? readInteger(candidate.allocationProtocol);
  const graph = readObject(candidate.graph_v2) ?? readObject(candidate.graphV2) ?? candidate;
  const compatibilityId = readString(graph.compatibility_id) ?? readString(graph.compatibilityId);
  const totalLayers = readInteger(graph.total_layers) ?? readInteger(graph.totalLayers);
  if (directProtocol !== 2 && (!compatibilityId || typeof totalLayers !== 'number')) {
    return undefined;
  }
  const metadata = {
    allocationProtocol:
      directProtocol === 1 || directProtocol === 2
        ? directProtocol
        : compatibilityId && typeof totalLayers === 'number'
          ? 2
          : undefined
  };
  if (compatibilityId && typeof totalLayers === 'number') {
    metadata.graphV2 = {
      compatibilityId,
      totalLayers,
      ...(readString(graph.vertex_type) ?? readString(graph.vertexType)
        ? { vertexType: readString(graph.vertex_type) ?? readString(graph.vertexType) }
        : {}),
      ...(typeof (readInteger(graph.deadline_unix_ms) ?? readInteger(graph.deadlineUnixMs)) === 'number'
        ? { deadlineUnixMs: readInteger(graph.deadline_unix_ms) ?? readInteger(graph.deadlineUnixMs) }
        : {})
    };
  }
  return metadata.allocationProtocol || metadata.graphV2 ? metadata : undefined;
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
          const pipeline = readObject(item.pipeline) ?? readObject(readObject(item.metadata)?.pipeline);
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
            teamName: readString(item.team_name) ?? readString(item.teamName),
            logicalModelId: readString(pipeline?.logical_model_id) ?? readString(pipeline?.logicalModelId),
            compatibilityId: readString(pipeline?.compatibility_id) ?? readString(pipeline?.compatibilityId),
            fragmentStartLayer: readInteger(pipeline?.fragment_start_layer) ?? readInteger(pipeline?.fragmentStartLayer),
            fragmentEndLayer: readInteger(pipeline?.fragment_end_layer) ?? readInteger(pipeline?.fragmentEndLayer),
            totalLayers: readInteger(pipeline?.total_layers) ?? readInteger(pipeline?.totalLayers),
            pipelineProtocolVersion: readInteger(pipeline?.protocol_version) ?? readInteger(pipeline?.protocolVersion),
            allocationMetadata:
              extractAllocationMetadata(item) ??
              extractAllocationMetadata(pipeline) ??
              extractAllocationMetadata(readObject(item.metadata)?.pipeline)
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
  const rawName = (model.logicalModelId || model.resourceId || model.modelName || model.assetName || '').trim();
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

function parseScopedCatalogModelName(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return { name: '' };
  }
  const match = trimmed.match(/^(?<name>.+)\.(?<visibility>public|private|team|enterprise)(?:\.(?<teamName>.+))?$/);
  if (!match?.groups) {
    return { name: trimmed };
  }
  const name = match.groups.name?.trim();
  const visibility = match.groups.visibility?.trim();
  const teamName = match.groups.teamName?.trim();
  if (!name || !visibility) {
    return { name: trimmed };
  }
  return {
    name,
    visibility:
      visibility === 'team' && teamName === '*'
        ? 'enterprise'
        : visibility === 'team' && teamName
          ? `team.${teamName}`
          : visibility,
    teamName: teamName === '*' ? undefined : teamName
  };
}

function catalogModelMatchesScope(visibility, teamName, requestedScope, requestedTeam) {
  const requestedBaseScope = getBaseScope(requestedScope);
  if (!requestedBaseScope) {
    return true;
  }
  const modelBaseScope = getBaseScope(visibility);
  if (!modelBaseScope) {
    return true;
  }
  if (modelBaseScope !== requestedBaseScope) {
    return false;
  }
  if (requestedBaseScope !== 'team') {
    return true;
  }
  const targetTeam = normalizeTeamName(getTeamNameFromScope(requestedScope) ?? requestedTeam);
  if (!targetTeam) {
    return true;
  }
  const modelTeam = normalizeTeamName(getTeamNameFromScope(visibility) ?? teamName);
  return !modelTeam || modelTeam === targetTeam;
}

function normalizePublicCatalogModels(response, config) {
  const raw = Array.isArray(response?.models)
    ? response.models
    : Array.isArray(response?.data)
      ? response.data
      : [];
  const models = [];
  const dedupe = new Set();
  for (const item of raw) {
    if (typeof item === 'string') {
      const parsed = parseScopedCatalogModelName(item);
      if (!parsed.name || dedupe.has(parsed.name)) {
        continue;
      }
      if (!catalogModelMatchesScope(parsed.visibility, parsed.teamName, config.scope, config.team)) {
        continue;
      }
      dedupe.add(parsed.name);
      models.push({
        uid: parsed.name,
        displayName: parsed.name
      });
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const rawName = readString(item.model) ?? readString(item.name) ?? readString(item.id);
    if (!rawName) {
      continue;
    }
    const parsed = parseScopedCatalogModelName(rawName);
    if (!parsed.name || dedupe.has(parsed.name)) {
      continue;
    }
    const visibility =
      readString(item.visibility) ??
      readString(item.visibility_scope) ??
      readString(item.visibilityScope) ??
      readString(item.scope) ??
      parsed.visibility;
    const teamName = readString(item.team_name) ?? readString(item.teamName) ?? parsed.teamName;
    if (!catalogModelMatchesScope(visibility, teamName, config.scope, config.team)) {
      continue;
    }
    const displayName =
      readString(item.display_name) ??
      readString(item.displayName) ??
      readString(item.label) ??
      readString(item.friendly_name) ??
      readString(item.friendlyName);
    const allocationMetadata =
      extractAllocationMetadata(item) ??
      extractAllocationMetadata(readObject(item.pipeline)) ??
      extractAllocationMetadata(readObject(item.metadata)?.pipeline);
    dedupe.add(parsed.name);
    models.push({
      uid: parsed.name,
      displayName: displayName && displayName !== parsed.name ? displayName : parsed.name,
      ...(allocationMetadata ? { allocationMetadata } : {})
    });
  }
  return models;
}

function isHashedModelUid(uid) {
  return /^gguf:(?:sha256|fastsha256|fasthash256):/i.test(uid);
}

function finalizeModelCatalog(config, models) {
  const sortedModels = [...models].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  );
  const displayNameCounts = new Map();
  for (const model of sortedModels) {
    displayNameCounts.set(model.displayName, (displayNameCounts.get(model.displayName) ?? 0) + 1);
  }
  for (const model of sortedModels) {
    model.apiName =
      (displayNameCounts.get(model.displayName) ?? 0) > 1
        ? `${model.displayName} [${model.uid}]`
        : model.displayName;
  }
  return {
    scope: config.scope,
    team: config.team,
    models: sortedModels,
    fetchedAt: new Date().toISOString()
  };
}

async function fetchHostInventoryModels(config, pemContent) {
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
      if (!existing.allocationMetadata && model.allocationMetadata) {
        existing.allocationMetadata = model.allocationMetadata;
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
  return [...byUid.values()];
}

function mergePublicModels(hostModels, catalogModels) {
  const byUid = new Map(hostModels.map(model => [model.uid, { ...model }]));
  for (const model of catalogModels) {
    const existing = byUid.get(model.uid);
    const displayName = existing?.displayName || model.displayName || model.uid;
    if (isHashedModelUid(model.uid) && !displayName) {
      continue;
    }
    byUid.set(model.uid, {
      uid: model.uid,
      displayName,
      count: existing?.count ?? 0,
      ...((existing?.allocationMetadata ?? model.allocationMetadata)
        ? { allocationMetadata: existing?.allocationMetadata ?? model.allocationMetadata }
        : {})
    });
  }
  return [...byUid.values()].filter(model => !isHashedModelUid(model.uid) || model.displayName !== model.uid || model.count > 0);
}

async function fetchAvailableModels(config, { forceRefresh = false } = {}) {
  const cacheKey = catalogCacheKey(config);
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
    const hostModels = await fetchHostInventoryModels(config, pemContent);
    let models = hostModels;
    if (getBaseScope(config.scope) === 'public') {
      const modelsUrl = buildApiUrl(SPILLI_BACKEND_API_URL, SPILLI_AVAILABLE_MODELS_PATH).toString();
      const response = await requestJsonWithPem(modelsUrl, { scope: 'public' }, pemContent);
      const publicCatalogModels = normalizePublicCatalogModels(response, config);
      // Match the extension: the public signaling catalog already collapses
      // physical fragments into a logical model list. Host inventory is only
      // used as enrichment/availability proof, not as extra selectable entries.
      const catalogModelsWithLabels = publicCatalogModels.filter(
        model => !isHashedModelUid(model.uid) || model.displayName
      );
      models = catalogModelsWithLabels.map(model => ({
        ...model,
        count: hostModels.find(hostModel => hostModel.uid === model.uid)?.count ?? 0,
        ...((hostModels.find(hostModel => hostModel.uid === model.uid)?.allocationMetadata ?? model.allocationMetadata)
          ? {
              allocationMetadata:
                hostModels.find(hostModel => hostModel.uid === model.uid)?.allocationMetadata ?? model.allocationMetadata
            }
          : {})
      }));
    }
    const catalog = finalizeModelCatalog(config, models);
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

function resolveModelFromCatalog(requestedModel, catalog, modelAliases = new Map()) {
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
  for (const [alias, target] of modelAliases.entries()) {
    if (normalizeModelLookupName(alias) !== normalized) {
      continue;
    }
    const resolved = resolveModelFromCatalog(target, catalog, new Map());
    return {
      ...resolved,
      requestedAlias: requested
    };
  }
  const available = catalog.models.map(model => model.apiName).join(', ');
  throw Object.assign(new Error(`Unknown model "${requested}". Available ${catalog.scope} models: ${available}`), {
    statusCode: 404
  });
}

async function resolveRequestedModel(requestedModel, config) {
  let catalog = await fetchAvailableModels(config);
  const cacheKey = catalogCacheKey(config);
  try {
    const resolved = resolveModelFromCatalog(requestedModel, catalog, config.modelAliases);
    state.lastResolvedModelByScope.set(cacheKey, resolved);
    return resolved;
  } catch (err) {
    if (err?.statusCode !== 404) {
      throw err;
    }
    catalog = await fetchAvailableModels(config, { forceRefresh: true });
    try {
      const resolved = resolveModelFromCatalog(requestedModel, catalog, config.modelAliases);
      state.lastResolvedModelByScope.set(cacheKey, resolved);
      return resolved;
    } catch (refreshedErr) {
      if (refreshedErr?.statusCode === 404 && isBridgeBuiltInModelName(requestedModel)) {
        const fallback = state.lastResolvedModelByScope.get(cacheKey) ?? catalog.models[0];
        if (fallback) {
          console.warn(`Mapping built-in bridge model alias "${requestedModel}" to SpiLLI model "${fallback.apiName}".`);
          return fallback;
        }
      }
      throw refreshedErr;
    }
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
    value.type === 'function_call' || value.type === 'custom_tool_call' || typeof value.call_id === 'string' || typeof value.arguments !== 'undefined'
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
    typeof value.args !== 'undefined'
      ? value.args
      : typeof value.arguments !== 'undefined'
        ? value.arguments
        : value.type === 'custom_tool_call'
          ? value.input
          : undefined
  );
  const input = value.type === 'custom_tool_call' && typeof value.input === 'string' ? value.input : args;
  return { id: callId, name: toolName, input };
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

function normalizeToolNameForLookup(value) {
  return asString(value).trim().toLowerCase();
}

function catalogCacheKey(config) {
  return `${config.keyPath}|${config.scope}|${config.team}`;
}

function isBridgeBuiltInModelName(value) {
  const modelName = asString(value).trim();
  return /^(claude[-_]|gpt[-_]|chatgpt[-_]|codex[-_]|o[1345](?:[-_]|$))/i.test(modelName);
}

function extractAvailableToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map(tool => (isRecord(tool) ? asString(tool.name || tool.function?.name).trim() : ''))
    .filter(Boolean);
}

function extractResponsesToolTypes(tools) {
  const types = {};
  if (!Array.isArray(tools)) {
    return types;
  }
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const name = asString(tool.name || tool.function?.name).trim();
    if (!name) {
      continue;
    }
    types[normalizeToolNameForLookup(name)] = asString(tool.type || 'function').trim().toLowerCase() || 'function';
  }
  return types;
}

function resolveAllowedToolName(name, allowedToolNames = []) {
  const trimmed = asString(name).trim();
  if (!trimmed) {
    return undefined;
  }
  const aliases = new Map([
    ['shell', 'Bash'],
    ['terminal', 'Bash']
  ]);
  const preferred = aliases.get(normalizeToolNameForLookup(trimmed)) ?? trimmed;
  if (!allowedToolNames.length) {
    return preferred;
  }
  const normalized = normalizeToolNameForLookup(preferred);
  return allowedToolNames.find(candidate => normalizeToolNameForLookup(candidate) === normalized);
}

function formatPseudoToolPrompt(name, input) {
  if (typeof input === 'string' && input.trim()) {
    return input.trim();
  }
  if (!isRecord(input)) {
    return `Complete the requested ${name} task.`;
  }
  const directPrompt = asString(input.prompt || input.query || input.task || input.instruction || input.instructions).trim();
  const pathText = asString(input.path || input.cwd || input.directory).trim();
  const breadth = asString(input.breadth).trim();
  const parts = [];
  if (directPrompt) {
    parts.push(directPrompt);
  }
  if (pathText) {
    parts.push(`Work under path: ${pathText}`);
  }
  if (breadth) {
    parts.push(`Breadth: ${breadth}`);
  }
  return parts.length ? parts.join('\n') : `Complete the requested ${name} task with input: ${JSON.stringify(input)}`;
}

function pseudoToolBaseName(name) {
  return normalizeToolNameForLookup(name).split(/[:\s]/)[0];
}

function pseudoToolDescription(name, input) {
  const normalized = pseudoToolBaseName(name);
  return (
    asString(input?.description || input?.title || input?.query || input?.prompt).trim() ||
    (asString(name).includes(':') ? asString(name).slice(asString(name).indexOf(':') + 1).trim() : '') ||
    (normalized === 'explore' ? 'Explore workspace' : 'Run delegated task')
  ).slice(0, 80);
}

function normalizeAgentToolInput(call) {
  const input = call.input;
  if (isRecord(input) && typeof input.description === 'string' && typeof input.prompt === 'string') {
    return input;
  }
  const normalized = pseudoToolBaseName(call.name);
  const subagentType =
    isRecord(input) && typeof input.subagent_type === 'string'
      ? input.subagent_type
      : normalized === 'explore'
        ? 'Explore'
        : 'general-purpose';
  return {
    description: pseudoToolDescription(call.name, input),
    prompt: formatPseudoToolPrompt(call.name, input),
    subagent_type: subagentType
  };
}

function aliasPseudoToolCall(call, allowedToolNames = []) {
  const pseudoName = pseudoToolBaseName(call.name);
  const agentToolName = resolveAllowedToolName('Agent', allowedToolNames);
  if (agentToolName && ['agent', 'explore', 'search', 'browse'].includes(pseudoName)) {
    return {
      ...call,
      name: agentToolName,
      input: normalizeAgentToolInput(call)
    };
  }
  const taskToolName = resolveAllowedToolName('Task', allowedToolNames);
  if (taskToolName && ['agent', 'explore', 'search', 'browse'].includes(pseudoName)) {
    return {
      ...call,
      name: taskToolName,
      input: {
        description: pseudoToolDescription(call.name, call.input),
        prompt: formatPseudoToolPrompt(call.name, call.input),
        subagent_type: pseudoName === 'explore' ? 'Explore' : 'general-purpose'
      }
    };
  }
  return undefined;
}

function sanitizeToolInput(name, input) {
  if (!isRecord(input)) {
    return input;
  }
  const normalizedName = normalizeToolNameForLookup(name);
  const sanitized = { ...input };
  if (normalizedName === 'read') {
    delete sanitized.lines;
    delete sanitized.line;
  }
  if (normalizedName === 'agent') {
    delete sanitized.callId;
    delete sanitized.call_id;
  }
  return sanitized;
}

function normalizeToolCallForAllowedTools(call, allowedToolNames = []) {
  const allowedName = resolveAllowedToolName(call.name, allowedToolNames);
  if (allowedName) {
    const normalized = { ...call, name: allowedName };
    const input = normalizeToolNameForLookup(allowedName) === 'agent'
      ? normalizeAgentToolInput(normalized)
      : normalized.input;
    return { ...normalized, input: sanitizeToolInput(allowedName, input) };
  }
  const aliased = aliasPseudoToolCall(call, allowedToolNames);
  return aliased ? { ...aliased, input: sanitizeToolInput(aliased.name, aliased.input) } : undefined;
}


function extractJsonObjectAt(text, startIndex) {
  let start = -1;
  for (let i = startIndex; i < text.length; i += 1) {
    if (text[i] === '{') {
      start = i;
      break;
    }
    if (!/\s/.test(text[i])) {
      return undefined;
    }
  }
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
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
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function collectLooseToolAssignments(raw, calls) {
  const text = String(raw ?? '');
  const regex = /(?:to=([A-Za-z_][\w.-]*)\s+)?toolName\s*=\s*["']?([A-Za-z_][\w.-]*)["']?\s+args\s*=\s*/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = asString(match[2] || match[1]).trim();
    if (!name) {
      continue;
    }
    const jsonText = extractJsonObjectAt(text, regex.lastIndex);
    if (!jsonText) {
      continue;
    }
    const args = tryParseJson(jsonText);
    calls.push({
      id: `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name,
      input: isRecord(args) ? args : jsonText
    });
  }
}

function parseToolCallsFromOutput(raw, allowedToolNames = []) {
  const calls = [];
  const parsedHarmony = parseHarmonyOutput(raw);
  if (parsedHarmony.isHarmony) {
    for (const segment of parsedHarmony.messages) {
      const hasRecipient = typeof segment.recipient === 'string' && segment.recipient.trim();
      const isToolish = segment.terminator === 'call' || (hasRecipient && segment.terminator === 'end');
      if (!isToolish) {
        continue;
      }
      const parsed = tryParseJson(segment.content.trim());
      const parsedContent = isRecord(parsed) ? parsed : {};
      const rawName = asString(parsedContent.toolName || segment.recipient).trim();
      if (!rawName) {
        continue;
      }
      const input = isRecord(parsedContent.args)
        ? {
            ...parsedContent.args,
            ...(typeof parsedContent.subagent_type === 'string' ? { subagent_type: parsedContent.subagent_type } : {}),
            ...(typeof parsedContent.description === 'string' ? { description: parsedContent.description } : {}),
            ...(typeof parsedContent.prompt === 'string' ? { prompt: parsedContent.prompt } : {})
          }
        : isRecord(parsed)
          ? parsedContent
          : segment.content.trim();
      calls.push({
        id:
          asString(parsedContent.callId).trim() ||
          `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name: rawName,
        input
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
  collectLooseToolAssignments(raw, calls);
  const seen = new Set();
  const normalizedCalls = [];
  for (const call of calls) {
    const normalizedCall = normalizeToolCallForAllowedTools(call, allowedToolNames);
    if (!normalizedCall) {
      continue;
    }
    const key = `${normalizedCall.name}|${JSON.stringify(normalizedCall.input ?? {})}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedCalls.push(normalizedCall);
  }
  return normalizedCalls;
}

function stripDisplaySections(text) {
  const normalized = text.trim();
  const finalMatch = normalized.match(/^(?:#+\s*)?Final Response\s*\n([\s\S]*?)(?:\n\s*(?:#+\s*)?(?:Analysis|Tool Calls|Tool Results|Commentary)\s*\n[\s\S]*)?$/i);
  return finalMatch?.[1]?.trim() || normalized;
}

function stripHarmonyControlTokens(text) {
  return String(text ?? '')
    .replace(/<\|(?:start|end|call|return|channel|message|constrain)\|>/g, '')
    .replace(/\[EOG\]\s*$/g, '')
    .trim();
}

function extractHarmonyChannelText(raw, channelName) {
  const text = String(raw ?? '');
  const channelToken = '<|channel|>';
  const messageToken = '<|message|>';
  const wanted = channelName.toLowerCase();
  let cursor = 0;
  let found;

  while (cursor < text.length) {
    const channelAt = text.indexOf(channelToken, cursor);
    if (channelAt < 0) {
      break;
    }
    const channelStart = channelAt + channelToken.length;
    const messageAt = text.indexOf(messageToken, channelStart);
    if (messageAt < 0) {
      break;
    }
    const channelHeader = text.slice(channelStart, messageAt).trim().toLowerCase();
    const channel = channelHeader.split(/\s+/)[0];
    const contentStart = messageAt + messageToken.length;
    const terminators = ['<|end|>', '<|call|>', '<|return|>', '<|start|>', '<|channel|>']
      .map(token => text.indexOf(token, contentStart))
      .filter(index => index >= 0);
    const contentEnd = terminators.length > 0 ? Math.min(...terminators) : text.length;

    if (channel === wanted) {
      found = stripHarmonyControlTokens(text.slice(contentStart, contentEnd));
    }

    cursor = contentEnd > contentStart ? contentEnd : messageAt + messageToken.length;
  }

  return typeof found === 'string' ? found : undefined;
}

function extractHarmonyFinalText(raw) {
  const parsed = parseHarmonyOutput(raw);
  if (parsed.isHarmony) {
    const parsedFinal = parsed.messages
      .filter(segment => asString(segment.channel).trim().split(/\s+/)[0] === 'final')
      .map(segment => stripHarmonyControlTokens(segment.content))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (parsedFinal) {
      return parsedFinal;
    }
  }
  return extractHarmonyChannelText(raw, 'final');
}

function renderText(raw, toolCalls) {
  const rendered = renderHarmonyForDisplay(raw);
  if (toolCalls.length > 0) {
    const text = extractHarmonyFinalText(raw) ?? (rendered.isHarmony ? '' : raw);
    const trimmed = stripHarmonyControlTokens(stripDisplaySections(text));
    if (!trimmed.startsWith('{') && !trimmed.startsWith('```json')) {
      return trimmed;
    }
    return '';
  }
  const text = extractHarmonyFinalText(raw) ?? (rendered.isHarmony ? '' : stripDisplaySections(rendered.display));
  return stripHarmonyControlTokens(text);
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

const NO_TOOLS_PROMPT = [
  'No external tools are available in this API request.',
  'Do not emit tool calls, function calls, Harmony recipient calls, or pseudo-tool invocations.',
  'Do not call Explore, Agent, Read, Write, Edit, Bash, TodoWrite, WebFetch, or any other tool name.',
  'Answer directly in final text and produce any requested artifact inline.'
].join(' ');

function formatToolsForPrompt(tools, { includeSchemas = true } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return NO_TOOLS_PROMPT;
  }
  const toolNames = extractAvailableToolNames(tools);
  const lines = [
    'Tools are available. When you need a tool, respond with a tool call rather than final prose.',
    `Use only these exact tool names: ${toolNames.join(', ')}.`,
    'For broad workspace exploration, use the exact Agent tool with subagent_type "Explore" when Agent is available; otherwise use the available file/search tools directly.',
    'Do not invent separate Explore or Task tools unless those exact names appear above.',
    'Tool call JSON shape: {"toolName":"exact_tool_name","callId":"optional-id","args":{...}}',
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
    if (!includeSchemas) {
      const summary = description.replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`- ${name}: ${summary || 'No description'}`);
      continue;
    }
    const schema = tool.input_schema || tool.parameters || tool.function?.parameters || {};
    lines.push(`- ${name}: ${description || 'No description'} Schema: ${JSON.stringify(schema)}`);
  }
  return lines.join('\n');
}

function hashHistoryValue(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function messageText(role, content) {
  const normalizedRole = asString(role || 'user').trim().toUpperCase() || 'USER';
  return `${normalizedRole}:\n${content}`;
}

function createHistoryItem(role, content) {
  const normalizedRole = ['assistant', 'system'].includes(asString(role).trim().toLowerCase())
    ? asString(role).trim().toLowerCase()
    : 'user';
  const normalizedContent = asString(content);
  const text = messageText(normalizedRole, normalizedContent);
  return {
    role: normalizedRole,
    content: normalizedContent,
    text,
    hash: hashHistoryValue(text)
  };
}

function createHistoryState({ requestedModel, prompt, historyItems, allowDelta = true }) {
  const items = Array.isArray(historyItems) ? historyItems.filter(item => item?.text) : [];
  return {
    requestedModel: asString(requestedModel).trim(),
    prompt: asString(prompt),
    promptHash: hashHistoryValue(asString(prompt)),
    historyItems: items,
    historyHashes: items.map(item => item.hash),
    allowDelta,
    query: items.map(item => item.text).join('\n\n')
  };
}

function normalizeOpenAiChatMessageContent(message) {
  const parts = [normalizeContent(message?.content)];
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call)) {
        continue;
      }
      const functionName = asString(call.function?.name).trim() || 'function';
      const args = asString(call.function?.arguments).trim();
      parts.push(`Tool call ${functionName}(${args})`);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function buildHistoryStateForAnthropic(body) {
  // Claude Code already supplies extensive tool guidance in its system prompt.
  // Keep names and short descriptions for the local model without duplicating
  // every JSON schema into the model context.
  const prompt = [
    normalizeSystem(body.system),
    formatToolsForPrompt(body.tools, { includeSchemas: false })
  ].filter(Boolean).join('\n\n');
  const historyItems = Array.isArray(body.messages)
    ? body.messages
        .map(message => {
          if (!isRecord(message)) {
            return undefined;
          }
          return createHistoryItem(asString(message.role) || 'user', normalizeContent(message.content));
        })
        .filter(Boolean)
    : [];
  return createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems
  });
}

function anthropicToSpilliPayload(body) {
  const historyState = buildHistoryStateForAnthropic(body);
  return {
    requestedModel: historyState.requestedModel,
    prompt: historyState.prompt,
    query: historyState.query
  };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(asString(text).length / 4));
}

function openAiToSpilliPayload(body) {
  const historyState = buildHistoryStateForOpenAiChat(body);
  return {
    requestedModel: historyState.requestedModel,
    prompt: historyState.prompt,
    query: historyState.query
  };
}

function buildHistoryStateForOpenAiChat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = [
    messages
      .filter(message => isRecord(message) && message.role === 'system')
      .map(message => normalizeContent(message.content))
      .filter(Boolean)
      .join('\n\n'),
    formatToolsForPrompt(body.tools)
  ]
    .filter(Boolean)
    .join('\n\n');
  const historyItems = messages
    .filter(message => isRecord(message) && message.role !== 'system')
    .map(message => createHistoryItem(asString(message.role || 'user'), normalizeOpenAiChatMessageContent(message)));
  return createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems
  });
}

function stripEogMarkers(value) {
  return String(value ?? '').replace(/\[EOG\]/g, '');
}

function extractSpilliHostError(value) {
  const text = String(value ?? '');
  const match = text.match(/\|<error>\|([\s\S]*?)\|<\/error>\|/);
  return match ? match[1].trim() || 'SpiLLIHost returned an unspecified error.' : '';
}

function createSpilliHostRunError(raw) {
  const message = extractSpilliHostError(raw);
  if (!message) return undefined;
  return Object.assign(new Error(message), {
    statusCode: 502,
    code: 'SPILLI_HOST_RUN_ERROR',
    rawHostResponse: String(raw ?? '')
  });
}

function createStreamChunkForwarder(onChunk) {
  const marker = '[EOG]';
  let ended = false;
  let pending = '';
  return {
    onChunk(chunk) {
      if (!onChunk || ended) {
        return;
      }
      const text = String(chunk ?? '');
      if (!text) {
        return;
      }
      const combined = pending + text;
      const eogIndex = combined.indexOf(marker);
      if (eogIndex >= 0) {
        const safeText = combined.slice(0, eogIndex);
        if (safeText) {
          onChunk(safeText);
        }
        pending = '';
        ended = true;
        return;
      }
      const keep = Math.min(marker.length - 1, combined.length);
      const safeText = combined.slice(0, combined.length - keep);
      pending = combined.slice(combined.length - keep);
      if (safeText) {
        onChunk(safeText);
      }
    },
    flush() {
      if (!onChunk || ended || !pending) {
        return;
      }
      onChunk(pending);
      pending = '';
    }
  };
}

function createMarkerFilteringForwarder(onChunk, marker) {
  let pending = '';
  let blocked = false;
  return {
    onChunk(chunk) {
      if (!onChunk || blocked) return;
      const combined = pending + String(chunk ?? '');
      if (combined.includes(marker)) {
        pending = '';
        blocked = true;
        return;
      }
      // Retain enough leading text to suppress the host's surrounding |<error>| envelope too.
      const keep = Math.min(marker.length + 32, combined.length);
      const ready = combined.slice(0, combined.length - keep);
      pending = combined.slice(combined.length - keep);
      if (ready) onChunk(ready);
    },
    flush() {
      if (!onChunk || blocked || !pending) return;
      onChunk(pending);
      pending = '';
    }
  };
}

function resourceCacheKey(resource) {
  const graphKey = resource.graph_v2
    ? [
        resource.graph_v2.compatibility_id,
        resource.graph_v2.total_layers,
        resource.graph_v2.vertex_type ?? '',
        resource.graph_v2.deadline_unix_ms ?? ''
      ].join(':')
    : '';
  return [
    resource.model,
    resource.scope ?? '',
    resource.team ?? '',
    resource.allocation_protocol ?? '',
    graphKey
  ].join('|');
}

function buildResource(resolvedModel, config) {
  const resource = { model: resolvedModel.uid, scope: config.scope };
  if (config.team) {
    resource.team = config.team;
  }
  if (resolvedModel.allocationMetadata?.allocationProtocol) {
    resource.allocation_protocol = resolvedModel.allocationMetadata.allocationProtocol;
  }
  if (resolvedModel.allocationMetadata?.graphV2) {
    resource.graph_v2 = {
      compatibility_id: resolvedModel.allocationMetadata.graphV2.compatibilityId,
      total_layers: resolvedModel.allocationMetadata.graphV2.totalLayers,
      ...(resolvedModel.allocationMetadata.graphV2.vertexType
        ? { vertex_type: resolvedModel.allocationMetadata.graphV2.vertexType }
        : {}),
      ...(resolvedModel.allocationMetadata.graphV2.deadlineUnixMs
        ? { deadline_unix_ms: resolvedModel.allocationMetadata.graphV2.deadlineUnixMs }
        : {})
    };
  }
  return resource;
}

function historyHashesHavePrefix(historyHashes, prefixHashes) {
  if (!Array.isArray(historyHashes) || !Array.isArray(prefixHashes)) {
    return false;
  }
  if (prefixHashes.length > historyHashes.length) {
    return false;
  }
  for (let index = 0; index < prefixHashes.length; index += 1) {
    if (historyHashes[index] !== prefixHashes[index]) {
      return false;
    }
  }
  return true;
}

function historyItemToContextMessage(item) {
  return {
    role: item.role,
    content: item.content
  };
}

function createSpilliContext(identity, resourceKey, revision, transferMode, recentItems = []) {
  return {
    version: 1,
    window_id: identity.windowId,
    session_id: identity.sessionId,
    context_id: identity.contextId,
    context_revision: revision,
    transfer_mode: transferMode,
    resource_key: resourceKey,
    allow_cross_job_context_reuse: true,
    delta_messages: transferMode === 'delta' ? [] : undefined,
    recent_messages: transferMode === 'hydrate'
      ? recentItems.map(historyItemToContextMessage)
      : undefined
  };
}

function createRunPayloadFromHistory(historyState, queryItems, context, hydrateContext) {
  return {
    requestedModel: historyState.requestedModel,
    prompt: historyState.prompt,
    query: queryItems.map(item => item.text).join('\n\n'),
    spilliContext: context,
    hydrateContext
  };
}

function summarizeHistoryState(historyState) {
  return {
    requestedModel: historyState?.requestedModel ?? null,
    promptLength: historyState?.prompt?.length ?? 0,
    promptHash: historyState?.promptHash ?? null,
    historyItemCount: Array.isArray(historyState?.historyItems) ? historyState.historyItems.length : 0,
    historyHashCount: Array.isArray(historyState?.historyHashes) ? historyState.historyHashes.length : 0,
    allowDelta: historyState?.allowDelta === true,
    queryLength: historyState?.query?.length ?? 0,
    firstHistoryHash: Array.isArray(historyState?.historyHashes) && historyState.historyHashes.length > 0
      ? historyState.historyHashes[0]
      : null,
    lastHistoryHash: Array.isArray(historyState?.historyHashes) && historyState.historyHashes.length > 0
      ? historyState.historyHashes[historyState.historyHashes.length - 1]
      : null
  };
}

function summarizeSessionEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    initialized: entry.initialized === true,
    revision: Number.isInteger(entry.revision) ? entry.revision : null,
    resourceKey: entry.resourceKey ?? null,
    promptHash: entry.promptHash ?? null,
    historyHashCount: Array.isArray(entry.historyHashes) ? entry.historyHashes.length : 0,
    lastHistoryHash: Array.isArray(entry.historyHashes) && entry.historyHashes.length > 0
      ? entry.historyHashes[entry.historyHashes.length - 1]
      : null,
    sessionLive: entry.session?.isLive?.() === true,
    identity: entry.identity
      ? {
          key: entry.identity.key ?? null,
          windowId: entry.identity.windowId ?? null,
          sessionId: entry.identity.sessionId ?? null,
          contextId: entry.identity.contextId ?? null
        }
      : null
  };
}

function summarizeContextPayload(context) {
  if (!context) {
    return null;
  }
  return {
    version: context.version ?? null,
    windowId: context.window_id ?? null,
    sessionId: context.session_id ?? null,
    contextId: context.context_id ?? null,
    contextRevision: context.context_revision ?? null,
    transferMode: context.transfer_mode ?? null,
    resourceKey: context.resource_key ?? null,
    recentMessageCount: Array.isArray(context.recent_messages) ? context.recent_messages.length : 0,
    deltaMessageCount: Array.isArray(context.delta_messages) ? context.delta_messages.length : 0
  };
}

function prepareSessionRunPayload(historyState, previousEntry, resourceKey, identity = undefined) {
  const previousHashes = previousEntry?.historyHashes ?? [];
  const canUseDelta =
    previousEntry?.initialized === true &&
    previousEntry?.session?.isLive?.() &&
    previousEntry.promptHash === historyState.promptHash &&
    previousEntry.resourceKey === resourceKey &&
    historyState.allowDelta &&
    historyState.historyHashes.length > previousHashes.length &&
    historyHashesHavePrefix(historyState.historyHashes, previousHashes);
  const contextIdentity = identity ?? previousEntry?.identity ?? {
    windowId: 'api-bridge',
    sessionId: 'untracked-session',
    contextId: 'untracked-context'
  };
  const revision = Math.max(0, previousEntry?.revision ?? 0) + 1;
  const queryItems = canUseDelta
    ? historyState.historyItems.slice(previousHashes.length)
    : historyState.historyItems.slice(-1);
  const hydratedItems = historyState.historyItems.slice(0, Math.max(0, historyState.historyItems.length - queryItems.length));
  const transferMode = canUseDelta ? 'delta' : 'hydrate';
  const hydrateContext = createSpilliContext(
    contextIdentity,
    resourceKey,
    revision,
    'hydrate',
    hydratedItems
  );
  return {
    reused: Boolean(canUseDelta),
    reason: canUseDelta ? 'append' : previousEntry?.session?.isLive?.() ? 'replace' : 'new',
    revision,
    transferMode,
    payload: createRunPayloadFromHistory(
      historyState,
      queryItems,
      transferMode === 'delta'
        ? createSpilliContext(contextIdentity, resourceKey, revision, 'delta')
        : hydrateContext,
      hydrateContext
    )
  };
}

function shouldReuseTransport(previousEntry, prepared, resourceKey) {
  return (
    prepared.transferMode === 'delta' &&
    previousEntry?.session?.isLive?.() &&
    previousEntry.resourceKey === resourceKey
  );
}

function assistantHistoryItemForAnthropic(message) {
  return createHistoryItem('assistant', normalizeContent(message?.content));
}

function assistantHistoryItemForOpenAiChat(message) {
  return createHistoryItem('assistant', normalizeOpenAiChatMessageContent(message));
}

function createResponsesHistoryItem(item) {
  const text = responsesInputItemToText(item);
  if (!text) return undefined;
  const explicitRole = responsesInputItemRole(item);
  const itemType = isRecord(item) ? asString(item.type) : '';
  const role = explicitRole === 'assistant' || itemType === 'function_call' || itemType === 'custom_tool_call'
    ? 'assistant'
    : 'user';
  const prefix = `${role.toUpperCase()}:\n`;
  return createHistoryItem(role, text.startsWith(prefix) ? text.slice(prefix.length) : text);
}

function assistantHistoryItemsForResponses(output) {
  return Array.isArray(output)
    ? output.map(createResponsesHistoryItem).filter(Boolean)
    : [];
}

async function withResourceRunQueue(resource, callback) {
  const key = resourceCacheKey(resource);
  const previous = state.resourceRunQueues.get(key) ?? Promise.resolve();
  let release;
  const current = previous.catch(() => undefined).then(() => callback());
  release = current.finally(() => {
    if (state.resourceRunQueues.get(key) === release) {
      state.resourceRunQueues.delete(key);
    }
  });
  state.resourceRunQueues.set(key, release);
  return current;
}

// Run inference using an already created SpiLLI session.
async function runInference(
  { requestedModel, prompt, query, spilliContext, hydrateContext },
  config,
  streamOptions = {},
  session,
  resolvedModelOverride
) {
  const resolvedModel = resolvedModelOverride ?? await resolveRequestedModel(requestedModel, config);
  const resource = buildResource(resolvedModel, config);
  const apiModelName = requestedModel || resolvedModel.displayName;
  return withResourceRunQueue(resource, async () => {
    const activeSession = session?.isLive?.() ? session : undefined;
    if (!activeSession?.isLive?.()) {
      throw Object.assign(new Error('SpiLLI model session is not live.'), { statusCode: 503 });
    }
    streamOptions.onStart?.({ requestedModel: apiModelName, resolvedModel });
    const runOnce = async (context, suppressContextMiss) => {
      const attemptSummary = {
        requestedModel: apiModelName,
        resourceKey: resourceCacheKey(resource),
        promptLength: prompt.length,
        queryLength: query.length,
        context: summarizeContextPayload(context),
        hydrateContext: summarizeContextPayload(hydrateContext),
        suppressContextMiss
      };
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.run.start',
        run: attemptSummary
      }, 'RUN');
      const runOptions = { timeoutMs: config.requestTimeoutMs };
      const streamForwarder =
        typeof streamOptions.onChunk === 'function' ? createStreamChunkForwarder(streamOptions.onChunk) : undefined;
      const hostOutputForwarder = streamForwarder
        ? createMarkerFilteringForwarder(chunk => streamForwarder.onChunk(chunk), '|<error>|')
        : undefined;
      if (streamForwarder) {
        runOptions.onChunk = chunk => {
          hostOutputForwarder.onChunk(chunk);
        };
      }
      let raw;
      try {
        raw = stripEogMarkers(await activeSession.run(
          { prompt, query, spilli_context: context },
          runOptions
        ));
      } catch (error) {
        await appendLog({
          timestamp: new Date().toISOString(),
          kind: 'spilli.run.error',
          run: attemptSummary,
          error: errorSummary(error)
        }, 'RUN');
        throw error;
      }
      hostOutputForwarder?.flush();
      streamForwarder?.flush();
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.run.complete',
        run: {
          ...attemptSummary,
          rawLength: raw.length,
          hasContextMiss: raw.includes('SPILLI_CONTEXT_MISS'),
          rawPreview: raw.slice(0, 4000)
        }
      }, 'RUN');
      return raw;
    };

    let raw = await runOnce(spilliContext, spilliContext?.transfer_mode === 'delta');
    if (spilliContext?.transfer_mode === 'delta' && raw.includes('SPILLI_CONTEXT_MISS')) {
      raw = await runOnce(hydrateContext, false);
    }
    const hostError = createSpilliHostRunError(raw);
    if (hostError) {
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.run.host_error',
        run: {
          requestedModel: apiModelName,
          resourceKey: resourceCacheKey(resource),
          transferMode: spilliContext?.transfer_mode ?? null,
          error: hostError.message,
          rawHostResponse: hostError.rawHostResponse
        }
      }, 'RUN');
      throw hostError;
    }
    return {
      raw,
      requestedModel: apiModelName,
      resolvedModel,
      session: activeSession
    };
  });
}

async function getOrCreateClientSession(req, historyState, config) {
  const discoveredIdentity = getSpilliSessionIdentity(req);
  const identity = discoveredIdentity ?? {
    key: `ephemeral:${crypto.randomUUID()}`,
    windowId: 'api-bridge',
    sessionId: crypto.randomUUID(),
    contextId: crypto.randomUUID()
  };
  const sessionKey = identity.key;
  const service = getService(config);
  const resolvedModel = await resolveRequestedModel(historyState.requestedModel, config);
  const resource = buildResource(resolvedModel, config);
  const resourceKey = resourceCacheKey(resource);
  const previousEntry = discoveredIdentity ? state.chatSessions.get(sessionKey) : undefined;
  const prepared = prepareSessionRunPayload(historyState, previousEntry, resourceKey, identity);

  const canReuseTransport = shouldReuseTransport(previousEntry, prepared, resourceKey);
  const chosenSession = canReuseTransport
    ? previousEntry.session
    : await service.request(resource, config.requestTimeoutMs);
  if (discoveredIdentity) {
    state.chatSessions.set(sessionKey, {
      session: chosenSession,
      identity,
      promptHash: previousEntry?.promptHash ?? '',
      historyHashes: previousEntry?.historyHashes ?? [],
      resourceKey,
      revision: previousEntry?.revision ?? 0,
      initialized: canReuseTransport && previousEntry?.initialized === true
    });
  }

  const commitHistory = (assistantItems = []) => {
    if (!discoveredIdentity) {
      return;
    }
    const current = state.chatSessions.get(sessionKey);
    if (current?.session !== chosenSession) {
      return;
    }
    state.chatSessions.set(sessionKey, {
      ...current,
      initialized: true,
      promptHash: historyState.promptHash,
      revision: prepared.revision,
      historyHashes: [
        ...historyState.historyHashes,
        ...assistantItems.map(item => item.hash).filter(Boolean)
      ]
    });
  };

  return {
    sessionKey,
    chosenSession,
    resolvedModel,
    payload: prepared.payload,
    transferMode: prepared.transferMode,
    reusedTransport: canReuseTransport,
    revision: prepared.revision,
    reason: prepared.reason,
    previousEntry,
    historyState,
    commitHistory
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

function errorJson(req, res, err) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  void logApiError(req, err);
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

function sanitizeForLog(value, depth = 0) {
  if (depth > 8) {
    return '[Max log depth reached]';
  }
  if (typeof value === 'string') {
    if (value.length <= MAX_LOG_STRING_LENGTH) {
      return value;
    }
    return `${value.slice(0, MAX_LOG_STRING_LENGTH)}...[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLog(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('token') || normalizedKey.includes('authorization') || normalizedKey.includes('api_key')) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = sanitizeForLog(item, depth + 1);
  }
  return output;
}

function getRequestLogPath() {
  return readEnv('SPILLI_BRIDGE_REQUEST_LOG_PATH', DEFAULT_REQUEST_LOG_PATH);
}

function summarizeRequestForError(req) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const identity = getSpilliSessionIdentity(req);
  return {
    method: req.method,
    path: url.pathname,
    headers: {
      'user-agent': asString(req.headers['user-agent']) || null,
      'x-app': asString(req.headers['x-app']) || null,
      'anthropic-version': asString(req.headers['anthropic-version']) || null,
      'anthropic-beta': asString(req.headers['anthropic-beta']) || null,
      'x-claude-code-session-id': asString(req.headers['x-claude-code-session-id']) || null,
      'x-codex-turn-metadata': sanitizeForLog(req.headers['x-codex-turn-metadata']) ?? null,
      'x-openai-subagent': asString(req.headers['x-openai-subagent']) || null
    },
    session_key: identity?.key ?? null
  };
}

function errorSummary(err) {
  return {
    statusCode: Number.isInteger(err?.statusCode) ? err.statusCode : 500,
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : typeof err,
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6) : undefined,
    context: isRecord(err?.context) ? sanitizeForLog(err.context) : undefined
  };
}

async function logApiError(req, err, extra = {}) {
  const summary = errorSummary(err);
  const request = summarizeRequestForError(req);
  const entry = {
    timestamp: new Date().toISOString(),
    kind: 'api.error',
    request,
    error: summary,
    ...extra
  };
  console.error(
    `[SpiLLI API bridge] ${request.method} ${request.path} failed (${summary.statusCode}): ${summary.message}`
  );
  await appendLog(entry, 'ERROR');
}

function isRequestTraceEnabled() {
  return readEnv('SPILLI_BRIDGE_TRACE_REQUEST_SHAPES', '0') === '1';
}

function summarizeAnthropicContentShape(content) {
  if (typeof content === 'string') {
    return {
      kind: 'string',
      length: content.length
    };
  }
  if (!Array.isArray(content)) {
    return {
      kind: typeof content
    };
  }
  return {
    kind: 'array',
    parts: content.map((part, index) => {
      if (!isRecord(part)) {
        return { index, type: typeof part };
      }
      const summary = {
        index,
        type: asString(part.type) || 'unknown'
      };
      if (typeof part.text === 'string') {
        summary.textLength = part.text.length;
      }
      if (typeof part.name === 'string') {
        summary.name = part.name;
      }
      if (typeof part.id === 'string') {
        summary.id = part.id;
      }
      if (isRecord(part.input)) {
        summary.inputKeys = Object.keys(part.input).sort();
      }
      if (isRecord(part.result)) {
        summary.resultKeys = Object.keys(part.result).sort();
      }
      if (typeof part.tool_use_id === 'string') {
        summary.toolUseId = part.tool_use_id;
      }
      return summary;
    })
  };
}

function summarizeAnthropicMessageShape(message, index) {
  if (!isRecord(message)) {
    return {
      index,
      type: typeof message
    };
  }
  return {
    index,
    role: asString(message.role) || 'unknown',
    content: summarizeAnthropicContentShape(message.content)
  };
}

function summarizeClaudeRequestHeaders(req) {
  const summary = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const sanitized = sanitizeForLog(value);
    if (typeof sanitized === 'string' && sanitized) {
      summary[name] = sanitized;
    } else if (Array.isArray(sanitized) && sanitized.length > 0) {
      summary[name] = sanitized;
    }
  }
  return summary;
}

async function logClaudeRequestShape(req, body, payload) {
  if (!isRequestTraceEnabled()) {
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  await appendLog(
    {
      timestamp: new Date().toISOString(),
      kind: 'anthropic.messages.shape',
      method: req.method,
      path: url.pathname,
      headers: summarizeClaudeRequestHeaders(req),
      request: {
        model: asString(body.model) || null,
        stream: body.stream === true,
        max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : null,
        systemShape: summarizeAnthropicContentShape(body.system),
        toolNames: extractAvailableToolNames(body.tools),
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        messages: Array.isArray(body.messages)
          ? body.messages.map((message, index) => summarizeAnthropicMessageShape(message, index))
          : []
      },
      bridge: {
        requestedModel: payload.requestedModel,
        promptLength: payload.prompt.length,
        queryLength: payload.query.length
      }
    },
    'TRACE'
  );
}

async function appendLog(entry,label) {
  const logPath = expandHome(getRequestLogPath());
  try {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await fs.promises.appendFile(logPath, `${label}: ${JSON.stringify(sanitizeForLog(entry))}
`, 'utf8');
  } catch (err) {
    console.warn(`Failed to write SpiLLI API bridge request log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function appendResponseLog(entry) {
  const logPath = expandHome(getRequestLogPath());
  try {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await fs.promises.appendFile(logPath, `RESPONSE: ${JSON.stringify(sanitizeForLog(entry))}
`, 'utf8');
  } catch (err) {
    console.warn(`Failed to write SpiLLI API bridge request log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function logInferenceRequest(kind, req, body, payload, extra = {}) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  await appendLog({
    timestamp: new Date().toISOString(),
    kind,
    method: req.method,
    path: url.pathname,
    // query: Object.fromEntries(url.searchParams.entries()),
    // client: {
    //   user_agent: asString(req.headers['user-agent']) || null,
    //   anthropic_version: asString(req.headers['anthropic-version']) || null,
    //   anthropic_beta: asString(req.headers['anthropic-beta']) || null
    // },
    request: {
      model: asString(body.model) || null,
      stream: body.stream === true,
      system: body.system ?? null,
      // body: body
      // codexmeta: body.client_metadata["x-codex-turn-metadata"],
      turnmeta:req.headers["x-codex-turn-metadata"],
      subagent: req.headers["x-openai-subagent"],
      // metadata: body.client_metadata,
      // tools: Array.isArray(body.tools) ? body.tools : [],
      // tool_names: extractAvailableToolNames(body.tools),
      // messages: Array.isArray(body.messages) ? body.messages : []
    },
    bridge: {
      requestedModel: payload.requestedModel,
      promptLength: payload.prompt.length,
      queryLength: payload.query.length,
      // prompt: payload.prompt,
      query: payload.query,
      ...extra
    }
  },'REQUEST');
}

async function logSessionProtocolDecision(kind, req, details) {
  await appendLog({
    timestamp: new Date().toISOString(),
    kind,
    method: req.method,
    path: new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`).pathname,
    protocol: details
  }, 'PROTOCOL');
}

async function logSessionState(kind, req, details) {
  await appendLog({
    timestamp: new Date().toISOString(),
    kind,
    method: req.method,
    path: new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`).pathname,
    session: details
  }, 'SESSION');
}

function harmonySummary(raw) {
  const parsed = parseHarmonyOutput(raw);
  if (!parsed.isHarmony) {
    return { isHarmony: false };
  }
  return {
    isHarmony: true,
    messages: parsed.messages.map(message => ({
      role: message.role,
      channel: message.channel,
      recipient: message.recipient,
      terminator: message.terminator,
      content: message.content
    })),
    remainder: parsed.remainder
  };
}

async function logInferenceResponse(kind, data) {
  await appendLog({
    timestamp: new Date().toISOString(),
    kind,
    response: data
  },'RESPONSE');
}

function toAnthropicMessage({ id, model, raw, toolsEnabled = false, allowedToolNames = [] }) {
  const toolCalls = toolsEnabled ? parseToolCallsFromOutput(raw, allowedToolNames) : [];
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

function toRawAnthropicMessage({ id, model, raw }) {
  const text = String(raw ?? '');
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: Math.max(1, Math.ceil(text.length / 4))
    }
  };
}

function requestHasTools(body) {
  return extractAvailableToolNames(body?.tools).length > 0;
}

function messageHasOutput(message) {
  return Array.isArray(message?.content) && message.content.length > 0;
}

function shouldRetryEmptyAnthropicTurn(message, raw) {
  if (messageHasOutput(message)) {
    return false;
  }
  const parsed = parseHarmonyOutput(raw);
  return parsed.isHarmony || Boolean(String(raw || '').trim());
}

function buildAnthropicRetryPayload(payload, allowedToolNames) {
  const toolList = allowedToolNames.length ? allowedToolNames.join(', ') : 'none';
  const repairPrompt = [
    'Bridge retry instruction: your previous response could not be converted into a valid Anthropic assistant message.',
    'Do not return analysis-only text.',
    `Available exact tool names: ${toolList}.`,
    'If you need workspace search or exploration and Agent is available, emit exactly one tool call in this JSON shape:',
    '{"toolName":"Agent","args":{"description":"3-5 word task summary","prompt":"specific search/read task with paths and filenames","subagent_type":"Explore"}}',
    'If no tool is needed, answer directly in the final channel.'
  ].join('\n');
  return {
    ...payload,
    prompt: repairPrompt,
    query: ''
  };
}

async function runAnthropicInferenceWithRetry(payload, config, options) {
  let result = await runInference(
    payload,
    config,
    options?.streamOptions ?? {},
    options?.session,
    options?.resolvedModel
  );
  let message = toAnthropicMessage({
    id: options.id,
    model: result.requestedModel,
    raw: result.raw,
    toolsEnabled: options.toolsEnabled,
    allowedToolNames: options.allowedToolNames
  });
  let retried = false;
  if (shouldRetryEmptyAnthropicTurn(message, result.raw)) {
    retried = true;
    const retryPayload = buildAnthropicRetryPayload(payload, options.allowedToolNames);
    result = await runInference(retryPayload, config, {}, result.session, result.resolvedModel);
    message = toAnthropicMessage({
      id: options.id,
      model: result.requestedModel,
      raw: result.raw,
      toolsEnabled: options.toolsEnabled,
      allowedToolNames: options.allowedToolNames
    });
  }
  return { result, message, retried };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleAnthropicMessages(req, res, config) {
  const body = await readBody(req);
  const historyState = buildHistoryStateForAnthropic(body);
  const fullPayload = anthropicToSpilliPayload(body);
  await logClaudeRequestShape(req, body, fullPayload);
  const {
    chosenSession,
    resolvedModel,
    payload,
    transferMode,
    reusedTransport,
    revision,
    reason,
    previousEntry,
    historyState: preparedHistoryState,
    commitHistory
  } = await getOrCreateClientSession(req, historyState, config);
  const allowedToolNames = extractAvailableToolNames(body.tools);
  const toolsEnabled = allowedToolNames.length > 0;
  const rawMode = config.responseMode === 'raw';
  const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  await logInferenceRequest('anthropic.messages', req, body, payload, {
    requestId: id,
    allowedToolNames,
    toolsEnabled,
    responseMode: config.responseMode,
    transferMode,
    reusedTransport,
    revision,
    reason
  });
  await logSessionProtocolDecision('anthropic.messages.protocol', req, {
    requestId: id,
    transferMode,
    reusedTransport,
    revision,
    reason,
    promptLength: payload.prompt.length,
    queryLength: payload.query.length,
    contextRevision: payload.spilliContext?.context_revision ?? null,
    resourceKey: payload.spilliContext?.resource_key ?? null,
    sessionKey: getSpilliSessionIdentity(req)?.key ?? null
  });
  await logSessionState('anthropic.messages.session.before', req, {
    requestId: id,
    transferMode,
    reusedTransport,
    revision,
    reason,
    previousEntry: summarizeSessionEntry(previousEntry),
    nextHistoryState: summarizeHistoryState(preparedHistoryState),
    spilliContext: summarizeContextPayload(payload.spilliContext),
    hydrateContext: summarizeContextPayload(payload.hydrateContext)
  });
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders()
    });
    const ping = setInterval(() => writeSse(res, 'ping', { type: 'ping' }), 15_000);
    let textBlockStarted = false;
    let textBlockStopped = false;
    let streamedText = '';
    let outputChars = 0;
    const startTextBlock = () => {
      if (textBlockStarted) {
        return;
      }
      textBlockStarted = true;
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });
    };
    const writeTextDelta = text => {
      if (!text) {
        return;
      }
      startTextBlock();
      outputChars += text.length;
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
      });
    };
    const stopTextBlock = () => {
      if (!textBlockStarted || textBlockStopped) {
        return;
      }
      textBlockStopped = true;
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    };
    try {
      const streamOptions = {
        onStart: ({ requestedModel }) => {
          writeSse(res, 'message_start', {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              model: requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          });
        }
      };
      if (rawMode) {
        streamOptions.onChunk = chunk => {
          const text = String(chunk ?? '');
          streamedText += text;
          writeTextDelta(text);
        };
      }
      const { result, message, retried } = rawMode
        ? {
            result: await runInference(payload, config, streamOptions, chosenSession, resolvedModel),
            message: undefined,
            retried: false
          }
        : await runAnthropicInferenceWithRetry(payload, config, {
            id,
            toolsEnabled,
            allowedToolNames,
            streamOptions,
            session: chosenSession,
            resolvedModel
          });
      const emittedMessage = rawMode
        ? toRawAnthropicMessage({ id, model: result.requestedModel, raw: result.raw })
        : message;
      commitHistory([assistantHistoryItemForAnthropic(emittedMessage)]);
      await logSessionState('anthropic.messages.session.after', req, {
        requestId: id,
        transferMode,
        reusedTransport,
        revision,
        reason,
        committedAssistantItems: 1,
        emittedStopReason: emittedMessage.stop_reason ?? null,
        emittedContentTypes: Array.isArray(emittedMessage.content)
          ? emittedMessage.content.map(block => block?.type ?? null)
          : []
      });
      // await logInferenceResponse('anthropic.messages.response', {
      //   id,
      //   stream: true,
      //   retried,
      //   responseMode: config.responseMode,
      //   model: result.requestedModel,
      //   allowedToolNames,
      //   raw: result.raw,
      //   harmony: rawMode ? undefined : harmonySummary(result.raw),
      //   parsedToolCalls: rawMode ? [] : parseToolCallsFromOutput(result.raw, allowedToolNames),
      //   emittedContent: emittedMessage.content,
      //   stopReason: emittedMessage.stop_reason
      // });
      const finalTextBlock = emittedMessage.content.find(block => block.type === 'text');
      if (finalTextBlock?.text && finalTextBlock.text.startsWith(streamedText)) {
        const delta = finalTextBlock.text.slice(streamedText.length);
        streamedText = finalTextBlock.text;
        writeTextDelta(delta);
      } else if (outputChars === 0 && finalTextBlock?.text) {
        streamedText = finalTextBlock.text;
        writeTextDelta(finalTextBlock.text);
      }
      stopTextBlock();
      let nextIndex = textBlockStarted ? 1 : 0;
      for (const block of emittedMessage.content) {
        if (block.type !== 'tool_use') {
          continue;
        }
        const index = nextIndex++;
        writeSse(res, 'content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
        });
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
        });
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
      }
      writeSse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: emittedMessage.stop_reason, stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: Math.max(1, Math.ceil(Math.max(outputChars, result.raw.length) / 4)) }
      });
      writeSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    } catch (err) {
      await logApiError(req, err, {
        route: 'anthropic.messages',
        request_id: id,
        response_mode: config.responseMode,
        requested_model: payload.requestedModel || null,
        transfer_mode: transferMode,
        reused_transport: reusedTransport,
        revision,
        reason,
        previous_entry: summarizeSessionEntry(previousEntry),
        history_state: summarizeHistoryState(preparedHistoryState),
        spilli_context: summarizeContextPayload(payload.spilliContext),
        hydrate_context: summarizeContextPayload(payload.hydrateContext)
      });
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
  const { result, message, retried } = rawMode
    ? {
        result: await runInference(payload, config, {}, chosenSession, resolvedModel),
        message: undefined,
        retried: false
      }
    : await runAnthropicInferenceWithRetry(payload, config, {
        id,
        toolsEnabled,
        allowedToolNames,
        session: chosenSession,
        resolvedModel
      });
  const emittedMessage = rawMode
    ? toRawAnthropicMessage({ id, model: result.requestedModel, raw: result.raw })
    : message;
  commitHistory([assistantHistoryItemForAnthropic(emittedMessage)]);
  await logSessionState('anthropic.messages.session.after', req, {
    requestId: id,
    transferMode,
    reusedTransport,
    revision,
    reason,
    committedAssistantItems: 1,
    emittedStopReason: emittedMessage.stop_reason ?? null,
    emittedContentTypes: Array.isArray(emittedMessage.content)
      ? emittedMessage.content.map(block => block?.type ?? null)
      : [],
    retried
  });
  // await logInferenceResponse('anthropic.messages.response', {
  //   id,
  //   stream: false,
  //   retried,
  //   responseMode: config.responseMode,
  //   model: result.requestedModel,
  //   allowedToolNames,
  //   raw: result.raw,
  //   harmony: rawMode ? undefined : harmonySummary(result.raw),
  //   parsedToolCalls: rawMode ? [] : parseToolCallsFromOutput(result.raw, allowedToolNames),
  //   emittedContent: emittedMessage.content,
  //   stopReason: emittedMessage.stop_reason
  // });
  json(res, 200, emittedMessage);
}

async function handleAnthropicCountTokens(req, res, config) {
  const body = await readBody(req);
  const payload = anthropicToSpilliPayload(body);
  // await logInferenceRequest('anthropic.count_tokens', req, body, payload, { requestId: `tok_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` });
  json(res, 200, {
    input_tokens: estimateTokens(`${payload.prompt}\n\n${payload.query}`)
  });
}

function toOpenAiChatCompletion({
  id,
  model,
  raw,
  toolsEnabled = false,
  allowedToolNames = [],
  responseMode = 'compat'
}) {
  const rawMode = responseMode === 'raw';
  const toolCalls = rawMode ? [] : toolsEnabled ? parseToolCallsFromOutput(raw, allowedToolNames) : [];
  const text = rawMode ? String(raw ?? '') : renderText(raw, toolCalls);
  const message = {
    role: 'assistant',
    content: text || null
  };
  if (!rawMode) {
    message.tool_calls = toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input ?? {})
      }
    }));
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
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
  const historyState = buildHistoryStateForOpenAiChat(body);
  const fullPayload = openAiToSpilliPayload(body);
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const allowedToolNames = extractAvailableToolNames(body.tools);
  const toolsEnabled = allowedToolNames.length > 0;
  const rawMode = config.responseMode === 'raw';
  await logInferenceRequest('openai.chat_completions', req, body, fullPayload, {
    requestId: id,
    allowedToolNames,
    toolsEnabled,
    responseMode: config.responseMode
  });
  const created = Math.floor(Date.now() / 1000);
  const { chosenSession, resolvedModel, payload, commitHistory } = await getOrCreateClientSession(req, historyState, config);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders()
    });
    let streamModel = payload.requestedModel;
    let rawForStream = '';
    let streamedText = '';
    try {
      const result = await runInference(payload, config, {
        onStart: ({ requestedModel }) => {
          streamModel = requestedModel;
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
          })}\n\n`);
        },
        onChunk: chunk => {
          rawForStream += chunk;
          if (!rawMode) {
            return;
          }
          const nextText = rawForStream;
          if (!nextText || !nextText.startsWith(streamedText)) {
            return;
          }
          const delta = nextText.slice(streamedText.length);
          streamedText = nextText;
          if (!delta) {
            return;
          }
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: streamModel,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
          })}\n\n`);
        }
      }, chosenSession, resolvedModel);
      const completion = toOpenAiChatCompletion({
        id,
        model: result.requestedModel,
        raw: result.raw,
        toolsEnabled,
        allowedToolNames,
        responseMode: config.responseMode
      });
      commitHistory([assistantHistoryItemForOpenAiChat(completion.choices[0]?.message)]);
      await logInferenceResponse('openai.chat_completions.response', {
        id,
        stream: true,
        responseMode: config.responseMode,
        model: result.requestedModel,
        // allowedToolNames,
        // raw: result.raw,
        // harmony: rawMode ? undefined : harmonySummary(result.raw),
        // parsedToolCalls: rawMode ? [] : parseToolCallsFromOutput(result.raw, allowedToolNames),
        // emittedChoice: completion.choices[0]
      });
      const choice = completion.choices[0];
      if (choice.message.content && choice.message.content.startsWith(streamedText)) {
        const delta = choice.message.content.slice(streamedText.length);
        streamedText = choice.message.content;
        if (delta) {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: result.requestedModel,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
          })}\n\n`);
        }
      } else if (!streamedText && choice.message.content) {
        streamedText = choice.message.content;
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: result.requestedModel,
          choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }]
        })}\n\n`);
      }
      for (const toolCall of choice.message.tool_calls ?? []) {
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: result.requestedModel,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: toolCall.id,
                type: 'function',
                function: toolCall.function
              }]
            },
            finish_reason: null
          }]
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: result.requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      await logApiError(req, err, {
        route: 'openai.chat_completions',
        request_id: id,
        response_mode: config.responseMode,
        requested_model: payload.requestedModel || null
      });
      res.write(`data: ${JSON.stringify({
        error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) }
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }
  const result = await runInference(payload, config, {}, chosenSession, resolvedModel);
  const completion = toOpenAiChatCompletion({
    id,
    model: result.requestedModel,
    raw: result.raw,
    toolsEnabled,
    allowedToolNames,
    responseMode: config.responseMode
  });
  commitHistory([assistantHistoryItemForOpenAiChat(completion.choices[0]?.message)]);
  await logInferenceResponse('openai.chat_completions.response', {
    id,
    stream: false,
    responseMode: config.responseMode,
    model: result.requestedModel,
    // allowedToolNames,
    // raw: result.raw,
    // harmony: rawMode ? undefined : harmonySummary(result.raw),
    // parsedToolCalls: rawMode ? [] : parseToolCallsFromOutput(result.raw, allowedToolNames),
    // emittedChoice: completion.choices[0]
  });
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
    team_name: config.team || null,
    valid_scopes: ['public', 'private', 'team', 'team.<name>', 'enterprise'],
    message
  };
}

function responsesContentToText(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => responsesContentToText(part))
      .filter(Boolean)
      .join('\n');
  }

  if (!isRecord(content)) return '';

  if (content.type === 'input_text' || content.type === 'output_text') {
    return asString(content.text);
  }

  if (content.type === 'refusal') {
    return asString(content.refusal);
  }

  if (content.type === 'input_image') {
    return '[Image input omitted by SpiLLI API bridge]';
  }

  if (content.type === 'input_file') {
    const filename = asString(content.filename).trim();
    return `[File input omitted by SpiLLI API bridge${filename ? `: ${filename}` : ''}]`;
  }

  const direct = asString(content.text || content.content || content.output);
  if (direct) return direct;

  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function responsesInputItemRole(item) {
  if (!isRecord(item)) return '';
  return asString(item.role).trim().toLowerCase();
}

function responsesInputItemToText(item) {
  if (typeof item === 'string') {
    return `USER:\n${item}`;
  }

  if (!isRecord(item)) return '';

  if (item.type === 'function_call_output') {
    const callId = asString(item.call_id).trim() || 'unknown';
    return `TOOL RESULT ${callId}:\n${responsesContentToText(item.output)}`;
  }

  if (item.type === 'custom_tool_call_output') {
    const callId = asString(item.call_id).trim() || 'unknown';
    return `CUSTOM TOOL RESULT ${callId}:\n${responsesContentToText(item.output)}`;
  }

  if (item.type === 'function_call') {
    return [
      `ASSISTANT TOOL CALL ${asString(item.name).trim() || 'function'}:`,
      `call_id: ${asString(item.call_id).trim()}`,
      `arguments: ${asString(item.arguments).trim()}`
    ].join('\n');
  }

  if (item.type === 'custom_tool_call') {
    return [
      `ASSISTANT CUSTOM TOOL CALL ${asString(item.name).trim() || 'custom'}:`,
      `call_id: ${asString(item.call_id).trim()}`,
      `input: ${asString(item.input).trim()}`
    ].join('\n');
  }

  const role = asString(item.role || 'user').trim().toUpperCase() || 'USER';
  return `${role}:\n${responsesContentToText(item.content)}`;
}

function responsesToSpilliPayload(body) {
  const historyState = buildHistoryStateForResponses(body);
  return {
    requestedModel: historyState.requestedModel,
    prompt: historyState.prompt,
    query: historyState.query
  };
}

function buildHistoryStateForResponses(body) {
  const input = body.input;
  const inputItems = Array.isArray(input) ? input : [];

  const isInstructionItem = (item) => {
    const role = responsesInputItemRole(item);
    return role === 'system' || role === 'developer';
  };

  const promptFromInputItems = inputItems
    .filter(isInstructionItem)
    .map(responsesInputItemToText)
    .filter(Boolean)
    .join('\n\n');

  const prompt = [
    asString(body.instructions).trim(),
    promptFromInputItems,
    formatToolsForPrompt(body.tools)
  ]
    .filter(Boolean)
    .join('\n\n');

  const historyItems =
    typeof input === 'string'
      ? [createHistoryItem('user', input)]
      : inputItems
          .filter((item) => !isInstructionItem(item))
          .map(createResponsesHistoryItem)
          .filter(Boolean);

  return createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems,
    allowDelta: typeof input !== 'string'
  });
}

function createResponseId(prefix = 'resp') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeResponseCallId(value) {
  const raw =
    asString(value).trim() ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 58);
  return safe.startsWith('call_') ? safe.slice(0, 64) : `call_${safe}`.slice(0, 64);
}

function toResponsesOutputItems({
  raw,
  toolsEnabled = false,
  allowedToolNames = [],
  toolTypes = {},
  messageId = undefined,
  responseMode = 'compat'
}) {
  const rawMode = responseMode === 'raw';
  const toolCalls = rawMode
    ? []
    : toolsEnabled
    ? parseToolCallsFromOutput(raw, allowedToolNames)
    : [];

  const text = rawMode ? String(raw ?? '') : renderText(raw, toolCalls);
  const output = [];

  if (text) {
    output.push({
      id: messageId || createResponseId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text,
          annotations: []
        }
      ]
    });
  }

  for (const call of toolCalls) {
    const toolType = toolTypes[normalizeToolNameForLookup(call.name)] || 'function';
    if (toolType === 'custom') {
      output.push({
        id: createResponseId('ctc'),
        type: 'custom_tool_call',
        status: 'completed',
        call_id: normalizeResponseCallId(call.id),
        name: call.name,
        input: typeof call.input === 'string' ? call.input : asString(call.input?.patch || call.input?.input || call.input?.diff || JSON.stringify(call.input ?? {}))
      });
      continue;
    }
    output.push({
      id: createResponseId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: normalizeResponseCallId(call.id),
      name: call.name,
      arguments: JSON.stringify(call.input ?? {})
    });
  }

  return { output, text, toolCalls };
}

function outputTextFromResponsesOutput(output) {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('');
}

function createResponsesObject({
  id,
  body,
  model,
  output,
  status = 'completed',
  createdAt,
  completedAt = null,
  rawText = ''
}) {
  const inputText =
    typeof body.input === 'string'
      ? body.input
      : Array.isArray(body.input)
        ? body.input.map(responsesInputItemToText).join('\n\n')
        : '';

  const outputText = outputTextFromResponsesOutput(output);
  const inputTokens = estimateTokens(
    [body.instructions, inputText].filter(Boolean).join('\n\n')
  );
  const outputTokens = estimateTokens(rawText || outputText);

  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    completed_at: completedAt,
    error: null,
    incomplete_details: null,

    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: model || asString(body.model).trim() || 'spilli',

    output,
    output_text: outputText,

    parallel_tool_calls: body.parallel_tool_calls ?? true,
    reasoning: body.reasoning ?? null,
    store: body.store ?? false,
    temperature: body.temperature ?? null,
    text: body.text ?? { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: body.top_p ?? null,
    truncation: body.truncation ?? 'disabled',
    user: body.user ?? null,
    metadata: body.metadata ?? {},

    usage:
      status === 'completed'
        ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            output_tokens_details: {
              reasoning_tokens: 0
            },
            total_tokens: inputTokens + outputTokens
          }
        : null,

    end_turn: status === 'completed'
  };
}

function writeResponsesSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function handleOpenAiResponses(req, res, config) {
  const body = await readBody(req);
  const historyState = buildHistoryStateForResponses(body);
  const fullPayload = responsesToSpilliPayload(body);
  const id = createResponseId('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  const messageId = createResponseId('msg');

  const allowedToolNames = extractAvailableToolNames(body.tools);
  const toolTypes = extractResponsesToolTypes(body.tools);
  const toolsEnabled = allowedToolNames.length > 0;
  const rawMode = config.responseMode === 'raw';
  await logInferenceRequest('openai.responses', req, body, fullPayload, {
    requestId: id,
    // allowedToolNames,
    // toolsEnabled,
    // responseMode: config.responseMode
  });

  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...corsHeaders()
    });

    let sequenceNumber = 1;
    let streamModel = fullPayload.requestedModel || asString(body.model).trim() || 'spilli';
    let rawForStream = '';
    let streamedText = '';

    let outputItemStarted = false;
    let contentPartStarted = false;
    const emit = (event) => {
      writeResponsesSse(res, {
        ...event,
        sequence_number: sequenceNumber++
      });
    };

    const ensureTextOutputStarted = () => {
      if (!outputItemStarted) {
        outputItemStarted = true;
        emit({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: messageId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: []
          }
        });
      }

      if (!contentPartStarted) {
        contentPartStarted = true;
        emit({
          type: 'response.content_part.added',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: 'output_text',
            text: '',
            annotations: []
          }
        });
      }
    };

    try {
      const created = createResponsesObject({
        id,
        body,
        model: streamModel,
        output: [],
        status: 'in_progress',
        createdAt,
        rawText: ''
      });

      emit({
        type: 'response.created',
        response: created
      });
      const { chosenSession, resolvedModel, payload, commitHistory } = await getOrCreateClientSession(req, historyState, config);
      const result = await runInference(payload, config, {
        onStart: ({ requestedModel }) => {
          streamModel = requestedModel || streamModel;
        },

        onChunk: (chunk) => {
          rawForStream += chunk;
          if (!rawMode) {
            return;
          }

          const nextText = rawForStream;

          if (!nextText || !nextText.startsWith(streamedText)) return;

          const delta = nextText.slice(streamedText.length);
          streamedText = nextText;

          if (!delta) return;

          ensureTextOutputStarted();

          emit({
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta
          });
        }
      }, chosenSession, resolvedModel);

      const { output, toolCalls } = toResponsesOutputItems({
        raw: result.raw,
        toolsEnabled,
        allowedToolNames,
        toolTypes,
        messageId,
        responseMode: config.responseMode
      });
      commitHistory(assistantHistoryItemsForResponses(output));

      await logInferenceResponse('openai.responses.response', {
        id,
        stream: true,
        responseMode: config.responseMode,
        model: result.requestedModel,
        // allowedToolNames,
        // raw: result.raw,
        // harmony: rawMode ? undefined : harmonySummary(result.raw),
        parsedToolCalls: toolCalls,
        // emittedOutput: output
      });

      const messageItem = output.find((item) => item.type === 'message');
      const finalText =
        messageItem?.content?.find((part) => part.type === 'output_text')?.text ?? '';

      if (finalText) {
        ensureTextOutputStarted();

        if (finalText.startsWith(streamedText)) {
          const tail = finalText.slice(streamedText.length);
          if (tail) {
            emit({
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: tail
            });
          }
        }

        emit({
          type: 'response.output_text.done',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: finalText
        });

        emit({
          type: 'response.content_part.done',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: 'output_text',
            text: finalText,
            annotations: []
          }
        });

        emit({
          type: 'response.output_item.done',
          output_index: 0,
          item: messageItem
        });
      }

      let outputIndex = finalText ? 1 : 0;

      for (const item of output.filter((entry) => entry.type !== 'message')) {
        emit({
          type: 'response.output_item.done',
          output_index: outputIndex,
          item
        });
        outputIndex += 1;
      }

      const completed = createResponsesObject({
        id,
        body,
        model: result.requestedModel || streamModel,
        output,
        status: 'completed',
        createdAt,
        completedAt: Math.floor(Date.now() / 1000),
        rawText: result.raw
      });

      emit({
        type: 'response.completed',
        response: completed
      });

      res.end();
    } catch (err) {
      await logApiError(req, err, {
        route: 'openai.responses',
        request_id: id,
        response_mode: config.responseMode,
        requested_model: fullPayload.requestedModel || null
      });
      const failed = createResponsesObject({
        id,
        body,
        model: streamModel,
        output: [],
        status: 'failed',
        createdAt,
        completedAt: Math.floor(Date.now() / 1000),
        rawText: ''
      });

      failed.error = {
        code: 'api_error',
        message: err instanceof Error ? err.message : String(err)
      };

      emit({
        type: 'response.failed',
        response: failed
      });

      res.end();
    }

    return;
  }
  const { chosenSession, resolvedModel, payload, commitHistory } = await getOrCreateClientSession(req, historyState, config);
  const result = await runInference(payload, config, {}, chosenSession, resolvedModel);

  const { output, toolCalls } = toResponsesOutputItems({
    raw: result.raw,
    toolsEnabled,
    allowedToolNames,
    toolTypes,
    responseMode: config.responseMode
  });
  commitHistory(assistantHistoryItemsForResponses(output));

  await logInferenceResponse('openai.responses.response', {
    id,
    stream: false,
    responseMode: config.responseMode,
    model: result.requestedModel,
    // allowedToolNames,
    // raw: result.raw,
    // harmony: rawMode ? undefined : harmonySummary(result.raw),
    parsedToolCalls: toolCalls,
    // emittedOutput: output
  });

  json(
    res,
    200,
    createResponsesObject({
      id,
      body,
      model: result.requestedModel,
      output,
      status: 'completed',
      createdAt,
      completedAt: Math.floor(Date.now() / 1000),
      rawText: result.raw
    })
  );
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
  const requestedTeamName = asString(body.team_name || body.teamName || body.team).trim();
  const scopeTeamName = getTeamNameFromScope(normalized);
  const effectiveTeamName = scopeTeamName || requestedTeamName || config.team;
  if (getBaseScope(normalized) === 'team' && !effectiveTeamName) {
    json(res, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'team_name is required when scope is "team".'
      }
    });
    return;
  }
  state.modelScope = normalized;
  state.modelTeam = getBaseScope(normalized) === 'team' ? effectiveTeamName : undefined;
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
      team_name: config.team || null,
      response_mode: config.responseMode,
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
  if (
    req.method === 'POST' &&
    (url.pathname === '/v1/responses' || url.pathname === '/responses')
  ) {
    await handleOpenAiResponses(req, res, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleOpenAiChatCompletions(req, res, config);
    return;
  }
  json(res, 404, { error: { type: 'not_found_error', message: `No route for ${req.method} ${url.pathname}` } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => errorJson(req, res, err));
});

export {
  buildHistoryStateForAnthropic,
  buildHistoryStateForOpenAiChat,
  buildHistoryStateForResponses,
  buildResource,
  createMarkerFilteringForwarder,
  extractHarmonyFinalText,
  extractSpilliHostError,
  mergePublicModels,
  normalizePublicCatalogModels,
  prepareSessionRunPayload,
  parseToolCallsFromOutput,
  resourceCacheKey,
  renderText,
  toResponsesOutputItems
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFiles();
  const config = getConfig();
  server.listen(config.port, config.host, () => {
    console.log(`SpiLLI API bridge listening at http://${config.host}:${config.port}`);
    console.log(`SpiLLI API bridge request log: ${expandHome(getRequestLogPath())}`);
  });
}
