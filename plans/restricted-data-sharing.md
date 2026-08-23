# Plan: Govern sharing of restricted data by observer verification

## Goal

Replace the all-or-nothing sharing lockdown that a restricted-data observation imposes
with a per-collaborator check: a workspace that has read restricted data stays
shareable, and each collaborator is admitted only while they are verified as an
observer of the gatekeeper that produced the data.

**Known security limitation:** that guarantee is currently scoped by collaborator role.
A `use` collaborator is verified only against gatekeepers bound to a gadget. The workspace
agent can nevertheless read an unbound gatekeeper through a chat binding (including an
ambient singleton), persist its restricted result into gadget storage or UI state, and
thereby expose it to an unverified `use` collaborator. This plan accepts that risk for the
current implementation; "Never-bound producers" below records the exact boundary and the
required future remedies.

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
  current collaborator in whose role scope the producer falls is already verified
  against it (`#assertSensitiveObservationCoverage`). The exception for an unbound
  producer and a `use` collaborator is the known security risk stated above.
- **Coverage is held to each collaborator's own role scope.** `ensureObserver` never
  verifies a `use` collaborator against a gatekeeper no gadget binds, so demanding
  coverage there would block the read permanently and make the error's remedy ("re-open
  the workspace") a lie. This is a liveness tradeoff, not a security guarantee: restricted
  data can flow from that gatekeeper through the agent into gadget-visible state. An
  unverifiable gatekeeper — no vendor account, or a legacy record with no `creationSpec`
  — blocks on any collaborator regardless of role.
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

The base fixes PR introduces this gate (the role floor plus the `ensureObserver` call)
with `receiveExternalMessage` as its only caller; this PR extends it with the
pending-redemption machinery below and migrates `open()` onto it.

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

`ensureObserver` is serialized per profile (a promise chain, like
`#preparingChatMessages` -- `blockConcurrencyWhile` would freeze the DO across the
unbounded modal wait). Its body loads the observer record, awaits verifier RPCs and the
modal, and persists at the end; input gates don't cover those awaits, so without the
lock a concurrent open's final put resurrected coverage a failed check had just
scrubbed, and two concurrent first opens each minted their own `observerId`, orphaning
the loser's id inside the gatekeepers. One consequence: `authorizeCollaborator`
snapshots its scope fingerprint before queueing, so a queued open's snapshot is older
than its verification -- which fails closed (it can only deny more).

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
- **The in-memory tier is bound to its capturing stub**: it is replayed only on the same
  `authenticatedApi` that captured it; any other stub falls through to the
  identity-checked storage tier. This removes the reliance on the rendering invariant
  that an identity change unmounts the editor -- true today, but enforced two files away.
- **Stamps are generation-gated**: the async identity stamp commits through a write token
  taken at capture; clearing a workspace's entry (a successful open) or the logout sweep
  voids every earlier token, so a stamp resolving late cannot resurrect a cleared key.
  The invalidation lives in `retainedShareKeys.ts` because the storage outlives any one
  attempt -- a per-attempt flag guards only its own attempt's writes.
- **A superseded open bails after its identity await**, before creating any capability:
  its cleanup already ran with nothing to dispose, so proceeding would mint a stub
  nothing can reach and publish a stale (or wrong-workspace) capability.

## Commit sequence (one PR)

Ordered so the kernel-critical diffs are isolated. Every commit type-checks green across
`workshop-shared`, `workshop-backend`, `workshop-frontend` and `gatekeeper-google`.

Two pre-existing bugs this work surfaced ship as their own PR, based directly on main
and sitting below this one in the stack, since both are live on main today and neither
depends on the model change: **verify collaborators on the external-message path**
(verification only ever ran in `open()`, so `receiveExternalMessage` authorized on the
effective role alone) and **serialize observer verification per profile** (§5). The
first fix lands as the `authorizeCollaborator` gate itself (§3), which this PR then
extends; the fixes PR also carries the external-message integration coverage — the
harness's gateway bindings, the fixture's real sessions, and the two tests that
exercise base behavior (verification on the external path, and its role-before-
verification denial) — that Part 4 here builds on.

1. **Refactor — the rename.** Mechanical, no behavior change, spanning
   `workshop-shared`, `workshop-backend`, `workshop-frontend`, `gatekeeper-google`,
   `gatekeeper-mcp` and the gatekeeper-authoring skill doc. Atomic by necessity.
2. **Part 1 — API.** `PermissionEdge.pending`; the restated contract on
   `containsRestrictedData`. Server still implements the old behavior.
3. **Part 2 — core server implementation.** The coverage guard, `authorizeCollaborator`,
   the pending-edge trio, `restrictedProducerIds`/`assertNewSharingAllowed`, the
   producer-removal guard, the legacy flag shim, and removal of `hasAnyShares`. Extends
   the `authorizeCollaborator` gate the fixes PR introduced (pending-edge role
   computation, the scope fingerprint, the confirm and role re-derivation) and migrates
   `open()` onto it.
4. **Part 3 — backend tests.**
5. **Part 4 — integration tests.** Over real Durable Objects; the test gatekeeper fixture
   grows a per-resource restricted flag and a controllable verification outcome. The
   external-message gate's base-behavior tests live in the fixes PR
   (`external-message-verification.test.ts`); this commit adds the restricted-data
   scenarios on top.
6. **Part 5 — UI changes.** The Share modal notice.
7. **Part 6 — documentation.** `docs/observers.md` coverage rules and residuals;
   `docs/sharing.md` pending redemption.
8. **Bugfix — scrub persisted coverage on a failed live check** (§5).
9. **Bugfix — re-assert the redemption policy at `confirmShareKeyRedemption`.**
10. **Comment-only — document the pending-edge re-add wart** (below).
11. **Retain a consumed share key so a failed open can retry.**
12. **Bugfix — identity-key retained share keys and clear them on logout.**
13. **Bugfix — abandon a superseded workspace open before it creates a capability** (§6).
14. **Bugfix — bind the retained share key to the session that captured it** (§6).
15. **Bugfix — invalidate a pending share-key stamp on discard and logout** (§6).
16. **Cover the observer-coverage scrub against a concurrent open** — the §5 lock and
    scrub compose; asserted once both exist.

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
- **Open gap, NOT implemented in this PR — removing an unverifiable restricted producer
  unblocks its collaborators.** `remove()`'s producer guard exempts unverifiable records
  ("removing one is itself a remedy"), which is backwards once the data has been read:
  the record is the *blocker* -- `#inScopeGatekeepers` throws on it, so no collaborator
  can open -- and removing it lets every existing collaborator open unverified while the
  restricted data persists in chat history, gadget storage and code.
  `assertNewSharingAllowed` only stops *new* grants. Decided remedy, for a follow-up:
  guard unverifiable producers like any other -- the owner must remove all collaborators
  and revoke all share links before removal, after which the workspace is permanently
  owner-only (`restrictedProducerIds()` reads the action log, which never forgets the
  producer). Fail-closed and preferable to exposing data nothing can verify anymore.

## Accepted tradeoffs / future work

- **Formerly-bound producers.** Unbinding shrinks `use` scope with no guard, so a
  formerly-bound producer's sensitive reads stop requiring `use` collaborators'
  coverage. Accepted because `use` sessions cannot read chat history or the action log;
  the data entered gadget storage while the producer *was* bound, when every `use`
  collaborator was verified or the read was blocked; and re-binding restores
  verifiability at the next open. The residual is `use` grants created after the unbind.
- **Known security risk — never-bound producers.** A producer reachable only through chat
  bindings (including an ambient singleton) is never in a `use` collaborator's verification
  scope. The agent can read restricted data from it, persist the result into gadget code,
  storage, or UI state, and the collaborator can then read that state through the deployed
  gadget despite never passing the producer's `addObserver()` check. The coverage guard
  deliberately skips this collaborator, so `containsRestrictedData` does not prevent this
  disclosure. Binding the producer makes future opens verifiable but does not retract data
  already exposed. Accepted temporarily to avoid making the read permanently unavailable
  under the current role-scoped model. The required fix is either workspace-wide observer
  verification for `use` collaborators or enforceable provenance that prevents data from an
  unverified producer reaching their gadget-visible state. Both this and the formerly-bound
  residual are documented at `docs/observers.md` edge case 4.
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
