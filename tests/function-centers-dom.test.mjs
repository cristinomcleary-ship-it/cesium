import assert from 'node:assert/strict';
import test from 'node:test';
import { FUNCTION_CENTERS, installFunctionCenters } from '../src/functionCenters.ts';

// Small DOM adapter for exercising the real installer and its lifecycle. It
// models node moves, event bubbling and batched attribute observers, not layout.
const observers = new Set();
class AttributeObserver {
  constructor(callback) { this.callback = callback; this.targets = new Map(); this.records = []; this.queued = false; }
  observe(target, options) { this.targets.set(target, options); observers.add(this); }
  disconnect() { this.targets.clear(); this.records = []; observers.delete(this); }
  changed(target, attributeName) {
    const options = this.targets.get(target);
    if (!options || !options.attributeFilter.includes(attributeName)) return;
    this.records.push({ target, attributeName });
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const records = this.records.splice(0);
      if (records.length) this.callback(records, this);
    });
  }
}
class DomNode {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.parentElement = null; this.children = [];
    this.attributes = new Map(); this.dataset = {}; this.listeners = new Map(); this.hidden = false; this.disabled = false;
    this.open = false; this.value = ''; this.text = ''; this.classes = new Set();
    this.classList = {
      contains: value => this.classes.has(value),
      add: (...values) => { values.forEach(value => this.classes.add(value)); this.changed('class'); },
      remove: (...values) => { values.forEach(value => this.classes.delete(value)); this.changed('class'); },
      toggle: (value, force) => {
        const enabled = force ?? !this.classes.has(value);
        if (enabled) this.classes.add(value); else this.classes.delete(value);
        this.changed('class'); return enabled;
      },
    };
  }
  changed(name) { for (const observer of observers) observer.changed(this, name); }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); this.changed('class'); }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(value) { this.attributes.set('id', value); }
  get childNodes() { return this.children; }
  get childElementCount() { return this.children.filter(node => node.tagName !== '#COMMENT').length; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.changed(name); }
  removeAttribute(name) { this.attributes.delete(name); this.changed(name); }
  matches(selector) {
    if (this.tagName === '#COMMENT') return false;
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if ([...selector.matchAll(/\.([\w-]+)/g)].some(match => !this.classes.has(match[1]))) return false;
    if ([...selector.matchAll(/#([\w-]+)/g)].some(match => this.id !== match[1])) return false;
    return [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value);
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.text = ''; this.append(...nodes); }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
  }
  before(node) { const parent = this.parentElement; node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parentElement; node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  replaceWith(node) { this.before(node); this.remove(); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  fire(type, values = {}) {
    const event = { type, target: this, stopped: false, defaultPrevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (let node = this; node; node = node.parentElement) {
      for (const listener of node.listeners.get(type) ?? []) listener(event);
      if (event.stopped) break;
    }
    return event;
  }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() { return this.hidden ? [] : [{}]; }
}
class DomDocument {
  activeElement = null;
  createElement(tag) { return new DomNode(tag, this); }
  createComment(text) { const node = new DomNode('#comment', this); node.textContent = text; return node; }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(onAction = () => false) {
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = AttributeObserver;
  const doc = new DomDocument();
  const shell = doc.createElement('div'); shell.className = 'shell';
  const header = doc.createElement('header'); header.className = 'app-header';
  const nav = doc.createElement('nav'); nav.className = 'tabs'; nav.setAttribute('aria-label', '原功能菜单');
  shell.append(header); header.append(nav);
  const ids = ['overview', 'sandtable', 'cad', 'models', 'temporary-works', 'machinery', 'rail-safety', 'tiles', 'gis', 'videoar', 'markup', 'monitoring', 'report'];
  const tabs = new Map(ids.map(id => {
    const button = doc.createElement('button'); button.className = id === 'cad' ? 'tab active' : 'tab'; button.dataset.tab = id; button.textContent = id;
    nav.append(button); return [id, button];
  }));
  let blocked = false, clicks = 0;
  for (const tab of tabs.values()) tab.addEventListener('click', () => {
    clicks++;
    if (blocked) return;
    for (const item of tabs.values()) item.classList.remove('active');
    tab.classList.add('active');
  });
  const originalNodes = [...nav.childNodes];
  const controller = installFunctionCenters(nav, { onAction });
  return {
    shell, header, nav, tabs, controller, originalNodes,
    clicks: () => clicks, block: value => { blocked = value; },
    search: nav.querySelector('input'), current: nav.querySelector('.function-centers-current'),
    group: id => nav.querySelector(`[data-center="${id}"]`),
    action: id => nav.querySelector(`[data-center-action="${id}"]`),
    cleanup: () => { controller.dispose(); globalThis.MutationObserver = previousObserver; assert.equal(observers.size, 0); },
  };
}

test('installer moves original nodes once, preserves listeners and fully restores on dispose', async () => {
  const f = fixture();
  try {
    assert.equal(f.nav.parentElement, f.shell);
    assert.equal(f.nav.querySelectorAll('.tab').length, 13);
    for (const [id, original] of f.tabs) assert.equal(f.nav.querySelector(`[data-tab="${id}"]`), original);
    assert.equal(installFunctionCenters(f.nav, { onAction: () => true }), f.controller);
    assert.equal(f.nav.querySelectorAll('details').length, 6);
    f.tabs.get('monitoring').click(); await settle();
    assert.equal(f.clicks(), 1);
    assert.equal(f.current.textContent, '当前：基坑监测');
    assert.equal(f.group('safety').classList.contains('has-current'), true);
    f.controller.dispose();
    assert.equal(f.nav.parentElement, f.header);
    assert.deepEqual(f.nav.childNodes, f.originalNodes);
    assert.equal(f.nav.getAttribute('aria-label'), '原功能菜单');
    assert.equal(f.shell.querySelector('.function-centers-toggle'), null);
    f.tabs.get('cad').click(); await settle();
    assert.equal(f.clicks(), 2, 'original listeners still work after teardown');
  } finally { f.cleanup(); }
});

test('blocked professional navigation and rejected actions do not change current selection', async () => {
  const f = fixture();
  try {
    f.block(true); f.tabs.get('machinery').click(); await settle();
    assert.equal(f.tabs.get('cad').classList.contains('active'), true);
    assert.equal(f.current.textContent, '当前：CAD 图纸');
    assert.equal(f.group('safety').classList.contains('has-current'), false);
    f.action('display').click(); await settle();
    assert.equal(f.current.textContent, '当前：CAD 图纸');
    assert.equal(f.action('display').classList.contains('is-current'), false);
  } finally { f.cleanup(); }
});

test('search preserves permission attributes and external selection reveals the target center', async () => {
  const f = fixture();
  try {
    const model = f.tabs.get('models'); model.hidden = true; model.disabled = true;
    f.search.value = '便道'; f.search.fire('input');
    assert.equal(f.tabs.get('temporary-works').parentElement.hidden, false);
    assert.equal(f.tabs.get('machinery').parentElement.hidden, true);
    assert.equal(f.group('safety').hidden, true);
    f.tabs.get('machinery').click(); await settle();
    assert.equal(f.search.value, '');
    assert.equal(f.group('safety').hidden, false);
    assert.equal(f.group('safety').open, true);
    assert.equal(f.current.textContent, '当前：施工机械');
    assert.equal(model.hidden, true); assert.equal(model.disabled, true);
  } finally { f.cleanup(); }
});

test('pending action cannot replace a later successful professional selection', async () => {
  let resolveAction;
  const f = fixture(() => new Promise(resolve => { resolveAction = resolve; }));
  try {
    f.action('library').click();
    assert.equal(f.action('library').getAttribute('aria-busy'), 'true');
    assert.equal(f.current.textContent, '当前：CAD 图纸');
    f.tabs.get('monitoring').click(); await settle();
    resolveAction(true); await settle();
    assert.equal(f.action('library').getAttribute('aria-busy'), null);
    assert.equal(f.action('library').classList.contains('is-current'), false);
    assert.equal(f.current.textContent, '当前：基坑监测');
  } finally { f.cleanup(); }
});

test('an external directory action clears a conflicting search and reveals its center', async () => {
  const f = fixture();
  try {
    f.search.value = '便道'; f.search.fire('input');
    f.tabs.get('temporary-works').click(); await settle();
    assert.equal(f.search.value, '便道', 'the selected matching professional entry retains the search');
    assert.equal(f.group('scene').hidden, true);
    f.controller.setActiveAction('display');
    assert.equal(f.search.value, '');
    assert.equal(f.group('scene').hidden, false);
    assert.equal(f.group('scene').open, true);
    assert.equal(f.action('display').parentElement.hidden, false);
    assert.equal(f.action('display').getAttribute('aria-current'), 'page');
    assert.equal(f.current.textContent, '当前：对象目录与显示');
  } finally { f.cleanup(); }
});

test('keyboard search uses the original button; center opening does not navigate or lose nodes', async () => {
  const f = fixture(() => true);
  try {
    f.controller.openCenter('construction');
    assert.equal(f.group('construction').open, true);
    assert.equal(f.clicks(), 0);
    assert.equal(f.tabs.get('cad').classList.contains('active'), true);
    f.search.value = '便道'; f.search.fire('input');
    const enter = f.search.fire('keydown', { key: 'Enter' }); await settle();
    assert.equal(enter.defaultPrevented, true); assert.equal(f.clicks(), 1);
    assert.equal(f.current.textContent, '当前：临建规划');
    f.search.value = '原件'; f.search.fire('input');
    assert.equal(f.action('library').parentElement.hidden, false);
    f.search.fire('keydown', { key: 'Escape' });
    assert.equal(f.search.value, '');
    f.action('library').click(); await settle();
    assert.equal(f.current.textContent, '当前：已保存资料');
    assert.equal(f.action('library').getAttribute('aria-current'), 'page');
    assert.equal(f.nav.querySelectorAll('.tab').length, FUNCTION_CENTERS.flatMap(center => center.entries.filter(entry => entry.tab)).length);
  } finally { f.cleanup(); }
});
