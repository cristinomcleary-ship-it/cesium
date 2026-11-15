// Portable synthetic Python regression entry; never starts a production service.
// PYTHON_EXECUTABLE selects an existing virtual environment without editing it.
import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3');
const env = { ...process.env, PYTHONPATH: [root, resolve(root, 'video_ar_backend'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
let failed = false;
for (const directory of ['ar_v2/tests', 'video_ar_backend/tests']) {
  console.log(`Python regression: ${directory}`);
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', directory, '-v'], { cwd: root, env, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Python regression stopped by ${result.signal}`);
  failed ||= result.status !== 0;
}
process.exitCode = failed ? 1 : 0;
