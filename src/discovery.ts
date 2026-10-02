import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { field, parseJson } from './json.ts';

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
  | 'symlink not followed'
  | 'unreadable';

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
    let names: string[];
    // A directory that cannot be listed, or an entry that disappears while it is walked, is skipped and named.
    try { names = readdirSync(dir).sort(); } catch { result.excluded.push({ path: relative(root, dir).split(sep).join('/') || '.', reason: 'unreadable' }); return; }
    for (const name of names) {
      if (result.files.length >= MAX_FILES) { result.truncated = true; return; }
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      let info;
      try { info = lstatSync(abs); } catch { result.excluded.push({ path: rel, reason: 'unreadable' }); continue; }
      if (info.isDirectory() && Object.hasOwn(SKIPPED_DIRS, name)) continue;
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

// Opens a regular file without following a symlink, even one swapped in after the walk, and without blocking on a
// FIFO. Null when it cannot be opened that way.
function openRegular(abs: string): { fd: number; size: number; mtimeMs: number } | null {
  let fd: number;
  try { fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  const info = fstatSync(fd);
  if (info.isFile()) return { fd, size: info.size, mtimeMs: info.mtimeMs };
  closeSync(fd);
  return null;
}

export type RepoFile = { kind: 'absent' } | { kind: 'skipped'; reason: string } | { kind: 'read'; text: string; sha256: string };

// Reads one top-level repository file under the same boundary as discovery: never a symlink, a sensitive file or
// a configured sensitive path.
export function readRepoFile(root: string, name: string, exclude: readonly string[]): RepoFile {
  const abs = join(root, name);
  let info;
  try { info = lstatSync(abs); } catch { return { kind: 'absent' }; }
  const reason = info.isSymbolicLink() ? "it's a symlink, and I never follow symlinks"
    : sensitiveReason(name) ?? (exclude.map(globToRegExp).some((re) => re.test(name)) ? "it's a configured sensitive path" : null);
  if (reason) return { kind: 'skipped', reason };
  const file = openRegular(abs);
  if (!file) return { kind: 'skipped', reason: "it isn't a regular file I can open" };
  try {
    const bytes = readFileSync(file.fd);
    return { kind: 'read', text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    closeSync(file.fd);
  }
}

export interface Detected { value: string; evidence: string[] }
export interface StraddleSdk { package: string; version: string; manifest: string }

export interface RepoFacts {
  root: string;
  language: Detected;
  framework: Detected;
  straddleSdk: StraddleSdk | null;
  // Providers to migrate from. Plaid counts only when the code calls Plaid Transfer or Identity Verification.
  providers: string[];
  // A bank connection already in use (Plaid Link and its processor tokens): a Plan decision, not a migration.
  bankLink: BankLink[];
  files: number;
  excluded: Exclusion[];
  truncated: boolean;
  errors: string[];
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

export type BankLink = 'plaid';

// Plaid is a competitor for payments (Transfer) and KYC (Identity Verification), and a bank connection (Link,
// processor tokens) Straddle accepts. Method names as plaid-node, plaid-python and plaid-go spell them, and the endpoints.
const PLAID_MIGRATE = /\b(?:transfer_?(?:authorization_?)?create|identity_?verification_?create)\b|\/(?:transfer\/(?:authorization\/)?|identity_verification\/)create\b/i;
const PLAID_LINK = /\b(?:link_?token_?create|item_?public_?token_?exchange|processor_?token_?create)\b|\/(?:link\/token\/create|item\/public_token\/exchange|processor\/token\/create)\b/i;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rb|cs)$/;

// Which Plaid roles the source files show. Read under the same boundary as hashing: walked files only, no symlinks.
function plaidUsage(root: string, files: readonly string[]): { migrate: boolean; link: boolean } {
  let migrate = false;
  let link = false;
  for (const rel of files) {
    if (!SOURCE.test(rel)) continue;
    const file = openRegular(join(root, rel));
    if (!file) continue;
    try {
      if (file.size > MAX_HASH_BYTES) continue;
      const text = readFileSync(file.fd, 'utf8');
      migrate ||= PLAID_MIGRATE.test(text);
      link ||= PLAID_LINK.test(text);
    } catch { /* unreadable: no evidence either way */ } finally {
      closeSync(file.fd);
    }
    if (migrate && link) break;
  }
  return { migrate, link };
}

interface Manifest { ecosystem: Ecosystem; language: string; evidence: string[]; deps: Map<string, string>; file: string }

function readManifests(root: string, files: readonly string[]): { manifests: Manifest[]; errors: string[] } {
  const has = new Set(files);
  const manifests: Manifest[] = [];
  const errors: string[] = [];
  const read = (rel: string): string | null => {
    const file = openRegular(join(root, rel));
    try {
      if (file) return readFileSync(file.fd, 'utf8');
    } catch { /* reported below */ } finally {
      if (file) closeSync(file.fd);
    }
    errors.push(`I couldn't read ${rel}`);
    return null;
  };

  const raw = has.has('package.json') ? read('package.json') : null;
  if (raw !== null) {
    const pkg = parseJson(raw);
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      errors.push('package.json is malformed JSON');
    } else {
      const deps = new Map<string, string>();
      for (const key of ['dependencies', 'devDependencies']) {
        const block = field(pkg, key);
        if (block && typeof block === 'object') for (const [name, version] of Object.entries(block)) deps.set(name, String(version));
      }
      const ts = has.has('tsconfig.json') || deps.has('typescript');
      manifests.push({ ecosystem: 'node', language: ts ? 'TypeScript' : 'JavaScript', evidence: has.has('tsconfig.json') ? ['package.json', 'tsconfig.json'] : ['package.json'], deps, file: 'package.json' });
    }
  }
  const python = ['pyproject.toml', 'requirements.txt', 'Pipfile'].find((f) => has.has(f));
  const pythonText = python ? read(python) : null;
  if (python && pythonText !== null) {
    const deps = new Map<string, string>();
    for (const m of pythonText.matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*([=<>~!]=?[^"#,\s]*)?/gm)) deps.set(m[1]!.toLowerCase(), m[2] ?? '');
    manifests.push({ ecosystem: 'python', language: 'Python', evidence: [python], deps, file: python });
  }
  const gemfile = has.has('Gemfile') ? read('Gemfile') : null;
  if (gemfile !== null) {
    const deps = new Map<string, string>();
    for (const m of gemfile.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) deps.set(m[1]!, m[2] ?? '');
    manifests.push({ ecosystem: 'ruby', language: 'Ruby', evidence: ['Gemfile'], deps, file: 'Gemfile' });
  }
  const goMod = has.has('go.mod') ? read('go.mod') : null;
  if (goMod !== null) {
    const deps = new Map<string, string>();
    for (const m of goMod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/gm)) deps.set(m[1]!, m[2]!);
    manifests.push({ ecosystem: 'go', language: 'Go', evidence: ['go.mod'], deps, file: 'go.mod' });
  }
  const csproj = files.find((f) => f.endsWith('.csproj') && f.split('/').length <= 3);
  const text = csproj ? read(csproj) : null;
  if (csproj && text !== null) {
    const deps = new Map<string, string>();
    for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) deps.set(m[1]!, m[2] ?? '');
    const sdk = /<Project\s+Sdk="([^"]+)"/.exec(text)?.[1];
    if (sdk) deps.set(sdk, '');
    manifests.push({ ecosystem: 'csharp', language: 'C#', evidence: [csproj], deps, file: csproj });
  }
  return { manifests, errors };
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
  const { manifests, errors } = readManifests(root, scan.files);
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
  // A Plaid dependency without Transfer or Identity Verification calls is a bank connection, not a provider.
  let bankLink: BankLink[] = [];
  if (providers.has('plaid')) {
    const plaid = plaidUsage(root, scan.files);
    if (!plaid.migrate) providers.delete('plaid');
    if (plaid.link || !plaid.migrate) bankLink = ['plaid'];
  }

  return {
    root,
    language: primary ? { value: primary.language, evidence: primary.evidence } : unknown,
    framework,
    straddleSdk,
    providers: [...providers].sort(),
    bankLink,
    files: scan.files.length,
    excluded: scan.excluded,
    truncated: scan.truncated,
    errors,
  };
}

// Hashes only files discovery may open, to report what changed during an agent session. `limits` names what the
// comparison could not cover, so a changed-file list is never presented as exhaustive when it is not.
export interface Snapshot { hashes: Record<string, string>; limits: string[] }

export function snapshot(root: string, exclude: readonly string[]): Snapshot {
  const scan = walk(root, exclude);
  const hashes: Record<string, string> = {};
  const unreadable = scan.excluded.filter((e) => e.reason === 'unreadable').map((e) => e.path);
  for (const rel of scan.files) {
    const file = openRegular(join(root, rel));
    if (!file) { unreadable.push(rel); continue; }
    try {
      hashes[rel] = file.size > MAX_HASH_BYTES ? `size:${file.size}:mtime:${file.mtimeMs}` : createHash('sha256').update(readFileSync(file.fd)).digest('hex');
    } catch {
      unreadable.push(rel);
    } finally {
      closeSync(file.fd);
    }
  }
  const limits: string[] = [];
  if (scan.truncated) limits.push(`the file limit (${MAX_FILES} files, ${MAX_DEPTH} directory levels) was reached; files beyond it were not compared`);
  if (unreadable.length) limits.push(`not readable, so not compared: ${unreadable.sort().join(', ')}`);
  return { hashes, limits };
}

export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const paths = new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]);
  return [...paths].filter((p) => before.hashes[p] !== after.hashes[p]).sort();
}
