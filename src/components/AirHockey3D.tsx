import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import confetti from 'canvas-confetti';
import { sound } from '../services/sound';
import { db, auth, RoomRecord } from '../firebase';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  getDocs
} from 'firebase/firestore';

export type GameMode = 'bot' | 'local' | 'online_host' | 'online_guest';
export type BotDifficulty = 'rookie' | 'pro' | 'master' | 'cyber' | 'god';
export type CameraView = 'fpv' | 'top' | 'action' | 'classic';

function sendPeerPacket(channel: RTCDataChannel | null | undefined, packet: object) {
  if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 65_536) return;

  try {
    channel.send(JSON.stringify(packet));
  } catch (error) {
    console.error('Failed to send peer game data:', error);
  }
}

interface AirHockey3DProps {
  mode: GameMode;
  botDifficulty: BotDifficulty;
  winningScore: number;
  allowOwnGoals?: boolean;
  roomCode?: string;
  onlineRoom?: RoomRecord | null;
  gameDataChannel?: RTCDataChannel | null;
  cameraView: CameraView;
  mouseSensitivityMultiplier?: number;
  onGoalScored?: (scorer: 'player' | 'opponent', scores: { player: number; opponent: number }) => void;
  onScoreUpdate?: (scores: { player: number; opponent: number }) => void;
  onGameOver?: (winner: 'player' | 'opponent', scores: { player: number; opponent: number }) => void;
}

export const AirHockey3D: React.FC<AirHockey3DProps> = ({
  mode,
  botDifficulty,
  winningScore = 10,
  allowOwnGoals = true,
  roomCode,
  onlineRoom,
  gameDataChannel,
  cameraView,
  mouseSensitivityMultiplier = 2.5,
  onGoalScored,
  onScoreUpdate,
  onGameOver
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Score states
  const [playerScore, setPlayerScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [announcement, setAnnouncement] = useState<string>('GET READY');
  const [isServing, setIsServing] = useState(true);
  const [selectedServeX, setSelectedServeX] = useState(0);
  const [helpDisabled, setHelpDisabled] = useState(false);
  const [winner, setWinner] = useState<'player' | 'opponent' | null>(null);

  // References for render loop & physics mutable states to run at solid 60+ FPS without re-renders
  const stateRef = useRef({
    // Table dimensions
    tableWidth: 14,
    tableLength: 26,
    goalWidth: 3.2,
    puckRadius: 0.55,
    p1MalletRadius: 1.4, // Bigger player mallet
    p2MalletRadius: 0.8, // Smaller bot / opponent mallet

    // Puck state
    puckX: 0,
    puckZ: 0,
    puckVx: 0,
    puckVz: 0,
    puckTargetY: 0.16,

    // Player 1 mallet (Z > 0 side)
    p1X: 0,
    p1Z: 8.5,
    p1PrevX: 0,
    p1PrevZ: 8.5,
    p1Vx: 0,
    p1Vz: 0,

    // Player 2 / Opponent / Bot mallet (Z < 0 side)
    p2X: 0,
    p2Z: -8.5,
    p2PrevX: 0,
    p2PrevZ: -8.5,
    p2Vx: 0,
    p2Vz: 0,

    // Mouse / Pointer target
    targetP1X: 0,
    targetP1Z: 8.5,
    targetP2X: 0,
    targetP2Z: -8.5,

    // Scores
    p1Score: 0,
    p2Score: 0,
    gameOver: false,
    isScoring: false,
    servingWait: 1.2,
    servePending: true,
    serveSide: 'p1' as 'p1' | 'p2',
    requestedServeX: null as number | null,
    botServeReadyAt: 0,
    botGracePeriodUntil: 0,
    lastTouchedBy: null as 'player' | 'opponent' | null,
    isGuestPredictingPaddleHit: false,

    // Online sync throttle
    lastSyncTime: 0,
    lastRemotePaddleUpdateTime: 0,

    // Key states for local 2-player mode
    keys: {} as Record<string, boolean>,

    // Three.js items
    scene: null as THREE.Scene | null,
    camera: null as THREE.PerspectiveCamera | null,
    renderer: null as THREE.WebGLRenderer | null,
    puckMesh: null as THREE.Mesh | null,
    puckGlowMesh: null as THREE.Mesh | null,
    p1Mesh: null as THREE.Group | null,
    p2Mesh: null as THREE.Group | null,
    tableRailLeft: null as THREE.Mesh | null,
    tableRailRight: null as THREE.Mesh | null,
    p1ScoreText: null as THREE.Mesh | null,
    p2ScoreText: null as THREE.Mesh | null,
    particles: [] as {
      mesh: THREE.Mesh;
      vx: number;
      vy: number;
      vz: number;
      life: number;
    }[],

    // Animation frame ID
    animId: 0
  });

  // Keep stateRef synced with props
  const propsRef = useRef({
    mode,
    botDifficulty,
    winningScore,
    allowOwnGoals,
    cameraView,
    mouseSensitivityMultiplier,
    onlineRoom,
    gameDataChannel,
    onGoalScored,
    onScoreUpdate,
    onGameOver
  });

  useEffect(() => {
    propsRef.current = {
      mode,
      botDifficulty,
      winningScore,
      allowOwnGoals,
      cameraView,
      mouseSensitivityMultiplier,
      onlineRoom,
      gameDataChannel,
      onGoalScored,
      onScoreUpdate,
      onGameOver
    };
  }, [mode, botDifficulty, winningScore, allowOwnGoals, cameraView, mouseSensitivityMultiplier, onlineRoom, gameDataChannel, onGoalScored, onScoreUpdate, onGameOver]);

  // Read initial scores from the room; live match state comes through WebRTC.
  useEffect(() => {
    if (!onlineRoom || (mode !== 'online_guest' && mode !== 'online_host')) return;
    const s = stateRef.current;
    const player = mode === 'online_guest' ? onlineRoom.guestScore : onlineRoom.hostScore;
    const opponent = mode === 'online_guest' ? onlineRoom.hostScore : onlineRoom.guestScore;
    s.p1Score = player;
    s.p2Score = opponent;
    setPlayerScore(player);
    setOpponentScore(opponent);
  }, [onlineRoom, mode]);

  useEffect(() => {
    if (mode !== 'online_guest' && mode !== 'online_host') return;

    const hostColor = onlineRoom?.hostColor ?? 'blue';
    const localColor = mode === 'online_host' ? hostColor : hostColor === 'blue' ? 'red' : 'blue';
    const opponentColor = localColor === 'blue' ? 'red' : 'blue';
    const colors = {
      blue: { main: 0x168bff, glow: 0x38bdf8 },
      red: { main: 0xef3340, glow: 0xff6670 }
    };
    const applySideColor = (group: THREE.Group | null, color: 'red' | 'blue') => {
      if (!group) return;
      group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          const role = material.userData.colorRole;
          if (role === 'main') material.color.setHex(colors[color].main);
          if (role === 'glow') material.color.setHex(colors[color].glow);
          if (role === 'main' && material instanceof THREE.MeshStandardMaterial) {
            material.emissive.setHex(colors[color].glow);
          }
        }
      });
    };

    applySideColor(stateRef.current.p1Mesh, localColor);
    applySideColor(stateRef.current.p2Mesh, opponentColor);
  }, [mode, onlineRoom?.hostColor]);

  useEffect(() => {
    if (!gameDataChannel) return;

    gameDataChannel.onmessage = event => {
      let packet: Record<string, unknown>;
      try {
        packet = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch (error) {
        console.error('Received invalid peer game data:', error);
        return;
      }

      const s = stateRef.current;
      if (
        propsRef.current.mode === 'online_host' &&
        packet.type === 'guest-input' &&
        typeof packet.x === 'number' &&
        typeof packet.z === 'number' &&
        typeof packet.vx === 'number' &&
        typeof packet.vz === 'number'
      ) {
        s.p2X = packet.x;
        s.p2Z = -packet.z;
        s.p2Vx = Math.max(-30, Math.min(30, packet.vx));
        s.p2Vz = Math.max(-30, Math.min(30, -packet.vz));
        s.lastRemotePaddleUpdateTime = performance.now();
      } else if (
        propsRef.current.mode === 'online_host' &&
        packet.type === 'serve-request' &&
        typeof packet.x === 'number'
      ) {
        s.requestedServeX = Math.max(-3.5, Math.min(3.5, packet.x));
      } else if (
        propsRef.current.mode === 'online_guest' &&
        packet.type === 'host-state' &&
        ['puckX', 'puckZ', 'puckVx', 'puckVz', 'hostPaddleX', 'hostPaddleZ', 'hostScore', 'guestScore']
          .every(key => typeof packet[key] === 'number') &&
        typeof packet.gameOver === 'boolean'
      ) {
        s.puckX = packet.puckX as number;
        s.puckZ = -(packet.puckZ as number);
        s.puckVx = packet.puckVx as number;
        s.puckVz = -(packet.puckVz as number);
        s.p2X = packet.hostPaddleX as number;
        s.p2Z = -(packet.hostPaddleZ as number);
        s.p1Score = packet.guestScore as number;
        s.p2Score = packet.hostScore as number;
        s.servePending = packet.servePending as boolean;
        s.serveSide = packet.serveSide as 'p1' | 'p2';
        setIsServing(s.servePending);
        if (s.servePending) {
          setAnnouncement(s.serveSide === 'p2' ? 'YOUR SERVE' : 'OPPONENT SERVE');
        }
        setPlayerScore(s.p1Score);
        setOpponentScore(s.p2Score);
        if (s.gameOver !== packet.gameOver) {
          s.gameOver = packet.gameOver;
          setWinner(packet.gameOver ? (s.p1Score >= propsRef.current.winningScore ? 'player' : 'opponent') : null);
          setAnnouncement(packet.gameOver ? (s.p1Score >= propsRef.current.winningScore ? 'VICTORY!' : 'GAME OVER') : '');
        }
      }
    };

    return () => {
      gameDataChannel.onmessage = null;
    };
  }, [gameDataChannel]);

  // Particle explosion helper with strict collision particle limit and pooling
  const triggerSparks = useCallback((x: number, y: number, z: number, colorHex: number, count = 8) => {
    const s = stateRef.current;
    if (!s.scene) return;

    // Enforce max active particles limit (25 max) to guarantee zero lag
    const MAX_PARTICLES = 25;
    while (s.particles.length + count > MAX_PARTICLES && s.particles.length > 0) {
      const old = s.particles.shift();
      if (old) {
        s.scene.remove(old.mesh);
        old.mesh.geometry.dispose();
      }
    }

    for (let i = 0; i < count; i++) {
      const geo = new THREE.SphereGeometry(0.08, 4, 4);
      const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 1
      });
      const spark = new THREE.Mesh(geo, mat);
      spark.position.set(x, y, z);
      s.scene.add(spark);

      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      s.particles.push({
        mesh: spark,
        vx: Math.cos(angle) * speed,
        vy: 1.0 + Math.random() * 4,
        vz: Math.sin(angle) * speed,
        life: 0.25 + Math.random() * 0.25
      });
    }
  }, []);

  // Serve puck after goal
  const servePuck = useCallback((server: 'p1' | 'p2', x = 0) => {
    const s = stateRef.current;
    const serveX = Math.max(-3.5, Math.min(3.5, x));
    s.puckX = serveX;
    s.puckZ = server === 'p1' ? 4 : -4;
    s.puckVx = -serveX * 0.55 + (Math.random() - 0.5) * 1.2;
    s.puckVz = server === 'p1' ? -7 : 7;
    s.servePending = false;
    s.serveSide = server;
    s.requestedServeX = null;
    s.isScoring = false;
    s.servingWait = 0;
    s.botServeReadyAt = 0;
    setIsServing(true);
    setAnnouncement('SERVE!');
    sound.playWhistle();

    setTimeout(() => {
      setIsServing(false);
      setAnnouncement('');
    }, 450);
  }, []);

  // Reset complete match
  const resetMatch = useCallback(() => {
    const s = stateRef.current;
    s.p1Score = 0;
    s.p2Score = 0;
    s.gameOver = false;
    s.isScoring = false;
    s.p1X = 0;
    s.p1Z = 8.5;
    s.targetP1Z = 8.5;
    s.p2X = 0;
    s.p2Z = -8.5;
    s.targetP2Z = -8.5;
    s.puckX = 0;
    s.puckZ = 4;
    s.puckVx = 0;
    s.puckVz = 0;
    s.servePending = true;
    s.serveSide = 'p1';
    s.requestedServeX = null;
    s.botGracePeriodUntil = performance.now() + 1500;
    setIsServing(true);
    setSelectedServeX(0);
    setPlayerScore(0);
    setOpponentScore(0);
    setWinner(null);
    setAnnouncement('CHOOSE YOUR SERVE');
    sound.playWhistle();
    propsRef.current.onScoreUpdate?.({ player: 0, opponent: 0 });
    setTimeout(() => {
      setAnnouncement('');
    }, 1000);
  }, []);

  // Setup Three.js scene
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const s = stateRef.current;

    // 1. Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x040711);
    scene.fog = new THREE.FogExp2(0x040711, 0.022);
    s.scene = scene;

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(
      65,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    s.camera = camera;

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    s.renderer = renderer;

    // 4. Lighting
    const ambientLight = new THREE.AmbientLight(0x223355, 0.8);
    scene.add(ambientLight);

    // Main table spotlight
    const spotLight = new THREE.SpotLight(0xddeeff, 2.8);
    spotLight.position.set(0, 18, 0);
    spotLight.angle = Math.PI / 3;
    spotLight.penumbra = 0.5;
    spotLight.decay = 1.2;
    spotLight.distance = 45;
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.width = 1024;
    spotLight.shadow.mapSize.height = 1024;
    scene.add(spotLight);

    // Blue/Cyan side glow (Player side)
    const p1PointLight = new THREE.PointLight(0x00e5ff, 2.2, 18);
    p1PointLight.position.set(0, 4, 10);
    scene.add(p1PointLight);

    // Pink/Magenta side glow (Opponent side)
    const p2PointLight = new THREE.PointLight(0xff0066, 2.2, 18);
    p2PointLight.position.set(0, 4, -10);
    scene.add(p2PointLight);

    // 5. Table Geometry & Materials
    const halfW = s.tableWidth / 2;
    const halfL = s.tableLength / 2;
    const goalHalfW = s.goalWidth / 2;

    // Rink surface
    const surfaceGeo = new THREE.BoxGeometry(s.tableWidth, 0.3, s.tableLength);
    const surfaceMat = new THREE.MeshStandardMaterial({
      color: 0x101d32,
      roughness: 0.22,
      metalness: 0.32,
      envMapIntensity: 0.8
    });
    const rinkMesh = new THREE.Mesh(surfaceGeo, surfaceMat);
    rinkMesh.position.y = -0.15;
    rinkMesh.receiveShadow = true;
    scene.add(rinkMesh);

    // Rink Markings
    const linesGroup = new THREE.Group();
    linesGroup.position.y = 0.01;

    // Center dividing red line
    const centerLineGeo = new THREE.PlaneGeometry(s.tableWidth, 0.12);
    const centerLineMat = new THREE.MeshBasicMaterial({ color: 0xff1744, side: THREE.DoubleSide });
    const centerLine = new THREE.Mesh(centerLineGeo, centerLineMat);
    centerLine.rotation.x = -Math.PI / 2;
    linesGroup.add(centerLine);

    // Center glowing circle
    const centerRingGeo = new THREE.RingGeometry(2.4, 2.52, 48);
    const centerRingMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide });
    const centerRing = new THREE.Mesh(centerRingGeo, centerRingMat);
    centerRing.rotation.x = -Math.PI / 2;
    linesGroup.add(centerRing);

    // Center faceoff dot
    const centerDotGeo = new THREE.CircleGeometry(0.4, 24);
    const centerDotMat = new THREE.MeshBasicMaterial({ color: 0xff0066, side: THREE.DoubleSide });
    const centerDot = new THREE.Mesh(centerDotGeo, centerDotMat);
    centerDot.rotation.x = -Math.PI / 2;
    linesGroup.add(centerDot);

    // Faceoff rings on each half add clearer rink structure.
    for (const z of [-halfL * 0.48, halfL * 0.48]) {
      const faceoffRing = new THREE.Mesh(
        new THREE.RingGeometry(1.15, 1.22, 48),
        new THREE.MeshBasicMaterial({ color: 0x9bb8d6, transparent: true, opacity: 0.62, side: THREE.DoubleSide })
      );
      faceoffRing.rotation.x = -Math.PI / 2;
      faceoffRing.position.z = z;
      linesGroup.add(faceoffRing);

      const faceoffDot = new THREE.Mesh(
        new THREE.CircleGeometry(0.16, 24),
        new THREE.MeshBasicMaterial({ color: 0xdbeafe, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
      );
      faceoffDot.rotation.x = -Math.PI / 2;
      faceoffDot.position.z = z;
      linesGroup.add(faceoffDot);
    }

    // Player 1 Goal Crease arc
    const p1CreaseGeo = new THREE.RingGeometry(2.8, 2.92, 32, 1, 0, Math.PI);
    const p1CreaseMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide });
    const p1Crease = new THREE.Mesh(p1CreaseGeo, p1CreaseMat);
    p1Crease.rotation.x = -Math.PI / 2;
    p1Crease.rotation.z = Math.PI;
    p1Crease.position.z = halfL;
    linesGroup.add(p1Crease);

    // Player 2 Goal Crease arc
    const p2CreaseGeo = new THREE.RingGeometry(2.8, 2.92, 32, 1, 0, Math.PI);
    const p2CreaseMat = new THREE.MeshBasicMaterial({ color: 0xff0066, side: THREE.DoubleSide });
    const p2Crease = new THREE.Mesh(p2CreaseGeo, p2CreaseMat);
    p2Crease.rotation.x = -Math.PI / 2;
    p2Crease.position.z = -halfL;
    linesGroup.add(p2Crease);

    scene.add(linesGroup);

    // Air Holes pattern texture / illusion: Subtle micro grid
    const gridHelper = new THREE.GridHelper(s.tableWidth, 28, 0x00e5ff, 0x112233);
    gridHelper.position.y = 0.005;
    gridHelper.scale.z = s.tableLength / s.tableWidth;
    scene.add(gridHelper);

    // Rails (Side and End Rails with Goal Cutouts)
    const railHeight = 0.8;
    const railThickness = 0.7;

    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x151c2e,
      roughness: 0.25,
      metalness: 0.85
    });

    const neonCyanMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    const neonPinkMat = new THREE.MeshBasicMaterial({ color: 0xff0066 });

    // Left Rail
    const leftRailGeo = new THREE.BoxGeometry(railThickness, railHeight, s.tableLength);
    const leftRail = new THREE.Mesh(leftRailGeo, railMaterial);
    leftRail.position.set(-halfW - railThickness / 2, railHeight / 2, 0);
    leftRail.castShadow = true;
    leftRail.receiveShadow = true;
    scene.add(leftRail);

    // Left Rail Neon Trim
    const leftTrimGeo = new THREE.BoxGeometry(0.12, 0.12, s.tableLength);
    const leftTrim = new THREE.Mesh(leftTrimGeo, neonCyanMat);
    leftTrim.position.set(-halfW - 0.06, railHeight + 0.06, 0);
    scene.add(leftTrim);

    // Right Rail
    const rightRailGeo = new THREE.BoxGeometry(railThickness, railHeight, s.tableLength);
    const rightRail = new THREE.Mesh(rightRailGeo, railMaterial);
    rightRail.position.set(halfW + railThickness / 2, railHeight / 2, 0);
    rightRail.castShadow = true;
    rightRail.receiveShadow = true;
    scene.add(rightRail);

    // Right Rail Neon Trim
    const rightTrim = new THREE.Mesh(leftTrimGeo, neonCyanMat);
    rightTrim.position.set(halfW + 0.06, railHeight + 0.06, 0);
    scene.add(rightTrim);

    // End Rails (with goal gap in middle)
    const endSegmentWidth = (s.tableWidth - s.goalWidth) / 2;

    const createEndRail = (zPos: number, isP1: boolean) => {
      const trimMat = isP1 ? neonCyanMat : neonPinkMat;

      // Left segment
      const segLeftGeo = new THREE.BoxGeometry(endSegmentWidth, railHeight, railThickness);
      const segLeft = new THREE.Mesh(segLeftGeo, railMaterial);
      segLeft.position.set(-halfW + endSegmentWidth / 2, railHeight / 2, zPos);
      segLeft.castShadow = true;
      segLeft.receiveShadow = true;
      scene.add(segLeft);

      const trimLeftGeo = new THREE.BoxGeometry(endSegmentWidth, 0.12, 0.12);
      const trimLeft = new THREE.Mesh(trimLeftGeo, trimMat);
      trimLeft.position.set(-halfW + endSegmentWidth / 2, railHeight + 0.06, zPos + (isP1 ? -0.06 : 0.06));
      scene.add(trimLeft);

      // Right segment
      const segRight = new THREE.Mesh(segLeftGeo, railMaterial);
      segRight.position.set(halfW - endSegmentWidth / 2, railHeight / 2, zPos);
      segRight.castShadow = true;
      segRight.receiveShadow = true;
      scene.add(segRight);

      const trimRight = new THREE.Mesh(trimLeftGeo, trimMat);
      trimRight.position.set(halfW - endSegmentWidth / 2, railHeight + 0.06, zPos + (isP1 ? -0.06 : 0.06));
      scene.add(trimRight);

      // Goal Pocket Backing Box (catches puck)
      const goalPocketGeo = new THREE.BoxGeometry(s.goalWidth, 0.6, 1.4);
      const goalPocketMat = new THREE.MeshStandardMaterial({
        color: 0x05070f,
        roughness: 0.8
      });
      const goalPocket = new THREE.Mesh(goalPocketGeo, goalPocketMat);
      goalPocket.position.set(0, 0.3, zPos + (isP1 ? 0.7 : -0.7));
      scene.add(goalPocket);

      // Goal Pocket Neon Frame & Netting (clearly visible in top view)
      const pocketNetGeo = new THREE.BoxGeometry(s.goalWidth + 0.1, 0.68, 1.48);
      const pocketNetMat = new THREE.MeshBasicMaterial({
        color: isP1 ? 0x00e5ff : 0xff0066,
        wireframe: true,
        transparent: true,
        opacity: 0.85
      });
      const pocketNet = new THREE.Mesh(pocketNetGeo, pocketNetMat);
      pocketNet.position.set(0, 0.34, zPos + (isP1 ? 0.74 : -0.74));
      scene.add(pocketNet);

      // Glowing Goal Posts at opening
      const postGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.8, 16);
      const postMat = new THREE.MeshBasicMaterial({ color: isP1 ? 0x00ffff : 0xff0066 });
      const leftPost = new THREE.Mesh(postGeo, postMat);
      leftPost.position.set(-s.goalWidth / 2, 0.4, zPos);
      scene.add(leftPost);
      const rightPost = new THREE.Mesh(postGeo, postMat);
      rightPost.position.set(s.goalWidth / 2, 0.4, zPos);
      scene.add(rightPost);

      // Goal Sensor Neon Glow
      const sensorGeo = new THREE.BoxGeometry(s.goalWidth, 0.1, 0.1);
      const sensorMesh = new THREE.Mesh(sensorGeo, trimMat);
      sensorMesh.position.set(0, 0.05, zPos);
      scene.add(sensorMesh);
    };

    createEndRail(halfL + railThickness / 2, true);
    createEndRail(-halfL - railThickness / 2, false);

    // 6. 3D Mallets (Player 1 and Player 2 / Opponent)
    const createMallet = (isP1: boolean) => {
      const radius = isP1 ? s.p1MalletRadius : s.p2MalletRadius;
      const group = new THREE.Group();

      const mainColor = isP1 ? 0x00d4ff : 0xff0055;
      const glowColor = isP1 ? 0x00ffff : 0xff1744;

      // Base disc
      const baseGeo = new THREE.CylinderGeometry(radius, radius + 0.1, 0.35, 32);
      const baseMat = new THREE.MeshStandardMaterial({
        color: mainColor,
        roughness: 0.2,
        metalness: 0.6,
        emissive: glowColor,
        emissiveIntensity: 0.16
      });
      baseMat.userData.colorRole = 'main';
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.175;
      base.castShadow = true;
      group.add(base);

      // Felt rim bottom
      const feltGeo = new THREE.CylinderGeometry(radius + 0.05, radius + 0.05, 0.06, 32);
      const feltMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
      const felt = new THREE.Mesh(feltGeo, feltMat);
      felt.position.y = 0.03;
      group.add(felt);

      // Handle shaft
      const shaftGeo = new THREE.CylinderGeometry(0.38, 0.55, 0.7, 24);
      const shaftMat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 0.3,
        metalness: 0.8
      });
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.position.y = 0.65;
      shaft.castShadow = true;
      group.add(shaft);

      // Top handle knob
      const knobGeo = new THREE.SphereGeometry(0.5, 24, 24);
      const knobMat = new THREE.MeshStandardMaterial({
        color: mainColor,
        roughness: 0.1,
        metalness: 0.4
      });
      knobMat.userData.colorRole = 'main';
      const knob = new THREE.Mesh(knobGeo, knobMat);
      knob.position.y = 1.1;
      knob.castShadow = true;
      group.add(knob);

      // Neon Accent Ring
      const ringGeo = new THREE.TorusGeometry(radius * 0.7, 0.05, 12, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: glowColor });
      ringMat.userData.colorRole = 'glow';
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.36;
      group.add(ring);

      return group;
    };

    const p1Mallet = createMallet(true);
    p1Mallet.position.set(0, 0, 7.0);
    scene.add(p1Mallet);
    s.p1Mesh = p1Mallet;

    const p2Mallet = createMallet(false);
    p2Mallet.position.set(0, 0, -7.0);
    scene.add(p2Mallet);
    s.p2Mesh = p2Mallet;

    // 7. 3D Puck
    const puckGeo = new THREE.CylinderGeometry(s.puckRadius, s.puckRadius, 0.24, 32);
    const puckMat = new THREE.MeshStandardMaterial({
      color: 0xff5500,
    roughness: 0.16,
    metalness: 0.72,
    emissive: 0xff3b12,
    emissiveIntensity: 0.65
    });
    const puckMesh = new THREE.Mesh(puckGeo, puckMat);
    puckMesh.position.set(0, 0.12, 0);
    puckMesh.castShadow = true;
    scene.add(puckMesh);
    s.puckMesh = puckMesh;

    // Puck glowing center core
    const puckCoreGeo = new THREE.CylinderGeometry(s.puckRadius * 0.55, s.puckRadius * 0.55, 0.26, 24);
    const puckCoreMat = new THREE.MeshBasicMaterial({ color: 0xffd2a1 });
    const puckCore = new THREE.Mesh(puckCoreGeo, puckCoreMat);
    puckMesh.add(puckCore);
    const puckHalo = new THREE.Mesh(
      new THREE.TorusGeometry(s.puckRadius * 0.82, 0.045, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xff7138, transparent: true, opacity: 0.82 })
    );
    puckHalo.rotation.x = Math.PI / 2;
    puckHalo.position.y = 0.16;
    puckMesh.add(puckHalo);
    const puckLight = new THREE.PointLight(0xff5b2e, 0.8, 4);
    puckLight.position.y = 0.35;
    puckMesh.add(puckLight);

    // 8. Arena Environment (Stands, Floating Arena Lights)
    const arenaDomeGeo = new THREE.SphereGeometry(45, 24, 16);
    const arenaDomeMat = new THREE.MeshBasicMaterial({
      color: 0x050b18,
      side: THREE.BackSide
    });
    const arenaDome = new THREE.Mesh(arenaDomeGeo, arenaDomeMat);
    scene.add(arenaDome);

    // Handle Window Resize
    const handleResize = () => {
      if (!container || !camera || !renderer) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    // Start with puck in the middle
    s.puckX = 0;
    s.puckZ = 4;
    s.puckVx = 0;
    s.puckVz = 0;
    s.isScoring = false;
    s.servePending = true;
    s.serveSide = 'p1';
    s.requestedServeX = null;
    setIsServing(true);
    setSelectedServeX(0);
    setAnnouncement('CHOOSE YOUR SERVE');

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      cancelAnimationFrame(s.animId);
    };
  }, [triggerSparks, servePuck]);

  // Input listeners (Mouse, Touch, Keyboard)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const s = stateRef.current;

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      const rect = container.getBoundingClientRect();
      const halfW = s.tableWidth / 2;
      const halfL = s.tableLength / 2;
      const p1ClampW = halfW - s.p1MalletRadius - 0.2;
      const p1ClampL = halfL - s.p1MalletRadius - 0.2;
      const p2ClampL = halfL - s.p2MalletRadius - 0.2;
      const sens = propsRef.current.mouseSensitivityMultiplier || 2.5;
      const isLocal = propsRef.current.mode === 'local';

      if ('touches' in e) {
        // Multi-touch support for local 2-player or single player
        for (let i = 0; i < e.touches.length; i++) {
          const t = e.touches[i];
          const clientX = t.clientX;
          const clientY = t.clientY;
          const normX = ((clientX - rect.left) / rect.width) * 2 - 1;
          const normY = ((clientY - rect.top) / rect.height) * 2 - 1;

          if (isLocal && normY < 0) {
            // Top half of screen controls Player 2 in local 2-player mode
            s.targetP2X = Math.max(-p1ClampW, Math.min(p1ClampW, normX * (halfW * sens)));
            const mappedZ = -1.0 - Math.max(0, Math.min(1, (-normY) * (sens * 0.5))) * (p2ClampL - 1.0);
            s.targetP2Z = Math.max(-p2ClampL, Math.min(-0.6, mappedZ));
          } else {
            // Bottom half or single player controls Player 1
            s.targetP1X = Math.max(-p1ClampW, Math.min(p1ClampW, normX * (halfW * sens)));
            const mappedZ = 1.0 + Math.max(0, Math.min(1, (normY) * (sens * 0.5))) * (p1ClampL - 1.0);
            s.targetP1Z = Math.max(0.6, Math.min(p1ClampL, mappedZ));
          }
        }
      } else {
        // Mouse event
        const clientX = e.clientX;
        const clientY = e.clientY;
        const normX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const normY = ((clientY - rect.top) / rect.height) * 2 - 1;

        if (isLocal && normY < 0) {
          s.targetP2X = Math.max(-p1ClampW, Math.min(p1ClampW, normX * (halfW * sens)));
          const mappedZ = -1.0 - Math.max(0, Math.min(1, (-normY) * (sens * 0.5))) * (p2ClampL - 1.0);
          s.targetP2Z = Math.max(-p2ClampL, Math.min(-0.6, mappedZ));
        } else {
          s.targetP1X = Math.max(-p1ClampW, Math.min(p1ClampW, normX * (halfW * sens)));
          const mappedZ = 1.0 + Math.max(0, Math.min(1, (normY) * (sens * 0.5))) * (p1ClampL - 1.0);
          s.targetP1Z = Math.max(0.6, Math.min(p1ClampL, mappedZ));
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      s.keys[e.key.toLowerCase()] = true;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      s.keys[e.key.toLowerCase()] = false;
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('touchmove', handlePointerMove, { passive: true });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Main 60FPS Physics & Render Loop
  useEffect(() => {
    const s = stateRef.current;

    let lastTime = performance.now();

    const loop = (time: number) => {
      s.animId = requestAnimationFrame(loop);

      const dt = Math.min((time - lastTime) / 1000, 0.033);
      lastTime = time;

      const currentMode = propsRef.current.mode;
      const currentDifficulty = propsRef.current.botDifficulty;
      if (
        currentMode === 'online_host' &&
        s.servePending &&
        s.serveSide === 'p2' &&
        s.requestedServeX !== null
      ) {
        servePuck('p2', s.requestedServeX);
      }
      if (
        currentMode === 'bot' &&
        s.servePending &&
        s.serveSide === 'p2' &&
        s.botServeReadyAt > 0 &&
        time >= s.botServeReadyAt
      ) {
        servePuck('p2', 0);
      }
      if (
        currentMode === 'online_host' &&
        time - s.lastRemotePaddleUpdateTime > 150
      ) {
        s.p2Vx = 0;
        s.p2Vz = 0;
      }
      const halfW = s.tableWidth / 2;
      const halfL = s.tableLength / 2;
      const goalHalfW = s.goalWidth / 2;
      const puckR = s.puckRadius;
      const goalOpeningHalfWidth = goalHalfW - puckR;
      const malletR1 = s.p1MalletRadius;
      const malletR2 = currentMode === 'online_host' || currentMode === 'online_guest'
        ? malletR1
        : s.p2MalletRadius;

      // 1. Update Player 1 position (Smooth lerp with velocity calculation)
      // Keyboard support for Player 1:
      const speed = 18 * dt;
      if (s.keys['a'] || s.keys['arrowleft']) s.targetP1X -= speed;
      if (s.keys['d'] || s.keys['arrowright']) s.targetP1X += speed;
      if (s.keys['w'] || s.keys['arrowup']) s.targetP1Z -= speed;
      if (s.keys['s'] || s.keys['arrowdown']) s.targetP1Z += speed;

      // Clamp Player 1 to their half (Z > 0.6)
      const p1ClampW = halfW - malletR1 - 0.2;
      const p1ClampL = halfL - malletR1 - 0.2;
      s.targetP1X = Math.max(-p1ClampW, Math.min(p1ClampW, s.targetP1X));
      s.targetP1Z = Math.max(0.6, Math.min(p1ClampL, s.targetP1Z));

      s.p1PrevX = s.p1X;
      s.p1PrevZ = s.p1Z;

      // Direct responsive physics follow (snappy with zero sluggish lag)
      const lerpFactor = 0.92;
      s.p1X += (s.targetP1X - s.p1X) * lerpFactor;
      s.p1Z += (s.targetP1Z - s.p1Z) * lerpFactor;

      s.p1Vx = (s.p1X - s.p1PrevX) / dt;
      s.p1Vz = (s.p1Z - s.p1PrevZ) / dt;

      // 2. Update Player 2 / Opponent
      if (currentMode === 'bot') {
        const isGracePeriod = performance.now() < s.botGracePeriodUntil;
        if (isGracePeriod) {
          // Grace period after goal: Bot holds ready defensive position and DOES NOT strike puck!
          const readyZ = -halfL + 3.4;
          s.p2PrevX = s.p2X;
          s.p2PrevZ = s.p2Z;
          s.p2X += (0 - s.p2X) * Math.min(1, 14 * dt);
          s.p2Z += (readyZ - s.p2Z) * Math.min(1, 14 * dt);
          s.p2Vx = 0;
          s.p2Vz = 0;
        } else {
          // Multi-tiered AI Engine - nerfed slightly so player can score easily!
          const botConfig = {
            rookie: { speed: 6,  aggro: 0.2,  predict: 0.15, lunge: 0.1,  aimOffset: 0.1,  reactDelay: 0.4 },
            pro:    { speed: 9,  aggro: 0.3,  predict: 0.25, lunge: 0.2,  aimOffset: 0.2,  reactDelay: 0.3 },
            master: { speed: 13, aggro: 0.45, predict: 0.4,  lunge: 0.35, aimOffset: 0.3,  reactDelay: 0.2 },
            cyber:  { speed: 17, aggro: 0.6,  predict: 0.5,  lunge: 0.5,  aimOffset: 0.45, reactDelay: 0.15 },
            god:    { speed: 21, aggro: 0.75, predict: 0.6,  lunge: 0.65, aimOffset: 0.6,  reactDelay: 0.1 }
          }[currentDifficulty] || { speed: 9, aggro: 0.3, predict: 0.25, lunge: 0.2, aimOffset: 0.2, reactDelay: 0.3 };

          const baseDefendZ = -halfL + 2.5;
          let targetX = 0;
          let targetZ = baseDefendZ;

          // Puck approaching bot half or loose on bot half
          const isApproaching = s.puckVz < -0.5;
          const isPuckOnBotHalf = s.puckZ < 0;

          if (isApproaching || isPuckOnBotHalf) {
            // Analytical Wall-Bounce Reflection Raycasting
            const interceptZ = isPuckOnBotHalf ? Math.min(-1.5, s.puckZ) : baseDefendZ;
            const deltaZ = Math.abs(s.puckZ - interceptZ);
            const timeToIntercept = Math.max(0.01, deltaZ / Math.max(2, Math.abs(s.puckVz)));

            // Project X forward with multi-wall reflection folding
            const rawFutureX = s.puckX + s.puckVx * timeToIntercept * botConfig.predict;
            const minRailX = -halfW + puckR;
            const maxRailX = halfW - puckR;
            const tableSpan = maxRailX - minRailX;

            let foldedX = rawFutureX - minRailX;
            const bounceCount = Math.floor(foldedX / tableSpan);
            let remX = foldedX % tableSpan;
            if (remX < 0) remX += tableSpan;

            let predictedX = (Math.abs(bounceCount) % 2 === 0)
              ? (minRailX + remX)
              : (maxRailX - remX);

            // Strategic aiming: If bot can strike puck, offset position to angle puck away from player
            if (isPuckOnBotHalf && Math.abs(s.puckZ - s.p2Z) < 3.0) {
              const openCornerSign = s.p1X >= 0 ? -1 : 1;
              const shotAngleOffset = openCornerSign * (s.p2MalletRadius * 0.35) * botConfig.aimOffset;
              targetX = Math.max(-p1ClampW, Math.min(p1ClampW, s.puckX - shotAngleOffset));

              // Aggressive forward lunge to strike puck
              targetZ = Math.min(-0.8, s.puckZ + (s.p2MalletRadius * 0.6 * botConfig.lunge));
            } else {
              targetX = Math.max(-p1ClampW, Math.min(p1ClampW, predictedX));
              targetZ = Math.min(-1.5, Math.max(-halfL + 1.2, isPuckOnBotHalf ? s.puckZ - 1.2 : baseDefendZ));
            }
          } else {
            // Puck is on player's half: mirror puck X smoothly to guard center & cut off bank angles
            targetX = Math.max(-p1ClampW * 0.7, Math.min(p1ClampW * 0.7, s.puckX * 0.55));
            targetZ = baseDefendZ;
          }

          const stepX = (targetX - s.p2X);
          const stepZ = (targetZ - s.p2Z);
          const dist = Math.sqrt(stepX * stepX + stepZ * stepZ);
          const maxStep = botConfig.speed * dt;

          s.p2PrevX = s.p2X;
          s.p2PrevZ = s.p2Z;

          if (dist > 0.01) {
            s.p2X += (stepX / dist) * Math.min(dist, maxStep);
            s.p2Z += (stepZ / dist) * Math.min(dist, maxStep);
          }

          // Clamp Bot to its half (Z <= -0.6)
          s.p2X = Math.max(-p1ClampW, Math.min(p1ClampW, s.p2X));
          s.p2Z = Math.max(-p1ClampL, Math.min(-0.6, s.p2Z));

          s.p2Vx = (s.p2X - s.p2PrevX) / dt;
          s.p2Vz = (s.p2Z - s.p2PrevZ) / dt;
        }

      } else if (currentMode === 'local') {
        // Local Player 2 keyboard (IJKL or Numpad)
        const p2Speed = 22 * dt;
        if (s.keys['j']) s.targetP2X -= p2Speed;
        if (s.keys['l']) s.targetP2X += p2Speed;
        if (s.keys['i']) s.targetP2Z -= p2Speed;
        if (s.keys['k']) s.targetP2Z += p2Speed;

        s.targetP2X = Math.max(-p1ClampW, Math.min(p1ClampW, s.targetP2X));
        s.targetP2Z = Math.max(-p1ClampL, Math.min(-0.6, s.targetP2Z));

        s.p2PrevX = s.p2X;
        s.p2PrevZ = s.p2Z;

        s.p2X += (s.targetP2X - s.p2X) * lerpFactor;
        s.p2Z += (s.targetP2Z - s.p2Z) * lerpFactor;

        s.p2Vx = (s.p2X - s.p2PrevX) / dt;
        s.p2Vz = (s.p2Z - s.p2PrevZ) / dt;
      }

      // 3. Puck Physics Sub-stepping (Host authoritative or Single-player)
      const isSimulatingPhysics = currentMode !== 'online_guest';

      if (isSimulatingPhysics && !s.gameOver && !s.servePending) {
        const subSteps = 6;
        const subDt = dt / subSteps;

        for (let step = 0; step < subSteps; step++) {
          // Friction / Air cushion: slide smoothly with very low drag
          const drag = Math.exp(-0.08 * subDt);
          s.puckVx *= drag;
          s.puckVz *= drag;

          // Integrate position
          s.puckX += s.puckVx * subDt;
          s.puckZ += s.puckVz * subDt;

          // Paddle 1 Collision
          const dx1 = s.puckX - s.p1X;
          const dz1 = s.puckZ - s.p1Z;
          const dist1 = Math.sqrt(dx1 * dx1 + dz1 * dz1);
          const minDist1 = puckR + malletR1;

          if (dist1 < minDist1 && dist1 > 0.0001) {
            const nx = dx1 / dist1;
            const nz = dz1 / dist1;

            // Push puck out of mallet
            s.puckX = s.p1X + nx * minDist1;
            s.puckZ = s.p1Z + nz * minDist1;

            // Relative velocity
            const relVx = s.puckVx - s.p1Vx;
            const relVz = s.puckVz - s.p1Vz;
            const normVel = relVx * nx + relVz * nz;

            if (normVel < 0) {
              const restitution = 1.45;
              const impulse = -(1 + restitution) * normVel;
              s.puckVx += nx * impulse + s.p1Vx * 0.7;
              s.puckVz += nz * impulse + s.p1Vz * 0.7;

              // Ensure crisp energetic exit velocity so puck never dies
              const exitSpd = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
              if (exitSpd < 12) {
                const boost = 12 / Math.max(0.1, exitSpd);
                s.puckVx *= boost;
                s.puckVz *= boost;
              }

              // Sound & Sparks
              sound.playPaddleHit(Math.min(2, exitSpd / 12));
              triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 14);
              s.lastTouchedBy = 'player';
            }
          }

          // Paddle 2 Collision (Bot / Opponent)
          const dx2 = s.puckX - s.p2X;
          const dz2 = s.puckZ - s.p2Z;
          const dist2 = Math.sqrt(dx2 * dx2 + dz2 * dz2);
          const minDist2 = puckR + malletR2;

          if (dist2 < minDist2 && dist2 > 0.0001) {
            const nx = dx2 / dist2;
            const nz = dz2 / dist2;

            s.puckX = s.p2X + nx * minDist2;
            s.puckZ = s.p2Z + nz * minDist2;

            const relVx = s.puckVx - s.p2Vx;
            const relVz = s.puckVz - s.p2Vz;
            const normVel = relVx * nx + relVz * nz;

            if (normVel < 0) {
              const restitution = 1.45;
              const impulse = -(1 + restitution) * normVel;
              s.puckVx += nx * impulse + s.p2Vx * 0.7;
              s.puckVz += nz * impulse + s.p2Vz * 0.7;

              const exitSpd = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
              if (exitSpd < 12) {
                const boost = 12 / Math.max(0.1, exitSpd);
                s.puckVx *= boost;
                s.puckVz *= boost;
              }

              sound.playPaddleHit(Math.min(2, exitSpd / 12));
              triggerSparks(s.puckX, 0.2, s.puckZ, 0xff0066, 14);
              s.lastTouchedBy = 'opponent';
            }
          }

          // 4 Rounded Corner Physics (fillet radius = 2.0)
          const cornerR = 2.0;
          const minCornerX = -halfW + cornerR;
          const maxCornerX = halfW - cornerR;
          const minCornerZ = -halfL + cornerR;
          const maxCornerZ = halfL - cornerR;

          // Corner collision test helper
          const checkCornerArc = (cx: number, cz: number, isLeft: boolean, isTop: boolean) => {
            const inCornerX = isLeft ? s.puckX < cx : s.puckX > cx;
            const inCornerZ = isTop ? s.puckZ < cz : s.puckZ > cz;
            if (inCornerX && inCornerZ) {
              const dx = s.puckX - cx;
              const dz = s.puckZ - cz;
              const dist = Math.sqrt(dx * dx + dz * dz);
              const maxDist = cornerR - puckR;
              if (dist >= maxDist && dist > 0.0001) {
                // Circle normal pointing inward towards rink
                const nx = -dx / dist;
                const nz = -dz / dist;
                s.puckX = cx - (dx / dist) * (maxDist - 0.02);
                s.puckZ = cz - (dz / dist) * (maxDist - 0.02);

                const dot = s.puckVx * nx + s.puckVz * nz;
                if (dot < 0) {
                  s.puckVx -= (1 + 0.985) * dot * nx;
                  s.puckVz -= (1 + 0.985) * dot * nz;
                  sound.playWallHit(Math.max(0.3, Math.abs(dot) / 10));
                  triggerSparks(s.puckX, 0.2, s.puckZ, isTop ? 0xff0066 : 0x00e5ff, 8);
                }
              }
              // Anti-stuck safeguard: ensure puck never wedges in a corner
              const curSpeed = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
              if (curSpeed < 6) {
                s.puckVx = isLeft ? 12 : -12;
                s.puckVz = isTop ? 12 : -12;
              }
              return true;
            }
            return false;
          };

          const hitTL = checkCornerArc(minCornerX, minCornerZ, true, true);
          const hitTR = checkCornerArc(maxCornerX, minCornerZ, false, true);
          const hitBL = checkCornerArc(minCornerX, maxCornerZ, true, false);
          const hitBR = checkCornerArc(maxCornerX, maxCornerZ, false, false);

          // Rounded goal posts keep edge shots from catching on the goal frame.
          const postRadius = puckR + 0.12;
          for (const postX of [-goalHalfW, goalHalfW]) {
            for (const postZ of [-halfL - 0.35, halfL + 0.35]) {
              const dx = s.puckX - postX;
              const dz = s.puckZ - postZ;
              const distance = Math.sqrt(dx * dx + dz * dz);
              if (distance >= postRadius || distance < 0.0001) continue;

              const nx = dx / distance;
              const nz = dz / distance;
              s.puckX = postX + nx * postRadius;
              s.puckZ = postZ + nz * postRadius;
              const impactSpeed = s.puckVx * nx + s.puckVz * nz;
              if (impactSpeed < 0) {
                s.puckVx -= 1.9 * impactSpeed * nx;
                s.puckVz -= 1.9 * impactSpeed * nz;
              }
            }
          }

          // Straight Rail Collisions
          // Left Wall
          if (!hitTL && !hitBL && s.puckX - puckR < -halfW) {
            s.puckX = -halfW + puckR;
            s.puckVx = Math.abs(s.puckVx) * 0.985;
            sound.playWallHit(Math.abs(s.puckVx) / 10);
            triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 6);
          }
          // Right Wall
          if (!hitTR && !hitBR && s.puckX + puckR > halfW) {
            s.puckX = halfW - puckR;
            s.puckVx = -Math.abs(s.puckVx) * 0.985;
            sound.playWallHit(Math.abs(s.puckVx) / 10);
            triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 6);
          }

          // Top Wall & Goal Alcove Pocket (Opponent Side / P2 Goal)
          if (!hitTL && !hitTR) {
            if (Math.abs(s.puckX) <= goalOpeningHalfWidth) {
              if (s.puckZ + puckR <= -halfL && !s.isScoring) {
                const ownGoal =
                  currentMode === 'online_host' &&
                  !propsRef.current.allowOwnGoals &&
                  s.lastTouchedBy === 'opponent';
                if (ownGoal) {
                  s.puckZ = -halfL + puckR;
                  s.puckVz = Math.max(2, Math.abs(s.puckVz) * 1.1);
                  sound.playWallHit(1);
                  triggerSparks(s.puckX, 0.2, s.puckZ, 0xff0066, 10);
                  continue;
                }
                handleGoal('player');
                break;
              }
            } else {
              if (s.puckZ - puckR <= -halfL) {
                s.puckZ = -halfL + puckR;
                if (s.puckVz < 0) s.puckVz = Math.max(1.5, Math.abs(s.puckVz) * 0.94);
                sound.playWallHit(Math.abs(s.puckVz) / 10);
                triggerSparks(s.puckX, 0.2, s.puckZ, 0xff0066, 6);
              }
            }
          }

          // Bottom Wall & Goal Alcove Pocket (Player 1 Side / P1 Goal)
          if (!hitBL && !hitBR) {
            if (Math.abs(s.puckX) <= goalOpeningHalfWidth) {
              if (s.puckZ - puckR >= halfL && !s.isScoring) {
                const ownGoal =
                  currentMode === 'online_host' &&
                  !propsRef.current.allowOwnGoals &&
                  s.lastTouchedBy === 'player';
                const puckSpd = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
                if (
                  ownGoal ||
                  (currentMode !== 'online_host' && s.lastTouchedBy === 'player' && puckSpd < 25)
                ) {
                  s.puckZ = halfL - puckR;
                  s.puckVz = -Math.max(2, Math.abs(s.puckVz) * (ownGoal ? 1.1 : 1.2));
                  sound.playWallHit(1.0);
                  triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 10);
                } else {
                  handleGoal('opponent');
                  break;
                }
              }
            } else {
              if (s.puckZ + puckR >= halfL) {
                s.puckZ = halfL - puckR;
                if (s.puckVz > 0) s.puckVz = -Math.max(1.5, Math.abs(s.puckVz) * 0.94);
                sound.playWallHit(Math.abs(s.puckVz) / 10);
                triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 6);
              }
            }
          }

          // Absolute bounds safety guard: ensure puck NEVER clips out of bounds
          s.puckX = Math.max(-halfW + puckR, Math.min(halfW - puckR, s.puckX));
          if (Math.abs(s.puckX) > goalOpeningHalfWidth) {
            s.puckZ = Math.max(-halfL + puckR, Math.min(halfL - puckR, s.puckZ));
          } else {
            const maxGoalDepth = goalHalfW;
            s.puckZ = Math.max(-halfL - maxGoalDepth + puckR, Math.min(halfL + maxGoalDepth - puckR, s.puckZ));
          }

          // High-velocity arcade speed cap
          const maxSpd = 50;
          const currSpd = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
          if (currSpd > maxSpd) {
            s.puckVx = (s.puckVx / currSpd) * maxSpd;
            s.puckVz = (s.puckVz / currSpd) * maxSpd;
          }
        }
      }

      // Predict local guest mallet hits while the host's authoritative puck update is in flight.
      if (currentMode === 'online_guest' && !s.gameOver && !s.servePending) {
        const dx = s.puckX - s.p1X;
        const dz = s.puckZ - s.p1Z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const minDistance = puckR + malletR1;

        if (distance > minDistance + 0.2) {
          s.isGuestPredictingPaddleHit = false;
        } else if (distance < minDistance && distance > 0.0001 && !s.isGuestPredictingPaddleHit) {
          const nx = dx / distance;
          const nz = dz / distance;
          s.puckX = s.p1X + nx * minDistance;
          s.puckZ = s.p1Z + nz * minDistance;

          const relativeVx = s.puckVx - s.p1Vx;
          const relativeVz = s.puckVz - s.p1Vz;
          const normalVelocity = relativeVx * nx + relativeVz * nz;

          if (normalVelocity < 0) {
            const impulse = -(1 + 1.45) * normalVelocity;
            s.puckVx += nx * impulse + s.p1Vx * 0.7;
            s.puckVz += nz * impulse + s.p1Vz * 0.7;

            const exitSpeed = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
            if (exitSpeed < 12) {
              const boost = 12 / Math.max(0.1, exitSpeed);
              s.puckVx *= boost;
              s.puckVz *= boost;
            }

            s.lastTouchedBy = 'player';
            sound.playPaddleHit(Math.min(2, exitSpeed / 12));
            triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 14);
          }
          s.isGuestPredictingPaddleHit = true;
        }
      }

      // 4. Goal Detection Handler
      function handleGoal(scorer: 'player' | 'opponent') {
        if (s.isScoring || s.gameOver) return;
        s.isScoring = true;

        sound.playGoal();
        if (scorer === 'player') {
          confetti({
            particleCount: 60,
            spread: 60,
            origin: { y: 0.2 },
            colors: ['#00e5ff', '#0070f3', '#ffffff']
          });
        }

        const newP1 = scorer === 'player' ? s.p1Score + 1 : s.p1Score;
        const newP2 = scorer === 'opponent' ? s.p2Score + 1 : s.p2Score;
        s.p1Score = newP1;
        s.p2Score = newP2;
        setPlayerScore(newP1);
        setOpponentScore(newP2);

        propsRef.current.onGoalScored?.(scorer, { player: newP1, opponent: newP2 });
        propsRef.current.onScoreUpdate?.({ player: newP1, opponent: newP2 });

        const nextServer = scorer === 'player' ? 'p2' : 'p1';
        s.servePending = true;
        s.serveSide = nextServer;
        s.requestedServeX = null;
        s.puckX = 0;
        s.puckZ = nextServer === 'p1' ? 4 : -4;
        s.puckVx = 0;
        s.puckVz = 0;
        s.botGracePeriodUntil = performance.now() + 1800;
        s.botServeReadyAt = currentMode === 'bot' && nextServer === 'p2'
          ? performance.now() + 1800
          : 0;
        setIsServing(true);
        setSelectedServeX(0);
        setAnnouncement(nextServer === 'p1' ? 'YOUR SERVE' : 'OPPONENT SERVE');

        if (newP1 >= propsRef.current.winningScore || newP2 >= propsRef.current.winningScore) {
          s.gameOver = true;
          s.servePending = false;
          setIsServing(false);
          const matchWinner = newP1 >= propsRef.current.winningScore ? 'player' : 'opponent';
          setWinner(matchWinner);
          setAnnouncement(matchWinner === 'player' ? 'VICTORY!' : 'GAME OVER');
          propsRef.current.onGameOver?.(matchWinner, { player: newP1, opponent: newP2 });
        } else {
          setTimeout(() => {
            s.isScoring = false;
            setAnnouncement('');
          }, 1500);
        }
      }

      // 5. Update 3D Meshes
      if (s.puckMesh) {
        s.puckMesh.position.x = s.puckX;
        s.puckMesh.position.z = s.puckZ;
        s.puckMesh.rotation.y += (s.puckVx + s.puckVz) * 0.1;
      }
      if (s.p1Mesh) {
        s.p1Mesh.position.x = s.p1X;
        s.p1Mesh.position.z = s.p1Z;
        s.p1Mesh.scale.setScalar(s.p1MalletRadius / 1.4);
      }
      if (s.p2Mesh) {
        s.p2Mesh.position.x = s.p2X;
        s.p2Mesh.position.z = s.p2Z;
        const onlineMalletScale = currentMode === 'online_host' || currentMode === 'online_guest'
          ? malletR1 / s.p2MalletRadius
          : 1;
        s.p2Mesh.scale.setScalar(onlineMalletScale);
      }

      // 6. Update Spark Particles
      for (let i = s.particles.length - 1; i >= 0; i--) {
        const p = s.particles[i];
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.vy -= 9.8 * dt; // Gravity
        p.life -= dt;

        if (p.life <= 0) {
          s.scene?.remove(p.mesh);
          p.mesh.geometry.dispose();
          s.particles.splice(i, 1);
        }
      }

      // 7. Dynamic Camera Update based on selected View
      if (s.camera) {
        const camMode = propsRef.current.cameraView;
        if (camMode === 'top') {
          // Fixed, static Top View that DOES NOT MOVE the screen at all!
          // Adjusted height ensures both nets (z = -14.8 to +14.8) are completely visible
          s.camera.up.set(0, 0, -1);
          const container = containerRef.current;
          const aspect = container ? (container.clientWidth / Math.max(1, container.clientHeight)) : 1.6;
          const topH = aspect < 1.1 ? Math.max(34, 34 / aspect) : 34;
          s.camera.position.set(0, topH, 0.001);
          s.camera.lookAt(0, 0, 0);

        } else if (camMode === 'fpv') {
          s.camera.up.set(0, 1, 0);
          // True First-Person View behind Player 1 mallet looking forward
          const targetCamX = s.p1X * 0.45;
          const targetCamY = 3.6;
          const targetCamZ = s.p1Z + 4.8;

          s.camera.position.x += (targetCamX - s.camera.position.x) * 0.15;
          s.camera.position.y += (targetCamY - s.camera.position.y) * 0.15;
          s.camera.position.z += (targetCamZ - s.camera.position.z) * 0.15;

          // Look at center-forward table area with dynamic slight puck tracking
          const lookAtX = s.puckX * 0.35;
          const lookAtZ = s.p1Z - 9;
          s.camera.lookAt(lookAtX, 0.6, lookAtZ);

        } else if (camMode === 'action') {
          s.camera.up.set(0, 1, 0);
          // Action dynamic camera tracking the puck
          s.camera.position.set(s.puckX * 0.25, 9.5, s.tableLength * 0.6);
          s.camera.lookAt(s.puckX * 0.6, 0.2, s.puckZ * 0.6);
        } else {
          s.camera.up.set(0, 1, 0);
          // Classic angled perspective
          s.camera.position.set(0, 16, s.tableLength * 0.72);
          s.camera.lookAt(0, 0, 0);
        }
      }

      // Exchange only the latest inputs and authoritative puck state over WebRTC.
      if (currentMode === 'online_host' && time - s.lastSyncTime > 30) {
        s.lastSyncTime = time;
        sendPeerPacket(propsRef.current.gameDataChannel, {
          type: 'host-state',
          puckX: s.puckX,
          puckZ: s.puckZ,
          puckVx: s.puckVx,
          puckVz: s.puckVz,
          hostPaddleX: s.p1X,
          hostPaddleZ: s.p1Z,
          hostScore: s.p1Score,
          guestScore: s.p2Score,
          gameOver: s.gameOver,
          servePending: s.servePending,
          serveSide: s.serveSide
        });
      } else if (currentMode === 'online_guest' && time - s.lastSyncTime > 16) {
        s.lastSyncTime = time;
        sendPeerPacket(propsRef.current.gameDataChannel, {
          type: 'guest-input',
          x: s.p1X,
          z: s.p1Z,
          vx: s.p1Vx,
          vz: s.p1Vz
        });
      }

      // Render Three.js scene
      if (s.renderer && s.scene && s.camera) {
        s.renderer.render(s.scene, s.camera);
      }
    };

    s.animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(s.animId);
    };
  }, [triggerSparks, servePuck]);

  const localServeSide = mode === 'online_guest' ? 'p2' : mode === 'online_host' ? 'p1' : stateRef.current.serveSide;
  const canChooseServe = mode === 'local' ||
    (mode === 'online_guest' && stateRef.current.serveSide === 'p2') ||
    (mode === 'online_host' && stateRef.current.serveSide === 'p1') ||
    (mode === 'bot' && stateRef.current.serveSide === 'p1');
  const submitServe = (serveX = selectedServeX) => {
    if (mode === 'online_guest') {
      sendPeerPacket(gameDataChannel, { type: 'serve-request', x: serveX });
      setAnnouncement('SERVE REQUESTED');
      return;
    }
    servePuck(localServeSide, serveX);
  };
  const pickRandomServe = () => {
    const spots = [-3.5, 0, 3.5];
    const randomServeX = spots[Math.floor(Math.random() * spots.length)];
    setSelectedServeX(randomServeX);
    submitServe(randomServeX);
  };
  const toggleHelp = () => {
    const nextHelpDisabled = !helpDisabled;
    stateRef.current.p1MalletRadius = nextHelpDisabled
      ? stateRef.current.p2MalletRadius
      : 1.4;
    setHelpDisabled(nextHelpDisabled);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full select-none overflow-hidden bg-slate-950 cursor-crosshair"
    >
      <canvas ref={canvasRef} className="block w-full h-full" />

      {/* Sleek, Non-Intrusive Top HUD Announcement Banner */}
      {announcement && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none text-center animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="px-5 py-1.5 rounded-full bg-slate-950/85 border border-cyan-400/40 backdrop-blur-md shadow-lg shadow-cyan-950/50 flex items-center gap-2.5">
            <div className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
            <span className="text-xs sm:text-sm font-black tracking-widest uppercase text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-white to-pink-400 drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]">
              {announcement}
            </span>
          </div>
        </div>
      )}

      {isServing && stateRef.current.servePending && !winner && (
        <div className="absolute bottom-14 sm:bottom-5 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="rounded-xl border border-cyan-400/40 bg-slate-950/90 px-3 py-2 text-center shadow-lg shadow-cyan-950/40 backdrop-blur-md pointer-events-auto">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cyan-300">
              {canChooseServe ? 'Choose serve position' : 'Waiting for opponent to serve'}
            </p>
            {canChooseServe ? (
              <>
                <div className="flex items-center justify-center gap-1.5">
                  {[
                    { x: -3.5, label: 'Left' },
                    { x: 0, label: 'Center' },
                    { x: 3.5, label: 'Right' }
                  ].map(spot => (
                    <button
                      key={spot.label}
                      onClick={() => setSelectedServeX(spot.x)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${
                        selectedServeX === spot.x
                          ? 'border-cyan-300 bg-cyan-400/20 text-cyan-100'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-cyan-500/50'
                      }`}
                    >
                      {spot.label}
                    </button>
                  ))}
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => submitServe()}
                    className="flex-1 rounded-lg bg-gradient-to-r from-cyan-400 to-blue-500 px-3 py-1.5 text-xs font-black uppercase tracking-wider text-slate-950 transition hover:brightness-110"
                  >
                    Serve
                  </button>
                  <button
                    onClick={pickRandomServe}
                    className="flex-1 rounded-lg border border-violet-400/50 bg-violet-500/15 px-3 py-1.5 text-xs font-bold text-violet-100 transition hover:bg-violet-500/25"
                  >
                    Random Serve
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-400">The puck is held until the server chooses a spot.</p>
            )}
          </div>
        </div>
      )}

      {mode === 'bot' && !winner && (
        <button
          onClick={toggleHelp}
          className="absolute top-14 left-3 z-20 rounded-lg border border-slate-700 bg-slate-950/85 px-3 py-2 text-xs font-bold text-slate-200 shadow-lg backdrop-blur transition hover:border-cyan-400/60 hover:text-cyan-100"
          aria-pressed={helpDisabled}
        >
          {helpDisabled ? 'Enable Help' : 'Disable Help'}
        </button>
      )}

      {/* Game Over Screen */}
      {winner && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-md p-8 rounded-2xl bg-slate-900 border border-cyan-500/50 shadow-2xl shadow-cyan-900/60 text-center animate-in zoom-in-95">
            <div className="inline-block px-4 py-1 mb-4 rounded-full text-xs font-mono font-semibold tracking-wider bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase">
              Match Completed
            </div>

            <h2 className={`text-4xl font-extrabold mb-2 tracking-tight ${winner === 'player' ? 'text-cyan-400 drop-shadow-[0_0_15px_rgba(6,182,212,0.8)]' : 'text-rose-400 drop-shadow-[0_0_15px_rgba(244,63,94,0.8)]'}`}>
              {winner === 'player' ? 'YOU WON!' : 'OPPONENT WON!'}
            </h2>

            <p className="text-sm text-slate-300 mb-6">
              Final Score: <span className="font-mono font-bold text-cyan-400">{playerScore}</span> - <span className="font-mono font-bold text-rose-400">{opponentScore}</span>
            </p>

            <button
              onClick={resetMatch}
              className="w-full py-3.5 px-6 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 shadow-lg shadow-cyan-500/30 active:scale-95 transition"
            >
              Play Again
            </button>
          </div>
        </div>
      )}

      {/* Controls HUD Hint */}
      <div className="absolute bottom-3 left-4 z-20 pointer-events-none hidden sm:flex items-center gap-3 text-xs text-slate-400/80 font-mono">
        <span className="px-2 py-1 rounded bg-slate-900/80 border border-slate-800">
          Mouse / Touch / WASD: Move Mallet
        </span>
        <span className="px-2 py-1 rounded bg-slate-900/80 border border-slate-800">
          Fast Swipe: Power Strike
        </span>
      </div>

    </div>
  );
};
