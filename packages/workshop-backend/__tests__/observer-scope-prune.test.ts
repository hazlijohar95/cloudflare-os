// ensureObserver must prune out-of-scope account choices from the observer record at every open,
// restoring the coverage guard's invariant "entry present => verified at this collaborator's most
// recent open". Without the prune, a "use" collaborator opening while a connection is unbound
// from every gadget verifies nothing against it, yet their stale entry survives; rebinding the
// connection keeps the same gatekeeper id (only gadget binding edges change), so the guard would
// trust coverage that the collaborator's opens during the unbound window never re-verified.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-serialization.test.ts) so ensureObserver's storage and the coverage guard are real; the
// gatekeeper facet and the client's User DO are the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

function seedGatekeepers(impl: any): void {
  for (let id of [1, 2]) {
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
}

// A gadget that binds only gatekeeper 1, leaving gatekeeper 2 out of "use" scope.
function seedGadgetBindingGk1(impl: any): void {
  impl.storage.gadgets.put({
    id: 100,
    title: "G",
    created: new Date(),
    bindingName: "G",
    bindings: { DB: { target: 1 } },
  });
}

// A client User DO that always has the account and always mints a verifier.
const fakeClientUser = {
  getVerifier: async () => ({}),
} as any;

describe("ensureObserver out-of-scope coverage pruning", () => {
  it("prunes an unbound gatekeeper's entry at a use-role open", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-scope-prune-use");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      seedGadgetBindingGk1(impl);
      impl.ownerProfileId = "owner";
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let verified: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => { verified.push(id); },
      });

      await impl.ensureObserver("alice", fakeClientUser, "use");

      // Gatekeeper 2 is outside "use" scope: its stale entry is gone, and nothing re-verified it.
      expect(verified).toEqual([1]);
      expect(impl.storage.observers.get("alice").accountChoices).toEqual({ 1: 10 });
    });
  });

  it("prunes everything at an empty-scope open, keeping the record", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-scope-prune-empty");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      // No gadgets at all: a "use" collaborator's verification scope is empty.
      impl.ownerProfileId = "owner";
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      // No configureCb: the open must still resolve (nothing in scope to configure), and it must
      // still prune -- this is exactly the everything-unbound open the fix exists for.
      await impl.ensureObserver("alice", fakeClientUser, "use");

      let record = impl.storage.observers.get("alice");
      expect(record).toBeDefined();
      expect(record.accountChoices).toEqual({});
    });
  });

  it("keeps unbound gatekeepers' entries at a build-role open", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-scope-prune-build");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      seedGadgetBindingGk1(impl);
      impl.ownerProfileId = "owner";
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let verified: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => { verified.push(id); },
      });

      // "build" scope is every account-requiring gatekeeper regardless of gadget bindings, so
      // both entries are in scope and nothing may be pruned (guards against over-pruning).
      await impl.ensureObserver("alice", fakeClientUser, "build");

      expect(verified.toSorted()).toEqual([1, 2]);
      expect(impl.storage.observers.get("alice").accountChoices).toEqual({ 1: 10, 2: 20 });
    });
  });

  it("blocks a rebound producer's restricted reads until the collaborator re-opens", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-scope-prune-rebind");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      seedGadgetBindingGk1(impl);
      impl.ownerProfileId = "owner";
      // Alice is a "use" collaborator with stale coverage for gatekeeper 2, left over from before
      // it was unbound from every gadget.
      impl.storage.collaborators.put({
        profile: { type: "user", id: "alice", name: "Alice" },
        addedBy: [{ type: "user", sharer: "owner", created: new Date(), role: "use" }],
      });
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      impl.getGatekeeperFacet = () => ({ addObserver: async () => {} });

      // Alice opens during the unbound window: gatekeeper 2 is out of her scope, so this open
      // verifies nothing against it -- and prunes her stale entry.
      await impl.ensureObserver("alice", fakeClientUser, "use");

      // Rebind gatekeeper 2 (same gatekeeper id -- only the gadget's binding edges change).
      let gadget = impl.storage.gadgets.get(100);
      gadget.bindings.DB2 = { target: 2 };
      impl.storage.gadgets.put(gadget);

      // Its restricted reads must now be blocked: Alice's most recent open never verified her
      // against gatekeeper 2. Pre-fix, the stale entry survived the open and this resolved.
      await expect(impl.authorizeObservation(
          2, { title: "t", description: "d", containsRestrictedData: true }, { from: "user" }))
          .rejects.toThrow(/not been verified/);
    });
  });
});
