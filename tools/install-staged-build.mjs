import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Install new build files without copying old files or deleting unrelated data. */
export function installStagedBuild(projectRoot, buildDirectory, protectedDirectories = []) {
  const root = fs.realpathSync(projectRoot);
  const stage = path.resolve(buildDirectory);
  const output = path.join(root, 'output');
  const dist = path.join(root, 'dist');
  if (path.relative(output, path.dirname(stage)) !== '' || !/^deploy-build-[a-zA-Z0-9-]+$/.test(path.basename(stage))) {
    throw new Error('The build must be a dedicated output/deploy-build-* staging directory.');
  }
  const inspectParents = (target, leafIsFile) => {
    const parts = path.relative(root, target).split(path.sep);
    let cursor = root;
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index]);
      const info = fs.lstatSync(cursor, { throwIfNoEntry: false });
      if (!info) continue;
      if (info.isSymbolicLink()) throw new Error(`Refusing a linked build path: ${cursor}`);
      const expectFile = leafIsFile && index === parts.length - 1;
      if (expectFile ? !info.isFile() : !info.isDirectory()) throw new Error(`Unexpected build path type: ${cursor}`);
    }
  };
  inspectParents(stage, false);
  const protectedRoots = [path.join(root, 'project-data'), ...protectedDirectories.filter(Boolean).map(value => path.resolve(root, value))]
    .flatMap(directory => fs.existsSync(directory) ? [directory, fs.realpathSync(directory)] : [directory]);
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing a linked staged file: ${source}`);
      if (entry.isDirectory()) visit(source);
      else if (entry.isFile()) files.push(path.relative(stage, source));
      else throw new Error(`Unexpected staged file type: ${source}`);
    }
  };
  visit(stage);
  if (!files.includes('index.html')) throw new Error('The staged build has no index.html.');
  // Validate every destination before writing any new file. Old unmatched files
  // stay in place; a code backup cannot recover user data stored inside dist.
  for (const relative of files) {
    const destination = path.join(dist, relative);
    if (protectedRoots.some(protectedRoot => within(protectedRoot, destination) || within(destination, protectedRoot))) {
      throw new Error(`The new build would overwrite a data directory: ${destination}`);
    }
    inspectParents(destination, true);
  }
  files.sort((a, b) => Number(a.endsWith('.html')) - Number(b.endsWith('.html')) || a.localeCompare(b));
  for (const relative of files) {
    const destination = path.join(dist, relative);
    inspectParents(destination, true);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(stage, relative), destination);
  }
  // This is only the newly generated build, never a copy of the old deployment.
  fs.rmSync(stage, { recursive: true });
  return { installedFiles: files.length, dist };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [root, stage] = process.argv.slice(2);
    if (!root || !stage) throw new Error('Usage: install-staged-build.mjs <project-root> <build-directory>');
    const protectedDirectories = ['CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR'].map(key => process.env[key]);
    console.log(JSON.stringify(installStagedBuild(root, stage, protectedDirectories)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
