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
const DEFAULT_ALLOCATION_TIMEOUT_MS = 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_CACHE_TTL_MS = 30_000;
const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
const DEFAULT_MAX_DURABLE_CONTEXTS_PER_RESOURCE = 2;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
const DEFAULT_TOOL_RESULT_RAW_CHARS = 4_000;
const DEFAULT_TOOL_RESULT_COMPACT_CHARS = 16_000;
const DEFAULT_TOOL_RESULT_COMPACT_TARGET_CHARS = 6_000;
const DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS = 3_000;
const DEFAULT_TOOL_RESULT_SUMMARIZER_TIMEOUT_MS = 60_000;
const DEFAULT_ASK_CONTINUE_ON_MAX_TOKENS = true;
const DEFAULT_CONTEXT_CHARS_PER_TOKEN = 3;
const DEFAULT_CONTEXT_INPUT_BUDGET_FRACTION = 0.72;
const DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS = 1024;
const DEFAULT_CONTEXT_MIN_HISTORY_CHARS = 512;
const DEFAULT_CONTEXT_DEPENDENCY_RAW_CHARS = 24_000;
const DEFAULT_TOOL_SCHEMA_PROMPT_MAX_CHARS = 24_000;
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
  // Maps SpiLLI resource keys to one live SDK transport/allocation. Logical
  // chat histories are separated by spilli_context identities over this transport.
  resourceSessions: new Map(),
  lastResolvedModelByScope: new Map(),
  // Maps bridge-managed client session keys to logical SpiLLI contexts.
  chatSessions: new Map()
};

function getNamespacedSessionKey(prefix, key) {
  const normalized = typeof key === 'string' ? key.trim() : '';
  return normalized ? `${prefix}:${normalized}` : undefined;
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

  return getNamespacedSessionKey('codex', `${windowId}:${sessionId}:${threadId}`);
}

function getClaudeSessionKey(req) {
  return getNamespacedSessionKey('claude', asString(req.headers['x-claude-code-session-id']));
}

function stableBridgeId(prefix, value) {
  const hash = crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
  return `${prefix}-${hash}`;
}

function getCodexSessionIdentity(req) {
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
  return {
    key,
    windowId,
    sessionId: `${sessionId}:${threadId}`,
    contextId: stableBridgeId('codex-context', `${windowId}:${sessionId}:${threadId}`)
  };
}

function getClaudeSessionIdentity(req) {
  const sessionId = asString(req.headers['x-claude-code-session-id']).trim();
  if (!sessionId) {
    return undefined;
  }
  return {
    key: getNamespacedSessionKey('claude', sessionId),
    windowId: 'claude-code',
    sessionId,
    contextId: stableBridgeId('claude-context', sessionId)
  };
}

function getSpilliSessionIdentity(req) {
  return getCodexSessionIdentity(req) ?? getClaudeSessionIdentity(req);
}

function anthropicSystemText(body) {
  const system = body?.system;
  if (typeof system === 'string') {
    return system;
  }
  if (!Array.isArray(system)) {
    return '';
  }
  return system
    .map(part => (isRecord(part) ? asString(part.text) : asString(part)))
    .filter(Boolean)
    .join('\n');
}

function shouldLogFullSystemPrompt() {
  return readEnv('SPILLI_BRIDGE_LOG_SYSTEM_PROMPT', '0') === '1';
}

function shouldLogFullToolSchemas() {
  return readEnv('SPILLI_BRIDGE_LOG_TOOL_SCHEMAS', '0') === '1';
}

function summarizeSystemPromptForLog(body, normalizedText) {
  const text = typeof normalizedText === 'string'
    ? normalizedText
    : anthropicSystemText(body);
  const summary = {
    systemShape: summarizeAnthropicContentShape(body?.system),
    systemPromptLength: text.length,
    systemPromptHash: hashHistoryValue(text),
    systemPromptPreview: text.slice(0, 4000)
  };
  if (shouldLogFullSystemPrompt()) {
    summary.systemPromptText = text;
  }
  return summary;
}

function summarizeJsonSchemaForLog(schema) {
  if (!isRecord(schema)) {
    return {
      type: typeof schema
    };
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    type: asString(schema.type) || undefined,
    required: Array.isArray(schema.required) ? schema.required.map(item => asString(item)).filter(Boolean) : [],
    propertyNames: Object.keys(properties).sort(),
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, value]) => {
        const property = isRecord(value) ? value : {};
        return [
          name,
          {
            type: asString(property.type) || undefined,
            enum: Array.isArray(property.enum) ? property.enum.map(item => asString(item)).filter(Boolean) : undefined,
            descriptionLength: asString(property.description).length,
            descriptionPreview: asString(property.description).slice(0, 500)
          }
        ];
      })
    )
  };
}

function summarizeToolSchemasForLog(tools) {
  if (!Array.isArray(tools)) {
    return {
      toolCount: 0,
      tools: []
    };
  }
  const summaries = tools.map((tool, index) => {
    if (!isRecord(tool)) {
      return {
        index,
        type: typeof tool
      };
    }
    const name = asString(tool.name || tool.function?.name).trim();
    const description = asString(tool.description || tool.function?.description);
    const inputSchema = tool.input_schema || tool.inputSchema || tool.function?.parameters || tool.function?.input_schema;
    return {
      index,
      name,
      keys: Object.keys(tool).sort(),
      descriptionLength: description.length,
      descriptionPreview: description.slice(0, 1000),
      inputSchema: summarizeJsonSchemaForLog(inputSchema),
      hasCacheControl: isRecord(tool.cache_control) || isRecord(tool.cacheControl),
      type: asString(tool.type) || undefined
    };
  });
  const summary = {
    toolCount: summaries.length,
    toolNames: summaries.map(tool => tool.name).filter(Boolean),
    tools: summaries
  };
  if (shouldLogFullToolSchemas()) {
    summary.toolSchemas = sanitizeForLog(tools);
  }
  return summary;
}

function getClientKind(req) {
  if (getClaudeSessionIdentity(req)) {
    return 'claude';
  }
  if (getCodexSessionIdentity(req)) {
    return 'codex';
  }
  return 'unknown';
}

function isClaudeSubagentRequest(req, body = {}) {
  if (!getClaudeSessionIdentity(req)) {
    return false;
  }
  const headerText = Object.entries(req.headers)
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(' ') : value ?? ''}`)
    .join('\n')
    .toLowerCase();
  const systemText = anthropicSystemText(body).toLowerCase();
  return (
    headerText.includes('cc_is_subagent=true') ||
    systemText.includes('cc_is_subagent=true') ||
    systemText.includes('you are an agent for claude code') ||
    systemText.includes('claude code subagent')
  );
}

function isClaudeUtilityRequest(req, body = {}) {
  if (!getClaudeSessionIdentity(req)) {
    return false;
  }
  const systemText = anthropicSystemText(body).toLowerCase();
  return (
    systemText.includes('generate a concise, sentence-case title') ||
    systemText.includes('return json with a single "title" field')
  );
}

function getLeaseKindForRequest(req, body = {}) {
  return isClaudeSubagentRequest(req, body) || isClaudeUtilityRequest(req, body)
    ? 'ephemeral'
    : 'durable';
}

function specializeSessionIdentityForHistory(identity, historyState) {
  if (!identity || !String(identity.key ?? '').startsWith('claude:')) {
    return identity;
  }
  const promptHash = asString(historyState?.promptHash).trim();
  if (!promptHash) {
    return identity;
  }
  const promptScope = stableBridgeId('prompt', promptHash);
  return {
    ...identity,
    key: `${identity.key}:${promptScope}`,
    contextId: stableBridgeId('claude-context', `${identity.sessionId}:${promptHash}`)
  };
}

/**
 * Determine a client session key from request metadata when the client exposes one.
 *
 * Codex provides `x-codex-turn-metadata` with `window_id`, `session_id`, and
 * `thread_id`. Claude Code provides `x-claude-code-session-id`.
 *
 * @param {import('node:http').IncomingMessage} req - HTTP request
 * @returns {string|undefined} Session key when present
 */
function getSpilliSessionKey(req) {
  return getCodexSessionKey(req) ?? getClaudeSessionKey(req);
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

function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(readEnv(name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveIntEnv(name) {
  const parsed = Number.parseInt(readEnv(name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveFloatEnv(name, fallback) {
  const parsed = Number.parseFloat(readEnv(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const allocationTimeoutMs = Number.parseInt(
    readEnv('SPILLI_BRIDGE_ALLOCATION_TIMEOUT_MS', readEnv('SPILLI_BRIDGE_REQUEST_TIMEOUT_MS')),
    10
  );
  const runTimeoutMs = Number.parseInt(
    readEnv('SPILLI_BRIDGE_RUN_TIMEOUT_MS', readEnv('SPILLI_BRIDGE_INFERENCE_TIMEOUT_MS')),
    10
  );
  const modelCacheTtlMs = Number.parseInt(readEnv('SPILLI_BRIDGE_MODEL_CACHE_TTL_MS'), 10);
  const webSearchTimeoutMs = Number.parseInt(readEnv('SPILLI_BRIDGE_WEB_SEARCH_TIMEOUT_MS'), 10);
  const webSearchMaxResults = Number.parseInt(readEnv('SPILLI_BRIDGE_WEB_SEARCH_MAX_RESULTS'), 10);
  const legacyMaxToolResultChars = Number.parseInt(readEnv('SPILLI_BRIDGE_MAX_TOOL_RESULT_CHARS'), 10);
  const toolResultRawChars = readPositiveIntEnv('SPILLI_BRIDGE_TOOL_RESULT_RAW_CHARS', DEFAULT_TOOL_RESULT_RAW_CHARS);
  const toolResultCompactChars = readPositiveIntEnv(
    'SPILLI_BRIDGE_TOOL_RESULT_COMPACT_CHARS',
    Number.isFinite(legacyMaxToolResultChars) && legacyMaxToolResultChars > 0
      ? legacyMaxToolResultChars
      : DEFAULT_TOOL_RESULT_COMPACT_CHARS
  );
  const toolResultCompactTargetChars = readPositiveIntEnv(
    'SPILLI_BRIDGE_TOOL_RESULT_COMPACT_TARGET_CHARS',
    DEFAULT_TOOL_RESULT_COMPACT_TARGET_CHARS
  );
  const toolResultSummaryTargetChars = readPositiveIntEnv(
    'SPILLI_BRIDGE_TOOL_RESULT_SUMMARY_TARGET_CHARS',
    DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS
  );
  const toolResultSummarizerTimeoutMs = readPositiveIntEnv(
    'SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_TIMEOUT_MS',
    DEFAULT_TOOL_RESULT_SUMMARIZER_TIMEOUT_MS
  );
  const maxHistoryCharsOverride = readOptionalPositiveIntEnv('SPILLI_BRIDGE_MAX_HISTORY_CHARS');
  const contextCharsPerToken = readPositiveFloatEnv(
    'SPILLI_BRIDGE_CONTEXT_CHARS_PER_TOKEN',
    DEFAULT_CONTEXT_CHARS_PER_TOKEN
  );
  const contextInputBudgetFraction = Math.min(
    0.95,
    Math.max(
      0.1,
      readPositiveFloatEnv('SPILLI_BRIDGE_CONTEXT_INPUT_BUDGET_FRACTION', DEFAULT_CONTEXT_INPUT_BUDGET_FRACTION)
    )
  );
  const contextOutputReserveTokens = readPositiveIntEnv(
    'SPILLI_BRIDGE_CONTEXT_OUTPUT_RESERVE_TOKENS',
    DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS
  );
  const contextDependencyRawChars = readPositiveIntEnv(
    'SPILLI_BRIDGE_CONTEXT_DEPENDENCY_RAW_CHARS',
    DEFAULT_CONTEXT_DEPENDENCY_RAW_CHARS
  );
  const toolSchemaPromptMaxChars = readPositiveIntEnv(
    'SPILLI_BRIDGE_TOOL_SCHEMA_PROMPT_MAX_CHARS',
    DEFAULT_TOOL_SCHEMA_PROMPT_MAX_CHARS
  );
  const maxDurableContextsPerResource = Number.parseInt(
    readEnv('SPILLI_BRIDGE_MAX_DURABLE_CONTEXTS_PER_RESOURCE'),
    10
  );
  const scope = normalizeConfiguredScope(state.modelScope);
  return {
    host: readEnv('SPILLI_BRIDGE_HOST', '127.0.0.1'),
    port: Number.parseInt(readEnv('SPILLI_BRIDGE_PORT'), 10) || DEFAULT_PORT,
    keyPath: expandHome(readEnv('SPILLI_KEY_PATH', DEFAULT_SPILLI_KEY_PATH)),
    scope,
    team: state.modelTeam ?? readEnv('SPILLI_BRIDGE_TEAM'),
    authToken: readEnv('SPILLI_BRIDGE_AUTH_TOKEN'),
    allocationTimeoutMs:
      Number.isFinite(allocationTimeoutMs) && allocationTimeoutMs > 0
        ? allocationTimeoutMs
        : DEFAULT_ALLOCATION_TIMEOUT_MS,
    runTimeoutMs: Number.isFinite(runTimeoutMs) && runTimeoutMs > 0 ? runTimeoutMs : DEFAULT_RUN_TIMEOUT_MS,
    modelCacheTtlMs:
      Number.isFinite(modelCacheTtlMs) && modelCacheTtlMs > 0 ? modelCacheTtlMs : DEFAULT_MODEL_CACHE_TTL_MS,
    nativeCacheDir: readEnv('SPILLI_BRIDGE_NATIVE_CACHE_DIR'),
    modelAliases: parseModelAliases(readEnv('SPILLI_BRIDGE_MODEL_ALIASES')),
    responseMode: normalizeResponseMode(readEnv('SPILLI_BRIDGE_RESPONSE_MODE', 'compat')),
    askContinueOnMaxTokens:
      readEnv('SPILLI_BRIDGE_ASK_CONTINUE_ON_MAX_TOKENS', DEFAULT_ASK_CONTINUE_ON_MAX_TOKENS ? '1' : '0') !== '0',
    webSearchEndpoint: readEnv('SPILLI_BRIDGE_WEB_SEARCH_ENDPOINT'),
    webSearchTimeoutMs:
      Number.isFinite(webSearchTimeoutMs) && webSearchTimeoutMs > 0
        ? webSearchTimeoutMs
        : DEFAULT_WEB_SEARCH_TIMEOUT_MS,
    webSearchMaxResults:
      Number.isFinite(webSearchMaxResults) && webSearchMaxResults > 0
        ? webSearchMaxResults
        : DEFAULT_WEB_SEARCH_MAX_RESULTS,
    maxToolResultChars:
      Number.isFinite(legacyMaxToolResultChars) && legacyMaxToolResultChars > 0
        ? legacyMaxToolResultChars
        : DEFAULT_MAX_TOOL_RESULT_CHARS,
    toolResultRawChars,
    toolResultCompactChars: Math.max(toolResultRawChars, toolResultCompactChars),
    toolResultCompactTargetChars,
    toolResultSummaryTargetChars,
    toolResultSummarizerEndpoint: readEnv('SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENDPOINT'),
    compactToolResults: readEnv('SPILLI_BRIDGE_COMPACT_TOOL_RESULTS', '0') === '1',
    toolResultSummarizerEnabled: readEnv('SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENABLED', '1') !== '0',
    toolResultSummarizerModel: readEnv('SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_MODEL'),
    toolResultSummarizerTimeoutMs,
    renderToolSchemas: readEnv('SPILLI_BRIDGE_RENDER_TOOL_SCHEMAS', '1') !== '0',
    toolSchemaPromptMaxChars,
    maxHistoryCharsOverride,
    contextCharsPerToken,
    contextInputBudgetFraction,
    contextOutputReserveTokens,
    contextDependencyRawChars,
    releaseEphemeralContexts: readEnv('SPILLI_BRIDGE_RELEASE_EPHEMERAL_CONTEXTS', '1') !== '0',
    maxDurableContextsPerResource:
      Number.isFinite(maxDurableContextsPerResource) && maxDurableContextsPerResource > 0
        ? maxDurableContextsPerResource
        : DEFAULT_MAX_DURABLE_CONTEXTS_PER_RESOURCE
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

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_WEB_SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
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
            capabilities: normalizeModelCapabilities(item),
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

function readPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function mergeCapabilities(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'undefined' || value === null) {
        continue;
      }
      merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeModelCapabilities(item) {
  if (!isRecord(item)) {
    return undefined;
  }
  const capabilities = mergeCapabilities(
    item.capabilities,
    item.provider_capabilities,
    item.providerCapabilities,
    item.host_capabilities,
    item.hostCapabilities,
    isRecord(item.metadata) ? item.metadata.capabilities : undefined,
    isRecord(item.metadata) ? item.metadata.provider_capabilities : undefined,
    isRecord(item.pipeline) ? item.pipeline.capabilities : undefined
  );
  if (!capabilities) {
    return undefined;
  }
  const pipelineSafeContextTokens =
    readPositiveNumber(capabilities.pipeline_safe_context_tokens) ??
    readPositiveNumber(capabilities.pipelineSafeContextTokens);
  const safeContextTokens =
    readPositiveNumber(capabilities.safe_context_tokens) ??
    readPositiveNumber(capabilities.safeContextTokens) ??
    pipelineSafeContextTokens;
  const contextWindowTokens =
    readPositiveNumber(capabilities.context_window_tokens) ??
    readPositiveNumber(capabilities.contextWindowTokens) ??
    readPositiveNumber(capabilities.context_size) ??
    readPositiveNumber(capabilities.contextSize);
  const pipelineMaxSessions =
    readPositiveNumber(capabilities.pipeline_max_sessions) ??
    readPositiveNumber(capabilities.pipelineMaxSessions);
  const minimumContextTokens =
    readPositiveNumber(capabilities.minimum_context_tokens) ??
    readPositiveNumber(capabilities.minimumContextTokens) ??
    readPositiveNumber(capabilities.pipeline_minimum_context_tokens) ??
    readPositiveNumber(capabilities.pipelineMinimumContextTokens);
  const desiredContextTokens =
    readPositiveNumber(capabilities.desired_context_tokens) ??
    readPositiveNumber(capabilities.desiredContextTokens) ??
    readPositiveNumber(capabilities.pipeline_desired_context_tokens) ??
    readPositiveNumber(capabilities.pipelineDesiredContextTokens);
  const dynamicContextDesiredTokens =
    readPositiveNumber(capabilities.dynamic_context_desired_tokens) ??
    readPositiveNumber(capabilities.dynamicContextDesiredTokens);
  const dynamicContextMinimumTokens =
    readPositiveNumber(capabilities.dynamic_context_minimum_tokens) ??
    readPositiveNumber(capabilities.dynamicContextMinimumTokens);
  const maxContextTokens =
    readPositiveNumber(capabilities.max_context_tokens) ??
    readPositiveNumber(capabilities.maxContextTokens);
  const totalKvCells =
    readPositiveNumber(capabilities.total_kv_cells) ??
    readPositiveNumber(capabilities.totalKvCells);
  const recommendedInputBudgetTokens =
    readPositiveNumber(capabilities.recommended_input_budget_tokens) ??
    readPositiveNumber(capabilities.recommendedInputBudgetTokens);
  const freeSequenceSlots =
    readPositiveNumber(capabilities.free_sequence_slots) ??
    readPositiveNumber(capabilities.freeSequenceSlots);
  return {
    ...capabilities,
    ...(pipelineSafeContextTokens ? { pipelineSafeContextTokens, pipeline_safe_context_tokens: pipelineSafeContextTokens } : {}),
    ...(safeContextTokens ? { safeContextTokens, safe_context_tokens: safeContextTokens } : {}),
    ...(contextWindowTokens ? { contextWindowTokens, context_window_tokens: contextWindowTokens } : {}),
    ...(pipelineMaxSessions ? { pipelineMaxSessions, pipeline_max_sessions: pipelineMaxSessions } : {}),
    ...(minimumContextTokens ? { minimumContextTokens, minimum_context_tokens: minimumContextTokens } : {}),
    ...(desiredContextTokens ? { desiredContextTokens, desired_context_tokens: desiredContextTokens } : {}),
    ...(dynamicContextDesiredTokens ? { dynamicContextDesiredTokens, dynamic_context_desired_tokens: dynamicContextDesiredTokens } : {}),
    ...(dynamicContextMinimumTokens ? { dynamicContextMinimumTokens, dynamic_context_minimum_tokens: dynamicContextMinimumTokens } : {}),
    ...(maxContextTokens ? { maxContextTokens, max_context_tokens: maxContextTokens } : {}),
    ...(totalKvCells ? { totalKvCells, total_kv_cells: totalKvCells } : {}),
    ...(recommendedInputBudgetTokens ? { recommendedInputBudgetTokens, recommended_input_budget_tokens: recommendedInputBudgetTokens } : {}),
    ...(freeSequenceSlots ? { freeSequenceSlots, free_sequence_slots: freeSequenceSlots } : {})
  };
}

function normalizeAllocationMetadata(item) {
  if (!isRecord(item)) {
    return undefined;
  }
  const metadata = isRecord(item.allocationMetadata)
    ? item.allocationMetadata
    : isRecord(item.allocation_metadata)
      ? item.allocation_metadata
      : {};
  const graphSource = isRecord(metadata.graphV2)
    ? metadata.graphV2
    : isRecord(metadata.graph_v2)
      ? metadata.graph_v2
      : isRecord(item.graphV2)
        ? item.graphV2
        : isRecord(item.graph_v2)
          ? item.graph_v2
          : {};
  const allocationProtocol =
    Number(metadata.allocationProtocol ?? metadata.allocation_protocol ?? item.allocationProtocol ?? item.allocation_protocol ?? 0) ||
    undefined;
  const compatibilityId =
    readString(graphSource.compatibilityId) ??
    readString(graphSource.compatibility_id) ??
    readString(item.compatibilityId) ??
    readString(item.compatibility_id);
  const totalLayers = Number(graphSource.totalLayers ?? graphSource.total_layers ?? item.totalLayers ?? item.total_layers ?? 0) || undefined;
  const vertexType =
    readString(graphSource.vertexType) ??
    readString(graphSource.vertex_type) ??
    readString(item.vertexType) ??
    readString(item.vertex_type);
  const graphV2 = {};
  if (compatibilityId) {
    graphV2.compatibilityId = compatibilityId;
  }
  if (totalLayers !== undefined) {
    graphV2.totalLayers = totalLayers;
  }
  if (vertexType) {
    graphV2.vertexType = vertexType;
  }
  if (!allocationProtocol && Object.keys(graphV2).length === 0) {
    return undefined;
  }
  return {
    allocationProtocol: allocationProtocol ?? 2,
    ...(Object.keys(graphV2).length > 0 ? { graphV2 } : {})
  };
}

function normalizePublicCatalogModels(response, config) {
  const raw = Array.isArray(response?.models)
    ? response.models
    : Array.isArray(response?.data)
      ? response.data
      : [];
  const models = [];
  const byUid = new Map();
  const addModel = model => {
    const existing = byUid.get(model.uid);
    byUid.set(model.uid, {
      ...existing,
      ...model,
      displayName: existing?.displayName && existing.displayName !== existing.uid ? existing.displayName : model.displayName
    });
    if (!existing) {
      models.push(byUid.get(model.uid));
    } else {
      const index = models.findIndex(entry => entry.uid === model.uid);
      if (index >= 0) {
        models[index] = byUid.get(model.uid);
      }
    }
  };
  for (const item of raw) {
    if (typeof item === 'string') {
      const parsed = parseScopedCatalogModelName(item);
      if (!parsed.name) {
        continue;
      }
      if (!catalogModelMatchesScope(parsed.visibility, parsed.teamName, config.scope, config.team)) {
        continue;
      }
      addModel({
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
    if (!parsed.name) {
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
    const allocationMetadata = normalizeAllocationMetadata(item);
    const capabilities = normalizeModelCapabilities(item);
    addModel({
      uid: parsed.name,
      displayName: displayName && displayName !== parsed.name ? displayName : parsed.name,
      ...(allocationMetadata ? { allocationMetadata } : {}),
      ...(capabilities ? { capabilities } : {})
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
      const mergedCapabilities = mergeCapabilities(existing.capabilities, model.capabilities);
      if (mergedCapabilities) {
        existing.capabilities = mergedCapabilities;
      } else {
        delete existing.capabilities;
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
    const merged = {
      ...existing,
      ...model,
      uid: model.uid,
      displayName,
      count: existing?.count ?? 0
    };
    const mergedCapabilities = mergeCapabilities(existing?.capabilities, model.capabilities);
    if (mergedCapabilities) {
      merged.capabilities = mergedCapabilities;
    } else {
      delete merged.capabilities;
    }
    byUid.set(model.uid, merged);
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
      models = mergePublicModels(hostModels, publicCatalogModels);
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

function selectPreferredDisplayMatch(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }
  const tiers = [
    model => !isHashedModelUid(model.uid) && model.allocationMetadata?.allocationProtocol === 2,
    model => !isHashedModelUid(model.uid) && model.allocationMetadata?.graphV2,
    model => !isHashedModelUid(model.uid),
    model => model.allocationMetadata?.allocationProtocol === 2,
    model => model.allocationMetadata?.graphV2
  ];
  for (const predicate of tiers) {
    const preferred = matches.filter(predicate);
    if (preferred.length === 1) {
      return preferred[0];
    }
  }
  return undefined;
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
  const exactPreferredDisplayMatch = selectPreferredDisplayMatch(exactDisplayMatches);
  if (exactPreferredDisplayMatch) {
    return exactPreferredDisplayMatch;
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
  const normalizedPreferredDisplayMatch = selectPreferredDisplayMatch(normalizedDisplayMatches);
  if (normalizedPreferredDisplayMatch) {
    return normalizedPreferredDisplayMatch;
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
  const wrapperFunctionName =
    typeof value.input !== 'undefined' || typeof value.args !== 'undefined'
      ? value.name || value.tool || value.tool_name || value.toolName
      : undefined;
  const toolName = asString(value.toolName || responseFunctionName || wrapperFunctionName).trim();
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
          : isRecord(value.input)
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
  return asString(value)
    .trim()
    .replace(/^(?:tool|tools|function|functions)\./i, '')
    .toLowerCase();
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
    ['terminal', 'Bash'],
    ['tool_bash', 'Bash'],
    ['bash_tool', 'Bash'],
    ['read_file', 'Read'],
    ['file_read', 'Read'],
    ['fileread', 'Read'],
    ['repo_browser.read_file', 'Read'],
    ['write_file', 'Write'],
    ['file_write', 'Write'],
    ['filewrite', 'Write'],
    ['edit_file', 'Edit'],
    ['file_edit', 'Edit'],
    ['fileedit', 'Edit']
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

function pseudoToolNameVariants(name) {
  const normalized = pseudoToolBaseName(name);
  const variants = new Set([normalized]);
  for (const separator of ['.', '_', '-']) {
    const [prefix] = normalized.split(separator);
    if (prefix) {
      variants.add(prefix);
    }
  }
  return variants;
}

function isExplorePseudoToolName(name) {
  const normalized = pseudoToolBaseName(name);
  const variants = pseudoToolNameVariants(name);
  return (
    ['explore', 'search', 'browse', 'repo_browser', 'repo_browser.search', 'codebase.search', 'workspace.search', 'grep', 'rg', 'ripgrep'].includes(normalized) ||
    variants.has('explore') ||
    variants.has('search') ||
    variants.has('browse') ||
    variants.has('repo') ||
    variants.has('repo_browser') ||
    variants.has('codebase') ||
    variants.has('workspace')
  );
}

function isAgentPseudoToolName(name) {
  return pseudoToolNameVariants(name).has('agent');
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
  const exploreLike = isExplorePseudoToolName(call.name);
  const subagentType =
    isRecord(input) && typeof input.subagent_type === 'string'
      ? input.subagent_type
      : exploreLike
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
  const exploreLike = isExplorePseudoToolName(call.name);
  const agentLike = isAgentPseudoToolName(call.name);
  const agentToolName = resolveAllowedToolName('Agent', allowedToolNames);
  if (agentToolName && (agentLike || exploreLike)) {
    return {
      ...call,
      name: agentToolName,
      input: normalizeAgentToolInput(call)
    };
  }
  const taskToolName = resolveAllowedToolName('Task', allowedToolNames);
  if (taskToolName && (agentLike || exploreLike)) {
    return {
      ...call,
      name: taskToolName,
      input: {
        description: pseudoToolDescription(call.name, call.input),
        prompt: formatPseudoToolPrompt(call.name, call.input),
        subagent_type: exploreLike ? 'Explore' : 'general-purpose'
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
  if (normalizedName === 'web_search' || normalizedName === 'websearch') {
    const query = asString(input.query || input.search_query || input.q).trim();
    return query ? { query } : {};
  }
  const sanitized = { ...input };
  if (normalizedName === 'read') {
    if (!asString(sanitized.file_path).trim()) {
      const filePath = asString(sanitized.path || sanitized.file || sanitized.filename).trim();
      if (filePath) {
        sanitized.file_path = filePath;
      }
    }
    const lineStart = Number.parseInt(sanitized.line_start ?? sanitized.start, 10);
    const lineEnd = Number.parseInt(sanitized.line_end ?? sanitized.end, 10);
    if (!Object.hasOwn(sanitized, 'offset') && Number.isFinite(lineStart) && lineStart > 0) {
      sanitized.offset = lineStart;
    }
    if (
      !Object.hasOwn(sanitized, 'limit') &&
      Number.isFinite(lineStart) &&
      lineStart > 0 &&
      Number.isFinite(lineEnd) &&
      lineEnd >= lineStart
    ) {
      sanitized.limit = lineEnd - lineStart + 1;
    }
    delete sanitized.path;
    delete sanitized.file;
    delete sanitized.filename;
    delete sanitized.lines;
    delete sanitized.line;
    delete sanitized.line_start;
    delete sanitized.line_end;
    delete sanitized.start;
    delete sanitized.end;
  }
  if (normalizedName === 'write') {
    if (!asString(sanitized.file_path).trim()) {
      const filePath = asString(sanitized.path || sanitized.file || sanitized.filename).trim();
      if (filePath) {
        sanitized.file_path = filePath;
      }
    }
    if (typeof sanitized.content !== 'string') {
      const content = asString(sanitized.text || sanitized.data || sanitized.append).trim();
      if (content) {
        sanitized.content = content;
      }
    }
    delete sanitized.path;
    delete sanitized.file;
    delete sanitized.filename;
    delete sanitized.text;
    delete sanitized.data;
    delete sanitized.append;
    delete sanitized.mode;
  }
  if (normalizedName === 'edit') {
    if (!asString(sanitized.file_path).trim()) {
      const filePath = asString(sanitized.path || sanitized.file || sanitized.filename).trim();
      if (filePath) {
        sanitized.file_path = filePath;
      }
    }
    delete sanitized.path;
    delete sanitized.file;
    delete sanitized.filename;
    delete sanitized.mode;
  }
  if (normalizedName === 'agent') {
    delete sanitized.callId;
    delete sanitized.call_id;
  }
  if (normalizedName === 'bash') {
    if (Array.isArray(sanitized.command)) {
      sanitized.command =
        sanitized.command.length >= 3 &&
        String(sanitized.command[0]) === 'bash' &&
        String(sanitized.command[1]) === '-lc'
          ? String(sanitized.command.slice(2).join(' '))
          : sanitized.command.map(part => String(part)).join(' ');
    } else if (!asString(sanitized.command).trim() && Array.isArray(sanitized.cmd)) {
      sanitized.command =
        sanitized.cmd.length >= 3 &&
        String(sanitized.cmd[0]) === 'bash' &&
        String(sanitized.cmd[1]) === '-lc'
          ? String(sanitized.cmd.slice(2).join(' '))
          : sanitized.cmd.map(part => String(part)).join(' ');
      delete sanitized.cmd;
    } else if (!asString(sanitized.command).trim() && typeof sanitized.cmd === 'string') {
      sanitized.command = sanitized.cmd;
      delete sanitized.cmd;
    }
  }
  return sanitized;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function commandFromArgv(value) {
  if (Array.isArray(value)) {
    if (value.length >= 3 && String(value[0]) === 'bash' && String(value[1]) === '-lc') {
      return String(value.slice(2).join(' '));
    }
    return value.map(part => String(part)).join(' ');
  }
  return asString(value).trim();
}

function aliasShellPseudoToolCall(call, allowedToolNames = []) {
  const bashToolName = resolveAllowedToolName('Bash', allowedToolNames);
  if (!bashToolName) {
    return undefined;
  }
  const normalized = normalizeToolNameForLookup(call.name);
  const input = isRecord(call.input) ? call.input : {};
  if (
    normalized === 'container.exec' ||
    normalized === 'exec_command' ||
    normalized === 'tool_bash' ||
    (normalized.startsWith('toolu_') && (Object.hasOwn(input, 'command') || Object.hasOwn(input, 'cmd')))
  ) {
    const command = commandFromArgv(input.command || input.cmd);
    return command ? { ...call, name: bashToolName, input: { command } } : undefined;
  }
  if (normalized === 'repo_browser.print_tree') {
    const targetPath = asString(input.path).trim() || '.';
    const depth = Math.max(1, Math.min(8, Number.parseInt(input.depth, 10) || 3));
    return {
      ...call,
      name: bashToolName,
      input: {
        command: `find ${shellQuote(targetPath)} -maxdepth ${depth} -print | sed -n '1,200p'`
      }
    };
  }
  if (normalized === 'repo_browser.search' || normalized === 'repo_browser.find') {
    const targetPath = asString(input.path).trim() || '.';
    const query = asString(input.query || input.pattern || input.search).trim();
    if (!query) {
      return undefined;
    }
    return {
      ...call,
      name: bashToolName,
      input: {
        command: `grep -RIn --exclude-dir=.git --exclude-dir=node_modules -- ${shellQuote(query)} ${shellQuote(targetPath)} | head -100`
      }
    };
  }
  if (normalized === 'repo_browser.open_file' || normalized === 'open_file') {
    const targetPath = asString(input.path || input.file).trim();
    if (!targetPath) {
      return undefined;
    }
    const start = Math.max(1, Number.parseInt(input.line_start || input.start || 1, 10) || 1);
    const end = Math.max(start, Number.parseInt(input.line_end || input.end || start + 199, 10) || start + 199);
    return {
      ...call,
      name: bashToolName,
      input: {
        command: `sed -n '${start},${end}p' ${shellQuote(targetPath)}`
      }
    };
  }
  return undefined;
}

function aliasFilePseudoToolCall(call, allowedToolNames = []) {
  const normalized = normalizeToolNameForLookup(call.name);
  const input = isRecord(call.input) ? call.input : {};
  const requestedAction = asString(input.action || input.operation).trim().toLowerCase();
  const appendMode =
    ['a', 'append'].includes(asString(input.mode).trim().toLowerCase()) ||
    requestedAction === 'append' ||
    typeof input.append === 'string';
  const prependMode = requestedAction === 'prepend';
  const bashToolName = resolveAllowedToolName('Bash', allowedToolNames);
  if (
    normalized === 'edit' &&
    isRecord(input) &&
    asString(input.file_path || input.path || input.file || input.filename).trim() &&
    (appendMode || prependMode)
  ) {
    const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
    const content =
      typeof input.new_content === 'string'
        ? input.new_content
        : typeof input.newString === 'string'
          ? input.newString
          : typeof input.new_string === 'string'
            ? input.new_string
            : typeof input.content === 'string'
              ? input.content
              : typeof input.append === 'string'
                ? input.append
                : '';
    if (!content || !bashToolName) {
      return undefined;
    }
    const command = prependMode
      ? `tmp=$(mktemp) && printf %s ${shellQuote(content)} > "$tmp" && cat ${shellQuote(filePath)} >> "$tmp" && mv "$tmp" ${shellQuote(filePath)}`
      : `printf %s ${shellQuote(content)} >> ${shellQuote(filePath)}`;
    return { ...call, name: bashToolName, input: { command } };
  }
  if (
    normalized === 'edit' &&
    isRecord(input) &&
    asString(input.file_path || input.path || input.file || input.filename).trim() &&
    typeof input.old_string === 'string' &&
    input.old_string.length === 0 &&
    typeof input.new_string === 'string'
  ) {
    const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
    return bashToolName
      ? { ...call, name: bashToolName, input: { command: `printf %s ${shellQuote(input.new_string)} >> ${shellQuote(filePath)}` } }
      : undefined;
  }
  if (normalized === 'repo_browser.read_file' || normalized === 'read_file' || normalized === 'file_read' || normalized === 'fileread') {
    const readToolName = resolveAllowedToolName('Read', allowedToolNames);
    if (!readToolName) {
      return undefined;
    }
    const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
    return filePath ? { ...call, name: readToolName, input: { ...input, file_path: filePath } } : undefined;
  }
  if (normalized === 'write_file' || normalized === 'file_write' || normalized === 'filewrite') {
    const writeToolName = resolveAllowedToolName('Write', allowedToolNames);
    if (!writeToolName) {
      return undefined;
    }
    const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
    if (!filePath) {
      return undefined;
    }
    const content =
      typeof input.content === 'string'
        ? input.content
        : typeof input.text === 'string'
          ? input.text
          : typeof input.data === 'string'
            ? input.data
            : typeof input.append === 'string'
              ? input.append
              : '';
    if (appendMode) {
      return bashToolName
        ? { ...call, name: bashToolName, input: { command: `printf %s ${shellQuote(content)} >> ${shellQuote(filePath)}` } }
        : undefined;
    }
    return { ...call, name: writeToolName, input: { ...input, file_path: filePath, content } };
  }
  if (normalized === 'fileedit' || normalized === 'file_edit' || normalized === 'edit_file') {
    const editToolName = resolveAllowedToolName('Edit', allowedToolNames);
    const writeToolName = resolveAllowedToolName('Write', allowedToolNames);
    const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
    if (!filePath) {
      return undefined;
    }
    const content =
      typeof input.content === 'string'
        ? input.content
        : typeof input.text === 'string'
          ? input.text
          : typeof input.data === 'string'
            ? input.data
            : typeof input.append === 'string'
              ? input.append
              : '';
    if (appendMode) {
      return bashToolName
        ? { ...call, name: bashToolName, input: { command: `printf %s ${shellQuote(content)} >> ${shellQuote(filePath)}` } }
        : undefined;
    }
    const selectedToolName = editToolName || writeToolName;
    if (!selectedToolName) {
      return undefined;
    }
    return {
      ...call,
      name: selectedToolName,
      input: { ...input, file_path: filePath, content }
    };
  }
  if (normalized === 'write') {
    const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
    const content = typeof input.content === 'string'
      ? input.content
      : typeof input.text === 'string'
        ? input.text
        : typeof input.data === 'string'
          ? input.data
          : typeof input.append === 'string'
            ? input.append
            : '';
    if (!filePath || typeof content !== 'string') {
      return undefined;
    }
    if (appendMode) {
      return bashToolName
        ? { ...call, name: bashToolName, input: { command: `printf %s ${shellQuote(content)} >> ${shellQuote(filePath)}` } }
        : undefined;
    }
    const existing = readExistingLocalToolFile(filePath);
    if (existing !== undefined && content.startsWith(existing) && content.length > existing.length) {
      const suffix = content.slice(existing.length);
      return bashToolName
        ? { ...call, name: bashToolName, input: { command: `printf %s ${shellQuote(suffix)} >> ${shellQuote(filePath)}` } }
        : undefined;
    }
    if (existing !== undefined) {
      return bashToolName
        ? {
            ...call,
            name: bashToolName,
            input: {
              command: [
                'printf %s',
                shellQuote(
                  [
                    'SpiLLI bridge blocked an unsafe Write tool call.',
                    `The model attempted to overwrite existing file ${filePath} with reconstructed content.`,
                    'Use Edit with old_string/new_string for targeted modifications, or Bash with a shell append command if Bash is available.'
                  ].join('\n')
                ),
                '>&2',
                'exit 1'
              ].join(' ')
            }
          }
        : undefined;
    }
  }
  return undefined;
}

function readExistingLocalToolFile(filePath) {
  const normalizedPath = asString(filePath).trim();
  if (!normalizedPath) {
    return undefined;
  }
  try {
    const resolvedPath = path.isAbsolute(normalizedPath)
      ? normalizedPath
      : path.resolve(process.cwd(), normalizedPath);
    const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      return undefined;
    }
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return undefined;
  }
}

function contentContainsCompactionArtifact(content) {
  const text = String(content ?? '');
  return (
    /\[(?:tail excerpt|head excerpt|compacted tool result|summarized earlier conversation by SpiLLI API bridge)/i.test(text) ||
    /\[\.\.\.\s*\d+\s+(?:characters|tokens|lines)\s+omitted/i.test(text) ||
    /\[\.\.\.\s*[\s\S]{0,120}\s+omitted from (?:older conversation history|latest history item|tool result) by SpiLLI API bridge/i.test(text)
  );
}

function isUnsafeNativeFileToolCall(call) {
  const normalized = normalizeToolNameForLookup(call?.name);
  if (normalized !== 'write') {
    return false;
  }
  const input = isRecord(call.input) ? call.input : {};
  const content = typeof input.content === 'string' ? input.content : undefined;
  if (typeof content !== 'string') {
    return false;
  }
  if (contentContainsCompactionArtifact(content)) {
    return true;
  }
  const filePath = asString(input.file_path || input.path || input.file || input.filename).trim();
  const existing = readExistingLocalToolFile(filePath);
  return existing !== undefined && content !== existing;
}

function unwrapGenericToolRunCall(call) {
  const normalized = normalizeToolNameForLookup(call?.name);
  if (!['tool.run', 'run_tool', 'tool_run'].includes(normalized)) {
    return call;
  }
  const input = isRecord(call.input) ? call.input : {};
  const name = asString(input.name || input.tool || input.tool_name || input.toolName).trim();
  if (!name) {
    return call;
  }
  const args = isRecord(input.arguments)
    ? input.arguments
    : isRecord(input.args)
      ? input.args
      : isRecord(input.input)
        ? input.input
        : {};
  return {
    ...call,
    name,
    input: args
  };
}

function inferAnonymousToolCall(call) {
  if (asString(call?.name).trim()) {
    return call;
  }
  const input = isRecord(call?.input) ? call.input : {};
  const query = asString(input.query || input.pattern || input.search).trim();
  if (!query) {
    return call;
  }
  if (
    Object.hasOwn(input, 'path') ||
    Object.hasOwn(input, 'max_results') ||
    Object.hasOwn(input, 'pattern') ||
    Object.hasOwn(input, 'search')
  ) {
    return {
      ...call,
      name: 'repo_browser.search',
      input
    };
  }
  return call;
}

function normalizeToolCallForAllowedTools(call, allowedToolNames = []) {
  const unwrappedCall = inferAnonymousToolCall(unwrapGenericToolRunCall(call));
  const fileAliased = aliasFilePseudoToolCall(unwrappedCall, allowedToolNames);
  if (fileAliased) {
    return { ...fileAliased, input: sanitizeToolInput(fileAliased.name, fileAliased.input) };
  }
  if (isUnsafeNativeFileToolCall(unwrappedCall)) {
    return undefined;
  }
  const allowedName = resolveAllowedToolName(unwrappedCall.name, allowedToolNames);
  if (allowedName) {
    const normalized = { ...unwrappedCall, name: allowedName };
    const input = normalizeToolNameForLookup(allowedName) === 'agent'
      ? normalizeAgentToolInput(normalized)
      : normalized.input;
    return { ...normalized, input: sanitizeToolInput(allowedName, input) };
  }
  const shellAliased = aliasShellPseudoToolCall(unwrappedCall, allowedToolNames);
  if (shellAliased) {
    return { ...shellAliased, input: sanitizeToolInput(shellAliased.name, shellAliased.input) };
  }
  const aliased = aliasPseudoToolCall(unwrappedCall, allowedToolNames);
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
      const channelName = asString(segment.channel).trim().split(/\s+/)[0].toLowerCase();
      const anonymousCommentaryJson =
        !hasRecipient && channelName === 'commentary' && segment.content.trim().startsWith('{');
      const isToolish =
        segment.terminator === 'call' || (hasRecipient && segment.terminator === 'end') || anonymousCommentaryJson;
      if (!isToolish) {
        continue;
      }
      const parsed = tryParseJson(segment.content.trim());
      const parsedContent = isRecord(parsed) ? parsed : {};
      const payloadToolName = asString(
        parsedContent.toolName ||
          parsedContent.name ||
          parsedContent.tool ||
          parsedContent.tool_name ||
          parsedContent.toolName
      ).trim();
      const rawName = payloadToolName || asString(segment.recipient).trim();
      if (!rawName && !isRecord(parsed)) {
        continue;
      }
      const input = isRecord(parsedContent.args)
        ? {
            ...parsedContent.args,
            ...(typeof parsedContent.subagent_type === 'string' ? { subagent_type: parsedContent.subagent_type } : {}),
            ...(typeof parsedContent.description === 'string' ? { description: parsedContent.description } : {}),
            ...(typeof parsedContent.prompt === 'string' ? { prompt: parsedContent.prompt } : {})
          }
        : isRecord(parsedContent.arguments)
          ? parsedContent.arguments
          : isRecord(parsedContent.input)
            ? parsedContent.input
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
    .replace(/\|<stop_reason>\|[\s\S]*?\|<\/stop_reason>\|/g, '')
    .replace(/\[EOG\]\s*$/g, '')
    .trim();
}

function extractSpilliStopReason(raw) {
  const match = String(raw ?? '').match(/\|<stop_reason>\|([\s\S]*?)\|<\/stop_reason>\|/);
  const reason = match?.[1]?.trim();
  return reason === 'max_tokens' ? 'max_tokens' : undefined;
}

function createBridgeToolUseId(prefix = 'toolu_spilli') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 64);
}

function buildContinueAfterMaxTokensQuestion() {
  const question = 'Generation reached the configured token limit. Would you like SpiLLI to continue generating from the current session?';
  return {
    questions: [
      {
        question,
        header: 'Continue?',
        options: [
          {
            label: 'Continue',
            description: 'Ask the model to keep generating from the current warm context.'
          },
          {
            label: 'Stop',
            description: 'Stop here and keep the current partial response.'
          }
        ],
        multiSelect: false
      }
    ]
  };
}

function shouldAskContinueAfterMaxTokens({ stopReason, toolCalls, allowedToolNames, config }) {
  if (stopReason !== 'max_tokens' || toolCalls.length > 0 || config?.askContinueOnMaxTokens === false) {
    return false;
  }
  return Boolean(resolveAllowedToolName('AskUserQuestion', allowedToolNames));
}

function readPositiveInteger(value) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function maxTokensFromAnthropicBody(body) {
  return readPositiveInteger(body?.max_tokens);
}

function maxTokensFromOpenAiChatBody(body) {
  return readPositiveInteger(body?.max_completion_tokens) ?? readPositiveInteger(body?.max_tokens);
}

function maxTokensFromResponsesBody(body) {
  return readPositiveInteger(body?.max_output_tokens);
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
    const parsedFinalMessages = parsed.messages
      .filter(segment => asString(segment.channel).trim().split(/\s+/)[0] === 'final')
      .map(segment => stripHarmonyControlTokens(segment.content))
      .map(text => text.trim())
      .filter(Boolean);
    if (parsedFinalMessages.length === 1) {
      return parsedFinalMessages[0];
    }
    if (parsedFinalMessages.length > 1) {
      const substantive = parsedFinalMessages
        .filter(text => text.length >= 80)
        .filter(text => !/^this is the end of the conversation\.?$/i.test(text.trim()));
      const candidates = substantive.length > 0 ? substantive : parsedFinalMessages;
      return candidates.reduce((best, text) => (text.length > best.length ? text : best), candidates[0]);
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

function normalizeWebSearchResultBlock(part) {
  const title = asString(part.title || part.document_title).trim();
  const url = asString(part.url).trim();
  const pageAge = asString(part.page_age || part.pageAge).trim();
  const citedText = asString(part.cited_text || part.citedText || part.text || part.snippet).trim();
  const lines = [];
  if (title || url) {
    lines.push(`- ${title || url}${url && title ? ` (${url})` : ''}`);
  }
  if (pageAge) {
    lines.push(`  Page age: ${pageAge}`);
  }
  if (citedText) {
    lines.push(`  Excerpt: ${citedText}`);
  }
  return lines.join('\n');
}

function clipForModelContext(text, maxChars, label = 'content') {
  const normalized = asString(text);
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  const headLength = Math.max(0, Math.floor(maxChars * 0.7));
  const tailLength = Math.max(0, maxChars - headLength);
  const omitted = normalized.length - headLength - tailLength;
  return [
    normalized.slice(0, headLength).trimEnd(),
    `[... ${omitted} characters omitted from ${label} by SpiLLI API bridge ...]`,
    normalized.slice(normalized.length - tailLength).trimStart()
  ].join('\n');
}

function takeLinesWithinBudget(lines, maxChars) {
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const next = asString(line);
    const cost = next.length + 1;
    if (kept.length > 0 && used + cost > maxChars) {
      break;
    }
    kept.push(next);
    used += cost;
  }
  return kept.join('\n');
}

function compactGrepLikeOutput(text, targetChars) {
  const lines = asString(text).split(/\r?\n/).filter(Boolean);
  const grepLines = lines.filter(line => /^[^:\n]+:\d+(?::\d+)?:/.test(line));
  if (grepLines.length < Math.max(2, Math.floor(lines.length * 0.4))) {
    return undefined;
  }
  const byFile = new Map();
  for (const line of grepLines) {
    const file = line.match(/^([^:\n]+):\d+(?::\d+)?:/)?.[1] || 'matches';
    const bucket = byFile.get(file) || [];
    if (bucket.length < 4) {
      bucket.push(line);
    }
    byFile.set(file, bucket);
  }
  const compacted = [];
  compacted.push(`Matched ${grepLines.length} lines across ${byFile.size} files.`);
  for (const [file, fileLines] of byFile.entries()) {
    compacted.push(`\n${file}`);
    compacted.push(...fileLines.map(line => `  ${line}`));
    if (takeLinesWithinBudget(compacted, targetChars).length >= targetChars) {
      break;
    }
  }
  return takeLinesWithinBudget(compacted, targetChars);
}

function compactJsonLikeOutput(text, targetChars) {
  const parsed = tryParseJson(asString(text).trim());
  if (!parsed) {
    return undefined;
  }
  const seen = new WeakSet();
  const simplify = value => {
    if (Array.isArray(value)) {
      return value.slice(0, 20).map(simplify);
    }
    if (isRecord(value)) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
      const out = {};
      for (const [key, item] of Object.entries(value).slice(0, 30)) {
        if (typeof item === 'string') {
          out[key] = item.length > 600 ? `${item.slice(0, 600)}... [${item.length - 600} chars omitted]` : item;
        } else {
          out[key] = simplify(item);
        }
      }
      return out;
    }
    return value;
  };
  return clipForModelContext(JSON.stringify(simplify(parsed), null, 2), targetChars, 'JSON tool result');
}

function compactGenericOutput(text, targetChars) {
  const normalized = asString(text).trim();
  if (normalized.length <= targetChars) {
    return normalized;
  }
  const lines = normalized.split(/\r?\n/);
  if (lines.length <= 2) {
    return clipForModelContext(normalized, targetChars, 'single-line tool result');
  }
  const informative = lines.filter(line => line.trim()).slice(0, 200);
  const headerLike = informative.filter(line =>
    /^\s*(?:class|def|function|const|let|var|export|import|async|#|##|\*|-|\d+\.|\w[\w.-]+:)/.test(line)
  );
  const candidates = headerLike.length >= 8 ? headerLike : informative;
  const headBudget = Math.floor(targetChars * 0.7);
  const tailBudget = Math.max(0, targetChars - headBudget - 160);
  const head = takeLinesWithinBudget(candidates, headBudget);
  const tail = tailBudget > 0 ? takeLinesWithinBudget(lines.slice(-40), tailBudget) : '';
  return [head, tail ? '\n[tail excerpt]\n' + tail : ''].filter(Boolean).join('');
}

function compactToolResultForModelContext(text, options = {}) {
  const normalized = asString(text);
  const rawLimit = Number.isFinite(options.toolResultRawChars)
    ? options.toolResultRawChars
    : DEFAULT_TOOL_RESULT_RAW_CHARS;
  const compactLimit = Number.isFinite(options.toolResultCompactChars)
    ? options.toolResultCompactChars
    : DEFAULT_TOOL_RESULT_COMPACT_CHARS;
  const compactTarget = Number.isFinite(options.toolResultCompactTargetChars)
    ? options.toolResultCompactTargetChars
    : DEFAULT_TOOL_RESULT_COMPACT_TARGET_CHARS;
  const summaryTarget = Number.isFinite(options.toolResultSummaryTargetChars)
    ? options.toolResultSummaryTargetChars
    : DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS;
  if (normalized.length <= rawLimit) {
    return normalized;
  }
  const needsSummarizer = normalized.length > compactLimit;
  const target = needsSummarizer ? summaryTarget : compactTarget;
  const compacted =
    compactGrepLikeOutput(normalized, target) ||
    compactJsonLikeOutput(normalized, target) ||
    compactGenericOutput(normalized, target);
  const mode = needsSummarizer ? 'summarizer-recommended deterministic pre-summary' : 'deterministic';
  const endpoint = asString(options.toolResultSummarizerEndpoint).trim();
  const summarizerHint = needsSummarizer
    ? endpoint
      ? `\nSummarizer endpoint configured: ${endpoint}`
      : '\nSummarizer endpoint not configured; using deterministic pre-summary.'
    : '';
  return [
    `[compacted tool result: mode=${mode}; original_chars=${normalized.length}; compacted_chars=${compacted.length}]${summarizerHint}`,
    compacted
  ].join('\n');
}

function buildSummarizedToolResultText({ originalText, summaryText, toolUseId, targetChars }) {
  const summary = clipForModelContext(summaryText, targetChars, `summary for ${toolUseId || 'tool result'}`).trim();
  return [
    `[summarized tool result: original_chars=${asString(originalText).length}; summary_chars=${summary.length}; summarizer=spilli-sdk]`,
    summary
  ].join('\n');
}

async function summarizeTextWithSpilliSdk({
  text,
  model,
  config,
  instruction = '',
  targetChars = DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS,
  source = 'tool_result'
}) {
  const normalized = asString(text).trim();
  if (!normalized) {
    return '';
  }
  const requestedModel = asString(model || config.toolResultSummarizerModel).trim();
  if (!requestedModel) {
    throw Object.assign(new Error('A model is required for SpiLLI summarization.'), { statusCode: 400 });
  }
  const resolvedModel = await resolveRequestedModel(requestedModel, config);
  const resource = buildResource(resolvedModel, config);
  const service = getService(config);
  const session = await requestSpilliSessionForResource(service, resource, config.allocationTimeoutMs);
  const prompt = [
    'You summarize tool outputs for an agent context window.',
    'Preserve facts, file paths, line numbers, errors, commands, URLs, and decisions.',
    'Do not invent missing information. Do not include hidden analysis.',
    `Target length: at most ${targetChars} characters.`,
    instruction ? `Caller instruction: ${instruction}` : ''
  ].filter(Boolean).join('\n');
  const query = [
    `Summarize this ${source} for the calling agent.`,
    'Return only the summary text.',
    '',
    normalized
  ].join('\n');
  const result = await runInference(
    { requestedModel, prompt, query },
    { ...config, runTimeoutMs: config.toolResultSummarizerTimeoutMs || config.runTimeoutMs },
    {},
    session,
    resolvedModel
  );
  const finalText = extractHarmonyFinalText(result.raw) || stripHarmonyControlTokens(result.raw);
  return clipForModelContext(finalText.trim(), targetChars, 'SpiLLI tool result summary');
}

function cloneAnthropicBodyWithMessages(body, messages) {
  return {
    ...body,
    messages
  };
}

async function summarizeOversizedToolResultsInBody(body, config) {
  if (!config.compactToolResults || !config.toolResultSummarizerEnabled || !Array.isArray(body?.messages)) {
    return body;
  }
  const threshold = Number.isFinite(config.toolResultCompactChars)
    ? config.toolResultCompactChars
    : DEFAULT_TOOL_RESULT_COMPACT_CHARS;
  const targetChars = Number.isFinite(config.toolResultSummaryTargetChars)
    ? config.toolResultSummaryTargetChars
    : DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS;
  const requestedModel = asString(config.toolResultSummarizerModel || body?.model).trim();
  if (!requestedModel) {
    return body;
  }
  let changed = false;
  const messages = [];
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    const content = [];
    for (const part of message.content) {
      if (!isRecord(part) || (part.type !== 'tool_result' && part.type !== 'web_search_tool_result')) {
        content.push(part);
        continue;
      }
      const rawText = normalizeContent(part.content, {
        toolResultRawChars: Number.MAX_SAFE_INTEGER,
        toolResultCompactChars: Number.MAX_SAFE_INTEGER
      });
      if (rawText.length <= threshold) {
        content.push(part);
        continue;
      }
      const toolUseId = asString(part.tool_use_id) || 'tool';
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'tool_result.summarize.start',
        summary: {
          model: requestedModel,
          toolUseId,
          originalChars: rawText.length,
          targetChars
        }
      }, 'SUMMARY');
      try {
        const summaryText = await summarizeTextWithSpilliSdk({
          text: rawText,
          model: requestedModel,
          config,
          targetChars,
          source: part.type
        });
        const summarized = buildSummarizedToolResultText({
          originalText: rawText,
          summaryText,
          toolUseId,
          targetChars
        });
        content.push({
          ...part,
          content: summarized
        });
        changed = true;
        await appendLog({
          timestamp: new Date().toISOString(),
          kind: 'tool_result.summarize.complete',
          summary: {
            model: requestedModel,
            toolUseId,
            originalChars: rawText.length,
            summaryChars: summarized.length
          }
        }, 'SUMMARY');
      } catch (error) {
        content.push(part);
        await appendLog({
          timestamp: new Date().toISOString(),
          kind: 'tool_result.summarize.error',
          summary: {
            model: requestedModel,
            toolUseId,
            originalChars: rawText.length
          },
          error: errorSummary(error)
        }, 'SUMMARY');
      }
    }
    messages.push({
      ...message,
      content
    });
  }
  return changed ? cloneAnthropicBodyWithMessages(body, messages) : body;
}

function normalizeContentBlock(part, options = {}) {
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
    const rawText = normalizeContent(part.content, options);
    const resultText = options.compactToolResults
      ? compactToolResultForModelContext(rawText, options)
      : rawText;
    const errorText = part.is_error ? '\nTool status: error' : '';
    return `Tool result for ${asString(part.tool_use_id) || 'tool'}:${errorText}\n${resultText}`.trim();
  }
  if (part.type === 'tool_use') {
    return `Tool call ${asString(part.name)}(${JSON.stringify(part.input ?? {})})`;
  }
  if (part.type === 'web_search_tool_result') {
    const rawText = normalizeContent(part.content, options);
    const resultText = options.compactToolResults
      ? compactToolResultForModelContext(rawText, options)
      : rawText;
    return `Web search results for ${asString(part.tool_use_id) || 'tool'}:\n${resultText}`.trim();
  }
  if (part.type === 'web_search_result' || part.type === 'web_search_result_location') {
    return normalizeWebSearchResultBlock(part);
  }
  if (part.type === 'web_search_tool_result_error') {
    return `Web search error: ${asString(part.error_code || part.errorCode || 'unknown')}`;
  }
  if (part.type === 'image') {
    return '[Image input omitted by SpiLLI API bridge]';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.content === 'string' || Array.isArray(part.content) || isRecord(part.content)) {
    return normalizeContent(part.content, options);
  }
  if (part.title || part.url || part.cited_text || part.snippet) {
    return normalizeWebSearchResultBlock(part);
  }
  return JSON.stringify(sanitizeForLog(part));
}

function normalizeContent(content, options = {}) {
  if (typeof content === 'string') {
    return content;
  }
  if (isRecord(content)) {
    return normalizeContentBlock(content, options);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(part => normalizeContentBlock(part, options))
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

function normalizeToolForPrompt(tool) {
  if (!isRecord(tool)) {
    return undefined;
  }
  const name = asString(tool.name || tool.function?.name).trim();
  if (!name) {
    return undefined;
  }
  const description = asString(tool.description || tool.function?.description).trim();
  const inputSchema = tool.input_schema || tool.inputSchema || tool.function?.parameters || tool.function?.input_schema;
  const normalized = {
    name,
    ...(description ? { description } : {}),
    ...(inputSchema ? { input_schema: inputSchema } : {})
  };
  if (Array.isArray(tool.input_examples)) {
    normalized.input_examples = tool.input_examples;
  } else if (Array.isArray(tool.inputExamples)) {
    normalized.input_examples = tool.inputExamples;
  }
  return normalized;
}

function sortedToolsForPrompt(tools) {
  const priority = new Map([
    ['read', 0],
    ['edit', 1],
    ['write', 2],
    ['bash', 3],
    ['websearch', 4],
    ['webfetch', 5],
    ['agent', 6],
    ['askuserquestion', 7]
  ]);
  return tools
    .map((tool, index) => ({ tool, index, priority: priority.get(normalizeToolNameForLookup(tool.name)) ?? 100 }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(item => item.tool);
}

function buildToolSchemaPrompt(tools, options = {}) {
  if (!options.renderToolSchemas || !Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  const maxChars = Math.max(
    4000,
    Math.min(
      readPositiveInteger(options.toolSchemaPromptMaxChars) ?? DEFAULT_TOOL_SCHEMA_PROMPT_MAX_CHARS,
      120000
    )
  );
  const header = [
    'In this environment you have access to a set of tools you can use to answer the user.',
    'Tool calls must be emitted in the Harmony commentary channel using the exact tool name and a JSON object matching the tool input_schema.',
    'String and scalar parameters should be specified as JSON string/number/boolean values; arrays and objects should use JSON values.',
    'For file changes, prefer Edit for partial modifications. Write overwrites files and should be used only for new files or full replacement when the schema description permits it.',
    '',
    'Here are the available tools in JSON Schema format:'
  ].join('\n');
  const blocks = [header];
  let omitted = 0;
  for (const tool of sortedToolsForPrompt(tools.map(normalizeToolForPrompt).filter(Boolean))) {
    const block = JSON.stringify(tool, null, 2);
    const next = `${blocks.join('\n\n')}\n\n${block}`;
    if (next.length > maxChars) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
  }
  if (omitted > 0) {
    blocks.push(`[${omitted} lower-priority tool definition${omitted === 1 ? '' : 's'} omitted by SpiLLI API bridge to fit the local tool-schema prompt budget.]`);
  }
  return blocks.join('\n\n');
}

function buildAnthropicPromptParts(body, options = {}) {
  const toolSchemaPrompt = buildToolSchemaPrompt(body?.tools, options);
  const systemPrompt = normalizeSystem(body?.system);
  return {
    prompt: [toolSchemaPrompt, systemPrompt].filter(part => asString(part).trim()).join('\n\n'),
    toolSchemaPrompt,
    systemPrompt
  };
}

function buildAnthropicPrompt(body, options = {}) {
  return buildAnthropicPromptParts(body, options).prompt;
}

function buildPromptFootprint(promptParts, query, options = {}) {
  const prompt = asString(promptParts?.prompt);
  const toolSchemaPrompt = asString(promptParts?.toolSchemaPrompt);
  const systemPrompt = asString(promptParts?.systemPrompt);
  const queryText = asString(query);
  return {
    promptChars: prompt.length,
    systemChars: systemPrompt.length,
    toolSchemaChars: toolSchemaPrompt.length,
    queryChars: queryText.length,
    totalInputChars: prompt.length + queryText.length,
    promptUnits: estimateTokens(prompt),
    queryUnits: estimateTokens(queryText),
    totalInputUnits: estimateTokens(`${prompt}\n\n${queryText}`),
    toolCount: Number.isFinite(options.toolCount) ? options.toolCount : undefined,
    toolSchemaMaxChars: options.toolSchemaPromptMaxChars ?? undefined
  };
}

function hashHistoryValue(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function messageText(role, content) {
  const normalizedRole = asString(role || 'user').trim().toUpperCase() || 'USER';
  return `${normalizedRole}:\n${content}`;
}

function createHistoryItem(role, content) {
  const normalizedRole = asString(role || 'user').trim().toLowerCase() || 'user';
  const normalizedContent = asString(content);
  const text = messageText(normalizedRole, normalizedContent);
  return {
    role: normalizedRole,
    content: normalizedContent,
    text,
    hash: hashHistoryValue(text)
  };
}

function getModelContextLimitTokens(resolvedModel) {
  const capabilities = resolvedModel?.capabilities;
  if (!isRecord(capabilities)) {
    return undefined;
  }
  const supportsDynamicContext =
    capabilities.supports_dynamic_context_budgeting === true ||
    capabilities.supportsDynamicContextBudgeting === true;
  if (supportsDynamicContext) {
    const dynamicDesired =
      readPositiveNumber(capabilities.dynamicContextDesiredTokens) ??
      readPositiveNumber(capabilities.dynamic_context_desired_tokens);
    if (dynamicDesired) {
      return dynamicDesired;
    }
  }
  return (
    readPositiveNumber(capabilities.desiredContextTokens) ??
    readPositiveNumber(capabilities.desired_context_tokens) ??
    readPositiveNumber(capabilities.pipelineDesiredContextTokens) ??
    readPositiveNumber(capabilities.pipeline_desired_context_tokens) ??
    readPositiveNumber(capabilities.pipelineSafeContextTokens) ??
    readPositiveNumber(capabilities.pipeline_safe_context_tokens) ??
    readPositiveNumber(capabilities.safeContextTokens) ??
    readPositiveNumber(capabilities.safe_context_tokens) ??
    readPositiveNumber(capabilities.contextWindowTokens) ??
    readPositiveNumber(capabilities.context_window_tokens)
  );
}

function getModelMinimumContextTokens(resolvedModel) {
  const capabilities = resolvedModel?.capabilities;
  if (!isRecord(capabilities)) {
    return undefined;
  }
  return (
    readPositiveNumber(capabilities.dynamicContextMinimumTokens) ??
    readPositiveNumber(capabilities.dynamic_context_minimum_tokens) ??
    readPositiveNumber(capabilities.minimumContextTokens) ??
    readPositiveNumber(capabilities.minimum_context_tokens) ??
    readPositiveNumber(capabilities.pipelineMinimumContextTokens) ??
    readPositiveNumber(capabilities.pipeline_minimum_context_tokens) ??
    readPositiveNumber(capabilities.pipelineSafeContextTokens) ??
    readPositiveNumber(capabilities.pipeline_safe_context_tokens) ??
    readPositiveNumber(capabilities.safeContextTokens) ??
    readPositiveNumber(capabilities.safe_context_tokens)
  );
}

function deriveHistoryContextPolicy({ prompt, maxTokens, resolvedModel, config }) {
  if (config?.maxHistoryCharsOverride) {
    return {
      source: 'bridge_override',
      maxHistoryChars: config.maxHistoryCharsOverride,
      hostContextTokens: getModelContextLimitTokens(resolvedModel),
      minimumContextTokens: getModelMinimumContextTokens(resolvedModel)
    };
  }
  const hostContextTokens = getModelContextLimitTokens(resolvedModel);
  const minimumContextTokens = getModelMinimumContextTokens(resolvedModel);
  if (!hostContextTokens) {
    return {
      source: 'unbounded',
      maxHistoryChars: undefined,
      hostContextTokens: undefined,
      minimumContextTokens
    };
  }
  const requestedOutputReserveTokens = Math.max(
    readPositiveInteger(maxTokens) ?? 0,
    config?.contextOutputReserveTokens ?? DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS
  );
  const outputReserveTokens = Math.max(
    256,
    Math.min(requestedOutputReserveTokens, Math.floor(hostContextTokens * 0.4))
  );
  const promptTokens = estimateTokens(prompt);
  const inputBudgetTokens = Math.max(
    1,
    Math.floor((hostContextTokens - outputReserveTokens - promptTokens) * (config?.contextInputBudgetFraction ?? DEFAULT_CONTEXT_INPUT_BUDGET_FRACTION))
  );
  const maxHistoryChars = Math.max(
    DEFAULT_CONTEXT_MIN_HISTORY_CHARS,
    Math.floor(inputBudgetTokens * (config?.contextCharsPerToken ?? DEFAULT_CONTEXT_CHARS_PER_TOKEN))
  );
  return {
    source: 'host_capability',
    maxHistoryChars,
    hostContextTokens,
    minimumContextTokens,
    promptTokens,
    outputReserveTokens,
    inputBudgetTokens
  };
}

function limitHistoryItemsForModelContext(historyItems, maxHistoryChars) {
  const items = Array.isArray(historyItems) ? historyItems.filter(item => item?.text) : [];
  if (!Number.isFinite(maxHistoryChars) || maxHistoryChars <= 0) {
    return items;
  }
  let total = 0;
  const retained = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const itemLength = item.text.length + 2;
    if (retained.length > 0 && total + itemLength > maxHistoryChars) {
      break;
    }
    retained.unshift(item);
    total += itemLength;
  }
  if (retained.length === items.length) {
    return retained;
  }
  const omitted = items.length - retained.length;
  return [
    createHistoryItem(
      'system',
      `[${omitted} older conversation message${omitted === 1 ? '' : 's'} omitted by SpiLLI API bridge to fit local model context.]`
    ),
    ...retained
  ];
}

function isClaudeCodeWastedReadText(text) {
  return /Wasted call\s*[—-]\s*file unchanged since your last Read\.\s*Refer to that earlier tool_result instead\./i.test(
    asString(text)
  );
}

function isToolResultHistoryItem(item) {
  return /^Tool result for\s+\S+:/i.test(asString(item?.content).trim());
}

function selectRawDependencyItemsForCompaction(omittedItems, retainedItems, config = {}) {
  const retainedText = Array.isArray(retainedItems) ? retainedItems.map(item => item?.text || '').join('\n\n') : '';
  if (!isClaudeCodeWastedReadText(retainedText)) {
    return [];
  }
  const maxDependencyChars = Number.isFinite(config.contextDependencyRawChars)
    ? config.contextDependencyRawChars
    : DEFAULT_CONTEXT_DEPENDENCY_RAW_CHARS;
  for (let index = omittedItems.length - 1; index >= 0; index -= 1) {
    const item = omittedItems[index];
    if (!isToolResultHistoryItem(item)) {
      continue;
    }
    if (item.content.length > maxDependencyChars) {
      return [];
    }
    return [
      createHistoryItem(
        item.role,
        [
          '[raw earlier tool_result retained by SpiLLI API bridge because a later Claude Code Read result references it]',
          item.content
        ].join('\n')
      )
    ];
  }
  return [];
}

async function compactHistoryItemsForModelContext(historyItems, policy, { requestedModel, config } = {}) {
  const items = Array.isArray(historyItems) ? historyItems.filter(item => item?.text) : [];
  const maxHistoryChars = policy?.maxHistoryChars;
  if (!Number.isFinite(maxHistoryChars) || maxHistoryChars <= 0) {
    return { items, compacted: false, omitted: 0, summaryChars: 0 };
  }

  let total = 0;
  const retained = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const itemLength = item.text.length + 2;
    if (retained.length > 0 && total + itemLength > maxHistoryChars) {
      break;
    }
    if (retained.length === 0 && itemLength > maxHistoryChars) {
      retained.unshift(createHistoryItem(item.role, clipForModelContext(item.content, maxHistoryChars, 'latest history item')));
      total = retained[0].text.length + 2;
      break;
    }
    retained.unshift(item);
    total += itemLength;
  }
  if (retained.length === items.length) {
    return { items: retained, compacted: false, omitted: 0, summaryChars: 0 };
  }

  const omittedItems = items.slice(0, items.length - retained.length);
  const dependencyItems = selectRawDependencyItemsForCompaction(omittedItems, retained, config);
  const dependencyHashes = new Set(dependencyItems.map(item => item.hash));
  const omittedForSummary = dependencyItems.length
    ? omittedItems.filter(item => !dependencyHashes.has(createHistoryItem(item.role, [
        '[raw earlier tool_result retained by SpiLLI API bridge because a later Claude Code Read result references it]',
        item.content
      ].join('\n')).hash))
    : omittedItems;
  const omittedText = omittedForSummary.map(item => item.text).join('\n\n');
  const summaryTarget = Math.max(
    800,
    Math.min(
      config?.toolResultSummaryTargetChars ?? DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS,
      Math.floor(maxHistoryChars * 0.25)
    )
  );
  let summaryText = '';
  let summaryMode = 'deterministic';
  if (omittedText && config?.toolResultSummarizerEnabled && requestedModel && omittedText.length > summaryTarget * 2) {
    try {
      summaryText = await summarizeTextWithSpilliSdk({
        text: omittedText,
        model: requestedModel,
        config,
        instruction: [
          'This is older chat history being compacted because SpiLLIHost reported a smaller safe KV context.',
          'Preserve user requests, assistant commitments, tool results, file paths, errors, and unresolved tasks.',
          'Do not add new instructions or behavior policy.'
        ].join(' '),
        targetChars: summaryTarget,
        source: 'conversation_history'
      });
      summaryMode = 'spilli-sdk';
    } catch (error) {
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'history.compaction.summarize.error',
        history: {
          requestedModel,
          omittedMessages: omittedItems.length,
          omittedChars: omittedText.length,
          targetChars: summaryTarget
        },
        error: errorSummary(error)
      }, 'SUMMARY');
    }
  }
  if (!summaryText.trim() && omittedText) {
    summaryText = clipForModelContext(omittedText, summaryTarget, 'older conversation history');
  }
  const summaryItems = summaryText.trim()
    ? [
        createHistoryItem(
          'system',
          [
            `[summarized earlier conversation by SpiLLI API bridge: mode=${summaryMode}; original_messages=${omittedItems.length}; summarized_messages=${omittedForSummary.length}; raw_dependency_messages=${dependencyItems.length}; original_chars=${omittedItems.map(item => item.text).join('\n\n').length}; summarized_chars=${omittedText.length}; host_context_tokens=${policy?.hostContextTokens ?? 'unknown'}]`,
            summaryText.trim()
          ].join('\n')
        )
      ]
    : [];
  return {
    items: [...summaryItems, ...dependencyItems, ...retained],
    compacted: true,
    omitted: omittedItems.length,
    summaryChars: summaryText.trim().length,
    summaryMode,
    rawDependencyCount: dependencyItems.length
  };
}

function createHistoryState({ requestedModel, prompt, historyItems, allowDelta = true, maxTokens }) {
  const items = Array.isArray(historyItems) ? historyItems.filter(item => item?.text) : [];
  return {
    requestedModel: asString(requestedModel).trim(),
    prompt: asString(prompt),
    promptHash: hashHistoryValue(asString(prompt)),
    historyItems: items,
    historyHashes: items.map(item => item.hash),
    allowDelta,
    maxTokens: readPositiveInteger(maxTokens),
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

function buildHistoryStateForAnthropic(body, options = {}) {
  const promptParts = buildAnthropicPromptParts(body, {
    renderToolSchemas: options.renderToolSchemas,
    toolSchemaPromptMaxChars: options.toolSchemaPromptMaxChars
  });
  const prompt = promptParts.prompt;
  const contentOptions = {
    compactToolResults: options.compactToolResults,
    maxToolResultChars: options.maxToolResultChars,
    toolResultRawChars: options.toolResultRawChars,
    toolResultCompactChars: options.toolResultCompactChars,
    toolResultCompactTargetChars: options.toolResultCompactTargetChars,
    toolResultSummaryTargetChars: options.toolResultSummaryTargetChars,
    toolResultSummarizerEndpoint: options.toolResultSummarizerEndpoint
  };
  const historyItems = Array.isArray(body.messages)
    ? body.messages
        .map(message => {
          if (!isRecord(message)) {
            return undefined;
          }
          return createHistoryItem(asString(message.role) || 'user', normalizeContent(message.content, contentOptions));
        })
        .filter(Boolean)
    : [];
  const historyState = createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems: limitHistoryItemsForModelContext(historyItems, options.maxHistoryChars),
    maxTokens: maxTokensFromAnthropicBody(body)
  });
  historyState.promptFootprint = buildPromptFootprint(promptParts, historyState.query, {
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    toolSchemaPromptMaxChars: options.toolSchemaPromptMaxChars
  });
  return historyState;
}

async function buildHistoryStateForAnthropicWithContextPolicy(body, config, resolvedModel) {
  const promptParts = buildAnthropicPromptParts(body, config);
  const prompt = promptParts.prompt;
  const contentOptions = {
    compactToolResults: config.compactToolResults,
    maxToolResultChars: config.maxToolResultChars,
    toolResultRawChars: config.toolResultRawChars,
    toolResultCompactChars: config.toolResultCompactChars,
    toolResultCompactTargetChars: config.toolResultCompactTargetChars,
    toolResultSummaryTargetChars: config.toolResultSummaryTargetChars,
    toolResultSummarizerEndpoint: config.toolResultSummarizerEndpoint
  };
  const historyItems = Array.isArray(body.messages)
    ? body.messages
        .map(message => {
          if (!isRecord(message)) {
            return undefined;
          }
          return createHistoryItem(asString(message.role) || 'user', normalizeContent(message.content, contentOptions));
        })
        .filter(Boolean)
    : [];
  const maxTokens = maxTokensFromAnthropicBody(body);
  const contextPolicy = deriveHistoryContextPolicy({ prompt, maxTokens, resolvedModel, config });
  const compacted = await compactHistoryItemsForModelContext(historyItems, contextPolicy, {
    requestedModel: body.model,
    config
  });
  const historyState = createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems: compacted.items,
    maxTokens
  });
  historyState.contextPolicy = contextPolicy;
  historyState.contextCompaction = {
    compacted: compacted.compacted,
    omitted: compacted.omitted,
    summaryChars: compacted.summaryChars,
    summaryMode: compacted.summaryMode,
    rawDependencyCount: compacted.rawDependencyCount ?? 0
  };
  historyState.promptFootprint = buildPromptFootprint(promptParts, historyState.query, {
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    toolSchemaPromptMaxChars: config.toolSchemaPromptMaxChars
  });
  return historyState;
}

function historyStateToSpilliPayload(historyState) {
  return {
    requestedModel: historyState.requestedModel,
    prompt: historyState.prompt,
    query: historyState.query,
    ...(historyState.maxTokens ? { max_tokens: historyState.maxTokens } : {})
  };
}

function anthropicToSpilliPayload(body) {
  return historyStateToSpilliPayload(buildHistoryStateForAnthropic(body, getConfig()));
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(asString(text).length / 4));
}

function openAiToSpilliPayload(body) {
  const historyState = buildHistoryStateForOpenAiChat(body);
  return {
    requestedModel: historyState.requestedModel,
    prompt: historyState.prompt,
    query: historyState.query,
    ...(historyState.maxTokens ? { max_tokens: historyState.maxTokens } : {})
  };
}

function buildHistoryStateForOpenAiChat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = messages
    .filter(message => isRecord(message) && message.role === 'system')
    .map(message => normalizeContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const historyItems = messages
    .filter(message => isRecord(message) && message.role !== 'system')
    .map(message => createHistoryItem(asString(message.role || 'user'), normalizeOpenAiChatMessageContent(message)));
  return createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems,
    maxTokens: maxTokensFromOpenAiChatBody(body)
  });
}

function stripEogMarkers(value) {
  return String(value ?? '').replace(/\[EOG\]/g, '');
}

function extractSpilliError(raw) {
  const match = String(raw ?? '').match(/\|<error>\|([\s\S]*?)\|<\/error>\|/);
  return match ? match[1].trim() : '';
}

function isSpilliContextMiss(raw) {
  return extractSpilliError(raw) === 'SPILLI_CONTEXT_MISS';
}

function throwIfSpilliError(raw) {
  const error = extractSpilliError(raw);
  if (!error) {
    return;
  }
  throw Object.assign(new Error(error), {
    statusCode: error === 'SPILLI_CONTEXT_MISS' ? 409 : 500,
    spilliError: error
  });
}

function isDegenerateSpilliOutput(raw) {
  const text = stripHarmonyControlTokens(raw).trim();
  if (!text) {
    return false;
  }
  const questionRuns = text.match(/\?{8,}/g) ?? [];
  const questionCount = questionRuns.reduce((sum, run) => sum + run.length, 0);
  if (questionCount >= 16 && questionCount / Math.max(1, text.length) > 0.45) {
    return true;
  }
  return /^[\p{L}\p{N}_.,;:'"()\-\s]{0,40}\?{16,}$/u.test(text);
}

function throwIfDegenerateSpilliOutput(raw) {
  if (!isDegenerateSpilliOutput(raw)) {
    return;
  }
  throw Object.assign(new Error('SPILLI_DEGENERATE_OUTPUT'), {
    statusCode: 500,
    spilliError: 'SPILLI_DEGENERATE_OUTPUT'
  });
}

function isSpilliContextStateError(error) {
  const message = [
    error?.spilliError,
    error instanceof Error ? error.message : String(error ?? ''),
    isRecord(error?.context) ? JSON.stringify(error.context) : ''
  ].filter(Boolean).join('\n').toLowerCase();
  return [
    'root fragment prompt decode failed',
    'pipeline fragment failed to mirror upstream kv-cache shift',
    'failed to mirror upstream kv-cache shift',
    'kv-cache shift',
    'spilli_degenerate_output',
    'sequence positions remain consecutive',
    'llama_decode: failed to decode',
    'decode: failed to initialize batch'
  ].some(marker => message.includes(marker));
}

function sessionFailureReasonForError(error, fallback = 'bridge_request_failure') {
  return isSpilliContextStateError(error)
    ? 'bridge_context_state_failure'
    : fallback;
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

function resourceCacheKey(resource) {
  const graph = resource.graph_v2 ?? {};
  return [
    resource.model,
    resource.scope ?? '',
    resource.team ?? '',
    resource.allocation_protocol ?? '',
    graph.compatibility_id ?? '',
    graph.total_layers ?? '',
    graph.vertex_type ?? ''
  ].join('|');
}

function buildResource(resolvedModel, config) {
  const resource = { model: resolvedModel.uid, scope: config.scope };
  if (config.team) {
    resource.team = config.team;
  }
  const allocationMetadata = isRecord(resolvedModel.allocationMetadata)
    ? resolvedModel.allocationMetadata
    : isRecord(resolvedModel.allocation_metadata)
      ? resolvedModel.allocation_metadata
      : {};
  const graphV2 = isRecord(allocationMetadata.graphV2)
    ? allocationMetadata.graphV2
    : isRecord(allocationMetadata.graph_v2)
      ? allocationMetadata.graph_v2
      : {};
  const allocationProtocol = Number(allocationMetadata.allocationProtocol ?? allocationMetadata.allocation_protocol ?? 0) || undefined;
  if (allocationProtocol === 2 || Object.keys(graphV2).length > 0) {
    resource.allocation_protocol = 2;
    resource.graph_v2 = {
      compatibility_id: asString(graphV2.compatibilityId || graphV2.compatibility_id || resolvedModel.uid).trim(),
      total_layers: Number(graphV2.totalLayers ?? graphV2.total_layers ?? 0) || 0
    };
    const vertexType = asString(graphV2.vertexType || graphV2.vertex_type).trim();
    if (vertexType) {
      resource.graph_v2.vertex_type = vertexType;
    }
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

function historyItemsToContextMessages(historyItems) {
  return (Array.isArray(historyItems) ? historyItems : [])
    .map(item => ({
      role: asString(item?.role || 'user').trim().toLowerCase() || 'user',
      content: asString(item?.content)
    }))
    .filter(item => item.content);
}

function createRunPayloadFromHistory(historyState, historyItems, includePrompt) {
  return {
    requestedModel: historyState.requestedModel,
    prompt: includePrompt ? historyState.prompt : '',
    query: historyItems.map(item => item.text).join('\n\n'),
    ...(historyState.maxTokens ? { max_tokens: historyState.maxTokens } : {})
  };
}

function prepareSessionRunPayload(historyState, previousEntry, resourceKey) {
  const previousHashes = previousEntry?.historyHashes ?? [];
  const canReuse =
    previousEntry?.initialized === true &&
    previousEntry?.session?.isLive?.() &&
    previousEntry.promptHash === historyState.promptHash &&
    previousEntry.resourceKey === resourceKey &&
    historyState.allowDelta &&
    historyHashesHavePrefix(historyState.historyHashes, previousHashes);
  const historyItems = canReuse
    ? historyState.historyItems.slice(previousHashes.length)
    : historyState.historyItems;
  return {
    reused: Boolean(canReuse),
    reason: canReuse ? 'append' : previousEntry?.session?.isLive?.() ? 'replace' : 'new',
    transferMode: canReuse ? 'delta' : 'hydrate',
    historyItems,
    payload: createRunPayloadFromHistory(historyState, historyItems, !canReuse)
  };
}

function assistantHistoryItemForAnthropic(message) {
  return createHistoryItem('assistant', normalizeContent(message?.content));
}

function assistantHistoryItemForOpenAiChat(message) {
  return createHistoryItem('assistant', normalizeOpenAiChatMessageContent(message));
}

function assistantHistoryItemsForResponses(output) {
  return Array.isArray(output)
    ? output
        .map(item => {
          const text = responsesInputItemToText(item);
          return text ? { text, hash: hashHistoryValue(text) } : undefined;
        })
        .filter(Boolean)
    : [];
}

async function withResourceKeyRunQueue(key, callback) {
  const previous = state.resourceRunQueues.get(key) ?? Promise.resolve();
  let release;
  const current = previous.catch(() => undefined).then(() => callback());
  release = current.catch(() => undefined).finally(() => {
    if (state.resourceRunQueues.get(key) === release) {
      state.resourceRunQueues.delete(key);
    }
  });
  state.resourceRunQueues.set(key, release);
  return current;
}

async function withResourceRunQueue(resource, callback) {
  return withResourceKeyRunQueue(resourceCacheKey(resource), callback);
}

async function requestSpilliSessionForResource(service, resource, timeoutMs) {
  const key = resourceCacheKey(resource);
  await appendLog({
    timestamp: new Date().toISOString(),
    kind: 'spilli.allocation.queued',
    allocation: { resourceKey: key }
  }, 'ALLOC');
  return withResourceRunQueue(resource, async () => {
    const existing = state.resourceSessions.get(key);
    if (existing?.isLive?.()) {
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.allocation.reuse',
        allocation: { resourceKey: key, sessionLive: true }
      }, 'ALLOC');
      return existing;
    }
    if (existing) {
      state.resourceSessions.delete(key);
    }
    await appendLog({
      timestamp: new Date().toISOString(),
      kind: 'spilli.allocation.start',
      allocation: { resourceKey: key }
    }, 'ALLOC');
    try {
      const session = await service.request(resource, timeoutMs);
      if (session?.isLive?.()) {
        state.resourceSessions.set(key, session);
      }
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.allocation.complete',
        allocation: { resourceKey: key, sessionLive: session?.isLive?.() === true }
      }, 'ALLOC');
      return session;
    } catch (error) {
      state.resourceSessions.delete(key);
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.allocation.error',
        allocation: { resourceKey: key },
        error: errorSummary(error)
      }, 'ALLOC');
      throw error;
    }
  });
}

// Run inference using an already created SpiLLI session.
async function runInference(payload, config, streamOptions = {}, session, resolvedModelOverride) {
  const { requestedModel, prompt, query } = payload;
  const resolvedModel = resolvedModelOverride ?? await resolveRequestedModel(requestedModel, config);
  const resource = buildResource(resolvedModel, config);
  const resourceKey = resourceCacheKey(resource);
  const apiModelName = requestedModel || resolvedModel.displayName;
  return withResourceRunQueue(resource, async () => {
    const activeSession = session?.isLive?.() ? session : undefined;
    if (!activeSession?.isLive?.()) {
      throw Object.assign(new Error('SpiLLI model session is not live.'), { statusCode: 503 });
    }
    streamOptions.onStart?.({ requestedModel: apiModelName, resolvedModel });
    const runOptions = { timeoutMs: config.runTimeoutMs };
    const streamForwarder =
      typeof streamOptions.onChunk === 'function' ? createStreamChunkForwarder(streamOptions.onChunk) : undefined;
    if (streamForwarder) {
      runOptions.onChunk = chunk => streamForwarder.onChunk(chunk);
    }
  const runPayload = {
    prompt,
    query,
    ...(readPositiveInteger(payload.max_tokens) ? { max_tokens: readPositiveInteger(payload.max_tokens) } : {}),
    ...(payload.spilliContext ? { spilli_context: payload.spilliContext } : {}),
    ...(payload.hydrateContext ? { hydrate_context: payload.hydrateContext } : {})
  };
    await appendLog({
      timestamp: new Date().toISOString(),
      kind: 'spilli.run.start',
      run: {
        requestedModel: apiModelName,
        resolvedUid: resolvedModel.uid,
        resourceKey,
        timeoutMs: config.runTimeoutMs,
        maxTokens: runPayload.max_tokens ?? null,
        promptLength: asString(prompt).length,
        queryLength: asString(query).length,
        spilliContext: summarizeContextPayload(payload.spilliContext),
        hydrateContext: summarizeContextPayload(payload.hydrateContext)
      }
    }, 'RUN');
    try {
      const raw = stripEogMarkers(await activeSession.run(runPayload, runOptions));
      streamForwarder?.flush();
      throwIfSpilliError(raw);
      throwIfDegenerateSpilliOutput(raw);
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.run.complete',
        run: {
          requestedModel: apiModelName,
          resolvedUid: resolvedModel.uid,
          resourceKey,
          rawLength: raw.length,
          rawPreview: raw.slice(0, 2000),
          spilliContext: summarizeContextPayload(payload.spilliContext)
        }
      }, 'RUN');
      return {
        raw,
        requestedModel: apiModelName,
        resolvedModel,
        session: activeSession
      };
    } catch (error) {
      await appendLog({
        timestamp: new Date().toISOString(),
        kind: 'spilli.run.error',
        run: {
          requestedModel: apiModelName,
          resolvedUid: resolvedModel.uid,
          resourceKey,
          spilliContext: summarizeContextPayload(payload.spilliContext)
        },
        error: errorSummary(error)
      }, 'RUN');
      throw error;
    }
  });
}

function buildSpilliContextReleaseControl(entry, reason = 'bridge_context_release') {
  return {
    version: 1,
    action: 'release',
    context_id: entry?.identity?.contextId ?? '',
    resource_key: entry?.resourceKey ?? '',
    window_id: entry?.identity?.windowId ?? '',
    session_id: entry?.identity?.sessionId ?? '',
    context_revision: entry?.revision ?? 1,
    reason,
    lease_kind: entry?.leaseKind === 'ephemeral' ? 'ephemeral' : 'durable',
    client_kind: entry?.clientKind ?? 'unknown'
  };
}

function isSameChatSessionEntry(current, entry) {
  return (
    current &&
    entry &&
    current.resourceKey === entry.resourceKey &&
    current.revision === entry.revision &&
    current.identity?.contextId === entry.identity?.contextId
  );
}

async function releaseChatSessionEntry(sessionKey, entry, config, reason = 'bridge_context_release') {
  if (!sessionKey || !entry) {
    return false;
  }
  const control = buildSpilliContextReleaseControl(entry, reason);
  const releaseId = crypto.randomUUID();
  const currentBeforeRelease = state.chatSessions.get(sessionKey);
  if (isSameChatSessionEntry(currentBeforeRelease, entry)) {
    state.chatSessions.set(sessionKey, {
      ...currentBeforeRelease,
      inFlight: true,
      releasing: true,
      releaseId,
      releaseReason: reason,
      lastUsedAt: Date.now()
    });
  }
  await appendLog({
    timestamp: new Date().toISOString(),
    kind: 'spilli.context.release.start',
    session: {
      key: sessionKey,
      leaseKind: entry.leaseKind ?? 'durable',
      clientKind: entry.clientKind ?? 'unknown',
      resourceKey: entry.resourceKey ?? '',
      contextId: entry.identity?.contextId ?? '',
      revision: entry.revision ?? 0,
      releaseId,
      reason
    }
  }, 'SESSION');
  try {
    await withResourceKeyRunQueue(entry.resourceKey ?? '', async () => {
      if (entry.session?.isLive?.()) {
        if (typeof entry.session.releaseContext === 'function') {
          await entry.session.releaseContext(control, { timeoutMs: config.allocationTimeoutMs });
        } else {
          await entry.session.run({
            prompt: '',
            query: '',
            spilli_context_control: control
          }, { timeoutMs: config.allocationTimeoutMs });
        }
      }
    });
    const current = state.chatSessions.get(sessionKey);
    if (current?.releaseId === releaseId && isSameChatSessionEntry(current, entry)) {
      state.chatSessions.delete(sessionKey);
    }
    await appendLog({
      timestamp: new Date().toISOString(),
      kind: 'spilli.context.release.complete',
      session: {
        key: sessionKey,
        leaseKind: entry.leaseKind ?? 'durable',
        clientKind: entry.clientKind ?? 'unknown',
        resourceKey: entry.resourceKey ?? '',
        contextId: entry.identity?.contextId ?? '',
        revision: entry.revision ?? 0,
        releaseId,
        reason
      }
    }, 'SESSION');
    return true;
  } catch (error) {
    const current = state.chatSessions.get(sessionKey);
    if (current?.releaseId === releaseId && isSameChatSessionEntry(current, entry)) {
      state.chatSessions.set(sessionKey, {
        ...current,
        inFlight: false,
        releasing: false,
        releaseId: undefined,
        lastUsedAt: Date.now()
      });
    }
    await appendLog({
      timestamp: new Date().toISOString(),
      kind: 'spilli.context.release.error',
      session: {
        key: sessionKey,
        leaseKind: entry.leaseKind ?? 'durable',
        clientKind: entry.clientKind ?? 'unknown',
        resourceKey: entry.resourceKey ?? '',
        contextId: entry.identity?.contextId ?? '',
        revision: entry.revision ?? 0,
        releaseId,
        reason
      },
      error: errorSummary(error)
    }, 'SESSION');
    return false;
  }
}

async function evictIdleDurableContextsForResource(resourceKey, currentSessionKey, config, reason = 'bridge_lru_eviction') {
  const maxDurable = Math.max(0, Number(config.maxDurableContextsPerResource ?? DEFAULT_MAX_DURABLE_CONTEXTS_PER_RESOURCE));
  if (maxDurable <= 0) {
    return 0;
  }
  const candidates = Array.from(state.chatSessions.entries())
    .filter(([key, entry]) => (
      key !== currentSessionKey &&
      entry?.resourceKey === resourceKey &&
      entry?.leaseKind !== 'ephemeral' &&
      entry?.inFlight !== true
    ))
    .sort(([, a], [, b]) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
  let durableCount = candidates.length;
  let evicted = 0;
  while (durableCount >= maxDurable && candidates.length > 0) {
    const [key, entry] = candidates.shift();
    if (await releaseChatSessionEntry(key, entry, config, reason)) {
      evicted += 1;
      durableCount -= 1;
    } else {
      break;
    }
  }
  return evicted;
}

function markChatSessionIdle(sessionKey, chosenSession) {
  if (!sessionKey) {
    return;
  }
  const current = state.chatSessions.get(sessionKey);
  if (current?.session !== chosenSession) {
    return;
  }
  state.chatSessions.set(sessionKey, {
    ...current,
    inFlight: false,
    lastUsedAt: Date.now()
  });
}

async function getOrCreateClientSession(req, historyState, config, body = {}) {
  const discoveredIdentity = getSpilliSessionIdentity(req);
  const baseIdentity = discoveredIdentity ?? {
    key: `ephemeral:${crypto.randomUUID()}`,
    windowId: 'api-bridge',
    sessionId: crypto.randomUUID(),
    contextId: crypto.randomUUID()
  };
  const identity = discoveredIdentity
    ? specializeSessionIdentityForHistory(baseIdentity, historyState)
    : baseIdentity;
  const sessionKey = identity.key;
  const service = getService(config);
  const resolvedModel = await resolveRequestedModel(historyState.requestedModel, config);
  const resource = buildResource(resolvedModel, config);
  const resourceKey = resourceCacheKey(resource);
  const previousEntry = sessionKey ? state.chatSessions.get(sessionKey) : undefined;
  const reusablePreviousEntry =
    previousEntry?.releasing === true || previousEntry?.inFlight === true
      ? undefined
      : previousEntry;
  const prepared = prepareSessionRunPayload(historyState, reusablePreviousEntry, resourceKey);
  const leaseKind = getLeaseKindForRequest(req, body);
  const clientKind = getClientKind(req);
  const nextRevision = (previousEntry?.revision ?? 0) + 1;
  const transferMode = prepared.transferMode;
  const contextMessages = historyItemsToContextMessages(prepared.historyItems);
  const spilliContext = {
    version: 1,
    window_id: identity.windowId,
    session_id: identity.sessionId,
    context_id: identity.contextId,
    context_revision: nextRevision,
    transfer_mode: transferMode,
    resource_key: resourceKey,
    lease_kind: leaseKind,
    client_kind: clientKind,
    ...(historyState.contextPolicy?.hostContextTokens
      ? { context_budget_tokens: historyState.contextPolicy.hostContextTokens }
      : {}),
    dynamic_context_policy: historyState.contextPolicy ?? undefined,
    allow_cross_job_context_reuse: true,
    recent_messages: transferMode === 'hydrate' ? contextMessages : [],
    delta_messages: transferMode === 'delta' ? contextMessages : []
  };
  const retryHydrateContextMessages = historyItemsToContextMessages(historyState.historyItems);
  const retryHydrateContext = {
    ...spilliContext,
    transfer_mode: 'hydrate',
    recent_messages: retryHydrateContextMessages,
    delta_messages: []
  };
  const retryHydrateRunPayload = createRunPayloadFromHistory(
    historyState,
    historyState.historyItems,
    true
  );
  const payload = {
    ...prepared.payload,
    spilliContext,
    hydrateContext: transferMode === 'hydrate' ? spilliContext : undefined,
    retryHydratePayload: {
      ...retryHydrateRunPayload,
      spilliContext: retryHydrateContext,
      hydrateContext: retryHydrateContext
    }
  };

  if (discoveredIdentity &&
      previousEntry &&
      !prepared.reused &&
      previousEntry.releasing !== true &&
      previousEntry.inFlight !== true) {
    await releaseChatSessionEntry(sessionKey, previousEntry, config, 'bridge_context_replaced');
  }

  if (discoveredIdentity && !prepared.reused && leaseKind === 'durable') {
    await evictIdleDurableContextsForResource(resourceKey, sessionKey, config, 'bridge_durable_lru_limit');
  }

  const chosenSession = prepared.reused
    ? reusablePreviousEntry.session
    : await requestSpilliSessionForResource(service, resource, config.allocationTimeoutMs);
  if (discoveredIdentity) {
    state.chatSessions.set(sessionKey, {
      session: chosenSession,
      identity,
      promptHash: historyState.promptHash ?? previousEntry?.promptHash ?? '',
      historyHashes: reusablePreviousEntry?.historyHashes ?? [],
      resourceKey,
      revision: nextRevision,
      initialized: prepared.reused && reusablePreviousEntry?.initialized === true,
      leaseKind,
      clientKind,
      lastUsedAt: Date.now(),
      inFlight: true
    });
  }

  const commitHistory = (assistantItems = []) => {
    if (!sessionKey) {
      return;
    }
    const current = state.chatSessions.get(sessionKey);
    if (current?.session !== chosenSession ||
        current?.revision !== nextRevision ||
        current?.identity?.contextId !== identity.contextId) {
      return;
    }
    state.chatSessions.set(sessionKey, {
      ...current,
      initialized: true,
      promptHash: historyState.promptHash ?? current.promptHash ?? '',
      inFlight: false,
      lastUsedAt: Date.now(),
      historyHashes: [
        ...historyState.historyHashes,
        ...assistantItems.map(item => item.hash).filter(Boolean)
      ]
    });
  };

  const finishSession = async (reasonSuffix = 'request_complete') => {
    const current = state.chatSessions.get(sessionKey);
    if (!current?.session || current.session !== chosenSession) {
      return;
    }
    const contextStateFailed = String(reasonSuffix).toLowerCase().includes('context_state_failure');
    if (contextStateFailed ||
        (current.leaseKind === 'ephemeral' && config.releaseEphemeralContexts)) {
      const released = await releaseChatSessionEntry(sessionKey, current, config, reasonSuffix);
      if (!released) {
        const afterRelease = state.chatSessions.get(sessionKey);
        if (isSameChatSessionEntry(afterRelease, current)) {
          state.chatSessions.delete(sessionKey);
        }
      }
      return;
    }
    const failed = String(reasonSuffix).toLowerCase().includes('failure');
    if (failed &&
        current.revision === nextRevision &&
        current.identity?.contextId === identity.contextId) {
      if (previousEntry?.session === chosenSession &&
          previousEntry?.identity?.contextId === identity.contextId) {
        state.chatSessions.set(sessionKey, {
          ...previousEntry,
          inFlight: false,
          lastUsedAt: Date.now()
        });
      } else {
        state.chatSessions.delete(sessionKey);
      }
      return;
    }
    markChatSessionIdle(sessionKey, chosenSession);
  };

  return {
    sessionKey,
    chosenSession,
    resolvedModel,
    payload,
    transferMode,
    reusedTransport: prepared.reused,
    revision: nextRevision,
    reason: prepared.reason,
    previousEntry,
    historyState,
    leaseKind,
    clientKind,
    commitHistory,
    finishSession
  };
}

function summarizeSessionEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    initialized: entry.initialized === true,
    revision: entry.revision ?? 0,
    resourceKey: entry.resourceKey ?? '',
    leaseKind: entry.leaseKind ?? 'durable',
    clientKind: entry.clientKind ?? 'unknown',
    inFlight: entry.inFlight === true,
    releasing: entry.releasing === true,
    releaseReason: entry.releaseReason ?? '',
    lastUsedAt: entry.lastUsedAt ?? null,
    promptHash: entry.promptHash ?? '',
    historyHashCount: Array.isArray(entry.historyHashes) ? entry.historyHashes.length : 0,
    lastHistoryHash: Array.isArray(entry.historyHashes) && entry.historyHashes.length
      ? entry.historyHashes[entry.historyHashes.length - 1]
      : null,
    sessionLive: entry.session?.isLive?.() === true,
    identity: entry.identity ?? null
  };
}

function summarizeHistoryState(historyState) {
  return {
    requestedModel: historyState?.requestedModel ?? '',
    promptLength: asString(historyState?.prompt).length,
    promptHash: historyState?.promptHash ?? '',
    historyItemCount: Array.isArray(historyState?.historyItems) ? historyState.historyItems.length : 0,
    historyHashCount: Array.isArray(historyState?.historyHashes) ? historyState.historyHashes.length : 0,
    allowDelta: historyState?.allowDelta === true,
    queryLength: asString(historyState?.query).length,
    contextPolicy: historyState?.contextPolicy ?? null,
    contextCompaction: historyState?.contextCompaction ?? null,
    promptFootprint: historyState?.promptFootprint ?? null,
    firstHistoryHash: Array.isArray(historyState?.historyHashes) && historyState.historyHashes.length
      ? historyState.historyHashes[0]
      : null,
    lastHistoryHash: Array.isArray(historyState?.historyHashes) && historyState.historyHashes.length
      ? historyState.historyHashes[historyState.historyHashes.length - 1]
      : null
  };
}

function summarizeContextPayload(context) {
  if (!context) {
    return null;
  }
  return {
    version: context.version ?? null,
    windowId: context.window_id ?? context.windowId ?? '',
    sessionId: context.session_id ?? context.sessionId ?? '',
    contextId: context.context_id ?? context.contextId ?? '',
    contextRevision: context.context_revision ?? context.contextRevision ?? null,
    transferMode: context.transfer_mode ?? context.transferMode ?? '',
    resourceKey: context.resource_key ?? context.resourceKey ?? '',
    leaseKind: context.lease_kind ?? context.leaseKind ?? '',
    clientKind: context.client_kind ?? context.clientKind ?? '',
    recentMessageCount: Array.isArray(context.recent_messages)
      ? context.recent_messages.length
      : Array.isArray(context.recentMessages) ? context.recentMessages.length : 0,
    deltaMessageCount: Array.isArray(context.delta_messages)
      ? context.delta_messages.length
      : Array.isArray(context.deltaMessages) ? context.deltaMessages.length : 0
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
    session_key: getSpilliSessionKey(req) ?? null
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

function summarizeToolResultPart(part, depth = 0) {
  if (depth > 5) {
    return { type: 'max_depth' };
  }
  if (typeof part === 'string') {
    return {
      type: 'string',
      length: part.length,
      preview: part.slice(0, 1200)
    };
  }
  if (Array.isArray(part)) {
    return {
      type: 'array',
      length: part.length,
      items: part.slice(0, 8).map(item => summarizeToolResultPart(item, depth + 1))
    };
  }
  if (!isRecord(part)) {
    return {
      type: typeof part,
      value: part
    };
  }
  const summary = {
    type: asString(part.type) || 'object',
    keys: Object.keys(part).sort()
  };
  for (const key of ['tool_use_id', 'name', 'title', 'url', 'page_age', 'error_code']) {
    if (typeof part[key] === 'string') {
      summary[key] = part[key].slice(0, 1200);
    }
  }
  for (const key of ['text', 'cited_text', 'snippet']) {
    if (typeof part[key] === 'string') {
      summary[`${key}Preview`] = part[key].slice(0, 1200);
      summary[`${key}Length`] = part[key].length;
    }
  }
  if (Object.prototype.hasOwnProperty.call(part, 'content')) {
    summary.content = summarizeToolResultPart(part.content, depth + 1);
  }
  return summary;
}

function summarizeAnthropicToolResults(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const results = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      return;
    }
    message.content.forEach((part, partIndex) => {
      if (!isRecord(part) || part.type !== 'tool_result') {
        return;
      }
      results.push({
        messageIndex,
        partIndex,
        toolUseId: asString(part.tool_use_id) || null,
        isError: part.is_error === true,
        content: summarizeToolResultPart(part.content)
      });
    });
  });
  return results;
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
  const systemPrompt = summarizeSystemPromptForLog(body, payload?.prompt);
  const toolSchemas = summarizeToolSchemasForLog(body.tools);
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
        systemPrompt,
        toolNames: extractAvailableToolNames(body.tools),
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        toolSchemas,
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
  const systemPrompt = summarizeSystemPromptForLog(body, payload?.prompt);
  const toolSchemas = summarizeToolSchemasForLog(body.tools);
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
      systemPrompt,
      toolSchemas,
      // body: body
      // codexmeta: body.client_metadata["x-codex-turn-metadata"],
      turnmeta:req.headers["x-codex-turn-metadata"],
      subagent: req.headers["x-openai-subagent"],
      tool_result_summaries: summarizeAnthropicToolResults(body.messages),
      // metadata: body.client_metadata,
      // tools: Array.isArray(body.tools) ? body.tools : [],
      tool_names: extractAvailableToolNames(body.tools),
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

async function logSessionProtocolDecision(kind, req, protocol) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  await appendLog({
    timestamp: new Date().toISOString(),
    kind,
    method: req.method,
    path: url.pathname,
    protocol
  }, 'PROTOCOL');
}

async function logSessionState(kind, req, session) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  await appendLog({
    timestamp: new Date().toISOString(),
    kind,
    method: req.method,
    path: url.pathname,
    session
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

function toAnthropicMessage({ id, model, raw, toolsEnabled = false, allowedToolNames = [], config = {} }) {
  const toolCalls = toolsEnabled ? parseToolCallsFromOutput(raw, allowedToolNames) : [];
  const text = renderText(raw, toolCalls);
  const stopReason = extractSpilliStopReason(raw);
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
  if (shouldAskContinueAfterMaxTokens({ stopReason, toolCalls, allowedToolNames, config })) {
    content.push({
      type: 'tool_use',
      id: createBridgeToolUseId('toolu_spilli_continue'),
      name: resolveAllowedToolName('AskUserQuestion', allowedToolNames),
      input: buildContinueAfterMaxTokensQuestion()
    });
  }
  if (content.length === 0 && String(raw ?? '').trim()) {
    content.push({
      type: 'text',
      text: 'I could not convert the model output into a valid Claude Code response. Please retry this step.'
    });
  }
  const hasToolUse = content.some(block => block?.type === 'tool_use');
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : stopReason || 'end_turn',
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

function createAnthropicToolUseMessage({ id, model, name, input }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [
      {
        type: 'tool_use',
        id: `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name,
        input: input ?? {}
      }
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 1
    }
  };
}

function createAnthropicTextMessage({ id, model, text }) {
  const normalizedText = asString(text);
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: normalizedText ? [{ type: 'text', text: normalizedText }] : [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: Math.max(1, Math.ceil(normalizedText.length / 4))
    }
  };
}

function extractClaudeWebSearchHelperQuery(body) {
  const systemText = normalizeSystem(body?.system).toLowerCase();
  if (!systemText.includes('web search tool use')) {
    return '';
  }
  const allowedToolNames = extractAvailableToolNames(body?.tools);
  const hasOnlyWebSearch =
    allowedToolNames.length === 1 &&
    ['web_search', 'websearch'].includes(normalizeToolNameForLookup(allowedToolNames[0]));
  if (!hasOnlyWebSearch || !Array.isArray(body?.messages)) {
    return '';
  }
  const lastUserMessage = [...body.messages].reverse().find(message => isRecord(message) && message.role === 'user');
  const text = normalizeContent(lastUserMessage?.content).trim();
  const match = text.match(/perform\s+a\s+web\s+search\s+for\s+the\s+query\s*:\s*([\s\S]+)$/i);
  return asString(match?.[1]).trim();
}

function extractSearchResultsFromValue(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => extractSearchResultsFromValue(item));
  }
  if (typeof value === 'string') {
    return [];
  }
  if (!isRecord(value)) {
    return [];
  }
  const directTitle = asString(value.title || value.heading || value.name).trim();
  const directUrl = asString(value.url || value.link || value.href || value.firstURL || value.FirstURL).trim();
  const directSnippet = asString(
    value.snippet ||
      value.description ||
      value.body ||
      value.abstract ||
      value.Abstract ||
      value.text ||
      value.Text ||
      value.content
  ).trim();
  const direct = directTitle || directUrl || directSnippet
    ? [{ title: directTitle || directUrl || 'Search result', url: directUrl, snippet: directSnippet }]
    : [];
  const nestedKeys = [
    'results',
    'items',
    'organic_results',
    'organicResults',
    'webPages',
    'RelatedTopics',
    'relatedTopics',
    'topics'
  ];
  const nested = [];
  for (const key of nestedKeys) {
    const nestedValue = key === 'webPages' && isRecord(value.webPages) ? value.webPages.value : value[key];
    nested.push(...extractSearchResultsFromValue(nestedValue));
  }
  return [...direct, ...nested];
}

function dedupeSearchResults(results, maxResults) {
  const output = [];
  const seen = new Set();
  for (const result of results) {
    const title = asString(result.title).trim();
    const url = asString(result.url).trim();
    const snippet = asString(result.snippet).trim();
    if (!title && !url && !snippet) {
      continue;
    }
    const key = (url || `${title}\n${snippet}`).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({ title, url, snippet });
    if (output.length >= maxResults) {
      break;
    }
  }
  return output;
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseDuckDuckGoHtmlResults(html, maxResults) {
  const results = [];
  const regex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null && results.length < maxResults) {
    const href = decodeHtmlEntities(match[1]);
    let url = href;
    try {
      const parsed = new URL(href, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      url = uddg || parsed.href;
    } catch {
      url = href;
    }
    results.push({
      title: stripHtml(match[2]),
      url,
      snippet: stripHtml(match[3])
    });
  }
  return results;
}

function formatWebSearchResults(query, results, provider) {
  const safeQuery = asString(query).trim();
  const lines = [`Web search results for query: "${safeQuery}"`];
  if (!results.length) {
    lines.push('', `No web search results were returned by ${provider}.`);
    return lines.join('\n');
  }
  results.forEach((result, index) => {
    const title = result.title || result.url || `Result ${index + 1}`;
    const url = result.url ? ` (${result.url})` : '';
    lines.push('', `${index + 1}. ${title}${url}`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
  });
  lines.push('', 'Use the result titles and URLs above as markdown hyperlinks when citing sources.');
  return lines.join('\n');
}

async function searchWithExternalEndpoint(query, config) {
  if (!config.webSearchEndpoint) {
    return undefined;
  }
  const endpoint = config.webSearchEndpoint;
  const body = JSON.stringify({ query, max_results: config.webSearchMaxResults });
  const response = endpoint.includes('{query}')
    ? await fetchWithTimeout(endpoint.replaceAll('{query}', encodeURIComponent(query)), {
        method: 'GET',
        headers: { accept: 'application/json' }
      }, config.webSearchTimeoutMs)
    : await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body
      }, config.webSearchTimeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`external web search failed (${response.status}): ${text.slice(0, 500)}`);
  }
  const parsed = tryParseJson(text);
  const results = dedupeSearchResults(extractSearchResultsFromValue(parsed ?? text), config.webSearchMaxResults);
  return {
    provider: 'external',
    results,
    rawText: parsed ? '' : text
  };
}

async function searchWithDuckDuckGo(query, config) {
  const instantUrl = new URL('https://api.duckduckgo.com/');
  instantUrl.searchParams.set('q', query);
  instantUrl.searchParams.set('format', 'json');
  instantUrl.searchParams.set('no_html', '1');
  instantUrl.searchParams.set('skip_disambig', '1');
  const instantResponse = await fetchWithTimeout(instantUrl, {
    headers: { accept: 'application/json' }
  }, config.webSearchTimeoutMs);
  const instantText = await instantResponse.text();
  let results = instantResponse.ok
    ? dedupeSearchResults(extractSearchResultsFromValue(tryParseJson(instantText)), config.webSearchMaxResults)
    : [];
  if (results.length >= Math.min(2, config.webSearchMaxResults)) {
    return { provider: 'duckduckgo-instant-answer', results };
  }
  const htmlUrl = new URL('https://duckduckgo.com/html/');
  htmlUrl.searchParams.set('q', query);
  const htmlResponse = await fetchWithTimeout(htmlUrl, {
    headers: {
      accept: 'text/html',
      'user-agent': 'SpiLLI API Bridge/0.1 (+https://synaptrix.org)'
    }
  }, config.webSearchTimeoutMs);
  const html = await htmlResponse.text();
  if (htmlResponse.ok) {
    results = dedupeSearchResults([...results, ...parseDuckDuckGoHtmlResults(html, config.webSearchMaxResults)], config.webSearchMaxResults);
  }
  return { provider: 'duckduckgo', results };
}

async function runBridgeWebSearch(query, config) {
  const errors = [];
  try {
    const external = await searchWithExternalEndpoint(query, config);
    if (external) {
      return external;
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    return await searchWithDuckDuckGo(query, config);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    provider: 'none',
    results: [],
    errors
  };
}

function maybeBuildClaudeWebSearchHelperMessage(body, id) {
  const query = extractClaudeWebSearchHelperQuery(body);
  if (!query) {
    return undefined;
  }
  const allowedName = extractAvailableToolNames(body.tools)[0] || 'web_search';
  return createAnthropicToolUseMessage({
    id,
    model: asString(body.model) || 'spilli',
    name: allowedName,
    input: sanitizeToolInput(allowedName, { query })
  });
}

async function maybeBuildClaudeWebSearchResultMessage(body, id, config) {
  const query = extractClaudeWebSearchHelperQuery(body);
  if (!query) {
    return undefined;
  }
  const search = await runBridgeWebSearch(query, config);
  const text = formatWebSearchResults(query, search.results, search.provider);
  return {
    message: createAnthropicTextMessage({
      id,
      model: asString(body.model) || 'spilli',
      text
    }),
    search: {
      query,
      provider: search.provider,
      resultCount: search.results.length,
      errors: search.errors ?? []
    }
  };
}

function requestHasTools(body) {
  return extractAvailableToolNames(body?.tools).length > 0;
}

async function runAnthropicInferenceWithRetry(payload, config, options) {
  let retried = false;
  let result;
  try {
    result = await runInference(
      payload,
      config,
      options?.streamOptions ?? {},
      options?.session,
      options?.resolvedModel
    );
  } catch (error) {
    if (error?.spilliError !== 'SPILLI_CONTEXT_MISS' || !payload.retryHydratePayload) {
      throw error;
    }
    retried = true;
    await appendLog({
      timestamp: new Date().toISOString(),
      kind: 'spilli.context.retry_hydrate',
      run: {
        requestedModel: payload.requestedModel,
        spilliContext: summarizeContextPayload(payload.spilliContext),
        hydrateContext: summarizeContextPayload(payload.retryHydratePayload.hydrateContext)
      }
    }, 'RUN');
    result = await runInference(
      payload.retryHydratePayload,
      config,
      options?.streamOptions ?? {},
      options?.session,
      options?.resolvedModel
    );
  }
  let message = toAnthropicMessage({
    id: options.id,
    model: result.requestedModel,
    raw: result.raw,
    toolsEnabled: options.toolsEnabled,
    allowedToolNames: options.allowedToolNames,
    config
  });
  return { result, message, retried };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicMessageSse(res, message) {
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  message.content.forEach((block, index) => {
    const isToolUse = block.type === 'tool_use';
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: isToolUse
        ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
        : { type: 'text', text: '' }
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: isToolUse
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
        : { type: 'text_delta', text: asString(block.text) }
    });
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: message.usage
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
}

async function handleAnthropicMessages(req, res, config) {
  const originalBody = await readBody(req);
  const body = await summarizeOversizedToolResultsInBody(originalBody, config);
  const preResolvedModel = await resolveRequestedModel(asString(body.model), config);
  const historyState = await buildHistoryStateForAnthropicWithContextPolicy(body, config, preResolvedModel);
  const fullPayload = historyStateToSpilliPayload(historyState);
  await logClaudeRequestShape(req, body, fullPayload);
  const allowedToolNames = extractAvailableToolNames(body.tools);
  const toolsEnabled = allowedToolNames.length > 0;
  const rawMode = config.responseMode === 'raw';
  const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const directWebSearch = rawMode ? undefined : await maybeBuildClaudeWebSearchResultMessage(body, id, config);
  if (directWebSearch) {
    const directMessage = directWebSearch.message;
    await logInferenceRequest('anthropic.messages.web_search_helper', req, body, fullPayload, {
      requestId: id,
      allowedToolNames,
      toolsEnabled,
      responseMode: config.responseMode,
      effectiveResponseMode: 'compat',
      bypassedModelRun: true,
      webSearch: directWebSearch.search
    });
    await logInferenceResponse('anthropic.messages.response', {
      id,
      stream: body.stream === true,
      responseMode: config.responseMode,
      model: directMessage.model,
      allowedToolNames,
      emittedContent: directMessage.content,
      stopReason: directMessage.stop_reason,
      bypassedModelRun: true,
      webSearch: directWebSearch.search
    });
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...corsHeaders()
      });
      writeAnthropicMessageSse(res, directMessage);
      res.end();
    } else {
      json(res, 200, directMessage);
    }
    return;
  }
  const {
    chosenSession,
    resolvedModel,
    payload,
    transferMode,
    reusedTransport,
    revision,
    reason,
    sessionKey,
    previousEntry,
    historyState: preparedHistoryState,
    leaseKind,
    clientKind,
    commitHistory,
    finishSession
  } = await getOrCreateClientSession(req, historyState, config, body);
  await logInferenceRequest('anthropic.messages', req, body, payload, {
    requestId: id,
    allowedToolNames,
    toolsEnabled,
    responseMode: config.responseMode,
    effectiveResponseMode: rawMode ? 'raw' : 'compat',
    transferMode,
    reusedTransport,
    revision,
    reason,
    leaseKind,
    clientKind,
    contextPolicy: historyState.contextPolicy ?? null,
    contextCompaction: historyState.contextCompaction ?? null
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
    sessionKey,
    leaseKind,
    clientKind
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
    let completed = false;
    let finishReason = 'bridge_request_failure';
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
      completed = true;
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
      finishReason = sessionFailureReasonForError(err, 'bridge_request_failure');
      await logApiError(req, err, {
        route: 'anthropic.messages',
        request_id: id,
        response_mode: config.responseMode,
        requested_model: payload.requestedModel || null
      });
      writeSse(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) }
      });
      res.end();
    } finally {
      clearInterval(ping);
      await finishSession(completed ? 'bridge_request_success' : finishReason);
    }
    return;
  }
  let completed = false;
  let finishReason = 'bridge_request_failure';
  try {
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
    completed = true;
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
  } catch (err) {
    finishReason = sessionFailureReasonForError(err, 'bridge_request_failure');
    throw err;
  } finally {
    await finishSession(completed ? 'bridge_request_success' : finishReason);
  }
}

async function handleAnthropicCountTokens(req, res, config) {
  const body = await readBody(req);
  const resolvedModel = await resolveRequestedModel(asString(body.model), config);
  const historyState = await buildHistoryStateForAnthropicWithContextPolicy(body, config, resolvedModel);
  const payload = historyStateToSpilliPayload(historyState);
  // await logInferenceRequest('anthropic.count_tokens', req, body, payload, { requestId: `tok_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` });
  json(res, 200, {
    input_tokens: estimateTokens(`${payload.prompt}\n\n${payload.query}`)
  });
}

async function handleSummarize(req, res, config) {
  if (req.method !== 'POST') {
    json(res, 405, { error: { type: 'invalid_request_error', message: 'Method not allowed.' } });
    return;
  }
  const body = await readBody(req);
  const text = asString(body.text || body.input || body.content).trim();
  if (!text) {
    json(res, 400, { error: { type: 'invalid_request_error', message: 'text is required.' } });
    return;
  }
  const targetChars = readPositiveIntEnv(
    'SPILLI_BRIDGE_TOOL_RESULT_SUMMARY_TARGET_CHARS',
    DEFAULT_TOOL_RESULT_SUMMARY_TARGET_CHARS
  );
  const requestedTargetChars =
    Number.parseInt(body.target_chars ?? body.targetChars ?? '', 10);
  const effectiveTargetChars =
    Number.isFinite(requestedTargetChars) && requestedTargetChars > 0 ? requestedTargetChars : targetChars;
  const model = asString(body.model || config.toolResultSummarizerModel || body.requested_model).trim();
  const summary = await summarizeTextWithSpilliSdk({
    text,
    model,
    config,
    instruction: asString(body.instruction || body.instructions).trim(),
    targetChars: effectiveTargetChars,
    source: asString(body.source || 'summarize_endpoint').trim()
  });
  json(res, 200, {
    summary,
    original_chars: text.length,
    summary_chars: summary.length,
    model: model || config.toolResultSummarizerModel || null
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
  const { chosenSession, resolvedModel, payload, commitHistory, finishSession } =
    await getOrCreateClientSession(req, historyState, config, body);
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
    let completed = false;
    let finishReason = 'bridge_request_failure';
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
      completed = true;
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
      finishReason = sessionFailureReasonForError(err, 'bridge_request_failure');
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
    } finally {
      await finishSession(completed ? 'bridge_request_success' : finishReason);
    }
    return;
  }
  let completed = false;
  let finishReason = 'bridge_request_failure';
  try {
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
    completed = true;
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
  } catch (err) {
    finishReason = sessionFailureReasonForError(err, 'bridge_request_failure');
    throw err;
  } finally {
    await finishSession(completed ? 'bridge_request_success' : finishReason);
  }
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
    query: historyState.query,
    ...(historyState.maxTokens ? { max_tokens: historyState.maxTokens } : {})
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
    promptFromInputItems
  ]
    .filter(Boolean)
    .join('\n\n');

  const historyItems =
    typeof input === 'string'
      ? [createHistoryItem('user', input)]
      : inputItems
          .filter((item) => !isInstructionItem(item))
          .map((item) => {
            const text = responsesInputItemToText(item);
            return text ? { text, hash: hashHistoryValue(text) } : undefined;
          })
          .filter(Boolean);

  return createHistoryState({
    requestedModel: body.model,
    prompt,
    historyItems,
    allowDelta: typeof input !== 'string',
    maxTokens: maxTokensFromResponsesBody(body)
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
    let finishSession;
    let requestCompleted = false;
    let finishReason = 'bridge_request_failure';

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
      const sessionRun = await getOrCreateClientSession(req, historyState, config, body);
      finishSession = sessionRun.finishSession;
      const { chosenSession, resolvedModel, payload, commitHistory } = sessionRun;
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
      requestCompleted = true;

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
      finishReason = sessionFailureReasonForError(err, 'bridge_request_failure');
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
    } finally {
      await finishSession?.(requestCompleted ? 'bridge_request_success' : finishReason);
    }

    return;
  }
  const { chosenSession, resolvedModel, payload, commitHistory, finishSession } =
    await getOrCreateClientSession(req, historyState, config, body);
  let requestCompleted = false;
  let finishReason = 'bridge_request_failure';
  try {
    const result = await runInference(payload, config, {}, chosenSession, resolvedModel);

    const { output, toolCalls } = toResponsesOutputItems({
      raw: result.raw,
      toolsEnabled,
      allowedToolNames,
      toolTypes,
      responseMode: config.responseMode
    });
    commitHistory(assistantHistoryItemsForResponses(output));
    requestCompleted = true;

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
  } catch (err) {
    finishReason = sessionFailureReasonForError(err, 'bridge_request_failure');
    throw err;
  } finally {
    await finishSession(requestCompleted ? 'bridge_request_success' : finishReason);
  }
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
  if (req.method === 'POST' && (url.pathname === '/v1/spilli/summarize' || url.pathname === '/summarize')) {
    await handleSummarize(req, res, config);
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
  buildResource,
  buildSpilliContextReleaseControl,
  buildToolSchemaPrompt,
  compactHistoryItemsForModelContext,
  buildHistoryStateForAnthropic,
  buildHistoryStateForOpenAiChat,
  buildHistoryStateForResponses,
  extractHarmonyFinalText,
  isDegenerateSpilliOutput,
  extractSearchResultsFromValue,
  formatWebSearchResults,
  getLeaseKindForRequest,
  limitHistoryItemsForModelContext,
  mergePublicModels,
  maybeBuildClaudeWebSearchHelperMessage,
  normalizePublicCatalogModels,
  prepareSessionRunPayload,
  parseToolCallsFromOutput,
  specializeSessionIdentityForHistory,
  withResourceRunQueue,
  resourceCacheKey,
  renderText,
  selectPreferredDisplayMatch,
  toAnthropicMessage,
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
