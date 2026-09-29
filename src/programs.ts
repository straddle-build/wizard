// Routing data only. What each skill does lives in the versioned skill bundle, never here.

export const INTEGRATION_PLAN = 'straddle-integration-plan.md';
export const MIGRATION_PLAN = 'straddle-migration-plan.md';

// Files the skills themselves write as durable artifacts. The edit gate never blocks these.
export const SKILL_ARTIFACTS = [
  INTEGRATION_PLAN,
  MIGRATION_PLAN,
  'straddle-plan-visual.html',
  'straddle-audit-report.md',
  'straddle-test-evidence.md',
] as const;

export interface SkillRoute {
  title: string;
  // Handoff statuses after which the Wizard offers the next skill in the program.
  advanceOn: readonly string[];
  // The skill will not run without one of these files in the repository.
  requiresAnyOf: readonly string[];
  // Code edits in the repository are denied until one of these files exists.
  editGate: readonly string[];
  // The skill can send Straddle requests, so missing key or environment is shown as a configuration error first.
  sendsStraddleRequests: boolean;
}

export const SKILLS = {
  'straddle-setup': { title: 'Setup', advanceOn: ['ready', 'ready_with_warnings'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false },
  'straddle-plan': { title: 'Plan', advanceOn: ['draft'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false },
  'straddle-integrate': { title: 'Integrate', advanceOn: ['complete'], requiresAnyOf: [INTEGRATION_PLAN], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: true },
  'straddle-test': { title: 'Test', advanceOn: ['passed', 'failed', 'partial'], requiresAnyOf: [INTEGRATION_PLAN, MIGRATION_PLAN], editGate: [INTEGRATION_PLAN, MIGRATION_PLAN], sendsStraddleRequests: true },
  'straddle-get-started': { title: 'Get Started', advanceOn: ['routed', 'needs_input'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false },
  'straddle-migrate': { title: 'Migrate', advanceOn: ['migrated', 'awaiting_approval'], requiresAnyOf: [], editGate: [MIGRATION_PLAN], sendsStraddleRequests: false },
  'straddle-go-live': { title: 'Go Live', advanceOn: ['ready', 'not_ready'], requiresAnyOf: [], editGate: [INTEGRATION_PLAN], sendsStraddleRequests: false },
  'straddle-audit': { title: 'Audit', advanceOn: ['findings', 'clean'], requiresAnyOf: [], editGate: ['straddle-audit-report.md'], sendsStraddleRequests: false },
} as const satisfies Record<string, SkillRoute>;

export type SkillName = keyof typeof SKILLS;

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
  integration: { skills: ['straddle-setup', 'straddle-plan', 'straddle-integrate', 'straddle-test'], asksChoices: true, purpose: 'Add Straddle Pay by Bank to this repository with your local coding agent.' },
  setup: { skills: ['straddle-setup'], asksChoices: true, purpose: 'Check that this repository, your agent, the Straddle plugin, CLI and configuration are ready.' },
  plan: { skills: ['straddle-plan'], asksChoices: true, purpose: 'Write or refresh straddle-integration-plan.md. No code changes and no remote writes.' },
  integrate: { skills: ['straddle-integrate'], asksChoices: false, purpose: 'Implement the approved plan, then preview and run its approved Sandbox writes.' },
  test: { skills: ['straddle-test'], asksChoices: false, purpose: 'Verify the finished integration against its approved plan and write sanitized evidence.' },
  audit: { skills: ['straddle-audit'], asksChoices: false, purpose: 'Review the existing Straddle integration and report findings with file:line and confidence.' },
  migrate: { skills: ['straddle-migrate'], asksChoices: true, purpose: 'Add Straddle beside your current payment provider, code only and additive.' },
  'go-live': { skills: ['straddle-go-live'], asksChoices: false, purpose: 'Review production readiness. No production writes.' },
  'get-started': { skills: ['straddle-get-started'], asksChoices: true, purpose: 'Orient: which Straddle product, integration model, SDK and docs fit this repository.' },
} as const satisfies Record<string, Program>;

export type ProgramName = keyof typeof PROGRAMS | `skill:${SkillName}`;

export function programFor(name: ProgramName): Program {
  if (!name.startsWith('skill:')) return PROGRAMS[name as keyof typeof PROGRAMS];
  const skill = name.slice('skill:'.length) as SkillName;
  return { skills: [skill], asksChoices: false, purpose: `Run the ${skill} skill directly.` };
}

export function programLabel(name: ProgramName): string {
  return programFor(name).skills.map((s) => SKILLS[s].title).join(' → ');
}
