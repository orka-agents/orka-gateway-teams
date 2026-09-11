import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { receiverConfig } from './ingress-auth.js';

export function setupFiles(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teams-setup-'));
  const challenge = `orka-setup:${randomBytes(16).toString('hex')}`;
  const config = { appId: receiverConfig.appId, tenantId: receiverConfig.tenantId,
    clientSecret: receiverConfig.clientSecret, host: '127.0.0.1', port: 0, timeoutMs: 30000,
    challengeFile: join(directory, 'challenge'), captureFile: join(directory, 'candidate.json') };
  writeFileSync(config.challengeFile, challenge, { mode: 0o600, flag: 'wx' });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, challenge, config };
}

export function setupEnv(config: ReturnType<typeof setupFiles>['config']): NodeJS.ProcessEnv {
  return { TEAMS_APP_ID: config.appId, TEAMS_TENANT_ID: config.tenantId, TEAMS_CLIENT_SECRET: config.clientSecret,
    SETUP_CHALLENGE_FILE: config.challengeFile, SETUP_CAPTURE_FILE: config.captureFile };
}
