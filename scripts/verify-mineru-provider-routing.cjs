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

function createSharpStub(input, _options) {
  return {
    png() {
      return this;
    },
    async toBuffer() {
      return Buffer.isBuffer(input) ? input : Buffer.from(input);
    },
  };
}

function createLoggerStub() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
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

  const module = { exports: {} };
  moduleCache.set(resolved, module);
  const dirname = path.dirname(resolved);

  function sandboxRequire(specifier) {
    if (specifier === 'jszip') return JSZip;
    if (specifier === 'sharp') return createSharpStub;
    if (specifier === 'unpdf') {
      return {
        extractText: async () => ({ text: 'unused' }),
        getDocumentProxy: async () => ({ numPages: 0 }),
        extractImages: async () => [],
      };
    }
    if (specifier === '@/lib/logger') {
      return {
        createLogger: createLoggerStub,
      };
    }
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
  fn(sandboxRequire, module, module.exports, resolved, dirname);
  return module.exports;
}

async function buildFixtureZip() {
  const zip = new JSZip();
  zip.file('full.md', '# Hosted MinerU\n\n![figure](images/figure-1.png)\n');
  zip.file(
    'result_content_list.json',
    JSON.stringify([
      {
        type: 'image',
        img_path: 'images/figure-1.png',
        image_caption: ['Hosted figure'],
        bbox: [10, 20, 110, 120],
        page_idx: 0,
      },
    ]),
  );
  zip.file('images/figure-1.png', Buffer.from('fake-png-bytes'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  const pdfProvidersPath = path.join(repoRoot, 'lib', 'pdf', 'pdf-providers.ts');
  const { parsePDF } = loadTsModule(pdfProvidersPath);

  const fixtureArchive = await buildFixtureZip();
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });

    if (String(url).endsWith('/file-urls/batch')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            batch_id: 'batch-123',
            file_urls: ['https://upload.example.com/document.pdf'],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (String(url) === 'https://upload.example.com/document.pdf') {
      return new Response(null, { status: 200 });
    }

    if (String(url).includes('/extract-results/batch/batch-123')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            extract_result: {
              state: 'done',
              full_zip_url: 'https://download.example.com/full.zip',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (String(url) === 'https://download.example.com/full.zip') {
      return new Response(fixtureArchive, { status: 200 });
    }

    throw new Error(`Unexpected fetch call: ${String(url)}`);
  };

  try {
    const parsed = await parsePDF(
      {
        providerId: 'mineru',
        apiKey: 'test-key',
      },
      Buffer.from('%PDF-1.4 fake pdf'),
    );

    assert.equal(parsed.metadata?.parser, 'mineru');
    assert.equal(parsed.metadata?.pageCount, 1);
    assert.equal(parsed.metadata?.pdfImages?.[0]?.description, 'Hosted figure');
    assert.equal(parsed.metadata?.imageMapping?.img_1, parsed.images[0]);
    assert.equal(
      calls.some(({ url }) => url.endsWith('/file-urls/batch')),
      true,
      'Hosted MinerU flow should request an upload batch',
    );

    console.log('MinerU provider hosted routing verification passed.');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
