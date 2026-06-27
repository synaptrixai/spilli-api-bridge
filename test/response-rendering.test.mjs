import assert from 'node:assert/strict';

import {
  extractHarmonyFinalText,
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

console.log('response rendering tests passed');
