import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Read package.json for default name
let pkgName = 'source-code';
let pkgVersion = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  if (pkg.name) pkgName = pkg.name;
  if (pkg.version) pkgVersion = pkg.version;
} catch (_) {}

// Parse arguments
const args = process.argv.slice(2);
const isFastMode = args.includes('--fast');
let outputFile = args.find(a => !a.startsWith('--')) || `${pkgName}-v${pkgVersion}-source.zip`;
if (!outputFile.endsWith('.zip')) {
  outputFile += '.zip';
}

const outputPath = path.resolve(projectRoot, outputFile);

// Clean previous zip file if present
if (existsSync(outputPath)) {
  try {
    unlinkSync(outputPath);
  } catch (_) {}
}

const startTime = performance.now();

console.log(`📦 Zipping repository source code...`);
console.log(`📁 Target: ${outputFile}`);

let success = false;
let fileCount = 0;

// Method 1: Git ls-files + tar (Complete source: tracked + untracked unignored files, excluding zip files)
if (!isFastMode) {
  try {
    const lsFiles = execSync('git ls-files -co --exclude-standard', { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const fileList = lsFiles
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.endsWith('.zip') && line !== outputFile);
    
    fileCount = fileList.length;

    if (fileCount > 0) {
      const inputBuffer = fileList.join('\n');
      const tarResult = spawnSync('tar', ['-a', '-cf', outputPath, '-T', '-'], {
        cwd: projectRoot,
        input: inputBuffer,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (tarResult.status === 0 && existsSync(outputPath)) {
        success = true;
      }
    }
  } catch (_) {}
}

// Method 2: Git archive (~80-120ms ultra-fast C-native zip via Git)
if (!success) {
  try {
    let commit = 'HEAD';
    try {
      const stashCommit = execSync('git stash create', { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (stashCommit) commit = stashCommit;
    } catch (_) {}

    execSync(`git archive -o "${outputPath}" ${commit}`, { cwd: projectRoot, stdio: 'ignore' });
    if (existsSync(outputPath)) {
      success = true;
      try {
        const archivedFiles = execSync(`git ls-tree -r --name-only ${commit}`, { cwd: projectRoot, encoding: 'utf8' });
        fileCount = archivedFiles.split(/\r?\n/).filter(line => line.trim() && !line.endsWith('.zip')).length;
      } catch (_) {}
    }
  } catch (err) {
    console.error('Failed to create zip:', err.message);
  }
}

const endTime = performance.now();
const durationMs = (endTime - startTime).toFixed(1);

if (success && existsSync(outputPath)) {
  const stats = statSync(outputPath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  const sizeKB = (stats.size / 1024).toFixed(1);
  const displaySize = stats.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  console.log(`\n✨ Success!`);
  console.log(`📄 Path: ${outputPath}`);
  console.log(`📊 Size: ${displaySize} (${stats.size.toLocaleString()} bytes)`);
  if (fileCount > 0) console.log(`📑 Files: ${fileCount}`);
  console.log(`⚡ Time: ${durationMs} ms`);
} else {
  console.error(`\n❌ Failed to generate zip file.`);
  process.exit(1);
}
