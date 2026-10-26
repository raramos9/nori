import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { NoriError } from '../errors.js';
import { parseOrigin } from '../graph/model.js';
import { type IsolatedBrowser, launchIsolatedBrowser, RunRecorder } from './crawl.js';

async function launchWedged(test: TestContext): Promise<{ isolated: IsolatedBrowser; pid: number }> {
  const recorder = new RunRecorder(mkdtempSync(join(tmpdir(), 'nori-wedge-')));
  const isolated = await launchIsolatedBrowser({ origin: parseOrigin('http://127.0.0.1:9'), recorder }).catch((error: unknown) => {
    if (error instanceof NoriError) test.skip('system Chrome is not installed');
    throw error;
  });
  const cdp = await isolated.browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
  const pid = processInfo.find(({ type }) => type === 'browser')!.id;
  process.kill(pid, 'SIGSTOP');
  return { isolated, pid };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('a Chrome that stops answering', () => {
  it('is killed while a call to it is pending, so the call fails instead of hanging', async (test) => {
    const { isolated, pid } = await launchWedged(test);
    await expect(isolated.browser.newContext()).rejects.toThrow();
    await isolated.close();
    expect(isAlive(pid)).toBe(false);
  }, 40_000);

  it('is killed by close, so it cannot outlive the run', async (test) => {
    const { isolated, pid } = await launchWedged(test);
    await isolated.close();
    expect(isAlive(pid)).toBe(false);
  }, 15_000);
});
