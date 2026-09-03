const DEFAULT_MODEL = 'onnx-community/all-MiniLM-L6-v2-ONNX';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_MAX_INPUT_CHARS = 32_000;

let extractorPromise;
let extractorKey;

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function embeddingConfigFromEnv(env = process.env) {
  const backend = String(env.SPILLI_BRIDGE_EMBEDDING_BACKEND ?? 'disabled').trim().toLowerCase();
  return {
    backend,
    model: String(env.SPILLI_BRIDGE_EMBEDDING_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    dimensions: positiveInteger(env.SPILLI_BRIDGE_EMBEDDING_DIMENSIONS, DEFAULT_DIMENSIONS),
    maxBatchSize: positiveInteger(env.SPILLI_BRIDGE_EMBEDDING_MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE),
    maxInputChars: positiveInteger(env.SPILLI_BRIDGE_EMBEDDING_MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS),
    threads: positiveInteger(env.SPILLI_BRIDGE_EMBEDDING_THREADS, 2),
    dtype: String(env.SPILLI_BRIDGE_EMBEDDING_DTYPE ?? 'fp32').trim() || 'fp32',
    cacheDir: String(env.SPILLI_BRIDGE_EMBEDDING_CACHE_DIR ?? '').trim()
  };
}

export function normalizeEmbeddingRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('Embedding request body must be a JSON object.');
  }
  if (config.backend !== 'local') {
    throw requestError(
      'Local embeddings are disabled. Set SPILLI_BRIDGE_EMBEDDING_BACKEND=local.',
      503
    );
  }

  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (requestedModel && requestedModel !== config.model) {
    throw requestError(`Unknown embedding model "${requestedModel}". Configured model: "${config.model}".`, 404);
  }
  if (body.encoding_format !== undefined && body.encoding_format !== 'float') {
    throw requestError('Only encoding_format="float" is supported by the local embedding backend.');
  }
  if (body.dimensions !== undefined) {
    const requestedDimensions = positiveInteger(body.dimensions, 0);
    if (requestedDimensions !== config.dimensions) {
      throw requestError(
        `Embedding model "${config.model}" has fixed dimensions=${config.dimensions}; requested ${body.dimensions}.`
      );
    }
  }

  const input = typeof body.input === 'string' ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length === 0 || input.some(value => typeof value !== 'string')) {
    throw requestError('input must be a non-empty string or an array of strings. Token-array input is not supported.');
  }
  if (input.length > config.maxBatchSize) {
    throw requestError(`Embedding batch exceeds the configured maximum of ${config.maxBatchSize} inputs.`, 413);
  }
  for (const text of input) {
    if (text.length > config.maxInputChars) {
      throw requestError(
        `Embedding input exceeds the configured maximum of ${config.maxInputChars} characters.`,
        413
      );
    }
  }
  return { input, model: config.model };
}

async function getLocalExtractor(config) {
  const key = JSON.stringify([config.model, config.dtype, config.cacheDir, config.threads]);
  if (!extractorPromise || extractorKey !== key) {
    extractorKey = key;
    extractorPromise = import('@huggingface/transformers').then(async ({ env, pipeline }) => {
      if (config.cacheDir) {
        env.cacheDir = config.cacheDir;
      }
      return pipeline('feature-extraction', config.model, {
        device: 'cpu',
        dtype: config.dtype,
        session_options: {
          intraOpNumThreads: config.threads,
          interOpNumThreads: 1
        }
      });
    });
    extractorPromise.catch(() => {
      if (extractorKey === key) {
        extractorPromise = undefined;
        extractorKey = undefined;
      }
    });
  }
  return extractorPromise;
}

async function embedLocally(input, config) {
  const extractor = await getLocalExtractor(config);
  const tensor = await extractor(input, { pooling: 'mean', normalize: true });
  return tensor.tolist();
}

export async function createEmbeddingResponse(body, config, embed = embedLocally) {
  const request = normalizeEmbeddingRequest(body, config);
  const vectors = await embed(request.input, config);
  if (!Array.isArray(vectors) || vectors.length !== request.input.length) {
    throw requestError('Local embedding model returned an invalid batch shape.', 502);
  }
  vectors.forEach((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== config.dimensions || vector.some(value => !Number.isFinite(value))) {
      throw requestError(
        `Local embedding model returned an invalid vector at index ${index}; expected ${config.dimensions} finite values.`,
        502
      );
    }
  });

  const estimatedTokens = request.input.reduce((total, text) => total + Math.max(1, Math.ceil(text.length / 4)), 0);
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: request.model,
    usage: { prompt_tokens: estimatedTokens, total_tokens: estimatedTokens }
  };
}
