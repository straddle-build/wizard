// Routing data only. What each skill does lives in the versioned skill bundle, never here.

export const INTEGRATION_PLAN = 'straddle-integration-plan.md';
export const MIGRATION_PLAN = 'straddle-migration-plan.md';

// The files the integration program's skills write, each opening with a status header. Resume reads them, never session state.
export const CONTRACT_FILES = [
  'straddle-setup.md',
  INTEGRATION_PLAN,
  MIGRATION_PLAN,
  'straddle-integration-report.md',
  'straddle-test-evidence.md',
  'straddle-go-live-report.md',
] as const;

// Files the skills themselves write as durable artifacts. The edit gate never blocks these.
export const SKILL_ARTIFACTS = [
  ...CONTRACT_FILES,
  'straddle-plan-visual.html',
  'straddle-audit-report.md',
] as const;

export interface SkillRoute {
  title: string;
  // Handoff statuses that report the step finished; a step ticks only when its file agrees.
  advanceOn: readonly string[];
  // The skill will not run without one of these files in the repository.
  requiresAnyOf: readonly string[];
  // Code edits in the repository are denied until one of these files exists.
  editGate: readonly string[];
  // The skill can send Straddle requests, so missing key or environment is shown as a configuration error first.
  sendsStraddleRequests: boolean;
  // The contract file whose status header says whether this step is done. Skills without one finish on their handoff.
  record?: (typeof CONTRACT_FILES)[number];
}

const ROUTES = {
  'straddle-setup': { title: 'Setup', advanceOn: ['ready', 'ready_with_warnings'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false, record: 'straddle-setup.md' },
  'straddle-plan': { title: 'Plan', advanceOn: ['draft'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false, record: INTEGRATION_PLAN },
  'straddle-integrate': { title: 'Integrate', advanceOn: ['complete'], requiresAnyOf: [INTEGRATION_PLAN], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: true, record: 'straddle-integration-report.md' },
  'straddle-test': { title: 'Test', advanceOn: ['passed', 'failed', 'partial'], requiresAnyOf: [INTEGRATION_PLAN, MIGRATION_PLAN], editGate: [INTEGRATION_PLAN, MIGRATION_PLAN], sendsStraddleRequests: true, record: 'straddle-test-evidence.md' },
  'straddle-get-started': { title: 'Get Started', advanceOn: ['routed', 'needs_input'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false },
  'straddle-migrate': { title: 'Migrate', advanceOn: ['migrated'], requiresAnyOf: [], editGate: [MIGRATION_PLAN], sendsStraddleRequests: false, record: MIGRATION_PLAN },
  'straddle-go-live': { title: 'Go Live', advanceOn: ['ready', 'not_ready'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false, record: 'straddle-go-live-report.md' },
  'straddle-audit': { title: 'Audit', advanceOn: ['findings', 'clean'], requiresAnyOf: [], editGate: ['straddle-audit-report.md'], sendsStraddleRequests: false },
} as const satisfies Record<string, SkillRoute>;

export type SkillName = keyof typeof ROUTES;
export const SKILLS: Record<SkillName, SkillRoute> = ROUTES;

export function isRunnableSkill(name: string): name is SkillName {
  return Object.hasOwn(SKILLS, name);
}

export interface Program {
  skills: readonly SkillName[];
  // Ask products, integration type, SDK and notification path up front.
  asksChoices: boolean;
  purpose: string;
}

export const PROGRAMS = {
  integration: { skills: ['straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test', 'straddle-go-live'], asksChoices: true, purpose: 'Add Straddle Pay by Bank to this app in one agent session: set up, plan, build, test in Sandbox, and check Go Live readiness.' },
  setup: { skills: ['straddle-setup'], asksChoices: true, purpose: 'Check that this repo, your agent, the Straddle plugin, the CLI and your Sandbox configuration are ready.' },
  plan: { skills: ['straddle-plan'], asksChoices: true, purpose: 'Write or refresh straddle-integration-plan.md. No code changes and no Straddle writes.' },
  integrate: { skills: ['straddle-integrate'], asksChoices: false, purpose: 'Build the approved plan, then preview and run its approved Sandbox writes.' },
  test: { skills: ['straddle-test'], asksChoices: false, purpose: 'Test the finished integration against its approved plan in Sandbox and write sanitized evidence.' },
  audit: { skills: ['straddle-audit'], asksChoices: false, purpose: 'Review your existing Straddle integration and report findings with file:line and confidence.' },
  migrate: { skills: ['straddle-migrate'], asksChoices: true, purpose: 'Add Straddle beside your current payment provider. Code only, and additive.' },
  'go-live': { skills: ['straddle-go-live'], asksChoices: false, purpose: 'Review Production readiness. No Production writes.' },
  'get-started': { skills: ['straddle-get-started'], asksChoices: true, purpose: 'Find the Straddle product, integration model, SDK and docs that fit this repo.' },
} as const satisfies Record<string, Program>;

export type ProgramName = keyof typeof PROGRAMS | `skill:${SkillName}`;

export function programFor(name: ProgramName): Program {
  if (!name.startsWith('skill:')) return PROGRAMS[name as keyof typeof PROGRAMS];
  const skill = name.slice('skill:'.length) as SkillName;
  return { skills: [skill], asksChoices: false, purpose: `Run the ${skill} skill directly.` };
}

// The steps a run of this program takes here: the integration program adds Migrate after Plan when the repository
// already uses another payment provider.
export function programSkills(name: ProgramName, providers: readonly string[]): SkillName[] {
  const skills = [...programFor(name).skills];
  if (name === 'integration' && providers.length) skills.splice(skills.indexOf('straddle-plan') + 1, 0, 'straddle-migrate');
  return skills;
}

export function stepTitles(skills: readonly SkillName[]): string {
  return skills.map((s) => SKILLS[s].title).join(' → ');
}
