import type { Timestamp } from "firebase/firestore";

export type RoomStatus = "LOBBY" | "ACTIVE" | "CLOSED";
export type RoomMode = "LEDGER" | "POKER";
export type PlayerRole = "OWNER" | "PLAYER";
export type BetMode = "NORMAL" | "BLIND";
export type EventType =
  | "ROOM_CREATED"
  | "TRANSFER"
  | "BET"
  | "CALL"
  | "FOLD"
  | "ROUND_STARTED"
  | "ROUND_ADVANCED"
  | "SETTLEMENT"
  | "PLAYER_LEFT"
  | "TABLE_SEATED"
  | "TABLE_LEFT"
  | "PLAYER_READY"
  | "PLAYER_UNREADY"
  | "HOST_REMOVED_FROM_TABLE"
  | "HOST_REMOVED_FROM_ROOM"
  | "BET_MODE_CHANGED"
  | "SETTINGS_UPDATED"
  | "REVERSAL";

export interface Room {
  id: string;
  name: string;
  ownerId: string;
  schemaVersion?: number;
  /** Missing only on rooms created before modes were introduced. */
  mode?: RoomMode;
  status: RoomStatus;
  round: number;
  pot: number;
  currentBet?: number;
  /** ROUND is set for hands started after the per-round betting limit was introduced. */
  betLimitMode?: "SINGLE" | "ROUND";
  playerCount: number;
  maxPlayers: number;
  /** Room rules are grouped here so future settings remain extensible. */
  settings?: {
    /** Starting balance assigned to every player before the room has activity. */
    initialBalance?: number;
    /** Maximum comparable stake a player may accumulate during one betting round. */
    maxSingleBet?: number;
    /** Forced contribution paid by each participant when a poker hand begins. */
    ante?: number;
  };
  /** Set when the first transfer or poker hand starts; protects opening balances. */
  hasStarted?: boolean;
  revision: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  expiresAt: Timestamp | null;
}

export interface RoomInvite {
  id: string;
  playerId: string;
  displayName: string;
  role: PlayerRole;
  joinedAt?: Timestamp | null;
  createdAt: Timestamp | null;
}

export interface Player {
  id: string;
  displayName: string;
  balance: number;
  role: PlayerRole;
  /** Missing only on old rooms; those members are considered active. */
  isActiveMember?: boolean;
  isSeated?: boolean;
  isReady?: boolean;
  /** The player's chosen state, not whether they have looked at their cards. */
  betMode?: BetMode;
  /** Once blind betting is cancelled in a hand, it cannot be re-enabled. */
  blindLocked?: boolean;
  activeInHand: boolean;
  folded: boolean;
  roundContribution?: number;
  /** Comparable normal-bet value, used for blind/normal call calculations. */
  roundStake?: number;
  handContribution?: number;
  joinedAt: Timestamp | null;
  leftAt?: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface LedgerEvent {
  id: string;
  operationId: string;
  type: EventType;
  actorId: string;
  fromId?: string;
  toId?: string;
  amount?: number;
  recipientIds?: string[];
  round?: number;
  note?: string;
  createdAt: Timestamp | null;
}

export interface RoomState {
  room: Room | null;
  players: Player[];
  events: LedgerEvent[];
  isLoading: boolean;
  isSynced: boolean;
  hasPendingWrites: boolean;
  error: string | null;
  /** Local receive times, used only to diagnose a device's Firestore stream. */
  streamHealth: {
    roomAt: number | null;
    roomFromCache: boolean | null;
    playersAt: number | null;
    playersFromCache: boolean | null;
    eventsAt: number | null;
    eventsFromCache: boolean | null;
  };
}

export interface Session {
  uid: string;
  isReady: boolean;
  error: string | null;
}
