import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { field } from './json.ts';

// Bounds keep discovery predictable in large repositories.
const MAX_FILES = 5000;
const MAX_DEPTH = 12;
const MAX_HASH_BYTES = 5 * 1024 * 1024;

// Generated or dependency trees: skipped silently, never secrets by themselves.
const SKIPPED_DIRS: Record<string, true> = {
  '.git': true, node_modules: true, '.straddle-wizard': true, dist: true, build: true, '.next': true, vendor: true, target: true,
  '.venv': true, venv: true, __pycache__: true, bin: true, obj: true, coverage: true, '.turbo': true, '.cache': true,
};

export type ExclusionReason =
  | 'environment file'
  | 'private key or certificate'
  | 'credential or CLI configuration'
  | 'configured sensitive path'
  | 'symlink escapes the repository'
  | 'symlink not followed';

export interface Exclusion { path: string; reason: ExclusionReason }

function sensitiveReason(name: string): ExclusionReason | null {
  if (name.startsWith('.env')) return 'environment file';
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return 'private key or certificate';
  if (/^\.(npmrc|pypirc|netrc|git-credentials|aws|ssh|gnupg|docker|kube|config|straddle.*)$/.test(name) || /secret|credential|\.tfvars$/i.test(name)) {
    return 'credential or CLI configuration';
  }
  return null;
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${body}$`);
}

interface Walk { files: string[]; excluded: Exclusion[]; truncated: boolean }

function walk(repo: string, exclude: readonly string[]): Walk {
  const root = realpathSync(repo);
  const configured = exclude.map(globToRegExp);
  const result: Walk = { files: [], excluded: [], truncated: false };
  const visit = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      if (result.files.length >= MAX_FILES) { result.truncated = true; return; }
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      const info = lstatSync(abs);
      if (info.isDirectory() && SKIPPED_DIRS[name]) continue;
      if (info.isSymbolicLink()) {
        let target: string | null = null;
        try { target = realpathSync(abs); } catch { target = null; }
        const inside = target !== null && (target === root || target.startsWith(root + sep));
        result.excluded.push({ path: rel, reason: inside ? 'symlink not followed' : 'symlink escapes the repository' });
        continue;
      }
      const reason = sensitiveReason(name) ?? (configured.some((re) => re.test(rel)) ? 'configured sensitive path' : null);
      if (reason) { result.excluded.push({ path: rel, reason }); continue; }
      if (info.isDirectory()) {
        if (depth >= MAX_DEPTH) { result.truncated = true; continue; }
        visit(abs, depth + 1);
      } else if (info.isFile()) {
        result.files.push(rel);
      }
    }
  };
  visit(root, 0);
  return result;
}

export interface Detected { value: string; evidence: string[] }
export interface StraddleSdk { package: string; version: string; manifest: string }

export interface RepoFacts {
  root: string;
  language: Detected;
  framework: Detected;
  straddleSdk: StraddleSdk | null;
  providers: string[];
  files: number;
  excluded: Exclusion[];
  truncated: boolean;
}

type Ecosystem = 'node' | 'python' | 'ruby' | 'go' | 'csharp';

const FRAMEWORKS: Record<Ecosystem, Array<[string, string]>> = {
  node: [['next', 'Next.js'], ['@nestjs/core', 'NestJS'], ['@remix-run/node', 'Remix'], ['@sveltejs/kit', 'SvelteKit'], ['nuxt', 'Nuxt'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['koa', 'Koa'], ['react', 'React'], ['vue', 'Vue']],
  python: [['django', 'Django'], ['fastapi', 'FastAPI'], ['flask', 'Flask']],
  ruby: [['rails', 'Rails'], ['sinatra', 'Sinatra']],
  go: [['github.com/gin-gonic/gin', 'Gin'], ['github.com/labstack/echo', 'Echo'], ['github.com/go-chi/chi', 'chi'], ['github.com/gofiber/fiber', 'Fiber']],
  csharp: [['Microsoft.NET.Sdk.Web', 'ASP.NET Core']],
};

const PROVIDERS: Array<[RegExp, string]> = [
  [/^(stripe|github\.com\/stripe\/stripe-go.*)$/, 'stripe'],
  [/^(plaid|plaid-python|github\.com\/plaid\/plaid-go.*)$/, 'plaid'],
  [/^(@moovio\/.*|moov|github\.com\/moovfinancial\/.*)$/, 'moov'],
  [/^(dwolla-v2|dwollav2|dwolla_v2|dwolla)$/, 'dwolla'],
  [/^(modern-treasury|modern_treasury|github\.com\/modern-treasury\/.*)$/, 'modern-treasury'],
];

interface Manifest { ecosystem: Ecosystem; language: string; evidence: string[]; deps: Map<string, string>; file: string }

function readManifests(root: string, files: readonly string[]): Manifest[] {
  const has = new Set(files);
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const manifests: Manifest[] = [];

  if (has.has('package.json')) {
    const pkg: unknown = JSON.parse(read('package.json'));
    const deps = new Map<string, string>();
    for (const key of ['dependencies', 'devDependencies']) {
      const block = field(pkg, key);
      if (block && typeof block === 'object') for (const [name, version] of Object.entries(block)) deps.set(name, String(version));
    }
    const ts = has.has('tsconfig.json') || deps.has('typescript');
    manifests.push({ ecosystem: 'node', language: ts ? 'TypeScript' : 'JavaScript', evidence: has.has('tsconfig.json') ? ['package.json', 'tsconfig.json'] : ['package.json'], deps, file: 'package.json' });
  }
  for (const file of ['pyproject.toml', 'requirements.txt', 'Pipfile']) {
    if (!has.has(file)) continue;
    const deps = new Map<string, string>();
    for (const m of read(file).matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*([=<>~!]=?[^"#,\s]*)?/gm)) deps.set(m[1]!.toLowerCase(), m[2] ?? '');
    manifests.push({ ecosystem: 'python', language: 'Python', evidence: [file], deps, file });
    break;
  }
  if (has.has('Gemfile')) {
    const deps = new Map<string, string>();
    for (const m of read('Gemfile').matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) deps.set(m[1]!, m[2] ?? '');
    manifests.push({ ecosystem: 'ruby', language: 'Ruby', evidence: ['Gemfile'], deps, file: 'Gemfile' });
  }
  if (has.has('go.mod')) {
    const deps = new Map<string, string>();
    for (const m of read('go.mod').matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gm)) deps.set(m[1]!, m[2]!);
    manifests.push({ ecosystem: 'go', language: 'Go', evidence: ['go.mod'], deps, file: 'go.mod' });
  }
  const csproj = files.find((f) => f.endsWith('.csproj') && f.split('/').length <= 3);
  if (csproj) {
    const text = read(csproj);
    const deps = new Map<string, string>();
    for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) deps.set(m[1]!, m[2] ?? '');
    const sdk = /<Project\s+Sdk="([^"]+)"/.exec(text)?.[1];
    if (sdk) deps.set(sdk, '');
    manifests.push({ ecosystem: 'csharp', language: 'C#', evidence: [csproj], deps, file: csproj });
  }
  return manifests;
}

const SDK_PACKAGES: Record<Ecosystem, string[]> = {
  node: ['@straddlecom/straddle'],
  python: ['straddle'],
  ruby: ['straddle'],
  go: ['github.com/straddle-build/straddle-go', 'github.com/straddleio/straddle-go'],
  csharp: ['Straddle'],
};

export function discover(root: string, exclude: readonly string[]): RepoFacts {
  const scan = walk(root, exclude);
  const manifests = readManifests(root, scan.files);
  const primary = manifests[0];
  const unknown: Detected = { value: 'unknown', evidence: [] };

  let framework = unknown;
  let straddleSdk: StraddleSdk | null = null;
  const providers = new Set<string>();
  for (const m of manifests) {
    const hit = FRAMEWORKS[m.ecosystem].find(([dep]) => m.deps.has(dep));
    if (hit && framework === unknown) framework = { value: hit[1], evidence: [m.file] };
    const sdk = SDK_PACKAGES[m.ecosystem].find((p) => m.deps.has(p));
    if (sdk && !straddleSdk) straddleSdk = { package: sdk, version: m.deps.get(sdk) ?? '', manifest: m.file };
    for (const dep of m.deps.keys()) {
      const provider = PROVIDERS.find(([re]) => re.test(dep));
      if (provider) providers.add(provider[1]);
    }
  }

  return {
    root,
    language: primary ? { value: primary.language, evidence: primary.evidence } : unknown,
    framework,
    straddleSdk,
    providers: [...providers].sort(),
    files: scan.files.length,
    excluded: scan.excluded,
    truncated: scan.truncated,
  };
}

export type Snapshot = Record<string, string>;

// Hashes only files discovery may open, to report what changed during an agent session.
export function snapshot(root: string, exclude: readonly string[]): Snapshot {
  const snap: Snapshot = {};
  for (const rel of walk(root, exclude).files) {
    const abs = join(root, rel);
    const info = statSync(abs);
    snap[rel] = info.size > MAX_HASH_BYTES ? `size:${info.size}:mtime:${info.mtimeMs}` : createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  return snap;
}

export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => before[p] !== after[p]).sort();
}
