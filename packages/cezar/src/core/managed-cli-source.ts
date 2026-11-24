export type ManagedCliDigestAlgorithm = 'sha256' | 'sha384' | 'sha512';

export interface ManagedCliDigest {
  readonly algorithm: ManagedCliDigestAlgorithm;
  readonly value: string;
}

export interface ManagedCliManifest {
  readonly version: string;
  readonly url: string;
  readonly digest: ManagedCliDigest;
}

export interface ManagedCliManifestContext {
  readonly target: string;
}

/** Parses one vendor manifest JSON payload into the normalized release shape the installer verifies. */
export type ManagedCliManifestParser = (raw: unknown, context: ManagedCliManifestContext) => ManagedCliManifest;

/** A host-target manifest with a verified, single-executable release. No network work at boot. */
export interface ManagedCliSource {
  readonly manifestUrl: string;
  readonly downloadUrlPrefix: string;
  readonly executable: string;
  readonly windowsExecutable: string;
  readonly parseManifest: ManagedCliManifestParser;
}
