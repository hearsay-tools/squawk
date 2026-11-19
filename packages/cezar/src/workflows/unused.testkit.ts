/** Unused collaborators fail at the first accidental access, including after constructor changes. */
export function unused<T extends object>(name: string, used: Partial<T> = {}): T {
  return new Proxy(used as T, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      throw new Error(`unused collaborator ${name}.${String(key)}`);
    },
  });
}
