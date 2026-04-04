type ArrayType = readonly unknown[];
type MutableArrayType = unknown[];

type ArrayTypeOf<T extends ArrayType> = T extends MutableArrayType ? MutableArrayType : ArrayType;

type AsMutable<T extends ArrayType> = [...T];
type AsReadonly<T extends ArrayType> = readonly [...T];

type CopyReadonly<O extends ArrayType, T extends MutableArrayType> =
  readonly [O] extends readonly [MutableArrayType] ? T : AsReadonly<T>;

export type ValidatePrefix<T extends ArrayType, P extends ArrayType> =
  readonly [P] extends readonly [T] ? P :
  T extends readonly [] ? never :
  ValidatePrefix<(RestOnRight<T> extends true
    ? CopyReadonly<T, RemoveRestOnRight<AsMutable<T>>>
    : ShiftRight_Readonly<T>), P>;

type ShiftLeft<T extends MutableArrayType> = T extends [unknown?, ...infer R] ? R : never;

type ShiftRight<T extends MutableArrayType> = T extends [...infer R, unknown?] ? R : never;
type ShiftRight_Readonly<T extends ArrayType> = CopyReadonly<T, T extends readonly [...infer R, unknown?] ? R : never>;

type RemoveRestOnRight<T extends MutableArrayType, Acc extends MutableArrayType = []> =
  T extends [infer Head, ...infer Tail]
  ? RemoveRestOnRight<Tail, [...Acc, Head]>
  : [...T, unknown] extends [infer Head, ...ArrayType, unknown]
  ? RemoveRestOnRight<ShiftLeft<T>, [...Acc, Head?]>
  : Acc;

type RemoveRestOnLeft<T extends MutableArrayType, Acc extends MutableArrayType = []> =
  T extends [...infer Head, infer Tail]
  ? RemoveRestOnLeft<Head, [Tail, ...Acc]>
  : [...T, unknown] extends [...ArrayType, infer Tail, unknown]
  ? RemoveRestOnLeft<ShiftRight<T>, [Tail?, ...Acc]>
  : Acc;

type GetRestOnLeft<T extends MutableArrayType> =
  [...T, unknown] extends [...infer Head, unknown, unknown] ? GetRestOnLeft<Head> : T;

type RestOnLeft<T extends ArrayType> =
  T extends readonly [] ? false :
  readonly [...T, unknown] extends readonly [unknown, ...ArrayType, unknown] ? false : true;

type RestOnRight<T extends ArrayType> =
  T extends readonly [] ? false :
  readonly [...T, unknown] extends readonly [...ArrayType, unknown, unknown] ? false : true;

type IsRest<T extends ArrayType> = RestOnLeft<T> extends true ? RestOnRight<T> extends true ? true : false : false;

export type RemovePrefix<T extends ArrayType, P extends ArrayType> =
  CopyReadonly<T, RemovePrefixInternal<AsMutable<T>, AsMutable<P>>>;

type RemovePrefixInternal<
  T extends MutableArrayType,
  P extends MutableArrayType
> =
  T extends MutableArrayType ?
  // Base case
  P extends []
  ? T

  // Step case (tuple-to-tuple)
  : [...T, unknown] extends [infer THead, ...ArrayType, unknown]
  ? ([...P, unknown] extends [infer PHead, ...ArrayType, unknown]
    ? [PHead] extends [THead]
    ? RemovePrefixInternal<
      ShiftLeft<T>,
      ShiftLeft<P>
    >
    : never
    : never // We don't have handling logic for T having rest but P not having rest, so we just fail in that case
  )
  // Rest handling fallback
  : HandleRest<T, P> extends [infer NewT extends MutableArrayType, infer NewP extends MutableArrayType]
  ? RemovePrefixInternal<NewT, NewP> : never
  : never;

type HandleRest<
  T extends MutableArrayType,
  P extends MutableArrayType
> =
  RestOnLeft<T> extends true
  ? (
    RestOnRight<T> extends true
    ? P extends T ? [T, []] : never[]
    : HandleRest_Continuation<T, P> extends [infer CNextT extends MutableArrayType, infer CNextP extends MutableArrayType]
    ? [CNextT, CNextP]
    : ConsumeArrayPrefix<P, GetRestOnLeft<T>> extends infer PrefixRemoved extends MutableArrayType
    ? [RemoveRestOnLeft<T>, PrefixRemoved]
    : never[]
  )
  : never[];

type HandleRest_Continuation<T extends MutableArrayType, P extends MutableArrayType> =
  IsRest<P> extends true
  ? GetRestOnLeft<T> extends infer TRest extends MutableArrayType
  ? P extends TRest
  ? [T, []]
  : never[]
  : never[]
  : never[];

type ConsumeArrayPrefixStep<
  T extends MutableArrayType,
  Acc extends MutableArrayType
> =
  RestOnLeft<T> extends true ? [Tail: RemoveRestOnLeft<T>, NextAcc: [...Acc, ...GetRestOnLeft<T>]] :
  [...T, unknown] extends [infer Head, ...infer _Tail, unknown]
  ? [Tail: ShiftLeft<T>, NextAcc: [...Acc, Head]]
  : never[];

type ConsumeArrayPrefix<
  T extends MutableArrayType,
  P extends MutableArrayType,
  Acc extends MutableArrayType = [],
  Step = ConsumeArrayPrefixStep<T, Acc>
> =
  [Acc] extends [P]
  ? ConsumeArrayPrefixFound<T, P, Acc>
  : Step extends [infer Tail extends MutableArrayType, infer NextAcc extends MutableArrayType]
  ? ConsumeArrayPrefix<Tail, P, NextAcc>
  : never;

type ConsumeArrayPrefixFound<
  T extends MutableArrayType,
  P extends MutableArrayType,
  Acc extends MutableArrayType,
  PrevT extends MutableArrayType = T,
  Step = ConsumeArrayPrefixStep<T, Acc>
> =
  [Acc] extends [P]
  ? Step extends [infer Tail extends MutableArrayType, infer NextAcc extends MutableArrayType]
  ? ConsumeArrayPrefixFound<Tail, P, NextAcc, T>
  : T
  : PrevT;

export class Trie<K extends ArrayType, T> implements Map<K, T> {
  get [Symbol.toStringTag](): string {
    return 'Trie';
  }

  static #registry =
    new FinalizationRegistry<WeakRef<Trie<ArrayType, unknown>>>(parent => {
      const derefed = parent.deref();
      if (!derefed) return;
      derefed.#count &&= derefed.#count - 1;
      derefed.#erase();
    });

  #weakStore: WeakMap<WeakKey, Trie<ArrayType, T>> = new WeakMap();
  #strongStore: Map<unknown, Trie<ArrayType, T>> = new Map();
  #usesWeakMap: boolean;

  constructor(useWeakMap = true) {
    this.#usesWeakMap = !!useWeakMap;
  }

  static from<K extends ArrayType, T>(
    entries: Iterable<readonly [K, T]>,
    useWeakMap = true
  ): Trie<K, T> {
    const trie = new Trie<K, T>(useWeakMap);

    for (const [path, value] of entries) {
      trie.set(path, value);
    }

    return trie;
  }

  #value: T | undefined;
  #parent: Trie<ArrayType, T> | null = null;
  #parentKey: unknown = null;
  #parentWeakKey: WeakKey | null = null;
  #unregisterToken: symbol | null = null;

  #hasValue: boolean = false;
  #count: number = 1;
  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    this.#count &&= this.#count - 1;
    this.#erase();
  }

  #isWeak(key: unknown): key is WeakKey {
    if (!this.#usesWeakMap) return false;
    if (key === null) return false;
    if (typeof key === 'object' || typeof key === 'function') return true;
    if (typeof key === 'symbol' && Symbol.keyFor(key) === undefined) return true;
    return false;
  }

  set(path: K, value: T): this {
    const tail = this.#retrieveOrCreate(path);
    tail.#value = value;
    tail.#hasValue = true;
    return this;
  }

  view(): this {
    this.#count++;
    return this;
  }

  partial<const P extends ArrayTypeOf<K>>(path: ValidatePrefix<K, P>): Trie<RemovePrefix<K, P>, T> {
    const tail: Trie<RemovePrefix<K, P>, T> = this.#retrieveOrCreate(path);
    tail.#count++;
    return tail;
  }

  /**
   * Combination of `partial` and `dispose`.
   * @example
   * ```ts
   * let trie = root.view();
   * for (const next of sequence) {
   *   trie = trie.into(next);
   * }
   * trie.dispose();
   * ```
   */
  into<const P extends ArrayTypeOf<K>>(path: ValidatePrefix<K, P>): Trie<RemovePrefix<K, P>, T> {
    const tail: Trie<RemovePrefix<K, P>, T> = this.#retrieveOrCreate(path);
    tail.#count++;
    this.dispose();
    return tail;
  }

  #create<K extends ArrayType>(parent: Trie<ArrayType, T> | null) {
    const subTrie = new Trie<K, T>(this.#usesWeakMap);
    subTrie.#count = 0;
    subTrie.#parent = parent;
    return subTrie;
  }

  #retrieveOrCreate<const P extends ArrayType>(path: ValidatePrefix<K, P>): Trie<RemovePrefix<K, P>, T> {
    let current: Trie<ArrayType, T> = this;
    for (const key of path) {
      if (current.#isWeak(key)) {
        const store = current.#weakStore;
        let value = store.get(key);
        if (!value) {
          const token = Symbol('Unregister Token');
          Trie.#registry.register(key, new WeakRef(current), token);

          value = this.#create(current);
          store.set(key, value);
          value.#parentWeakKey = key;
          value.#unregisterToken = token;
          current.#count++;
        }
        current = value;
      } else {
        const store = current.#strongStore;
        let value = store.get(key);
        if (!value) {
          value = this.#create(current);
          store.set(key, value);
          value.#parentKey = key;
        }
        current = value;
      }
    }
    return current as Trie<RemovePrefix<K, P>, T>;
  }

  #retrieve<const P extends ArrayType>(path: ValidatePrefix<K, P>): Trie<RemovePrefix<K, P>, T> | undefined {
    let current: Trie<ArrayType, T> | undefined = this;
    for (const key of path) {
      if (current.#isWeak(key)) {
        current = current.#weakStore.get(key);
      } else {
        current = current.#strongStore.get(key);
      }
      if (!current) break;
    }
    return current as Trie<RemovePrefix<K, P>, T> | undefined;
  }

  #erase(force: boolean = false) {
    if (!this.#parent) return false;
    if (!force)
      if (this.#count || this.#strongStore.size || this.#hasValue)
        return false;
    let current: Trie<ArrayType, T> = this;
    while (current.#parent) {
      const child = current;

      [current.#parent, current] = [null, current.#parent];

      if (child.#parentWeakKey) {
        current.#weakStore.delete(child.#parentWeakKey);
        Trie.#registry.unregister(child.#unregisterToken!);
        current.#count &&= current.#count - 1;
        child.#parentWeakKey = null;
        child.#unregisterToken = null;
      } else {
        current.#strongStore.delete(child.#parentKey);
        child.#parentKey = null;
      }

      if (current.#count || current.#strongStore.size || current.#hasValue) break;
    }
    return true;
  }

  delete(path: K): boolean {
    const tail = this.#retrieve(path);
    if (!tail) return false;
    const ret = tail.#hasValue;
    tail.#hasValue = false;
    tail.#value = undefined;
    tail.#erase();
    return ret;
  }

  detach<const P extends ArrayTypeOf<K>>(path: ValidatePrefix<K, P>): boolean {
    const tail: Trie<RemovePrefix<K, P>, T> | undefined = this.#retrieve(path);
    if (!tail) return false;
    return tail.#erase(true);
  }

  detached<const P extends ArrayTypeOf<K>>(path: ValidatePrefix<K, P>): Trie<RemovePrefix<K, P>, T> | undefined {
    const tail: Trie<RemovePrefix<K, P>, T> | undefined = this.#retrieve(path);
    if (!tail) return;
    tail.#erase(true);
    tail.#count++;
    return tail;
  }

  attach<const P extends ArrayTypeOf<K>>(
    path: ValidatePrefix<K, P>,
    subTrie: Trie<RemovePrefix<K, P>, T>
  ): boolean {
    if (subTrie.#parent) return false;

    const tail = this.#retrieveOrCreate(path);
    if (!tail.#parent) return false;

    let current: Trie<ArrayType, T> | null = tail;
    do {
      if (current === subTrie) return false;
    } while (current = current.#parent);

    const parent: Trie<ArrayType, T> = tail.#parent;
    const weakKey = tail.#parentWeakKey;
    const key = tail.#parentKey;
    const tail_: Trie<ArrayType, T> = tail;
    parent.#count++;
    tail_.#erase(true);
    parent.#count &&= parent.#count - 1;

    if (weakKey) {
      const token = Symbol('Unregister Token');
      Trie.#registry.register(weakKey, new WeakRef(parent), token);

      parent.#weakStore.set(weakKey, subTrie);
      subTrie.#parent = parent;
      subTrie.#parentWeakKey = weakKey;
      subTrie.#unregisterToken = token;
      parent.#count++;
    } else {
      parent.#strongStore.set(key, subTrie);
      subTrie.#parent = parent;
      subTrie.#parentKey = key;
    }
    subTrie.#erase();

    return true;
  }

  has(path: K): boolean {
    const tail = this.#retrieve(path);
    if (!tail) return false;
    return tail.#hasValue;
  }

  get(path: K): T | undefined {
    const tail = this.#retrieve(path);
    if (!tail) return undefined;
    return tail.#value!;
  }

  getOrInsert(path: K, defaultValue: T): T {
    const tail = this.#retrieveOrCreate(path);
    if (!tail.#hasValue) {
      tail.#value = defaultValue;
      tail.#hasValue = true;
    }
    return tail.#value!;
  }

  getOrInsertComputed(path: K, callback: (path: K) => T): T {
    const tail = this.#retrieveOrCreate(path);
    if (!tail.#hasValue) {
      tail.#value = callback(path);
      tail.#hasValue = true;
    }
    return tail.#value!;
  }

  forEach<S>(callbackfn: (this: S, value: T, path: K, trie: Trie<K, T>) => void, thisArg: S): void;
  forEach(callbackfn: (value: T, path: K, trie: Trie<K, T>) => void): void;
  forEach(callbackfn: (value: T, path: K, trie: Trie<K, T>) => void, thisArg?: any): void {
    for (const [path, value] of this) {
      callbackfn.call(thisArg, value, path, this);
    }
  }

  as<X extends T>(): Trie<K, X> {
    return this as Trie<K, T> as Trie<K, X>;
  }

  *entries(): Generator<[K, T], undefined, unknown> {
    const kstack: unknown[] = [];
    if (this.#hasValue)
      yield [kstack.slice() as unknown as K, this.#value!];
    const istack: MapIterator<[unknown, Trie<ArrayType, T>]>[] = [this.#strongStore.entries()];
    while (istack.length) {
      const iter = istack[istack.length - 1].next();
      if (iter.done) {
        kstack.pop();
        istack.pop();
        continue;
      }
      const [key, trie] = iter.value;
      kstack.push(key);
      istack.push(trie.#strongStore.entries());
      if (trie.#hasValue)
        yield [kstack.slice() as unknown as K, trie.#value!];
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  *keys(): Generator<K, undefined, unknown> {
    const kstack: unknown[] = [];
    if (this.#hasValue)
      yield kstack.slice() as unknown as K;
    const istack: MapIterator<[unknown, Trie<ArrayType, T>]>[] = [this.#strongStore.entries()];
    while (istack.length) {
      const iter = istack[istack.length - 1].next();
      if (iter.done) {
        kstack.pop();
        istack.pop();
        continue;
      }
      const [key, trie] = iter.value;
      kstack.push(key);
      istack.push(trie.#strongStore.entries());
      if (trie.#hasValue)
        yield kstack.slice() as unknown as K;
    }
  }

  *values(): Generator<T, undefined, unknown> {
    if (this.#hasValue)
      yield this.#value!;
    const istack: MapIterator<Trie<ArrayType, T>>[] = [this.#strongStore.values()];
    while (istack.length) {
      const iter = istack[istack.length - 1].next();
      if (iter.done) {
        istack.pop();
        continue;
      }
      const trie = iter.value;
      istack.push(trie.#strongStore.values());
      if (trie.#hasValue)
        yield trie.#value!;
    }
  }

  clear() {
    for (const key of this.keys()) {
      this.delete(key);
    }
  }

  get size() {
    let count = 0;
    for (const item of this.values()) {
      count++;
    }
    return count;
  }
}
