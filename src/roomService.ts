import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type Firestore,
  type Transaction as FirestoreTransaction,
  type Unsubscribe,
  writeBatch,
} from "firebase/firestore";
import type { BetMode, LedgerEvent, Player, Room, RoomInvite, RoomMode, RoomState } from "../types";

const INITIAL_BALANCE = 10_000;
const DEFAULT_ANTE = 10;
const ROOM_TTL_HOURS = 12;
const RECENT_EVENT_LIMIT = 100;

const roomRef = (db: Firestore, roomId: string) => doc(db, "rooms", roomId);
const playersRef = (db: Firestore, roomId: string) =>
  collection(db, "rooms", roomId, "players");
const eventsRef = (db: Firestore, roomId: string) =>
  collection(db, "rooms", roomId, "events");
const playerNamesRef = (db: Firestore, roomId: string) =>
  collection(db, "rooms", roomId, "playerNames");
const playerNameRef = (db: Firestore, roomId: string, name: string) =>
  doc(playerNamesRef(db, roomId), encodeURIComponent(name.toLocaleLowerCase()));
const invitesRef = (db: Firestore, roomId: string) =>
  collection(roomRef(db, roomId), "invites");
const inviteRef = (db: Firestore, roomId: string, token: string) =>
  doc(invitesRef(db, roomId), token);
const sessionsRef = (db: Firestore, roomId: string) =>
  collection(roomRef(db, roomId), "sessions");
const sessionRef = (db: Firestore, roomId: string, authUid: string) =>
  doc(sessionsRef(db, roomId), authUid);
const createOperationId = () => crypto.randomUUID();
const createRoomId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const createPlayerId = () => `p_${crypto.randomUUID().replace(/-/g, "")}`;
const createInviteToken = () => crypto.randomUUID().replace(/-/g, "");

function assertAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("金额必须是正整数。");
}

function assertName(name: string) {
  const value = name.trim();
  if (!value || value.length > 24) throw new Error("昵称需为 1–24 个字符。");
  return value;
}

function assertRoomName(name: string) {
  const value = name.trim();
  if (!value || value.length > 32) throw new Error("房间名需为 1–32 个字符。");
  return value;
}

const toRoom = (id: string, data: Record<string, unknown>) =>
  ({ id, ...data }) as Room;
const toPlayer = (id: string, data: Record<string, unknown>) =>
  ({ id, ...data }) as Player;
const toEvent = (id: string, data: Record<string, unknown>) =>
  ({ id, ...data }) as LedgerEvent;
const isActiveMember = (player: Player) => player.isActiveMember !== false;
const isSeated = (player: Player) => player.isSeated === true;
const isInHand = (player: Player) => player.activeInHand || player.folded;

function assertRoomOpen(room: Room) {
  if (room.status === "CLOSED") throw new Error("该房间已停止使用。");
  if (room.expiresAt && room.expiresAt.toMillis() < Date.now())
    throw new Error("该房间已过期。");
}

function assertPokerTable(room: Room) {
  if (room.mode === "LEDGER") throw new Error("记账房没有牌桌。");
  if (room.schemaVersion !== 3)
    throw new Error("这是旧测试房间，请新建房间。");
}

async function writeOnce(
  db: Firestore,
  roomId: string,
  operationId: string,
  write: (transaction: FirestoreTransaction, room: Room) => Promise<void>,
) {
  await runTransaction(db, async (transaction) => {
    const event = doc(eventsRef(db, roomId), operationId);
    const [roomSnapshot, eventSnapshot] = await Promise.all([
      transaction.get(roomRef(db, roomId)),
      transaction.get(event),
    ]);
    if (eventSnapshot.exists()) return;
    if (!roomSnapshot.exists()) throw new Error("房间不存在或已被清理。");
    const room = toRoom(roomSnapshot.id, roomSnapshot.data());
    assertRoomOpen(room);
    await write(transaction, room);
  });
}

export async function createLinkedRoom(
  db: Firestore,
  authUid: string,
  roomName: string,
  displayName: string,
  mode: RoomMode,
): Promise<{ roomId: string; inviteToken: string; playerId: string }> {
  const roomId = createRoomId();
  const playerId = createPlayerId();
  const inviteToken = createInviteToken();
  const operationId = createOperationId();
  const ownerName = assertName(displayName);
  await runTransaction(db, async (transaction) => {
    transaction.set(roomRef(db, roomId), {
      name: assertRoomName(roomName), ownerId: playerId, schemaVersion: 3,
      mode, status: "LOBBY", round: 0, pot: 0, currentBet: 0,
      betLimitMode: "ROUND", playerCount: 1, inviteCount: 1, maxPlayers: 12,
      settings: { initialBalance: INITIAL_BALANCE, maxSingleBet: 200, ante: DEFAULT_ANTE },
      hasStarted: false, revision: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + ROOM_TTL_HOURS * 60 * 60 * 1000),
    });
    transaction.set(doc(playersRef(db, roomId), playerId), {
      displayName: ownerName, balance: INITIAL_BALANCE, role: "OWNER", isActiveMember: true,
      isSeated: false, isReady: false, betMode: "NORMAL", blindLocked: false,
      activeInHand: false, folded: false, roundContribution: 0, roundStake: 0,
      handContribution: 0, joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.set(playerNameRef(db, roomId, ownerName), { uid: playerId, createdAt: serverTimestamp() });
    transaction.set(inviteRef(db, roomId, inviteToken), {
      playerId, displayName: ownerName, role: "OWNER", joinedAt: serverTimestamp(), createdAt: serverTimestamp(),
    });
    transaction.set(sessionRef(db, roomId, authUid), {
      playerId, inviteId: inviteToken, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId, type: "ROOM_CREATED", actorId: playerId, createdAt: serverTimestamp(), note: "room_created",
    });
  });
  return { roomId, inviteToken, playerId };
}

export async function getRoomSession(db: Firestore, roomId: string, authUid: string) {
  const snapshot = await getDoc(sessionRef(db, roomId, authUid));
  return snapshot.exists() && typeof snapshot.data().playerId === "string"
    ? snapshot.data().playerId as string : null;
}

export async function getQuickInvite(db: Firestore, roomId: string, token: string) {
  const snapshot = await getDoc(inviteRef(db, roomId, token));
  return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as RoomInvite) : null;
}

export async function redeemQuickInvite(db: Firestore, roomId: string, authUid: string, token: string) {
  let resolvedPlayerId = "";
  await runTransaction(db, async (transaction) => {
    const currentRoom = roomRef(db, roomId);
    const currentInvite = inviteRef(db, roomId, token);
    const currentSession = sessionRef(db, roomId, authUid);
    const [roomSnapshot, inviteSnapshot, sessionSnapshot] = await Promise.all([
      transaction.get(currentRoom), transaction.get(currentInvite), transaction.get(currentSession),
    ]);
    if (!roomSnapshot.exists() || !inviteSnapshot.exists())
      throw new Error("专属邀请已失效，请向房主重新索取链接。");
    const room = toRoom(roomSnapshot.id, roomSnapshot.data());
    assertRoomOpen(room);
    if (room.schemaVersion !== 3) throw new Error("旧房间已失效，请使用新的专属链接。");
    const invite = inviteSnapshot.data() as Omit<RoomInvite, "id">;
    resolvedPlayerId = invite.playerId;
    const currentPlayer = doc(playersRef(db, roomId), invite.playerId);
    const playerSnapshot = await transaction.get(currentPlayer);
    if (!playerSnapshot.exists() && room.playerCount >= room.maxPlayers)
      throw new Error(`房间已满（最多 ${room.maxPlayers} 人）。`);
    transaction.set(currentSession, {
      playerId: invite.playerId, inviteId: token,
      ...(sessionSnapshot.exists() ? {} : { createdAt: serverTimestamp() }), updatedAt: serverTimestamp(),
    }, { merge: true });
    if (playerSnapshot.exists()) return;
    transaction.set(currentPlayer, {
      displayName: assertName(invite.displayName), balance: room.settings?.initialBalance ?? INITIAL_BALANCE,
      role: invite.role, isActiveMember: true, isSeated: false, isReady: false,
      betMode: "NORMAL", blindLocked: false, activeInHand: false, folded: false,
      roundContribution: 0, roundStake: 0, handContribution: 0,
      joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    transaction.update(currentInvite, { joinedAt: serverTimestamp() });
    transaction.update(currentRoom, { playerCount: increment(1), revision: increment(1), updatedAt: serverTimestamp() });
  });
  return resolvedPlayerId;
}

export async function createQuickInvites(
  db: Firestore, roomId: string, ownerId: string, count: number, candidateNames: string[],
) {
  if (!Number.isInteger(count) || count < 1 || count > 11) throw new Error("请选择 1–11 个邀请名额。");
  const existingSnapshot = await getDocs(invitesRef(db, roomId));
  const usedNames = new Set(existingSnapshot.docs.map((item) => String(item.data().displayName).toLocaleLowerCase()));
  const shuffled = [...candidateNames].sort(() => Math.random() - 0.5);
  const names: string[] = [];
  for (const candidate of shuffled) {
    if (!usedNames.has(candidate.toLocaleLowerCase())) names.push(candidate);
    if (names.length === count) break;
  }
  for (let number = 1; names.length < count; number += 1) {
    const candidate = `牌友${number}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) names.push(candidate);
  }
  const pending = names.map((displayName) => ({
    id: createInviteToken(), playerId: createPlayerId(), displayName,
  }));
  await runTransaction(db, async (transaction) => {
    const currentRoom = roomRef(db, roomId);
    const snapshot = await transaction.get(currentRoom);
    if (!snapshot.exists()) throw new Error("房间不存在。");
    const room = toRoom(snapshot.id, snapshot.data());
    assertRoomOpen(room);
    if (room.ownerId !== ownerId) throw new Error("只有房主可以生成邀请。");
    const inviteCount = Number(snapshot.data().inviteCount ?? room.playerCount);
    if (inviteCount + count > room.maxPlayers) throw new Error(`最多只能准备 ${room.maxPlayers} 个专属身份。`);
    const reservations = await Promise.all(pending.map((item) => transaction.get(playerNameRef(db, roomId, item.displayName))));
    if (reservations.some((item) => item.exists())) throw new Error("随机名字发生冲突，请重试。");
    pending.forEach((item) => {
      transaction.set(inviteRef(db, roomId, item.id), {
        playerId: item.playerId, displayName: item.displayName, role: "PLAYER", createdAt: serverTimestamp(),
      });
      transaction.set(playerNameRef(db, roomId, item.displayName), { uid: item.playerId, createdAt: serverTimestamp() });
    });
    transaction.update(currentRoom, { inviteCount: increment(count), revision: increment(1), updatedAt: serverTimestamp() });
  });
  return pending;
}

export async function revokeQuickInvite(db: Firestore, roomId: string, ownerId: string, token: string) {
  await runTransaction(db, async (transaction) => {
    const currentRoom = roomRef(db, roomId);
    const currentInvite = inviteRef(db, roomId, token);
    const [roomSnapshot, inviteSnapshot] = await Promise.all([transaction.get(currentRoom), transaction.get(currentInvite)]);
    if (!roomSnapshot.exists() || !inviteSnapshot.exists()) return;
    const room = toRoom(roomSnapshot.id, roomSnapshot.data());
    if (room.ownerId !== ownerId) throw new Error("只有房主可以撤销邀请。");
    const invite = inviteSnapshot.data() as Omit<RoomInvite, "id">;
    if (invite.role === "OWNER" || invite.joinedAt) throw new Error("只能撤销尚未使用的牌友邀请。");
    transaction.delete(currentInvite);
    transaction.delete(playerNameRef(db, roomId, invite.displayName));
    transaction.update(currentRoom, { inviteCount: increment(-1), revision: increment(1), updatedAt: serverTimestamp() });
  });
}

export async function renameRoomPlayer(
  db: Firestore,
  roomId: string,
  actorId: string,
  playerId: string,
  displayName: string,
) {
  const name = assertName(displayName);
  const matchingInvites = await getDocs(query(invitesRef(db, roomId), where("playerId", "==", playerId), limit(1)));
  const matchingInvite = matchingInvites.docs[0];
  await runTransaction(db, async (transaction) => {
    const currentPlayer = doc(playersRef(db, roomId), playerId);
    const currentRoom = roomRef(db, roomId);
    const nextName = playerNameRef(db, roomId, name);
    const [playerSnapshot, roomSnapshot, nameSnapshot, inviteSnapshot] = await Promise.all([
      transaction.get(currentPlayer),
      transaction.get(currentRoom),
      transaction.get(nextName),
      matchingInvite ? transaction.get(matchingInvite.ref) : Promise.resolve(null),
    ]);
    if (!roomSnapshot.exists()) throw new Error("房间不存在。");
    const room = toRoom(roomSnapshot.id, roomSnapshot.data());
    const isOwner = room.ownerId === actorId;
    if (!isOwner && playerId !== actorId) throw new Error("只有房主可以修改其他玩家的名字。");
    const player = playerSnapshot.exists() ? toPlayer(playerSnapshot.id, playerSnapshot.data()) : null;
    const invite = inviteSnapshot?.exists() ? inviteSnapshot.data() as Omit<RoomInvite, "id"> : null;
    if (!player && !invite) throw new Error("该玩家身份不存在。");
    if (!player && !isOwner) throw new Error("请先加入房间后再修改名字。");
    const oldName = player?.displayName ?? invite!.displayName;
    if (nameSnapshot.exists() && nameSnapshot.data().uid !== playerId) throw new Error("该玩家名已被使用，请换一个。");
    if (oldName !== name) {
      transaction.delete(playerNameRef(db, roomId, oldName));
      transaction.set(nextName, { uid: playerId, createdAt: serverTimestamp() });
    }
    if (player && player.displayName !== name)
      transaction.update(currentPlayer, { displayName: name, updatedAt: serverTimestamp() });
    // 牌友自行改名时不触碰邀请文件，避免非房主的邀请写入被规则拒绝。
    // 房主改名可同时更新待加入身份的邀请名称。
    if (isOwner && inviteSnapshot?.exists() && invite!.displayName !== name)
      transaction.update(inviteSnapshot.ref, { displayName: name });
    transaction.update(currentRoom, {
      ...(isOwner && playerId === actorId ? { name: `${name}的房间` } : {}),
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
  });
}


export async function listRoomInvites(db: Firestore, roomId: string) {
  const snapshot = await getDocs(invitesRef(db, roomId));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as RoomInvite[];
}


export async function destroyRoom(
  db: Firestore,
  roomId: string,
  actorId: string,
) {
  const currentRoom = roomRef(db, roomId);
  const roomSnapshot = await getDoc(currentRoom);
  if (!roomSnapshot.exists()) return;
  if (toRoom(roomSnapshot.id, roomSnapshot.data()).ownerId !== actorId)
    throw new Error("只有房主可以销毁房间。");

  const [players, events, playerNames, invites, sessions] = await Promise.all([
    getDocs(playersRef(db, roomId)),
    getDocs(eventsRef(db, roomId)),
    getDocs(playerNamesRef(db, roomId)),
    getDocs(invitesRef(db, roomId)),
    getDocs(sessionsRef(db, roomId)),
  ]);
  const refs = [
    ...events.docs.map((item) => item.ref),
    ...playerNames.docs.map((item) => item.ref),
    ...invites.docs.map((item) => item.ref),
  ];
  for (let index = 0; index < refs.length; index += 400) {
    const batch = writeBatch(db);
    refs.slice(index, index + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  const finalBatch = writeBatch(db);
  players.docs.forEach((item) => finalBatch.delete(item.ref));
  sessions.docs.forEach((item) => finalBatch.delete(item.ref));
  finalBatch.delete(currentRoom);
  await finalBatch.commit();
}

export async function transfer(
  db: Firestore,
  roomId: string,
  actorId: string,
  toId: string,
  amount: number,
  operationId = createOperationId(),
) {
  assertAmount(amount);
  if (actorId === toId) throw new Error("不能转给自己。");
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    const fromRef = doc(playersRef(db, roomId), actorId);
    const toRef = doc(playersRef(db, roomId), toId);
    const [fromSnapshot, toSnapshot] = await Promise.all([
      transaction.get(fromRef),
      transaction.get(toRef),
    ]);
    if (!fromSnapshot.exists() || !toSnapshot.exists())
      throw new Error("玩家信息已变化，请稍后重试。");
    const fromPlayer = toPlayer(fromSnapshot.id, fromSnapshot.data());
    const toPlayerRecord = toPlayer(toSnapshot.id, toSnapshot.data());
    if (!isActiveMember(fromPlayer) || !isActiveMember(toPlayerRecord))
      throw new Error("对方已离开房间，无法转账。");
    if (fromPlayer.balance < amount)
      throw new Error("余额不足，无法完成转账。");
    transaction.update(fromRef, {
      balance: increment(-amount),
      updatedAt: serverTimestamp(),
    });
    transaction.update(toRef, {
      balance: increment(amount),
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), {
      hasStarted: true,
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "TRANSFER",
      actorId,
      fromId: actorId,
      toId,
      amount,
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function updateRoomSettings(
  db: Firestore,
  roomId: string,
  actorId: string,
  settings: { initialBalance: number; maxSingleBet?: number; ante?: number },
  operationId = createOperationId(),
) {
  if (!Number.isSafeInteger(settings.initialBalance) || settings.initialBalance < 100 || settings.initialBalance > 1_000_000)
    throw new Error("起始筹码需为 ¥100 到 ¥1,000,000 的整数。");
  if (settings.maxSingleBet !== undefined && (!Number.isSafeInteger(settings.maxSingleBet) || settings.maxSingleBet < 10 || settings.maxSingleBet > 10_000))
    throw new Error("单轮下注上限需在 ¥10 到 ¥10,000 之间。");
  if (settings.ante !== undefined && (!Number.isSafeInteger(settings.ante) || settings.ante < 1 || settings.ante > 10_000))
    throw new Error("底注需在 ¥1 到 ¥10,000 之间。");
  const [playerDocuments, legacyActivitySnapshot] = await Promise.all([
    getDocs(playersRef(db, roomId)),
    getDocs(query(eventsRef(db, roomId), where("type", "!=", "ROOM_CREATED"), limit(1))),
  ]);
  const activePlayerDocuments = playerDocuments.docs.filter((player) =>
    isActiveMember(toPlayer(player.id, player.data())),
  );
  const hasLegacyActivity = legacyActivitySnapshot.size > 0;
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    if (room.ownerId !== actorId) throw new Error("只有房主可以修改设置。");
    const initialBalance = room.settings?.initialBalance ?? INITIAL_BALANCE;
    const maxSingleBet = room.settings?.maxSingleBet ?? 200;
    const ante = room.settings?.ante ?? DEFAULT_ANTE;
    const nextMaxSingleBet = room.mode === "LEDGER" ? maxSingleBet : settings.maxSingleBet ?? maxSingleBet;
    const nextAnte = room.mode === "LEDGER" ? ante : settings.ante ?? ante;
    const changingInitialBalance = settings.initialBalance !== initialBalance;
    const changingMaxSingleBet = nextMaxSingleBet !== maxSingleBet;
    const changingAnte = nextAnte !== ante;
    if (room.status === "ACTIVE" && (changingMaxSingleBet || changingAnte))
      throw new Error("请在本局结束后修改下注上限或底注。");
    if (nextAnte > settings.initialBalance)
      throw new Error("底注不能高于每位玩家的起始筹码。");
    if (!changingInitialBalance && !changingMaxSingleBet && !changingAnte) return;
    const legacyActivity = room.hasStarted === undefined
      ? hasLegacyActivity
      : false;
    const hasStarted = room.hasStarted === true || legacyActivity;
    if (changingInitialBalance && hasStarted)
      throw new Error("已有牌局流水，不能再修改起始筹码。");
    if (changingInitialBalance) {
      if (room.playerCount !== activePlayerDocuments.length)
        throw new Error("玩家名单正在变化，请稍后重试。");
      const playerSnapshots = await Promise.all(
        activePlayerDocuments.map((player) => transaction.get(player.ref)),
      );
      if (playerSnapshots.some((player) => !player.exists()))
        throw new Error("玩家名单正在变化，请稍后重试。");
      playerSnapshots.forEach((player) => transaction.update(player.ref, {
          balance: settings.initialBalance,
          updatedAt: serverTimestamp(),
        }));
    }
    transaction.update(roomRef(db, roomId), {
      settings: {
        ...(room.settings ?? {}),
        initialBalance: settings.initialBalance,
        ...(room.mode === "POKER" ? { maxSingleBet: nextMaxSingleBet, ante: nextAnte } : {}),
      },
      ...(room.hasStarted === undefined ? { hasStarted } : {}),
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "SETTINGS_UPDATED",
      actorId,
      note: `initial_balance:${settings.initialBalance};max_single_bet:${nextMaxSingleBet};ante:${nextAnte}`,
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function takeSeat(
  db: Firestore,
  roomId: string,
  actorId: string,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    const playerRef = doc(playersRef(db, roomId), actorId);
    const snapshot = await transaction.get(playerRef);
    if (!snapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(snapshot.id, snapshot.data());
    if (!isActiveMember(player)) throw new Error("你已离开此房间。");
    if (isSeated(player)) return;
    transaction.update(playerRef, {
      isSeated: true,
      isReady: false,
      betMode: "NORMAL",
      blindLocked: false,
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), {
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId, type: "TABLE_SEATED", actorId, createdAt: serverTimestamp(),
    });
  });
}

export async function setReady(
  db: Firestore,
  roomId: string,
  actorId: string,
  ready: boolean,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.status === "ACTIVE") throw new Error("牌局进行中，请等待本局结束。");
    const playerRef = doc(playersRef(db, roomId), actorId);
    const snapshot = await transaction.get(playerRef);
    if (!snapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(snapshot.id, snapshot.data());
    if (!isActiveMember(player) || !isSeated(player))
      throw new Error("请先上桌。");
    transaction.update(playerRef, { isReady: ready, updatedAt: serverTimestamp() });
    transaction.update(roomRef(db, roomId), {
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: ready ? "PLAYER_READY" : "PLAYER_UNREADY",
      actorId,
      createdAt: serverTimestamp(),
    });
  });
}

export async function setBetMode(
  db: Firestore,
  roomId: string,
  actorId: string,
  mode: BetMode,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    const playerRef = doc(playersRef(db, roomId), actorId);
    const snapshot = await transaction.get(playerRef);
    if (!snapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(snapshot.id, snapshot.data());
    if (!isActiveMember(player) || !isSeated(player) || !player.activeInHand || player.folded)
      throw new Error("请先上桌。");
    if ((player.betMode ?? "NORMAL") === mode) return;
    if (room.status !== "ACTIVE") throw new Error("请在牌局开始后切换下注状态。");
    if (mode === "BLIND" && (room.round !== 1 || player.blindLocked === true))
      throw new Error("盲注只能在第一轮开启；取消后本局不能重新开启。");
    transaction.update(playerRef, {
      betMode: mode,
      ...(mode === "NORMAL" ? { blindLocked: true } : {}),
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), {
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "BET_MODE_CHANGED",
      actorId,
      note: mode,
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function leaveTable(
  db: Firestore,
  roomId: string,
  actorId: string,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    const playerRef = doc(playersRef(db, roomId), actorId);
    const snapshot = await transaction.get(playerRef);
    if (!snapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(snapshot.id, snapshot.data());
    if (!isSeated(player)) return;
    if (player.isReady)
      throw new Error("请先取消准备，再下桌。");
    transaction.update(playerRef, {
      isSeated: false,
      isReady: false,
      betMode: "NORMAL",
      blindLocked: false,
      activeInHand: false,
      folded: room.status === "ACTIVE" && isInHand(player),
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), { revision: increment(1), updatedAt: serverTimestamp() });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId, type: "TABLE_LEFT", actorId, round: room.round, createdAt: serverTimestamp(),
    });
  });
}

export async function forceOffTable(
  db: Firestore,
  roomId: string,
  actorId: string,
  targetId: string,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.ownerId !== actorId) throw new Error("只有房主可以请玩家下桌。");
    if (targetId === actorId) throw new Error("房主请自行下桌。");
    const playerRef = doc(playersRef(db, roomId), targetId);
    const snapshot = await transaction.get(playerRef);
    if (!snapshot.exists()) throw new Error("该玩家已不在房间中。");
    const player = toPlayer(snapshot.id, snapshot.data());
    if (!isSeated(player)) return;
    transaction.update(playerRef, {
      isSeated: false, isReady: false, betMode: "NORMAL", blindLocked: false, activeInHand: false,
      folded: room.status === "ACTIVE" && isInHand(player),
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), { revision: increment(1), updatedAt: serverTimestamp() });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId, type: "HOST_REMOVED_FROM_TABLE", actorId, toId: targetId,
      round: room.round, createdAt: serverTimestamp(),
    });
  });
}

export async function forceRemovePlayer(
  db: Firestore,
  roomId: string,
  actorId: string,
  targetId: string,
  operationId = createOperationId(),
) {
  const matchingInvites = await getDocs(query(invitesRef(db, roomId), where("playerId", "==", targetId), limit(1)));
  const matchingInvite = matchingInvites.docs[0];
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    if (room.ownerId !== actorId) throw new Error("只有房主可以请玩家离开。");
    if (targetId === actorId) throw new Error("房主不能请自己离开。");
    const targetRef = doc(playersRef(db, roomId), targetId);
    const targetSnapshot = await transaction.get(targetRef);
    if (!targetSnapshot.exists()) throw new Error("该玩家已不在房间中。");
    const player = toPlayer(targetSnapshot.id, targetSnapshot.data());
    if (!isActiveMember(player)) return;
    transaction.update(targetRef, {
      isActiveMember: false,
      isSeated: false,
      isReady: false,
      activeInHand: false,
      folded: room.status === "ACTIVE" && isInHand(player),
      leftAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    transaction.delete(playerNameRef(db, roomId, player.displayName));
    if (matchingInvite) transaction.delete(matchingInvite.ref);
    transaction.update(roomRef(db, roomId), {
      playerCount: increment(-1),
      ...(matchingInvite ? { inviteCount: increment(-1) } : {}),
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "HOST_REMOVED_FROM_ROOM",
      actorId,
      toId: targetId,
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function startHand(
  db: Firestore,
  roomId: string,
  actorId: string,
  operationId = createOperationId(),
) {
  const playerDocuments = (await getDocs(playersRef(db, roomId))).docs.filter(
    (player) => isActiveMember(toPlayer(player.id, player.data())),
  );
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.ownerId !== actorId) throw new Error("只有房主可以开局。");
    if (room.status === "ACTIVE") throw new Error("牌局已经开始。");
    const currentSnapshots = await Promise.all(playerDocuments.map((player) => transaction.get(player.ref)));
    const currentPlayers = currentSnapshots
      .filter((snapshot) => snapshot.exists())
      .map((snapshot) => ({ ref: snapshot.ref, player: toPlayer(snapshot.id, snapshot.data()) }));
    const readyPlayers = currentPlayers.filter(({ player }) => {
      const current = player;
      return isSeated(current) && current.isReady === true;
    });
    if (readyPlayers.length < 2) throw new Error("至少两名已准备玩家才能开局。");
    const ante = room.settings?.ante ?? DEFAULT_ANTE;
    const unableToPay = readyPlayers.find(({ player }) => player.balance < ante);
    if (unableToPay)
      throw new Error(`「${unableToPay.player.displayName}」筹码不足，无法支付 ¥${ante.toLocaleString()} 底注。`);
    const readyIds = new Set(readyPlayers.map(({ player }) => player.id));
    currentPlayers.forEach(({ ref, player }) =>
      transaction.update(ref, {
        activeInHand: readyIds.has(player.id),
        folded: false,
        isReady: false,
        betMode: "NORMAL",
        blindLocked: false,
        roundContribution: readyIds.has(player.id) ? ante : 0,
        roundStake: 0,
        handContribution: readyIds.has(player.id) ? ante : 0,
        ...(readyIds.has(player.id) ? { balance: player.balance - ante } : {}),
        updatedAt: serverTimestamp(),
      }),
    );
    transaction.update(roomRef(db, roomId), {
      status: "ACTIVE",
      hasStarted: true,
      round: 1,
      pot: ante * readyPlayers.length,
      currentBet: 0,
      betLimitMode: "ROUND",
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "ROUND_STARTED",
      actorId,
      round: 1,
      note: `ante:${ante}`,
      createdAt: serverTimestamp(),
    });
  });
}

export async function placeBet(
  db: Firestore,
  roomId: string,
  actorId: string,
  amount: number,
  operationId = createOperationId(),
) {
  assertAmount(amount);
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.status !== "ACTIVE") throw new Error("当前不在牌局中。");
    const playerRef = doc(playersRef(db, roomId), actorId);
    const playerSnapshot = await transaction.get(playerRef);
    if (!playerSnapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(playerSnapshot.id, playerSnapshot.data());
    if (!isActiveMember(player)) throw new Error("你已离开此房间。");
    if (!player.activeInHand || player.folded) throw new Error("你不在本局牌桌中。");
    const isBlind = player.betMode === "BLIND";
    const stakeAmount = amount * (isBlind ? 2 : 1);
    if (player.balance < amount) throw new Error("余额不足，无法下注。");
    const roundContribution = (player.roundContribution ?? 0) + amount;
    const currentRoundStake = player.roundStake ?? player.roundContribution ?? 0;
    const roundStake = currentRoundStake + stakeAmount;
    const maxRoundStake = room.settings?.maxSingleBet ?? 200;
    if (room.betLimitMode === "ROUND" && roundStake > maxRoundStake) {
      const remainingStake = Math.max(0, maxRoundStake - currentRoundStake);
      const remainingAmount = Math.floor(remainingStake / (isBlind ? 2 : 1));
      throw new Error(
        remainingAmount > 0
          ? `本轮下注上限为 ¥${maxRoundStake.toLocaleString()}，还可投入 ¥${remainingAmount.toLocaleString()}。`
          : `本轮下注已达到 ¥${maxRoundStake.toLocaleString()} 上限。`,
      );
    }
    if (room.betLimitMode !== "ROUND" && stakeAmount > maxRoundStake)
      throw new Error(`单次下注最高为 ¥${maxRoundStake.toLocaleString()}。`);
    transaction.update(playerRef, {
      balance: increment(-amount),
      activeInHand: true,
      roundContribution,
      roundStake,
      handContribution: (player.handContribution ?? 0) + amount,
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), {
      pot: increment(amount),
      currentBet: Math.max(room.currentBet ?? 0, roundStake),
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "BET",
      actorId,
      fromId: actorId,
      amount,
      note: isBlind ? "BLIND" : "NORMAL",
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function callBet(
  db: Firestore,
  roomId: string,
  actorId: string,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.status !== "ACTIVE") throw new Error("当前不在牌局中。");
    const playerRef = doc(playersRef(db, roomId), actorId);
    const playerSnapshot = await transaction.get(playerRef);
    if (!playerSnapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(playerSnapshot.id, playerSnapshot.data());
    if (!isActiveMember(player)) throw new Error("你已离开此房间。");
    if (!player.activeInHand || player.folded) throw new Error("你不在本局牌桌中。");
    const currentStake = player.roundStake ?? player.roundContribution ?? 0;
    const remainingStake = Math.max(0, (room.currentBet ?? 0) - currentStake);
    if (!remainingStake) throw new Error("本轮无需跟注。");
    const isBlind = player.betMode === "BLIND";
    const amount = Math.ceil(remainingStake / (isBlind ? 2 : 1));
    const stakeAmount = amount * (isBlind ? 2 : 1);
    const maxRoundStake = room.settings?.maxSingleBet ?? 200;
    if (room.betLimitMode === "ROUND" && currentStake + stakeAmount > maxRoundStake)
      throw new Error(`跟注后会超过本轮 ¥${maxRoundStake.toLocaleString()} 的下注上限。`);
    if (player.balance < amount) throw new Error("余额不足，无法完成跟注。");
    transaction.update(playerRef, {
      balance: increment(-amount),
      roundContribution: (player.roundContribution ?? 0) + amount,
      roundStake: currentStake + stakeAmount,
      handContribution: (player.handContribution ?? 0) + amount,
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), {
      pot: increment(amount),
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "CALL",
      actorId,
      fromId: actorId,
      amount,
      note: isBlind ? "BLIND" : "NORMAL",
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function fold(
  db: Firestore,
  roomId: string,
  actorId: string,
  operationId = createOperationId(),
) {
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.status !== "ACTIVE") throw new Error("当前不在牌局中。");
    const playerRef = doc(playersRef(db, roomId), actorId);
    const playerSnapshot = await transaction.get(playerRef);
    if (!playerSnapshot.exists()) throw new Error("你不在此房间中。");
    const player = toPlayer(playerSnapshot.id, playerSnapshot.data());
    if (!isActiveMember(player)) throw new Error("你已离开此房间。");
    if (!player.activeInHand || player.folded) throw new Error("你不在本局牌桌中。");
    transaction.update(playerRef, {
      folded: true,
      activeInHand: false,
      updatedAt: serverTimestamp(),
    });
    transaction.update(roomRef(db, roomId), {
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "FOLD",
      actorId,
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export async function nextRound(
  db: Firestore,
  roomId: string,
  actorId: string,
  operationId = createOperationId(),
) {
  const playerDocuments = (await getDocs(playersRef(db, roomId))).docs.filter(
    (player) => {
      const current = toPlayer(player.id, player.data());
      return isActiveMember(current) && isInHand(current);
    },
  );
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.ownerId !== actorId) throw new Error("只有房主可以推进轮次。");
    if (room.status !== "ACTIVE") throw new Error("当前不在牌局中。");
    const required = room.currentBet ?? 0;
    const waiting = playerDocuments
      .map((item) => toPlayer(item.id, item.data()))
      .filter(
        (player) =>
          !player.folded &&
          (player.roundStake ?? player.roundContribution ?? 0) < required,
      );
    if (waiting.length)
      throw new Error(`${waiting.map((player) => player.displayName).join("、")} 还未跟注。`);
    const next = room.round + 1;
    playerDocuments.forEach((player) =>
      transaction.update(player.ref, {
        roundContribution: 0,
        roundStake: 0,
        updatedAt: serverTimestamp(),
      }),
    );
    transaction.update(roomRef(db, roomId), {
      round: next,
      currentBet: 0,
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "ROUND_ADVANCED",
      actorId,
      round: next,
      createdAt: serverTimestamp(),
    });
  });
}

export async function settle(
  db: Firestore,
  roomId: string,
  actorId: string,
  winnerIds: string[],
  operationId = createOperationId(),
) {
  if (!winnerIds.length) throw new Error("请至少选择一位赢家。");
  const playerDocuments = (await getDocs(playersRef(db, roomId))).docs.filter(
    (player) => {
      const current = toPlayer(player.id, player.data());
      return isActiveMember(current) && isInHand(current);
    },
  );
  await writeOnce(db, roomId, operationId, async (transaction, room) => {
    assertPokerTable(room);
    if (room.ownerId !== actorId) throw new Error("只有房主可以结算。");
    if (room.status !== "ACTIVE") throw new Error("当前不在牌局中。");
    if (room.pot % winnerIds.length !== 0)
      throw new Error("底池不能被均分，请选择可整除的赢家人数。");
    if (!winnerIds.every((id) => playerDocuments.some((player) => player.id === id)))
      throw new Error("赢家必须是本局参与者。");
    const winnerRefs = winnerIds.map((id) => doc(playersRef(db, roomId), id));
    const winners = await Promise.all(
      winnerRefs.map((ref) => transaction.get(ref)),
    );
    if (winners.some((winner) => !winner.exists()))
      throw new Error("赢家列表已变化，请重试。");
    const share = room.pot / winnerIds.length;
    playerDocuments.forEach((player) =>
      transaction.update(player.ref, {
        activeInHand: false,
        folded: false,
        roundContribution: 0,
        roundStake: 0,
        handContribution: 0,
        updatedAt: serverTimestamp(),
      }),
    );
    winnerRefs.forEach((ref) => transaction.update(ref, { balance: increment(share) }));
    transaction.update(roomRef(db, roomId), {
      status: "LOBBY",
      round: 0,
      pot: 0,
      currentBet: 0,
      revision: increment(1),
      updatedAt: serverTimestamp(),
    });
    transaction.set(doc(eventsRef(db, roomId), operationId), {
      operationId,
      type: "SETTLEMENT",
      actorId,
      amount: room.pot,
      recipientIds: winnerIds,
      round: room.round,
      createdAt: serverTimestamp(),
    });
  });
}

export function subscribeRoom(
  db: Firestore,
  roomId: string,
  onUpdate: (state: Partial<RoomState>) => void,
): Unsubscribe {
  const unsubscribers: Unsubscribe[] = [];
  let stopped = false;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let playerRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRoomRevision: number | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (expiryTimer) clearTimeout(expiryTimer);
    if (playerRecoveryTimer) clearTimeout(playerRecoveryTimer);
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  };
  const track = (unsubscribe: Unsubscribe) => {
    if (stopped) unsubscribe();
    else unsubscribers.push(unsubscribe);
  };
  const closeExpiredRoom = () => {
    onUpdate({
      isLoading: false,
      isSynced: false,
      error: "该房间已过期，已停止同步。",
    });
    stop();
  };
  const scheduleExpiryCheck = (expiresAtMillis: number) => {
    if (stopped) return;
    const remaining = expiresAtMillis - Date.now();
    if (remaining <= 0) {
      closeExpiredRoom();
      return;
    }
    // Browsers clamp timers longer than a signed 32-bit millisecond value.
    // Recheck once per day to avoid an overflowing expiry timer.
    expiryTimer = setTimeout(
      () => scheduleExpiryCheck(expiresAtMillis),
      Math.min(remaining, 24 * 60 * 60 * 1000),
    );
  };
  const recoverPlayersAfterRoomChange = (roomReceivedAt: number) => {
    if (playerRecoveryTimer) clearTimeout(playerRecoveryTimer);
    playerRecoveryTimer = setTimeout(async () => {
      if (stopped || (streamHealth.playersAt ?? 0) >= roomReceivedAt) return;
      try {
        const snapshot = await getDocs(
          query(playersRef(db, roomId), orderBy("joinedAt", "asc")),
        );
        if (stopped) return;
        streamHealth.playersAt = Date.now();
        streamHealth.playersFromCache = snapshot.metadata.fromCache;
        onUpdate({
          players: snapshot.docs.map((item) => toPlayer(item.id, item.data())),
          streamHealth: { ...streamHealth },
        });
      } catch {
        // The regular listener remains active and will keep retrying itself.
      }
    }, 1500);
  };
  const streamHealth: RoomState["streamHealth"] = {
    roomAt: null,
    roomFromCache: null,
    playersAt: null,
    playersFromCache: null,
    eventsAt: null,
    eventsFromCache: null,
  };
  track(
    onSnapshot(
      roomRef(db, roomId),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!snapshot.exists()) {
          onUpdate({
            room: null,
            isLoading: false,
            isSynced: false,
            error: "该房间已被销毁或不存在，已停止同步。",
          });
          stop();
          return;
        }
        const room = toRoom(snapshot.id, snapshot.data());
        if (room.schemaVersion !== 3) {
          onUpdate({
            room: null,
            isLoading: false,
            isSynced: false,
            error: "旧测试房间已失效，请新建房间。",
          });
          stop();
          return;
        }
        if (room.expiresAt && room.expiresAt.toMillis() <= Date.now()) {
          closeExpiredRoom();
          return;
        }
        if (expiryTimer) clearTimeout(expiryTimer);
        if (room.expiresAt) {
          scheduleExpiryCheck(room.expiresAt.toMillis());
        }
        const roomReceivedAt = Date.now();
        const revisionChanged =
          lastRoomRevision !== null && lastRoomRevision !== room.revision;
        lastRoomRevision = room.revision;
        streamHealth.roomAt = roomReceivedAt;
        streamHealth.roomFromCache = snapshot.metadata.fromCache;
        onUpdate({
          room,
          isLoading: false,
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
          isSynced:
            !snapshot.metadata.hasPendingWrites && !snapshot.metadata.fromCache,
          error: null,
          streamHealth: { ...streamHealth },
        });
        if (revisionChanged) recoverPlayersAfterRoomChange(roomReceivedAt);
      },
      () =>
        onUpdate({
          error: "读取房间失败，请检查网络后重试。",
          isLoading: false,
        }),
    ),
  );
  track(
    onSnapshot(
      query(playersRef(db, roomId), orderBy("joinedAt", "asc")),
      { includeMetadataChanges: true },
      (snapshot) => {
        streamHealth.playersAt = Date.now();
        streamHealth.playersFromCache = snapshot.metadata.fromCache;
        onUpdate({
          players: snapshot.docs.map((item) => toPlayer(item.id, item.data())),
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
          streamHealth: { ...streamHealth },
        });
      },
      () => onUpdate({ error: "读取玩家列表失败。" }),
    ),
  );
  track(
    onSnapshot(
      query(
        eventsRef(db, roomId),
        orderBy("createdAt", "desc"),
        limit(RECENT_EVENT_LIMIT),
      ),
      { includeMetadataChanges: true },
      (snapshot) => {
        streamHealth.eventsAt = Date.now();
        streamHealth.eventsFromCache = snapshot.metadata.fromCache;
        onUpdate({
          events: snapshot.docs.map((item) => toEvent(item.id, item.data())),
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
          streamHealth: { ...streamHealth },
        });
      },
      () => onUpdate({ error: "读取流水失败。" }),
    ),
  );
  return stop;
}
