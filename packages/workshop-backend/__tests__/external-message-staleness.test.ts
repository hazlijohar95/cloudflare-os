// receiveExternalMessage's entry gate (authorizeCollaborator) is separated from the prompt
// commit by real await windows -- the owner's registration, the caller's context RPC, message
// preparation -- in which a concurrent verification's fail() can scrub the caller's coverage, a
// sharing change can sever their role, or a new connection can widen the scope they were never
// verified against. The agent then runs over the unfiltered chat tail and its reply leaves the
// Workshop, so the authorization must be re-asserted synchronously with the commit: newChat and
// sendChatMessage run the registration's assertStillAuthorized as the first statement of the
// transaction that writes the prompt, so a stale caller aborts it -- no chat, no message, no
// response target, no agent turn.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// restricted-observation-latch.test.ts); the gatekeeper facet and the caller's User DO are the
// fakes. A unit test rather than an integration test because the scrub must land
// deterministically inside the context-RPC window, which a fake getExternalMessageChatContext
// controls exactly.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
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

// Seeds an owned workspace with connection 1 and bob as a confirmed "build" collaborator holding
// a covering observer record, and fakes bob's User DO so the context RPC parks until the test
// releases it -- the window under test. startAgent is a spy: the assertion target is that it
// never runs for a denied submission. registerExternalMessageResponseTarget is a spy too, since
// the real one persists the gateway stub into DO storage and a stub minted inside the test
// context is not storable ("RpcStub cannot be serialized in this context") -- what matters here
// is whether it ran at all, and it runs inside the same transaction the re-check aborts.
function setup(instance: OverseerDurableObject): {
  impl: any;
  startAgentCalls: number;
  registrations: number;
  releaseContext: () => void;
} {
  let impl = (instance as unknown as { impl: any }).impl;
  impl.ownerProfileId = OWNER;
  impl.ownerId = "owner-do-id";
  seedGatekeeper(impl, 1);
  impl.storage.collaborators.put({
    profile: { id: "bob", name: "Bob" },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
  });
  impl.storage.observers.put(
      { profileId: "bob", observerId: "obs-b", accountChoices: { 1: 10 } });
  impl.getGatekeeperFacet = () => ({ addObserver: async () => {} });

  let state = { impl, startAgentCalls: 0, registrations: 0, releaseContext: () => {} };
  impl.startAgent = () => { state.startAgentCalls++; };
  impl.registerExternalMessageResponseTarget = () => { state.registrations++; };

  let held = deferred();
  state.releaseContext = held.resolve;
  let fakeCaller = {
    id: { toString: () => "caller-do-id" },
    whoamiIfExists: async () => ({ type: "user", id: "bob", name: "Bob" }),
    getVerifier: async () => ({}),
    getExternalMessageChatContext: async () => {
      await held.promise;
      return {
        profile: { type: "user", id: "bob", name: "Bob" },
        aiModel: {
          profile: { type: "agent", id: "test-model", name: "Test Model" },
          config: { provider: "anthropic" },
        },
      };
    },
  };
  impl.users = {
    getByName: () => fakeCaller,
    // The best-effort lastActive bump resolves the owner's DO through these; give it an inert
    // target so the control case doesn't log a spurious bump failure.
    idFromString: (id: string) => id,
    get: () => ({ setGadgetLastActive: async () => {} }),
  };
  return state;
}

function submitInput(key: string) {
  return {
    callerEmail: "bob@example.com",
    externalChatKey: `ext-${key}`,
    idempotencyKey: `idem-${key}`,
    prompt: "Hello agent",
    chatGatewayRpcTarget: new NativeRpcStub({ deliverResponse: async () => {} }) as any,
    title: "My Workspace",
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function expectNothingCommitted(
    state: { impl: any; startAgentCalls: number; registrations: number }, key: string): void {
  expect([...state.impl.storage.chatMeta.list()]).toHaveLength(0);
  expect([...state.impl.storage.chats.list()]).toHaveLength(0);
  expect(state.registrations).toBe(0);
  expect(state.impl.storage.externalChats.get(`ext-${key}`)).toBeUndefined();
  expect(state.startAgentCalls).toBe(0);
}

describe("receiveExternalMessage's commit-time authorization re-check", () => {
  it("denies when a concurrent verification failure scrubbed coverage mid-flight", async () => {
    let stub = env.TEST_OVERSEER.getByName("external-staleness-coverage-scrub");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let state = setup(instance);
      let result = instance.receiveExternalMessage(submitInput("scrub"));
      await tick();

      // A sibling verification's fail() scrubs the failed gatekeeper from the persisted record,
      // synchronously, exactly as ensureObserver does.
      let record = state.impl.storage.observers.get("bob");
      delete record.accountChoices[1];
      state.impl.storage.observers.put(record);

      state.releaseContext();
      await expect(result).resolves.toMatchObject({ accepted: false });
      expect((await result).message).toMatch(/could not be verified/);
      // The transaction aborted before anything landed, and the agent never started.
      expectNothingCommitted(state, "scrub");
    });
  });

  it("denies when the caller's role was severed mid-flight", async () => {
    let stub = env.TEST_OVERSEER.getByName("external-staleness-role-severed");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let state = setup(instance);
      let result = instance.receiveExternalMessage(submitInput("severed"));
      await tick();

      state.impl.storage.collaborators.delete("bob");

      state.releaseContext();
      await expect(result).resolves.toMatchObject({ accepted: false });
      expect((await result).message).toMatch(/could not be verified/);
      expectNothingCommitted(state, "severed");
    });
  });

  it("denies when a connection added mid-flight widened the unverified scope", async () => {
    let stub = env.TEST_OVERSEER.getByName("external-staleness-scope-widened");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let state = setup(instance);
      let result = instance.receiveExternalMessage(submitInput("widened"));
      await tick();

      // The re-check recomputes the scope live, so the new connection -- which bob was never
      // verified against -- fails closed, like the redemption scope check.
      seedGatekeeper(state.impl, 2);

      state.releaseContext();
      await expect(result).resolves.toMatchObject({ accepted: false });
      expect((await result).message).toMatch(/could not be verified/);
      expectNothingCommitted(state, "widened");
    });
  });

  it("denies the existing-chat path without committing the message", async () => {
    let stub = env.TEST_OVERSEER.getByName("external-staleness-existing-chat");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let state = setup(instance);
      // A prior conversation already exists for this external chat key.
      let started = new Date();
      state.impl.storage.chatMeta.put(
          { id: 7, title: "Existing chat", started, lastActive: started });
      state.impl.storage.externalChats.put({ externalChatKey: "ext-existing", chatId: 7 });

      let result = instance.receiveExternalMessage(submitInput("existing"));
      await tick();

      let record = state.impl.storage.observers.get("bob");
      delete record.accountChoices[1];
      state.impl.storage.observers.put(record);

      state.releaseContext();
      await expect(result).resolves.toMatchObject({ accepted: false });
      expect((await result).message).toMatch(/could not be verified/);
      // The chat survives but gained no message, no response target, no agent turn.
      expect([...state.impl.storage.chats.list()]).toHaveLength(0);
      expect(state.registrations).toBe(0);
      expect(state.startAgentCalls).toBe(0);
    });
  });

  it("accepts and commits when authorization stays intact", async () => {
    let stub = env.TEST_OVERSEER.getByName("external-staleness-control");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let state = setup(instance);
      let result = instance.receiveExternalMessage(submitInput("ok"));
      await tick();

      state.releaseContext();
      let outcome = await result;
      expect(outcome.accepted).toBe(true);

      let messages = [...state.impl.storage.chats.list()];
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe("Hello agent");
      expect(state.registrations).toBe(1);
      expect(state.startAgentCalls).toBe(1);
    });
  });
});
