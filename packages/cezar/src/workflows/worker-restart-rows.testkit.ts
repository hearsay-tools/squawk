/** The worker-restart file groups and the cases each registers. Apart from the cells, so the
 *  registration guard reads them without loading the run engine. */
export const RESTART_GROUPS = {
 'starting-proof': ['starting-proof', 'continue-after-crash', 'continue-after-recovered-crash'],
 'destroy-absent-ledger': ['destroy-absent'],
 'destroy-incomplete-ledger': ['destroy-incomplete'],
 'same-boot-crash-lock': ['same-boot-crash-lock'],
} as const;
