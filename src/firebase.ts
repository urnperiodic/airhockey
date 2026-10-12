/**
 * Firebase Client Setup and Firestore Helpers
 */
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  Firestore
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase App singleton
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// CRITICAL: Initialize Firestore with the dedicated Database ID
export const db: Firestore = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Auth instance
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Boots the mandatory server test connection
 */
export async function testConnection(): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const start = performance.now();
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    const latencyMs = Math.round(performance.now() - start);
    return { success: true, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start);
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
    // Note: If document does not exist, getDocFromServer still successfully contacts server
    const isDocNotFoundError = error instanceof Error && error.message.includes('No document to update');
    return {
      success: isDocNotFoundError || !(error instanceof Error && error.message.includes('unavailable')),
      latencyMs,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Initial boot check as required by guidelines
testConnection().then(res => {
  if (res.success) {
    console.log(`[Firebase] Initial connection verified in ${res.latencyMs}ms`);
  } else {
    console.warn(`[Firebase] Initial connection notice:`, res.error);
  }
}).catch(console.error);

/**
 * Auth Helpers
 */
export async function loginWithGoogle(): Promise<User> {
  try {
    const cred = await signInWithPopup(auth, googleProvider);
    return cred.user;
  } catch (err) {
    console.error('Google Sign In failed:', err);
    throw err;
  }
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export function subscribeAuth(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

/**
 * App Types
 */
export interface LeaderboardRecord {
  id: string;
  userId: string;
  displayName: string;
  wins: number;
  losses: number;
  goalsScored: number;
  winStreak: number;
  highestStreak: number;
  updatedAt: string;
}

export interface RoomRecord {
  id: string;
  roomCode: string;
  title: string;
  hostId: string;
  hostName: string;
  guestId?: string;
  guestName?: string;
  hostColor?: 'red' | 'blue';
  status: 'waiting' | 'playing' | 'finished' | 'abandoned';
  hostScore: number;
  guestScore: number;
  winningScore: number;
  hostOffer?: RTCSessionDescriptionInit;
  guestAnswer?: RTCSessionDescriptionInit;
  hostCandidates?: RTCIceCandidateInit[];
  guestCandidates?: RTCIceCandidateInit[];
  createdAt: string;
  updatedAt: string;
}
