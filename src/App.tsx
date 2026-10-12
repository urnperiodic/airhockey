/**
 * Neon Air Hockey 3D - Main Application
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  AirHockey3D,
  GameMode,
  BotDifficulty,
  CameraView
} from './components/AirHockey3D';
import { FirebaseTester } from './components/FirebaseTester';
import { MultiplayerModal } from './components/MultiplayerModal';
import { sound } from './services/sound';
import {
  auth,
  db,
  testConnection,
  RoomRecord,
  loginWithGoogle,
  logoutUser
} from './firebase';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc
} from 'firebase/firestore';
import {
  Volume2,
  VolumeX,
  Database,
  Bot,
  Eye,
  Camera,
  Play,
  Share2,
  Check,
  Radio,
  LogIn,
  LogOut,
  Sparkles,
  Zap,
  RotateCcw,
  Maximize,
  Minimize,
  ChevronDown,
  Menu,
  X,
  Sliders,
  Users
} from 'lucide-react';

export default function App() {
  // Game Configuration State
  const [mode, setMode] = useState<GameMode>('bot');
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('pro');
  const [cameraView, setCameraView] = useState<CameraView>('fpv');
  const [winningScore, setWinningScore] = useState(10);
  const [allowOwnGoals, setAllowOwnGoals] = useState(true);
  const [helpDisabled, setHelpDisabled] = useState(false);
  const [playerScore, setPlayerScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [mouseSensitivity, setMouseSensitivity] = useState<number>(2.5);
  const [isMuted, setIsMuted] = useState(sound.isMuted());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
        setIsFullscreen(false);
      }
    }
  };

  const cycleCameraView = () => {
    const views: CameraView[] = ['fpv', 'top', 'action', 'classic'];
    setCameraView(current => views[(views.indexOf(current) + 1) % views.length]);
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    const views: CameraView[] = ['fpv', 'top', 'action', 'classic'];
    const handlePerspectiveShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key.toLowerCase() !== 'v' ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) return;

      setCameraView(current => views[(views.indexOf(current) + 1) % views.length]);
    };

    window.addEventListener('keydown', handlePerspectiveShortcut);
    return () => window.removeEventListener('keydown', handlePerspectiveShortcut);
  }, []);

  // Online Room State
  const [onlineRoom, setOnlineRoom] = useState<RoomRecord | null>(null);
  const [gameDataChannel, setGameDataChannel] = useState<RTCDataChannel | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Modals
  const [isTesterOpen, setIsTesterOpen] = useState(false);
  const [isMultiplayerOpen, setIsMultiplayerOpen] = useState(false);

  // Firebase status indicator
  const [firebaseStatus, setFirebaseStatus] = useState<{
    connected: boolean;
    latencyMs: number;
    checking: boolean;
  }>({
    connected: false,
    latencyMs: 0,
    checking: true
  });

  // Auth state
  const [user, setUser] = useState(auth.currentUser);

  // Check Firebase connection on load
  useEffect(() => {
    const unsubAuth = auth.onAuthStateChanged(u => setUser(u));

    testConnection().then(res => {
      setFirebaseStatus({
        connected: res.success,
        latencyMs: res.latencyMs,
        checking: false
      });
    }).catch(() => {
      setFirebaseStatus({
        connected: false,
        latencyMs: 0,
        checking: false
      });
    });

    return () => unsubAuth();
  }, []);

  useEffect(() => () => gameDataChannel?.close(), [gameDataChannel]);

  // Audio Toggle
  const toggleSound = () => {
    const nextMute = !isMuted;
    sound.setMuted(nextMute);
    setIsMuted(nextMute);
    if (!nextMute) sound.playClick();
  };

  // Handle Game Over: record score to leaderboard
  const handleGameOver = async (winner: 'player' | 'opponent', scores: { player: number; opponent: number }) => {
    if (!user) return; // Only persist player stats if authenticated or registered

    const userRef = doc(db, 'leaderboard', user.uid);
    try {
      const snap = await getDoc(userRef);
      const isWin = winner === 'player';
      if (snap.exists()) {
        const cur = snap.data();
        const curStreak = isWin ? (cur.winStreak || 0) + 1 : 0;
        const highestStreak = Math.max(cur.highestStreak || 0, curStreak);
        await updateDoc(userRef, {
          wins: isWin ? (cur.wins || 0) + 1 : (cur.wins || 0),
          losses: isWin ? (cur.losses || 0) : (cur.losses || 0) + 1,
          goalsScored: (cur.goalsScored || 0) + scores.player,
          winStreak: curStreak,
          highestStreak,
          updatedAt: new Date().toISOString()
        });
      } else {
        await setDoc(userRef, {
          id: user.uid,
          userId: user.uid,
          displayName: user.displayName || 'Champion Striker',
          wins: isWin ? 1 : 0,
          losses: isWin ? 0 : 1,
          goalsScored: scores.player,
          winStreak: isWin ? 1 : 0,
          highestStreak: isWin ? 1 : 0,
          updatedAt: new Date().toISOString()
        });
      }
    } catch {
      // Ignore leaderboard stats update errors silently
    }
  };

  const handleStartOnlineMatch = (
    newMode: 'online_host' | 'online_guest',
    room: RoomRecord,
    dataChannel: RTCDataChannel
  ) => {
    gameDataChannel?.close();
    setOnlineRoom(room);
    setGameDataChannel(dataChannel);
    setMode(newMode);
  };

  const leaveOnlineRoom = () => {
    gameDataChannel?.close();
    if (onlineRoom?.id) {
      updateDoc(doc(db, 'rooms', onlineRoom.id), {
        status: 'abandoned',
        updatedAt: new Date().toISOString()
      }).catch(error => {
        console.error('Failed to mark online match as left:', error);
      });
    }
    setGameDataChannel(null);
    setOnlineRoom(null);
    setMode('bot');
  };

  const copyRoomCode = () => {
    if (!onlineRoom?.roomCode) return;
    navigator.clipboard.writeText(onlineRoom.roomCode);
    setCopiedCode(true);
    sound.playClick();
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden flex flex-col bg-slate-950 text-slate-100 font-sans select-none">
      
      {/* Top Main Navigation / Bar - Automatically hidden when Fullscreen */}
      <header className={`relative z-30 flex items-center justify-between px-3 md:px-6 py-2 bg-slate-900/95 backdrop-blur-md border-b border-cyan-500/25 transition-all duration-300 ${isFullscreen ? 'hidden' : 'flex'}`}>
        
        {/* Left: Score Section */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-950/90 border border-cyan-500/30 shadow-inner">
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold tracking-wider text-cyan-400 uppercase font-mono">YOU</span>
            <span className="text-xl font-black font-mono text-cyan-400 drop-shadow-[0_0_8px_rgba(6,182,212,0.9)]">
              {playerScore}
            </span>
          </div>
          <span className="text-slate-600 font-black text-xs">:</span>
          <div className="flex items-center gap-1">
            <span className="text-xl font-black font-mono text-rose-400 drop-shadow-[0_0_8px_rgba(244,63,94,0.9)]">
              {opponentScore}
            </span>
            <span className="text-[9px] font-bold tracking-wider text-rose-400 uppercase font-mono">
              {mode === 'bot' ? 'BOT' : mode === 'local' ? 'P2' : 'OPP'}
            </span>
          </div>
          {mode === 'bot' && (
            <button
              onClick={() => setHelpDisabled(disabled => !disabled)}
              className="ml-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-bold text-slate-200 transition hover:border-cyan-400/60 hover:text-cyan-100"
              aria-pressed={helpDisabled}
            >
              {helpDisabled ? 'Enable Help' : 'Disable Help'}
            </button>
          )}
        </div>

        {mode === 'online_host' && (
          <div className="flex items-center justify-between">
            <span className="text-slate-300 font-medium">Own-goal scoring:</span>
            <button
              onClick={() => setAllowOwnGoals(value => !value)}
              className={`px-2.5 py-1 rounded-lg border font-bold ${
                allowOwnGoals
                  ? 'bg-rose-500/10 border-rose-500/40 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
              }`}
              aria-pressed={allowOwnGoals}
            >
              {allowOwnGoals ? 'Allowed' : 'Prevented'}
            </button>
          </div>
        )}

        {/* Center/Right controls: Dropdown toggle, Fullscreen, Sound */}
        <div className="flex items-center gap-2 relative">
          
          {/* Settings / Controls Dropdown Button */}
          <div className="relative">
            <button
              onClick={() => setIsMenuOpen(prev => !prev)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition ${
                isMenuOpen
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-md shadow-cyan-500/30'
                  : 'bg-slate-950 text-cyan-300 border-cyan-500/40 hover:bg-slate-900'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Game Settings</span>
              {isMenuOpen ? <X className="w-3.5 h-3.5 ml-1" /> : <ChevronDown className="w-3.5 h-3.5 ml-1" />}
            </button>

            {/* Dropdown Panel */}
            {isMenuOpen && (
              <div className="absolute right-0 mt-2 w-80 md:w-96 p-4 rounded-2xl bg-slate-900 border border-cyan-500/40 shadow-2xl shadow-cyan-950/80 z-50 flex flex-col gap-3 text-xs animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <span className="font-bold text-cyan-400 uppercase tracking-wider font-mono">Air Hockey Controls</span>
                  <button onClick={() => setIsMenuOpen(false)} className="text-slate-400 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Target Score */}
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 font-medium">First to Score:</span>
                  <div className="flex items-center gap-1.5 font-mono">
                    <button
                      onClick={() => setWinningScore(prev => Math.max(1, prev - 1))}
                      className="w-5 h-5 flex items-center justify-center rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-bold"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={winningScore}
                      onChange={e => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val >= 1) setWinningScore(Math.min(99, val));
                      }}
                      className="w-10 py-0.5 text-center font-bold font-mono text-cyan-300 bg-slate-950 border border-cyan-500/30 rounded outline-none"
                    />
                    <button
                      onClick={() => setWinningScore(prev => Math.min(99, prev + 1))}
                      className="w-5 h-5 flex items-center justify-center rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-bold"
                    >
                      +
                    </button>
                  </div>
                </div>

                 {/* Game Mode */}
                <div className="flex flex-col gap-1">
                  <span className="text-slate-300 font-medium">Game Mode:</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      onClick={() => { setMode('bot'); setIsMenuOpen(false); }}
                      className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-medium transition text-[11px] ${
                        mode === 'bot'
                          ? 'bg-cyan-500 text-slate-950 font-bold shadow'
                          : 'bg-slate-950 text-slate-300 border border-slate-800 hover:bg-slate-800'
                      }`}
                    >
                      <Bot className="w-3.5 h-3.5" />
                      <span>vs Bot</span>
                    </button>
                    <button
                      onClick={() => { setMode('local'); setIsMenuOpen(false); }}
                      className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-medium transition text-[11px] ${
                        mode === 'local'
                          ? 'bg-cyan-500 text-slate-950 font-bold shadow'
                          : 'bg-slate-950 text-slate-300 border border-slate-800 hover:bg-slate-800'
                      }`}
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>2 Player</span>
                    </button>
                    <button
                      onClick={() => { setIsMultiplayerOpen(true); setIsMenuOpen(false); }}
                      className="flex items-center justify-center gap-1 py-1.5 rounded-lg bg-slate-950 text-slate-300 border border-slate-800 hover:bg-slate-800 font-medium text-[11px]"
                    >
                      <Radio className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Online</span>
                    </button>
                  </div>
                </div>

                {/* Bot Difficulty */}
                {mode === 'bot' && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300 font-medium">Bot Difficulty:</span>
                    <select
                      value={botDifficulty}
                      onChange={e => setBotDifficulty(e.target.value as BotDifficulty)}
                      className="py-1 px-2.5 rounded-lg bg-slate-950 border border-cyan-500/40 text-cyan-300 font-bold outline-none cursor-pointer"
                    >
                      <option value="rookie">🟢 Rookie</option>
                      <option value="pro">🔵 Pro</option>
                      <option value="master">🟡 Master</option>
                      <option value="cyber">🔴 Cyber Beast</option>
                      <option value="god">👑 God Bot</option>
                    </select>
                  </div>
                )}

                {/* Camera View */}
                <div className="flex flex-col gap-1">
                  <span className="text-slate-300 font-medium">Camera Perspective:</span>
                  <span className="text-[10px] text-slate-500">Press V to switch views</span>
                  <div className="grid grid-cols-4 gap-1">
                    {(['top', 'fpv', 'action', 'classic'] as CameraView[]).map(view => (
                      <button
                        key={view}
                        onClick={() => setCameraView(view)}
                        className={`py-1 rounded-lg text-center font-medium uppercase text-[10px] transition ${
                          cameraView === view
                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold'
                            : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                        }`}
                      >
                        {view}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Mouse Sensitivity */}
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 font-medium">Mallet Mouse Sensitivity:</span>
                  <select
                    value={mouseSensitivity}
                    onChange={e => setMouseSensitivity(parseFloat(e.target.value))}
                    className="py-1 px-2.5 rounded-lg bg-slate-950 border border-slate-800 text-cyan-300 font-bold outline-none cursor-pointer font-mono"
                  >
                    <option value="1.8">1.8x (Slow)</option>
                    <option value="2.5">2.5x (Normal)</option>
                    <option value="3.2">3.2x (Fast)</option>
                  </select>
                </div>

                {onlineRoom && (
                  <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                    <span className="text-cyan-400 font-mono">Room: {onlineRoom.roomCode}</span>
                    <button
                      onClick={leaveOnlineRoom}
                      className="px-2 py-1 rounded bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 text-[11px]"
                    >
                      Leave Room
                    </button>
                  </div>
                )}

              </div>
            )}
          </div>

          {/* Quick perspective switch */}
          <button
            onClick={cycleCameraView}
            className="p-2 rounded-xl bg-slate-950 hover:bg-slate-900 text-cyan-300 border border-cyan-500/30 transition flex items-center gap-1.5"
            title={`Switch perspective (V). Current: ${cameraView}`}
            aria-label={`Switch camera perspective, current view ${cameraView}`}
          >
            <Camera className="w-4 h-4" />
            <span className="hidden sm:inline text-[10px] uppercase">{cameraView}</span>
          </button>

          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-xl bg-slate-950 hover:bg-slate-900 text-cyan-300 border border-cyan-500/30 transition flex items-center gap-1"
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>

          {/* Sound Toggle */}
          <button
            onClick={toggleSound}
            className="p-2 rounded-xl bg-slate-950 hover:bg-slate-900 text-cyan-300 border border-cyan-500/30 transition"
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
          </button>

        </div>

      </header>

      {/* When in fullscreen, show a floating minimal exit fullscreen / score badge in the top corner */}
      {isFullscreen && (
        <div className="absolute top-3 left-3 z-40 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/80 backdrop-blur-md border border-cyan-500/40 shadow-xl pointer-events-auto">
          <div className="flex items-center gap-1.5 text-xs font-mono">
            <span className="text-cyan-400 font-bold">{playerScore}</span>
            <span className="text-slate-500">:</span>
            <span className="text-rose-400 font-bold">{opponentScore}</span>
          </div>
          <button
            onClick={toggleFullscreen}
            className="ml-2 px-2 py-1 rounded-lg bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 transition flex items-center gap-1"
            title="Exit Fullscreen"
          >
            <Minimize className="w-3.5 h-3.5" />
            <span>Exit FS</span>
          </button>
        </div>
      )}

      {/* 3D First-Person Air Hockey Table Area */}
      <main className="relative flex-1 w-full h-full">
        <AirHockey3D
          mode={mode}
          botDifficulty={botDifficulty}
          winningScore={winningScore}
          allowOwnGoals={allowOwnGoals}
          cameraView={cameraView}
          mouseSensitivityMultiplier={mouseSensitivity}
          helpDisabled={helpDisabled}
          roomCode={onlineRoom?.roomCode}
          onlineRoom={onlineRoom}
          gameDataChannel={gameDataChannel}
          onScoreUpdate={scores => {
            setPlayerScore(scores.player);
            setOpponentScore(scores.opponent);
          }}
          onGameOver={handleGameOver}
        />
      </main>

      {/* Modals */}
      <FirebaseTester
        isOpen={isTesterOpen}
        onClose={() => setIsTesterOpen(false)}
        onStatusChange={status =>
          setFirebaseStatus({
            connected: status.connected,
            latencyMs: status.latencyMs,
            checking: false
          })
        }
      />

      <MultiplayerModal
        isOpen={isMultiplayerOpen}
        onClose={() => setIsMultiplayerOpen(false)}
        onStartOnlineMatch={handleStartOnlineMatch}
      />

    </div>
  );
}
