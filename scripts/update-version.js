#!/usr/bin/env node
/**
 * Usage (project root):
 *   pnpm run ver -- 1.2.3
 *   pnpm run ver -- patch|minor|major
 *   NEW_VERSION=1.2.3 pnpm run ver
 */

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function isValidSemver(value) {
    return /^\d+\.\d+\.\d+$/.test(value);
}

function parseSemver(value) {
    if (!isValidSemver(value)) throw new Error(`Version is not x.y.z: ${value}`);
    return value.split('.').map(part => BigInt(part));
}

function compareSemver(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    for (let index = 0; index < 3; index++) {
        if (a[index] < b[index]) return -1;
        if (a[index] > b[index]) return 1;
    }
    return 0;
}

function bumpVersion(current, part) {
    const [major, minor, patch] = parseSemver(current);
    if (part === 'major') return `${major + 1n}.0.0`;
    if (part === 'minor') return `${major}.${minor + 1n}.0`;
    if (part === 'patch') return `${major}.${minor}.${patch + 1n}`;
    throw new Error(`Unknown version bump: ${part}`);
}

(function main() {
    const aliases = { a: 'major', b: 'minor', c: 'patch' };
    const resolve = value => aliases[value] || value;
    const requestedRaw = process.argv.slice(2)[0] ?? process.env.NEW_VERSION;
    if (!requestedRaw) {
        console.error('Provide x.y.z or major/minor/patch explicitly.');
        process.exit(1);
    }

    const requested = resolve(requestedRaw);
    const bumpOptions = new Set(['major', 'minor', 'patch']);
    const cwd = process.cwd();
    const packagePath = path.join(cwd, 'package.json');
    const manifestPath = path.join(cwd, 'manifest.json');
    const versionsPath = path.join(cwd, 'versions.json');

    try {
        const packageJson = readJson(packagePath);
        const manifest = readJson(manifestPath);
        const versions = readJson(versionsPath);

        if (!isValidSemver(packageJson.version) || !isValidSemver(manifest.version) || packageJson.version !== manifest.version) {
            throw new Error(`Current version metadata is inconsistent: package=${packageJson.version} manifest=${manifest.version}`);
        }
        if (!isValidSemver(manifest.minAppVersion)) {
            throw new Error(`manifest.minAppVersion is not x.y.z: ${manifest.minAppVersion}`);
        }
        if (versions[packageJson.version] !== manifest.minAppVersion) {
            throw new Error(`versions.json is inconsistent for current version ${packageJson.version}`);
        }

        const target = bumpOptions.has(requested) ? bumpVersion(packageJson.version, requested) : requested;
        if (!isValidSemver(target)) throw new Error(`Invalid target version: ${target}`);
        if (compareSemver(target, packageJson.version) <= 0) {
            throw new Error(`Target version must be greater than ${packageJson.version}`);
        }
        if (Object.hasOwn(versions, target)) throw new Error(`versions.json already contains ${target}`);

        const nextPackage = { ...packageJson, version: target };
        const nextManifest = { ...manifest, version: target };
        const nextVersions = { ...versions, [target]: manifest.minAppVersion };

        writeJson(packagePath, nextPackage);
        writeJson(manifestPath, nextManifest);
        writeJson(versionsPath, nextVersions);
        console.log(`Version: ${packageJson.version} -> ${target}`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
})();
