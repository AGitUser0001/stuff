// Written by AI for the most part

// Benchmark for Trie data structure
// Compares Trie against Map-based alternatives
// ENHANCED VERSION with deletion benchmarks

import { Trie } from './trie.js';

// Alternative implementations for comparison
class NestedMapNode<T> {
  children = new Map<unknown, NestedMapNode<T>>();
  value?: T;
  hasValue = false;
}

class NestedMap<T> {
  private root = new NestedMapNode<T>();

  set(path: readonly unknown[], value: T) {
    let current = this.root;
    for (const key of path) {
      let child = current.children.get(key);
      if (!child) {
        child = new NestedMapNode<T>();
        current.children.set(key, child);
      }
      current = child;
    }
    current.value = value;
    current.hasValue = true;
  }

  get(path: readonly unknown[]): T | undefined {
    let current = this.root;
    for (const key of path) {
      const child = current.children.get(key);
      if (!child) return undefined;
      current = child;
    }
    return current.hasValue ? current.value : undefined;
  }

  delete(path: readonly unknown[]): boolean {
    let current = this.root;
    for (const key of path) {
      const child = current.children.get(key);
      if (!child) return false;
      current = child;
    }
    if (!current.hasValue) return false;
    current.hasValue = false;
    delete current.value;
    return true;
  }

  has(path: readonly unknown[]): boolean {
    let current = this.root;
    for (const key of path) {
      const child = current.children.get(key);
      if (!child) return false;
      current = child;
    }
    return current.hasValue;
  }
}

class FlatMap<T> {
  private map = new Map<string, T>();

  private serialize(path: readonly unknown[]): string {
    return JSON.stringify(path);
  }

  set(path: readonly unknown[], value: T) {
    this.map.set(this.serialize(path), value);
  }

  get(path: readonly unknown[]): T | undefined {
    return this.map.get(this.serialize(path));
  }

  has(path: readonly unknown[]): boolean {
    return this.map.has(this.serialize(path));
  }

  delete(path: readonly unknown[]): boolean {
    return this.map.delete(this.serialize(path));
  }
}

// Benchmark utilities

function benchmark(name: string, fn: () => void, iterations: number = 100000): number {
  // Warmup
  for (let i = 0; i < Math.min(5000, iterations / 10); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const duration = end - start;

  console.log(`${name.padEnd(50)} ${duration.toFixed(2)}ms (${(iterations / duration * 1000).toFixed(0)} ops/sec)`);
  return duration;
}

console.log('='.repeat(80));
console.log('TRIE BENCHMARK SUITE - ENHANCED');
console.log('='.repeat(80));

// Benchmark 1: Simple set/get operations
console.log('\n📊 Benchmark 1: Simple Set/Get Operations (100k iterations)');
console.log('-'.repeat(80));

const trie1 = new Trie<[string, number, string], number>();
const nested1 = new NestedMap<number>();
const flat1 = new FlatMap<number>();

benchmark('Trie - set', () => {
  trie1.set(['user', 123, 'age'], 25);
}, 100000);

benchmark('NestedMap - set', () => {
  nested1.set(['user', 123, 'age'], 25);
}, 100000);

benchmark('FlatMap - set', () => {
  flat1.set(['user', 123, 'age'], 25);
}, 100000);

console.log();

benchmark('Trie - get', () => {
  trie1.get(['user', 123, 'age']);
}, 100000);

benchmark('NestedMap - get', () => {
  nested1.get(['user', 123, 'age']);
}, 100000);

benchmark('FlatMap - get', () => {
  flat1.get(['user', 123, 'age']);
}, 100000);

// Benchmark 2: Many unique paths
console.log('\n📊 Benchmark 2: Many Unique Paths (10k unique sets)');
console.log('-'.repeat(80));

const trie2 = new Trie<[string, number, string], string>();
const nested2 = new NestedMap<string>();
const flat2 = new FlatMap<string>();

benchmark('Trie - set 10k unique paths', () => {
  const id = Math.floor(Math.random() * 10000);
  trie2.set(['user', id, 'name'], `user${id}`);
}, 10000);

benchmark('NestedMap - set 10k unique paths', () => {
  const id = Math.floor(Math.random() * 10000);
  nested2.set(['user', id, 'name'], `user${id}`);
}, 10000);

benchmark('FlatMap - set 10k unique paths', () => {
  const id = Math.floor(Math.random() * 10000);
  flat2.set(['user', id, 'name'], `user${id}`);
}, 10000);

// Benchmark 3: Partial path operations
console.log('\n📊 Benchmark 3: Partial Path Operations (using subtrees)');
console.log('-'.repeat(80));

const trie3 = new Trie<readonly [string, number, string, string], any>();

benchmark('Trie - using partial + multiple sets', () => {
  using userTree = trie3.partial(['user', 123]);
  userTree.set(['profile', 'name'], 'John');
  userTree.set(['profile', 'age'], 30);
  userTree.set(['settings', 'theme'], 'dark');
}, 50000);

benchmark('Trie - direct sets (no partial)', () => {
  trie3.set(['user', 123, 'profile', 'name'], 'John');
  trie3.set(['user', 123, 'profile', 'age'], 30);
  trie3.set(['user', 123, 'settings', 'theme'], 'dark');
}, 50000);

// Benchmark the ACTUAL use case
console.log('\n📊 Benchmark 3.5: Long-lived Partial (correct usage)');
console.log('-'.repeat(80));

const trie3_5 = new Trie<readonly [string, number, string, number], any>();
using userTree = trie3_5.partial(['user', 123]);

benchmark('Trie - reused partial (50000 sets)', () => {
  userTree.set(['data', Math.random()], Math.random());
}, 50000);

// vs
const trie3_5_5 = new Trie<readonly [string, number, string, number], any>();
benchmark('Trie - direct path (50000 sets)', () => {
  trie3_5_5.set(['user', 123, 'data', Math.random()], Math.random());
}, 50000);

// Benchmark 4: Deep paths
console.log('\n📊 Benchmark 4: Deep Path Performance (6 levels deep)');
console.log('-'.repeat(80));

const trie4 = new Trie<readonly [string, string, string, string, string, string], number>();
const nested4 = new NestedMap<number>();
const flat4 = new FlatMap<number>();

const deepPath = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

benchmark('Trie - deep path set', () => {
  trie4.set(deepPath, 42);
}, 50000);

benchmark('NestedMap - deep path set', () => {
  nested4.set(deepPath, 42);
}, 50000);

benchmark('FlatMap - deep path set', () => {
  flat4.set(deepPath, 42);
}, 50000);

console.log();

benchmark('Trie - deep path get', () => {
  trie4.get(deepPath);
}, 50000);

benchmark('NestedMap - deep path get', () => {
  nested4.get(deepPath);
}, 50000);

benchmark('FlatMap - deep path get', () => {
  flat4.get(deepPath);
}, 50000);

// Benchmark 5: Weak key cleanup simulation
console.log('\n📊 Benchmark 5: Weak Key Operations');
console.log('-'.repeat(80));

const trie5 = new Trie<[object, string], number>();
const weakMap5 = new WeakMap<object, Map<string, number>>();

const objects = Array.from({ length: 1000 }, () => ({}));

benchmark('Trie - weak key set', () => {
  const obj = objects[Math.floor(Math.random() * objects.length)];
  trie5.set([obj, 'data'], 123);
}, 50000);

benchmark('WeakMap + Map - weak key set', () => {
  const obj = objects[Math.floor(Math.random() * objects.length)];
  let inner = weakMap5.get(obj);
  if (!inner) {
    inner = new Map();
    weakMap5.set(obj, inner);
  }
  inner.set('data', 123);
}, 50000);

// Benchmark 6: Mixed operations
console.log('\n📊 Benchmark 6: Mixed Read/Write Operations');
console.log('-'.repeat(80));

const trie6 = new Trie<[string, number], number>();
const nested6 = new NestedMap<number>();

// Pre-populate
for (let i = 0; i < 100; i++) {
  trie6.set(['item', i], i);
  nested6.set(['item', i], i);
}

benchmark('Trie - 70% read, 30% write', () => {
  const id = Math.floor(Math.random() * 100);
  if (Math.random() < 0.7) {
    trie6.get(['item', id]);
  } else {
    trie6.set(['item', id], id * 2);
  }
}, 100000);

benchmark('NestedMap - 70% read, 30% write', () => {
  const id = Math.floor(Math.random() * 100);
  if (Math.random() < 0.7) {
    nested6.get(['item', id]);
  } else {
    nested6.set(['item', id], id * 2);
  }
}, 100000);

// ============================================================================
// NEW: Benchmark 7: Deletion and Cleanup Performance
// ============================================================================
console.log('\n📊 Benchmark 7: Deletion and Cleanup Performance');
console.log('-'.repeat(80));

// Test 7a: Delete leaf nodes (triggers cleanup in Trie)
const trie7a = new Trie<[string, number, string], number>();
const nested7a = new NestedMap<number>();
const flat7a = new FlatMap<number>();

benchmark('Trie - delete leaf nodes (with auto-cleanup)', () => {
  const id = Math.floor(Math.random() * 1000);
  trie7a.set(['user', id, 'temp'], 42);
  trie7a.delete(['user', id, 'temp']);
}, 50000);

benchmark('NestedMap - delete leaf nodes (no cleanup)', () => {
  const id = Math.floor(Math.random() * 1000);
  nested7a.set(['user', id, 'temp'], 42);
  nested7a.delete(['user', id, 'temp']);
}, 50000);

benchmark('FlatMap - delete leaf nodes', () => {
  const id = Math.floor(Math.random() * 1000);
  flat7a.set(['user', id, 'temp'], 42);
  flat7a.delete(['user', id, 'temp']);
}, 50000);

console.log();

// Test 7b: Delete from populated tree
const trie7b = new Trie<[string, number, string], number>();
const nested7b = new NestedMap<number>();
const flat7b = new FlatMap<number>();

// Pre-populate with 1000 entries
for (let i = 0; i < 1000; i++) {
  trie7b.set(['user', i, 'data'], i);
  nested7b.set(['user', i, 'data'], i);
  flat7b.set(['user', i, 'data'], i);
}

benchmark('Trie - delete from populated tree', () => {
  const id = Math.floor(Math.random() * 1000);
  trie7b.delete(['user', id, 'data']);
}, 10000);

benchmark('NestedMap - delete from populated tree', () => {
  const id = Math.floor(Math.random() * 1000);
  nested7b.delete(['user', id, 'data']);
}, 10000);

benchmark('FlatMap - delete from populated tree', () => {
  const id = Math.floor(Math.random() * 1000);
  flat7b.delete(['user', id, 'data']);
}, 10000);

console.log();

// Test 7c: Bulk delete (stress test cleanup mechanism)
const trie7c = new Trie<[string, number], number>();
const nested7c = new NestedMap<number>();
const flat7c = new FlatMap<number>();

benchmark('Trie - bulk delete 1000 entries (cleanup test)', () => {
  // Create and delete in same iteration
  for (let i = 0; i < 1000; i++) {
    trie7c.set(['bulk', i], i);
  }
  for (let i = 0; i < 1000; i++) {
    trie7c.delete(['bulk', i]);
  }
}, 100);

benchmark('NestedMap - bulk delete 1000 entries', () => {
  for (let i = 0; i < 1000; i++) {
    nested7c.set(['bulk', i], i);
  }
  for (let i = 0; i < 1000; i++) {
    nested7c.delete(['bulk', i]);
  }
}, 100);

benchmark('FlatMap - bulk delete 1000 entries', () => {
  for (let i = 0; i < 1000; i++) {
    flat7c.set(['bulk', i], i);
  }
  for (let i = 0; i < 1000; i++) {
    flat7c.delete(['bulk', i]);
  }
}, 100);

console.log();

// Test 7d: Delete with shared prefix (tests if cleanup is correctly conservative)
const trie7d = new Trie<[string, number, string], number>();
const nested7d = new NestedMap<number>();
const flat7d = new FlatMap<number>();

// Create structure: user/i/a, user/i/b, user/i/c for each i
for (let i = 0; i < 100; i++) {
  trie7d.set(['user', i, 'a'], 1);
  trie7d.set(['user', i, 'b'], 2);
  trie7d.set(['user', i, 'c'], 3);
  nested7d.set(['user', i, 'a'], 1);
  nested7d.set(['user', i, 'b'], 2);
  nested7d.set(['user', i, 'c'], 3);
  flat7d.set(['user', i, 'a'], 1);
  flat7d.set(['user', i, 'b'], 2);
  flat7d.set(['user', i, 'c'], 3);
}

benchmark('Trie - delete 1 of 3 siblings (no parent cleanup)', () => {
  const id = Math.floor(Math.random() * 100);
  trie7d.delete(['user', id, 'a']);
}, 10000);

benchmark('NestedMap - delete 1 of 3 siblings', () => {
  const id = Math.floor(Math.random() * 100);
  nested7d.delete(['user', id, 'a']);
}, 10000);

benchmark('FlatMap - delete 1 of 3 siblings', () => {
  const id = Math.floor(Math.random() * 100);
  flat7d.delete(['user', id, 'a']);
}, 10000);

console.log();

// Test 7e: Delete all siblings (should trigger parent cleanup)
const trie7e = new Trie<[string, number, string], number>();

// Create 100 isolated branches
for (let i = 0; i < 100; i++) {
  trie7e.set(['isolated', i, 'data'], i);
}

benchmark('Trie - delete triggering parent cleanup', () => {
  const id = Math.floor(Math.random() * 100);
  trie7e.delete(['isolated', id, 'data']);
  // After deletion, the entire ['isolated', id] branch should be cleaned up
}, 10000);

console.log();

// Test 7f: Interleaved set/delete (realistic workload)
const trie7f = new Trie<[string, number], number>();
const nested7f = new NestedMap<number>();
const flat7f = new FlatMap<number>();

benchmark('Trie - interleaved set/delete/get', () => {
  const id = Math.floor(Math.random() * 500);
  if (Math.random() < 0.4) {
    trie7f.set(['data', id], id);
  } else if (Math.random() < 0.7) {
    trie7f.get(['data', id]);
  } else {
    trie7f.delete(['data', id]);
  }
}, 100000);

benchmark('NestedMap - interleaved set/delete/get', () => {
  const id = Math.floor(Math.random() * 500);
  if (Math.random() < 0.4) {
    nested7f.set(['data', id], id);
  } else if (Math.random() < 0.7) {
    nested7f.get(['data', id]);
  } else {
    nested7f.delete(['data', id]);
  }
}, 100000);

benchmark('FlatMap - interleaved set/delete/get', () => {
  const id = Math.floor(Math.random() * 500);
  if (Math.random() < 0.4) {
    flat7f.set(['data', id], id);
  } else if (Math.random() < 0.7) {
    flat7f.get(['data', id]);
  } else {
    flat7f.delete(['data', id]);
  }
}, 100000);

// Memory usage indicator
console.log('\n📊 Memory Characteristics');
console.log('-'.repeat(80));

const trie7 = new Trie<[string, number], string>();
const trie7_weak = new Trie<[string, symbol], string>();
const nested7 = new NestedMap<string>();

console.time('Trie - memory test');
const pathCount = 2500000;
for (let i = 0; i < pathCount; i++) {
  trie7.set(['prefix', i], `value${i}`);
}
console.timeEnd('Trie - memory test');

console.time('Trie - memory test WeakKey');
for (let i = 0; i < pathCount; i++) {
  trie7_weak.set(['prefix', Symbol('WEAK')], `value${i}`);
}
console.timeEnd('Trie - memory test WeakKey');

console.time('NestedMap - memory test');
for (let i = 0; i < pathCount; i++) {
  nested7.set(['prefix', i], `value${i}`);
}
console.timeEnd('NestedMap - memory test');

console.log(`Created ${pathCount} paths with shared prefix 'prefix'`);
console.log(`Remaining count in Trie: ${trie7.size}`);
console.log(`Remaining count in Trie_weak: ${trie7_weak.size}`);

console.time('NestedMap - Has test');
let count = 0;
for (let i = 0; i < pathCount; i++) {
  count += +nested7.has(['prefix', i]);
}
console.timeEnd('NestedMap - Has test');

console.log(`Remaining count in NestedMap: ${count}`);

console.log('Trie: Shares parent node across all paths + auto-cleanup on delete');
console.log('NestedMap: Shares parent node across all paths (manual cleanup needed)');
console.log('FlatMap: Each path is independent (higher memory, simpler cleanup)');

console.log('\n' + '='.repeat(80));
console.log('Benchmark complete!');
console.log('='.repeat(80));
console.log('\nKey Insights:');
console.log('- Trie auto-cleanup walks up the tree on delete (small cost for memory benefit)');
console.log('- Reused partials are fastest for repeated operations');
console.log('- Weak key support has overhead but enables automatic GC');
console.log('- Deletion performance depends on tree depth and cleanup propagation');
