declare const __PRODUCT_IDENTITY__: { displayName: string; command: string; npx: string }

/** The installed command comes from the build identity. */
export function productCommand(identity = __PRODUCT_IDENTITY__): string {
  return identity.command
}
