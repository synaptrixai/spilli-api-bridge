import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BRIDGE_DIR = '/home/sanket/SpinOrg/SpiLLI_HowTos/PublicReleases/spilli-api-bridge';
const CLAUDE_BIN = process.env.SPILLI_CLAUDE_BIN || '/home/sanket/.local/bin/claude';
const SOURCE_PROFILE = process.env.SPILLI_CLAUDE_SETTINGS || '/home/sanket/.claude/settings.spilli.json';
const DEFAULT_MODEL = process.env.SPILLI_CLAUDE_E2E_MODEL || 'Openai_Gpt Oss 20b';
const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = Number.parseInt(process.env.SPILLI_CLAUDE_E2E_PORT || '18888', 10);
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_TOKEN = process.env.SPILLI_CLAUDE_E2E_AUTH_TOKEN || 'sk-spilli-local';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SPILLI_CLAUDE_E2E_TIMEOUT_MS || '240000', 10);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function mkdirp(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(url, timeoutMs) {
  const started = Date.now();
  let lastError = 'Bridge did not start.';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`, {
        headers: {
          'x-api-key': BRIDGE_TOKEN
        }
      });
      if (response.ok) {
        return await response.json();
      }
      lastError = `Health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for bridge health at ${url}: ${lastError}`);
}

function spawnWithCapture(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', chunk => {
    stderr += String(chunk);
  });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

async function loadSpilliProfile(sourcePath, targetBridgeUrl, modelName) {
  const raw = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  const envEntries = Array.isArray(raw?.claudeCode?.environmentVariables)
    ? raw.claudeCode.environmentVariables
    : Array.isArray(raw?.['claudeCode.environmentVariables'])
      ? raw['claudeCode.environmentVariables']
      : [];
  const envMap = Object.fromEntries(
    envEntries
      .filter(entry => entry && typeof entry === 'object' && typeof entry.name === 'string')
      .map(entry => [entry.name, String(entry.value ?? '')])
  );
  envMap.ANTHROPIC_BASE_URL = targetBridgeUrl;
  envMap.ANTHROPIC_AUTH_TOKEN = BRIDGE_TOKEN;
  envMap.ANTHROPIC_API_KEY = BRIDGE_TOKEN;
  envMap.ANTHROPIC_MODEL = modelName;
  envMap.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  envMap.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return {
    source: raw,
    envMap
  };
}

async function writeDerivedSettings(profile, artifactDir, modelName) {
  const settingsPath = path.join(artifactDir, 'settings.spilli.e2e.json');
  const merged = {
    ...profile.source,
    model: modelName,
    'claudeCode.environmentVariables': Object.entries(profile.envMap).map(([name, value]) => ({ name, value }))
  };
  await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return settingsPath;
}

async function fetchModels() {
  const response = await fetch(`${BRIDGE_URL}/v1/models`, {
    headers: {
      'x-api-key': BRIDGE_TOKEN
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to list bridge models: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function runClaudeTurn({
  artifactDir,
  settingsPath,
  prompt,
  sessionId,
  resumeSessionId,
  turnName,
  modelName
}) {
  const debugPath = path.join(artifactDir, `${turnName}.claude-debug.log`);
  const args = [
    '--bare',
    '--print',
    '--output-format',
    'json',
    '--settings',
    settingsPath,
    '--debug-file',
    debugPath,
    '--model',
    modelName,
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--tools',
    ''
  ];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  } else {
    args.push('--session-id', sessionId);
  }
  args.push(
    prompt
  );
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: BRIDGE_URL,
    ANTHROPIC_AUTH_TOKEN: BRIDGE_TOKEN,
    ANTHROPIC_API_KEY: BRIDGE_TOKEN,
    ANTHROPIC_MODEL: modelName,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  };
  const startedAt = Date.now();
  const { result } = spawnWithCapture(CLAUDE_BIN, args, {
    cwd: BRIDGE_DIR,
    env
  });
  const completed = await result;
  await fs.writeFile(
    path.join(artifactDir, `${turnName}.stdout.txt`),
    completed.stdout,
    'utf8'
  );
  await fs.writeFile(
    path.join(artifactDir, `${turnName}.stderr.txt`),
    completed.stderr,
    'utf8'
  );
  let parsed;
  try {
    parsed = JSON.parse(completed.stdout || '{}');
  } catch (error) {
    throw new Error(
      `${turnName} produced non-JSON stdout. Exit=${completed.code}. Parse error=${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    ...completed,
    parsed,
    debugPath,
    durationMs: Date.now() - startedAt
  };
}

async function readLogIfPresent(filePath) {
  if (!(await pathExists(filePath))) {
    return '';
  }
  return await fs.readFile(filePath, 'utf8');
}

async function summarizeArtifacts(artifactDir, requestLogPath) {
  const requestLog = await readLogIfPresent(requestLogPath);
  const files = await fs.readdir(artifactDir);
  return {
    artifactDir,
    requestLogPath,
    files: files.sort(),
    requestLogTail: requestLog.split('\n').filter(Boolean).slice(-60)
  };
}

async function main() {
  assert.equal(await pathExists(CLAUDE_BIN), true, `Claude CLI not found at ${CLAUDE_BIN}`);
  assert.equal(await pathExists(SOURCE_PROFILE), true, `SpiLLI Claude profile not found at ${SOURCE_PROFILE}`);

  const artifactDir = await mkdirp(path.join(os.tmpdir(), `spilli-bridge-claude-e2e-${nowStamp()}`));
  const bridgeStdoutPath = path.join(artifactDir, 'bridge.stdout.log');
  const bridgeStderrPath = path.join(artifactDir, 'bridge.stderr.log');
  const requestLogPath = path.join(artifactDir, 'bridge.requests.jsonl');

  const modelName = DEFAULT_MODEL;
  const profile = await loadSpilliProfile(SOURCE_PROFILE, BRIDGE_URL, modelName);
  const settingsPath = await writeDerivedSettings(profile, artifactDir, modelName);

  const bridgeEnv = {
    ...process.env,
    SPILLI_BRIDGE_HOST: BRIDGE_HOST,
    SPILLI_BRIDGE_PORT: String(BRIDGE_PORT),
    SPILLI_BRIDGE_AUTH_TOKEN: BRIDGE_TOKEN,
    SPILLI_BRIDGE_RESPONSE_MODE: 'compat',
    SPILLI_BRIDGE_REQUEST_LOG_PATH: requestLogPath,
    SPILLI_BRIDGE_REQUEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS)
  };

  const bridge = spawn('node', ['src/server.mjs'], {
    cwd: BRIDGE_DIR,
    env: bridgeEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let bridgeStdout = '';
  let bridgeStderr = '';
  bridge.stdout?.on('data', chunk => {
    const text = String(chunk);
    bridgeStdout += text;
  });
  bridge.stderr?.on('data', chunk => {
    const text = String(chunk);
    bridgeStderr += text;
  });

  let bridgeClosed = false;
  bridge.on('close', () => {
    bridgeClosed = true;
  });

  try {
    await waitForHealth(BRIDGE_URL, 20_000);
    const modelsPayload = await fetchModels();
    await fs.writeFile(path.join(artifactDir, 'bridge.models.json'), `${JSON.stringify(modelsPayload, null, 2)}\n`, 'utf8');

    const availableModelIds = Array.isArray(modelsPayload?.data)
      ? modelsPayload.data.map(item => item?.id).filter(Boolean)
      : Array.isArray(modelsPayload?.models)
        ? modelsPayload.models.map(item => item?.id ?? item).filter(Boolean)
        : [];
    assert.ok(
      availableModelIds.some(id => String(id) === modelName),
      `Bridge model list does not contain "${modelName}". See ${path.join(artifactDir, 'bridge.models.json')}`
    );

    const sessionId = crypto.randomUUID();
    const firstTurn = await runClaudeTurn({
      artifactDir,
      settingsPath,
      prompt: 'Reply with exactly: SPILLI_CLAUDE_ONE_TURN_OK',
      sessionId,
      turnName: 'turn-1',
      modelName
    });
    assert.equal(firstTurn.code, 0, `Claude first turn exited with ${firstTurn.code}`);
    assert.equal(firstTurn.parsed?.is_error, false, `Claude first turn returned an error payload: ${firstTurn.stdout}`);
    assert.match(
      String(firstTurn.parsed?.result ?? ''),
      /SPILLI_CLAUDE_ONE_TURN_OK/i,
      'Claude first turn did not return the expected marker'
    );

    const secondTurn = await runClaudeTurn({
      artifactDir,
      settingsPath,
      prompt: 'Repeat the exact marker from your previous answer and append _SECOND',
      sessionId,
      resumeSessionId: firstTurn.parsed?.session_id ?? sessionId,
      turnName: 'turn-2',
      modelName
    });
    assert.equal(secondTurn.code, 0, `Claude second turn exited with ${secondTurn.code}`);
    assert.equal(secondTurn.parsed?.is_error, false, `Claude second turn returned an error payload: ${secondTurn.stdout}`);
    assert.match(
      String(secondTurn.parsed?.result ?? ''),
      /SECOND/i,
      'Claude second turn did not produce the expected follow-up marker'
    );

    await fs.writeFile(
      path.join(artifactDir, 'summary.json'),
      `${JSON.stringify({
        ok: true,
        modelName,
        sessionId,
        bridgeUrl: BRIDGE_URL,
        requestLogPath,
        turns: [
          {
            name: 'turn-1',
            durationMs: firstTurn.durationMs,
            sessionId: firstTurn.parsed?.session_id ?? null
          },
          {
            name: 'turn-2',
            durationMs: secondTurn.durationMs,
            sessionId: secondTurn.parsed?.session_id ?? null
          }
        ]
      }, null, 2)}\n`,
      'utf8'
    );

    console.log(JSON.stringify({
      ok: true,
      artifactDir,
      requestLogPath,
      bridgeUrl: BRIDGE_URL,
      modelName,
      firstTurn: {
        durationMs: firstTurn.durationMs,
        result: firstTurn.parsed?.result ?? null
      },
      secondTurn: {
        durationMs: secondTurn.durationMs,
        result: secondTurn.parsed?.result ?? null
      }
    }, null, 2));
  } catch (error) {
    await fs.writeFile(bridgeStdoutPath, bridgeStdout, 'utf8');
    await fs.writeFile(bridgeStderrPath, bridgeStderr, 'utf8');
    const summary = await summarizeArtifacts(artifactDir, requestLogPath);
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
      bridgeUrl: BRIDGE_URL,
      requestLogPath,
      bridgeClosed,
      summary
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await fs.writeFile(bridgeStdoutPath, bridgeStdout, 'utf8');
    await fs.writeFile(bridgeStderrPath, bridgeStderr, 'utf8');
    if (!bridge.killed) {
      bridge.kill('SIGTERM');
      await sleep(500);
      if (!bridge.killed) {
        bridge.kill('SIGKILL');
      }
    }
  }
}

await main();
