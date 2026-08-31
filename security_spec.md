# Firebase Security Audit - Migration Phase

## Data Invariants
1. A contact must belong to an organization.
2. A conversation must belong to an organization.
3. Users must be authenticated to read or write data.

## The "Dirty Dozen" Payloads (Deferred)
(Full testing deferred for speed of migration, default-deny strategy employed for unsupported paths)
