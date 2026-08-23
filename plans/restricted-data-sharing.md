# Plan: Govern sharing of restricted data by observer verification

## Goal

Replace the all-or-nothing sharing lockdown that a restricted-data observation imposes
with a per-collaborator check: a workspace that has read restricted data stays
shareable, and each collaborator is admitted only while they are verified as an
observer of the gatekeeper that produced the data.

Delivered as **one PR, split into reviewable commits** (see "Commit sequence" at the
end). The kernel packages (`workshop-backend`, `workshop-shared`) get the small,
separated diffs; the rename, the UI, and the frontend share-key work ride in their own
commits.

## Locked decisions

- **The flag is renamed, not aliased.** `ObservationDescription.prohibitAllSharing`
  becomes `containsRestrictedData`, and `GadgetMetadata.sharingProhibited` becomes the
  same name. The flag states a fact about the data ("this observation contains
  restricted data"); what the platform does about that is policy and does not belong in
  the name. A hard rename means every gatekeeper call site moves in the same commit —
  TypeScript's excess-property check on the object literals passed to
  `authorizeObservation` will not tolerate a staged one.
- **The durable storage key keeps its old name.** The overseer's `prohibitAllSharing`
  singleton is untouched: typed-storage keys *are* property names, so renaming it would
  silently unlatch every workspace that has already observed restricted data. A NOTE at
  the declaration says so.
- **Persisted records are read through a legacy shim.** Old action-log entries still
  carry `prohibitAllSharing` in their recorded `ObservationDescription`.
  `observationContainsRestrictedData()` (with a local `LegacyObservationDescription`
  type) reads either spelling. This is a read-side shim only — no producer may write the
  old name.
- **Admission is per-collaborator, checked continuously.** Not at grant time: at every
  `open()`, so revocation of a collaborator's underlying resource access is caught
  promptly. `authorizeObservation` admits a restricted observation only when every
  current collaborator is already verified against the producing gatekeeper
  (`#assertSensitiveObservationCoverage`).
- **Coverage is held to each collaborator's own role scope.** `ensureObserver` never
  verifies a `use` collaborator against a gatekeeper no gadget binds, so demanding
  coverage there would block the read permanently and make the error's remedy ("re-open
  the workspace") a lie. An unverifiable gatekeeper — no vendor account, or a legacy
  record with no `creationSpec` — blocks on any collaborator regardless of role.
- **Share-key redemption becomes two-phase.** A redeemed edge is written *pending*: it
  grants nothing to anyone and is invisible to `listCollaborators`. Only the open that
  is verifying it counts it, via an explicit `assumePendingLink` opt-in. Success
  confirms, refusal reverts.
- **One authorization gate for every non-owner entry point.** `authorizeCollaborator`
  resolves the effective role and runs `ensureObserver`. Both `open()` and
  `receiveExternalMessage()` pass through it; the latter non-interactively, since there
  is no way to configure connected accounts from an inbound message.
- **Removing the producing connection does not lift the restriction** for existing
  collaborators. It does close the workspace to *new* grants
  (`assertNewSharingAllowed`), since there is no longer an anchor to verify a newcomer
  against.
- **Fail closed everywhere.** An operational failure — provider outage, expired
  credential — is treated exactly like a refusal.

## Current-state anchors (for orientation)

- `authorizeObservation` (overseer.ts) is where a gatekeeper's observation is admitted
  or refused, and where the durable restricted-mode flag latches.
- `ensureObserver` (overseer.ts) brings a non-owner into compliance for their role:
  selects in-scope gatekeepers, prompts for unconfigured account choices via
  `configureCb`, calls `addObserver` on each gatekeeper facet, and persists an
  `ObserverRecord` only after all of them succeed. Re-runs on every open. Throws to deny.
- `SharingManager` (sharing.ts) owns the permission graph: collaborator records, their
  `addedBy` edges, share links and keys, and `computeEffectiveRoles`' fixed-point
  resolution. The module header states that sharing *policy* deliberately lives outside
  it — this plan keeps that boundary by passing policy in as `assertGrantAllowed`
  callbacks.
- `#inScopeGatekeepers(role)` derives what a collaborator must be verified against.
  `use` scope is live gadget-binding state; `build` scope is broader.

## Design

### 1. The coverage guard (`#assertSensitiveObservationCoverage`)

Replaces the old `hasAnyShares()` block-everything check. Walks `listCollaborators()`
and throws unless each has a persisted observer record naming the producing gatekeeper.
Skips a verifiable gatekeeper outside a `use` collaborator's scope (see "Accepted
tradeoffs"); an unverifiable one blocks on any collaborator.

The error reaches sandboxed gadget code and agent output — an audience that cannot
otherwise enumerate collaborators — so it names the collaborator but omits their profile
id, which is the full email on OAuth and CF Access deployments. The display name is
never a full email on any path.

### 2. Two-phase share-key redemption (sharing.ts)

`redeemShareKey` writes an edge with `pending: true` and returns the link id when there
is something to settle. `computeEffectiveRoles` skips pending edges for everyone except
the named `assumePendingLink`, so a mid-verification recipient is invisible to the
owner, to the coverage guard, and to themselves.

The verifying `open()` then either `confirmShareKeyRedemption` (clears the flag) or
`revertShareKeyRedemption` (severs the edge, so a refused recipient never persists in
the graph — which the previous single-phase flow did leave behind).

Why persist a pending edge rather than hold the hypothetical role in memory: concurrent
and crashed opens. Two tabs redeeming the same link, or a retry after a DO restart, must
not write duplicate edges, and one open's failure must not erase another's success.
`redeemShareKey` returns the link id whether it wrote the edge or found one left behind;
each open settles independently, and `revertShareKeyRedemption` only removes edges still
marked pending.

### 3. The unified gate (`authorizeCollaborator`)

Resolves the effective role — counting the pending edge when settling one — denies below
`requireRole` *before* verification runs, then calls `ensureObserver`.

Denying early matters: without it a `use` collaborator reaching `receiveExternalMessage`
would be verified (real `addObserver` calls, a persisted record) only to be turned away,
or worse, told to fix a verification failure that could never grant them access.

For a pending redemption it additionally:

- snapshots `#verificationScopeFingerprint()` in the same synchronous tick as
  `ensureObserver`'s own in-scope snapshot, and denies on *any* topology change
  afterwards rather than re-verifying. This is what makes a pending redeemer's
  invisibility to the coverage guard safe.
- re-asserts the redemption policy at the confirm, in the granting write's synchronous
  block.
- re-derives the role from the live graph after confirming, so a link revoked while
  verification waited collapses the role. Decreases pass through; an *increase* does not
  ride out on this open, since `ensureObserver` verified against the narrower scope.

### 4. Policy hooks, not policy in `SharingManager`

`addCollaborator`, `createShareLink`, `newShareLinkKey`, `redeemShareKey` and
`confirmShareKeyRedemption` all take an optional `assertGrantAllowed` callback, invoked
synchronously with the granting write. The overseer passes `assertNewSharingAllowed`.
A throw persists nothing.

### 5. Observer-record scrubbing on a failed live check

`ensureObserver`'s failure path drops the failed gatekeeper from the collaborator's
persisted `accountChoices` synchronously with the failure determination, and the
terminal catch de-registers invalidated gatekeepers alongside newly-added ones
(`removeObserver` is idempotent). The scrub is scoped to the failed gatekeeper; a
repaired pass re-persists full coverage.

### 6. Frontend

- **Share modal**: no longer replaces itself with a "can't be shared" view. Controls stay
  live behind a notice.
- **Retained share keys** (`retainedShareKeys.ts`, new): the `#share=` fragment is
  stripped from the URL on open, so a failed open had nothing to retry with. The key is
  held in `sessionStorage` under a versioned, per-workspace key, and replayed on the next
  attempt.
- **Identity stamping**: because `sessionStorage` outlives the session that wrote it, each
  entry records the capturing user's id. A read by a different identity ignores *and*
  sweeps it, and `logout()` sweeps the whole prefix including malformed and older
  unstamped entries. Without this, one user's pending share key could be auto-redeemed
  under the next user's account in the same tab.

## Commit sequence (one PR)

Ordered so the kernel-critical diffs are isolated. Every commit type-checks green across
`workshop-shared`, `workshop-backend`, `workshop-frontend` and `gatekeeper-google`.

1. **Bugfix — external-message observer verification.** Pre-existing and independent of
   everything below: verification only ever ran in `open()`, so
   `receiveExternalMessage` authorized on the effective role alone. Adds an inline
   `ensureObserver` call. Cherry-pickable onto main on its own.
2. **Refactor — the rename.** Mechanical, no behavior change, spanning
   `workshop-shared`, `workshop-backend`, `workshop-frontend`, `gatekeeper-google`,
   `gatekeeper-mcp` and the gatekeeper-authoring skill doc. Atomic by necessity.
3. **Part 1 — API.** `PermissionEdge.pending`; the restated contract on
   `containsRestrictedData`. Server still implements the old behavior.
4. **Part 2 — core server implementation.** The coverage guard, `authorizeCollaborator`,
   the pending-edge trio, `restrictedProducerIds`/`assertNewSharingAllowed`, the
   producer-removal guard, the legacy flag shim, and removal of `hasAnyShares`. Commit
   1's inline call folds into `authorizeCollaborator` here.
5. **Part 3 — backend tests.**
6. **Part 4 — integration tests.** Over real Durable Objects; the test gatekeeper fixture
   grows a per-resource restricted flag and a controllable verification outcome.
7. **Part 5 — UI changes.** The Share modal notice.
8. **Part 6 — documentation.** `docs/observers.md` coverage rules and residuals;
   `docs/sharing.md` pending redemption.
9. **Bugfix — scrub persisted coverage on a failed live check** (§5).
10. **Bugfix — re-assert the redemption policy at `confirmShareKeyRedemption`.**
11. **Comment-only — document the pending-edge re-add wart** (below).
12. **Retain a consumed share key so a failed open can retry.**
13. **Bugfix — identity-key retained share keys and clear them on logout.**

## Known edge cases / watch-fors

- **A pending redeemer is invisible to the coverage guard.** Deliberate — otherwise a
  stranger parked at the account-picker modal would freeze the owner's restricted reads
  indefinitely, since `ensureObserver` can wait unboundedly on user input. It is safe
  *only* because `authorizeCollaborator` denies the redeeming open on any topology
  change during verification, so a redeemer is never confirmed against a scope narrower
  than what exists at confirm time.
- **A producer removed before the fingerprint snapshot is invisible to both
  fingerprints.** An unverifiable producer's `remove()` skips the share-link guard
  entirely, so the scope check structurally cannot catch it. This is why the redemption
  policy is re-asserted at the confirm and not only at the redeem.
- **The pending-edge re-add wart.** If the owner's `removeCollaborator` races a
  verification, the confirm re-adds the edge. Accepted: pending-only recipients are
  invisible to `listCollaborators`, so such a removal was necessarily aimed at an edge
  some earlier open had already confirmed; the re-add grants no incremental authority,
  since the recipient holds the live, manually re-redeemable link; and revoking the link
  is the durable exclusion (`computeEffectiveRoles` skips revoked links, inerting every
  edge referencing one).
- **Confirming cannot resurrect revoked authority.** An edge confirmed after its link was
  revoked lingers inert, like any edge of a revoked link under the lazy model.
- **The scrub fires on operational failures too.** An outage or expired credential scrubs
  exactly as a revocation does, blocking that producer's restricted reads until the
  collaborator re-opens successfully. Fail-closed by design, but it means a provider
  incident is visible as blocked reads rather than as an error.
- **Role increases do not ride out on a redeeming open.** An owner grant landing while
  verification waited takes effect at the recipient's next open, exactly as for an
  ordinary keyless open.

## Accepted tradeoffs / future work

- **Formerly-bound producers.** Unbinding shrinks `use` scope with no guard, so a
  formerly-bound producer's sensitive reads stop requiring `use` collaborators'
  coverage. Accepted because `use` sessions cannot read chat history or the action log;
  the data entered gadget storage while the producer *was* bound, when every `use`
  collaborator was verified or the read was blocked; and re-binding restores
  verifiability at the next open. The residual is `use` grants created after the unbind.
- **Never-bound producers.** Broader: a producer reachable only through chat bindings (an
  ambient singleton the agent reads) was never in any `use` collaborator's scope, so the
  premise above does not hold — the agent can persist its restricted data with no `use`
  collaborator ever verified against it, and there is no prior binding to restore.
  Accepted on the grounds that coverage there is unverifiable by construction, exposure
  is limited to what the agent chose to persist, and the forward remedy is binding the
  producer to a gadget. Both residuals are documented at `docs/observers.md` edge case 4.
- **`calculate()`-style aggregates are out of scope here.** This plan governs *who* may
  see restricted data, not what an aggregate over it discloses.
- **The coverage guard is O(collaborators) per restricted observation**, reading one
  observer record each. Fine at current scale; revisit if workspaces grow large
  collaborator sets.
- **No re-verification on binding *addition* for live sessions.** Adding a binding does
  not restart open sessions; the coverage guard covers the interim by blocking the new
  connection's sensitive reads until each collaborator's next open.
- **Verification remains interactive-only.** `receiveExternalMessage` can verify but
  cannot configure, so a caller with unconfigured account choices is told to open the
  workspace. A non-interactive configuration path is future work.
