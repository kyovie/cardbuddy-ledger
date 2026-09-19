import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, increment, runTransaction, serverTimestamp, Timestamp } from "firebase/firestore";
import { readFile } from "node:fs/promises";

let testEnv: RulesTestEnvironment;
const roomId = "quick-room";
const ownerAuthId = "owner-auth";
const ownerPlayerId = "p_owner";
const guestAuthId = "guest-auth";
const guestPlayerId = "p_guest";
const inviteId = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "cardledger-pro-rules-test",
    firestore: { rules: await readFile("firestore.rules", "utf8") },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await runTransaction(db, async (transaction) => {
      transaction.set(doc(db, "rooms", roomId), {
        ownerId: ownerPlayerId, schemaVersion: 3, playerCount: 1, maxPlayers: 12,
        status: "LOBBY", expiresAt: Timestamp.fromMillis(Date.now() + 86400000),
      });
      transaction.set(doc(db, "rooms", roomId, "players", ownerPlayerId), { displayName: "房主" });
      transaction.set(doc(db, "rooms", roomId, "sessions", ownerAuthId), { playerId: ownerPlayerId, inviteId: "owner-token" });
      transaction.set(doc(db, "rooms", roomId, "invites", "owner-token"), { playerId: ownerPlayerId, displayName: "房主", role: "OWNER" });
      transaction.set(doc(db, "rooms", roomId, "invites", inviteId), { playerId: guestPlayerId, displayName: "黄蓉", role: "PLAYER" });
      transaction.set(doc(db, "rooms", roomId, "playerNames", encodeURIComponent("黄蓉")), { uid: guestPlayerId });
    });
  });
});

afterAll(async () => { await testEnv.cleanup(); });

describe("专属邀请身份", () => {
  it("允许新浏览器把邀请映射到固定玩家 ID 并加入", async () => {
    const db = testEnv.authenticatedContext(guestAuthId).firestore();
    await expect(assertSucceeds(runTransaction(db, async (transaction) => {
      const room = doc(db, "rooms", roomId);
      const invite = doc(db, "rooms", roomId, "invites", inviteId);
      const session = doc(db, "rooms", roomId, "sessions", guestAuthId);
      const player = doc(db, "rooms", roomId, "players", guestPlayerId);
      await Promise.all([transaction.get(room), transaction.get(invite), transaction.get(session), transaction.get(player)]);
      transaction.set(session, { playerId: guestPlayerId, inviteId, createdAt: serverTimestamp() });
      transaction.set(player, { displayName: "黄蓉", isActiveMember: true });
      transaction.update(invite, { joinedAt: serverTimestamp() });
      transaction.update(room, { playerCount: increment(1) });
    }))).resolves.toBeUndefined();
  });

  it("不允许玩家用别人的固定 ID 伪造操作人", async () => {
    const db = testEnv.authenticatedContext(guestAuthId).firestore();
    await expect(assertFails(runTransaction(db, async (transaction) => {
      transaction.set(doc(db, "rooms", roomId, "events", "forged"), {
        operationId: "forged", type: "TRANSFER", actorId: ownerPlayerId,
      });
    }))).resolves.toBeUndefined();
  });
});
