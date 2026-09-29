// Straddle configuration as the developer's shell declares it. Presence only: the key value is never read into
// Wizard state, printed or stored.

export interface StraddleConfiguration {
  key: 'present' | 'missing';
  environment: string;
  // Each entry blocks every Straddle request by the skills that send them.
  errors: string[];
}

export function straddleConfiguration(env: NodeJS.ProcessEnv): StraddleConfiguration {
  const errors: string[] = [];
  const key = env.STRADDLE_API_KEY ? 'present' : 'missing';
  if (key === 'missing') errors.push('STRADDLE_API_KEY is not set');

  const declared = env.STRADDLE_ENVIRONMENT?.trim() || undefined;
  const baseUrl = env.STRADDLE_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
  // The Straddle CLI and SDKs send requests to STRADDLE_BASE_URL when it is set, whatever STRADDLE_ENVIRONMENT says,
  // so the base URL is the target and a different declared environment is a conflict, never resolved toward Sandbox.
  let environment: string;
  if (baseUrl) {
    const sandbox = baseUrl === 'https://sandbox.straddle.com';
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseUrl);
    environment = sandbox ? 'sandbox (STRADDLE_BASE_URL)' : local ? `offline synthetic target ${baseUrl} (the skill checks its conditions)` : `${baseUrl} (STRADDLE_BASE_URL)`;
    if (!sandbox && !local) errors.push(`STRADDLE_BASE_URL is ${baseUrl}, not the Sandbox host`);
    if (declared && (declared === 'sandbox') !== (sandbox || local)) {
      environment = `conflicting: STRADDLE_ENVIRONMENT is ${declared}, STRADDLE_BASE_URL is ${baseUrl}`;
      errors.push(`STRADDLE_ENVIRONMENT (${declared}) and STRADDLE_BASE_URL (${baseUrl}) disagree`);
    }
  } else if (declared === 'sandbox') {
    environment = 'sandbox (STRADDLE_ENVIRONMENT)';
  } else if (declared) {
    environment = `${declared} (STRADDLE_ENVIRONMENT)`;
    errors.push(`STRADDLE_ENVIRONMENT is ${declared}, not sandbox`);
  } else {
    environment = 'not declared';
    errors.push('no environment is declared (STRADDLE_ENVIRONMENT=sandbox)');
  }
  return { key, environment, errors };
}
