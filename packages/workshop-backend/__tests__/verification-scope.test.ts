// authorizeCollaborator must deny a pending share-key redemption whose verification-scope inputs
// changed while its verification was parked (typically in the recipient's configuration modal).
// The old guard compared a content fingerprint of the two id sets, which an add-then-remove (or
// bind-then-unbind) reverts to byte-identical: the redeemer -- invisible to the coverage guard
// while their edge is pending -- was confirmed without ever verifying against the interim
// topology. The fix is an event-driven generation counter (#scopeGeneration) bumped by
// typed-storage subscribers, which registers every relevant transition including one that
// restores the previous value.
//
// A denial must also leave nothing behind: the check and the confirming grant run as
// ensureObserver's commit gate, synchronously with the observer-record persist, so a rejected
// redemption takes the first-ever-failure rollback (no record, no gatekeeper registration, no
// pending id). An older shape persisted the record *before* the denial ran, which both let
// #decideExcludeObservers read the never-admitted redeemer as "lost access" (admitting an
// excluded observation) and broke the !record discriminator for the retry's whole parked window.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-serialization.test.ts); the gatekeeper facet and the client's User DO are the fakes.

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

// Seeds a workspace mid-redemption: connection 1, a live share link, bob holding the link's
// still-pending edge, and a bindingless permanent gadget to mutate. Returns the parked open:
// authorizeCollaborator is holding in bob's configuration modal, whose release the test controls.
function startParkedRedemption(instance: OverseerDurableObject): {
  impl: any;
  open: Promise<unknown>;
  release: () => void;
  observerCalls: { added: string[]; removed: string[] };
} {
  let impl = (instance as unknown as { impl: any }).impl;
  impl.ownerProfileId = OWNER;
  seedGatekeeper(impl, 1);
  impl.storage.shareKeys.put({
    id: "link-1", created: new Date(), createdBy: OWNER, role: "build",
  });
  impl.storage.collaborators.put({
    profile: { id: "bob", name: "Bob" },
    addedBy: [{
      type: "shareKey", keyId: "link-1", created: new Date(), role: "build", pending: true,
    }],
  });
  impl.storage.gadgets.put({
    id: 100, title: "My App", created: new Date(), bindingName: "MYAPP", bindings: {},
  });
  let observerCalls = { added: [] as string[], removed: [] as string[] };
  impl.getGatekeeperFacet = () => ({
    addObserver: async (id: string) => { observerCalls.added.push(id); },
    removeObserver: async (id: string) => { observerCalls.removed.push(id); },
  });

  let held = deferred();
  let configureCb = {
    configure: async () => {
      await held.promise;
      return [{ gatekeeperId: 1, accountId: 10 }];
    },
  } as any;
  let fakeClientUser = { getVerifier: async () => ({}) } as any;

  let open = impl.authorizeCollaborator(
      "bob", fakeClientUser, { configureCb, pendingLinkId: "link-1" });
  return { impl, open, release: held.resolve, observerCalls };
}

describe("verification-scope change detection across a redemption", () => {
  it("denies a bind-then-unbind reverted within the verification window", async () => {
    let stub = env.TEST_OVERSEER.getByName("verification-scope-bind-aba");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release } = startParkedRedemption(instance);
      await tick();

      // Bind connection 1 into the gadget, then unbind it: the id sets end byte-identical, but
      // bob's verification never ran against the interim topology (and, invisible to the
      // coverage guard while pending, was not protected by it either).
      let gadget = impl.storage.gadgets.get(100);
      gadget.bindings.API = { target: 1 };
      impl.storage.gadgets.put(gadget);
      gadget = impl.storage.gadgets.get(100);
      delete gadget.bindings.API;
      impl.storage.gadgets.put(gadget);

      release();
      // Pre-fix the fingerprint compare read the reverted sets as unchanged and confirmed bob.
      await expect(open).rejects.toThrow(/changed in this workspace/);
      expect(impl.storage.collaborators.get("bob").addedBy[0].pending).toBe(true);
      // The denial ran as ensureObserver's commit gate, so no observer record was left behind.
      expect(impl.storage.observers.get("bob")).toBeUndefined();
    });
  });

  it("denies a connection add-then-remove reverted within the verification window", async () => {
    let stub = env.TEST_OVERSEER.getByName("verification-scope-gatekeeper-aba");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release } = startParkedRedemption(instance);
      await tick();

      seedGatekeeper(impl, 2);
      impl.storage.gatekeepers.delete(2);

      release();
      await expect(open).rejects.toThrow(/changed in this workspace/);
      expect(impl.storage.observers.get("bob")).toBeUndefined();
    });
  });

  it("ignores gadget writes that cannot move the scope", async () => {
    let stub = env.TEST_OVERSEER.getByName("verification-scope-noop-writes");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release } = startParkedRedemption(instance);
      await tick();

      // Retitling and advancing the head are the config modal's most likely concurrent
      // neighbors; neither touches the bound-gatekeeper set, so neither may deny bob.
      let gadget = impl.storage.gadgets.get(100);
      gadget.title = "Renamed App";
      gadget.commitId = "0123456789abcdef0123456789abcdef01234567";
      impl.storage.gadgets.put(gadget);

      release();
      await expect(open).resolves.toBe("build");
      expect(impl.storage.collaborators.get("bob").addedBy[0].pending).toBeUndefined();
    });
  });

  it("still denies a single un-reverted change", async () => {
    let stub = env.TEST_OVERSEER.getByName("verification-scope-single-change");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release } = startParkedRedemption(instance);
      await tick();

      seedGatekeeper(impl, 2);

      release();
      await expect(open).rejects.toThrow(/changed in this workspace/);
    });
  });

  it("a denied redemption leaves nothing behind and its retry stays fail-closed", async () => {
    let stub = env.TEST_OVERSEER.getByName("verification-scope-denied-rollback");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let { impl, open, release, observerCalls } = startParkedRedemption(instance);
      await tick();

      // Deny via a reverted connection add: the generation counter registers it, but the id sets
      // end unchanged, so the retry below verifies against the same single connection.
      seedGatekeeper(impl, 2);
      impl.storage.gatekeepers.delete(2);

      release();
      await expect(open).rejects.toThrow(/changed in this workspace/);

      // Nothing left behind: no observer record, the minted id de-registered from the gatekeeper,
      // and the edge still pending (severing it is open()'s job, not authorizeCollaborator's).
      expect(impl.storage.observers.get("bob")).toBeUndefined();
      expect(observerCalls.added).toHaveLength(1);
      expect(observerCalls.removed).toEqual(observerCalls.added);
      let oldId = observerCalls.added[0];
      expect(impl.storage.collaborators.get("bob").addedBy[0].pending).toBe(true);

      // Retry the redemption, parked inside its addObserver: the freshly minted id is registered
      // with the gatekeeper but its record is not yet persisted -- the #pendingObserverIds window.
      let held = deferred();
      let retryAdded: string[] = [];
      impl.getGatekeeperFacet = () => ({
        addObserver: async (id: string) => { retryAdded.push(id); await held.promise; },
      });
      let configureCb = {
        configure: async () => [{ gatekeeperId: 1, accountId: 10 }],
      } as any;
      let retry = impl.authorizeCollaborator(
          "bob", { getVerifier: async () => ({}) } as any,
          { configureCb, pendingLinkId: "link-1" });
      await tick();

      expect(retryAdded).toHaveLength(1);
      let newId = retryAdded[0];
      // The rollback means the retry is a first-ever verification again: a fresh id, not the
      // rolled-back one (which the gatekeepers no longer hold).
      expect(newId).not.toBe(oldId);

      // An observation excluding the mid-verification id must fail closed. Pre-fix, the first
      // attempt's leftover record made the retry skip the #pendingObserverIds guard (!record was
      // false) and re-use oldId, which resolved to a profile with no effective role -- read as
      // "lost access", so the excluded observation was allowed.
      await expect(impl.authorizeObservation(1, {
        title: "Read a thing", description: "The test read a thing.",
        excludeObservers: [newId],
      }, { from: "user" })).rejects.toThrow(/currently being verified/);
      // The rolled-back first id is inert: nothing resolves it, so exclusion ignores it.
      await expect(impl.authorizeObservation(1, {
        title: "Read a thing", description: "The test read a thing.",
        excludeObservers: [oldId],
      }, { from: "user" })).resolves.toBeUndefined();

      held.resolve();
      await expect(retry).resolves.toBe("build");
      expect(impl.storage.observers.get("bob")).toBeDefined();
      expect(impl.storage.collaborators.get("bob").addedBy[0].pending).toBeUndefined();
    });
  });

  it("a denied upgrade redemption keeps the existing observer's record and registrations",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("verification-scope-upgrade-denied");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerProfileId = OWNER;
      seedGatekeeper(impl, 1);
      impl.storage.shareKeys.put({
        id: "link-1", created: new Date(), createdBy: OWNER, role: "use",
      });
      impl.storage.shareKeys.put({
        id: "link-2", created: new Date(), createdBy: OWNER, role: "build",
      });
      // Bob is already an admitted collaborator (confirmed link-1 edge, persisted covering
      // record); the pending edge on link-2 is the upgrade this open is verifying.
      impl.storage.collaborators.put({
        profile: { id: "bob", name: "Bob" },
        addedBy: [
          { type: "shareKey", keyId: "link-1", created: new Date(), role: "use" },
          { type: "shareKey", keyId: "link-2", created: new Date(), role: "build", pending: true },
        ],
      });
      impl.storage.observers.put(
          { profileId: "bob", observerId: "obs-b", accountChoices: { 1: 10 } });

      // Park the re-verification inside addObserver (the record covers everything, so there is
      // no configuration modal to park in), then deny on topology.
      let held = deferred();
      let removed: string[] = [];
      impl.getGatekeeperFacet = () => ({
        addObserver: async () => { await held.promise; },
        removeObserver: async (id: string) => { removed.push(id); },
      });
      let open = impl.authorizeCollaborator(
          "bob", { getVerifier: async () => ({}) } as any, { pendingLinkId: "link-2" });
      await tick();

      seedGatekeeper(impl, 2);
      impl.storage.gatekeepers.delete(2);

      held.resolve();
      await expect(open).rejects.toThrow(/changed in this workspace/);

      // The commit-gate denial must not roll back what an earlier successful open established:
      // bob *was* admitted (the !record boundary), so the record and the gatekeeper registration
      // stay -- they are what the coverage guard and forward exclusion rest on for bob's
      // still-live sessions -- and only the upgrade edge remains pending.
      expect(impl.storage.observers.get("bob")).toEqual(
          { profileId: "bob", observerId: "obs-b", accountChoices: { 1: 10 } });
      expect(removed).toEqual([]);
      expect(impl.storage.collaborators.get("bob").addedBy[1].pending).toBe(true);
    });
  });
});
