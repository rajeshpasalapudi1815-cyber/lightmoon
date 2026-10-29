// Builds the LightMoon Android app.
//   node scripts/android.mjs setup   one time: create the Android project, accept SDK licences, install SDK packages
//   node scripts/android.mjs build   build the app file (APK) into dist/LightMoon.apk
// Needs Java 21 (Microsoft OpenJDK) and Google's Android command-line tools in %LOCALAPPDATA%\Android\Sdk.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const android = path.join(root, 'android');
const jdkParent = 'C:\\Program Files\\Microsoft';
const jdk = fs.existsSync(jdkParent) ? fs.readdirSync(jdkParent).find(name => name.startsWith('jdk-21')) : null;

// Windows names it Path, other systems PATH: keep exactly one, with the Java and Android tools first.
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path';
const systemPath = env[pathKey];
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
if (jdk) env.JAVA_HOME = path.join(jdkParent, jdk);
env.ANDROID_HOME = env.ANDROID_SDK_ROOT = path.join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const sdkmanager = path.join(env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
env.Path = [
  path.join(env.JAVA_HOME ?? '', 'bin'),
  path.join(env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin'),
  path.join(env.ANDROID_HOME, 'platform-tools'),
  systemPath,
].join(';');

function run(command, args, { cwd = root, input } = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: true,
    input,
    stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`);
}

// Google's Android command-line tools (sdkmanager), downloaded into the SDK folder if missing.
const CMDLINE_TOOLS_URL = 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip';

function installCommandLineTools() {
  if (fs.existsSync(sdkmanager)) return;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lightmoon-cmdline-'));
  const zip = path.join(work, 'cmdline-tools.zip');
  run('curl.exe', ['-L', '--fail', '-o', `"${zip}"`, CMDLINE_TOOLS_URL]);
  run('tar.exe', ['-xf', `"${zip}"`, '-C', `"${work}"`]);
  const target = path.join(env.ANDROID_HOME, 'cmdline-tools', 'latest');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(work, 'cmdline-tools'), target);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Installed the Android command-line tools in ${target}`);
}

function setup() {
  console.log(`JAVA_HOME=${env.JAVA_HOME}\nANDROID_HOME=${env.ANDROID_HOME}`);
  installCommandLineTools();
  if (!fs.existsSync(path.join(android, 'app'))) run('npx', ['cap', 'add', 'android']);
  const variables = fs.readFileSync(path.join(android, 'variables.gradle'), 'utf8');
  const compileSdk = variables.match(/compileSdkVersion\s*=\s*(\d+)/)[1];
  const minSdk = variables.match(/minSdkVersion\s*=\s*(\d+)/)[1];
  console.log(`compileSdk=${compileSdk} minSdk=${minSdk}`);
  run(`"${sdkmanager}"`, ['--licenses'], { input: 'y\n'.repeat(30) });
  run(`"${sdkmanager}"`, ['--install', '"platform-tools"', `"platforms;android-${compileSdk}"`, `"build-tools;${compileSdk}.0.0"`]);
  fs.writeFileSync(path.join(android, 'local.properties'), `sdk.dir=${env.ANDROID_HOME.replace(/\\/g, '\\\\')}\n`);
  console.log('\nSETUP DONE');
}

// The release key (in %USERPROFILE%\.android\release, see its README.txt) plus its hand-over from the old test
// key: Android 13+ takes the app as an update of earlier versions, keeping its data (key rotation, APK Signature
// Scheme v3.1); older Androids still see the test key. Once a phone has such a version, every later one must be
// signed this way, so there is no falling back to the test key while the folder exists.
const RELEASE_KEYS = path.join(os.homedir(), '.android', 'release');

function signWithReleaseKey(apk, alias) {
  if (!fs.existsSync(path.join(RELEASE_KEYS, 'release.p12'))) {
    console.log(`\nNo release keys in ${RELEASE_KEYS}: the app is signed with the test key only.`);
    return;
  }
  const buildTools = path.join(env.ANDROID_HOME, 'build-tools');
  const latest = fs.readdirSync(buildTools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const apksigner = `"${path.join(buildTools, latest, 'apksigner.bat')}"`;
  const key = file => `"${path.join(RELEASE_KEYS, file)}"`;
  const signed = `${apk}.signed`;
  run(apksigner, [
    'sign', '--ks', key('debug-original.keystore'), '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android',
    '--next-signer', '--ks', key('release.p12'), '--ks-key-alias', alias, '--ks-pass', `file:${key('keystore-password.txt')}`,
    '--lineage', key(`${alias}.lineage`), '--out', `"${signed}"`, `"${apk}"`,
  ]);
  fs.renameSync(signed, apk);
  fs.rmSync(`${signed}.idsig`, { force: true });
  run(apksigner, ['verify', `"${apk}"`]);
  console.log(`Signed with the release key "${alias}" (and the hand-over from the test key).`);
}

function build() {
  run('npx', ['cap', 'sync', 'android']);
  run(`"${path.join(android, 'gradlew.bat')}"`, ['assembleDebug', '--console=plain'], { cwd: android });
  const apk = path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const target = path.join(root, 'dist', 'LightMoon.apk');
  fs.copyFileSync(apk, target);
  signWithReleaseKey(target, 'lightmoon');
  console.log(`\nBUILD DONE: dist/LightMoon.apk (${(fs.statSync(target).size / 1_048_576).toFixed(1)} MB)`);
}

const task = process.argv[2];
try {
  if (task === 'setup') setup();
  else if (task === 'build') build();
  else console.log('Usage: node scripts/android.mjs setup|build');
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
}
