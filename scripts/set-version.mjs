import fs from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/set-version.mjs <semver>');
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

const packageJson = readJson('package.json');
packageJson.version = version;
writeJson('package.json', packageJson);

const packageLock = readJson('package-lock.json');
packageLock.version = version;
if (packageLock.packages?.['']) packageLock.packages[''].version = version;
writeJson('package-lock.json', packageLock);

const tauriConfig = readJson('src-tauri/tauri.conf.json');
tauriConfig.version = version;
writeJson('src-tauri/tauri.conf.json', tauriConfig);

const cargoTomlPath = 'src-tauri/Cargo.toml';
const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
const cargoTomlVersion = cargoToml.match(/^(version\s*=\s*")[^"]+("\s*)$/m);
if (!cargoTomlVersion) throw new Error('Cargo.toml package version was not found.');
const nextCargoToml = cargoToml.replace(
  /^(version\s*=\s*")[^"]+("\s*)$/m,
  (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
);
fs.writeFileSync(cargoTomlPath, nextCargoToml);

const cargoLockPath = 'src-tauri/Cargo.lock';
const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
const cargoLockVersion = cargoLock.match(/(\[\[package\]\]\r?\nname = "heyjev"\r?\nversion = ")[^"]+("\r?\n)/);
if (!cargoLockVersion) throw new Error('HeyJev package entry was not found in Cargo.lock.');
const nextCargoLock = cargoLock.replace(
  /(\[\[package\]\]\r?\nname = "heyjev"\r?\nversion = ")[^"]+("\r?\n)/,
  (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
);
fs.writeFileSync(cargoLockPath, nextCargoLock);

console.log(`HeyJev version set to ${version}`);
