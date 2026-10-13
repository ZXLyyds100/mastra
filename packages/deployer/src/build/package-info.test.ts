import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPackageInfo, getPackageMetadata, getPackageRootPath } from './package-info';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function createTempPackage() {
  const tempRoot = join(process.cwd(), '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, 'package-root-'));
  tempDirs.push(tempDir);

  const packageDir = join(tempDir, 'node_modules', '@mastra', 'core');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@mastra/core', version: '1.0.0' }));
  const chunkFile = join(packageDir, 'dist', 'chunk-ABC.js');
  await writeFile(chunkFile, 'export {};');

  return { tempDir, packageDir, chunkFile };
}

async function createWorkspacePackage(version: string | undefined, nestedManifest = false) {
  const tempRoot = join(process.cwd(), '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, 'workspace-package-'));
  tempDirs.push(tempDir);

  const appDir = join(tempDir, 'app');
  const packageDir = join(tempDir, 'packages', 'dependency');
  const entryDir = join(packageDir, nestedManifest ? 'dist' : 'src');
  const entry = nestedManifest ? './dist/index.js' : './src/index.ts';
  await mkdir(join(appDir, 'node_modules', '@repro'), { recursive: true });
  await mkdir(entryDir, { recursive: true });
  await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'workspace-root', version: '1.0.0' }));
  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify({ name: '@repro/app', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
  );
  await writeFile(join(appDir, 'index.js'), "import '@repro/dependency';");
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@repro/dependency', private: true, version, type: 'module', exports: { '.': entry } }),
  );
  await writeFile(join(packageDir, entry), 'export const value = 42;');
  if (nestedManifest) {
    await writeFile(join(entryDir, 'package.json'), JSON.stringify({ type: 'module' }));
  }
  await symlink(packageDir, join(appDir, 'node_modules', '@repro', 'dependency'), 'junction');

  return { appDir, packageDir };
}

describe('getPackageInfo', () => {
  const versions = [
    { label: 'versionless', version: undefined },
    { label: 'versioned', version: '1.0.0' },
  ];

  it.each(versions)('retains the root of a $label workspace package', async ({ version }) => {
    const { appDir, packageDir } = await createWorkspacePackage(version);
    const parentPath = join(appDir, 'index.js');

    await expect(getPackageInfo('@repro/dependency', { paths: [appDir] })).resolves.toMatchObject({
      name: '@repro/dependency',
      rootPath: packageDir,
      packageJson: { name: '@repro/dependency', exports: { '.': './src/index.ts' } },
    });
    await expect(getPackageRootPath('@repro/dependency', parentPath)).resolves.toBe(packageDir);
    await expect(getPackageMetadata('@repro/dependency', parentPath)).resolves.toMatchObject({
      rootPath: packageDir,
      ...(version ? { version } : {}),
    });
  });

  it.each(versions)('searches past a nameless nested manifest for a $label package', async ({ version }) => {
    const { appDir, packageDir } = await createWorkspacePackage(version, true);

    await expect(getPackageInfo('@repro/dependency', { paths: [appDir] })).resolves.toMatchObject({
      name: '@repro/dependency',
      rootPath: packageDir,
      packageJson: { name: '@repro/dependency', exports: { '.': './dist/index.js' } },
    });
  });
});

describe('getPackageRootPath', () => {
  it('resolves a package when parentPath points to a file instead of a directory', async () => {
    const { packageDir, chunkFile } = await createTempPackage();

    await expect(getPackageRootPath('@mastra/core', chunkFile)).resolves.toBe(packageDir);
  });

  it('resolves the package copy installed for the app', async () => {
    const tempRoot = join(process.cwd(), '.tmp');
    await mkdir(tempRoot, { recursive: true });
    const tempDir = await mkdtemp(join(tempRoot, 'package-copy-'));
    tempDirs.push(tempDir);

    // An older copy hoisted to the top level, like a transitive dependency of another package.
    const hoistedDir = join(tempDir, 'node_modules', 'plain-pkg');
    await mkdir(hoistedDir, { recursive: true });
    await writeFile(join(hoistedDir, 'package.json'), JSON.stringify({ name: 'plain-pkg', version: '1.0.0' }));
    await writeFile(join(hoistedDir, 'index.js'), 'export {};');

    // The copy the app uses has no exports map.
    const appDir = join(tempDir, 'app');
    const installedDir = join(appDir, 'node_modules', 'plain-pkg');
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, 'package.json'),
      JSON.stringify({
        name: 'plain-pkg',
        version: '9.0.0',
        type: 'module',
      }),
    );
    await writeFile(join(installedDir, 'index.js'), 'export {};');
    const appEntry = join(appDir, 'index.js');
    await writeFile(appEntry, `import 'plain-pkg';`);

    await expect(getPackageRootPath('plain-pkg', appEntry)).resolves.toBe(installedDir);
    await expect(getPackageMetadata('plain-pkg', appEntry)).resolves.toMatchObject({ version: '9.0.0' });
  });

  it('returns an absolute path when parentPath is not absolute', async () => {
    const { packageDir, chunkFile } = await createTempPackage();
    const relativeChunkFile = relative(process.cwd(), chunkFile);

    const rootPath = await getPackageRootPath('@mastra/core', relativeChunkFile);

    expect(rootPath && isAbsolute(rootPath)).toBe(true);
    expect(rootPath).toBe(packageDir);
  });

  it('does not log ENOTDIR errors for unresolvable packages when parentPath is a file', async () => {
    const { chunkFile } = await createTempPackage();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // local-pkg logs non-MODULE_NOT_FOUND resolution errors (like ENOTDIR) to the console.
    // Passing a module file path as the resolution base must not trigger that.
    await expect(getPackageRootPath('mastra-nonexistent-package', chunkFile)).resolves.toBeNull();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('getPackageMetadata', () => {
  it('falls back from a package subpath to the package root metadata', async () => {
    const tempRoot = join(process.cwd(), '.tmp');
    await mkdir(tempRoot, { recursive: true });
    const tempDir = await mkdtemp(join(tempRoot, 'package-metadata-'));
    tempDirs.push(tempDir);

    const packageDir = join(tempDir, 'node_modules', 'date-fns');
    await mkdir(join(packageDir, 'esm', 'endOfDay'), { recursive: true });
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'date-fns', version: '2.30.0', type: 'module', main: './index.js' }),
    );
    await writeFile(join(packageDir, 'esm', 'endOfDay', 'index.js'), `export const endOfDay = () => {};`);

    await expect(getPackageMetadata('date-fns/esm/endOfDay/index.js', tempDir)).resolves.toMatchObject({
      version: '2.30.0',
      packageSpec: undefined,
    });
  });
});
