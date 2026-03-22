/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ts = require('typescript');
const JSZip = require('jszip');

const repoRoot = path.resolve(__dirname, '..');
const moduleCache = new Map();

function resolveRepoTsPath(specifier, fromFile) {
  const candidates = [];

  if (specifier.startsWith('@/')) {
    const rel = specifier.slice(2);
    candidates.push(path.join(repoRoot, `${rel}.ts`));
    candidates.push(path.join(repoRoot, `${rel}.tsx`));
    candidates.push(path.join(repoRoot, `${rel}.js`));
    candidates.push(path.join(repoRoot, rel, 'index.ts'));
    candidates.push(path.join(repoRoot, rel, 'index.tsx'));
  } else if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    candidates.push(base);
    candidates.push(`${base}.ts`);
    candidates.push(`${base}.tsx`);
    candidates.push(`${base}.js`);
    candidates.push(path.join(base, 'index.ts'));
    candidates.push(path.join(base, 'index.tsx'));
    candidates.push(path.join(base, 'index.js'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function loadTsModule(absPath) {
  const resolved = path.resolve(absPath);
  if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;

  const source = fs.readFileSync(resolved, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
    fileName: resolved,
  });

  const loadedModule = { exports: {} };
  moduleCache.set(resolved, loadedModule);
  const dirname = path.dirname(resolved);

  function sandboxRequire(specifier) {
    if (specifier === 'jszip') return JSZip;
    if (specifier === 'node:assert/strict') return assert;
    if (specifier.startsWith('@/') || specifier.startsWith('.')) {
      const linked = resolveRepoTsPath(specifier, resolved);
      if (!linked) throw new Error(`Unable to resolve module "${specifier}" from ${resolved}`);
      return loadTsModule(linked);
    }

    return require(specifier);
  }

  const wrapper = new vm.Script(
    `(function (require, module, exports, __filename, __dirname) {\n${transpiled.outputText}\n})`,
    { filename: resolved },
  );
  const fn = wrapper.runInThisContext();
  fn(sandboxRequire, loadedModule, loadedModule.exports, resolved, dirname);
  return loadedModule.exports;
}

async function withCapturedTimeouts(run) {
  const originalFetch = global.fetch;
  const originalTimeout = AbortSignal.timeout;
  const captured = [];

  AbortSignal.timeout = (ms) => {
    captured.push(ms);
    return { timeoutMs: ms };
  };

  global.fetch = async (_input, _init = {}) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      code: 0,
      data: {
        batch_id: 'batch-1',
        file_urls: ['https://upload.example.com/file.pdf'],
        extract_result: {
          state: 'done',
          full_zip_url: 'https://download.example.com/result.zip',
        },
      },
    }),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });

  try {
    await run();
  } finally {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }

  return captured;
}

async function main() {
  const helperPath = path.join(repoRoot, 'lib', 'pdf', 'mineru-hosted.ts');
  const helper = loadTsModule(helperPath);

  assert.equal(helper.MINERU_BATCH_REQUEST_TIMEOUT_MS, 2 * 60_000);
  assert.equal(helper.MINERU_STATUS_REQUEST_TIMEOUT_MS, 2 * 60_000);
  assert.equal(helper.MINERU_FILE_TRANSFER_TIMEOUT_MS, 15 * 60_000);
  assert.equal(helper.MINERU_POLL_TIMEOUT_MS, 20 * 60_000);

  const batchTimeouts = await withCapturedTimeouts(async () => {
    await helper.createMinerUUploadBatch({
      apiKey: 'key',
      fileName: 'sample.pdf',
    });
  });
  assert.deepEqual(batchTimeouts, [helper.MINERU_BATCH_REQUEST_TIMEOUT_MS]);

  const uploadTimeouts = await withCapturedTimeouts(async () => {
    await helper.uploadFileToMinerU(
      'https://upload.example.com/file.pdf',
      Buffer.from('pdf'),
      'application/pdf',
    );
  });
  assert.deepEqual(uploadTimeouts, [helper.MINERU_FILE_TRANSFER_TIMEOUT_MS]);

  const pollTimeouts = await withCapturedTimeouts(async () => {
    await helper.pollMinerUBatchResult({
      apiKey: 'key',
      batchId: 'batch-1',
      pollIntervalMs: 0,
    });
  });
  assert.deepEqual(pollTimeouts, [helper.MINERU_STATUS_REQUEST_TIMEOUT_MS]);

  const downloadTimeouts = await withCapturedTimeouts(async () => {
    await helper.downloadMinerUArchive('https://download.example.com/result.zip');
  });
  assert.deepEqual(downloadTimeouts, [helper.MINERU_FILE_TRANSFER_TIMEOUT_MS]);

  console.log('MinerU hosted timeout verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
