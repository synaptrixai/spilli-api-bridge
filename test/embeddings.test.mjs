import assert from 'node:assert/strict';

import {
  createEmbeddingResponse,
  embeddingConfigFromEnv,
  normalizeEmbeddingRequest
} from '../src/embeddings.mjs';

const config = embeddingConfigFromEnv({
  SPILLI_BRIDGE_EMBEDDING_BACKEND: 'local',
  SPILLI_BRIDGE_EMBEDDING_MODEL: 'test-embedding-model',
  SPILLI_BRIDGE_EMBEDDING_DIMENSIONS: '3',
  SPILLI_BRIDGE_EMBEDDING_MAX_BATCH_SIZE: '2',
  SPILLI_BRIDGE_EMBEDDING_MAX_INPUT_CHARS: '20'
});

assert.deepEqual(
  normalizeEmbeddingRequest({ input: 'hello', model: 'test-embedding-model' }, config),
  { input: ['hello'], model: 'test-embedding-model' }
);
assert.throws(
  () => normalizeEmbeddingRequest({ input: ['one', 'two', 'three'] }, config),
  error => error.statusCode === 413 && /batch exceeds/.test(error.message)
);
assert.throws(
  () => normalizeEmbeddingRequest({ input: 'hello', model: 'another-model' }, config),
  error => error.statusCode === 404 && /Unknown embedding model/.test(error.message)
);
assert.throws(
  () => normalizeEmbeddingRequest({ input: 'hello', dimensions: 2 }, config),
  /fixed dimensions=3/
);
assert.throws(
  () => normalizeEmbeddingRequest({ input: 'hello', encoding_format: 'base64' }, config),
  /encoding_format="float"/
);

const response = await createEmbeddingResponse(
  { input: ['hello', 'world'], model: 'test-embedding-model' },
  config,
  async input => input.map((_, index) => [index + 0.1, index + 0.2, index + 0.3])
);
assert.deepEqual(response, {
  object: 'list',
  data: [
    { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
    { object: 'embedding', index: 1, embedding: [1.1, 1.2, 1.3] }
  ],
  model: 'test-embedding-model',
  usage: { prompt_tokens: 4, total_tokens: 4 }
});

await assert.rejects(
  createEmbeddingResponse({ input: 'hello' }, config, async () => [[1, 2]]),
  error => error.statusCode === 502 && /expected 3 finite values/.test(error.message)
);

console.log('embedding tests passed');
