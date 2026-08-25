import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildModelsResponse,
  buildResource,
  buildSpilliContextReleaseControl,
  buildToolSchemaPrompt,
  compactHistoryItemsForModelContext,
  buildHistoryStateForAnthropic,
  buildHistoryStateForOpenAiChat,
  buildHistoryStateForResponses,
  buildResponsesWebSearchHydratedPayload,
  extractHarmonyFinalText,
  extractSearchResultsFromValue,
  formatWebSearchResults,
  getCodexSessionIdentity,
  getGenericSessionIdentity,
  getLeaseKindForRequest,
  isCodexUtilityRequest,
  isDegenerateSpilliOutput,
  limitHistoryItemsForModelContext,
  maybeBuildClaudeWebSearchHelperMessage,
  mergePublicModels,
  normalizePublicCatalogModels,
  prepareSessionRunPayload,
  extractRequestedToolNames,
  parseToolCallsFromOutput,
  renderText,
  resourceCacheKey,
  resolveModelFromCatalog,
  selectPreferredDisplayMatch,
  specializeSessionIdentityForHistory,
  toAnthropicMessage,
  withResourceRunQueue,
  toResponsesOutputItems
} from '../src/server.mjs';

const allowedToolNames = ['exec_command'];

const claudeFileTools = [
  {
    name: 'Write',
    description: "Writes a file to the local filesystem, overwriting if one exists.\n\nWhen to use: creating a new file, or fully replacing one you've already Read. For partial changes, use Edit instead.",
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['file_path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacement in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' }
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false
    }
  }
];

const toolThenFinal = [
  '<|channel|>analysis<|message|>Need to inspect the workspace.<|end|>',
  '<|start|>assistant<|channel|>commentary to=exec_command <|constrain|>json<|message|>{"cmd":"ls -1"}<|call|>',
  '<|start|>assistant<|channel|>final<|message|>The workspace contains README.md and src.<|end|>'
].join('');

const toolOnly = [
  '<|channel|>analysis<|message|>Need to inspect the workspace.<|end|>',
  '<|start|>assistant<|channel|>commentary to=exec_command <|constrain|>json<|message|>{"cmd":"ls -1"}<|call|>'
].join('');

const claudeWebSearchTool = [
  '<|channel|>analysis<|message|>We need to use WebSearch for current time in India.<|end|>',
  '<|start|>assistant<|channel|>commentary to=WebSearch <|constrain|>json<|message|>{"query":"current time in india","top_k":5,"recency_days":-1}'
].join('');

const repoBrowserSearchTool = [
  '<|channel|>analysis<|message|>We should inspect relevant files.<|end|>',
  '<|start|>assistant<|channel|>analysis to=repo_browser.search code<|message|>{"path":"", "query":"Spilli", "max_results":20}'
].join('');

const prefixedBashTool = [
  '<|channel|>analysis<|message|>Need to list files.<|end|>',
  '<|start|>assistant<|channel|>commentary to=tool.Bash code<|message|>{"cmd":["bash","-lc","find /tmp -maxdepth 1 -type f | head"]}'
].join('');

const repoBrowserTreeTool = [
  '<|channel|>analysis<|message|>Need a tree.<|end|>',
  '<|start|>assistant<|channel|>commentary to=repo_browser.print_tree code<|message|>{"path":"api-bridge","depth":2}'
].join('');

const containerExecTool = [
  '<|channel|>analysis<|message|>Need command.<|end|>',
  '<|start|>assistant<|channel|>commentary to=container.exec code<|message|>{"cmd":["bash","-lc","ls -la"]}'
].join('');

const genericToolRunRead = [
  '<|channel|>analysis<|message|>Need to read the file.<|end|>',
  '<|start|>assistant<|channel|>commentary to=tool.run code<|message|>{"name":"Read","arguments":{"file_path":"/tmp/ContextManagement.md"}}'
].join('');

const repoBrowserReadFileTool = [
  '<|channel|>analysis<|message|>Need to read README.<|end|>',
  '<|start|>assistant<|channel|>commentary to=repo_browser.read_file code<|message|>{"path":"README.md"}'
].join('');

const nativeReadLineRangeTool = [
  '<|channel|>analysis<|message|>Need to read README lines.<|end|>',
  '<|start|>assistant<|channel|>commentary to=Read <|constrain|>json<|message|>{"path":"README.md","line_start":1,"line_end":400}'
].join('');

const fileEditAppendTool = [
  '<|channel|>analysis<|message|>Need to append hello.<|end|>',
  '<|start|>assistant<|channel|>commentary to=FileEdit <|constrain|>json<|message|>{"path":"README.md","content":"\\nhello","mode":"a"}'
].join('');

const writeFileAppendTool = [
  '<|channel|>analysis<|message|>Need to append hello.<|end|>',
  '<|start|>assistant<|channel|>commentary to=write_file <|constrain|>json<|message|>{"path":"README.md","append":"\\nhello"}'
].join('');

const toolBashTool = [
  '<|channel|>analysis<|message|>Need shell.<|end|>',
  '<|start|>assistant<|channel|>commentary to=tool_bash code<|message|>{"cmd":["bash","-lc","printf hello >> README.md"]}'
].join('');

const nativeBashArrayCommandTool = [
  '<|channel|>analysis<|message|>Need shell.<|end|>',
  '<|start|>assistant<|channel|>commentary to=Bash <|constrain|>json<|message|>{"command":["bash","-lc","echo -e \\"\\\\nhello\\" >> README.md"]}'
].join('');

const wrappedBashWithWrongRecipient = [
  '<|channel|>analysis<|message|>Need shell.<|end|>',
  '<|start|>assistant<|channel|>commentary to=Golang code<|message|>{"name":"Bash","input":{"command":"echo \\"hello\\" >> README.md","description":"Append hello"}}'
].join('');

const wrappedReadWithWrongRecipient = [
  '<|channel|>analysis<|message|>Need to read.<|end|>',
  '<|start|>assistant<|channel|>commentary to=Golang code<|message|>{"name":"Read","input":{"path":"README.md"}}'
].join('');

const nativeEditAppendTool = [
  '<|channel|>analysis<|message|>Need to append hello with Edit.<|end|>',
  '<|start|>assistant<|channel|>commentary to=Edit <|constrain|>json<|message|>{"file_path":"README.md","old_string":"","new_string":"hello\\n"}'
].join('');

const unsafeCompactedWriteTool = [
  '<|channel|>analysis<|message|>Need to write README after reading it.<|end|>',
  '<|start|>assistant<|channel|>commentary to=Write <|constrain|>json<|message|>{"file_path":"README.md","content":"# README\\n\\n[tail excerpt]\\n214\\n\\nhello"}'
].join('');

const existingWriteTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spilli-bridge-write-'));
const existingWritePath = path.join(existingWriteTestDir, 'README.md');
fs.writeFileSync(existingWritePath, '# Title\n\nBody\n', 'utf8');

const appendOnlyNativeWriteTool = [
  '<|channel|>analysis<|message|>Need to append hello using Write.<|end|>',
  `<|start|>assistant<|channel|>commentary to=Write <|constrain|>json<|message|>${JSON.stringify({
    file_path: existingWritePath,
    content: '# Title\n\nBody\nhello\n'
  })}`
].join('');

const destructiveNativeWriteTool = [
  '<|channel|>analysis<|message|>Need to write partial content.<|end|>',
  `<|start|>assistant<|channel|>commentary to=Write <|constrain|>json<|message|>${JSON.stringify({
    file_path: existingWritePath,
    content: '# Title\n\n[tail excerpt]\nhello\n'
  })}`
].join('');

const toolUseIdRecipientBashTool = [
  '<|channel|>analysis<|message|>Need shell after an edit failed.<|end|>',
  '<|start|>assistant<|channel|>commentary to=toolu_mrt95z3708ktmu <|constrain|>json<|message|>{"command":["bash","-lc","cat \\"README.md\\""]}'
].join('');

const anonymousRepoSearchTool = [
  '<|channel|>analysis<|message|>Search for spilli usage.<|end|>',
  '<|start|>assistant<|channel|>commentary<|message|>{"path":"src/server.mjs","query":"spilli","max_results":20}'
].join('');

const patchTool = [
  '<|channel|>analysis<|message|>Need to patch the README.<|end|>',
  '<|start|>assistant<|channel|>commentary to=apply_patch <|constrain|>json<|message|>*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch<|end|>'
].join('');

const partialFinal = '<|channel|>final<|message|>Clean final text without a terminator';
const repeatedFinal = [
  '<|channel|>analysis<|message|>Thinking.<|end|>',
  '<|start|>assistant<|channel|>final<|message|>This is the end of the conversation.<|end|>',
  '<|start|>assistant<|channel|>final<|message|>Here is the useful answer after a tool call with enough detail to be selected as the final response.<|end|>',
  '<|start|>assistant<|channel|>commentary<|message|>I should not leak this continuation.'
].join('');

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

assert.equal(
  extractHarmonyFinalText(repeatedFinal),
  'Here is the useful answer after a tool call with enough detail to be selected as the final response.',
  'selects the substantive final segment when the model emits multiple finals'
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

assert.equal(isDegenerateSpilliOutput(' conserved???????????????????????????????'), true, 'detects question-mark degeneration from poisoned context');
assert.equal(isDegenerateSpilliOutput('<|channel|>final<|message|>A normal answer? Yes.'), false, 'does not flag normal question marks');

const toolSchemaPrompt = buildToolSchemaPrompt(claudeFileTools, {
  renderToolSchemas: true,
  toolSchemaPromptMaxChars: 8000
});
assert.match(toolSchemaPrompt, /Here are the available tools in JSON Schema format/);
assert.match(toolSchemaPrompt, /"name": "Edit"/);
assert.match(toolSchemaPrompt, /"old_string"/);
assert.match(toolSchemaPrompt, /"new_string"/);
assert.match(toolSchemaPrompt, /"name": "Write"/);
assert.match(toolSchemaPrompt, /overwriting if one exists/);
assert.match(toolSchemaPrompt, /For partial changes, use Edit instead/);

const historyWithToolSchemaPrompt = buildHistoryStateForAnthropic(
  {
    model: 'Openai_Gpt Oss 20b',
    system: 'You are Claude Code.',
    tools: claudeFileTools,
    messages: [{ role: 'user', content: 'Append hello to README.md.' }]
  },
  {
    renderToolSchemas: true,
    toolSchemaPromptMaxChars: 8000
  }
);
assert.match(historyWithToolSchemaPrompt.prompt, /"name": "Edit"/);
assert.match(historyWithToolSchemaPrompt.prompt, /You are Claude Code/);

const rawReadResult = [
  'Tool result for toolu_read:',
  '1\t# SpiLLI API Bridge',
  '2\t',
  '3\tLocal HTTP bridge from Anthropic/OpenAI-style API clients to the SpiLLI SDK service.',
  ...Array.from({ length: 180 }, (_, index) => `${index + 4}\tREADME content line ${index}`)
].join('\n');
const compactedWithWastedReadDependency = await compactHistoryItemsForModelContext(
  [
    {
      role: 'user',
      content: rawReadResult,
      text: `USER:\n${rawReadResult}`,
      hash: 'raw-read'
    },
    {
      role: 'assistant',
      content: 'Tool call Read({"file_path":"README.md"})',
      text: 'ASSISTANT:\nTool call Read({"file_path":"README.md"})',
      hash: 'read-call'
    },
    {
      role: 'user',
      content: 'Tool result for toolu_read_again:\nWasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
      text: 'USER:\nTool result for toolu_read_again:\nWasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
      hash: 'wasted-read'
    }
  ],
  { maxHistoryChars: 500, hostContextTokens: 16384 },
  { config: { contextDependencyRawChars: 12000, toolResultSummarizerEnabled: false } }
);
assert.equal(compactedWithWastedReadDependency.rawDependencyCount, 1, 'retains raw Read result referenced by wasted Read tool result');
assert.match(
  compactedWithWastedReadDependency.items.map(item => item.text).join('\n\n'),
  /raw earlier tool_result retained/
);
assert.match(
  compactedWithWastedReadDependency.items.map(item => item.text).join('\n\n'),
  /# SpiLLI API Bridge/
);

const maxTokensRaw = '<|channel|>final<|message|>Partial answer before the cap.|<stop_reason>|max_tokens|</stop_reason>|';
const defaultMaxTokensMessage = toAnthropicMessage({
  id: 'msg_max_tokens_default',
  model: 'Openai_Gpt_Oss_20b',
  raw: maxTokensRaw,
  toolsEnabled: true,
  allowedToolNames: ['AskUserQuestion']
});
assert.equal(defaultMaxTokensMessage.stop_reason, 'tool_use', 'asks continuation questions by default');
assert.equal(defaultMaxTokensMessage.content[1].name, 'AskUserQuestion');

const optOutMaxTokensMessage = toAnthropicMessage({
  id: 'msg_max_tokens_opt_out',
  model: 'Openai_Gpt_Oss_20b',
  raw: maxTokensRaw,
  toolsEnabled: true,
  allowedToolNames: ['AskUserQuestion'],
  config: { askContinueOnMaxTokens: false }
});
assert.equal(optOutMaxTokensMessage.stop_reason, 'max_tokens', 'preserves max_tokens when continuation questions are disabled');

const continueQuestionMessage = defaultMaxTokensMessage;
assert.equal(continueQuestionMessage.stop_reason, 'tool_use', 'asks through AskUserQuestion when max_tokens is reached');
assert.equal(continueQuestionMessage.content[0].type, 'text');
assert.equal(continueQuestionMessage.content[1].type, 'tool_use');
assert.equal(continueQuestionMessage.content[1].name, 'AskUserQuestion');
assert.equal(continueQuestionMessage.content[1].input.questions[0].options[0].label, 'Continue');

const maxTokensWithoutQuestionTool = toAnthropicMessage({
  id: 'msg_max_tokens_no_tool',
  model: 'Openai_Gpt_Oss_20b',
  raw: maxTokensRaw,
  toolsEnabled: true,
  allowedToolNames: ['Bash'],
  config: { askContinueOnMaxTokens: true }
});
assert.equal(maxTokensWithoutQuestionTool.stop_reason, 'max_tokens', 'preserves max_tokens when AskUserQuestion is unavailable');

const webSearchCalls = parseToolCallsFromOutput(claudeWebSearchTool, ['WebSearch']);
assert.equal(webSearchCalls.length, 1, 'parses Claude Code WebSearch Harmony tool calls even without a trailing call token');
assert.equal(webSearchCalls[0].name, 'WebSearch');
assert.deepEqual(webSearchCalls[0].input, {
  query: 'current time in india'
});
assert.equal(
  renderText(claudeWebSearchTool, webSearchCalls),
  '',
  'does not expose Claude Code analysis or WebSearch payload as assistant text'
);

const repoSearchCalls = parseToolCallsFromOutput(repoBrowserSearchTool, ['Agent']);
assert.equal(repoSearchCalls.length, 1, 'aliases repo_browser.search Harmony calls to Claude Code Agent');
assert.equal(repoSearchCalls[0].name, 'Agent');
assert.equal(repoSearchCalls[0].input.subagent_type, 'Explore');
assert.match(repoSearchCalls[0].input.prompt, /Spilli/);
assert.equal(
  renderText(repoBrowserSearchTool, repoSearchCalls),
  '',
  'does not expose unsupported repo-browser Harmony payload as assistant text'
);

const prefixedBashCalls = parseToolCallsFromOutput(prefixedBashTool, ['Bash']);
assert.equal(prefixedBashCalls.length, 1, 'normalizes tool-prefixed Claude Code tool names');
assert.equal(prefixedBashCalls[0].name, 'Bash');
assert.deepEqual(prefixedBashCalls[0].input, {
  command: 'find /tmp -maxdepth 1 -type f | head'
});

const repoTreeCalls = parseToolCallsFromOutput(repoBrowserTreeTool, ['Bash']);
assert.equal(repoTreeCalls.length, 1, 'aliases repo_browser.print_tree to Bash when Bash is available');
assert.equal(repoTreeCalls[0].name, 'Bash');
assert.match(repoTreeCalls[0].input.command, /^find 'api-bridge' -maxdepth 2 -print/);

const containerExecCalls = parseToolCallsFromOutput(containerExecTool, ['Bash']);
assert.equal(containerExecCalls.length, 1, 'aliases container.exec to Bash when Bash is available');
assert.equal(containerExecCalls[0].name, 'Bash');
assert.deepEqual(containerExecCalls[0].input, { command: 'ls -la' });

const genericToolRunReadCalls = parseToolCallsFromOutput(genericToolRunRead, ['Read']);
assert.equal(genericToolRunReadCalls.length, 1, 'unwraps generic tool.run wrappers to the requested Claude Code tool');
assert.equal(genericToolRunReadCalls[0].name, 'Read');
assert.deepEqual(genericToolRunReadCalls[0].input, {
  file_path: '/tmp/ContextManagement.md'
});

const repoBrowserReadFileCalls = parseToolCallsFromOutput(repoBrowserReadFileTool, ['Read']);
assert.equal(repoBrowserReadFileCalls.length, 1, 'aliases repo_browser.read_file to Claude Code Read');
assert.equal(repoBrowserReadFileCalls[0].name, 'Read');
assert.deepEqual(repoBrowserReadFileCalls[0].input, {
  file_path: 'README.md'
});

const nativeReadLineRangeCalls = parseToolCallsFromOutput(nativeReadLineRangeTool, ['Read']);
assert.equal(nativeReadLineRangeCalls.length, 1, 'normalizes native Read line_start/line_end aliases');
assert.equal(nativeReadLineRangeCalls[0].name, 'Read');
assert.deepEqual(nativeReadLineRangeCalls[0].input, {
  file_path: 'README.md',
  offset: 1,
  limit: 400
});

const fileEditAppendCalls = parseToolCallsFromOutput(fileEditAppendTool, ['Edit', 'Write', 'Bash']);
assert.equal(fileEditAppendCalls.length, 1, 'aliases append-style FileEdit to Bash append');
assert.equal(fileEditAppendCalls[0].name, 'Bash');
assert.deepEqual(fileEditAppendCalls[0].input, {
  command: "printf %s '\nhello' >> 'README.md'"
});

const writeFileAppendCalls = parseToolCallsFromOutput(writeFileAppendTool, ['Write', 'Bash']);
assert.equal(writeFileAppendCalls.length, 1, 'aliases append-style write_file to Bash append');
assert.equal(writeFileAppendCalls[0].name, 'Bash');
assert.deepEqual(writeFileAppendCalls[0].input, {
  command: "printf %s '\nhello' >> 'README.md'"
});

const toolBashCalls = parseToolCallsFromOutput(toolBashTool, ['Bash']);
assert.equal(toolBashCalls.length, 1, 'aliases tool_bash to Claude Code Bash');
assert.equal(toolBashCalls[0].name, 'Bash');
assert.deepEqual(toolBashCalls[0].input, {
  command: 'printf hello >> README.md'
});

const nativeBashArrayCommandCalls = parseToolCallsFromOutput(nativeBashArrayCommandTool, ['Bash']);
assert.equal(nativeBashArrayCommandCalls.length, 1, 'normalizes native Bash command arrays to a command string');
assert.equal(nativeBashArrayCommandCalls[0].name, 'Bash');
assert.deepEqual(nativeBashArrayCommandCalls[0].input, {
  command: 'echo -e "\\nhello" >> README.md'
});

const wrappedBashCalls = parseToolCallsFromOutput(wrappedBashWithWrongRecipient, ['Bash']);
assert.equal(wrappedBashCalls.length, 1, 'uses JSON payload name/input ahead of malformed Harmony recipients');
assert.equal(wrappedBashCalls[0].name, 'Bash');
assert.deepEqual(wrappedBashCalls[0].input, {
  command: 'echo "hello" >> README.md',
  description: 'Append hello'
});

const wrappedReadCalls = parseToolCallsFromOutput(wrappedReadWithWrongRecipient, ['Read']);
assert.equal(wrappedReadCalls.length, 1, 'normalizes wrapped Read payloads with malformed Harmony recipients');
assert.equal(wrappedReadCalls[0].name, 'Read');
assert.deepEqual(wrappedReadCalls[0].input, {
  file_path: 'README.md'
});

const nativeEditAppendCalls = parseToolCallsFromOutput(nativeEditAppendTool, ['Edit', 'Bash']);
assert.equal(nativeEditAppendCalls.length, 1, 'aliases empty-old-string Edit append attempts to Bash append');
assert.equal(nativeEditAppendCalls[0].name, 'Bash');
assert.deepEqual(nativeEditAppendCalls[0].input, {
  command: "printf %s 'hello\n' >> 'README.md'"
});

const unsafeCompactedWriteCalls = parseToolCallsFromOutput(unsafeCompactedWriteTool, ['Write', 'Bash']);
assert.equal(unsafeCompactedWriteCalls.length, 1, 'turns compacted native Write calls into a safe tool error');
assert.equal(unsafeCompactedWriteCalls[0].name, 'Bash');
assert.match(unsafeCompactedWriteCalls[0].input.command, /blocked an unsafe Write tool call/);

const appendOnlyNativeWriteCalls = parseToolCallsFromOutput(appendOnlyNativeWriteTool, ['Write', 'Bash']);
assert.equal(appendOnlyNativeWriteCalls.length, 1, 'converts append-only native Write for existing files to Bash append');
assert.equal(appendOnlyNativeWriteCalls[0].name, 'Bash');
assert.deepEqual(appendOnlyNativeWriteCalls[0].input, {
  command: `printf %s 'hello\n' >> '${existingWritePath}'`
});

const destructiveNativeWriteCalls = parseToolCallsFromOutput(destructiveNativeWriteTool, ['Write', 'Bash']);
assert.equal(destructiveNativeWriteCalls.length, 1, 'turns unsafe native Write overwrites into a safe tool error');
assert.equal(destructiveNativeWriteCalls[0].name, 'Bash');
assert.match(destructiveNativeWriteCalls[0].input.command, /blocked an unsafe Write tool call/);
assert.match(destructiveNativeWriteCalls[0].input.command, /exit 1$/);

const toolUseIdRecipientBashCalls = parseToolCallsFromOutput(toolUseIdRecipientBashTool, ['Bash']);
assert.equal(toolUseIdRecipientBashCalls.length, 1, 'aliases malformed tool-use-id recipients with commands to Bash');
assert.equal(toolUseIdRecipientBashCalls[0].name, 'Bash');
assert.deepEqual(toolUseIdRecipientBashCalls[0].input, {
  command: 'cat "README.md"'
});

const anonymousRepoSearchCalls = parseToolCallsFromOutput(anonymousRepoSearchTool, ['Bash']);
assert.equal(anonymousRepoSearchCalls.length, 1, 'infers anonymous repo-search JSON as a tool call');
assert.equal(anonymousRepoSearchCalls[0].name, 'Bash');
assert.match(anonymousRepoSearchCalls[0].input.command, /grep -RIn/);
assert.match(anonymousRepoSearchCalls[0].input.command, /src\/server\.mjs/);
assert.equal(
  renderText(anonymousRepoSearchTool, anonymousRepoSearchCalls),
  '',
  'does not expose anonymous repo-search JSON as assistant text'
);

const webSearchHelperMessage = maybeBuildClaudeWebSearchHelperMessage(
  {
    model: 'Openai_Gpt Oss 20b',
    system: [
      { type: 'text', text: 'You are an assistant for performing a web search tool use' }
    ],
    tools: [{ name: 'web_search' }],
    messages: [
      {
        role: 'user',
        content: 'Perform a web search for the query: last India England cricket match held'
      }
    ]
  },
  'msg_test'
);

assert.equal(webSearchHelperMessage.stop_reason, 'tool_use');
assert.deepEqual(webSearchHelperMessage.content[0], {
  type: 'tool_use',
  id: webSearchHelperMessage.content[0].id,
  name: 'web_search',
  input: { query: 'last India England cricket match held' }
});

const webSearchHistoryState = buildHistoryStateForAnthropic({
  model: 'Openai_Gpt Oss 20b',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_search',
          content: [
            {
              type: 'web_search_result',
              title: 'India beat England in fifth Test',
              url: 'https://example.test/scorecard',
              page_age: '2026-07-15',
              cited_text: 'India and England last met in the fifth Test at The Oval.'
            }
          ]
        }
      ]
    }
  ]
});

assert.match(webSearchHistoryState.query, /India beat England in fifth Test/);
assert.match(webSearchHistoryState.query, /https:\/\/example\.test\/scorecard/);
assert.match(webSearchHistoryState.query, /India and England last met/);

const compactedLegacyToolHistoryState = buildHistoryStateForAnthropic(
  {
    model: 'Openai_Gpt Oss 20b',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_big',
            content: 'a'.repeat(2000)
          }
        ]
      }
    ]
  },
  {
    compactToolResults: true,
    toolResultRawChars: 40,
    toolResultCompactChars: 500,
    toolResultCompactTargetChars: 80,
    toolResultSummaryTargetChars: 60
  }
);

assert.match(compactedLegacyToolHistoryState.query, /compacted tool result/);
assert.ok(compactedLegacyToolHistoryState.query.length < 600, 'compacts oversized tool results before hydration');

const rawDefaultToolHistoryState = buildHistoryStateForAnthropic(
  {
    model: 'Openai_Gpt Oss 20b',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_raw',
            content: 'b'.repeat(2000)
          }
        ]
      }
    ]
  },
  {
    toolResultRawChars: 40,
    toolResultCompactChars: 500,
    toolResultCompactTargetChars: 80,
    toolResultSummaryTargetChars: 60
  }
);

assert.doesNotMatch(rawDefaultToolHistoryState.query, /compacted tool result/, 'tool result compaction is opt-in');
assert.match(rawDefaultToolHistoryState.query, new RegExp(`b{${2000}}`), 'oversized tool results remain raw by default');

const limitedHistory = limitHistoryItemsForModelContext(
  [
    buildHistoryStateForAnthropic({ model: 'm', messages: [{ role: 'user', content: 'old'.repeat(40) }] }).historyItems[0],
    buildHistoryStateForAnthropic({ model: 'm', messages: [{ role: 'assistant', content: 'middle'.repeat(40) }] }).historyItems[0],
    buildHistoryStateForAnthropic({ model: 'm', messages: [{ role: 'user', content: 'latest' }] }).historyItems[0]
  ],
  120
);

assert.equal(limitedHistory[0].role, 'system');
assert.match(limitedHistory[0].content, /older conversation message/);
assert.match(limitedHistory.at(-1).content, /latest/);

const normalizedExternalSearchResults = extractSearchResultsFromValue({
  results: [
    {
      title: 'India vs England scorecard',
      url: 'https://example.test/india-england',
      snippet: 'India and England played most recently at The Oval.'
    }
  ]
});

assert.deepEqual(normalizedExternalSearchResults, [
  {
    title: 'India vs England scorecard',
    url: 'https://example.test/india-england',
    snippet: 'India and England played most recently at The Oval.'
  }
]);

const formattedSearchResults = formatWebSearchResults(
  'India England last match',
  normalizedExternalSearchResults,
  'external'
);

assert.match(formattedSearchResults, /Web search results for query: "India England last match"/);
assert.match(formattedSearchResults, /India vs England scorecard \(https:\/\/example\.test\/india-england\)/);
assert.match(formattedSearchResults, /Use the result titles and URLs above as markdown hyperlinks/);

const codexWebSearchHistory = buildHistoryStateForResponses({
  model: 'gpt-oss:20b',
  instructions: 'You are Codex.',
  tools: [{ type: 'web_search', external_web_access: true }],
  input: [{ role: 'user', content: 'Find the latest Apple stock price.' }]
}, {
  renderToolSchemas: true,
  toolSchemaPromptMaxChars: 24000
});
assert.match(codexWebSearchHistory.prompt, /"name": "web_search"/);
assert.match(codexWebSearchHistory.prompt, /Search the public web/);
assert.match(codexWebSearchHistory.prompt, /"required": \[\s*"query"\s*\]/);

assert.deepEqual(
  extractRequestedToolNames({ tool_names: ['exec_command', 'web_search'] }),
  ['exec_command', 'web_search'],
  'Responses web search is still detected when only normalized tool_names are available'
);

const codexWebSearchHydrate = buildResponsesWebSearchHydratedPayload({
  query: 'delta query that must not be used for recovery',
  retryHydratePayload: {
    prompt: 'Codex prompt',
    query: 'USER:\nFind the latest Apple stock price.',
    spilliContext: { transfer_mode: 'hydrate', context_revision: 2 },
    hydrateContext: { transfer_mode: 'hydrate', context_revision: 2 }
  }
}, 'Apple stock price', formattedSearchResults);
assert.equal(codexWebSearchHydrate.spilliContext.transfer_mode, 'hydrate');
assert.match(codexWebSearchHydrate.query, /USER:\nFind the latest Apple stock price/);
assert.match(codexWebSearchHydrate.query, /ASSISTANT TOOL CALL web_search/);
assert.match(codexWebSearchHydrate.query, /India vs England scorecard/);
assert.match(codexWebSearchHydrate.query, /Do not call web_search again/);

const codexPlainJsonArrayWebCalls = parseToolCallsFromOutput(
  'I will search for that.\n[{"id":"call_17z24j0958u310d76gk3w1f2","name":"web_search","arguments":{"query":"current Apple stock price AAPL"}}]\n',
  ['web_search']
);
assert.equal(codexPlainJsonArrayWebCalls.length, 1);
assert.equal(codexPlainJsonArrayWebCalls[0].id, 'call_17z24j0958u310d76gk3w1f2');
assert.equal(codexPlainJsonArrayWebCalls[0].name, 'web_search');
assert.equal(codexPlainJsonArrayWebCalls[0].input.query, 'current Apple stock price AAPL');

const codexHarmonyWebCalls = parseToolCallsFromOutput(
  '<|channel|>analysis<|message|>Need online info.<|end|><|start|>assistant<|channel|>commentary to=web_search <|constrain|>json<|message|>{"query":"latest Apple stock price"}',
  ['web_search']
);
assert.equal(codexHarmonyWebCalls.length, 1);
assert.equal(codexHarmonyWebCalls[0].name, 'web_search');
assert.equal(codexHarmonyWebCalls[0].input.query, 'latest Apple stock price');

const codexXmlWebCalls = parseToolCallsFromOutput(
  '<web_search>\n{"query": "latest Apple stock price"}\n</web_search>',
  ['web_search']
);
assert.equal(codexXmlWebCalls.length, 1);
assert.equal(codexXmlWebCalls[0].name, 'web_search');
assert.equal(codexXmlWebCalls[0].input.query, 'latest Apple stock price');

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
      { name: 'gguf:fastsha256:11f125', scope: 'public' },
      {
        name: 'Openai_Gpt_Oss_20b',
        display_name: 'Openai_Gpt Oss 20b',
        scope: 'public',
        allocation_protocol: 2,
        graph_v2: {
          compatibility_id: 'Openai_Gpt_Oss_20b:compat:test',
          total_layers: 24
        }
      }
    ]
  },
  { scope: 'public' }
);

assert.deepEqual(
  publicCatalogModels,
  [
    { uid: 'Named Public Model', displayName: 'Named Public Model' },
    { uid: 'gguf:sha256:abc123', displayName: 'Tiny Public Model' },
    { uid: 'gguf:fastsha256:11f125', displayName: 'gguf:fastsha256:11f125' },
    {
      uid: 'Openai_Gpt_Oss_20b',
      displayName: 'Openai_Gpt Oss 20b',
      allocationMetadata: {
        allocationProtocol: 2,
        graphV2: {
          compatibilityId: 'Openai_Gpt_Oss_20b:compat:test',
          totalLayers: 24
        }
      }
    }
  ],
  'normalizes backend public model catalog entries'
);

const mergedPublicModels = mergePublicModels(
  [
    { uid: 'gguf:sha256:abc123', displayName: 'tinygemma3-Q8_0.gguf', count: 1 },
    { uid: 'Host Public Model', displayName: 'Host Public Model', count: 2 },
    { uid: 'Openai_Gpt_Oss_20b', displayName: 'Openai_Gpt Oss 20b', count: 1 }
  ],
  publicCatalogModels
);

assert.deepEqual(
  mergedPublicModels,
  [
    { uid: 'gguf:sha256:abc123', displayName: 'tinygemma3-Q8_0.gguf', count: 1 },
    { uid: 'Host Public Model', displayName: 'Host Public Model', count: 2 },
    {
      uid: 'Openai_Gpt_Oss_20b',
      displayName: 'Openai_Gpt Oss 20b',
      count: 1,
      allocationMetadata: {
        allocationProtocol: 2,
        graphV2: {
          compatibilityId: 'Openai_Gpt_Oss_20b:compat:test',
          totalLayers: 24
        }
      }
    },
    { uid: 'Named Public Model', displayName: 'Named Public Model', count: 0 }
  ],
  'merges backend public catalog models with host inventory and drops unlabeled hashed catalog-only models'
);

const responseCatalogModels = mergedPublicModels.map(model => ({ ...model, apiName: model.displayName }));
const modelsResponse = buildModelsResponse({ models: responseCatalogModels });
assert.equal(modelsResponse.object, 'list', 'models response keeps OpenAI list object marker');
assert.equal(modelsResponse.data[0].object, 'model', 'models response keeps OpenAI model object marker');
assert.equal(modelsResponse.data[0].type, 'model', 'models response includes Anthropic model type marker');
assert.equal(modelsResponse.data[0].display_name, 'tinygemma3-Q8_0.gguf', 'models response includes Anthropic display name');
assert.equal(modelsResponse.data[0].created_at, '1970-01-01T00:00:00.000Z', 'models response includes Anthropic created_at');
assert.equal(modelsResponse.data[0].max_input_tokens, 0, 'models response includes Anthropic max_input_tokens');
assert.equal(modelsResponse.data[0].max_tokens, 0, 'models response includes Anthropic max_tokens');
assert.deepEqual(
  modelsResponse.data[0].capabilities.structured_outputs,
  { supported: false },
  'models response includes conservative Anthropic capabilities'
);
assert.equal(modelsResponse.first_id, 'tinygemma3-Q8_0.gguf', 'models response exposes first_id pagination marker');
assert.equal(modelsResponse.last_id, 'Named Public Model', 'models response exposes last_id pagination marker');

const claudeModelsResponse = buildModelsResponse(
  { models: responseCatalogModels },
  { claudeDiscovery: true }
);
assert.equal(
  claudeModelsResponse.data[0].id,
  'claude-spilli-dGlueWdlbW1hMy1ROF8wLmdndWY',
  'Claude discovery receives a picker-compatible reversible model id'
);
assert.equal(
  claudeModelsResponse.data[0].display_name,
  'tinygemma3-Q8_0.gguf',
  'Claude discovery preserves the SpiLLI display name'
);

const resolvedHashedModel = resolveModelFromCatalog('tinygemma3-Q8_0.gguf', {
  scope: 'public',
  models: responseCatalogModels
});
assert.equal(resolvedHashedModel.uid, 'gguf:sha256:abc123', 'display names resolve to the advertised resource hash');
assert.equal(
  resolveModelFromCatalog(claudeModelsResponse.data[0].id, {
    scope: 'public',
    models: responseCatalogModels
  }).uid,
  'gguf:sha256:abc123',
  'Claude discovery ids resolve back to the advertised resource hash'
);
assert.throws(
  () => resolveModelFromCatalog('gpt-unknown-alias', { scope: 'public', models: responseCatalogModels }),
  /Unknown model/,
  'unknown client model names are not silently redirected to another resource'
);

assert.deepEqual(
  buildResource(mergedPublicModels.find(model => model.uid === 'Openai_Gpt_Oss_20b'), { scope: 'public' }),
  {
    model: 'Openai_Gpt_Oss_20b',
    scope: 'public',
    allocation_protocol: 2,
    graph_v2: {
      compatibility_id: 'Openai_Gpt_Oss_20b:compat:test',
      total_layers: 24
    }
  },
  'merged V2 aggregate model still builds a graph-v2 allocation resource'
);

const v2Resource = buildResource(
  {
    uid: 'gguf:sha256:abc123',
    allocationMetadata: {
      allocationProtocol: 2,
      graphV2: {
        compatibilityId: 'graph-abc',
        totalLayers: 80,
        vertexType: 'transformer'
      }
    }
  },
  { scope: 'public' }
);

assert.deepEqual(
  v2Resource,
  {
    model: 'gguf:sha256:abc123',
    scope: 'public',
    allocation_protocol: 2,
    graph_v2: {
      compatibility_id: 'graph-abc',
      total_layers: 80,
      vertex_type: 'transformer'
    }
  },
  'builds a v2 SpiLLI resource when catalog metadata reports fragmented graph placement'
);

assert.notEqual(
  resourceCacheKey({ model: 'same', scope: 'public' }),
  resourceCacheKey(v2Resource),
  'resource cache keys differ between plain full-model and v2 fragmented allocations'
);

const preferredV2Aggregate = selectPreferredDisplayMatch([
  {
    uid: 'Openai_Gpt_Oss_20b',
    displayName: 'Openai_Gpt Oss 20b',
    apiName: 'Openai_Gpt Oss 20b [Openai_Gpt_Oss_20b]',
    allocationMetadata: {
      allocationProtocol: 2,
      graphV2: { compatibilityId: 'Openai_Gpt_Oss_20b:compat:test', totalLayers: 24 }
    }
  },
  {
    uid: 'gguf:fastsha256:1226b754fe7de2a5f334a00a147fbeb9cb3212ffae82cce5595a32702bba87c0',
    displayName: 'Openai_Gpt Oss 20b',
    apiName: 'Openai_Gpt Oss 20b [gguf:fastsha256:1226b754fe7de2a5f334a00a147fbeb9cb3212ffae82cce5595a32702bba87c0]'
  }
]);
assert.equal(
  preferredV2Aggregate?.uid,
  'Openai_Gpt_Oss_20b',
  'display-name resolution prefers the V2 aggregate over raw GGUF fragment hashes'
);

const queuedOrder = [];
const queuedResource = { model: 'queued-model', scope: 'public' };
const firstQueued = withResourceRunQueue(queuedResource, async () => {
  queuedOrder.push('first:start');
  await new Promise(resolve => setTimeout(resolve, 20));
  queuedOrder.push('first:end');
});
const secondQueued = withResourceRunQueue(queuedResource, async () => {
  queuedOrder.push('second:start');
  queuedOrder.push('second:end');
});
await Promise.all([firstQueued, secondQueued]);
assert.deepEqual(queuedOrder, ['first:start', 'first:end', 'second:start', 'second:end']);

const rejectedQueueResource = { model: 'rejected-queued-model', scope: 'public' };
await assert.rejects(
  withResourceRunQueue(rejectedQueueResource, async () => {
    throw new Error('expected queue failure');
  }),
  /expected queue failure/
);
const recoveredAfterReject = [];
await withResourceRunQueue(rejectedQueueResource, async () => {
  recoveredAfterReject.push('recovered');
});
assert.deepEqual(recoveredAfterReject, ['recovered'], 'resource queue recovers after a rejected operation');

const liveSession = { isLive: () => true };
const resourceKey = 'model|public|';

const firstAnthropicHistory = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'Be concise.',
  messages: [{ role: 'user', content: 'Hello' }]
});
const firstPrepared = prepareSessionRunPayload(firstAnthropicHistory, undefined, resourceKey);
assert.equal(firstPrepared.reused, false, 'first request creates a full-history run');
assert.equal(firstAnthropicHistory.prompt, 'Be concise.', 'Anthropic prompt only contains caller-provided system text');
assert.equal(firstPrepared.payload.prompt, firstAnthropicHistory.prompt);
assert.equal(firstPrepared.payload.query, 'USER:\nHello');
assert.deepEqual(firstPrepared.hydrationItems, [], 'the current first-turn query is not duplicated in hydration history');

const anthropicHistoryWithTools = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'Caller supplied system prompt.',
  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'Use the tool if needed' }]
});
assert.equal(
  anthropicHistoryWithTools.prompt,
  'Caller supplied system prompt.',
  'Anthropic tool declarations are not appended to the SpiLLI prompt'
);

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
assert.equal(secondPrepared.payload.prompt, 'Be concise.', 'the system prompt remains available while chat history is delta-transferred');
assert.equal(
  secondPrepared.payload.query,
  'USER:\nNext question',
  'append-only request sends only the new user suffix'
);
assert.equal(secondPrepared.hydrationItems.length, 2, 'delta preparation retains prior messages for context-miss hydration retry');

const rewrittenPrepared = prepareSessionRunPayload(secondAnthropicHistory, undefined, resourceKey);
assert.equal(rewrittenPrepared.transferMode, 'hydrate');
assert.equal(rewrittenPrepared.payload.query, 'USER:\nNext question');
assert.equal(rewrittenPrepared.hydrationItems.length, 2, 'fresh hydration contains prior messages only');
assert.equal(rewrittenPrepared.hydrationItems[0].content, 'Hello');
assert.equal(rewrittenPrepared.hydrationItems[1].content, 'Hi there');

const claudeBaseIdentity = {
  key: 'claude:shared-session',
  windowId: 'claude-code',
  sessionId: 'shared-session',
  contextId: 'claude-context-base'
};
const claudeSubagentHistory = buildHistoryStateForAnthropic({
  model: 'spilli-test',
  system: 'You are a Claude Code subagent.',
  messages: [{ role: 'user', content: 'Search the repository' }]
});
const parentClaudeIdentity = specializeSessionIdentityForHistory(claudeBaseIdentity, firstAnthropicHistory);
const subagentClaudeIdentity = specializeSessionIdentityForHistory(claudeBaseIdentity, claudeSubagentHistory);
assert.notEqual(
  parentClaudeIdentity.key,
  subagentClaudeIdentity.key,
  'Claude requests with different prompt fingerprints use separate logical session keys'
);
assert.notEqual(
  parentClaudeIdentity.contextId,
  subagentClaudeIdentity.contextId,
  'Claude requests with different prompt fingerprints use separate SpiLLI context ids'
);
const claudeReq = { headers: { 'x-claude-code-session-id': 'shared-session' } };
assert.equal(
  getLeaseKindForRequest(claudeReq, { system: 'You are a Claude Code subagent.' }),
  'ephemeral',
  'Claude Code subagent prompts are classified as ephemeral KV leases'
);
assert.equal(
  getLeaseKindForRequest({ headers: { 'x-claude-code-session-id': 'shared-session', 'x-anthropic-billing-header': 'cc_is_subagent=true' } }, {}),
  'ephemeral',
  'Claude Code subagent billing headers are classified as ephemeral KV leases'
);
assert.equal(
  getLeaseKindForRequest(claudeReq, {
    system: 'Generate a concise, sentence-case title (3-7 words). Return JSON with a single "title" field.'
  }),
  'ephemeral',
  'Claude Code title-generation utility requests are classified as ephemeral KV leases'
);
assert.equal(
  getLeaseKindForRequest(claudeReq, { system: 'Main Claude Code session.' }),
  'durable',
  'normal Claude sessions are classified as durable KV leases'
);
assert.deepEqual(
  buildSpilliContextReleaseControl({
    identity: {
      windowId: 'claude-code',
      sessionId: 'shared-session',
      contextId: subagentClaudeIdentity.contextId
    },
    resourceKey,
    revision: 3,
    leaseKind: 'ephemeral',
    clientKind: 'claude'
  }, 'subagent_complete'),
  {
    version: 1,
    action: 'release',
    context_id: subagentClaudeIdentity.contextId,
    resource_key: resourceKey,
    window_id: 'claude-code',
    session_id: 'shared-session',
    context_revision: 3,
    reason: 'subagent_complete',
    lease_kind: 'ephemeral',
    client_kind: 'claude'
  },
  'release controls serialize the host KV release contract'
);
assert.equal(
  specializeSessionIdentityForHistory({ key: 'codex:a:b:c', windowId: 'w', sessionId: 's', contextId: 'c' }, secondAnthropicHistory).key,
  'codex:a:b:c',
  'non-Claude clients keep their explicit context identity'
);

const modernCodexRequest = {
  headers: {
    'session-id': 'session-modern',
    'thread-id': 'thread-modern'
  }
};
const modernCodexIdentity = getCodexSessionIdentity(modernCodexRequest);
assert.equal(modernCodexIdentity.windowId, 'codex');
assert.equal(modernCodexIdentity.sessionId, 'session-modern');
assert.match(modernCodexIdentity.key, /^codex:/);
assert.match(modernCodexIdentity.contextId, /^codex-context-/);
assert.equal(isCodexUtilityRequest(modernCodexRequest), false, 'normal Codex threads are not utility requests');

const codexSystemUtilityRequest = {
  headers: {
    'session-id': 'session-system',
    'thread-id': 'thread-system',
    'x-codex-turn-metadata': JSON.stringify({ thread_source: 'system' })
  }
};
assert.equal(
  isCodexUtilityRequest(codexSystemUtilityRequest),
  true,
  'Codex system threads are classified as utility requests'
);
assert.equal(
  getLeaseKindForRequest(codexSystemUtilityRequest),
  'ephemeral',
  'Codex system utilities use ephemeral KV leases'
);

const legacyCodexIdentity = getCodexSessionIdentity({
  headers: {
    'x-codex-turn-metadata': JSON.stringify({
      window_id: 'window-legacy',
      session_id: 'session-legacy',
      thread_id: 'thread-legacy'
    })
  }
});
assert.equal(legacyCodexIdentity.windowId, 'window-legacy');
assert.equal(legacyCodexIdentity.sessionId, 'session-legacy');

const codexSubagentRequest = {
  headers: {
    'session-id': 'session-modern',
    'thread-id': 'thread-modern',
    'x-openai-subagent': 'compact',
    'x-codex-turn-metadata': JSON.stringify({ turn_id: 'child-turn-1' })
  }
};
const codexSubagentIdentity = specializeSessionIdentityForHistory(
  getCodexSessionIdentity(codexSubagentRequest),
  secondAnthropicHistory,
  codexSubagentRequest
);
assert.notEqual(codexSubagentIdentity.key, modernCodexIdentity.key, 'Codex subagents use isolated bridge session keys');
assert.notEqual(codexSubagentIdentity.contextId, modernCodexIdentity.contextId, 'Codex subagents use isolated host contexts');
assert.equal(getLeaseKindForRequest(codexSubagentRequest), 'ephemeral', 'Codex subagent contexts use ephemeral leases');
const concurrentCodexSubagentRequest = {
  headers: {
    ...codexSubagentRequest.headers,
    'x-codex-turn-metadata': JSON.stringify({ turn_id: 'child-turn-2' })
  }
};
const concurrentCodexSubagentIdentity = specializeSessionIdentityForHistory(
  getCodexSessionIdentity(concurrentCodexSubagentRequest),
  secondAnthropicHistory,
  concurrentCodexSubagentRequest
);
assert.notEqual(
  concurrentCodexSubagentIdentity.contextId,
  codexSubagentIdentity.contextId,
  'concurrent Codex subagent turns with the same label remain isolated'
);

const genericIdentity = getGenericSessionIdentity({ headers: { 'x-spilli-session-id': 'generic-chat' } });
assert.match(genericIdentity.key, /^spilli:/);
assert.match(genericIdentity.contextId, /^spilli-context-/);

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
assert.equal(promptChangedPrepared.payload.query, 'USER:\nNext question');
assert.equal(promptChangedPrepared.hydrationItems.length, 2);

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
assert.equal(compactedPrepared.payload.query, 'USER:\nContinue from there');
assert.equal(compactedPrepared.hydrationItems.length, 1);

const smallToolResultHistory = buildHistoryStateForAnthropic(
  {
    model: 'spilli-test',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_small',
            content: 'short output'
          }
        ]
      }
    ]
  },
  {
    compactToolResults: true,
    toolResultRawChars: 20,
    toolResultCompactChars: 80,
    toolResultCompactTargetChars: 60,
    toolResultSummaryTargetChars: 40
  }
);
assert.match(smallToolResultHistory.query, /short output/, 'small tool outputs remain raw');
assert.doesNotMatch(smallToolResultHistory.query, /compacted tool result/, 'small tool outputs are not compacted');

const grepToolResult = Array.from({ length: 20 }, (_, index) =>
  `src/file${index % 4}.mjs:${index + 1}: contains spilli sdk usage ${index}`
).join('\n');
const compactedToolResultHistory = buildHistoryStateForAnthropic(
  {
    model: 'spilli-test',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_grep',
            content: grepToolResult
          }
        ]
      }
    ]
  },
  {
    compactToolResults: true,
    toolResultRawChars: 40,
    toolResultCompactChars: 2000,
    toolResultCompactTargetChars: 500,
    toolResultSummaryTargetChars: 200
  }
);
assert.match(compactedToolResultHistory.query, /mode=deterministic/, 'medium tool outputs use deterministic compaction');
assert.match(compactedToolResultHistory.query, /Matched 20 lines across 4 files/, 'grep-like compaction keeps match/file summary');

const hugeToolResultHistory = buildHistoryStateForAnthropic(
  {
    model: 'spilli-test',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_huge',
            content: Array.from({ length: 80 }, (_, index) => `logs/output.txt:${index + 1}: repeated diagnostic line`).join('\n')
          }
        ]
      }
    ]
  },
  {
    compactToolResults: true,
    toolResultRawChars: 40,
    toolResultCompactChars: 400,
    toolResultCompactTargetChars: 300,
    toolResultSummaryTargetChars: 180,
    toolResultSummarizerEndpoint: 'http://localhost:9999/summarize'
  }
);
assert.match(
  hugeToolResultHistory.query,
  /mode=summarizer-recommended deterministic pre-summary/,
  'very large tool outputs are marked for summarizer-style compaction'
);
assert.match(
  hugeToolResultHistory.query,
  /Summarizer endpoint configured: http:\/\/localhost:9999\/summarize/,
  'configured summarizer endpoint is surfaced in the compacted context envelope'
);

const openAiChatHistory = buildHistoryStateForOpenAiChat({
  model: 'spilli-test',
  tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup data' } }],
  messages: [
    { role: 'system', content: 'System stays in the prompt.' },
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
    { role: 'user', content: 'Follow up' }
  ]
});
assert.equal(openAiChatHistory.historyItems.length, 3, 'OpenAI chat history excludes system messages');
assert.equal(
  openAiChatHistory.prompt,
  'System stays in the prompt.',
  'OpenAI chat prompt excludes bridge-generated tool context'
);

const responsesArrayHistory = buildHistoryStateForResponses({
  model: 'spilli-test',
  instructions: 'Prefer short answers.',
  tools: [{ type: 'function', name: 'lookup', description: 'Lookup data' }],
  input: [
    { role: 'developer', content: [{ type: 'input_text', text: 'Hidden instruction' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Visible question' }] }
  ]
});
assert.equal(responsesArrayHistory.allowDelta, true, 'Responses array input can use append-only deltas');
assert.equal(responsesArrayHistory.query, 'USER:\nVisible question');
assert.match(responsesArrayHistory.prompt, /Hidden instruction/);
assert.doesNotMatch(responsesArrayHistory.prompt, /Available tools|lookup/, 'Responses prompt excludes bridge-generated tool context');

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
