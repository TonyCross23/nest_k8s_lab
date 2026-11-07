const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/minikube-images.sh');
const images = ['nest-api:latest', 'nest-migrate:latest', 'postgres:17-bookworm'];

// These command doubles exercise archive transfer and failure handling without
// a cluster. They do not claim to verify Kubernetes rollout or networking.
const commandDouble = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.IMAGE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath));
state.calls.push([tool, ...args]);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const stop = (message) => { save(); console.error(message); process.exit(1); };
const runPython = (code, ...values) => {
  const result = spawnSync('python3', ['-c', code, ...values], {encoding: 'utf8'});
  if (result.status !== 0) stop(result.stderr);
  return result.stdout.trim();
};
if (tool === 'sleep') { save(); process.exit(0); }
if (tool === 'docker') {
  if (args[0] === 'info') { save(); process.exit(0); }
  if (args[0] === 'context') { save(); console.log('test-context'); process.exit(0); }
  if (args[0] === 'image' && args[1] === 'inspect') {
    save(); process.exit(state.host.includes(args.at(-1)) ? 0 : 1);
  }
  if (args[0] === 'build' || args[0] === 'pull') {
    const image = args[0] === 'build' ? args[args.indexOf('-t') + 1] : args.at(-1);
    state.attempts[image] = (state.attempts[image] || 0) + 1;
    if (state.attempts[image] <= (state.failures[image] || 0)) stop('auth.docker.io: TLS handshake timeout');
    if (!state.host.includes(image)) state.host.push(image);
    state.revisions[image] = (state.revisions[image] || 0) + 1;
    save(); process.exit(0);
  }
  if (args[0] === 'image' && args[1] === 'save') {
    const archive = args[args.indexOf('--output') + 1];
    const image = args.at(-1);
    const config = JSON.stringify({image, revision: state.revisions[image] || 0});
    const digest = crypto.createHash('sha256').update(config).digest('hex');
    const code = [
      'import io,json,sys,tarfile',
      'archive,image,config,digest=sys.argv[1:]',
      'config_path="blobs/sha256/"+digest',
      'manifest=json.dumps([{"Config":config_path,"RepoTags":[image],"Layers":[]}])',
      'with tarfile.open(archive,"w") as tar:',
      ' for name,data in [("manifest.json",manifest),(config_path,config)]:',
      '  payload=data.encode(); info=tarfile.TarInfo(name); info.size=len(payload); tar.addfile(info,io.BytesIO(payload))',
    ].join('\n');
    runPython(code, archive, image, config, digest);
    state.archives[archive] = {image, id: 'sha256:' + digest};
    save(); process.exit(0);
  }
}
if (tool === 'minikube') {
  if (args[2] === 'status') {
    if (state.profileMissing) stop('Profile not found');
    save(); console.log('host: Running'); process.exit(0);
  }
  if (args[2] === 'image' && args[3] === 'load') {
    const record = state.archives[args[4]];
    if (!record || !fs.existsSync(args[4])) stop('Archive missing');
    if (state.loadFailure === record.image) stop('ctr import failed');
    if (state.silentFailure !== record.image) {
      state.node[record.image] = state.staleImage === record.image ? 'sha256:outdated' : record.id;
    }
    save(); process.exit(0);
  }
  if (args[2] === 'ssh') {
    const image = args.at(-1).match(/docker\.io\/library\/([^' ]+)/)?.[1];
    if (!state.node[image]) stop('no such image present');
    save(); process.stdout.write(state.node[image] + '\r\n'); process.exit(0);
  }
}
stop('Unexpected command: ' + tool + ' ' + args.join(' '));
`;

function run(t, options = {}, args = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image tests '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const archives = path.join(directory, 'archives');
  fs.mkdirSync(bin);
  fs.mkdirSync(archives);
  for (const tool of ['docker', 'minikube', 'sleep']) {
    fs.writeFileSync(path.join(bin, tool), commandDouble, { mode: 0o755 });
  }
  const statePath = path.join(directory, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    host: [...images], node: {}, calls: [], attempts: {}, failures: {},
    revisions: {}, archives: {}, ...options,
  }));
  const result = spawnSync('bash', [script, ...args], {
    cwd: directory,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: archives, IMAGE_TEST_STATE: statePath },
    encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(result.error);
  assert.deepEqual(fs.readdirSync(archives), [], 'temporary archives must be removed on success or failure');
  return { ...result, state: JSON.parse(fs.readFileSync(statePath)) };
}

test('reuses host images, loads archives, and verifies every node image', (t) => {
  const result = run(t, {}, ['--profile', 'test-profile']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All three images verified in Minikube profile test-profile/);
  assert.equal(Object.keys(result.state.node).length, 3);
  assert.equal(result.state.calls.filter(([tool, command]) => tool === 'docker' && ['build', 'pull'].includes(command)).length, 0);
  const loads = result.state.calls.filter(([tool, , , command]) => tool === 'minikube' && command === 'image');
  assert.equal(loads.length, 3);
  assert.ok(loads.every((call) => call[4] === 'load' && call[5].endsWith('.tar') && !call.includes('--daemon')));
});

test('builds missing images from the repository and retries a temporary host pull failure', (t) => {
  const result = run(t, { host: [], failures: { 'postgres:17-bookworm': 1 } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.attempts['postgres:17-bookworm'], 2);
  const builds = result.state.calls.filter(([tool, command]) => tool === 'docker' && command === 'build');
  assert.equal(builds.length, 2);
  assert.ok(builds.every((call) => call.at(-1) === path.dirname(path.dirname(script))));
  assert.match(result.stdout, /All three images verified/);
});

test('stops after three failed builds and never reports readiness', (t) => {
  const result = run(t, { host: [], failures: { 'nest-api:latest': 3 } });
  assert.notEqual(result.status, 0);
  assert.equal(result.state.attempts['nest-api:latest'], 3);
  assert.match(result.stderr, /Build failed/);
  assert.doesNotMatch(result.stdout, /All three images verified/);
});

test('a persistent host TLS failure stops before any archive import', (t) => {
  const result = run(t, { host: images.slice(0, 2), failures: { 'postgres:17-bookworm': 3 } });
  assert.notEqual(result.status, 0);
  assert.equal(result.state.attempts['postgres:17-bookworm'], 3);
  assert.match(result.stderr, /host could not pull PostgreSQL/);
  assert.deepEqual(result.state.node, {});
  assert.doesNotMatch(result.stdout, /All three images verified/);
});

test('rejects a silent successful load when PostgreSQL never reaches the node', (t) => {
  const result = run(t, { silentFailure: 'postgres:17-bookworm' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing from the node runtime after import/);
  assert.doesNotMatch(result.stdout, /All three images verified/);
});

test('rejects a stale tag even when the image exists on the node', (t) => {
  const result = run(t, { staleImage: 'postgres:17-bookworm' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different image for postgres/);
  assert.doesNotMatch(result.stdout, /All three images verified/);
});

test('propagates import failures and removes temporary archives', (t) => {
  const result = run(t, { loadFailure: 'postgres:17-bookworm' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ctr import failed/);
  assert.doesNotMatch(result.stdout, /All three images verified/);
});

test('requires a running profile before building or importing', (t) => {
  const result = run(t, { profileMissing: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Start the cluster first/);
  assert.deepEqual(result.state.attempts, {});
  assert.deepEqual(result.state.node, {});
});

test('--rebuild replaces both existing application images', (t) => {
  const result = run(t, {}, ['--rebuild']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.attempts['nest-api:latest'], 1);
  assert.equal(result.state.attempts['nest-migrate:latest'], 1);
  assert.equal(result.state.attempts['postgres:17-bookworm'], undefined);
});
