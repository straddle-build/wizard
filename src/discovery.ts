import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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

// The regular expression pattern discovery and the payment review's session-state script (`writeExcludes` in review.ts)
// use to match the same `--exclude` globs.
export function globPattern(glob: string): string {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?')
    .replace(/\u0001/g, '.*');
  return `^${body}$`;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(globPattern(glob));
}

// `hidden`: excluded directories, and symlinks that may lead to one or to source, whose contents the walk never saw.
interface Walk { files: string[]; excluded: Exclusion[]; hidden: string[]; truncated: boolean }

function walk(repo: string, exclude: readonly string[]): Walk {
  const root = realpathSync(repo);
  const configured = exclude.map(globToRegExp);
  const result: Walk = { files: [], excluded: [], hidden: [], truncated: false };
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
        // Whether the unfollowed link could hide app source, from its target's metadata only (stat opens no file): a
        // directory or a source file could, a document can't, and a target that can't be inspected could. A dependency
        // tree's name never counts, as for a real directory.
        if (!Object.hasOwn(SKIPPED_DIRS, name)) {
          let hides = true;
          try {
            const linked = statSync(abs);
            hides = linked.isDirectory() || (linked.isFile() && (SOURCE.test(name) || SOURCE.test(target ?? '')));
          } catch { /* dangling or unreadable: hides = true */ }
          if (hides) result.hidden.push(rel);
        }
        continue;
      }
      const reason = sensitiveReason(name) ?? (configured.some((re) => re.test(rel)) ? 'configured sensitive path' : null);
      if (reason) {
        result.excluded.push({ path: rel, reason });
        if (info.isDirectory()) result.hidden.push(rel);
        continue;
      }
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
export function openRegular(abs: string): { fd: number; size: number; mtimeMs: number } | null {
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
  // Providers to migrate from. A declared Plaid leaves only when the whole scan shows Link calls and no Transfer or
  // Identity Verification call.
  providers: string[];
  // A bank connection the code already uses (Plaid Link): a Plan decision, not a migration. Null when none was found.
  bankLink: BankLink | null;
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
export const PROVIDER_NAMES: readonly string[] = PROVIDERS.map(([, name]) => name);

// `processorTokens`: the code calls processorTokenCreate, so it hands Plaid processor tokens to a partner.
export interface BankLink { source: 'plaid'; processorTokens: boolean }

// Plaid is a competitor for payments (Transfer, Transfer UI, recurring and legacy Bank Transfers) and KYC (Identity
// Verification, also started from a Link token whose products include identity_verification), and a bank connection
// (Link, processor tokens) Straddle accepts. A method matches called on a receiver as plaid-node, plaid-python,
// plaid-go and plaid-ruby spell it (Ruby needs no parentheses) or destructured, and an endpoint as a quoted path,
// a full Plaid URL or a template literal's path after `${base}`.
function plaidPattern(methods: string, paths: string): RegExp {
  return new RegExp(String.raw`\.(?:${methods})(?:\s*\(|[ \t]+[\w@:])|[{,]\s*(?:${methods})\s*[,}]|['"\x60}](?:https:\/\/[a-z]+\.plaid\.com)?\/(?:${paths})\b`, 'i');
}
const PLAID_MIGRATE = plaidPattern(
  String.raw`(?:bank_?)?transfer_?(?:authorization_?|intent_?|recurring_?)?create|identity_?verification_?(?:create|get|list|retry)`,
  String.raw`(?:bank_)?transfer\/(?:authorization\/|intent\/|recurring\/)?create|identity_verification\/(?:create|get|list|retry)`,
);
const PLAID_LINK_TOKEN = plaidPattern(String.raw`link_?token_?create`, String.raw`link\/token\/create`);
const PLAID_IDV_PRODUCT = /['"]identity_verification['"]|Products\.IdentityVerification\b|PRODUCTS_IDENTITY_VERIFICATION\b/;
const PLAID_EXCHANGE = plaidPattern(String.raw`item_?public_?token_?exchange`, String.raw`item\/public_token\/exchange`);
const PLAID_PROCESSOR = plaidPattern(String.raw`processor_?token_?create`, String.raw`processor\/token\/create`);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rb)$/;
// Tests, mocks, fixtures and installed packages name Plaid calls without the app making them.
const NOT_APP_CODE = /(?:^|\/)(?:tests?|__tests__|__mocks__|mocks?|fixtures?|specs?|site-packages)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;
// Comment spans, for the Link matchers only: Python docstrings, Ruby =begin blocks and `#` comments in .py/.rb files, and
// `/* */` and `//` comments elsewhere. Blocks go first, so a line-comment marker inside a string (a URL's `//`, a "#")
// can't swallow a block's opener and leave its body. An unclosed block runs to the end of the file, which keeps the
// scan linear. Each span becomes a space, so the text around it can't join into a call. Strings that look like comments
// are stripped too; every step only removes text, which only loses Link evidence.
const HASH_BLOCKS = /"""[\s\S]*?(?:"""|$(?![\s\S]))|'''[\s\S]*?(?:'''|$(?![\s\S]))|^=begin[\s\S]*?(?:^=end|$(?![\s\S]))/gm;
const HASH_LINES = /#.*$/gm;
const SLASH_BLOCKS = /\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))/g;
const SLASH_LINES = /\/\/.*$/gm;
interface PlaidUsage { migrate: boolean; link: boolean; processorTokens: boolean; complete: boolean }

// Which Plaid roles the app's source files show. Read under the same boundary as hashing: walked files only, no
// symlinks. `complete` is false when the walk hid a directory, a symlink or a source file, or a source file couldn't be
// read, so missing calls are unknown, not absent. Transfer and Identity Verification count anywhere in the text, comments
// included; Link counts only outside comments. A misread either way keeps Migrate.
function plaidUsage(root: string, scan: Walk): PlaidUsage {
  const usage: PlaidUsage = { migrate: false, link: false, processorTokens: false, complete: !scan.truncated };
  if (scan.hidden.some((p) => !NOT_APP_CODE.test(`${p}/`)) || scan.excluded.some((e) => e.reason === 'unreadable' || (SOURCE.test(e.path) && !NOT_APP_CODE.test(e.path)))) usage.complete = false;
  for (const rel of scan.files) {
    if (!SOURCE.test(rel) || NOT_APP_CODE.test(rel)) continue;
    const file = openRegular(join(root, rel));
    if (!file) { usage.complete = false; continue; }
    try {
      if (file.size > MAX_HASH_BYTES) { usage.complete = false; continue; }
      const code = readFileSync(file.fd, 'utf8');
      const live = /\.(?:py|rb)$/.test(rel) ? code.replace(HASH_BLOCKS, ' ').replace(HASH_LINES, ' ') : code.replace(SLASH_BLOCKS, ' ').replace(SLASH_LINES, ' ');
      const idvLink = PLAID_LINK_TOKEN.test(code) && PLAID_IDV_PRODUCT.test(code);
      const processor = PLAID_PROCESSOR.test(live);
      usage.migrate ||= idvLink || PLAID_MIGRATE.test(code);
      usage.link ||= (!idvLink && PLAID_LINK_TOKEN.test(live)) || processor || PLAID_EXCHANGE.test(live);
      usage.processorTokens ||= processor;
    } catch { usage.complete = false; } finally {
      closeSync(file.fd);
    }
  }
  return usage;
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
  // Plaid leaves the providers only on evidence: Link calls found, no Transfer or Identity Verification call, and a
  // scan that read every source file. Anything less keeps Migrate, as for any declared provider.
  let bankLink: BankLink | null = null;
  if (providers.has('plaid')) {
    const plaid = plaidUsage(root, scan);
    if (plaid.link) bankLink = { source: 'plaid', processorTokens: plaid.processorTokens };
    if (plaid.link && !plaid.migrate && plaid.complete) providers.delete('plaid');
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
