// authorizeObservation must check and write in one synchronous block (the house rule -- cf.
// addCollaborator): the coverage check, the exclusion decision, the restricted latch, and the
// action record. The old shape awaited the excluded observers' cross-worker teardown *between*
// the checks and the latch, opening a window where the workspace had delivered restricted data
// but removalBlockedByRestrictedData and assertNewSharingAllowed still read the latch as unset --
// so the producer could be removed and new sharing granted mid-observation. It also lacked any
// guard against a restricted observation arriving through an already-removed connection (an
// in-flight facet RPC can outlive removeGatekeeper), which with zero collaborators sailed past
// the coverage check's early return and latched a missing producer id -- permanently bricking
// sharing via assertNewSharingAllowed's missing-record branch.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// restricted-producer-removal.test.ts); the gatekeeper facet is the only fake.

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

function getImpl(instance: OverseerDurableObject): any {
  let impl = (instance as unknown as { impl: any }).impl;
  // The sharing manager resolves collaborator reachability from the owner; seed the cached
  // profile id so no User DO round trip is attempted.
  impl.ownerProfileId = OWNER;
  return impl;
}

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

describe("authorizeObservation's synchronous check-and-latch", () => {
  it("keeps the latch and the checks unbroken across the excluded observers' teardown", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-teardown-window");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // An outstanding share link keeps the workspace "shared" for
      // removalBlockedByRestrictedData without any collaborator blocking the coverage check.
      impl.storage.shareKeys.put({
        id: "link-1", created: new Date(), createdBy: OWNER, role: "build",
      });
      // Mallory holds an observer record but no reachable role: the named exclusion admits the
      // observation and schedules her teardown.
      impl.storage.observers.put(
          { profileId: "mallory", observerId: "obs-m", accountChoices: { 1: 10 } });

      // The cross-worker teardown parks, holding the observation in what used to be the window
      // between the checks and the latch.
      let held = deferred();
      impl.getGatekeeperFacet = () => ({
        removeObserver: async () => { await held.promise; },
      });

      let observation = impl.authorizeObservation(1, {
        title: "Read a thing",
        description: "The test read a thing.",
        containsRestrictedData: true,
        excludeObservers: ["obs-m"],
      }, { from: "user" });
      await tick();

      // The restricted data is being delivered, so the latch -- and everything keyed on it --
      // must already hold while the teardown is still in flight. Pre-fix both read false here:
      // the producer could be removed and new sharing granted mid-observation.
      expect(impl.storage.prohibitAllSharing.get()).toBe(true);
      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(true);

      held.resolve();
      await expect(observation).resolves.toBeUndefined();

      // The teardown still ran (mallory is no longer set up to observe), and the action record
      // landed.
      expect(impl.storage.observers.get("mallory")).toBeUndefined();
      let records = [...impl.storage.actions.list()];
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe("observation");
    });
  });

  it("refuses restricted data through a removed connection instead of bricking sharing", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-missing-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      // No gatekeeper record: the in-flight facet RPC outlived removeGatekeeper. With zero
      // collaborators the coverage check's early return admits it, so only this guard stands
      // between the observation and latching a missing producer id.
      await expect(impl.authorizeObservation(1, {
        title: "Read a thing",
        description: "The test read a thing.",
        containsRestrictedData: true,
      }, { from: "user" })).rejects.toThrow(/has been removed/);

      // A blocked observation delivered no data: the workspace must not be left restricted --
      // and above all must not be left permanently unshareable (pre-fix,
      // assertNewSharingAllowed's missing-record branch threw here forever).
      expect(impl.storage.prohibitAllSharing.get()).toBe(false);
      expect(() => impl.assertNewSharingAllowed()).not.toThrow();
    });
  });
});
