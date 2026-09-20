import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  ChevronRight,
  Coins,
  Copy,
  Crown,
  Dices,
  History,
  LoaderCircle,
  LogIn,
  Minus,
  Plus,
  Pencil,
  QrCode as QrCodeIcon,
  Share2,
  SlidersHorizontal,
  Spade,
  Trophy,
  Users,
  Wallet,
  X,
} from "lucide-react";
import QRCode from "react-qr-code";
import type { Html5Qrcode } from "html5-qrcode";
import type { Firestore } from "firebase/firestore";
import type { LedgerEvent, Player, Room, RoomInvite, RoomMode, RoomState } from "./types";
import { db, isFirebaseConfigured } from "./src/firebase";
import {
  createLinkedRoom,
  createQuickInvites,
  callBet,
  destroyRoom,
  fold,
  getQuickInvite,
  leaveTable,
  forceOffTable,
  forceRemovePlayer,
  nextRound,
  placeBet,
  settle,
  setReady,
  setBetMode,
  startHand,
  listRoomInvites,
  renameRoomPlayer,
  revokeQuickInvite,
  takeSeat,
  transfer,
  updateRoomSettings,
} from "./src/roomService";
import { useAnonymousSession, useRoom, useRoomIdentity } from "./src/useRoom";

type Modal =
  | "TRANSFER"
  | "BET"
  | "SETTLE"
  | "HISTORY"
  | "SHARE"
  | "DESTROY"
  | "LEAVE"
  | "SETTINGS"
  | "ROOM_ACTIONS"
  | "RENAME"
  | null;

type Theme = "dark" | "light";

type QuickRoomLink = { roomId: string; inviteToken: string };
const parseRoomLink = (value: string): QuickRoomLink | null => {
  const input = value.trim();
  let hash = input;
  try { hash = new URL(input).hash; } catch { /* A pasted hash/path is handled below. */ }
  const match = hash.replace(/^#/, "").match(/^\/?q\/([a-zA-Z0-9]{6,64})\/([a-fA-F0-9]{24,64})$/);
  return match ? { roomId: match[1], inviteToken: match[2] } : null;
};
const initialRoomLink = () => parseRoomLink(window.location.href);
const buildRoomLink = (roomId: string, inviteToken: string) =>
  `${window.location.origin}${window.location.pathname}#/q/${roomId}/${inviteToken}`;
const money = (value = 0) => `¥${Math.round(value).toLocaleString()}`;
const signedMoney = (value = 0) => {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}¥${Math.abs(rounded).toLocaleString()}`;
};
const isLedgerRoom = (room: Pick<Room, "mode">) => room.mode === "LEDGER";
const roomModeLabel = (room: Pick<Room, "mode">) =>
  isLedgerRoom(room) ? "记账模式" : "德州扑克";
const playerNameGroups = [
  {
    label: "金庸",
    names: [
      "郭靖",
      "黄蓉",
      "杨过",
      "小龙女",
      "令狐冲",
      "任盈盈",
      "张无忌",
      "赵敏",
      "周芷若",
      "乔峰",
      "阿朱",
      "王语嫣",
      "段誉",
      "虚竹",
      "韦小宝",
      "东方不败",
    ],
  },
  {
    label: "古龙",
    names: [
      "楚留香",
      "陆小凤",
      "李寻欢",
      "西门吹雪",
      "花满楼",
      "叶孤城",
      "傅红雪",
      "小鱼儿",
      "花无缺",
      "沈浪",
      "朱七七",
      "林仙儿",
      "苏蓉蓉",
      "铁心兰",
      "风四娘",
      "丁灵琳",
    ],
  },
  {
    label: "西游",
    names: [
      "孙悟空",
      "猪八戒",
      "沙悟净",
      "唐三藏",
      "白龙马",
      "观音",
      "哪吒",
      "二郎神",
      "牛魔王",
      "铁扇公主",
      "红孩儿",
      "嫦娥",
      "太上老君",
    ],
  },
];
const playerNamePresets = playerNameGroups.flatMap((group) => group.names);
const preferredPlayerNameKey = "cardledger.preferred-player-name";
const themePreferenceKey = "cardledger.theme";
const soundPreferenceKey = "cardledger.sound-enabled";
const recentRoomsKey = "cardledger.recent-rooms";
type RecentRoom = QuickRoomLink & {
  roomName: string;
  playerName: string;
  role: "OWNER" | "PLAYER";
  visitedAt: number;
  expiresAt: number;
};

function readRecentRooms(): RecentRoom[] {
  try {
    const value = JSON.parse(localStorage.getItem(recentRoomsKey) ?? "[]") as RecentRoom[];
    return Array.isArray(value)
      ? value.filter((item) => item.roomId && item.inviteToken && item.expiresAt > Date.now()).slice(0, 3)
      : [];
  } catch { return []; }
}

function rememberRecentRoom(room: RecentRoom) {
  try {
    const next = [room, ...readRecentRooms().filter((item) => !(item.roomId === room.roomId && item.inviteToken === room.inviteToken))].slice(0, 3);
    localStorage.setItem(recentRoomsKey, JSON.stringify(next));
  } catch { /* Recent rooms are an optional local convenience. */ }
}

function forgetRecentRoom(roomId: string, inviteToken: string) {
  try {
    localStorage.setItem(recentRoomsKey, JSON.stringify(readRecentRooms().filter((item) => !(item.roomId === roomId && item.inviteToken === inviteToken))));
  } catch { /* Recent rooms are an optional local convenience. */ }
}

function saveRecentRooms(rooms: RecentRoom[]) {
  try {
    localStorage.setItem(recentRoomsKey, JSON.stringify(rooms.slice(0, 3)));
  } catch { /* Recent rooms are an optional local convenience. */ }
}
// Changes when the invite entry experience changes, so shared links cannot
// accidentally boot an older cached application shell.
const inviteRelease = "20260904-identity";

function preferredTheme(): Theme {
  try {
    const saved = localStorage.getItem(themePreferenceKey);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function preferredPlayerName() {
  try {
    return localStorage.getItem(preferredPlayerNameKey) ?? "";
  } catch {
    return "";
  }
}

function rememberPlayerName(name: string) {
  try {
    localStorage.setItem(preferredPlayerNameKey, name.trim());
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}

type SoundEffect = "DICE" | "THEME" | "TICK" | "CHIPS" | "CARD" | "DEAL" | "WIN" | "CONFIRM";
let soundContext: AudioContext | null = null;

function soundEnabled() {
  try { return localStorage.getItem(soundPreferenceKey) !== "false"; } catch { return true; }
}

function rememberSoundEnabled(enabled: boolean) {
  try { localStorage.setItem(soundPreferenceKey, String(enabled)); } catch { /* Optional preference. */ }
}

function primeSound() {
  if (!soundEnabled()) return;
  try {
    soundContext ??= new AudioContext();
    void soundContext.resume();
  } catch { /* Audio is optional and browser-gated. */ }
}

function playSound(effect: SoundEffect) {
  if (!soundEnabled()) return;
  try {
    soundContext ??= new AudioContext();
    if (soundContext.state !== "running") return;
    const notes: Record<SoundEffect, Array<[number, number, number]>> = {
      DICE: [[520, 0, 0.035], [700, 0.055, 0.028]], THEME: [[760, 0, 0.035]],
      TICK: [[620, 0, 0.022]], CHIPS: [[360, 0, 0.03], [520, 0.045, 0.025]],
      CARD: [[250, 0, 0.025]], DEAL: [[440, 0, 0.03], [590, 0.06, 0.026]],
      WIN: [[620, 0, 0.035], [780, 0.075, 0.03]], CONFIRM: [[540, 0, 0.026]],
    };
    notes[effect].forEach(([frequency, delay, volume]) => {
      const oscillator = soundContext!.createOscillator();
      const gain = soundContext!.createGain();
      oscillator.type = effect === "CARD" ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(frequency, soundContext!.currentTime + delay);
      gain.gain.setValueAtTime(volume, soundContext!.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, soundContext!.currentTime + delay + 0.07);
      oscillator.connect(gain).connect(soundContext!.destination);
      oscillator.start(soundContext!.currentTime + delay);
      oscillator.stop(soundContext!.currentTime + delay + 0.075);
    });
  } catch { /* Audio is optional and browser-gated. */ }
}

function playDiceFeedback() {
  navigator.vibrate?.(12);
  primeSound();
  playSound("DICE");
}

function roomTime(value: Date) {
  return value.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function eventLabel(event: LedgerEvent, players: Player[]) {
  const name = (id?: string) =>
    players.find((player) => player.id === id)?.displayName ?? "未知玩家";
  switch (event.type) {
    case "ROOM_CREATED":
      return "房间已创建";
    case "TRANSFER":
      return `${name(event.fromId)} → ${name(event.toId)}`;
    case "BET":
      return `${name(event.actorId)} ${event.note === "BLIND" ? "盲注" : "下注"}`;
    case "CALL":
      return `${name(event.actorId)} ${event.note === "BLIND" ? "盲注跟注" : "跟注"}`;
    case "FOLD":
      return `${name(event.actorId)} 弃牌`;
    case "ROUND_STARTED":
      if (event.note === "room_created") return "房间已创建";
      const ante = event.note?.match(/^ante:(\d+)$/)?.[1];
      return ante ? `牌局开始 · 每人底注 ${money(Number(ante))}` : "牌局开始";
    case "ROUND_ADVANCED":
      return `进入第 ${event.round} 轮`;
    case "SETTLEMENT":
      return `本局结算给 ${event.recipientIds?.map(name).join("、") ?? "赢家"}`;
    case "PLAYER_LEFT":
      return `${name(event.actorId)} 已离开房间`;
    case "TABLE_SEATED": return `${name(event.actorId)} 已上桌`;
    case "TABLE_LEFT": return `${name(event.actorId)} 已下桌`;
    case "PLAYER_READY": return `${name(event.actorId)} 已准备`;
    case "PLAYER_UNREADY": return `${name(event.actorId)} 取消准备`;
    case "HOST_REMOVED_FROM_TABLE": return `${name(event.toId)} 被请下桌`;
    case "HOST_REMOVED_FROM_ROOM": return `${name(event.toId)} 被房主请离房间`;
    case "SETTINGS_UPDATED": return "房主更新了牌局设置";
    case "BET_MODE_CHANGED": return `${name(event.actorId)} ${event.note === "BLIND" ? "开启盲注" : "切回正常下注"}`;
    default:
      return "账本已更新";
  }
}

function eventTime(event: LedgerEvent) {
  return event.createdAt
    ? event.createdAt
        .toDate()
        .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "刚刚";
}

export default function App() {
  const [roomLink, setRoomLink] = useState(initialRoomLink);
  const roomId = roomLink?.roomId ?? null;
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  const showThemeHint = false;
  const session = useAnonymousSession();
  const roomState = useRoom(roomId, session.isReady && !session.error);
  const identity = useRoomIdentity(roomId, roomLink?.inviteToken ?? null, session.uid, session.isReady && !session.error);

  useEffect(() => {
    const onHashChange = () => setRoomLink(initialRoomLink());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!roomLink || !roomState.room || !identity.playerId) return;
    const player = roomState.players.find((item) => item.id === identity.playerId);
    if (!player) return;
    if (player.isActiveMember === false) {
      forgetRecentRoom(roomLink.roomId, roomLink.inviteToken);
      return;
    }
    rememberRecentRoom({
      roomId: roomLink.roomId,
      inviteToken: roomLink.inviteToken,
      roomName: roomState.room.name,
      playerName: player.displayName,
      role: player.role,
      visitedAt: Date.now(),
      expiresAt: roomState.room.expiresAt?.toMillis() ?? Date.now() + 12 * 60 * 60 * 1000,
    });
  }, [roomLink, roomState.room, roomState.players, identity.playerId]);

  useEffect(() => {
    try {
      if (localStorage.getItem(themePreferenceKey)) return;
    } catch { return; }
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const followSystem = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light");
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, []);

  const toggleTheme = () => setTheme((value) => {
    const next = value === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(themePreferenceKey, next);
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    return next;
  });
  const dismissThemeHint = () => {
    /* Kept as a no-op while older view props are phased out. */
  };

  const openRoom = (link: QuickRoomLink) => {
    window.location.hash = `/q/${link.roomId}/${link.inviteToken}`;
    setRoomLink({ roomId: link.roomId, inviteToken: link.inviteToken });
  };
  const goHome = () => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setRoomLink(null);
  };

  if (!isFirebaseConfigured) return <ConfigurationView />;
  if (!session.isReady) return <LoadingView label="正在建立安全连接…" />;
  if (session.error) return <ErrorView message={session.error} />;
  if (!roomId)
    return <LandingView db={db!} uid={session.uid} onOpenRoom={openRoom} theme={theme} onToggleTheme={toggleTheme} showThemeHint={showThemeHint} onDismissThemeHint={dismissThemeHint} />;
  if (roomState.isLoading || identity.isLoading) return <LoadingView label="正在验证专属身份并同步房间…" />;
  if (identity.error || roomState.error)
    return (
      <ErrorView
        message={identity.error ?? roomState.error!}
        onHome={goHome}
      />
    );
  if (!roomState.room)
    return (
      <ErrorView
        message="没有找到这个房间。请检查邀请链接是否完整。"
        onHome={goHome}
      />
    );

  const currentPlayer = roomState.players.find(
    (player) => player.id === identity.playerId && player.isActiveMember !== false,
  );
  // 专属身份兑换完成后，玩家列表监听可能会晚一个快照到达；缓存中的旧列表也不能
  // 当作“玩家不存在”。在服务端确认前保持加载态，避免首次打开链接闪现失败页。
  if (!currentPlayer && (!roomState.streamHealth.playersAt || roomState.streamHealth.playersFromCache))
    return <LoadingView label="正在同步玩家信息…" />;
  if (!currentPlayer)
    return <ErrorView message="专属身份尚未加入房间，请刷新后重试。" onHome={goHome} />;
  return (
    <RoomView
      db={db!}
      roomId={roomId}
      uid={identity.playerId!}
      inviteToken={roomLink!.inviteToken}
      currentPlayer={currentPlayer}
      state={roomState}
      theme={theme}
      onToggleTheme={toggleTheme}
      showThemeHint={showThemeHint}
      onDismissThemeHint={dismissThemeHint}
      onHome={goHome}
    />
  );
}

function LoadingView({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-[#0f172a] flex items-center justify-center text-slate-300">
      <div className="text-center">
        <LoaderCircle
          className="animate-spin text-amber-400 mx-auto mb-3"
          size={30}
        />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

function ErrorView({
  message,
  onHome,
}: {
  message: string;
  onHome?: () => void;
}) {
  return (
    <div className="min-h-screen bg-[#0f172a] p-6 flex items-center justify-center text-slate-100">
      <div className="max-w-sm text-center bg-white/5 border border-red-400/20 rounded-3xl p-7">
        <AlertCircle className="text-red-400 mx-auto mb-4" size={36} />
        <h1 className="font-bold text-xl mb-2">暂时无法进入</h1>
        <p className="text-sm leading-6 text-slate-400">{message}</p>
        {onHome && (
          <button
            onClick={onHome}
            className="mt-6 px-5 py-3 bg-amber-400 text-slate-900 rounded-xl font-bold"
          >
            返回首页
          </button>
        )}
      </div>
    </div>
  );
}

function ConfigurationView() {
  return (
    <div className="min-h-screen bg-[#0f172a] p-6 flex items-center justify-center text-slate-100">
      <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-3xl p-7">
        <Dices className="text-amber-400 mb-4" size={38} />
        <h1 className="text-2xl font-bold">等待连接 Firebase</h1>
        <p className="text-sm text-slate-400 leading-6 mt-3">
          新版本已切换为 Firebase 实时同步。部署前请将 Firebase Web 配置填入{" "}
          <code className="text-amber-300">.env.local</code>；模板在{" "}
          <code className="text-amber-300">.env.example</code>。
        </p>
        <div className="mt-5 bg-black/20 rounded-xl p-4 text-xs text-slate-400 leading-6">
          还需在 Firebase Console 启用：
          <br />
          1. Authentication → Anonymous
          <br />
          2. Cloud Firestore Database
        </div>
      </div>
    </div>
  );
}

function BrandLogo({
  variant,
  className = "",
  theme,
  onToggleTheme,
  showHint = false,
  onDismissHint,
}: {
  variant: "landing" | "header";
  className?: string;
  theme: Theme;
  onToggleTheme: () => void;
  showHint?: boolean;
  onDismissHint?: () => void;
}) {
  const compact = variant === "header";
  const landing = variant === "landing";
  const [rolling, setRolling] = useState(false);
  const toggle = () => {
    if (rolling) return;
    onDismissHint?.();
    primeSound();
    playSound("DICE");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setRolling(true);
    window.setTimeout(() => { onToggleTheme(); playSound("THEME"); }, reducedMotion ? 0 : 250);
    window.setTimeout(() => setRolling(false), reducedMotion ? 0 : 560);
  };
  return (
    <div className={`relative shrink-0 ${compact ? "h-11 w-11" : "h-20 w-20"} ${className}`}>
      <button
        type="button"
        onClick={toggle}
        aria-label={theme === "dark" ? "摇骰子，切换为明亮风格" : "摇骰子，切换为暗色风格"}
        className={`brand-logo ${rolling ? "is-rolling" : ""} grid h-full w-full place-items-center outline-none active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-400 ${compact ? "rounded-[0.95rem]" : "rounded-[1.75rem]"}`}
      >
      <div className={`brand-logo-glow absolute rounded-[2rem] bg-amber-400/15 blur-2xl ${compact ? "-inset-2 opacity-55" : "-inset-4"}`} />
      <div className={`brand-logo-shell relative grid h-full w-full place-items-center overflow-hidden border border-white/25 bg-[radial-gradient(circle_at_50%_8%,rgba(255,255,255,0.16),transparent_46%),linear-gradient(135deg,rgba(80,74,70,0.94),rgba(37,39,46,0.94))] shadow-[0_12px_30px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.12)] ${compact ? "rounded-[0.95rem]" : "rounded-[1.75rem]"}`}>
        <span className={`absolute rounded-full bg-red-500 shadow-[0_0_14px_rgba(248,70,70,0.75)] ${compact ? "left-2 top-2 h-1.5 w-1.5" : "left-3 top-3 h-3 w-3"}`} />
        <span className={`absolute rounded-full bg-blue-500 shadow-[0_0_14px_rgba(59,130,246,0.8)] ${compact ? "bottom-2 right-2 h-1.5 w-1.5" : "bottom-3 right-3 h-3 w-3"}`} />
        <Dices
          size={compact ? 24 : 38}
          strokeWidth={2.4}
          className="brand-logo-dice relative text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.45)]"
        />
      </div>
      </button>
      {showHint && (
        <span className={`theme-logo-hint absolute z-10 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold shadow-lg ${compact ? "left-12 top-1" : landing ? "left-0 top-full mt-2" : "left-1/2 top-full mt-3 -translate-x-1/2"}`}>
          点击骰子切换主题
        </span>
      )}
    </div>
  );
}

function LandingView({
  db,
  uid,
  onOpenRoom,
  theme,
  onToggleTheme,
  showThemeHint,
  onDismissThemeHint,
}: {
  db: Firestore;
  uid: string;
  onOpenRoom: (link: QuickRoomLink) => void;
  theme: Theme;
  onToggleTheme: () => void;
  showThemeHint: boolean;
  onDismissThemeHint: () => void;
}) {
  const [tab, setTab] = useState<"CREATE" | "JOIN">("CREATE");
  const [mode, setMode] = useState<RoomMode>("LEDGER");
  const [playerName, setPlayerName] = useState(preferredPlayerName);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showPlayerPicker, setShowPlayerPicker] = useState(false);
  const [playerDiceRolling, setPlayerDiceRolling] = useState(false);
  const [recentRooms, setRecentRooms] = useState(readRecentRooms);
  useEffect(() => {
    let active = true;
    const cachedRooms = readRecentRooms();
    if (!cachedRooms.length) return;
    Promise.all(cachedRooms.map(async (room) => {
      try {
        // 房间销毁、邀请撤销或被请离后，对应邀请会被删除。
        return await getQuickInvite(db, room.roomId, room.inviteToken) ? room : null;
      } catch {
        // 网络临时不可用时保留入口，避免误删仍然有效的最近房间。
        return room;
      }
    })).then((checkedRooms) => {
      if (!active) return;
      const validRooms = checkedRooms.filter((room): room is RecentRoom => room !== null);
      saveRecentRooms(validRooms);
      setRecentRooms(validRooms);
    });
    return () => { active = false; };
  }, [db]);
  const choosePlayerName = (name: string) => {
    setPlayerName(name);
    rememberPlayerName(name);
  };
  const chooseRandomPlayerName = () => {
    playDiceFeedback();
    setPlayerDiceRolling(true);
    window.setTimeout(() => {
      choosePlayerName(
        playerNamePresets[Math.floor(Math.random() * playerNamePresets.length)],
      );
      setPlayerDiceRolling(false);
    }, 170);
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "CREATE") {
        rememberPlayerName(playerName);
        onOpenRoom(await createLinkedRoom(db, uid, `${playerName.trim()}的房间`, playerName, mode));
      } else {
        const link = parseRoomLink(code);
        if (!link) throw new Error("请粘贴完整的专属邀请链接。");
        onOpenRoom(link);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "操作失败，请稍后重试。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative min-h-screen bg-[#0f172a] bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-800 to-[#0f172a] px-5 pb-8 pt-5 text-slate-100">
      <main className="relative mx-auto w-full max-w-md pt-10">
        <section className="mb-12 flex items-center gap-4">
          <BrandLogo variant="landing" theme={theme} onToggleTheme={onToggleTheme} showHint={showThemeHint} onDismissHint={onDismissThemeHint} />
          <div className="min-w-0">
            <h1 className="text-[30px] font-black leading-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-400 to-orange-500">牌友记账神器</h1>
            <p className="mt-1 text-[15px] text-slate-400">实时同步的朋友局账本</p>
          </div>
        </section>
        <section className="bg-white/5 border border-white/10 backdrop-blur-xl rounded-3xl p-7">
          <div className="flex p-1 bg-black/20 rounded-xl mb-6">
            <Tab
              active={tab === "CREATE"}
              onClick={() => setTab("CREATE")}
              icon={<Plus size={16} />}
              label="我要开房"
            />
            <Tab
              active={tab === "JOIN"}
              onClick={() => setTab("JOIN")}
              icon={<LogIn size={16} />}
              label="加入房间"
            />
          </div>
          <>
          {tab === "CREATE" ? (
            <>
              <RoomModePicker mode={mode} onChange={setMode} />
              <Input
                label="我的名字（将自动作为房间名）"
                value={playerName}
                onChange={setPlayerName}
                placeholder="例如：赌神阿发"
                action={
                  <div className="flex items-center gap-0.5">
                    <PlayerPickerButton
                      onClick={() => setShowPlayerPicker(true)}
                    />
                    <DiceButton
                      rolling={playerDiceRolling}
                      onClick={chooseRandomPlayerName}
                    />
                  </div>
                }
              />
            </>
          ) : (
            <>
              <Input
                label="专属邀请链接"
                value={code}
                onChange={setCode}
                placeholder="粘贴朋友发来的完整链接"
              />
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setShowScanner(true);
                }}
                className="-mt-2 mb-5 w-full rounded-2xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-slate-300 flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                <Camera size={18} className="text-amber-400" />
                扫码加入房间
              </button>
            </>
          )}
          {error && <p className="text-sm text-red-300 mb-4">{error}</p>}
          <button
            disabled={
              busy || (tab === "CREATE" ? !playerName : !code)
            }
            onClick={submit}
            className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 font-black text-lg flex justify-center gap-2 disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
          >
            {busy && <LoaderCircle className="animate-spin" />}{" "}
            {tab === "CREATE"
              ? `创建${mode === "LEDGER" ? "记账房" : "牌局房"}`
              : "下一步"}
            <ChevronRight />
          </button>
          </>
        </section>
        {!!recentRooms.length && <section className="mt-5">
          <div className="mb-2 flex items-center gap-2 px-1 text-xs font-bold text-slate-400"><History size={14} />最近房间</div>
          <div className="space-y-2">{recentRooms.map((room) => <div key={`${room.roomId}-${room.inviteToken}`} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-2 backdrop-blur-xl"><button type="button" onClick={() => onOpenRoom(room)} className="min-w-0 flex-1 rounded-xl px-3 py-2 text-left active:bg-white/5"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-bold text-slate-200">{room.roomName}</p><ChevronRight size={16} className="shrink-0 text-blue-300" /></div><p className="mt-1 truncate text-[11px] text-slate-500">以“{room.playerName}”进入 · {room.role === "OWNER" ? "房主" : "牌友"}</p></button><button type="button" onClick={() => { forgetRecentRoom(room.roomId, room.inviteToken); setRecentRooms(readRecentRooms()); }} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 active:bg-white/5" aria-label={`移除${room.roomName}`}><X size={15} /></button></div>)}</div>
        </section>}
        {showPlayerPicker && (
          <ModalFrame
            title="选择玩家名"
            onClose={() => setShowPlayerPicker(false)}
          >
            <PlayerNamePicker
              onSelect={(name) => {
                choosePlayerName(name);
                setShowPlayerPicker(false);
              }}
            />
          </ModalFrame>
        )}
        {showScanner && (
          <RoomQrScanner
            onClose={() => setShowScanner(false)}
            onRoomLink={(link) => {
              setCode(buildRoomLink(link.roomId, link.inviteToken));
              setShowScanner(false);
              onOpenRoom(link);
            }}
          />
        )}
      </main>
    </div>
  );
}


function RoomModePicker({
  mode,
  onChange,
}: {
  mode: RoomMode;
  onChange: (mode: RoomMode) => void;
}) {
  return (
    <div className="mb-5">
      <p className="mb-2 text-sm font-bold text-slate-400">房间用途</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange("LEDGER")}
          className={`rounded-2xl border p-3 text-left transition ${mode === "LEDGER" ? "border-amber-400 bg-amber-400/10 text-amber-200" : "border-white/10 bg-black/20 text-slate-400"}`}
        >
          <span className="flex items-center gap-2 text-sm font-black">
            <Wallet size={16} /> 记账
          </span>
          <span className="mt-1 block text-[10px] leading-4 opacity-75">
            转账与账本流水
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChange("POKER")}
          className={`rounded-2xl border p-3 text-left transition ${mode === "POKER" ? "border-amber-400 bg-amber-400/10 text-amber-200" : "border-white/10 bg-black/20 text-slate-400"}`}
        >
          <span className="flex items-center gap-2 text-sm font-black">
            <Dices size={16} /> 德州扑克
          </span>
          <span className="mt-1 block text-[10px] leading-4 opacity-75">
            荷官控场，下注与结算
          </span>
        </button>
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 ${active ? "bg-white/10 text-amber-400 border border-white/10" : "text-slate-500"}`}
    >
      {icon}
      {label}
    </button>
  );
}

function RoomQrScanner({
  onRoomLink,
  onClose,
}: {
  onRoomLink: (link: QuickRoomLink) => void;
  onClose: () => void;
}) {
  const readerId = useRef(`room-qr-reader-${crypto.randomUUID()}`);
  const scanner = useRef<Html5Qrcode | null>(null);
  const scanned = useRef(false);
  const [message, setMessage] = useState("将镜头对准朋友分享的专属二维码");

  useEffect(() => {
    let cancelled = false;
    const stopCamera = async () => {
      try {
        await scanner.current?.stop();
      } catch {
        // Stopping before the camera has started is harmless.
      }
      try {
        await scanner.current?.clear();
      } catch {
        // The view can already be gone while React is unmounting.
      }
    };
    const startCamera = async () => {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import(
        "html5-qrcode"
      );
      if (cancelled) return;
      const instance = new Html5Qrcode(readerId.current, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      scanner.current = instance;
      try {
        await instance.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          async (decodedText) => {
            if (scanned.current) return;
            const link = parseRoomLink(decodedText);
            if (!link) {
              setMessage("这不是有效的专属邀请，请重新扫描。");
              return;
            }
            scanned.current = true;
            await stopCamera();
            if (!cancelled) onRoomLink(link);
          },
          () => undefined,
        );
      } catch {
        if (!cancelled)
          setMessage("无法打开摄像头。请允许相机权限，或改为粘贴专属链接。");
      }
    };
    void startCamera();
    return () => {
      cancelled = true;
      void stopCamera();
    };
  }, [onRoomLink]);

  return (
    <ModalFrame title="扫码加入房间" onClose={onClose}>
      <div className="overflow-hidden rounded-2xl bg-black">
        <div id={readerId.current} className="min-h-56" />
      </div>
      <p className="mt-4 text-center text-sm leading-6 text-slate-400">
        {message}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-5 w-full rounded-2xl bg-white/5 py-3 text-sm font-bold text-slate-300"
      >
        取消扫描
      </button>
    </ModalFrame>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  numeric = false,
  disabled = false,
  action,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  numeric?: boolean;
  disabled?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="block mb-5">
      <div className="mb-2">
        <label className="block text-sm font-bold text-slate-400">
          {label}
        </label>
      </div>
      <div className="relative">
        <input
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          type={numeric ? "number" : "text"}
          inputMode={numeric ? "numeric" : "text"}
          className={`w-full rounded-2xl bg-black/30 border border-white/10 py-4 pl-5 text-white placeholder:text-slate-600 outline-none focus:border-amber-400 disabled:cursor-not-allowed disabled:opacity-45 ${action ? "pr-24" : "pr-5"}`}
        />
        {action && (
          <div className="absolute inset-y-0 right-2 flex items-center">
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

function DiceButton({
  rolling,
  onClick,
}: {
  rolling: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="随机取名"
      title="随机取名"
      onClick={onClick}
      className="grid h-10 w-10 place-items-center rounded-xl text-amber-400 transition-colors hover:bg-amber-400/10 active:scale-90"
    >
      <Dices
        size={20}
        className={rolling ? "animate-[spin_0.38s_ease-out]" : ""}
      />
    </button>
  );
}

function PlayerPickerButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="手动选择玩家名"
      title="手动选择玩家名"
      onClick={onClick}
      className="grid h-10 w-8 place-items-center rounded-xl text-slate-400 transition-colors hover:bg-white/5 hover:text-amber-300"
    >
      <Users size={18} />
    </button>
  );
}

function PlayerNamePicker({ onSelect }: { onSelect: (name: string) => void }) {
  return (
    <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
      {playerNameGroups.map((group) => (
        <section key={group.label}>
          <p className="mb-2 text-xs font-bold text-amber-300">{group.label}</p>
          <div className="flex flex-wrap gap-2">
            {group.names.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => onSelect(name)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-200 active:scale-95"
              >
                {name}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}


function RoomView({
  db,
  roomId,
  uid,
  inviteToken,
  currentPlayer,
  state,
  theme,
  onToggleTheme,
  showThemeHint,
  onDismissThemeHint,
  onHome,
}: {
  db: Firestore;
  roomId: string;
  uid: string;
  inviteToken: string;
  currentPlayer: Player;
  state: RoomState;
  theme: Theme;
  onToggleTheme: () => void;
  showThemeHint: boolean;
  onDismissThemeHint: () => void;
  onHome: () => void;
}) {
  const [modal, setModal] = useState<Modal>(null);
  const [forceTarget, setForceTarget] = useState<Player | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Player | null>(null);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [betModeTarget, setBetModeTarget] = useState<"BLIND" | "NORMAL" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roomActionsRef = useRef<HTMLDivElement>(null);
  const room = state.room!;
  const isOwner = room.ownerId === uid;
  const isLedger = isLedgerRoom(room);
  const isActive = room.status === "ACTIVE";
  const activePlayers = state.players.filter(
    (player) => player.isActiveMember !== false,
  );
  const seatedPlayers = activePlayers.filter((player) => player.isSeated === true);
  const readyPlayers = seatedPlayers.filter((player) => player.isReady === true);
  const inHand = currentPlayer.activeInHand || currentPlayer.folded;
  const isBlind = currentPlayer.betMode === "BLIND";
  const currentStake = currentPlayer.roundStake ?? currentPlayer.roundContribution ?? 0;
  const maxRoundStake = room.settings?.maxSingleBet ?? 200;
  const stakeMultiplier = isBlind ? 2 : 1;
  const usesRoundBetLimit = room.betLimitMode === "ROUND";
  const remainingRoundBetAmount = usesRoundBetLimit
    ? Math.floor(Math.max(0, maxRoundStake - currentStake) / stakeMultiplier)
    : Math.floor(maxRoundStake / stakeMultiplier);
  const callAmount = Math.ceil(
    Math.max(0, (room.currentBet ?? 0) - currentStake) / stakeMultiplier,
  );
  const callExceedsRoundLimit = usesRoundBetLimit
    && currentStake + callAmount * stakeMultiplier > maxRoundStake;
  const playerMap = useMemo(
    () => new Map(state.players.map((player) => [player.id, player])),
    [state.players],
  );
  useEffect(() => {
    if (modal !== "ROOM_ACTIONS") return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!roomActionsRef.current?.contains(event.target as Node)) setModal(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModal(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [modal]);
  const act = async (work: () => Promise<void>, sound: SoundEffect = "CONFIRM") => {
    primeSound();
    setBusy(true);
    try {
      await work();
      playSound(sound);
      setNotice("已提交，正在同步到所有玩家。");
      setTimeout(() => setNotice(null), 2800);
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "操作失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };
  const inviteUrl = buildRoomLink(roomId, inviteToken);
  const copyInvite = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setNotice("邀请链接已复制。");
    setTimeout(() => setNotice(null), 2000);
  };
  return (
    <div className="room-shell max-w-lg mx-auto bg-[#0f172a] text-slate-100">
      <header className="sticky top-0 z-20 p-4 bg-slate-900/80 backdrop-blur-md border-b border-white/5 flex justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <BrandLogo variant="header" theme={theme} onToggleTheme={onToggleTheme} showHint={showThemeHint} onDismissHint={onDismissThemeHint} />
          <div className="flex h-11 min-w-0 flex-1 flex-col items-start justify-between text-left">
            <h1 className="truncate text-[16px] font-bold leading-[1.15]">{room.name}</h1>
            <div className="flex w-full items-center justify-start gap-2 text-[10px] leading-none">
              <span className="room-mode-badge rounded-full bg-white/5 px-2 py-1 font-bold text-slate-400">
                {roomModeLabel(room)}
              </span>
              <span className="truncate font-medium text-slate-500">
                {room.createdAt ? roomTime(room.createdAt.toDate()) : "刚刚创建"}
              </span>
            </div>
          </div>
        </div>
        <div ref={roomActionsRef} className="relative flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setModal("SHARE")}
            className="grid h-11 w-11 place-items-center rounded-xl border border-blue-400/25 bg-blue-500/10 text-blue-300 active:scale-95"
            aria-label={isOwner ? "邀请朋友" : "我的专属链接"}
            title={isOwner ? "邀请朋友" : "我的专属链接"}
          >
            <Share2 size={18} />
          </button>
          <button
            onClick={() => setModal("ROOM_ACTIONS")}
            className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/5 text-slate-300 active:scale-95"
            aria-label="房间操作"
            title="房间操作"
          >
            <SlidersHorizontal size={18} />
          </button>
          {modal === "ROOM_ACTIONS" && (
            <RoomActionsModal
              isOwner={isOwner}
              isLedger={isLedger}
              onClose={() => setModal(null)}
              onOpenSettings={() => setModal("SETTINGS")}
              onOpenShare={() => setModal("SHARE")}
              onOpenDestroy={() => setModal("DESTROY")}
              onOpenLeave={() => setModal("LEAVE")}
            />
          )}
        </div>
      </header>
      <main className="p-4 space-y-5">
        {!isLedger && (
        <section className="rounded-3xl overflow-hidden border border-white/10 bg-gradient-to-b from-slate-900 to-slate-900/40">
          <div className="p-4 flex items-center justify-between border-b border-white/5">
            <div className="flex items-center gap-3">
              <span className="p-2 rounded-xl bg-amber-400 text-slate-900">
                <Coins size={18} />
              </span>
              <div>
                <p className="text-[10px] tracking-wider text-slate-400">
                  当前底池
                </p>
                <p className="text-2xl font-black">{money(room.pot)}</p>
              </div>
            </div>
            <div className="text-right">
                <p className="text-[10px] text-slate-400">轮次</p>
                <p className="text-xl font-bold">{isActive ? room.round : "-"}</p>
            </div>
          </div>
          <div className="p-4 min-h-28">
            {isActive ? (
              <div className="space-y-2">
                {state.players
                  .filter(
                    (player) =>
                      player.isActiveMember !== false &&
                      (player.activeInHand || player.folded),
                  )
                  .map((player) => (
                    <div
                      key={player.id}
                      className={`flex justify-between rounded-xl p-2.5 text-sm ${player.folded ? "opacity-40" : "bg-white/5"}`}
                    >
                      <span className="flex items-center gap-1.5">
                        {player.displayName}
                        {player.betMode === "BLIND" && <span className="rounded bg-violet-400/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">盲注</span>}
                      </span>
                      <span className="text-amber-400">
                        {player.folded
                          ? "已弃牌"
                          : `本轮 ${money(player.roundContribution ?? 0)}`}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="space-y-2">
                {seatedPlayers.map((player) => (
                  <div key={player.id} className="flex justify-between rounded-xl bg-white/5 p-2.5 text-sm">
                    <span>{player.displayName}</span>
                    <span className={player.isReady ? "text-green-300" : "text-slate-500"}>
                      {player.isReady ? "已准备" : "未准备"}
                    </span>
                  </div>
                ))}
                {!seatedPlayers.length && <div className="h-24 flex flex-col justify-center items-center text-slate-500"><Dices size={24} /><p className="mt-2 text-sm">牌桌空闲中</p></div>}
              </div>
            )}
          </div>
        </section>
        )}
        <section>
          <p className="mb-3 text-sm font-bold text-slate-400 flex items-center gap-2">
            <Users size={15} />
            {isLedger ? "记账玩家" : "打牌玩家"} ({room.playerCount}/{room.maxPlayers})
          </p>
          <div className="grid grid-cols-2 gap-3">
            {activePlayers.map((player) => (
              <PlayerCard
                key={player.id}
                player={player}
                isMe={player.id === uid}
                isOwner={player.id === room.ownerId}
                label={isLedger ? "余额" : "筹码"}
                initialBalance={room.settings?.initialBalance ?? 10_000}
                status={!isLedger ? (isActive ? (player.activeInHand ? "游戏中" : player.folded ? "已弃牌" : player.isSeated ? "等待下局" : "未上桌") : player.isSeated ? (player.isReady ? "已准备" : "未准备") : "未上桌") : undefined}
                isBlind={!isLedger && player.betMode === "BLIND"}
                onTransfer={player.id !== uid ? () => {
                  setTransferTarget(player.id);
                  setModal("TRANSFER");
                } : undefined}
                onRename={player.id === uid ? () => setModal("RENAME") : undefined}
                onForceOffTable={!isLedger && isOwner && player.id !== uid && player.isSeated ? () => setForceTarget(player) : undefined}
                onRemoveFromRoom={isOwner && player.id !== uid ? () => setRemoveTarget(player) : undefined}
              />
            ))}
          </div>
        </section>
        <section>
          <div className="flex justify-between mb-3">
            <p className="text-sm font-bold text-slate-400 flex gap-2">
              <History size={15} />
              {isLedger ? "最近流水" : "牌局记录"}
            </p>
            <button
              onClick={() => setModal("HISTORY")}
              className="text-xs text-amber-400"
            >
              查看全部
            </button>
          </div>
          <div className="space-y-2">
            {state.events.slice(0, 3).map((event) => (
              <EventRow key={event.id} event={event} players={state.players} compact />
            ))}
            {!state.events.length && (
              <p className="text-sm text-slate-500 text-center py-5">
                还没有账务记录
              </p>
            )}
          </div>
        </section>
      </main>
      {notice && (
        <div className="mobile-notice fixed z-50 left-1/2 -translate-x-1/2 max-w-[90vw] px-4 py-3 rounded-xl bg-slate-700 text-sm shadow-xl">
          {notice}
        </div>
      )}
      <nav className="mobile-action-bar fixed max-w-lg bottom-0 left-0 right-0 mx-auto px-3 pt-3 bg-[#0f172a] border-t border-white/10 grid grid-cols-4 gap-2">
        {isLedger ? (
          <button
            onClick={() => {
              setTransferTarget(null);
              setModal("TRANSFER");
            }}
            className="col-span-4 rounded-xl py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 font-black flex items-center justify-center gap-2"
          >
            <Wallet size={19} /> 转账
          </button>
        ) : (
          <>
            {isActive && !inHand ? (
              <button onClick={() => act(() => currentPlayer.isSeated ? leaveTable(db, roomId, uid) : takeSeat(db, roomId, uid))} className="col-span-4 rounded-xl py-4 bg-slate-800 text-slate-300 font-bold">
                {currentPlayer.isSeated ? "下桌（等待下一局）" : "上桌（下一局加入）"}
              </button>
            ) : isActive && currentPlayer.folded ? (
              <div className="col-span-4 rounded-xl bg-slate-800 text-slate-500 text-xs flex items-center justify-center">
                本局已弃牌，等待房主结算
              </div>
            ) : isActive ? (
              <>
                <button
                  onClick={() => act(() => callBet(db, roomId, uid), "CHIPS")}
                  disabled={busy || !callAmount || callExceedsRoundLimit}
                  className="rounded-xl bg-blue-500/15 border border-blue-400/20 text-blue-300 text-xs font-bold disabled:cursor-not-allowed disabled:bg-slate-800 disabled:border-slate-700 disabled:text-slate-500"
                >
                  {callExceedsRoundLimit
                    ? "已达本轮上限"
                    : callAmount
                      ? `${isBlind ? "盲注跟注" : "跟注"} ${money(callAmount)}`
                      : "等待下注"}
                </button>
                <button
                  onClick={() => setModal("BET")}
                  disabled={busy || remainingRoundBetAmount <= 0}
                  className="col-span-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold flex flex-col items-center justify-center disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
                >
                  <Coins size={18} />
                  <span className="text-xs">
                    {remainingRoundBetAmount <= 0
                      ? "本轮下注已达上限"
                      : isBlind
                        ? "盲注 / 加注"
                        : (room.currentBet ?? 0) ? "下注 / 加注" : "先下注"}
                  </span>
                </button>
                <button
                  onClick={() => act(() => fold(db, roomId, uid), "CARD")}
                  disabled={busy}
                  className="rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-bold disabled:cursor-not-allowed disabled:bg-slate-800 disabled:border-slate-700 disabled:text-slate-500"
                >
                  弃牌
                </button>
              </>
            ) : (
              <>
                {!currentPlayer.isSeated ? (
                  <button onClick={() => act(() => takeSeat(db, roomId, uid))} className="col-span-4 rounded-xl py-4 bg-slate-800 text-slate-200 font-bold">上桌</button>
                ) : (
                  <>
                    <button onClick={() => act(() => setReady(db, roomId, uid, !currentPlayer.isReady), "TICK")} className={`col-span-3 rounded-xl py-4 font-bold ${currentPlayer.isReady ? "bg-green-500/15 text-green-300" : "bg-amber-400 text-slate-900"}`}>
                      {currentPlayer.isReady ? "已准备 · 点击取消" : "准备"}
                    </button>
                    <button
                      onClick={() => act(() => leaveTable(db, roomId, uid))}
                      disabled={busy || currentPlayer.isReady}
                      className="rounded-xl bg-slate-800 text-slate-300 text-xs font-bold disabled:cursor-not-allowed disabled:bg-slate-800/50 disabled:text-slate-600"
                    >
                      {currentPlayer.isReady ? "先取消准备" : "下桌"}
                    </button>
                  </>
                )}
                {isOwner && <button onClick={() => act(() => startHand(db, roomId, uid), "DEAL")} disabled={busy || readyPlayers.length < 2} className="col-span-4 rounded-xl py-3 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 font-black disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500">
                  {readyPlayers.length >= 2 ? "开始牌局" : `等待准备（${readyPlayers.length}/2）`}
                </button>}
              </>
            )}
            {isActive && isOwner && (
              <div className="col-span-4 grid grid-cols-2 gap-2">
                <button
                  onClick={() => act(() => nextRound(db, roomId, uid), "DEAL")}
                  disabled={busy}
                  className="rounded-xl py-2 bg-blue-500/15 border border-blue-400/20 text-blue-300 text-xs font-bold disabled:cursor-not-allowed disabled:bg-slate-800 disabled:border-slate-700 disabled:text-slate-500"
                >
                  下一轮
                </button>
                <button
                  onClick={() => setModal("SETTLE")}
                  className="rounded-xl py-2 bg-red-500/15 border border-red-400/20 text-red-300 text-xs font-bold"
                >
                  结算本局
                </button>
              </div>
            )}
          </>
        )}
      </nav>
      {modal === "TRANSFER" && (
        <TransferModal
          players={activePlayers.filter((player) => player.id !== uid)}
          initialTo={transferTarget ?? undefined}
          onClose={() => {
            setTransferTarget(null);
            setModal(null);
          }}
          onSubmit={(to, amount) =>
            act(async () => {
              await transfer(db, roomId, uid, to, amount);
              setTransferTarget(null);
              setModal(null);
            }, "CHIPS")
          }
        />
      )}
      {modal === "BET" && (
        <AmountModal
          title={isBlind ? "确认盲注" : "确认下注"}
          action={isBlind ? "盲注" : (room.currentBet ?? 0) ? "下注 / 加注" : "下注"}
          maxAmount={remainingRoundBetAmount}
          roundLimit={maxRoundStake}
          usesRoundLimit={usesRoundBetLimit}
          blind={isBlind}
          canEnableBlind={!isBlind && room.round === 1 && currentPlayer.blindLocked !== true}
          blindLocked={currentPlayer.blindLocked === true || room.round !== 1}
          onRequestBetModeChange={setBetModeTarget}
          onClose={() => setModal(null)}
          onSubmit={(amount) =>
            act(async () => {
              await placeBet(db, roomId, uid, amount);
              setModal(null);
            }, "CHIPS")
          }
        />
      )}
      {modal === "SETTINGS" && (
        <RoomSettingsModal
          isPoker={!isLedger}
          initialBalance={room.settings?.initialBalance ?? 10_000}
          maxSingleBet={room.settings?.maxSingleBet ?? 200}
          ante={room.settings?.ante ?? 10}
          initialBalanceLocked={room.hasStarted === true}
          maxSingleBetLocked={isActive}
          anteLocked={isActive}
          onClose={() => setModal(null)}
          onSubmit={(settings) =>
            act(async () => {
              await updateRoomSettings(db, roomId, uid, settings);
              setModal(null);
            })
          }
        />
      )}
      {modal === "SETTLE" && (
        <SettlementModal
          players={activePlayers.filter((player) => !player.folded)}
          pot={room.pot}
          onClose={() => setModal(null)}
          onSubmit={(winners) =>
            act(async () => {
              await settle(db, roomId, uid, winners);
              setModal(null);
            }, "WIN")
          }
        />
      )}
      {modal === "HISTORY" && (
        <HistoryModal
          events={state.events}
          players={state.players}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "SHARE" && (
        <ShareModal
          db={db}
          ownerId={uid}
          currentPlayerId={uid}
          roomId={roomId}
          roomName={room.name}
          inviteUrl={inviteUrl}
          inviteToken={inviteToken}
          isOwner={isOwner}
          players={state.players}
          onCopy={copyInvite}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "DESTROY" && (
        <DestroyRoomModal
          roomName={room.name}
          onClose={() => setModal(null)}
          onSubmit={async () => {
            await destroyRoom(db, roomId, uid);
            forgetRecentRoom(roomId, inviteToken);
            setModal(null);
            onHome();
          }}
        />
      )}
      {modal === "LEAVE" && (
        <LeaveRoomModal
          roomName={room.name}
          isInHand={isActive}
          onClose={() => setModal(null)}
          onSubmit={async () => { setModal(null); onHome(); }}
        />
      )}
      {modal === "RENAME" && (
        <RenamePlayerModal
          currentName={currentPlayer.displayName}
          onClose={() => setModal(null)}
          onSubmit={(name) => act(async () => { await renameRoomPlayer(db, roomId, uid, uid, name); setModal(null); })}
        />
      )}
      {forceTarget && (
        <ForceOffTableModal
          playerName={forceTarget.displayName}
          isInHand={forceTarget.activeInHand || forceTarget.folded}
          onClose={() => setForceTarget(null)}
          onSubmit={async () => {
            await forceOffTable(db, roomId, uid, forceTarget.id);
            setForceTarget(null);
            setNotice(`已请 ${forceTarget.displayName} 下桌。`);
            setTimeout(() => setNotice(null), 2800);
          }}
        />
      )}
      {removeTarget && (
        <ForceRemovePlayerModal
          playerName={removeTarget.displayName}
          isInHand={removeTarget.activeInHand || removeTarget.folded}
          onClose={() => setRemoveTarget(null)}
          onSubmit={async () => {
            const playerName = removeTarget.displayName;
            await forceRemovePlayer(db, roomId, uid, removeTarget.id);
            setRemoveTarget(null);
            setNotice(`已请 ${playerName} 离开房间。`);
            setTimeout(() => setNotice(null), 2800);
          }}
        />
      )}
      {betModeTarget && (
        <BetModeConfirmModal
          target={betModeTarget}
          onClose={() => setBetModeTarget(null)}
          onSubmit={async () => {
            await setBetMode(db, roomId, uid, betModeTarget);
            setBetModeTarget(null);
            setNotice(betModeTarget === "BLIND" ? "已开启盲注。" : "已切回正常下注，本局不能再次开启盲注。");
            setTimeout(() => setNotice(null), 2800);
          }}
        />
      )}
    </div>
  );
}

function PlayerCard({
  player,
  isMe,
  isOwner,
  label,
  initialBalance,
  status,
  isBlind,
  onTransfer,
  onRename,
  onForceOffTable,
  onRemoveFromRoom,
}: {
  player: Player;
  isMe: boolean;
  isOwner: boolean;
  label: string;
  initialBalance: number;
  status?: string;
  isBlind?: boolean;
  onTransfer?: () => void;
  onRename?: () => void;
  onForceOffTable?: () => void;
  onRemoveFromRoom?: () => void;
}) {
  const profitLoss = player.balance - initialBalance;
  const profitLossStyle = profitLoss > 0
    ? "bg-green-500/15 text-green-300"
    : profitLoss < 0
      ? "bg-red-500/10 text-red-300"
      : "bg-white/5 text-slate-500";
  return (
    <div
      onClick={onRename ?? onTransfer}
      onKeyDown={(event) => {
        if ((onRename ?? onTransfer) && (event.key === "Enter" || event.key === " ")) (onRename ?? onTransfer)?.();
      }}
      role={(onRename ?? onTransfer) ? "button" : undefined}
      tabIndex={(onRename ?? onTransfer) ? 0 : undefined}
      className={`rounded-2xl border p-3.5 min-h-24 ${isMe ? "bg-blue-500/10 border-blue-400/30" : "bg-white/5 border-white/5"} ${(onRename ?? onTransfer) ? "cursor-pointer transition-colors hover:bg-white/10 active:scale-[0.98]" : ""}`}
    >
      <div className="flex justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-bold">
            {player.displayName}
          </span>
          {isMe && <Pencil size={12} className="shrink-0 text-blue-300" aria-hidden="true" />}
        </div>
        <div className="flex items-center gap-2">
          {isOwner && (
            <span className="flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
              <Crown size={10} /> 房主
            </span>
          )}
          {isBlind && (
            <span className="rounded bg-violet-400/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">盲注</span>
          )}
          {status && <span className={`text-[9px] ${status === "已准备" ? "text-green-300" : "text-slate-500"}`}>{status}</span>}
        </div>
      </div>
      {(onForceOffTable || onRemoveFromRoom) && (
        <div className="mt-2 flex items-center gap-3 text-[10px]">
          {onForceOffTable && <button onClick={(event) => { event.stopPropagation(); onForceOffTable(); }} className="text-slate-500">请下桌</button>}
          {onRemoveFromRoom && <button onClick={(event) => { event.stopPropagation(); onRemoveFromRoom(); }} className="text-red-300">请离开</button>}
        </div>
      )}
      <p className="mt-4 text-[10px] text-slate-500">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className={`min-w-0 text-xl font-black ${profitLoss > 0 ? "text-amber-400" : "text-slate-300"}`}>
          {money(player.balance)}
        </p>
        <span className={`mb-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-bold ${profitLossStyle}`}>
          盈亏 {signedMoney(profitLoss)}
        </span>
      </div>
    </div>
  );
}
function EventRow({
  event,
  players,
  compact = false,
}: {
  event: LedgerEvent;
  players: Player[];
  compact?: boolean;
}) {
  if (compact) return (
    <div className="flex items-center gap-2 rounded-xl border border-white/5 bg-white/5 px-3 py-2.5 text-sm">
      <p className="min-w-0 flex-1 truncate font-medium">{eventLabel(event, players)}</p>
      {event.amount ? <p className="shrink-0 font-bold text-amber-400">{money(event.amount)}</p> : null}
      <time className="shrink-0 text-[10px] font-medium text-slate-500">{eventTime(event)}</time>
    </div>
  );
  return (
    <div className="rounded-xl border border-white/5 bg-white/5 p-3 flex justify-between text-sm">
      <div>
        <p className="font-medium">{eventLabel(event, players)}</p>
        <p className="text-[10px] text-slate-500 mt-1">{eventTime(event)}</p>
      </div>
      {event.amount ? (
        <p className="font-bold text-amber-400">{money(event.amount)}</p>
      ) : null}
    </div>
  );
}

function ModalFrame({
  title,
  onClose,
  children,
  centered = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  centered?: boolean;
}) {
  return (
    <div className={`fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex justify-center ${centered ? "items-center p-5" : "items-end sm:items-center"}`}>
      <section className={`w-full max-w-md max-h-[calc(100dvh-2.5rem)] overflow-y-auto bg-[#1e293b] border border-white/10 p-6 text-slate-100 ${centered ? "rounded-3xl" : "rounded-t-3xl sm:rounded-3xl"}`}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} className="p-2 text-slate-400">
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function RoomActionsModal({
  isOwner,
  isLedger,
  onClose,
  onOpenSettings,
  onOpenShare,
  onOpenDestroy,
  onOpenLeave,
}: {
  isOwner: boolean;
  isLedger: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShare: () => void;
  onOpenDestroy: () => void;
  onOpenLeave: () => void;
}) {
  const open = (action: () => void) => {
    onClose();
    action();
  };
  const itemClass = "room-action-item flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-bold text-slate-100 transition-colors active:scale-[0.99]";
  return (
      <section
        className="room-actions-popover absolute right-0 top-full z-40 mt-2 w-[min(17.5rem,calc(100vw-1.5rem))] rounded-2xl border border-white/10 bg-[#1e293b]/95 p-2 shadow-2xl backdrop-blur-xl"
        aria-label="房间操作"
      >
      <div className="space-y-1">
        {isOwner && (
          <button type="button" onClick={() => open(onOpenSettings)} className={itemClass}>
            {isLedger ? <Wallet size={18} className="text-blue-300" /> : <Spade size={18} className="text-amber-300" />}
            <span>{isLedger ? "房间设置" : "牌局设置"}</span>
          </button>
        )}
        <button type="button" onClick={() => open(onOpenShare)} className={itemClass}>
          <Share2 size={18} className="text-blue-300" />
          <span>{isOwner ? "邀请朋友" : "我的专属链接"}</span>
        </button>
        <button type="button" onClick={() => open(onOpenLeave)} className={itemClass}>
          <LogIn size={18} className="rotate-180 text-slate-300" />
          <span>离开房间</span>
        </button>
        {isOwner && (
          <button type="button" onClick={() => open(onOpenDestroy)} className="room-action-danger mt-1 flex w-full items-center gap-3 border-t border-red-400/15 px-3 pb-3 pt-4 text-left text-sm font-bold text-red-300 active:scale-[0.99]">
            <X size={18} />
            <span>销毁房间</span>
          </button>
        )}
      </div>
      </section>
  );
}

function AmountModal({
  title,
  action,
  maxAmount,
  roundLimit,
  usesRoundLimit = true,
  blind = false,
  canEnableBlind = false,
  blindLocked = false,
  onRequestBetModeChange,
  onClose,
  onSubmit,
}: {
  title: string;
  action: string;
  maxAmount?: number;
  roundLimit?: number;
  usesRoundLimit?: boolean;
  blind?: boolean;
  canEnableBlind?: boolean;
  blindLocked?: boolean;
  onRequestBetModeChange?: (mode: "BLIND" | "NORMAL") => void;
  onClose: () => void;
  onSubmit: (amount: number) => void;
}) {
  const [amount, setAmount] = useState("");
  const numericAmount = Number(amount);
  const hasMaximum = maxAmount !== undefined;
  const isTooHigh = hasMaximum && numericAmount > maxAmount;
  const addAmount = (value: number) => {
    const next = Math.max(0, (Number(amount) || 0) + value);
    setAmount(String(hasMaximum ? Math.min(next, maxAmount) : next));
  };
  return (
    <ModalFrame title={title} onClose={onClose}>
      {onRequestBetModeChange && (
        <div className={`mb-4 flex items-center justify-between rounded-xl border px-3 py-2.5 text-xs ${blind ? "border-violet-400/25 bg-violet-400/10" : "border-white/10 bg-black/15"}`}>
          <div>
            <p className={`font-bold ${blind ? "text-violet-200" : "text-slate-300"}`}>{blind ? "盲注中" : "正常下注"}</p>
            <p className="mt-0.5 text-slate-500">{blind ? "输入实际筹码，按双倍金额计入下注。" : blindLocked ? "本局已不能开启盲注。" : "第一轮可选择开启盲注。"}</p>
          </div>
          {blind ? (
            <button type="button" onClick={() => onRequestBetModeChange("NORMAL")} className="rounded-lg border border-violet-400/30 px-2.5 py-1.5 font-bold text-violet-200 active:scale-95">取消盲注</button>
          ) : canEnableBlind ? (
            <button type="button" onClick={() => onRequestBetModeChange("BLIND")} className="rounded-lg border border-violet-400/30 bg-violet-400/10 px-2.5 py-1.5 font-bold text-violet-200 active:scale-95">开启盲注</button>
          ) : null}
        </div>
      )}
      <Input
        label="金额"
        value={amount}
        onChange={setAmount}
        placeholder="0"
        numeric
      />
      {hasMaximum && (
        <>
          <div className="grid grid-cols-4 gap-2 -mt-1 mb-3">
            {[10, 50, 100].map((value) => (
              <button key={value} type="button" onClick={() => addAmount(value)} className="rounded-xl border border-amber-400/20 bg-amber-400/10 py-2 text-sm font-bold text-amber-300 active:scale-95">
                +{value}
              </button>
            ))}
            <button type="button" onClick={() => setAmount("")} className="rounded-xl border border-white/10 py-2 text-xs font-bold text-slate-400 active:scale-95">清空</button>
          </div>
          <p className={`mb-4 text-xs ${isTooHigh ? "text-red-300" : "text-slate-500"}`}>
            {usesRoundLimit ? "本轮还可" : "单次最多"}{blind ? "盲注" : "下注"}：{money(maxAmount)}
            {blind && roundLimit ? `（按双倍金额计，${usesRoundLimit ? "本轮有效下注" : "单次有效下注"}上限 ${money(roundLimit)}）` : ""}
          </p>
        </>
      )}
      <button
        disabled={!amount || !numericAmount || isTooHigh}
        onClick={() => onSubmit(Number(amount))}
        className="w-full rounded-2xl py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 font-black disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
      >
        确认{action}
      </button>
    </ModalFrame>
  );
}

function RoomSettingsModal({
  isPoker,
  initialBalance,
  maxSingleBet,
  ante,
  initialBalanceLocked,
  maxSingleBetLocked,
  anteLocked,
  onClose,
  onSubmit,
}: {
  isPoker: boolean;
  initialBalance: number;
  maxSingleBet: number;
  ante: number;
  initialBalanceLocked: boolean;
  maxSingleBetLocked: boolean;
  anteLocked: boolean;
  onClose: () => void;
  onSubmit: (settings: { initialBalance: number; maxSingleBet?: number; ante?: number }) => void;
}) {
  const [initialValue, setInitialValue] = useState(String(initialBalance));
  const [maxValue, setMaxValue] = useState(String(maxSingleBet));
  const [anteValue, setAnteValue] = useState(String(ante));
  const nextInitialBalance = Number(initialValue);
  const nextMaxSingleBet = Number(maxValue);
  const nextAnte = Number(anteValue);
  const invalidInitialBalance = !Number.isSafeInteger(nextInitialBalance) || nextInitialBalance < 100 || nextInitialBalance > 1_000_000;
  const invalidMaxSingleBet = isPoker && (!Number.isSafeInteger(nextMaxSingleBet) || nextMaxSingleBet < 10 || nextMaxSingleBet > 10_000);
  const invalidAnte = isPoker && (!Number.isSafeInteger(nextAnte) || nextAnte < 1 || nextAnte > 10_000 || nextAnte > nextInitialBalance);
  const unchanged = nextInitialBalance === initialBalance && (!isPoker || (nextMaxSingleBet === maxSingleBet && nextAnte === ante));
  return (
    <ModalFrame title="房间设置" onClose={onClose}>
      <section className="rounded-2xl border border-white/10 bg-black/15 p-4">
        <p className="text-sm font-bold text-slate-200">起始金额</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">每位玩家加入房间时的初始{isPoker ? "筹码" : "余额"}。保存时会同步重设当前玩家的金额。</p>
        <div className="mt-4">
          <Input label="每位玩家初始金额" value={initialValue} onChange={setInitialValue} placeholder="10000" numeric disabled={initialBalanceLocked} />
        </div>
        <div className="-mt-1 grid grid-cols-4 gap-2">
          {[1_000, 5_000, 10_000, 20_000].map((preset) => (
            <button key={preset} type="button" disabled={initialBalanceLocked} onClick={() => setInitialValue(String(preset))} className={`rounded-xl border py-2 text-sm font-bold ${nextInitialBalance === preset ? "border-blue-400 bg-blue-400/10 text-blue-300" : "border-white/10 text-slate-400"} disabled:opacity-40`}>
              {money(preset)}
            </button>
          ))}
        </div>
        {isPoker && <>
          <div className="mt-5 border-t border-white/10 pt-5">
            <p className="text-sm font-bold text-slate-200">牌局规则</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">每位玩家每轮累计有效下注的最高金额；下注、加注和跟注合计不能超过此上限，底注不计入。</p>
          </div>
          <div className="mt-4">
            <Input label="单轮下注上限" value={maxValue} onChange={setMaxValue} placeholder="200" numeric disabled={maxSingleBetLocked} />
          </div>
          <div className="-mt-1 grid grid-cols-3 gap-2">
            {[100, 200, 500].map((preset) => (
              <button key={preset} type="button" disabled={maxSingleBetLocked} onClick={() => setMaxValue(String(preset))} className={`rounded-xl border py-2 text-sm font-bold ${nextMaxSingleBet === preset ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-white/10 text-slate-400"} disabled:opacity-40`}>
                {money(preset)}
              </button>
            ))}
          </div>
          <div className="mt-5 border-t border-white/10 pt-5">
            <p className="text-sm font-bold text-slate-200">开局底注</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">每手开局时，所有本局上桌且准备的玩家会自动投入底池；不计入第一轮下注。</p>
          </div>
          <div className="mt-4">
            <Input label="每位玩家底注" value={anteValue} onChange={setAnteValue} placeholder="10" numeric disabled={anteLocked} />
          </div>
          <div className="-mt-1 grid grid-cols-3 gap-2">
            {[5, 10, 20].map((preset) => (
              <button key={preset} type="button" disabled={anteLocked} onClick={() => setAnteValue(String(preset))} className={`rounded-xl border py-2 text-sm font-bold ${nextAnte === preset ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-white/10 text-slate-400"} disabled:opacity-40`}>
                {money(preset)}
              </button>
            ))}
          </div>
        </>}
      </section>
      {initialBalanceLocked && <p className="mt-3 text-xs text-amber-300">已有转账或已开局，起始金额已锁定。</p>}
      {maxSingleBetLocked && <p className="mt-3 text-xs text-amber-300">牌局进行中，结算后才能修改下注上限。</p>}
      {anteLocked && <p className="mt-3 text-xs text-amber-300">牌局进行中，结算后才能修改底注。</p>}
      {invalidInitialBalance && !initialBalanceLocked && <p className="mt-3 text-xs text-red-300">请输入 ¥100–¥1,000,000 的整数。</p>}
      {invalidMaxSingleBet && !maxSingleBetLocked && <p className="mt-3 text-xs text-red-300">请输入 ¥10–¥10,000 的整数。</p>}
      {invalidAnte && !anteLocked && <p className="mt-3 text-xs text-red-300">请输入不高于起始筹码的 ¥1–¥10,000 整数。</p>}
      <button
        disabled={invalidInitialBalance || invalidMaxSingleBet || invalidAnte || unchanged}
        onClick={() => onSubmit({ initialBalance: nextInitialBalance, ...(isPoker ? { maxSingleBet: nextMaxSingleBet, ante: nextAnte } : {}) })}
        className="mt-5 w-full rounded-2xl py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 font-black disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
      >
        保存设置
      </button>
    </ModalFrame>
  );
}

function TransferModal({
  players,
  initialTo,
  onClose,
  onSubmit,
}: {
  players: Player[];
  initialTo?: string;
  onClose: () => void;
  onSubmit: (to: string, amount: number) => void;
}) {
  const [to, setTo] = useState(initialTo ?? "");
  const [amount, setAmount] = useState("");
  return (
    <ModalFrame title="转账" onClose={onClose}>
      <p className="text-sm text-slate-400 mb-3">转给谁？</p>
      <div className="grid grid-cols-3 gap-2 mb-5">
        {players.map((player) => (
          <button
            key={player.id}
            onClick={() => setTo(player.id)}
            className={`rounded-xl py-3 text-sm font-bold border ${to === player.id ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-white/10 text-slate-400"}`}
          >
            {player.displayName}
          </button>
        ))}
      </div>
      <Input
        label="金额"
        value={amount}
        onChange={setAmount}
        placeholder="0"
        numeric
      />
      <button
        disabled={!to || !amount}
        onClick={() => onSubmit(to, Number(amount))}
        className="w-full rounded-2xl py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 font-black disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
      >
        确认记账
      </button>
    </ModalFrame>
  );
}

function SettlementModal({
  players,
  pot,
  onClose,
  onSubmit,
}: {
  players: Player[];
  pot: number;
  onClose: () => void;
  onSubmit: (ids: string[]) => void;
}) {
  const [winners, setWinners] = useState<string[]>([]);
  const toggle = (id: string) =>
    setWinners((old) =>
      old.includes(id) ? old.filter((item) => item !== id) : [...old, id],
    );
  return (
    <ModalFrame title="选择赢家" onClose={onClose}>
      <p className="text-sm text-slate-400 mb-3">
        底池 {money(pot)} 将平分给选中的赢家。
      </p>
      <div className="space-y-2 mb-5">
        {players.map((player) => (
          <button
            key={player.id}
            onClick={() => toggle(player.id)}
            className={`w-full flex justify-between rounded-xl p-3 border ${winners.includes(player.id) ? "border-amber-400 bg-amber-400/10 text-amber-200" : "border-white/10 text-slate-400"}`}
          >
            <span>{player.displayName}</span>
            {winners.includes(player.id) && <Check size={18} />}
          </button>
        ))}
      </div>
      <button
        disabled={!winners.length || pot % winners.length !== 0}
        onClick={() => onSubmit(winners)}
        className="w-full rounded-2xl py-4 bg-gradient-to-r from-amber-500 to-orange-600 font-black disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
      >
        确认结算
      </button>
      {winners.length > 0 && pot % winners.length !== 0 && (
        <p className="text-xs text-red-300 mt-3">
          底池无法整除，请调整赢家人数。
        </p>
      )}
    </ModalFrame>
  );
}
function HistoryModal({
  events,
  players,
  onClose,
}: {
  events: LedgerEvent[];
  players: Player[];
  onClose: () => void;
}) {
  return (
    <ModalFrame title="完整账本" onClose={onClose}>
      <div className="max-h-[65vh] overflow-y-auto space-y-2">
        {events.map((event) => (
          <EventRow key={event.id} event={event} players={players} />
        ))}
      </div>
    </ModalFrame>
  );
}
function ShareModal({
  db,
  ownerId,
  currentPlayerId,
  roomId,
  roomName,
  inviteUrl,
  inviteToken,
  isOwner,
  players,
  onCopy,
  onClose,
}: {
  db: Firestore;
  ownerId: string;
  currentPlayerId: string;
  roomId: string;
  roomName: string;
  inviteUrl: string;
  inviteToken: string;
  isOwner: boolean;
  players: Player[];
  onCopy: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [count, setCount] = useState(5);
  const [qrCard, setQrCard] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkCopied, setBulkCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RoomInvite | null>(null);
  const load = () => listRoomInvites(db, roomId).then(setInvites);
  useEffect(() => {
    load().catch(() => setError("读取邀请信息失败，请稍后重试。"));
  }, [db, roomId]);
  useEffect(() => {
    if (!qrCard) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setQrCard(null); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [qrCard]);
  const ownInvite = { id: inviteToken, playerId: currentPlayerId, displayName: players.find((item) => item.id === currentPlayerId)?.displayName ?? "我的身份", role: isOwner ? "OWNER" : "PLAYER", joinedAt: null, createdAt: null } as RoomInvite;
  const ownerInvite = invites.find((invite) => invite.role === "OWNER") ?? (isOwner ? ownInvite : null);
  const guestInvites = isOwner ? invites.filter((invite) => invite.role !== "OWNER") : [ownInvite];
  const remaining = Math.max(0, 12 - invites.length);
  const requestedCount = Math.min(count, Math.max(1, remaining));
  const inviteUrlFor = (invite: RoomInvite) =>
    invite.id === inviteToken ? inviteUrl : buildRoomLink(roomId, invite.id);
  const inviteNameFor = (invite: RoomInvite) =>
    players.find((item) => item.id === invite.playerId)?.displayName ?? invite.displayName;
  const copyAllGuestInvites = async () => {
    if (!guestInvites.length) return;
    const lines = guestInvites.map((invite) => `${inviteNameFor(invite)}：${inviteUrlFor(invite)}`);
    const content = `${roomName} · 专属邀请\n请任选一条链接加入，进房间后可改名。\n\n${lines.join("\n")}`;
    try {
      await navigator.clipboard.writeText(content);
      setBulkCopied(true);
      setTimeout(() => setBulkCopied(false), 2200);
    } catch {
      setError("无法复制邀请信息，请允许浏览器使用剪贴板后重试。");
    }
  };
  const inviteRow = (invite: RoomInvite) => {
    const player = players.find((item) => item.id === invite.playerId);
    const displayName = inviteNameFor(invite);
    const url = inviteUrlFor(invite);
    return <div key={invite.id} className="rounded-xl border border-white/10 bg-white/5 px-3 py-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-bold">{displayName}{invite.role === "OWNER" ? "（房主）" : ""}</p><p className="mt-0.5 text-[10px] text-slate-500">{player || invite.joinedAt ? "已加入" : "待加入"}</p></div><div className="flex shrink-0 gap-1"><button type="button" onClick={() => onCopy(url)} className="grid h-9 w-9 place-items-center rounded-lg bg-blue-600 text-white" aria-label={`复制${displayName}的链接`}><Copy size={15} /></button><button type="button" onClick={() => setQrCard({ url, name: displayName })} className="grid h-9 w-9 place-items-center rounded-lg border border-blue-400/30 text-blue-300" aria-label={`显示${displayName}的二维码`}><QrCodeIcon size={17} /></button>{isOwner && invite.role !== "OWNER" && <button type="button" onClick={() => setRenameTarget(invite)} className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-slate-300" aria-label={`修改${displayName}的名字`}><Pencil size={15} /></button>}{isOwner && invite.role !== "OWNER" && !player && !invite.joinedAt && <button type="button" onClick={async () => { try { await revokeQuickInvite(db, roomId, ownerId, invite.id); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "撤销失败。"); } }} className="grid h-9 w-9 place-items-center rounded-lg border border-red-400/20 text-red-300" aria-label={`撤销${displayName}的邀请`}><X size={15} /></button>}</div></div></div>;
  };
  return (
    <ModalFrame title={isOwner ? "邀请朋友" : "专属链接"} onClose={onClose}>
      <p className="mb-4 text-sm leading-6 text-slate-400">一条链接代表一个玩家身份，可跨浏览器和设备使用。请把不同链接分别发给朋友。</p>
      {ownerInvite && <section className="mb-4"><p className="mb-2 text-xs font-bold text-slate-500">房主入口</p>{inviteRow(ownerInvite)}</section>}
      {isOwner && <section className="mb-4 rounded-2xl border border-white/10 bg-black/15 p-3"><div className="mb-2 flex items-center justify-between"><p className="text-xs font-bold text-slate-400">本次新增牌友</p><span className="text-[10px] text-slate-500">还可生成 {remaining} 个</span></div>{remaining > 0 ? <div className="flex items-center gap-3"><div className="flex h-11 flex-1 items-center justify-between rounded-xl border border-white/10 bg-white/5 px-1"><button type="button" onClick={() => setCount((value) => Math.max(1, value - 1))} disabled={requestedCount <= 1} className="grid h-9 w-9 place-items-center rounded-lg text-slate-300 disabled:opacity-25" aria-label="减少一个牌友"><Minus size={17} /></button><strong className="text-lg tabular-nums">{requestedCount}</strong><button type="button" onClick={() => setCount((value) => Math.min(remaining, value + 1))} disabled={requestedCount >= remaining} className="grid h-9 w-9 place-items-center rounded-lg text-slate-300 disabled:opacity-25" aria-label="增加一个牌友"><Plus size={17} /></button></div><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await createQuickInvites(db, roomId, ownerId, requestedCount, playerNamePresets); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "生成失败，请重试。"); } finally { setBusy(false); } }} className="h-11 rounded-xl bg-blue-600 px-5 text-sm font-black text-white disabled:opacity-50">{busy ? "生成中…" : `生成 ${requestedCount} 个`}</button></div> : <p className="py-2 text-center text-xs text-slate-500">12 个玩家身份已经全部生成。</p>}</section>}
      {!!guestInvites.length && <div className="mb-2 flex items-center justify-between gap-3"><p className="text-xs font-bold text-slate-500">{isOwner ? `牌友邀请（${guestInvites.length}）` : "我的入口"}</p>{isOwner && <button type="button" onClick={copyAllGuestInvites} className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold active:scale-95 ${bulkCopied ? "bg-green-500/15 text-green-300" : "bg-blue-600 text-white"}`}><Copy size={13} />{bulkCopied ? "已复制全部" : "一键复制邀请"}</button>}</div>}
      <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
        {guestInvites.map(inviteRow)}
      </div>
      {!guestInvites.length && !error && <p className="py-5 text-center text-sm text-slate-500">选择数量后生成牌友链接。</p>}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <p className="mt-3 text-center text-xs text-slate-500">{roomName} · 房号 {roomId}</p>
      {renameTarget && <RenamePlayerModal
        title={`修改${inviteNameFor(renameTarget)}的名字`}
        description="仅修改显示名称；专属链接和玩家身份不会改变。"
        currentName={inviteNameFor(renameTarget)}
        onClose={() => setRenameTarget(null)}
        onSubmit={async (name) => {
          await renameRoomPlayer(db, roomId, ownerId, renameTarget.playerId, name);
          await load();
          setRenameTarget(null);
        }}
      />}
      {qrCard && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onClick={() => setQrCard(null)} role="presentation"><section className="relative w-full max-w-xs rounded-3xl bg-white p-6 text-center text-slate-900 shadow-2xl" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${qrCard.name}的专属二维码`}><button type="button" onClick={() => setQrCard(null)} className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-500" aria-label="关闭二维码"><X size={18} /></button><p className="mb-1 pr-8 text-left text-lg font-black">{qrCard.name}</p><p className="mb-5 text-left text-xs text-slate-500">专属加入二维码</p><div className="flex justify-center"><QRCode value={qrCard.url} size={220} /></div></section></div>}
    </ModalFrame>
  );
}

function RenamePlayerModal({ currentName, onClose, onSubmit, title = "修改我的名字", description = "名字可以修改，专属链接代表的玩家身份不会改变。" }: {
  currentName: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
  title?: string;
  description?: string;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <ModalFrame title={title} onClose={onClose}>
    <p className="mb-4 text-xs leading-5 text-slate-400">{description}</p>
    <Input label="玩家名" value={name} onChange={setName} placeholder="请输入新名字" />
    {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
    <button type="button" disabled={busy || !name.trim() || name.trim() === currentName} onClick={async () => { setBusy(true); setError(null); try { await onSubmit(name); } catch (reason) { setError(reason instanceof Error ? reason.message : "改名失败，请重试。"); } finally { setBusy(false); } }} className="w-full rounded-2xl bg-blue-600 py-4 font-black text-white disabled:opacity-40">{busy ? "保存中…" : "保存名字"}</button>
  </ModalFrame>;
}

function DestroyRoomModal({
  roomName,
  onClose,
  onSubmit,
}: {
  roomName: string;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destroy = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "销毁失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame title="销毁房间" onClose={onClose}>
      <div className="rounded-2xl border border-red-400/20 bg-red-500/10 p-4 text-sm leading-6 text-red-200">
        <p className="font-bold">此操作不可恢复</p>
        <p>“{roomName}”的玩家与全部流水都会被删除，所有成员将退出房间。</p>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button
        disabled={busy}
        onClick={destroy}
        className="mt-5 w-full rounded-2xl py-4 bg-red-500 font-black text-white disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-700 disabled:text-slate-500"
      >
        {busy ? "正在销毁…" : "确认销毁房间"}
      </button>
    </ModalFrame>
  );
}


function LeaveRoomModal({
  roomName,
  isInHand,
  onClose,
  onSubmit,
}: {
  roomName: string;
  isInHand: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame title="离开房间" onClose={onClose} centered>
      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-slate-300">
        <p>离开“{roomName}”只会返回首页，不会退出玩家身份或改变房间状态。</p>
        <p className="mt-1 text-slate-500">
          首页会保留临时入口，之后可以直接返回。
          {isInHand ? " 当前牌局仍会保持原状态。" : ""}
        </p>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button
        disabled={busy}
        onClick={leave}
        className="mt-5 w-full rounded-2xl py-3.5 bg-slate-100 font-black text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
      >
        {busy ? "正在离开…" : "确认离开房间"}
      </button>
    </ModalFrame>
  );
}

function BetModeConfirmModal({
  target,
  onClose,
  onSubmit,
}: {
  target: "BLIND" | "NORMAL";
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const enabling = target === "BLIND";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-5">
      <section className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#1e293b] p-5 text-slate-100 shadow-2xl">
        <p className={`text-lg font-black ${enabling ? "text-violet-200" : "text-slate-100"}`}>{enabling ? "开启盲注？" : "取消盲注？"}</p>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          {enabling
            ? "本轮下注将按双倍金额计算。仅第一轮可开启；取消后本局不能再次开启。"
            : "将切换为正常下注。此操作后，本局不能再次开启盲注。"}
        </p>
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button disabled={busy} onClick={onClose} className="rounded-2xl bg-white/5 py-3 font-bold text-slate-300 disabled:opacity-50">暂不切换</button>
          <button disabled={busy} onClick={confirm} className={`rounded-2xl py-3 font-black disabled:bg-slate-700 disabled:text-slate-500 ${enabling ? "bg-violet-400 text-slate-950" : "bg-slate-100 text-slate-900"}`}>{busy ? "正在切换…" : "确认切换"}</button>
        </div>
      </section>
    </div>
  );
}

function ForceOffTableModal({
  playerName,
  isInHand,
  onClose,
  onSubmit,
}: {
  playerName: string;
  isInHand: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame title="请玩家下桌" onClose={onClose}>
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm leading-6 text-slate-200">
        <p>
          请 <strong className="text-amber-300">{playerName}</strong> 下桌？
        </p>
        <p className="mt-1 text-slate-400">
          {isInHand ? "该玩家会立即弃牌，并从下一局起不再上桌。" : "该玩家不会再占用牌桌位置。"}
        </p>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button onClick={onClose} className="rounded-2xl bg-white/5 py-3 font-bold text-slate-300">
          取消
        </button>
        <button disabled={busy} onClick={submit} className="rounded-2xl bg-amber-400 py-3 font-black text-slate-900 disabled:bg-slate-700 disabled:text-slate-500">
          {busy ? "处理中…" : "确认下桌"}
        </button>
      </div>
    </ModalFrame>
  );
}

function ForceRemovePlayerModal({
  playerName,
  isInHand,
  onClose,
  onSubmit,
}: {
  playerName: string;
  isInHand: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame title="请玩家离开" onClose={onClose}>
      <div className="rounded-2xl border border-red-400/20 bg-red-500/10 p-4 text-sm leading-6 text-slate-200">
        <p>确认请 <strong className="text-red-300">{playerName}</strong> 离开房间？</p>
        <p className="mt-1 text-slate-400">
          {isInHand ? "该玩家会立即退出本局。" : "该玩家将不再占用房间人数。"}
          其专属链接会失效，需要再次加入时请重新生成链接。
        </p>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button disabled={busy} onClick={onClose} className="rounded-2xl bg-white/5 py-3 font-bold text-slate-300 disabled:opacity-50">取消</button>
        <button disabled={busy} onClick={submit} className="rounded-2xl bg-red-500 py-3 font-black text-white disabled:bg-slate-700 disabled:text-slate-500">
          {busy ? "处理中…" : "确认请离"}
        </button>
      </div>
    </ModalFrame>
  );
}
