import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover, snapshot, changedFiles } from '../src/discovery.ts';
import { programSkills } from '../src/programs.ts';
import { nextRepo, tempDir, writeFiles } from './helpers.ts';

test('detects language, framework, provider code and the declared Straddle SDK from manifests', () => {
  const repo = nextRepo();
  writeFiles(repo, { 'package.json': JSON.stringify({ dependencies: { next: '15.0.0', '@straddlecom/straddle': '^1.0.4', stripe: '17.0.0' }, devDependencies: { typescript: '5.6.0' } }) });

  const facts = discover(repo, []);

  assert.equal(facts.language.value, 'TypeScript');
  assert.equal(facts.framework.value, 'Next.js');
  assert.deepEqual(facts.straddleSdk, { package: '@straddlecom/straddle', version: '^1.0.4', manifest: 'package.json' });
  assert.deepEqual(facts.providers, ['stripe']);
});

// Plaid Transfer and Identity Verification calls make Plaid a provider to migrate from; Link and processor tokens make it
// a bank connection for Plan. Calls as plaid-node, plaid-python and plaid-go spell them.
const PLAID_MANIFESTS = {
  node: { 'package.json': JSON.stringify({ dependencies: { express: '4.21.0', plaid: '29.0.0' } }) },
  python: { 'requirements.txt': 'flask==3.0.0\nplaid-python==25.0.0\n' },
  go: { 'go.mod': 'module shop\n\nrequire github.com/plaid/plaid-go/v29 v29.0.0\n' },
};
const PLAID_CALLS = {
  transfer: {
    node: { 'src/pay.ts': 'const { data } = await plaid.transferCreate({ access_token, account_id, authorization_id, description: "Order" });\n' },
    python: { 'app/pay.py': 'from plaid.model.transfer_create_request import TransferCreateRequest\nresponse = client.transfer_create(request)\n' },
    go: { 'pay.go': 'resp, _, err := client.PlaidApi.TransferCreate(ctx).TransferCreateRequest(request).Execute()\n' },
  },
  transferIntent: {
    node: { 'src/pay.ts': 'const { data } = await plaid.transferIntentCreate({ mode: "PAYMENT", amount, description });\n' },
    python: { 'app/pay.py': 'response = client.transfer_intent_create(request)\n' },
    go: { 'pay.go': 'resp, _, err := client.PlaidApi.TransferIntentCreate(ctx).TransferIntentCreateRequest(request).Execute()\n' },
  },
  transferRecurring: {
    node: { 'src/pay.ts': 'await plaid.transferRecurringCreate({ access_token, account_id, schedule });\n' },
    python: { 'app/pay.py': 'response = client.transfer_recurring_create(request)\n' },
    go: { 'pay.go': 'resp, _, err := client.PlaidApi.TransferRecurringCreate(ctx).TransferRecurringCreateRequest(request).Execute()\n' },
  },
  bankTransfer: {
    node: { 'src/pay.ts': 'await plaid.bankTransferCreate({ idempotency_key, access_token, account_id });\n' },
    python: { 'app/pay.py': 'response = client.bank_transfer_create(request)\n' },
    go: { 'pay.go': 'resp, _, err := client.PlaidApi.BankTransferCreate(ctx).BankTransferCreateRequest(request).Execute()\n' },
  },
  identityVerification: {
    node: { 'src/kyc.ts': 'await plaid.identityVerificationCreate({ template_id, client_user_id, gave_consent: true });\n' },
    python: { 'app/kyc.py': 'response = client.identity_verification_create(request)\n' },
    go: { 'kyc.go': 'resp, _, err := client.PlaidApi.IdentityVerificationCreate(ctx).IdentityVerificationCreateRequest(request).Execute()\n' },
  },
  identityVerificationGet: {
    node: { 'src/kyc.ts': 'const { data } = await plaid.identityVerificationGet({ identity_verification_id });\n' },
    python: { 'app/kyc.py': 'response = client.identity_verification_get(request)\n' },
    go: { 'kyc.go': 'resp, _, err := client.PlaidApi.IdentityVerificationGet(ctx).IdentityVerificationGetRequest(request).Execute()\n' },
  },
  // Plaid's standard Identity Verification flow starts from a Link token; the create call is optional.
  identityVerificationLink: {
    node: { 'src/kyc.ts': 'await plaid.linkTokenCreate({ user: { client_user_id }, products: [Products.IdentityVerification], identity_verification: { template_id } });\n' },
    python: { 'app/kyc.py': 'request = LinkTokenCreateRequest(products=[Products("identity_verification")], user=user)\nclient.link_token_create(request)\n' },
    go: { 'kyc.go': 'request.SetProducts([]plaid.Products{plaid.PRODUCTS_IDENTITY_VERIFICATION})\nresp, _, err := client.PlaidApi.LinkTokenCreate(ctx).LinkTokenCreateRequest(*request).Execute()\n' },
  },
  link: {
    node: { 'src/link.ts': 'await plaid.linkTokenCreate({ products: [Products.Auth] });\nconst { data } = await plaid.itemPublicTokenExchange({ public_token });\n' },
    python: { 'app/link.py': 'client.link_token_create(request)\nexchange = client.item_public_token_exchange(exchange_request)\n' },
    go: { 'link.go': 'resp, _, err := client.PlaidApi.ItemPublicTokenExchange(ctx).ItemPublicTokenExchangeRequest(request).Execute()\n' },
  },
  processorTokens: {
    node: { 'src/processor.ts': 'await plaid.processorTokenCreate({ access_token, account_id, processor });\n' },
    python: { 'app/processor.py': 'client.processor_token_create(processor_request)\n' },
    go: { 'processor.go': 'resp, _, err := client.PlaidApi.ProcessorTokenCreate(ctx).ProcessorTokenCreateRequest(request).Execute()\n' },
  },
  balanceOnly: {
    node: { 'src/balance.ts': 'await plaid.accountsBalanceGet({ access_token });\n' },
    python: { 'app/balance.py': 'client.accounts_balance_get(request)\n' },
    go: { 'balance.go': 'resp, _, err := client.PlaidApi.AccountsBalanceGet(ctx).AccountsBalanceGetRequest(request).Execute()\n' },
  },
  // Transfer named where the app doesn't call it: the app's own names and routes, tests and installed packages.
  notCalls: {
    node: {
      'src/notes.ts': 'export const TRANSFER_CREATE = "transfer/create";\nawait fetch("/api/transfer/create");\n',
      'src/__tests__/pay.test.ts': 'const plaid = { transferCreate: vi.fn() };\nawait plaid.transferCreate(request);\n',
    },
    python: {
      'app/views.py': 'def transfer_create(request):\n    return None\n',
      'tests/test_pay.py': 'client.transfer_create(request)\n',
      'env/lib/python3.12/site-packages/plaid/api/plaid_api.py': "self.transfer_create_endpoint = _Endpoint(settings={'endpoint_path': '/transfer/create'})\nself.api_client.call_api('/transfer/create')\n",
    },
    go: {
      'pay_test.go': 'resp, _, err := client.PlaidApi.TransferCreate(ctx).Execute()\n',
    },
  },
  // Comments aren't parsed out, so a call named in one counts: the safe direction.
  commentOnly: {
    node: { 'src/notes.ts': '// await plaid.transferCreate(request)\n' },
    python: { 'app/notes.py': '# client.transfer_create(request)\n' },
    go: { 'notes.go': '// resp, _, err := client.PlaidApi.TransferCreate(ctx).Execute()\n' },
  },
};
const WITH_MIGRATE = ['straddle-setup', 'straddle-plan', 'straddle-migrate', 'straddle-integrate', 'straddle-test', 'straddle-go-live'];
const WITHOUT_MIGRATE = ['straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test', 'straddle-go-live'];
const LINK = { source: 'plaid', processorTokens: false };

for (const ecosystem of ['node', 'python', 'go'] as const) {
  const cases: Array<[string, Array<keyof typeof PLAID_CALLS>, { steps: string[]; bankLink: typeof LINK | null }]> = [
    ['a Transfer repo adds Migrate', ['transfer'], { steps: WITH_MIGRATE, bankLink: null }],
    ['a Transfer UI repo adds Migrate', ['transferIntent'], { steps: WITH_MIGRATE, bankLink: null }],
    ['a recurring Transfer repo adds Migrate', ['transferRecurring'], { steps: WITH_MIGRATE, bankLink: null }],
    ['a legacy Bank Transfers repo adds Migrate', ['bankTransfer'], { steps: WITH_MIGRATE, bankLink: null }],
    ['an Identity Verification repo adds Migrate', ['identityVerification'], { steps: WITH_MIGRATE, bankLink: null }],
    ['an Identity Verification repo that only reads results adds Migrate', ['identityVerificationGet'], { steps: WITH_MIGRATE, bankLink: null }],
    ['Identity Verification started from a Link token adds Migrate and is no bank connection', ['identityVerificationLink'], { steps: WITH_MIGRATE, bankLink: null }],
    ['a Link-only repo adds no Migrate and reports Plaid Link', ['link'], { steps: WITHOUT_MIGRATE, bankLink: LINK }],
    ['processor tokens add no Migrate and are reported', ['processorTokens'], { steps: WITHOUT_MIGRATE, bankLink: { source: 'plaid', processorTokens: true } }],
    ['a repo with Link and Transfer adds Migrate and reports Plaid Link', ['link', 'transfer'], { steps: WITH_MIGRATE, bankLink: LINK }],
    ['a Plaid dependency with no Link, Transfer or Identity Verification call keeps Migrate and claims no Link', ['balanceOnly'], { steps: WITH_MIGRATE, bankLink: null }],
    ['Link with Transfer named only in tests, its own names and routes, or installed packages adds no Migrate', ['link', 'notCalls'], { steps: WITHOUT_MIGRATE, bankLink: LINK }],
    ['Link with Transfer named in a comment keeps Migrate', ['link', 'commentOnly'], { steps: WITH_MIGRATE, bankLink: LINK }],
  ];
  for (const [name, calls, expected] of cases) {
    test(`Plaid (${ecosystem}): ${name}`, () => {
      const repo = tempDir(`plaid-${ecosystem}`);
      writeFiles(repo, Object.assign({}, PLAID_MANIFESTS[ecosystem], ...calls.map((c) => PLAID_CALLS[c][ecosystem])));

      const facts = discover(repo, []);

      assert.deepEqual({ steps: programSkills('integration', facts.providers), bankLink: facts.bankLink }, expected);
    });
  }
}

test('Plaid Link keeps Migrate when the scan may not see some source, and only then', () => {
  const outside = tempDir('plaid-shared');
  writeFiles(outside, { 'pay.ts': 'export const CENTS = 100;\n', LICENSE: 'MIT\n' });
  const helpers = 'export const CENTS = 100;\n';
  // Files, --exclude globs, and symlinks by name and target.
  const cases: Record<string, [Record<string, string>, string[], Record<string, string>]> = {
    'nothing hidden': [{ 'src/private/helpers.ts': helpers }, [], {}],
    'CLAUDE.md -> AGENTS.md': [{ 'AGENTS.md': '# Agents\n' }, [], { 'CLAUDE.md': 'AGENTS.md' }],
    'an extensionless LICENSE symlink to a file': [{}, [], { LICENSE: join(outside, 'LICENSE') }],
    'a symlinked node_modules': [{}, [], { node_modules: outside }],
    'an excluded file': [{ 'src/private/helpers.ts': helpers }, ['src/private/**'], {}],
    'an excluded directory': [{ 'src/private/helpers.ts': helpers }, ['src/private'], {}],
    'a directory with a sensitive name': [{ 'src/credentials/helpers.ts': helpers }, [], {}],
    'a symlinked directory': [{}, [], { shared: outside }],
    'a symlinked directory with a dotted name': [{}, [], { 'shared.v1': outside }],
    'a dangling symlink': [{}, [], { ghost: join(outside, 'missing') }],
  };
  const providers = ([files, exclude, links]: [Record<string, string>, string[], Record<string, string>]) => {
    const repo = tempDir('plaid-hidden');
    writeFiles(repo, Object.assign({}, PLAID_MANIFESTS.node, PLAID_CALLS.link.node, files));
    for (const [name, target] of Object.entries(links)) symlinkSync(target, join(repo, name));
    return discover(repo, exclude).providers;
  };

  const result = Object.fromEntries(Object.entries(cases).map(([name, setup]) => [name, providers(setup)]));

  assert.deepEqual(result, {
    'nothing hidden': [],
    'CLAUDE.md -> AGENTS.md': [],
    'an extensionless LICENSE symlink to a file': [],
    'a symlinked node_modules': [],
    'an excluded file': ['plaid'],
    'an excluded directory': ['plaid'],
    'a directory with a sensitive name': ['plaid'],
    'a symlinked directory': ['plaid'],
    'a symlinked directory with a dotted name': ['plaid'],
    'a dangling symlink': ['plaid'],
  });
});

test('Plaid calls count wherever the app makes them: under env/, around comments and strings, in a #field, destructured, in a template literal, and in Ruby without parentheses', () => {
  const RUBY = { Gemfile: "source 'https://rubygems.org'\ngem 'rails'\ngem 'plaid'\n", 'app/services/link.rb': 'client.link_token_create request\nclient.item_public_token_exchange request\n' };
  const repos: Array<[string, Record<string, string>]> = [
    ['env directory', { 'src/env/payments.ts': 'await plaid.transferCreate(request);\n' }],
    ['after a block comment', { 'src/pay.ts': '/* payment */ await plaid.transferCreate(request);\n' }],
    ['between a "/*" string and a JSDoc', { 'src/pay.ts': "app.use('/api/*', auth);\nawait plaid.transferCreate(request);\n/** Audit trail. */\nexport const audited = true;\n" }],
    ['#field', { 'src/account.ts': 'class Account {\n  #transfer = plaid.transferCreate(request);\n}\n' }],
    ['destructured', { 'src/pay.ts': 'const { transferCreate } = plaid;\nawait transferCreate.call(plaid, request);\n' }],
    ['template literal', { 'src/pay.ts': 'await axios.post(`${PLAID_BASE}/transfer/create`, body);\n' }],
  ];
  const facts = (files: Record<string, string>) => {
    const repo = tempDir('plaid-calls');
    writeFiles(repo, files);
    const found = discover(repo, []);
    return { steps: programSkills('integration', found.providers), bankLink: found.bankLink };
  };

  const node = Object.fromEntries(repos.map(([name, files]) => [name, facts(Object.assign({}, PLAID_MANIFESTS.node, PLAID_CALLS.link.node, files))]));
  const ruby = {
    link: facts(RUBY),
    transfer: facts({ ...RUBY, 'app/services/pay.rb': 'client.transfer_create request\n' }),
    identityVerification: facts({ ...RUBY, 'app/services/kyc.rb': 'client.identity_verification_get request\n' }),
  };

  const migrate = { steps: WITH_MIGRATE, bankLink: LINK };
  assert.deepEqual({ node, ruby }, {
    node: { 'env directory': migrate, 'after a block comment': migrate, 'between a "/*" string and a JSDoc': migrate, '#field': migrate, destructured: migrate, 'template literal': migrate },
    ruby: { link: { steps: WITHOUT_MIGRATE, bankLink: LINK }, transfer: migrate, identityVerification: migrate },
  });
});

test('reports unknown instead of guessing when no manifest names a language', () => {
  const repo = tempDir('empty');
  writeFiles(repo, { 'README.md': '# app\n' });

  const facts = discover(repo, []);

  assert.equal(facts.language.value, 'unknown');
  assert.equal(facts.framework.value, 'unknown');
  assert.equal(facts.straddleSdk, null);
});

test('malformed package.json yields detection error without false detection', () => {
  const repo = tempDir('malformed');
  writeFiles(repo, { 'package.json': '{ invalid json: }', 'tsconfig.json': '{}' });

  const facts = discover(repo, []);

  assert.equal(facts.language.value, 'unknown');
  assert.equal(facts.framework.value, 'unknown');
  assert.equal(facts.straddleSdk, null);
  assert.deepEqual(facts.errors, ['package.json is malformed JSON']);
});

test('never opens secrets, keys, CLI configuration or configured sensitive paths', () => {
  const repo = nextRepo();
  writeFiles(repo, {
    '.env': 'STRADDLE_API_KEY=sk_live_never',
    '.env.local': 'x',
    'config/server.pem': 'x',
    'deploy/id_ed25519': 'x',
    '.npmrc': '//registry/:_authToken=x',
    '.straddle/config.toml': 'x',
    'secrets/prod.json': 'x',
    'internal/customers.csv': 'x',
  });
  // Unreadable files prove discovery and snapshots do not open them: any read would throw EACCES.
  for (const path of ['.env', '.env.local', 'config/server.pem', 'deploy/id_ed25519', '.npmrc', '.straddle/config.toml', 'secrets/prod.json', 'internal/customers.csv']) {
    chmodSync(join(repo, path), 0o000);
  }

  const facts = discover(repo, ['internal/**']);
  const snap = snapshot(repo, ['internal/**']);

  const excluded = Object.fromEntries(facts.excluded.map((e) => [e.path, e.reason]));
  assert.equal(excluded['.env'], 'environment file');
  assert.equal(excluded['.env.local'], 'environment file');
  assert.equal(excluded['config/server.pem'], 'private key or certificate');
  assert.equal(excluded['deploy/id_ed25519'], 'private key or certificate');
  assert.equal(excluded['.npmrc'], 'credential or CLI configuration');
  assert.equal(excluded['.straddle'], 'credential or CLI configuration');
  assert.equal(excluded['secrets'], 'credential or CLI configuration');
  assert.equal(excluded['internal/customers.csv'], 'configured sensitive path');
  assert.ok(!Object.keys(snap.hashes).some((p) => p.startsWith('.env') || p.startsWith('internal/')));
});

test('does not follow symlinks, and names the ones that escape the repository', () => {
  const outside = tempDir('outside');
  writeFiles(outside, { 'requirements.txt': 'django==5.0\n', 'secret.txt': 'hunter2' });
  const repo = nextRepo();
  symlinkSync(outside, join(repo, 'vendor-link'));
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'notes.txt'));
  symlinkSync(join(repo, 'src'), join(repo, 'src-alias'));

  const facts = discover(repo, []);
  const snap = snapshot(repo, []);

  const excluded = Object.fromEntries(facts.excluded.map((e) => [e.path, e.reason]));
  assert.equal(excluded['vendor-link'], 'symlink escapes the repository');
  assert.equal(excluded['notes.txt'], 'symlink escapes the repository');
  assert.equal(excluded['src-alias'], 'symlink not followed');
  assert.equal(facts.language.value, 'TypeScript');
  assert.ok(!('notes.txt' in snap.hashes));
});

test('changed files compare two snapshots, including created and deleted files', () => {
  const repo = nextRepo();
  const before = snapshot(repo, []);
  writeFiles(repo, { 'src/app/page.tsx': 'changed', 'src/straddle.ts': 'new' });

  assert.deepEqual(changedFiles(before, snapshot(repo, [])), ['src/app/page.tsx', 'src/straddle.ts']);
});

test('an unreadable directory is skipped and named, and the snapshot says which paths it could not compare', () => {
  const repo = nextRepo();
  mkdirSync(join(repo, 'locked'));
  writeFiles(repo, { 'locked/build.log': 'x' });
  chmodSync(join(repo, 'locked'), 0o000);

  const facts = discover(repo, []);
  const snap = snapshot(repo, []);

  assert.deepEqual(facts.excluded, [{ path: 'locked', reason: 'unreadable' }]);
  assert.equal(facts.language.value, 'TypeScript');
  assert.deepEqual(snap.limits, ['not readable, so not compared: locked']);
  chmodSync(join(repo, 'locked'), 0o755);
});
