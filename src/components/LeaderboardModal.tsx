import React, { useState, useEffect } from 'react';
import { db, auth, LeaderboardRecord } from '../firebase';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { Trophy, Flame, Target, X, RotateCw, UserCheck } from 'lucide-react';

interface LeaderboardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LeaderboardModal: React.FC<LeaderboardModalProps> = ({ isOpen, onClose }) => {
  const [records, setRecords] = useState<LeaderboardRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const fetchLeaderboard = async () => {
    setLoading(true);
    setError('');
    try {
      const q = query(collection(db, 'leaderboard'), orderBy('wins', 'desc'), limit(15));
      const snap = await getDocs(q);
      const items: LeaderboardRecord[] = [];
      snap.forEach(doc => {
        items.push(doc.data() as LeaderboardRecord);
      });
      setRecords(items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Leaderboard query: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLeaderboard();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in">
      <div className="relative w-full max-w-lg bg-slate-900 border border-cyan-500/40 rounded-2xl shadow-2xl shadow-cyan-950/70 overflow-hidden text-slate-100">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-500/20 bg-slate-950/90">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Trophy className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white tracking-tight">Global Leaderboard</h3>
              <p className="text-xs text-slate-400">Top Air Hockey Strikers & Win Streaks</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-cyan-400 gap-2">
              <RotateCw className="w-6 h-6 animate-spin" />
              <span className="text-xs font-mono text-slate-400">Fetching live Firestore rankings...</span>
            </div>
          ) : error ? (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              {error}
            </div>
          ) : records.length === 0 ? (
            <div className="py-12 text-center text-slate-400 space-y-2">
              <Trophy className="w-10 h-10 mx-auto text-slate-600 mb-2" />
              <p className="text-sm font-semibold text-slate-300">No ranked matches recorded yet!</p>
              <p className="text-xs text-slate-500">Play 1v1 matches to secure your spot at the top.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {records.map((rec, idx) => (
                <div
                  key={rec.id || idx}
                  className={`flex items-center justify-between p-3 rounded-xl border transition ${
                    idx === 0
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                      : idx === 1
                      ? 'bg-slate-400/10 border-slate-400/30 text-slate-200'
                      : idx === 2
                      ? 'bg-amber-700/10 border-amber-700/30 text-amber-300'
                      : 'bg-slate-800/40 border-slate-700/50 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-6 text-center font-mono font-bold text-sm text-slate-400">
                      #{idx + 1}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-white">
                        {rec.displayName || 'Anonymous Striker'}
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-2">
                        <span className="flex items-center gap-0.5 text-amber-400">
                          <Flame className="w-3 h-3" /> {rec.winStreak} streak
                        </span>
                        <span>•</span>
                        <span>{rec.goalsScored} goals</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-base font-bold font-mono text-cyan-400">
                      {rec.wins} W
                    </span>
                    <div className="text-[10px] text-slate-500 font-mono">
                      {rec.losses} L
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>Synced with Firebase Firestore</span>
          <button
            onClick={fetchLeaderboard}
            className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
          >
            <RotateCw className="w-3 h-3" /> Refresh
          </button>
        </div>

      </div>
    </div>
  );
};
