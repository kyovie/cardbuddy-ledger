import { useEffect, useState } from 'react';
import type { RoomState, Session } from '../types';
import { db, ensureAnonymousSession, watchSession } from './firebase';
import { getRoomSession, redeemQuickInvite, subscribeRoom } from './roomService';

const emptyRoomState: RoomState = {
  room: null, players: [], events: [], isLoading: true, isSynced: false, hasPendingWrites: false, error: null,
  streamHealth: {
    roomAt: null, roomFromCache: null, playersAt: null, playersFromCache: null, eventsAt: null, eventsFromCache: null,
  },
};

export function useAnonymousSession(): Session {
  const [session, setSession] = useState<Session>({ uid: '', isReady: false, error: null });
  useEffect(() => {
    let active = true;
    let anonymousAttempted = false;
    const unsubscribe = watchSession((user) => {
      if (!active) return;
      if (user) {
        setSession({
          uid: user.uid,
          isReady: true,
          error: null,
        });
        return;
      }
      if (anonymousAttempted) return;
      anonymousAttempted = true;
      ensureAnonymousSession().catch(() => {
        if (active) setSession({ uid: '', isReady: true, error: '无法建立临时身份，请检查 Firebase Auth 是否已启用匿名登录。' });
      });
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  return session;
}

export function useRoom(roomId: string | null, enabled: boolean) {
  const [state, setState] = useState<RoomState>(emptyRoomState);
  const [connectionEpoch, setConnectionEpoch] = useState(0);

  useEffect(() => {
    if (!roomId || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reconnect = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setConnectionEpoch((value) => value + 1), 250);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconnect();
    };
    const onPageShow = () => reconnect();
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', reconnect);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('focus', reconnect);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [roomId, enabled]);

  useEffect(() => {
    if (!db || !roomId || !enabled) {
      setState({ ...emptyRoomState, isLoading: false });
      return;
    }
    setState(emptyRoomState);
    return subscribeRoom(db, roomId, (change) => setState((previous) => ({ ...previous, ...change })));
  }, [roomId, enabled, connectionEpoch]);
  return state;
}

export function useRoomIdentity(roomId: string | null, inviteToken: string | null, authUid: string, enabled: boolean) {
  const [state, setState] = useState<{ playerId: string | null; isLoading: boolean; error: string | null }>({
    playerId: null, isLoading: Boolean(roomId), error: null,
  });
  useEffect(() => {
    if (!db || !roomId || !authUid || !enabled) {
      setState({ playerId: null, isLoading: false, error: null });
      return;
    }
    let active = true;
    setState({ playerId: null, isLoading: true, error: null });
    const resolve = inviteToken
      ? redeemQuickInvite(db, roomId, authUid, inviteToken)
      : getRoomSession(db, roomId, authUid).then((playerId) => {
          if (!playerId) throw new Error('邀请链接不完整，请使用房主分享的专属链接。');
          return playerId;
        });
    resolve.then((playerId) => {
      if (active) setState({ playerId, isLoading: false, error: null });
    }).catch((reason) => {
      if (active) setState({ playerId: null, isLoading: false, error: reason instanceof Error ? reason.message : '专属邀请无效。' });
    });
    return () => { active = false; };
  }, [roomId, inviteToken, authUid, enabled]);
  return state;
}
