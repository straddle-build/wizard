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

  const declared = env.STRADDLE_ENVIRONMENT?.trim();
  const baseUrl = env.STRADDLE_BASE_URL?.trim();
  let environment: string;
  if (declared === 'sandbox' || baseUrl === 'https://sandbox.straddle.com') {
    environment = `sandbox (${declared === 'sandbox' ? 'STRADDLE_ENVIRONMENT' : 'STRADDLE_BASE_URL'})`;
  } else if (baseUrl && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseUrl)) {
    environment = `offline synthetic target ${baseUrl} (the skill checks its conditions)`;
  } else if (declared) {
    environment = `${declared} (STRADDLE_ENVIRONMENT)`;
    errors.push(`STRADDLE_ENVIRONMENT is ${declared}, not sandbox`);
  } else if (baseUrl) {
    environment = `${baseUrl} (STRADDLE_BASE_URL)`;
    errors.push(`STRADDLE_BASE_URL is ${baseUrl}, not the Sandbox host`);
  } else {
    environment = 'not declared';
    errors.push('no environment is declared (STRADDLE_ENVIRONMENT=sandbox)');
  }
  return { key, environment, errors };
}
