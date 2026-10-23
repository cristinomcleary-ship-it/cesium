import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'cristinomcleary-ship-it/cesium';
const expectedUrl = `https://github.com/${repository}`;

function sameRepository(value) {
  const normalized = value.trim().replace(/\/$/, '')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '');
  return normalized.toLowerCase() === expectedUrl;
}

function nativeGit(args, projectRoot) {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Creates and verifies a GitHub ref for an already reviewed, clean commit.
 * No local backups, automatic commits, stashes or file copies are created.
 * Ignored data and external assets are not included in this code-only backup.
 */
export function createGithubCodeBackup(projectRoot, expectedCommit, {
  runGit = nativeGit,
  now = () => new Date(),
  randomId = randomUUID,
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw new Error('An existing project path is required.');
  if (typeof expectedCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(expectedCommit)) throw new Error('A full expected commit SHA is required.');
  const sha = expectedCommit.toLowerCase();
  const git = (...args) => {
    try { return String(runGit(args, projectRoot)).trim(); }
    catch {
      // Native stderr may contain a credential-bearing URL. Do not echo it.
      throw new Error(`GitHub code backup stopped: git ${args[0]} failed. Check repository access and Git authentication; no source update was performed.`);
    }
  };
  for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
    const urls = git(...args).split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || !sameRepository(urls[0])) {
      throw new Error(`Origin must have exactly one fetch URL and one push URL for ${repository}. No backup was pushed.`);
    }
  }
  const verifyLocalState = () => {
    if (git('status', '--porcelain=v1', '--untracked-files=all')) {
      throw new Error('Working tree is not clean. Review and commit only intended code before creating its GitHub backup; no local backup or automatic commit was made.');
    }
    if (git('rev-parse', 'HEAD').toLowerCase() !== sha) {
      throw new Error('Local HEAD changed or differs from the expected commit. Stop and review it before deployment.');
    }
  };
  verifyLocalState();
  const timestamp = now().toISOString().replace(/[-:.]/g, '');
  const id = randomId();
  if (!/^[0-9a-z-]+$/i.test(id)) throw new Error('Invalid generated backup identifier.');
  const branch = `backup/local-deploy/${timestamp}-${id}`;
  const ref = `refs/heads/${branch}`;
  if (git('ls-remote', '--heads', 'origin', ref)) {
    throw new Error('The generated backup ref already exists. It was not updated; retry to generate a new unique name.');
  }
  verifyLocalState();
  // An empty lease means the ref MUST NOT exist. Unlike a plain push after an
  // ls-remote check, this also refuses a ref created by someone during the gap.
  // The only destination is the newly generated backup ref, never the work branch.
  git('push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`);
  const actual = git('ls-remote', '--heads', 'origin', ref);
  const lines = actual.split(/\r?\n/);
  const match = lines.length === 1 && lines[0].match(/^([0-9a-f]{40})\s+(\S+)$/i);
  if (!match || match[1].toLowerCase() !== sha || match[2] !== ref) {
    throw new Error('The GitHub backup SHA could not be verified. Stop deployment and inspect the remote backup ref.');
  }
  verifyLocalState();
  return { branch, sha, url: `${expectedUrl}/tree/${branch}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node github-code-backup.mjs <project-root> <expected-sha>');
    process.stdout.write(`${JSON.stringify(createGithubCodeBackup(process.argv[2], process.argv[3]))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'GitHub code backup failed.'}\n`);
    process.exitCode = 1;
  }
}
