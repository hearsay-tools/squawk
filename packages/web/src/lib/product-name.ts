declare const __PRODUCT_IDENTITY__: { displayName: string; command: string; npx: string }

/** Display prose only. Persisted names, paths and protocol values keep their identity.
 *  The `_legacy` argument is ignored: it keeps the call sites' old spelling until
 *  hearsay-tools/squawk#3509 rewrites them as literals. */
export function productName(
  _legacy: 'cezar' | 'Cezar' | 'Cezarion',
  identity = __PRODUCT_IDENTITY__,
): string {
  return identity.displayName
}

/** The installed command comes from the same build identity as product prose. */
export function productCommand(identity = __PRODUCT_IDENTITY__): string {
  return identity.command
}
