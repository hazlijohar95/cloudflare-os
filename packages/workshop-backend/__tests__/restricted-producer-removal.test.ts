// removalBlockedByRestrictedData() is the single predicate behind the producer-removal guard:
// GatekeeperClientImpl.remove() refuses on it, and ensureAmbientCapsules()'s reconciliation skips
// stale records on it. It must block exactly when deleting the record would readmit an unverified
// party -- the workspace is latched, the record is a restricted producer (verifiable or not), and
// the sharing graph still has collaborators or outstanding share links.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-serialization.test.ts) so the predicate reads real storage; records are seeded
// directly through the impl.

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

function getImpl(instance: OverseerDurableObject): any {
  let impl = (instance as unknown as { impl: any }).impl;
  // The sharing manager resolves collaborator reachability from the owner; seed the cached
  // profile id so no User DO round trip is attempted.
  impl.ownerProfileId = OWNER;
  return impl;
}

// A verifiable connection record, or (without `creationSpec`) a legacy one -- unverifiable, and
// with the pre-fix exemption gone, guarded all the same.
function seedGatekeeper(impl: any, id: number, creationSpec = true): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Connection ${id}`,
    class: {} as any,
    ...(creationSpec ? {
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    } : {}),
  });
}

// A restricted observation attributed to `gatekeeperId`, which is what makes it a producer
// (restrictedProducerIds scans the action log for exactly these).
function seedRestrictedObservation(impl: any, gatekeeperId: number, actionId: number): void {
  impl.storage.actions.put({
    id: actionId,
    gatekeeperId,
    caller: { from: "user" },
    createdAt: new Date(),
    state: "approved",
    type: "observation",
    description: {
      title: "Read a thing",
      description: "The test read a thing.",
      containsRestrictedData: true,
    },
  });
}

function seedCollaborator(impl: any): void {
  impl.storage.collaborators.put({
    profile: { id: "bob", name: "Bob" },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
  });
}

function seedShareLink(impl: any): void {
  impl.storage.shareKeys.put({
    id: "link-1",
    created: new Date(),
    createdBy: OWNER,
    role: "build",
  });
}

describe("removalBlockedByRestrictedData", () => {
  it("does not block while the workspace is unlatched", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-unlatched");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      seedCollaborator(impl);

      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(false);
    });
  });

  it("does not block a latched non-producer, even while shared", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-non-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);
      seedCollaborator(impl);

      await expect(impl.removalBlockedByRestrictedData(2)).resolves.toBe(false);
      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(true);
    });
  });

  it("blocks a legacy (unverifiable) producer while a collaborator exists", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-legacy");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1, /* creationSpec */ false);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);
      seedCollaborator(impl);

      // The legacy record is what denies every non-owner open (#inScopeGatekeepers throws on
      // it), so removing it while shared would readmit the collaborator unverified.
      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(true);
    });
  });

  it("blocks on an outstanding share link alone", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-link-only");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);
      seedShareLink(impl);

      // No collaborator yet, but the link's keys are multi-redeemable and redemption is gated
      // only while the record exists.
      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(true);
    });
  });

  it("does not block a latched producer while the workspace is unshared", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-unshared");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);

      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(false);
    });
  });

  it("falls back to guarding every connection when the latch is set with no producer", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-empty-producers");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // Should be impossible (the latch and its action record are written together), so fail
      // closed: with the latch set and no derivable producer set, everything is guarded.
      impl.storage.prohibitAllSharing.put(true);
      seedCollaborator(impl);

      await expect(impl.removalBlockedByRestrictedData(1)).resolves.toBe(true);
    });
  });
});
