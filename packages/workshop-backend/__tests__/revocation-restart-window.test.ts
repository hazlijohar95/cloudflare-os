// A revocation's DO abort (scheduleRevocationRestart) is what actually ends the removed
// collaborator's live sessions, but it runs only after two awaited RPC phases --
// tearDownLostObservers (serial removeObserver fan-out per collaborator) and
// refreshAffectedCollaboratorListings (chunked cross-DO round trips) -- a window that scales with
// collaborator and gatekeeper count, not the ~100ms the abort's own delay suggests. Inside that
// window the removed user still watches the session fan-out, yet both observation gates read
// them as gone: #decideExcludeObservers admits an observation naming them (their record was
// already deleted, so the id is unknown), and #assertSensitiveObservationCoverage's
// zero-collaborators early return admits restricted data when the *last* collaborator was
// removed. Both must instead fail closed until the restart lands, via the in-memory
// #revocationRestartPending flag tearDownLostObservers sets synchronously with the sever.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// verification-scope.test.ts); the gatekeeper facet is the fake, and the teardown's removeObserver
// is parked on a deferred so the tests occupy the window deterministically. No real DO abort ever
// fires here (scheduleRevocationRestart is not called).

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

function seedGatekeeper(impl: any, id: number): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Connection ${id}`,
    class: {} as any,
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

// Seeds a workspace with connection 1 and bob as a confirmed collaborator holding a covering
// observer record, and parks the gatekeeper facet's removeObserver on a deferred the test
// releases -- the teardown window under test.
function setup(instance: OverseerDurableObject): {
  impl: any;
  releaseTeardown: () => void;
  removed: string[];
} {
  let impl = (instance as unknown as { impl: any }).impl;
  impl.ownerProfileId = OWNER;
  seedGatekeeper(impl, 1);
  impl.storage.collaborators.put({
    profile: { id: "bob", name: "Bob" },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
  });
  impl.storage.observers.put(
      { profileId: "bob", observerId: "obs-b", accountChoices: { 1: 10 } });

  let held = deferred();
  let removed: string[] = [];
  impl.getGatekeeperFacet = () => ({
    addObserver: async () => {},
    removeObserver: async (id: string) => { removed.push(id); await held.promise; },
  });
  return { impl, releaseTeardown: held.resolve, removed };
}

// Severs bob's edge and starts the teardown in the same synchronous block, exactly as
// removeCollaborator does (SharingManager.removeCollaborator is synchronous, and the handler
// awaits tearDownLostObservers immediately after).
function severBob(impl: any): Promise<void> {
  let record = impl.storage.collaborators.get("bob");
  impl.storage.collaborators.delete("bob");
  return impl.tearDownLostObservers(
      [{ profile: record.profile, addedBy: record.addedBy, oldRole: "build", newRole: null }]);
}

const excludedObservation = (excludeObservers: string[]) =>
    ({ title: "Read a thing", description: "The test read a thing.", excludeObservers });
const restrictedObservation =
    { title: "Read a secret", description: "The test read a secret.",
      containsRestrictedData: true };

describe("observation gates during the revocation-restart window", () => {
  it("fails an excluded observation closed while the teardown is parked", async () => {
    let stub = env.TEST_OVERSEER.getByName("revocation-window-excluded");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, releaseTeardown } = setup(instance);
      let teardown = severBob(impl);
      await tick();

      // Bob's record was deleted synchronously at the sever, so byObserverId no longer resolves
      // obs-b: pre-fix the id read as "not an active observer" and the observation naming bob was
      // admitted -- into chat history his still-live session watches.
      await expect(impl.authorizeObservation(1, excludedObservation(["obs-b"]), { from: "user" }))
          .rejects.toThrow(/just revoked/);

      releaseTeardown();
      await teardown;

      // The flag is never cleared: the restart is what ends the window, and if it were somehow
      // lost, staying blocked is the safe direction.
      await expect(impl.authorizeObservation(1, excludedObservation(["obs-b"]), { from: "user" }))
          .rejects.toThrow(/just revoked/);
    });
  });

  it("fails a restricted observation closed without latching", async () => {
    let stub = env.TEST_OVERSEER.getByName("revocation-window-restricted");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, releaseTeardown } = setup(instance);
      let teardown = severBob(impl);
      await tick();

      // Bob was the *last* collaborator, so the coverage guard's zero-collaborators early return
      // is exactly what pre-fix admitted the restricted read -- while bob still watched.
      await expect(impl.authorizeObservation(1, restrictedObservation, { from: "user" }))
          .rejects.toThrow(/just revoked/);
      // A blocked observation delivers no data, so it must not have latched restricted mode.
      expect(impl.storage.prohibitAllSharing.get()).toBeFalsy();

      releaseTeardown();
      await teardown;
      await expect(impl.authorizeObservation(1, restrictedObservation, { from: "user" }))
          .rejects.toThrow(/just revoked/);
    });
  });

  it("a no-op sharing change does not block observations", async () => {
    let stub = env.TEST_OVERSEER.getByName("revocation-window-noop");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl } = setup(instance);
      // A removal that affected nobody (e.g. severing an edge nobody relied on) skips the restart,
      // so it must not block observations either -- same predicate as the restart's.
      await impl.tearDownLostObservers([]);

      await expect(impl.authorizeObservation(1, restrictedObservation, { from: "user" }))
          .resolves.toBeUndefined();
    });
  });
});
