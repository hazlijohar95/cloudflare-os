// authorizeCollaborator's commit gate must re-check the caller's live role for *every*
// verification, not just share-key redemptions. A keyless open parks in ensureObserver across
// real await windows (verifier RPCs, even the configuration modal), and a removal landing there
// used to be caught only by the revocation restart -- which fires after the teardown/listing
// phases, so a verification resolving inside that window slipped through: step 6's blind
// observers.put *resurrected* the record tearDownLostObservers had just deleted (record and
// account choices were loaded pre-park), leaving a removed user with coverage that a later
// re-grant would trust without re-verification, and the open returned a full stale-role
// capability besides. The gate now denies at commit time, and the post-verification role
// re-derivation (previously redemption-only) caps a mid-park downgrade at the live role.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// verification-scope.test.ts); the gatekeeper facet and the client's User DO are the fakes. Bob
// is a *returning* collaborator (persisted covering record), so the open parks inside step 5's
// addObserver -- no configuration modal is involved.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "alice";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  let promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Seeds bob as a confirmed "build" collaborator with a covering observer record, parks the
// gatekeeper facet's addObserver on a deferred, and starts bob's keyless open.
function startParkedKeylessOpen(instance: OverseerDurableObject): {
  impl: any;
  open: Promise<unknown>;
  release: () => void;
} {
  let impl = (instance as unknown as { impl: any }).impl;
  impl.ownerProfileId = OWNER;
  impl.storage.gatekeepers.put({
    id: 1,
    resourceTitle: "Connection 1",
    class: {} as any,
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: "https://example.com/1",
      typeUrlPattern: "https://*",
    },
  });
  impl.storage.collaborators.put({
    profile: { id: "bob", name: "Bob" },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
  });
  impl.storage.observers.put(
      { profileId: "bob", observerId: "obs-b", accountChoices: { 1: 10 } });

  let held = deferred();
  impl.getGatekeeperFacet = () => ({
    addObserver: async () => { await held.promise; },
    removeObserver: async () => {},
  });

  let open = impl.authorizeCollaborator("bob", { getVerifier: async () => ({}) } as any, {});
  return { impl, open, release: held.resolve };
}

describe("the commit gate on keyless opens", () => {
  it("denies a mid-verification removal and does not resurrect the torn-down record",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("keyless-commit-gate-removal");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release } = startParkedKeylessOpen(instance);
      await tick();

      // The owner removes bob while his re-verification is parked: the sever and the observer
      // teardown run exactly as removeCollaborator drives them. The revocation restart would
      // eventually kill this DO, but the parked verification can resolve before it lands.
      let record = impl.storage.collaborators.get("bob");
      impl.storage.collaborators.delete("bob");
      await impl.tearDownLostObservers(
          [{ profile: record.profile, addedBy: record.addedBy, oldRole: "build", newRole: null }]);
      expect(impl.storage.observers.get("bob")).toBeUndefined();

      release();
      // Pre-fix the keyless path had no commit gate: the open resolved "build"...
      await expect(open).rejects.toThrow(/revoked while it was being verified/);
      // ...and step 6's put resurrected the record the teardown just deleted, coverage a later
      // re-grant would then trust without re-verification.
      expect(impl.storage.observers.get("bob")).toBeUndefined();
    });
  });

  it("caps a mid-verification downgrade at the live role", async () => {
    let stub = env.TEST_OVERSEER.getByName("keyless-commit-gate-downgrade");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release } = startParkedKeylessOpen(instance);
      await tick();

      // The owner downgrades bob's edge to "use" while his verification is parked. The gate
      // passes (his role is still non-null, and verification at the pre-park "build" scope
      // covers the narrower "use" scope), but the capability handed out must be the live role.
      let record = impl.storage.collaborators.get("bob");
      record.addedBy[0].role = "use";
      impl.storage.collaborators.put(record);

      release();
      await expect(open).resolves.toBe("use");
      expect(impl.storage.observers.get("bob")).toBeDefined();
    });
  });
});
