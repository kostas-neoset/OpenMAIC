const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const moduleCache = new Map();

function resolveRepoTsPath(specifier, fromFile) {
  const candidates = [];

  if (specifier.startsWith('@/')) {
    const rel = specifier.slice(2);
    candidates.push(path.join(repoRoot, `${rel}.ts`));
    candidates.push(path.join(repoRoot, `${rel}.tsx`));
    candidates.push(path.join(repoRoot, rel, 'index.ts'));
    candidates.push(path.join(repoRoot, rel, 'index.tsx'));
  } else if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    candidates.push(base);
    candidates.push(`${base}.ts`);
    candidates.push(`${base}.tsx`);
    candidates.push(path.join(base, 'index.ts'));
    candidates.push(path.join(base, 'index.tsx'));
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

  const module = { exports: {} };
  moduleCache.set(resolved, module);
  const dirname = path.dirname(resolved);

  function sandboxRequire(specifier) {
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

async function main() {
  const modulePath = path.join(repoRoot, 'lib', 'generation', 'request-payloads.ts');
  const {
    buildOutlineRequestPayload,
    buildSceneContentRequestPayload,
    readApiErrorMessage,
  } = loadTsModule(modulePath);

  const pdfImages = [
    { id: 'img_1', pageNumber: 1 },
    { id: 'img_2', pageNumber: 2 },
    { id: 'img_3', pageNumber: 3 },
  ];
  const imageMapping = {
    img_1: 'data:image/png;base64,AAAA',
    img_2: 'data:image/png;base64,BBBB',
    img_3: 'data:image/png;base64,CCCC',
  };

  const outlinePayload = buildOutlineRequestPayload({
    requirements: { requirement: 'Teach me this PDF', language: 'en-US' },
    pdfText: 'hello',
    pdfImages,
    imageMapping,
    visionImageLimit: 2,
    researchContext: 'context',
    agents: [{ id: 'teacher', name: 'Teacher', role: 'teacher' }],
  });

  assert.deepEqual(
    Object.keys(outlinePayload.imageMapping),
    ['img_1', 'img_2'],
    'Outline request should only include the first vision image mappings',
  );
  assert.equal(outlinePayload.pdfImages.length, 3, 'Outline request should keep all image metadata');

  const scenePayload = buildSceneContentRequestPayload({
    outline: { id: 'outline-1', suggestedImageIds: ['img_2'] },
    allOutlines: [{ id: 'outline-1' }],
    pdfImages,
    imageMapping,
    stageInfo: { name: 'Stage' },
    stageId: 'stage-1',
    agents: [{ id: 'teacher', name: 'Teacher', role: 'teacher' }],
  });

  assert.deepEqual(
    scenePayload.pdfImages.map((img) => img.id),
    ['img_2'],
    'Scene content request should only include images assigned to the outline',
  );
  assert.deepEqual(
    scenePayload.imageMapping,
    { img_2: 'data:image/png;base64,BBBB' },
    'Scene content request should only include mappings for assigned images',
  );

  const payloadTooLargeMessage = await readApiErrorMessage(
    new Response('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE', {
      status: 413,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
    'Fallback message',
  );
  assert.match(
    payloadTooLargeMessage,
    /too much PDF image data/i,
    '413 payload errors should become a friendly explanation',
  );

  const jsonErrorMessage = await readApiErrorMessage(
    new Response(JSON.stringify({ error: 'Structured error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }),
    'Fallback message',
  );
  assert.equal(jsonErrorMessage, 'Structured error');

  console.log('Generation payload guards verified.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
