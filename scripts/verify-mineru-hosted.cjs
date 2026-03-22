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

  const module = { exports: {} };
  moduleCache.set(resolved, module);
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
  fn(sandboxRequire, module, module.exports, resolved, dirname);
  return module.exports;
}

async function buildFixtureZip() {
  const zip = new JSZip();
  zip.file(
    'full.md',
    '# Mineral lesson\n\nThis is a MinerU archive fixture.\n\n![figure](images/img_1.png)\n',
  );
  zip.file(
    'sample_content_list.json',
    JSON.stringify(
      [
        {
          type: 'text',
          text: 'MinerU archive fixture',
          text_level: 1,
          bbox: [0, 0, 100, 20],
          page_idx: 0,
        },
        {
          type: 'image',
          img_path: 'images/img_1.png',
          image_caption: ['Figure 1'],
          bbox: [10, 20, 110, 120],
          page_idx: 0,
        },
      ],
      null,
      2,
    ),
  );
  zip.file('images/img_1.png', Buffer.from('fake-png-bytes'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  const helperPath = path.join(repoRoot, 'lib', 'pdf', 'mineru-hosted.ts');
  const helper = loadTsModule(helperPath);

  assert.equal(helper.MINERU_OFFICIAL_API_ROOT, 'https://mineru.net/api/v4');
  assert.equal(helper.isMinerUHostedConfig({ providerId: 'mineru' }), true);
  assert.equal(
    helper.isMinerUHostedConfig({ providerId: 'mineru', baseUrl: 'https://mineru.net/api/v4' }),
    true,
  );
  assert.equal(
    helper.isMinerUHostedConfig({ providerId: 'mineru', baseUrl: 'http://localhost:8080/file_parse' }),
    false,
  );

  const archive = await buildFixtureZip();
  const parsed = await helper.parseMinerUArchive(archive);

  assert.equal(parsed.text.includes('MinerU archive fixture'), true);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].startsWith('data:image/png;base64,'), true);
  assert.equal(parsed.metadata.pageCount, 1);
  assert.equal(parsed.metadata.parser, 'mineru');
  assert.equal(parsed.metadata.imageMapping.img_1, parsed.images[0]);
  assert.equal(parsed.metadata.pdfImages.length, 1);
  assert.equal(parsed.metadata.pdfImages[0].pageNumber, 1);
  assert.equal(parsed.metadata.pdfImages[0].description, 'Figure 1');

  console.log('MinerU hosted helper verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
