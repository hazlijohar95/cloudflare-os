// Tests for role-scoped observer enforcement: the sensitive-observation coverage guard holds a
// collaborator only to what their role's verification scope can actually cover ("use"
// collaborators are verified only against gadget-bound connections; see #inScopeGatekeepers in
// overseer.ts). The external-message gate's role scoping is covered by
// external-message-verification.test.ts.
//
// This lives in its own file -- with its own harness, like every suite here -- rather than in
// sensitive-observations.test.ts, because that suite includes a revocation-restart test whose DO
// abort makes the shared local harness briefly drop unrelated in-flight requests; its concurrent
// tests pass with their current timing, but growing that file re-rolls those dice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

type Workspace = {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
  aliceApi: RpcStub<AuthenticatedApi>;
  /** The fixture session bound to the workspace's (first) gatekeeper. */
  session: any;
  gatekeeperId: number;
};

// Alice creates a workspace bound to one Test Thing and opens a session on its gatekeeper.
async function newWorkspace(publicApi: RpcStub<PublicApi>, thingName: string): Promise<Workspace> {
  const [alice] = nextUsernames("alice");
  const aliceApi = await signUp(publicApi, alice);
  const account = await provisionAccount(aliceApi);

  const overseer = await aliceApi.newGadget();
  const gatekeeper = await overseer.newGatekeeper(account.id, thingUrl(thingName));
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const gatekeeperId = await gatekeeper.getId();
  const session = await gatekeeper.openSession();
  const { id: gadgetId } = await overseer.getMetadata();
  return { gadgetId, overseer, aliceApi, session, gatekeeperId };
}

describe("role-scoped observer enforcement", () => {
  it.concurrent("a use collaborator only blocks reads from connections in their scope",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "use-scope");
      const [carol] = nextUsernames("carol");
      const carolApi = await signUp(publicApi, carol);
      const carolAccount = await provisionAccount(carolApi);
      const collaborator = await ws.overseer.addCollaborator(carol, "use");
      if (!collaborator) throw new Error(`Failed to share the gadget with ${carol}`);

      // No gadget binds the connection, so Carol's "use" verification scope is empty: her open
      // must not prompt (the recorder has no queued responses, so an unexpected prompt throws).
      const emptyCallback = stubFor(new ObserverConfigRecorder());
      try {
        (await carolApi.openGadget(ws.gadgetId, undefined, emptyCallback))[Symbol.dispose]();
      } finally {
        emptyCallback[Symbol.dispose]();
      }

      // ensureObserver can never verify Carol against an unbound connection, so she must not
      // block its sensitive reads either -- demanding coverage her role can't gain would block
      // them forever.
      await expect(ws.session.readThing(true)).resolves.toContain("use-scope");

      // Binding the connection to a gadget (pure storage writes; no gadget code runs) brings it
      // into "use" scope. Carol is now in scope but uncovered, so the read blocks...
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", ws.gatekeeperId);
      await expect(ws.session.readThing(true)).rejects.toThrow(/has not been verified/i);

      // ...and the error's remedy works: re-opening verifies her, which unblocks the read.
      const callback = stubFor(
          new ObserverConfigRecorder().alwaysChoose(carolAccount.id, MAX_OBSERVER_PROMPTS));
      try {
        (await carolApi.openGadget(ws.gadgetId, undefined, callback))[Symbol.dispose]();
      } finally {
        callback[Symbol.dispose]();
      }
      await expect(ws.session.readThing(true)).resolves.toContain("use-scope");
    });
  });
});
