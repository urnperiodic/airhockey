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

interface AirHockey3DProps {
  mode: GameMode;
  botDifficulty: BotDifficulty;
  winningScore: number;
  roomCode?: string;
  onlineRoom?: RoomRecord | null;
  cameraView: CameraView;
  mouseSensitivityMultiplier?: number;
  onGoalScored?: (scorer: 'player' | 'opponent', scores: { player: number; opponent: number }) => void;
  onScoreUpdate?: (scores: { player: number; opponent: number }) => void;
  onGameOver?: (winner: 'player' | 'opponent', scores: { player: number; opponent: number }) => void;
  onSyncRoom?: (room: Partial<RoomRecord>) => void;
}

export const AirHockey3D: React.FC<AirHockey3DProps> = ({
  mode,
  botDifficulty,
  winningScore = 10,
  roomCode,
  onlineRoom,
  cameraView,
  mouseSensitivityMultiplier = 2.5,
  onGoalScored,
  onScoreUpdate,
  onGameOver,
  onSyncRoom
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Score states
  const [playerScore, setPlayerScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [announcement, setAnnouncement] = useState<string>('GET READY');
  const [isServing, setIsServing] = useState(true);
  const [winner, setWinner] = useState<'player' | 'opponent' | null>(null);

  // References for render loop & physics mutable states to run at solid 60+ FPS without re-renders
  const stateRef = useRef({
    // Table dimensions
    tableWidth: 14,
    tableLength: 26,
    goalWidth: 3.2,
    puckRadius: 0.45,
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
    botGracePeriodUntil: 0,
    lastTouchedBy: null as 'player' | 'opponent' | null,

    // Online sync throttle
    lastSyncTime: 0,

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
    cameraView,
    mouseSensitivityMultiplier,
    onlineRoom,
    onGoalScored,
    onScoreUpdate,
    onGameOver,
    onSyncRoom
  });

  useEffect(() => {
    propsRef.current = {
      mode,
      botDifficulty,
      winningScore,
      cameraView,
      mouseSensitivityMultiplier,
      onlineRoom,
      onGoalScored,
      onScoreUpdate,
      onGameOver,
      onSyncRoom
    };
  }, [mode, botDifficulty, winningScore, cameraView, mouseSensitivityMultiplier, onlineRoom, onGoalScored, onScoreUpdate, onGameOver, onSyncRoom]);

  // Handle Online sync updates from props if guest
  useEffect(() => {
    if (mode === 'online_guest' && onlineRoom) {
      if (onlineRoom.puckX !== undefined && onlineRoom.puckY !== undefined) {
        // Map normalized room puck coordinates back to table
        stateRef.current.puckX = (onlineRoom.puckX - 0.5) * stateRef.current.tableWidth;
        stateRef.current.puckZ = (onlineRoom.puckY - 0.5) * stateRef.current.tableLength;
      }
      if (onlineRoom.hostPaddleX !== undefined && onlineRoom.hostPaddleY !== undefined) {
        // Host is P2 for the guest
        stateRef.current.p2X = (onlineRoom.hostPaddleX - 0.5) * stateRef.current.tableWidth;
        stateRef.current.p2Z = (onlineRoom.hostPaddleY - 0.5) * stateRef.current.tableLength;
      }
      if (onlineRoom.hostScore !== undefined && onlineRoom.guestScore !== undefined) {
        setPlayerScore(onlineRoom.guestScore);
        setOpponentScore(onlineRoom.hostScore);
        stateRef.current.p1Score = onlineRoom.guestScore;
        stateRef.current.p2Score = onlineRoom.hostScore;
      }
    } else if (mode === 'online_host' && onlineRoom) {
      if (onlineRoom.guestPaddleX !== undefined && onlineRoom.guestPaddleY !== undefined) {
        // Guest is P2 for the host
        stateRef.current.p2X = (onlineRoom.guestPaddleX - 0.5) * stateRef.current.tableWidth;
        stateRef.current.p2Z = (onlineRoom.guestPaddleY - 0.5) * stateRef.current.tableLength;
      }
    }
  }, [onlineRoom, mode]);

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
  const servePuck = useCallback((towards: 'p1' | 'p2') => {
    const s = stateRef.current;
    s.puckX = 0;
    s.puckZ = towards === 'p1' ? 4 : -4;
    s.puckVx = (Math.random() - 0.5) * 2;
    s.puckVz = towards === 'p1' ? 1.5 : -1.5;
    s.servingWait = 1.0;
    setIsServing(true);
    setAnnouncement(towards === 'p1' ? 'YOUR SERVE' : 'OPPONENT SERVE');
    sound.playWhistle();

    setTimeout(() => {
      setIsServing(false);
      setAnnouncement('');
    }, 1200);
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
    s.puckZ = 0; // Starts in middle!
    s.puckVx = 0;
    s.puckVz = 0;
    s.botGracePeriodUntil = performance.now() + 1500;
    setPlayerScore(0);
    setOpponentScore(0);
    setWinner(null);
    setAnnouncement('FACEOFF');
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
      color: 0x0a1122,
      roughness: 0.15,
      metalness: 0.45,
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
        metalness: 0.6
      });
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
      const knob = new THREE.Mesh(knobGeo, knobMat);
      knob.position.y = 1.1;
      knob.castShadow = true;
      group.add(knob);

      // Neon Accent Ring
      const ringGeo = new THREE.TorusGeometry(radius * 0.7, 0.05, 12, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: glowColor });
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
      roughness: 0.1,
      metalness: 0.9,
      emissive: 0xff3300,
      emissiveIntensity: 0.4
    });
    const puckMesh = new THREE.Mesh(puckGeo, puckMat);
    puckMesh.position.set(0, 0.12, 0);
    puckMesh.castShadow = true;
    scene.add(puckMesh);
    s.puckMesh = puckMesh;

    // Puck glowing center core
    const puckCoreGeo = new THREE.CylinderGeometry(s.puckRadius * 0.55, s.puckRadius * 0.55, 0.26, 24);
    const puckCoreMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
    const puckCore = new THREE.Mesh(puckCoreGeo, puckCoreMat);
    puckMesh.add(puckCore);

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
    s.puckZ = 0;
    s.puckVx = 0;
    s.puckVz = 0;
    s.isScoring = false;
    setAnnouncement('FACEOFF');
    sound.playWhistle();
    setTimeout(() => {
      setAnnouncement('');
    }, 1000);

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
      const halfW = s.tableWidth / 2;
      const halfL = s.tableLength / 2;
      const goalHalfW = s.goalWidth / 2;
      const puckR = s.puckRadius;
      const malletR1 = s.p1MalletRadius;
      const malletR2 = s.p2MalletRadius;

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

      if (isSimulatingPhysics && !s.gameOver) {
        const subSteps = 6;
        const subDt = dt / subSteps;

        for (let step = 0; step < subSteps; step++) {
          // Friction / Air cushion: slide smoothly with very low drag
          s.puckVx *= 0.9992;
          s.puckVz *= 0.9992;

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
            if (Math.abs(s.puckX) <= goalHalfW) {
              if (s.puckZ <= -halfL && !s.isScoring) {
                handleGoal('player');
                break;
              }
            } else {
              if (s.puckZ <= -halfL) {
                s.puckZ = -halfL + puckR;
                s.puckVz = Math.abs(s.puckVz) * 0.985;
                sound.playWallHit(Math.abs(s.puckVz) / 10);
                triggerSparks(s.puckX, 0.2, s.puckZ, 0xff0066, 6);
              }
            }
          }

          // Bottom Wall & Goal Alcove Pocket (Player 1 Side / P1 Goal)
          if (!hitBL && !hitBR) {
            if (Math.abs(s.puckX) <= goalHalfW) {
              if (s.puckZ >= halfL && !s.isScoring) {
                // Own-goal protection: make it much harder to own goal by bouncing out player-touched pucks unless hit hard
                const puckSpd = Math.sqrt(s.puckVx * s.puckVx + s.puckVz * s.puckVz);
                if (s.lastTouchedBy === 'player' && puckSpd < 25) {
                  s.puckZ = halfL - puckR - 0.25;
                  s.puckVz = -Math.abs(s.puckVz) * 1.5 - 5;
                  sound.playWallHit(1.0);
                  triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 10);
                } else {
                  handleGoal('opponent');
                  break;
                }
              }
            } else {
              if (s.puckZ >= halfL) {
                s.puckZ = halfL - puckR;
                s.puckVz = -Math.abs(s.puckVz) * 0.985;
                sound.playWallHit(Math.abs(s.puckVz) / 10);
                triggerSparks(s.puckX, 0.2, s.puckZ, 0x00e5ff, 6);
              }
            }
          }

          // Absolute bounds safety guard: ensure puck NEVER clips out of bounds
          s.puckX = Math.max(-halfW + puckR, Math.min(halfW - puckR, s.puckX));
          if (Math.abs(s.puckX) > goalHalfW) {
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

        // Instantly relocate puck to the opponent's side with grace period!
        if (scorer === 'player') {
          // Player scored: puck instantly goes to opponent's side
          s.puckX = 0;
          s.puckZ = -6.5;
          s.puckVx = 0;
          s.puckVz = 0;
          s.botGracePeriodUntil = performance.now() + 1800; // 1.8s grace period: Bot won't instantly smash puck!
          setAnnouncement('GOAL! OPPONENT SERVE');
        } else {
          // Opponent scored: puck instantly goes to player's side
          s.puckX = 0;
          s.puckZ = 6.5;
          s.puckVx = 0;
          s.puckVz = 0;
          s.botGracePeriodUntil = performance.now() + 1800; // Bot holds back!
          setAnnouncement('GOAL! YOUR SERVE');
        }

        if (newP1 >= propsRef.current.winningScore || newP2 >= propsRef.current.winningScore) {
          s.gameOver = true;
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
      }
      if (s.p2Mesh) {
        s.p2Mesh.position.x = s.p2X;
        s.p2Mesh.position.z = s.p2Z;
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

      // 8. Online Sync publishing (Throttled ~30fps for smooth network play)
      if (currentMode === 'online_host' && propsRef.current.onSyncRoom) {
        if (time - s.lastSyncTime > 40) {
          s.lastSyncTime = time;
          propsRef.current.onSyncRoom({
            puckX: (s.puckX / s.tableWidth) + 0.5,
            puckY: (s.puckZ / s.tableLength) + 0.5,
            puckVx: s.puckVx,
            puckVy: s.puckVz,
            hostPaddleX: (s.p1X / s.tableWidth) + 0.5,
            hostPaddleY: (s.p1Z / s.tableLength) + 0.5,
            hostScore: s.p1Score,
            guestScore: s.p2Score
          });
        }
      } else if (currentMode === 'online_guest' && propsRef.current.onSyncRoom) {
        if (time - s.lastSyncTime > 40) {
          s.lastSyncTime = time;
          propsRef.current.onSyncRoom({
            guestPaddleX: (s.p1X / s.tableWidth) + 0.5,
            guestPaddleY: (s.p1Z / s.tableLength) + 0.5
          });
        }
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
