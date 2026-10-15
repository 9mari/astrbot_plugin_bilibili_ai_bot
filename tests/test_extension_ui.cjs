// Run with: node --test tests/test_extension_ui.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUI() {
  const nodes = new Map();
  const node = () => ({
    innerHTML: '', dataset: {}, attributes: new Map(),
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { this.attributes.set(key, value); },
    removeAttribute(key) { this.attributes.delete(key); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    focus() {}, style: { setProperty() {} },
  });
  const document = {
    body: node(), documentElement: node(),
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
  };
  const context = vm.createContext({
    document, window: { AstrBotPluginPage: {}, scrollTo() {} },
    location: { search: '', href: 'http://localhost/' },
    URL, URLSearchParams, structuredClone, console, setTimeout, clearTimeout,
    requestAnimationFrame(callback) { callback(); },
  });
  const file = path.join(__dirname, '../pages/bilibot/app.js');
  const source = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/m, 'const icon = () => "";')
    .replaceAll('import.meta.url', '"http://localhost/app.js"')
    .replace(/\ninit\(\);\s*$/, '\n');
  vm.runInContext(source, context, { filename: file });
  vm.runInContext(`
    renderSidebar = () => {};
    refreshPageData = async () => {};
    renderCurrentPage = () => { content.innerHTML = 'HOST'; };
    updateSaveDock = () => {};
    closeMobileNav = () => {};
  `, context);
  return { context, nodes, api: vm.runInContext('({state, loadBase, loadExtensionPage, leaveExtension, renderExtensionPage})', context) };
}

test('slow extension discovery does not block the base control panel', async () => {
  const { context, api } = loadUI();
  let resolveExtensions;
  context.extensionDiscoveryResult = new Promise(resolve => { resolveExtensions = resolve; });
  vm.runInContext('apiGet = async (path) => path === "extensions" ? extensionDiscoveryResult : {};', context);
  let timer;
  try {
    await Promise.race([
      api.loadBase(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('base panel blocked')), 250); }),
    ]);
  } finally {
    clearTimeout(timer);
    resolveExtensions([]);
  }
});

test('a late extension failure cannot replace the host page after leaving', async () => {
  const { context, api, nodes } = loadUI();
  let rejectPage;
  context.pageResult = new Promise((_, reject) => { rejectPage = reject; });
  vm.runInContext('apiGet = () => pageResult;', context);
  Object.assign(api.state, { mode: 'extension', activeExtensionId: 'creator', extensions: [{ id: 'creator' }] });
  const pending = api.loadExtensionPage('creator', 'dashboard', true);
  api.leaveExtension();
  rejectPage(new Error('extension failed'));
  await pending;
  assert.equal(nodes.get('#content').innerHTML, 'HOST');
  assert.equal(api.state.mode, 'host');
  assert.equal(api.state.extensionLoading, false);
  assert.equal(nodes.get('#content').attributes.has('aria-busy'), false);
});

test('extension text is escaped before rendering HTML', () => {
  const { api } = loadUI();
  const html = api.renderExtensionPage({
    schema: 'bilibot-schema-v1',
    components: [{ type: 'creator-page-intro', title: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>' }],
  });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));
});

test('an action finishing after leaving cannot start another extension page load', async () => {
  const { context, api, nodes } = loadUI();
  vm.runInContext('apiGet = () => { throw new Error("unexpected extension request"); };', context);
  nodes.get('#content').innerHTML = 'HOST';
  await api.loadExtensionPage('creator', 'dashboard');
  assert.equal(nodes.get('#content').innerHTML, 'HOST');
  assert.equal(nodes.get('#content').attributes.has('aria-busy'), false);
});
