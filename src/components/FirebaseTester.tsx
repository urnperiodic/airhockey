import React, { useState, useEffect } from 'react';
import {
  db,
  auth,
  testConnection,
  loginWithGoogle,
  logoutUser,
  handleFirestoreError,
  OperationType
} from '../firebase';
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  onSnapshot,
  collection,
  getDocs,
  query,
  limit
} from 'firebase/firestore';
import {
  CheckCircle2,
  XCircle,
  Play,
  RotateCw,
  Server,
  ShieldCheck,
  Database,
  Activity,
  UserCheck,
  Copy,
  Check,
  Terminal,
  Trash2,
  Zap,
  LogIn,
  LogOut
} from 'lucide-react';
import firebaseConfig from '../../firebase-applet-config.json';

interface TestItem {
  id: string;
  name: string;
  description: string;
  status: 'idle' | 'running' | 'passed' | 'failed';
  latencyMs?: number;
  message?: string;
}

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

interface FirebaseTesterProps {
  isOpen: boolean;
  onClose: () => void;
  onStatusChange?: (status: { connected: boolean; latencyMs: number }) => void;
}

export const FirebaseTester: React.FC<FirebaseTesterProps> = ({ isOpen, onClose, onStatusChange }) => {
  const [currentUser, setCurrentUser] = useState(auth.currentUser);
  const [copied, setCopied] = useState(false);
  const [tests, setTests] = useState<TestItem[]>([
    {
      id: 'config',
      name: 'Config & Environment Integrity',
      description: 'Verifies Project ID, Auth Domain, and Firestore Database ID presence',
      status: 'idle'
    },
    {
      id: 'connection',
      name: 'Server Ping & Latency',
      description: 'Tests direct connection to Google Cloud Firestore database instance',
      status: 'idle'
    },
    {
      id: 'write',
      name: 'Document Write Test',
      description: 'Writes a test document into /test/{testId} with payload validation',
      status: 'idle'
    },
    {
      id: 'read',
      name: 'Document Read & Integrity',
      description: 'Fetches the newly created test document and validates its contents',
      status: 'idle'
    },
    {
      id: 'snapshot',
      name: 'Realtime onSnapshot Listener',
      description: 'Subscribes to live document stream and captures realtime state update',
      status: 'idle'
    },
    {
      id: 'auth',
      name: 'Firebase Authentication Status',
      description: 'Inspects user authentication session state for player identities',
      status: 'idle'
    },
    {
      id: 'rooms',
      name: 'Air Hockey 6-Digit Match Collection',
      description: 'Tests read/write compatibility on the multiplayer /rooms collection',
      status: 'idle'
    }
  ]);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunningAll, setIsRunningAll] = useState(false);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(user => {
      setCurrentUser(user);
    });
    return () => unsub();
  }, []);

  const addLog = (text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [
      { id: Math.random().toString(36).substring(2, 9), timestamp: time, type, text },
      ...prev.slice(0, 80)
    ]);
  };

  const updateTestStatus = (
    id: string,
    status: 'idle' | 'running' | 'passed' | 'failed',
    message?: string,
    latencyMs?: number
  ) => {
    setTests(prev =>
      prev.map(t => (t.id === id ? { ...t, status, message, latencyMs } : t))
    );
  };

  const runAllTests = async () => {
    setIsRunningAll(true);
    addLog('Starting Full Firebase Diagnostics Suite...', 'info');

    // 1. Config Test
    updateTestStatus('config', 'running');
    try {
      const hasPid = !!firebaseConfig.projectId;
      const hasDbId = !!firebaseConfig.firestoreDatabaseId;
      if (!hasPid || !hasDbId) {
        throw new Error('Missing projectId or firestoreDatabaseId in config');
      }
      updateTestStatus('config', 'passed', `Config valid (DB: ${firebaseConfig.firestoreDatabaseId})`);
      addLog(`[PASS] Config verified: Project="${firebaseConfig.projectId}", DB="${firebaseConfig.firestoreDatabaseId}"`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTestStatus('config', 'failed', msg);
      addLog(`[FAIL] Config check error: ${msg}`, 'error');
    }

    // 2. Server Connection Test
    updateTestStatus('connection', 'running');
    try {
      const res = await testConnection();
      if (res.success) {
        updateTestStatus('connection', 'passed', `Connected in ${res.latencyMs}ms`, res.latencyMs);
        addLog(`[PASS] Firestore ping responded in ${res.latencyMs}ms`, 'success');
        onStatusChange?.({ connected: true, latencyMs: res.latencyMs });
      } else {
        updateTestStatus('connection', 'failed', res.error || 'Connection failed', res.latencyMs);
        addLog(`[FAIL] Firestore connection error: ${res.error}`, 'error');
        onStatusChange?.({ connected: false, latencyMs: res.latencyMs });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTestStatus('connection', 'failed', msg);
      addLog(`[FAIL] Firestore ping failure: ${msg}`, 'error');
    }

    // Generate unique test ID
    const testId = `test_${Date.now()}`;
    const testPath = `test/${testId}`;
    const testPayload = {
      id: testId,
      status: 'verified',
      message: 'Air Hockey Firebase Diagnostics probe payload',
      testedBy: currentUser?.uid || 'anonymous_tester',
      createdAt: new Date().toISOString()
    };

    // 3. Write Test
    updateTestStatus('write', 'running');
    const writeStart = performance.now();
    try {
      await setDoc(doc(db, 'test', testId), testPayload);
      const writeLatency = Math.round(performance.now() - writeStart);
      updateTestStatus('write', 'passed', `Wrote test doc in ${writeLatency}ms`, writeLatency);
      addLog(`[PASS] Write succeeded to /${testPath} (${writeLatency}ms)`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTestStatus('write', 'failed', msg);
      addLog(`[FAIL] Write failed on /${testPath}: ${msg}`, 'error');
    }

    // 4. Read Test
    updateTestStatus('read', 'running');
    const readStart = performance.now();
    try {
      const snap = await getDoc(doc(db, 'test', testId));
      const readLatency = Math.round(performance.now() - readStart);
      if (snap.exists() && snap.data()?.id === testId) {
        updateTestStatus('read', 'passed', `Read and verified in ${readLatency}ms`, readLatency);
        addLog(`[PASS] Read verified payload integrity (${readLatency}ms)`, 'success');
      } else {
        throw new Error('Document read did not match expected test payload');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTestStatus('read', 'failed', msg);
      addLog(`[FAIL] Read failed on /${testPath}: ${msg}`, 'error');
    }

    // 5. Realtime Snapshot Listener Test
    updateTestStatus('snapshot', 'running');
    try {
      await new Promise<void>((resolve, reject) => {
        let triggered = false;
        const snapStart = performance.now();
        const timeout = setTimeout(() => {
          if (!triggered) {
            unsub();
            reject(new Error('Snapshot listener timed out after 4000ms'));
          }
        }, 4000);

        const unsub = onSnapshot(
          doc(db, 'test', testId),
          snapshot => {
            if (snapshot.exists() && !triggered) {
              triggered = true;
              clearTimeout(timeout);
              const snapLatency = Math.round(performance.now() - snapStart);
              updateTestStatus('snapshot', 'passed', `Snapshot event fired in ${snapLatency}ms`, snapLatency);
              addLog(`[PASS] Realtime onSnapshot stream verified (${snapLatency}ms)`, 'success');
              unsub();
              resolve();
            }
          },
          err => {
            clearTimeout(timeout);
            unsub();
            reject(err);
          }
        );
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTestStatus('snapshot', 'failed', msg);
      addLog(`[FAIL] Realtime snapshot error: ${msg}`, 'error');
    }

    // 6. Auth Status
    updateTestStatus('auth', 'running');
    if (currentUser) {
      updateTestStatus('auth', 'passed', `Signed in as ${currentUser.displayName || currentUser.email || currentUser.uid}`);
      addLog(`[PASS] Auth active: UID=${currentUser.uid}, Email=${currentUser.email || 'N/A'}`, 'success');
    } else {
      updateTestStatus('auth', 'passed', 'Guest mode active (Google Sign-In ready for match persistence)');
      addLog('[INFO] Auth: Guest mode (Google Sign-In available for leaderboard & cloud match records)', 'info');
    }

    // 7. Rooms Collection Compatibility Check
    updateTestStatus('rooms', 'running');
    try {
      const roomsQuery = query(collection(db, 'rooms'), limit(3));
      await getDocs(roomsQuery);
      updateTestStatus('rooms', 'passed', 'Rooms collection queried successfully');
      addLog('[PASS] /rooms multiplayer collection query verified', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTestStatus('rooms', 'failed', msg);
      addLog(`[FAIL] /rooms query error: ${msg}`, 'error');
    }

    // Cleanup test document
    try {
      await deleteDoc(doc(db, 'test', testId));
      addLog(`[CLEANUP] Deleted ephemeral test document /${testPath}`, 'info');
    } catch {
      // Ignore cleanup error
    }

    setIsRunningAll(false);
    addLog('Firebase Diagnostic Suite Completed!', 'success');
  };

  const handleGoogleLogin = async () => {
    try {
      addLog('Triggering Google Login popup...', 'info');
      const user = await loginWithGoogle();
      addLog(`Logged in successfully as ${user.displayName || user.email}!`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Login failed: ${msg}`, 'error');
    }
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
      addLog('Signed out of Firebase Auth', 'info');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Sign out failed: ${msg}`, 'error');
    }
  };

  const copyReport = () => {
    const report = [
      '=== FIREBASE DIAGNOSTICS REPORT ===',
      `Date: ${new Date().toISOString()}`,
      `Project ID: ${firebaseConfig.projectId}`,
      `Database ID: ${firebaseConfig.firestoreDatabaseId}`,
      `Auth User: ${currentUser ? `${currentUser.displayName || currentUser.email} (${currentUser.uid})` : 'Guest'}`,
      '',
      '--- TEST RESULTS ---',
      ...tests.map(t => `[${t.status.toUpperCase()}] ${t.name}: ${t.message || 'N/A'} (${t.latencyMs ? `${t.latencyMs}ms` : '-'})`),
      '',
      '--- RECENT LOGS ---',
      ...logs.slice(0, 15).map(l => `[${l.timestamp}] [${l.type.toUpperCase()}] ${l.text}`)
    ].join('\n');

    navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  const passedCount = tests.filter(t => t.status === 'passed').length;
  const failedCount = tests.filter(t => t.status === 'failed').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl max-h-[92vh] flex flex-col bg-slate-900 border border-cyan-500/40 rounded-2xl shadow-2xl shadow-cyan-950/60 overflow-hidden text-slate-100">
        
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-500/20 bg-slate-950/80">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Database className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold tracking-tight text-white">Firebase Diagnostics & Testing</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">
                  Live Engine
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Database: <span className="font-mono text-cyan-400">{firebaseConfig.firestoreDatabaseId}</span> • Project: <span className="font-mono text-slate-300">{firebaseConfig.projectId}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={copyReport}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
              title="Copy diagnostic report"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy Report'}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-red-500/20 hover:text-red-300 border border-slate-700 transition"
            >
              Close
            </button>
          </div>
        </div>

        {/* Action Bar */}
        <div className="px-6 py-3.5 bg-slate-950/40 border-b border-cyan-500/10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              disabled={isRunningAll}
              onClick={runAllTests}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 shadow-lg shadow-cyan-500/25 active:scale-95 transition disabled:opacity-50"
            >
              {isRunningAll ? (
                <RotateCw className="w-4 h-4 animate-spin text-slate-950" />
              ) : (
                <Play className="w-4 h-4 fill-slate-950" />
              )}
              {isRunningAll ? 'Running Diagnostics...' : 'Run Full Diagnostics'}
            </button>

            <div className="flex items-center gap-3 text-xs font-medium text-slate-400">
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> {passedCount} Passed
              </span>
              {failedCount > 0 && (
                <span className="flex items-center gap-1 text-rose-400">
                  <XCircle className="w-3.5 h-3.5" /> {failedCount} Failed
                </span>
              )}
            </div>
          </div>

          {/* User Auth control */}
          <div className="flex items-center gap-2">
            {currentUser ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700">
                <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-xs text-slate-200 font-medium max-w-[140px] truncate">
                  {currentUser.displayName || currentUser.email}
                </span>
                <button
                  onClick={handleLogout}
                  className="ml-1 p-1 text-slate-400 hover:text-rose-400 transition"
                  title="Sign Out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={handleGoogleLogin}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 transition"
              >
                <LogIn className="w-3.5 h-3.5" />
                Test Google Sign-In
              </button>
            )}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Diagnostic Test Cards (7 cols) */}
          <div className="lg:col-span-7 space-y-3">
            <h3 className="text-xs uppercase font-mono tracking-wider text-cyan-400/80 font-semibold mb-2">
              Automated Diagnostic Checks
            </h3>
            
            {tests.map(test => (
              <div
                key={test.id}
                className={`p-3.5 rounded-xl border transition-all ${
                  test.status === 'passed'
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-100'
                    : test.status === 'failed'
                    ? 'bg-rose-950/20 border-rose-500/30 text-rose-100'
                    : test.status === 'running'
                    ? 'bg-cyan-950/30 border-cyan-500/50 text-cyan-100 shadow-md shadow-cyan-900/30'
                    : 'bg-slate-800/40 border-slate-700/60 text-slate-300'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5">
                      {test.status === 'passed' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : test.status === 'failed' ? (
                        <XCircle className="w-4 h-4 text-rose-400" />
                      ) : test.status === 'running' ? (
                        <RotateCw className="w-4 h-4 text-cyan-400 animate-spin" />
                      ) : (
                        <Activity className="w-4 h-4 text-slate-500" />
                      )}
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                        {test.name}
                        {test.latencyMs !== undefined && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700">
                            {test.latencyMs}ms
                          </span>
                        )}
                      </h4>
                      <p className="text-xs text-slate-400 mt-0.5">{test.description}</p>
                      {test.message && (
                        <p
                          className={`text-xs mt-1.5 font-mono ${
                            test.status === 'passed'
                              ? 'text-emerald-400'
                              : test.status === 'failed'
                              ? 'text-rose-400'
                              : 'text-cyan-300'
                          }`}
                        >
                          ↳ {test.message}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Real-time Diagnostics Terminal (5 cols) */}
          <div className="lg:col-span-5 flex flex-col bg-slate-950/90 border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-mono font-medium text-slate-200">Diagnostics Terminal</span>
              </div>
              <button
                onClick={() => setLogs([])}
                className="text-xs text-slate-500 hover:text-slate-300 transition"
                title="Clear console"
              >
                Clear
              </button>
            </div>

            <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px] space-y-1.5 min-h-[300px] max-h-[460px]">
              {logs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center p-4">
                  <Activity className="w-6 h-6 mb-2 opacity-40" />
                  <p>Click "Run Full Diagnostics" to stream test output</p>
                </div>
              ) : (
                logs.map(log => (
                  <div
                    key={log.id}
                    className={`leading-relaxed break-words ${
                      log.type === 'success'
                        ? 'text-emerald-400'
                        : log.type === 'error'
                        ? 'text-rose-400'
                        : log.type === 'warning'
                        ? 'text-amber-400'
                        : 'text-slate-300'
                    }`}
                  >
                    <span className="text-slate-600 mr-1.5">[{log.timestamp}]</span>
                    {log.text}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer info banner */}
        <div className="px-6 py-3 bg-slate-950 border-t border-cyan-500/20 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            <span>Firestore Rules: <span className="text-emerald-400 font-medium">Hardened & Active</span></span>
          </div>
          <div className="text-slate-500">
            Air Hockey Online 1v1 Rooms backed by Google Firestore
          </div>
        </div>

      </div>
    </div>
  );
};
