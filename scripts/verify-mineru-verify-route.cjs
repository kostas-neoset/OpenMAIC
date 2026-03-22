const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const moduleCache = new Map();
let hostedCheckCalls = 0;

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
    if (specifier === 'next/server') {
      return { NextRequest: class NextRequest {} };
    }
    if (specifier === '@/lib/logger') {
      return {
        createLogger: () => ({
          info() {},
          warn() {},
          error() {},
        }),
      };
    }
    if (specifier === '@/lib/server/api-response') {
      return {
        apiSuccess: (data) => ({ success: true, ...data }),
        apiError: (code, status, message) => ({ success: false, code, status, error: message }),
      };
    }
    if (specifier === '@/lib/server/provider-config') {
      return {
        resolvePDFApiKey: (_providerId, clientKey) => clientKey || '',
        resolvePDFBaseUrl: (_providerId, clientBaseUrl) => clientBaseUrl,
      };
    }
    if (specifier === '@/lib/server/ssrf-guard') {
      return {
        validateUrlForSSRF: () => null,
      };
    }
    if (specifier === '@/lib/pdf/mineru-hosted') {
      return {
        isMinerUHostedConfig: ({ baseUrl }) => !baseUrl,
        normalizeMinerUApiRoot: () => 'https://mineru.net/api/v4',
        getMinerUHostedVerificationUrl: () => 'https://mineru.net/api/v4/file-urls/batch',
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

async function main() {
  const routePath = path.join(repoRoot, 'app', 'api', 'verify-pdf-provider', 'route.ts');
  const route = loadTsModule(routePath);

  const originalFetch = global.fetch;

  global.fetch = async () => {
    hostedCheckCalls += 1;
    return new Response(null, { status: 405 });
  };

  const hostedResponse = await route.POST({
    async json() {
      return {
        providerId: 'mineru',
        apiKey: 'test-key',
      };
    },
  });

  const selfHostedResponse = await route.POST({
    async json() {
      return {
        providerId: 'mineru',
        baseUrl: 'https://mineru.self-hosted.example.com',
      };
    },
  });

  try {
    assert.equal(hostedResponse.success, true);
    assert.equal(hostedCheckCalls, 1);
    assert.equal(hostedResponse.mode, 'hosted');
    assert.equal(
      hostedResponse.requestUrl,
      'https://mineru.net/api/v4/file-urls/batch',
    );
    assert.match(hostedResponse.message, /upload a pdf/i);

    assert.equal(selfHostedResponse.success, true);
    assert.equal(selfHostedResponse.mode, 'self-hosted');
    assert.equal(selfHostedResponse.requestUrl, 'https://mineru.self-hosted.example.com');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('MinerU verify route hosted check passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
