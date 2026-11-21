/** A host-target manifest with a verified, single-executable release. No network work at boot. */
export interface ManagedCliSource {
  readonly manifestUrl: string;
  readonly downloadUrlPrefix: string;
  readonly executable: string;
  readonly windowsExecutable: string;
}
