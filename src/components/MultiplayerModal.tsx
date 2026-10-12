import React, { useState, useEffect, useRef } from 'react';
import {
  db,
  auth,
  RoomRecord,
  handleFirestoreError,
  OperationType
} from '../firebase';
import {
  doc,
  setDoc,
  runTransaction,
  collection,
  query,
  where,
  getDocsFromServer,
  onSnapshot
} from 'firebase/firestore';
import {
  Users,
  Copy,
  Check,
  Play,
  RotateCw,
  X,
  Radio,
  ArrowRight,
  ShieldAlert,
  Sparkles
} from 'lucide-react';
import { sound } from '../services/sound';

interface MultiplayerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartOnlineMatch: (mode: 'online_host' | 'online_guest', room: RoomRecord) => void;
}

export const MultiplayerModal: React.FC<MultiplayerModalProps> = ({
  isOpen,
  onClose,
  onStartOnlineMatch
}) => {
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [hostRoomId, setHostRoomId] = useState<string | null>(null);
  const [isWaitingForGuest, setIsWaitingForGuest] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const roomListenerRef = useRef<(() => void) | null>(null);

  const WAITING_ROOM_TIMEOUT_MS = 10 * 60 * 1000;

  const generateNewRoomCode = () => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    setGeneratedCode(code);
    return code;
  };

  useEffect(() => {
    if (isOpen && tab === 'create') {
      generateNewRoomCode();
    }
  }, [isOpen, tab]);

  const abandonWaitingRoom = async () => {
    if (!hostRoomId || !isWaitingForGuest) return;

    await runTransaction(db, async transaction => {
      const roomRef = doc(db, 'rooms', hostRoomId);
      const roomSnap = await transaction.get(roomRef);
      if (roomSnap.exists() && roomSnap.data().status === 'waiting') {
        transaction.update(roomRef, {
          status: 'abandoned',
          updatedAt: new Date().toISOString()
        });
      }
    });
    roomListenerRef.current?.();
    roomListenerRef.current = null;
    setHostRoomId(null);
    setIsWaitingForGuest(false);
  };

  const handleClose = async () => {
    try {
      await abandonWaitingRoom();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Could not close the waiting room: ${msg}`);
    }
  };

  const handleTabChange = async (nextTab: 'create' | 'join') => {
    try {
      await abandonWaitingRoom();
      setTab(nextTab);
      setErrorMessage('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Could not close the waiting room: ${msg}`);
    }
  };

  // Handle Host creating room in Firestore
  const handleCreateRoom = async () => {
    sound.playClick();
    setErrorMessage('');
    setIsWaitingForGuest(true);

    const code = generatedCode || generateNewRoomCode();
    const roomId = `room_${code}_${Date.now()}`;
    const user = auth.currentUser;
    const hostId = user?.uid || `guest_host_${Math.random().toString(36).substring(2, 7)}`;
    const hostName = user?.displayName || 'Player 1 (Host)';

    const roomPayload: RoomRecord = {
      id: roomId,
      roomCode: code,
      title: `Air Hockey Match #${code}`,
      hostId,
      hostName,
      status: 'waiting',
      hostScore: 0,
      guestScore: 0,
      winningScore: 7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      await setDoc(doc(db, 'rooms', roomId), roomPayload);
      setHostRoomId(roomId);

      // Listen for guest joining
      const unsub = onSnapshot(doc(db, 'rooms', roomId), docSnap => {
        if (docSnap.exists()) {
          const roomData = docSnap.data() as RoomRecord;
          if (roomData.status === 'playing' && roomData.guestId) {
            unsub();
            roomListenerRef.current = null;
            setIsWaitingForGuest(false);
            setHostRoomId(null);
            sound.playWhistle();
            onStartOnlineMatch('online_host', roomData);
            onClose();
          }
        }
      }, err => {
        roomListenerRef.current?.();
        roomListenerRef.current = null;
        setIsWaitingForGuest(false);
        setErrorMessage(`Room connection lost: ${err.message}`);
      });
      roomListenerRef.current = unsub;
    } catch (err: unknown) {
      setIsWaitingForGuest(false);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Failed to create room in Firebase: ${msg}`);
      handleFirestoreError(err, OperationType.CREATE, `rooms/${roomId}`);
    }
  };

  // Handle Guest joining room via 6-digit code
  const handleJoinRoom = async () => {
    sound.playClick();
    setErrorMessage('');
    const code = inputCode.trim();

    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setErrorMessage('Please enter a valid 6-digit numeric room code');
      return;
    }

    setIsJoining(true);
    const user = auth.currentUser;
    const guestId = user?.uid || `guest_player_${Math.random().toString(36).substring(2, 7)}`;
    const guestName = user?.displayName || 'Player 2 (Challenger)';

    try {
      const q = query(collection(db, 'rooms'), where('roomCode', '==', code));
      const querySnap = await getDocsFromServer(q);

      if (querySnap.empty) {
        setIsJoining(false);
        setErrorMessage(`No waiting match found with 6-digit code "${code}". Check code or ask host.`);
        return;
      }

      let joinedRoom: RoomRecord | null = null;
      let hadWaitingRoom = false;

      for (const roomDoc of querySnap.docs) {
        const roomRef = doc(db, 'rooms', roomDoc.id);
        const roomData = await runTransaction(db, async transaction => {
          const currentSnap = await transaction.get(roomRef);
          if (!currentSnap.exists()) return null;

          const currentRoom = currentSnap.data() as RoomRecord;
          if (currentRoom.roomCode !== code || currentRoom.status !== 'waiting') return null;
          hadWaitingRoom = true;

          const createdAt = Date.parse(currentRoom.createdAt);
          if (!Number.isFinite(createdAt) || Date.now() - createdAt > WAITING_ROOM_TIMEOUT_MS) {
            return null;
          }

          transaction.update(roomRef, {
            guestId,
            guestName,
            status: 'playing',
            updatedAt: new Date().toISOString()
          });
          return { ...currentRoom, guestId, guestName, status: 'playing' as const };
        });

        if (roomData) {
          joinedRoom = roomData;
          break;
        }
      }

      if (!joinedRoom) {
        setIsJoining(false);
        setErrorMessage(
          hadWaitingRoom
            ? 'That room has expired or another player just joined. Ask the host to create a new match code.'
            : 'That code is no longer waiting for a player. Ask the host to create a new match code.'
        );
        return;
      }

      setIsJoining(false);
      sound.playWhistle();
      onStartOnlineMatch('online_guest', joinedRoom);
      onClose();

    } catch (err: unknown) {
      setIsJoining(false);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Join error: ${msg}`);
      handleFirestoreError(err, OperationType.GET, 'rooms');
    }
  };

  const copyCode = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    sound.playClick();
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in">
      <div className="relative w-full max-w-lg bg-slate-900 border border-cyan-500/40 rounded-2xl shadow-2xl shadow-cyan-950/70 overflow-hidden text-slate-100">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-500/20 bg-slate-950/90">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white tracking-tight">1v1 Online Multiplayer</h3>
              <p className="text-xs text-slate-400">Connect in real-time using a 6-digit match code</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex border-b border-slate-800 bg-slate-950/50">
          <button
            onClick={() => handleTabChange('create')}
            className={`flex-1 py-3 text-sm font-semibold transition border-b-2 ${
              tab === 'create'
                ? 'border-cyan-400 text-cyan-400 bg-cyan-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Host Match (Create Code)
          </button>
          <button
            onClick={() => handleTabChange('join')}
            className={`flex-1 py-3 text-sm font-semibold transition border-b-2 ${
              tab === 'join'
                ? 'border-cyan-400 text-cyan-400 bg-cyan-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Join Match (Enter Code)
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {errorMessage && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {tab === 'create' ? (
            <div className="text-center space-y-5">
              <div>
                <span className="text-xs font-mono uppercase text-cyan-400/80 tracking-wider">
                  Your 6-Digit Room Code
                </span>
                <div className="my-3 flex items-center justify-center gap-3">
                  <div className="px-6 py-3 rounded-2xl bg-slate-950 border-2 border-cyan-500/40 shadow-inner tracking-[0.35em] text-3xl md:text-4xl font-mono font-black text-cyan-300">
                    {generatedCode}
                  </div>
                  <button
                    onClick={copyCode}
                    className="p-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                    title="Copy Code"
                  >
                    {copied ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5" />}
                  </button>
                </div>
                <p className="text-xs text-slate-400">
                  Share this code with your friend. When they enter it, the match starts automatically!
                </p>
              </div>

              {isWaitingForGuest ? (
                <div className="p-4 rounded-xl bg-cyan-950/30 border border-cyan-500/30 flex items-center justify-center gap-3 text-cyan-300 text-sm">
                  <RotateCw className="w-5 h-5 animate-spin" />
                  <span>Waiting for player to connect with code <strong className="font-mono">{generatedCode}</strong>...</span>
                </div>
              ) : (
                <button
                  onClick={handleCreateRoom}
                  className="w-full py-3.5 px-6 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 shadow-lg shadow-cyan-500/25 active:scale-95 transition flex items-center justify-center gap-2"
                >
                  <Radio className="w-4 h-4" />
                  Create Online Match
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-mono uppercase text-slate-400 mb-2">
                  Enter 6-Digit Match Code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={inputCode}
                  onChange={e => setInputCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 583921"
                  className="w-full py-3.5 px-4 text-center tracking-[0.3em] font-mono font-bold text-2xl rounded-xl bg-slate-950 border border-slate-700 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 text-white placeholder:text-slate-600 outline-none transition"
                />
              </div>

              <button
                disabled={inputCode.length !== 6 || isJoining}
                onClick={handleJoinRoom}
                className="w-full py-3.5 px-6 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 shadow-lg shadow-cyan-500/25 active:scale-95 transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isJoining ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" />
                    Connecting to Match...
                  </>
                ) : (
                  <>
                    <ArrowRight className="w-4 h-4" />
                    Join 1v1 Room
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-950 border-t border-slate-800 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Synced via Google Firebase Cloud Firestore</span>
          <span className="flex items-center gap-1 text-emerald-400">
            <Radio className="w-3 h-3 animate-ping" /> Real-time active
          </span>
        </div>

      </div>
    </div>
  );
};
