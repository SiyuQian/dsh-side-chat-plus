import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);

test('built browser artifact lazily registers a usable scoped DSH factory', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], {cwd: fileURLToPath(root), stdio: 'pipe'});
  const factories = new Map();
  let requires = 0;
  runInNewContext(readFileSync(new URL('lib/client.js', root), 'utf8'), {
    window: {__ModuleLoader__: {load({id, factory}) {factories.set(id, factory);}}},
  }, {filename: 'lib/client.js'});
  assert.equal(requires, 0, 'loading the script must not resolve dependencies or activate the UI');
  const factory = factories.get('@siyuqian/dsh-side-chat-plus');
  assert.equal(typeof factory, 'function', 'DSH resolves the artifact by the scoped manifest name');
  const plugin = factory(id => {
    requires++;
    assert.equal(id, 'react', 'React must come from the DSH browser module table');
    return require(id);
  });
  assert.equal(requires, 1);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.default.apply, plugin.apply);
  const cleanup = () => {};
  assert.equal(plugin.apply({inject(dependencies, mount) {
    assert.ok(Array.from(dependencies).includes('sidebarRightTabs'));
    assert.equal(typeof mount, 'function');
    return cleanup;
  }}), cleanup);
});
