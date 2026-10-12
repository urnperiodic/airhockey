import { doc, onSnapshot, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';

export interface PeerGameSession {
  dataChannel: RTCDataChannel | null;
  connect: () => Promise<void>;
  close: () => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' }
];

function createPeerSession(roomId: string, isHost: boolean): PeerGameSession {
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const roomRef = doc(db, 'rooms', roomId);
  const dataChannel = isHost
    ? peer.createDataChannel('airhockey', { ordered: false, maxRetransmits: 0 })
    : null;
  let unsubscribe: (() => void) | null = null;
  let connectPromise: Promise<void> | null = null;
  let rejectConnection: ((error: Error) => void) | null = null;
  let cancelConnection: (() => void) | null = null;
  let remoteDescriptionReady = false;
  let isConnected = false;
  let signalQueue = Promise.resolve();
  const appliedCandidates = new Set<string>();

  const close = () => {
    cancelConnection?.();
    unsubscribe?.();
    unsubscribe = null;
    peer.close();
    dataChannel?.close();
  };

  peer.onicecandidate = event => {
    if (!event.candidate || isConnected) return;
    const candidates = isHost ? { hostCandidates: arrayUnion(event.candidate.toJSON()) } : {
      guestCandidates: arrayUnion(event.candidate.toJSON())
    };
    updateDoc(roomRef, candidates).catch(error => {
      rejectConnection?.(error instanceof Error ? error : new Error(String(error)));
    });
  };

  const session: PeerGameSession = {
    dataChannel,
    connect: () => {
      if (connectPromise) return connectPromise;

      connectPromise = new Promise<void>((resolve, reject) => {
        rejectConnection = reject;
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;

        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe?.();
          reject(error);
        };
        cancelConnection = () => fail(new Error('The peer-to-peer connection was cancelled.'));

        const connected = () => {
          if (settled) return;
          settled = true;
          isConnected = true;
          clearTimeout(timeout);
          unsubscribe?.();
          unsubscribe = null;
          resolve();
        };

        const addCandidates = async (candidates: RTCIceCandidateInit[] = []) => {
          if (!remoteDescriptionReady) return;
          for (const candidate of candidates) {
            const key = `${candidate.candidate}|${candidate.sdpMid}|${candidate.sdpMLineIndex}`;
            if (appliedCandidates.has(key)) continue;
            await peer.addIceCandidate(candidate);
            appliedCandidates.add(key);
          }
        };

        const processRoomUpdate = async (data: Record<string, unknown>) => {
          if (data.status === 'abandoned') {
            throw new Error('The host cancelled this match.');
          }

          if (isHost) {
            const answer = data.guestAnswer as RTCSessionDescriptionInit | undefined;
            if (answer && !remoteDescriptionReady) {
              await peer.setRemoteDescription(answer);
              remoteDescriptionReady = true;
            }
            await addCandidates(data.guestCandidates as RTCIceCandidateInit[] | undefined);
          } else {
            const offer = data.hostOffer as RTCSessionDescriptionInit | undefined;
            if (offer && !remoteDescriptionReady) {
              await peer.setRemoteDescription(offer);
              remoteDescriptionReady = true;
              const answer = await peer.createAnswer();
              await peer.setLocalDescription(answer);
              if (!peer.localDescription) throw new Error('Could not create a WebRTC answer.');
              await updateDoc(roomRef, {
                guestAnswer: {
                  type: peer.localDescription.type,
                  sdp: peer.localDescription.sdp
                }
              });
            }
            await addCandidates(data.hostCandidates as RTCIceCandidateInit[] | undefined);
          }
        };

        timeout = setTimeout(() => {
          fail(new Error('Peer connection timed out. Check both players’ network connections and try again.'));
        }, isHost ? 10 * 60_000 : 45_000);

        const channel = () => (session.dataChannel);
        const watchChannel = () => {
          const activeChannel = channel();
          if (!activeChannel) return;
          activeChannel.onopen = connected;
          activeChannel.onerror = () => fail(new Error('The peer-to-peer game connection failed.'));
          if (activeChannel.readyState === 'open') connected();
        };
        watchChannel();
        peer.ondatachannel = event => {
          if (!isHost && event.channel.label === 'airhockey') {
            session.dataChannel = event.channel;
            watchChannel();
          }
        };

        peer.onconnectionstatechange = () => {
          if (peer.connectionState === 'failed') {
            fail(new Error('Could not establish a direct peer connection. Your network may require a relay.'));
          }
        };

        unsubscribe = onSnapshot(roomRef, snapshot => {
          if (!snapshot.exists()) {
            fail(new Error('The match room was removed while connecting.'));
            return;
          }
          signalQueue = signalQueue
            .then(() => processRoomUpdate(snapshot.data()))
            .catch(error => fail(error instanceof Error ? error : new Error(String(error))));
        }, error => fail(error));

        if (isHost) {
          void peer.createOffer()
            .then(offer => peer.setLocalDescription(offer))
            .then(async () => {
              if (!peer.localDescription) throw new Error('Could not create a WebRTC offer.');
              await updateDoc(roomRef, {
                hostOffer: {
                  type: peer.localDescription.type,
                  sdp: peer.localDescription.sdp
                }
              });
            })
            .catch(error => fail(error instanceof Error ? error : new Error(String(error))));
        }
      });

      return connectPromise;
    },
    close
  };

  return session;
}

export function createHostPeerSession(roomId: string): PeerGameSession {
  return createPeerSession(roomId, true);
}

export function createGuestPeerSession(roomId: string): PeerGameSession {
  return createPeerSession(roomId, false);
}
