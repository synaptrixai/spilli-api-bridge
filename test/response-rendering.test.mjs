import assert from 'node:assert/strict';

import {
  buildHistoryStateForAnthropic,
  buildHistoryStateForOpenAiChat,
  buildHistoryStateForResponses,
  extractHarmonyFinalText,
  mergePublicModels,
  normalizePublicCatalogModels,
  prepareSessionRunPayload,
  parseToolCallsFromOutput,
  renderText,
  toResponsesOutputItems
} from '../src/server.mjs';

const allowedToolNames = ['exec_command'];

const toolThenFinal = [
  '<|channel|>analysis<|message|>Need to inspect the workspace.<|end|>',
  '<|start|>assistant<|channel|>commentary to=exec_command <|constrain|>json<|message|>{"cmd":"ls -1"}<|call|>',
  '<|start|>assistant<|channel|>final<|message|>The workspace contains README.md and src.<|end|>'
].join('');

const toolOnly = [
  '<|channel|>analysis<|message|>Need to inspect the workspace.<|end|>',
  '<|start|>assistant<|channel|>commentary to=exec_command <|constrain|>json<|message|>{"cmd":"ls -1"}<|call|>'
].join('');

const patchTool = [
  '<|channel|>analysis<|message|>Need to patch the README.<|end|>',
  '<|start|>assistant<|channel|>commentary to=apply_patch <|constrain|>json<|message|>*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch<|end|>'
].join('');

const partialFinal = '<|channel|>final<|message|>Clean final text without a terminator';

assert.equal(
  extractHarmonyFinalText(toolThenFinal),
  'The workspace contains README.md and src.',
  'extracts clean final text from Harmony output'
);

assert.equal(
  extractHarmonyFinalText(partialFinal),
  'Clean final text without a terminator',
  'extracts clean final text from unterminated Harmony output'
);

const calls = parseToolCallsFromOutput(toolThenFinal, allowedToolNames);
assert.equal(calls.length, 1, 'parses one tool call');
assert.equal(calls[0].name, 'exec_command');
assert.deepEqual(calls[0].input, { cmd: 'ls -1' });

assert.equal(
  renderText(toolThenFinal, calls),
  'The workspace contains README.md and src.',
  'renders final text without Harmony control tokens when tool calls are present'
);

assert.equal(
  renderText(toolOnly, parseToolCallsFromOutput(toolOnly, allowedToolNames)),
  '',
  'does not expose analysis or tool-call payload as assistant text'
);

const patchOutput = toResponsesOutputItems({
  raw: patchTool,
  toolsEnabled: true,
  allowedToolNames: ['exec_command', 'apply_patch'],
  toolTypes: { exec_command: 'function', apply_patch: 'custom' },
  responseMode: 'compat'
});

assert.deepEqual(
  patchOutput.output.map(item => item.type),
  ['custom_tool_call'],
  'emits native Responses custom tool calls for custom tools'
);
assert.equal(patchOutput.output[0].name, 'apply_patch');
assert.match(patchOutput.output[0].input, /^\*\*\* Begin Patch/);

const { output, toolCalls } = toResponsesOutputItems({
  raw: toolThenFinal,
  toolsEnabled: true,
  allowedToolNames,
  responseMode: 'compat'
});

assert.equal(toolCalls.length, 1, 'returns parsed tool call metadata');
assert.deepEqual(
  output.map(item => item.type),
  ['message', 'function_call'],
  'emits one message item and one Responses function_call item'
);
assert.equal(output[0].content[0].text, 'The workspace contains README.md and src.');
assert.equal(output[1].name, 'exec_command');
assert.equal(output[1].arguments, '{"cmd":"ls -1"}');

for (const item of output) {
  assert.equal(
    JSON.stringify(item).includes('<|channel|>'),
    false,
    'Responses output does not contain Harmony channel markers'
  );
}

const publicCatalogModels = normalizePublicCatalogModels(
  {
    models: [
      'Named Public Model.public',
      { name: 'gguf:sha256:abc123', display_name: 'Tiny Public Model', scope: 'public' },
      { name: 'gguf:fastsha256:11f125', scope: 'public' }
    ]
  },
  { scope: 'public' }
);

assert.deepEqual(
  publicCatalogModels,
  [
    { uid: 'Named Public Model', displayName: 'Named Public Model' },
    { uid: 'gguf:sha256:abc123', displayName: 'Tiny Public Model' },
    { uid: 'gguf:fastsha256:11f125', displayName: 'gguf:fastsha256:11f125' }
  ],
  'normalizes backend public model catalog entries'
);

const mergedPublicModels = mergePublicModels(
  [
    { uid: 'gguf:sha256:abc123', displayName: 'tinygemma3-Q8_0.gguf', count: 1 },
    { uid: 'Host Public Model', displayName: 'Host Public Model', count: 2 }
  ],
  publicCatalogModels
);

assert.deepEqual(
  mergedPublicModels,
  [
    { uid: 'gguf:sha256:abc123', displayName: 'tinygemma3-Q8_0.gguf', count: 1 },
    { uid: 'Host Public Model', displayName: 'Host Public Model', count: 2 },
    { uid: 'Named Public Model', displayName: 'Named Public Model', count: 0 }
  ],
  'merges backend public catalog models with host inventory and drops unlabeled hashed catalog-only models'
);

const liveSession = { isLive: () => true };
const resourceKey = 'model|public|';

const firstAnthropicHistory = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'Be concise.',
  messages: [{ role: 'user', content: 'Hello' }]
});
const firstPrepared = prepareSessionRunPayload(firstAnthropicHistory, undefined, resourceKey);
assert.equal(firstPrepared.reused, false, 'first request creates a full-history run');
assert.equal(firstPrepared.payload.prompt, firstAnthropicHistory.prompt);
assert.equal(firstPrepared.payload.query, 'USER:\nHello');

const secondAnthropicHistory = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'Be concise.',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Next question' }
  ]
});
const previousAfterAssistant = {
  session: liveSession,
  promptHash: firstAnthropicHistory.promptHash,
  resourceKey,
  initialized: true,
  historyHashes: secondAnthropicHistory.historyHashes.slice(0, 2)
};
const secondPrepared = prepareSessionRunPayload(secondAnthropicHistory, previousAfterAssistant, resourceKey);
assert.equal(secondPrepared.reused, true, 'append-only request reuses the live session');
assert.equal(secondPrepared.payload.prompt, '', 'append-only request does not resend the prompt');
assert.equal(
  secondPrepared.payload.query,
  'USER:\nNext question',
  'append-only request sends only the new user suffix'
);

const promptChangedHistory = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'Be verbose.',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Next question' }
  ]
});
const promptChangedPrepared = prepareSessionRunPayload(promptChangedHistory, previousAfterAssistant, resourceKey);
assert.equal(promptChangedPrepared.reused, false, 'prompt changes force a fresh full-history session');
assert.equal(promptChangedPrepared.payload.prompt, promptChangedHistory.prompt);
assert.equal(promptChangedPrepared.payload.query, promptChangedHistory.query);

const compactedHistory = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'Be concise.',
  messages: [
    { role: 'user', content: 'Summary of the previous chat' },
    { role: 'user', content: 'Continue from there' }
  ]
});
const compactedPrepared = prepareSessionRunPayload(compactedHistory, previousAfterAssistant, resourceKey);
assert.equal(compactedPrepared.reused, false, 'rewritten or compacted history forces a fresh session');
assert.equal(compactedPrepared.payload.query, compactedHistory.query);

const openAiChatHistory = buildHistoryStateForOpenAiChat({
  model: 'spilli-test',
  messages: [
    { role: 'system', content: 'System stays in the prompt.' },
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Follow up' }
  ]
});
assert.equal(openAiChatHistory.historyItems.length, 3, 'OpenAI chat history excludes system messages');
assert.match(openAiChatHistory.prompt, /System stays in the prompt\./);

const responsesArrayHistory = buildHistoryStateForResponses({
  model: 'spilli-test',
  instructions: 'Prefer short answers.',
  input: [
    { role: 'developer', content: [{ type: 'input_text', text: 'Hidden instruction' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Visible question' }] }
  ]
});
assert.equal(responsesArrayHistory.allowDelta, true, 'Responses array input can use append-only deltas');
assert.equal(responsesArrayHistory.query, 'USER:\nVisible question');
assert.match(responsesArrayHistory.prompt, /Hidden instruction/);

const responsesStringHistory = buildHistoryStateForResponses({
  model: 'spilli-test',
  input: 'Opaque single input'
});
const responsesStringPrepared = prepareSessionRunPayload(
  responsesStringHistory,
  {
    session: liveSession,
    promptHash: responsesStringHistory.promptHash,
    resourceKey,
    initialized: true,
    historyHashes: []
  },
  resourceKey
);
assert.equal(responsesStringHistory.allowDelta, false, 'Responses string input disables history diffing');
assert.equal(responsesStringPrepared.reused, false, 'Responses string input starts a fresh full-history session');
assert.equal(responsesStringPrepared.payload.query, 'USER:\nOpaque single input');

console.log('response rendering tests passed');
