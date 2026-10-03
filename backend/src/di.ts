// A minimal hand-rolled dependency-injection container: typed tokens +
// lazy singletons. There is no DI framework in the project on purpose —
// this is the whole machinery.
//
// The composition root (backend/src/index.ts) registers the services and
// resolves them; the consumers receive their dependencies through
// constructors and never touch the container themselves.

export interface Token<T> {
  readonly key: symbol;
  // Phantom type marker: makes Token<A> and Token<B> mutually incompatible
  // in TypeScript while adding nothing at runtime.
  readonly type?: T;
}

export function createToken<T>(description: string): Token<T> {
  return { key: Symbol(description) };
}

export class Container {
  private readonly factories = new Map<symbol, (c: Container) => unknown>();
  private readonly instances = new Map<symbol, unknown>();

  // Registers a lazily created singleton: the factory runs on the first
  // resolve, its result is cached for every subsequent one. Re-registering
  // the same token replaces the factory and drops the cached instance.
  register<T>(token: Token<T>, factory: (c: Container) => T): void {
    this.factories.set(token.key, factory);
    this.instances.delete(token.key);
  }

  resolve<T>(token: Token<T>): T {
    if (!this.instances.has(token.key)) {
      const factory = this.factories.get(token.key);
      if (!factory) {
        throw new Error(`No provider registered for ${String(token.key)}`);
      }
      this.instances.set(token.key, factory(this));
    }
    return this.instances.get(token.key) as T;
  }
}
