import { symlink } from 'node:fs/promises';
import type { TestContext } from 'node:test';

type CreateLink = (target: string, path: string, type: 'file') => Promise<void>;
type Options = { platform?: NodeJS.Platform; create?: CreateLink };
const unavailableOnWindows = new Set(['EPERM', 'EACCES', 'ENOTSUP']);

/** Only call from a dedicated file-link test, after creating its ordinary files.
 * Directory-junction and general HTTP checks must remain separate, mandatory tests.
 * Injection is confined to this test helper so its narrow skip policy is testable.
 */
export async function createFileSymlinkFixture(context: Pick<TestContext, 'skip'>, target: string, path: string,
  options: Options = {}): Promise<boolean> {
  try {
    await (options.create ?? symlink)(target, path, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if ((options.platform ?? process.platform) !== 'win32' || !code || !unavailableOnWindows.has(code)) throw error;
    context.skip(`Windows file symlink fixture unavailable (${code}); file-link boundary assertions were not executed. Directory-junction and ordinary path checks run separately.`);
    return false;
  }
}
