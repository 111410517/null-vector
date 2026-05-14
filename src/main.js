import './style.css';
import './pwa.js';
import * as Matter from 'matter-js';
import * as PIXI from 'pixi.js';
import { CONFIG, calculateRadius } from './constants.js';
import { updateAI } from './ai.js';
import { updateDemoAI } from './demo-ai.js';
import {
  loadProgress, saveProgress, getLevelProgress, grantXP, grantGold,
  calculateXPReward, calculateGoldReward, unlockSkill, equipSkill, upgradeSkill,
  getXPForNextLevel, getXPForCurrentLevel, MAX_LEVEL
} from './progression.js';
import {
  SKILL_DEFS, createSkillState, getSkillDef, getSkillParam,
  canUseSkill, updateSkillCooldown, startCooldown, getCooldownProgress,
  addSkillEnergy
} from './skills.js';
import {
  initTutorial, showTutorialStep, isTutorialActive,
  getTutorialStep, setupTutorialHooks, onSkillEquipped
} from './tutorial.js';

// --- Game State ---
let app, engine, world;
let nodeLayer, entityLayer, virusLayer, powerupLayer, vfxLayer, gameContainer;
let player, entities = [], nodes = [], powerups = [];
let miniVFX = [];
let mousePos = { x: 0, y: 0 };
let isMouseMoved = false; // [NEW] 紀錄進入遊戲後是否移動過滑鼠
let joystick = { active: false, vector: { x: 0, y: 0 }, touchId: null };
let isGameOver = false;
let isGameRunning = false;
let isPaused = false;
let screenShake = 0;
let spawnedNPCs = 0; // Track spawned NPCs for win condition

// 手機設備檢測
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
let joyZone, joyThumb;
let skillDrag = { active: false, startX: 0, startY: 0, vector: { x: 0, y: 0 }, touchId: null };
let startTime = 0;
let elapsedTime = 0;
let tutorialPauseStart = 0;
let miniCanvas, miniCtx;
let boostAccumulator = 0;
let boostTextTimer = 0;
let rareItemSpawnTimer = 0;
let virusRespawnTimer = 0;

// --- Progression State ---
let progress = loadProgress();
let skillState = null;
let killCount = 0;
let comboCount = 0;
let lastKillTime = 0;
const COMBO_WINDOW = 5000; // 5 秒連擊窗口

/** 閃現技能的全域時間縮放 (1.0 = 正常, 0.3 = 減速) */
let timeScale = 1.0;
let fpsUpdateTimer = 0; // FPS 更新計時器

const NPC_NAMES = [
  "Shadow_Hunter", "Zephyr", "Apex_Void", "CyberPulse", "Neon_Ghost",
  "8822", "4040", "11111", "霧島", "Ø_X99_!!!"
];

// --- Loading Screen Logic ---
function updateLoadingProgress(percent) {
  const progressEl = document.querySelector('.loading-progress');
  if (progressEl) {
    progressEl.textContent = `${Math.round(percent)}%`;
  }
}

function hideLoadingScreen() {
  const screen = document.getElementById('loading-screen');
  if (screen) {
    screen.classList.add('fade-out');
    // 確保動畫結束後移除 DOM 或設置為不顯示
    setTimeout(() => {
      screen.style.display = 'none';
    }, 500);
  }
}

function showLoadingScreen(callback) {
  const screen = document.getElementById('loading-screen');
  if (screen) {
    screen.style.display = 'flex';
    screen.classList.remove('fade-out');
    updateLoadingProgress(0);

    // 模擬一個平滑的加載過程
    let loadPct = 0;
    const interval = setInterval(() => {
      loadPct += Math.random() * 15;
      if (loadPct >= 100) {
        loadPct = 100;
        updateLoadingProgress(loadPct);
        clearInterval(interval);
        setTimeout(() => {
          if (callback) callback();
          hideLoadingScreen();
        }, 200);
      } else {
        updateLoadingProgress(loadPct);
      }
    }, 50);
  } else if (callback) {
    callback();
  }
}

// --- Initialization ---
async function init() {
  updateLoadingProgress(10);
  app = new PIXI.Application();
  await app.init({
    width: window.innerWidth, height: window.innerHeight,
    backgroundColor: CONFIG.bgColor, antialias: true, resizeTo: window,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true
  });
  updateLoadingProgress(30);
  document.getElementById('app').prepend(app.canvas);

  engine = Matter.Engine.create();
  world = engine.world;
  world.gravity.y = 0;

  updateLoadingProgress(50);
  createGrid();
  initMinimap();
  loadHistory();
  initProgressionUI();

  // Create Layers
  gameContainer = new PIXI.Container();
  nodeLayer = new PIXI.Container();
  entityLayer = new PIXI.Container();
  virusLayer = new PIXI.Container();
  powerupLayer = new PIXI.Container();
  vfxLayer = new PIXI.Container();

  // Z-Order: Nodes -> Powerups -> Entities -> Viruses -> VFX
  gameContainer.addChild(nodeLayer, powerupLayer, entityLayer, virusLayer, vfxLayer);
  app.stage.addChild(gameContainer);

  updateLoadingProgress(70);
  // Create World Mask to clip everything outside boundaries
  const mask = new PIXI.Graphics();
  mask.rect(0, 0, CONFIG.worldSize, CONFIG.worldSize);
  mask.fill(0xffffff);
  gameContainer.mask = mask;
  app.stage.addChild(mask); // Mask needs to be on stage to work correctly in some PIXI versions

  // Initial NPCs (Demo background: spawn 4 specific NPCs)
  for (let i = 0; i < 4; i++) {
    const rx = CONFIG.worldSize / 2 + (Math.random() - 0.5) * 1500;
    const ry = CONFIG.worldSize / 2 + (Math.random() - 0.5) * 1500;
    if (i === 0) {
      // NPC 1: Hunter (Hits viruses)
      spawnNPC(i, rx, ry, 700, true, false, true, false, false, 1.0, 1.1);
    } else if (i === 1) {
      // NPC 2: Opportunist (Hunts NPC 1)
      spawnNPC(i, rx, ry, 500, false, true, true, true, false, 1.0, 1.1);
    } else if (i === 2) {
      // NPC 3: Speedster (Zips around)
      spawnNPC(i, rx, ry, 25, false, false, false, false, true, 0.25, 1.3);
    } else {
      // NPC 4: Normal
      spawnNPC(i, rx, ry, null, false, false, true, false, false, 1.0, 1.1);
    }
  }

  // Create Nodes
  for (let i = 0; i < CONFIG.nodeCount; i++) spawnNode();

  // Create Viruses (Mother Cells)
  for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

  setupInputs();

  // [NEW] Mobile Navigation Event Listeners
  document.querySelectorAll('.m-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'guide') {
        document.getElementById('overlay-guide').classList.add('active');
      } else {
        const tabBtn = document.querySelector(`.tab-btn[data-tab="${target}"]`);
        if (tabBtn) tabBtn.click();
        document.getElementById('overlay-features').classList.add('active');
      }
    });
  });

  document.querySelectorAll('.close-overlay-btn').forEach(btn => {
    const closeHandler = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.feature-overlay').forEach(ov => ov.classList.remove('active'));
    };
    btn.addEventListener('click', closeHandler);
    btn.addEventListener('touchstart', closeHandler, { passive: true });
  });

  document.getElementById('start-btn').onclick = () => {
    showLoadingScreen(startGame);
  };

  app.ticker.add((delta) => {
    update(delta);
  });

  updateLoadingProgress(100);
  setTimeout(() => {
    hideLoadingScreen();
    const startMenu = document.getElementById('start-menu');
    startMenu.classList.add('animate-in');
  }, 500);

  setInterval(updateLeaderboard, 1000);
}

/**
 * 清理遊戲世界中的所有動態物件
 */
function clearWorld() {
  // 1. Remove all entities, nodes, viruses and powerups
  entities.forEach(ent => {
    entityLayer.removeChild(ent.container);
    if (ent.indicator) app.stage.removeChild(ent.indicator);
    Matter.World.remove(world, ent.body);
  });
  nodes.forEach(node => {
    nodeLayer.removeChild(node.graphics);
    Matter.World.remove(world, node.body);
  });
  viruses.forEach(v => {
    virusLayer.removeChild(v.graphics);
    Matter.World.remove(world, v.body);
  });
  powerups.forEach(p => {
    powerupLayer.removeChild(p.container);
    Matter.World.remove(world, p.body);
  });

  // 2. Clear arrays
  entities = [];
  nodes = [];
  viruses = [];
  powerups = [];
  player = null;
}

function spawnNPC(index, customX, customY, customMass, isDemoScripted, avoidViruses, noBoost, isOpportunist, isAlwaysBoosting, growthEfficiency, speedMult) {
  const isSmart = isDemoScripted || isOpportunist || isAlwaysBoosting || (index < (CONFIG.npcCount * 0.5));
  let name;
  if (isDemoScripted) {
    name = "NULL_VECTOR_DEMO";
  } else if (isOpportunist) {
    name = "OPPORTUNIST_BOT";
  } else if (isAlwaysBoosting) {
    name = "SPEEDSTER_BOT";
  } else if (isSmart) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()";
    name = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } else {
    name = NPC_NAMES[index % (NPC_NAMES.length - 1)];
  }

  const x = customX !== undefined ? customX : Math.random() * CONFIG.worldSize;
  const y = customY !== undefined ? customY : Math.random() * CONFIG.worldSize;

  const initialMass = customMass || CONFIG.initialMass;
  const ent = createEntity(x, y, initialMass, name, false);
  ent.isSmart = isSmart;
  ent.isDemoScripted = isDemoScripted;
  ent.avoidViruses = avoidViruses;
  ent.noBoost = noBoost;
  ent.isOpportunist = isOpportunist;
  ent.isAlwaysBoosting = isAlwaysBoosting;
  ent.growthEfficiency = growthEfficiency || 1.0;
  ent.speedMult = speedMult || 1.0;
  ent.protectionTime = 0; // 進入遊戲不應該有保護時間
  ent.spawnDelay = customMass ? 0 : 1000;
  ent.efficiency = Math.random() > 0.5 ? 0.67 : 1.0;

  // [NEW] 播放與玩家同款的入場特效
  triggerSpawnVFX(x, y);
}

function startGame() {
  isGameOver = false;
  isPaused = false;
  isMouseMoved = false; // 重置滑鼠移動狀態
  comboCount = 0;
  lastKillTime = 0;
  const comboOverlay = document.getElementById('combo-overlay');
  if (comboOverlay) comboOverlay.classList.remove('active');
  const comboText = document.getElementById('combo-text-container');
  if (comboText) comboText.classList.remove('active');

  const fpsDisplay = document.getElementById('fps-display');
  if (fpsDisplay) {
    fpsDisplay.style.display = 'block';
    fpsDisplay.textContent = 'fps --';
  }

  app.ticker.speed = 1; // 確保速度恢復
  tutorialPauseStart = 0;
  clearWorld();
  killCount = 0;
  timeScale = 1.0;

  for (let i = 0; i < CONFIG.nodeCount; i++) spawnNode();
  for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

  const nameInput = document.getElementById('player-name-input').value || "PLAYER";
  player = createEntity(CONFIG.worldSize / 2, CONFIG.worldSize / 2, CONFIG.initialMass, nameInput, true);
  updateLivesUI();

  const equipped = progress.equippedSkill;
  const skillLevel = equipped ? (progress.skills[equipped]?.level || 1) : 0;
  skillState = createSkillState(equipped, skillLevel);
  updateInGameSkillButton();

  startTime = Date.now();
  isGameRunning = true;
  document.getElementById('start-menu').style.display = 'none';
  document.querySelector('.ui-overlay').style.display = 'block';

  // [NEW] 播放開場特效
  triggerSpawnVFX(player.body.position.x, player.body.position.y);

  // 教學延遲 3 秒觸發
  setTimeout(() => {
    if (!isGameRunning) return;
    if (!progress.tutorialIntroDone) {
      showTutorialStep(5);
    } else if (progress.equippedSkill === 'sprint' && !progress.tutorialSkillGameDone) {
      showTutorialStep(4);
    }
  }, 3000);

  // START RARE ITEM (Controlled by update loop timer)
  rareItemSpawnTimer = 30000;

  // 6. Start Spawning NPCs over time
  spawnedNPCs = 0;

  // [NEW] 立即對齊攝影機，防止瞬間移動
  if (player) {
    const baseZoom = isTouchDevice ? 0.55 : 0.85;
    app.stage.scale.set(baseZoom);
    app.stage.pivot.set(player.body.position.x, player.body.position.y);
  }

  const spawnInterval = setInterval(() => {
    if (spawnedNPCs >= CONFIG.npcCount || !isGameRunning) {
      clearInterval(spawnInterval);
      return;
    }
    if (isPaused) return; // 教學暫停期間不生成 NPC
    if (spawnedNPCs === 0) {
      for (let i = 0; i < 4; i++) spawnNPC(spawnedNPCs++);
    } else {
      spawnNPC(spawnedNPCs++);
    }
  }, 400);
}

function createEntity(x, y, mass, name, isPlayer) {
  const radius = calculateRadius(mass);
  const body = Matter.Bodies.circle(x, y, radius, {
    frictionAir: CONFIG.friction,
    restitution: 0.6,
    label: isPlayer ? 'player' : 'npc'
  });

  const container = new PIXI.Container();
  const graphics = new PIXI.Graphics();

  // 1. Body Graphics (Bottom Layer)
  container.addChild(graphics);

  // 2. Name Label (Top Layer)
  const nameLabel = new PIXI.Text({
    text: name,
    style: {
      fontFamily: 'Outfit', fontSize: 14, fill: 0xFFFFFF,
      align: 'center', fontWeight: '900',
      dropShadow: { blur: 4, distance: 0, color: 0x000000, alpha: 0.5 }
    }
  });
  nameLabel.anchor.set(0.5, 1.2);
  container.addChild(nameLabel);

  // 3. Mass Label (Top Layer)
  const massLabel = new PIXI.Text({
    text: Math.floor(mass),
    style: {
      fontFamily: 'Outfit', fontSize: 28,
      fill: isPlayer ? 0x000000 : 0xFFFFFF,
      align: 'center', fontWeight: '900',
    }
  });
  massLabel.anchor.set(0.5, 0.5);
  container.addChild(massLabel);

  const indicator = new PIXI.Graphics();
  indicator.visible = false;
  app.stage.addChild(indicator);

  const entity = {
    body, container, graphics, nameLabel, massLabel, indicator,
    mass, name, isPlayer,
    lives: 2,
    protectionTime: 0, // 預設無保護時間，由復活邏輯觸發
    isBoosting: false,
    isDestroyed: false,

    lifeRings: [],
    dirIndicator: null,
    wobbleOffset: Math.random() * Math.PI * 2,
    smoothRotation: 0,
    spawnDelay: 0,
    efficiency: 1.0,
    growthEfficiency: 1.0,
    boostFactor: 0,
    tailAngle: 0,
    isSmart: false,
    boostBudget: 0,
    isRespawning: false,
    speedMult: 1.0 // Base speed multiplier
  };

  entity.body.collisionFilter = {
    group: -1,
    category: 0x0002,
    mask: 0x0001
  };

  const refRadius = calculateRadius(CONFIG.initialMass);
  drawEntityBody(graphics, isPlayer, refRadius, entity);
  // container.addChild(graphics); // Moved to top of function for layering

  // Direction Indicator (Triangle)
  if (isPlayer) {
    const dirIndicator = new PIXI.Graphics();
    dirIndicator.poly([0, 0, -12, -6, -12, 6]);
    dirIndicator.fill({ color: 0xFFFFFF });
    container.addChild(dirIndicator);
    entity.dirIndicator = dirIndicator;

    // [NEW] Speed Multiplier Group
    const speedGroup = new PIXI.Container();

    // Draw a custom white lightning bolt
    const bolt = new PIXI.Graphics();
    bolt.poly([
      5, 0,
      0, 10,
      4, 10,
      2, 20,
      10, 8,
      6, 8,
      10, 0
    ]);
    bolt.fill(0xFFFFFF);
    bolt.scale.set(0.8);
    bolt.x = -32; // Offset to the left of text
    bolt.y = -5;
    speedGroup.addChild(bolt);

    const speedIndicator = new PIXI.Text({
      text: '+0%',
      style: {
        fontFamily: 'Outfit', fontSize: 16, fill: 0xFFFFFF,
        fontWeight: '900',
        stroke: { color: 0x000000, width: 4, join: 'round' }
      }
    });
    speedIndicator.anchor.set(0, 0.5);
    speedIndicator.x = -18;
    speedGroup.addChild(speedIndicator);

    container.addChild(speedGroup);
    entity.speedIndicator = speedIndicator;
    entity.speedGroup = speedGroup;
  }

  // Draw initial life rings
  for (let i = 0; i < 1; i++) {
    const ring = new PIXI.Graphics();
    entity.lifeRings.push(ring);
    container.addChild(ring);
  }
  updateLifeRings(entity);

  if (vfxLayer) gameContainer.setChildIndex(vfxLayer, gameContainer.children.length - 1);

  entities.push(entity);
  entityLayer.addChild(container);
  Matter.World.add(world, body);
  return entity;
}

function drawEntityBody(g, isPlayer, radius, ent) {
  if (!ent) return;
  g.clear();

  const pos = ent.body.position;
  const points = 32; // Optimized for mobile performance
  const wobbleSpeed = 0.003;
  const wobbleAmp = radius * 0.025;
  const time = Date.now() * wobbleSpeed + ent.wobbleOffset;

  // SQUISH SENSORS (Detecting how much we are being squeezed)
  const distL = pos.x;
  const distR = CONFIG.worldSize - pos.x;
  const distT = pos.y;
  const distB = CONFIG.worldSize - pos.y;

  // Calculate squeeze compensation (More stable formula)
  const limit = radius * 0.4;
  let squeezeX = 0;
  if (distL < radius) squeezeX += (radius - distL);
  if (distR < radius) squeezeX += (radius - distR);
  squeezeX = Math.min(limit, squeezeX * 0.4);

  let squeezeY = 0;
  if (distT < radius) squeezeY += (radius - distT);
  if (distB < radius) squeezeY += (radius - distB);
  squeezeY = Math.min(limit, squeezeY * 0.4);

  const vertices = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    // [NEW] Flash Step Channeling Effect (Expansion + Jitter)
    let channelScale = 1.0;
    let jitter = 0;
    if (ent.isPlayer && skillState && skillState.skillId === 'flashStep' && skillState.isChanneling) {
      channelScale = 1.15; // 體型略為加大
      jitter = (Math.random() - 0.5) * 4; // 輕微抖動
    }

    const ripple = Math.sin(angle * 6 + time) * wobbleAmp;
    let r = (radius * channelScale) + ripple + jitter;
    r += (Math.sin(angle) ** 2) * squeezeX;
    r += (Math.cos(angle) ** 2) * squeezeY;

    // 3. WATERDROP EFFECT (Fluid deformation with inertial sway)
    if (ent.boostFactor > 0.01) {
      const vel = ent.body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed > 0.5) {
        const velAngle = Math.atan2(vel.y, vel.x);

        // INTERERTIAL SWAY: Use a blend of real angle and lagged tail angle
        // Back vertices lag more, front vertices lag less
        const dotForLag = Math.cos(angle - velAngle);
        const lagMix = Math.max(0, -dotForLag); // 1.0 at back, 0.0 at front

        // Circular lerp for angle
        let a1 = velAngle;
        let a2 = ent.tailAngle;
        let diff = a2 - a1;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        const blendedAngle = a1 + diff * lagMix;

        const dot = Math.cos(angle - blendedAngle);

        if (dot < 0) {
          // Back side: Stretch outwards
          const stretch = (dot ** 2) * radius * 0.75 * ent.boostFactor;
          r += stretch;
        } else {
          // Front side: Compress
          const compress = dot * radius * 0.2 * ent.boostFactor;
          r -= compress;
        }
      }
    }

    let vx = pos.x + Math.cos(angle) * r;
    let vy = pos.y + Math.sin(angle) * r;

    vx = Math.max(0, Math.min(CONFIG.worldSize, vx));
    vy = Math.max(0, Math.min(CONFIG.worldSize, vy));

    vertices.push({ x: vx - pos.x, y: vy - pos.y });
  }

  // SMOOTH CURVE DRAWING (Midpoint Quadratic Bezier)
  g.beginPath();
  const firstMidX = (vertices[0].x + vertices[points - 1].x) / 2;
  const firstMidY = (vertices[0].y + vertices[points - 1].y) / 2;
  g.moveTo(firstMidX, firstMidY);

  for (let i = 0; i < points; i++) {
    const p1 = vertices[i];
    const p2 = vertices[(i + 1) % points];
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    g.quadraticCurveTo(p1.x, p1.y, midX, midY);
  }

  g.closePath();
  g.fill({ color: isPlayer ? CONFIG.playerColor : CONFIG.npcColor });
}

// Helper to get the deformed radius at a specific angle
function getDeformedRadius(ent, targetAngle, radius) {
  const pos = ent.body.position;
  const distL = pos.x;
  const distR = CONFIG.worldSize - pos.x;
  const distT = pos.y;
  const distB = CONFIG.worldSize - pos.y;

  const limit = radius * 0.4;
  let squeezeX = 0;
  if (distL < radius) squeezeX += (radius - distL);
  if (distR < radius) squeezeX += (radius - distR);
  squeezeX = Math.min(limit, squeezeX * 0.4);

  let squeezeY = 0;
  if (distT < radius) squeezeY += (radius - distT);
  if (distB < radius) squeezeY += (radius - distB);
  squeezeY = Math.min(limit, squeezeY * 0.4);

  let r = radius;
  r += (Math.sin(targetAngle) ** 2) * squeezeX;
  r += (Math.cos(targetAngle) ** 2) * squeezeY;

  let vx = pos.x + Math.cos(targetAngle) * r;
  let vy = pos.y + Math.sin(targetAngle) * r;

  vx = Math.max(0, Math.min(CONFIG.worldSize, vx));
  vy = Math.max(0, Math.min(CONFIG.worldSize, vy));

  return Math.sqrt(Math.pow(vx - pos.x, 2) + Math.pow(vy - pos.y, 2));
}

function updateLifeRings(ent) {
  const radius = calculateRadius(ent.mass);
  ent.lifeRings.forEach((ring, i) => {
    ring.clear();
    if (ent.lives > i + 1) {
      const ringRadius = radius * (1.15 + i * 0.15);
      ring.circle(0, 0, ringRadius);
      ring.stroke({ width: 2, color: 0xFFFFFF, alpha: 0.4 });
    }
  });
}

function spawnNode() {
  let x, y, tooClose;
  let attempts = 0;
  do {
    x = Math.random() * CONFIG.worldSize;
    y = Math.random() * CONFIG.worldSize;
    tooClose = false;
    // Avoid viruses (300px clearance)
    for (const v of viruses) {
      const dx = v.body.position.x - x;
      const dy = v.body.position.y - y;
      if (dx * dx + dy * dy < 300 * 300) { tooClose = true; break; }
    }
    attempts++;
  } while (tooClose && attempts < 10);

  const isSpecial = Math.random() > 0.85;

  const body = Matter.Bodies.circle(x, y, isSpecial ? 12 : 6, {
    isSensor: true,
    label: isSpecial ? 'specialNode' : 'node'
  });

  const container = new PIXI.Container();
  container.x = x;
  container.y = y;

  const graphics = new PIXI.Graphics();
  if (isSpecial) {
    // CYAN PRISM: Thick, rounded double layered wireframes
    const inner = new PIXI.Graphics();
    const outer = new PIXI.Graphics();

    // Outer diamond with thicker, rounded stroke
    outer.poly([-12, 0, 0, -16, 12, 0, 0, 16]);
    outer.stroke({ width: 3, color: 0x00FFFF, alpha: 0.9, join: 'round' });

    // Inner solid core
    inner.poly([-6, 0, 0, -9, 6, 0, 0, 9]);
    inner.fill({ color: 0x00FFFF, alpha: 0.5 });

    container.addChild(outer, inner);

    let t = 0;
    const gUpdate = (d) => {
      t += d.deltaTime * 0.05;
      outer.rotation += 0.03 * d.deltaTime;
      inner.rotation -= 0.06 * d.deltaTime;
      container.alpha = 0.8 + Math.sin(t) * 0.2;
      if (body.isDestroyed) {
        nodeLayer.removeChild(container);
        app.ticker.remove(gUpdate);
      }
    };
    app.ticker.add(gUpdate);
  } else {
    // WHITE BIT: Rounded square with thick outline
    graphics.roundRect(-4, -4, 8, 8, 2);
    graphics.fill({ color: 0xFFFFFF, alpha: 0.3 });
    graphics.stroke({ width: 2, color: 0xFFFFFF, alpha: 0.7, join: 'round' });
    container.addChild(graphics);

    let t = Math.random() * 10;
    const gUpdate = (d) => {
      t += d.deltaTime * 0.04;
      graphics.rotation += 0.02 * d.deltaTime;
      container.scale.set(0.95 + Math.sin(t) * 0.05);
      if (body.isDestroyed) {
        nodeLayer.removeChild(container);
        app.ticker.remove(gUpdate);
      }
    };
    app.ticker.add(gUpdate);
  }

  nodeLayer.addChild(container);
  nodes.push({ body, graphics: container, isSpecial });
  Matter.World.add(world, body);
}

function showFloatingText(x, y, text, color = 0x00FF88) {
  // Fix: Don't show if text is 0 or -0
  if (text === 0 || text === "0" || text === "-0") return;

  const t = new PIXI.Text({
    text: text,
    style: {
      fontFamily: 'Outfit',
      fontSize: 26,
      fill: color,
      fontWeight: '900',
      dropShadow: { blur: 4, distance: 0, color: 0x000000, alpha: 0.6 }
    }
  });
  t.x = x; t.y = y;
  t.anchor.set(0.5);

  // Apply inverse scale to text so it stays readable regardless of zoom
  const inverseZoom = 1 / app.stage.scale.x;
  t.scale.set(inverseZoom);

  gameContainer.addChild(t);

  let life = 1.0;
  const fUpdate = (d) => {
    t.y -= 1.5 * d.deltaTime;
    life -= 0.02 * d.deltaTime;
    t.alpha = life;
    if (life <= 0) {
      gameContainer.removeChild(t);
      app.ticker.remove(fUpdate);
    }
  };
  app.ticker.add(fUpdate);
}

// calculateRadius moved to constants.js

function createGrid() {
  const grid = new PIXI.Graphics();
  for (let i = 0; i <= CONFIG.worldSize; i += 250) {
    grid.moveTo(i, 0); grid.lineTo(i, CONFIG.worldSize);
    grid.moveTo(0, i); grid.lineTo(CONFIG.worldSize, i);
  }
  grid.stroke({ width: 1, color: 0xFFFFFF, alpha: 0.05 });
  app.stage.addChild(grid);
}

function update(delta) {
  // Apply timeScale (Flash Step bullet time)
  // Ensure time stops during Pause or Tutorial
  const isPausedOrTutorial = isPaused || isTutorialActive();
  const currentScale = isPausedOrTutorial ? 0 : timeScale;
  const scaledDeltaMS = delta.elapsedMS * currentScale;

  // Always update physics if not paused/gameover (includes menu state)
  const shouldUpdatePhysics = !isGameOver && !isPaused && !isTutorialActive();

  if (shouldUpdatePhysics) {
    Matter.Engine.update(engine, scaledDeltaMS);

    // Update skill cooldown (only if game is actually running)
    if (isGameRunning && skillState) {
      updateSkillCooldown(skillState, scaledDeltaMS);
      updateSkillEffects(delta);
      updateCooldownUI();
    }

    if (isGameRunning) {
      handleInputs();

      // Update rare item spawn timer
      if (rareItemSpawnTimer > 0) {
        rareItemSpawnTimer -= scaledDeltaMS;
        if (rareItemSpawnTimer <= 0) {
          spawnRareItem();
        }
      }

      // Update virus respawn timer
      if (virusRespawnTimer > 0) {
        virusRespawnTimer -= scaledDeltaMS;
        if (virusRespawnTimer <= 0) {
          spawnVirus();
        }
      }
    }
  }

  // SYNC GRAPHICS & LOGIC (Always run for menu background)
  entities.forEach(ent => {
    if (ent.isDestroyed) return;

    // --- CRITICAL NUMERICAL SAFETY PRE-FLIGHT ---
    if (!Number.isFinite(ent.mass)) ent.mass = CONFIG.initialMass;
    ent.mass = Math.max(1, ent.mass);

    const v = ent.body.velocity;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
      Matter.Body.setVelocity(ent.body, { x: 0, y: 0 });
    }

    const p = ent.body.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      Matter.Body.setPosition(ent.body, { x: CONFIG.worldSize / 2, y: CONFIG.worldSize / 2 });
    }
    // --------------------------------------------

    if (shouldUpdatePhysics) {
      // RESTORE NPC AI with spawnDelay
      if (!ent.isPlayer) {
        if (ent.spawnDelay > 0) {
          ent.spawnDelay -= delta.elapsedMS;
          Matter.Body.setVelocity(ent.body, { x: 0, y: 0 });
        } else {
          // Use Demo AI if it's a menu-specific NPC
          if (ent.isDemoScripted || ent.isOpportunist || ent.isAlwaysBoosting) {
            updateDemoAI(ent, delta, { entities, viruses, nodes, powerups, isGameOver });
          } else {
            updateAI(ent, delta, { entities, viruses, nodes, powerups, isGameOver });
          }
        }
      }

      // Protection Effect
      if (ent.protectionTime > 0) {
        ent.protectionTime -= delta.deltaTime;
        ent.container.alpha = 0.4 + Math.sin(Date.now() * 0.01) * 0.4;
      } else {
        ent.container.alpha = 1.0;
      }
    }

    const pos = ent.body.position;
    const radius = calculateRadius(ent.mass);

    if (shouldUpdatePhysics) {
      ent.body.circleRadius = radius;
      Matter.Body.setMass(ent.body, ent.mass);
      updateLifeRings(ent);

      // DYNAMIC BOOST CONSUMPTION & DEFORMATION LERP
      if (ent.isPlayer && skillState) {
        const isDefaultBoost = skillState.isDefaultBoost && ent.isBoosting;
        const isOverdrive = skillState.skillId === 'overdrive' && skillState.isActive;
        const isTripleDash = skillState.skillId === 'tripleDash' && (ent.dashVisualTimer > 0);
        const isFlashStep = skillState.skillId === 'flashStep' && (skillState.isActive && !skillState.isChanneling);
        const isSprint = skillState.skillId === 'sprint' && (ent.sprintVisualTimer > 0);

        if (isDefaultBoost || isOverdrive || isTripleDash || isFlashStep || isSprint) {
          ent.isBoosting = true;
          if (ent.sprintVisualTimer > 0) ent.sprintVisualTimer -= delta.elapsedMS;
          if (ent.dashVisualTimer > 0) ent.dashVisualTimer -= delta.elapsedMS;
        } else {
          ent.isBoosting = false;
        }
      }

      const targetBoost = ent.isBoosting ? 1.0 : 0.0;
      ent.boostFactor += (targetBoost - ent.boostFactor) * 0.05; // Softer lerp (0.08 -> 0.05)

      const isSkillBoost = ent.isPlayer && skillState && !skillState.isDefaultBoost && skillState.isActive;
      if (ent.isBoosting && ent.mass > 20 && !isSkillBoost) {
        ent.mass -= 0.01 * delta.deltaTime;
      }

      // TAIL ANGLE LERP (Inertia)
      const currentVelAngle = Math.atan2(ent.body.velocity.y, ent.body.velocity.x);
      let angleDiff = currentVelAngle - ent.tailAngle;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      ent.tailAngle += angleDiff * 0.12;

      if (ent.isBoosting && ent.mass > CONFIG.initialMass * 0.8 && !isSkillBoost) {
        const consumption = (0.01 + ent.mass * 0.00015) * delta.deltaTime;
        ent.mass -= consumption;
        if (!ent.isPlayer) {
          ent.boostBudget -= consumption;
          if (ent.boostBudget <= 0) ent.isBoosting = false;
        } else {
          boostAccumulator += consumption;
        }
        triggerBoostParticles(ent);
      }

      // SOFT BOUNDARIES & WALL DAMPING
      const springK = 0.05;
      const wallMargin = radius * 0.3;
      const damping = 0.85;

      if (pos.x < wallMargin) {
        Matter.Body.applyForce(ent.body, pos, { x: (wallMargin - pos.x) * springK, y: 0 });
        if (ent.body.velocity.x < 0) Matter.Body.setVelocity(ent.body, { x: ent.body.velocity.x * damping, y: ent.body.velocity.y });
      }
      if (pos.x > CONFIG.worldSize - wallMargin) {
        Matter.Body.applyForce(ent.body, pos, { x: -(pos.x - (CONFIG.worldSize - wallMargin)) * springK, y: 0 });
        if (ent.body.velocity.x > 0) Matter.Body.setVelocity(ent.body, { x: ent.body.velocity.x * damping, y: ent.body.velocity.y });
      }
      if (pos.y < wallMargin) {
        Matter.Body.applyForce(ent.body, pos, { x: 0, y: (wallMargin - pos.y) * springK });
        if (ent.body.velocity.y < 0) Matter.Body.setVelocity(ent.body, { x: ent.body.velocity.x, y: ent.body.velocity.y * damping });
      }
      if (pos.y > CONFIG.worldSize - wallMargin) {
        Matter.Body.applyForce(ent.body, pos, { x: 0, y: -(pos.y - (CONFIG.worldSize - wallMargin)) * springK });
        if (ent.body.velocity.y > 0) Matter.Body.setVelocity(ent.body, { x: ent.body.velocity.x, y: ent.body.velocity.y * damping });
      }

      // Eating Logic
      entities.forEach(other => {
        if (ent === other || other.isDestroyed) return;
        const diff = Matter.Vector.sub(other.body.position, ent.body.position);
        const dist = Matter.Vector.magnitude(diff);
        const otherRadius = calculateRadius(other.mass);
        const combinedRadius = radius + otherRadius;

        if (dist < combinedRadius) {
          const repulsionThreshold = combinedRadius * 0.5;
          if (dist < repulsionThreshold) {
            const overlap = repulsionThreshold - dist;
            const repulsionK = 0.00005;
            const force = Matter.Vector.mult(Matter.Vector.normalise(diff), overlap * repulsionK);
            Matter.Body.applyForce(other.body, other.body.position, force);
            Matter.Body.applyForce(ent.body, ent.body.position, Matter.Vector.neg(force));
          }

          if (ent.protectionTime <= 0 && other.protectionTime <= 0) {
            if (ent.isPlayer && skillState && skillState.skillId === 'flashStep' && (skillState.isChanneling || skillState.isActive)) {
              return;
            }
            if (ent.mass > other.mass * 1.25 && dist < radius * 0.9) {
              const gainedMass = other.mass * 0.5;
              ent.mass += gainedMass;
              if (ent.isPlayer || other.isPlayer) screenShake = Math.max(screenShake, 40);

              if (ent.isPlayer && !other.isPlayer) {
                killCount++;
                updateCombo();
                showMassFeed(gainedMass, 'green');
                // 補充技能能量 (擊殺轉化率降低為 10%)
                if (skillState) addSkillEnergy(skillState, gainedMass * 0.1);
              }
              shatterEntity(other);
            }
          }
        }
      });

      checkCollisions(ent);
    }

    // Sync Graphics
    ent.container.x = pos.x;
    ent.container.y = pos.y;
    ent.massLabel.text = Math.floor(ent.mass);
    ent.nameLabel.y = -radius - 15;

    drawEntityBody(ent.graphics, ent.isPlayer, radius, ent);

    const inverseZoom = 1 / app.stage.scale.x;
    ent.nameLabel.scale.set(inverseZoom);
    ent.massLabel.scale.set(inverseZoom);

    if (ent.isPlayer && ent.dirIndicator) {
      const vel = ent.body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);

      // Calculate Total Speed Multiplier for UI (Multiplicative for power feel)
      let boostMult = 1.0;
      if (skillState) {
        if (skillState.isDefaultBoost && ent.isBoosting) boostMult = 2.0;
        else if (skillState.skillId === 'overdrive' && skillState.isActive) boostMult = skillState.overdriveSpeedMult;
      }
      const totalMult = boostMult + ((ent.speedMult || 1.0) - 1.0);
      const displayPct = Math.round((totalMult - 1.0) * 100);
      const sign = displayPct >= 0 ? '+' : '';

      if (ent.speedIndicator && ent.speedGroup) {
        ent.speedIndicator.text = `${sign}${displayPct}%`;
        ent.speedGroup.scale.set(inverseZoom);
      }

      if (speed > 0.5) {
        ent.dirIndicator.visible = true;
        const targetAngle = Math.atan2(vel.y, vel.x);
        let diff = targetAngle - ent.smoothRotation;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        ent.smoothRotation += diff * 0.45;
        ent.dirIndicator.rotation = ent.smoothRotation;
        ent.dirIndicator.scale.set(inverseZoom);

        const deformedR = getDeformedRadius(ent, ent.smoothRotation, radius);
        const ringSpacing = 0.15;
        const ringOffsetMult = (ent.lives > 1 ? (ent.lives - 1) * ringSpacing + 0.1 : 0.05);
        const baseDist = deformedR + (radius * ringOffsetMult) + (15 * inverseZoom);

        // Position Direction Indicator
        ent.dirIndicator.x = Math.cos(ent.smoothRotation) * baseDist;
        ent.dirIndicator.y = Math.sin(ent.smoothRotation) * baseDist;

        // Position Speed Indicator (Only if positive boost)
        if (ent.speedGroup) {
          if (displayPct > 0) {
            ent.speedGroup.visible = true;
            const speedDist = baseDist + (40 * inverseZoom);
            ent.speedGroup.x = -speedDist; // 絕對左側
            ent.speedGroup.y = 0;
            ent.speedGroup.rotation = 0; // 不跟隨旋轉，保持橫向
          } else {
            ent.speedGroup.visible = false;
          }
        }
      } else {
        ent.dirIndicator.visible = false;
        if (ent.speedGroup) ent.speedGroup.visible = false;
      }
    }
  });

  // Camera Logic (Always run)
  const minZoom = Math.max(app.screen.width, app.screen.height) / (CONFIG.worldSize * 1.05);
  const zoomLerp = 0.04;
  const followLerp = 0.1;

  if (player) {
    // 手機端使用更小的初始縮放（0.55），讓視野更開闊
    const baseZoom = isTouchDevice ? 0.55 : 0.85;
    // 讓視野隨體型成長而縮放得更快（0.0006 -> 0.0012）
    let targetZoom = Math.max(minZoom, baseZoom / (1 + (player.mass - CONFIG.initialMass) * 0.0012));
    if (player.isBoosting) targetZoom *= 0.85;

    // --- [NEW] Camera Focus & Aim Following ---
    let camX = player.body.position.x;
    let camY = player.body.position.y;

    if (skillState && skillState.skillId === 'flashStep' && skillState.isChanneling) {
      targetZoom *= 1.25; // Zoom in slightly while aiming
      
      // Shift camera pivot towards the aim target
      if (skillDrag.vector.x !== 0 || skillDrag.vector.y !== 0) {
        const def = SKILL_DEFS.flashStep;
        const maxRange = calculateRadius(player.mass) * def.maxRangeMultiplier;
        const lookAhead = maxRange * 0.5; // Follow up to 50% of max range
        camX += skillDrag.vector.x * lookAhead;
        camY += skillDrag.vector.y * lookAhead;
      }
    }

    app.stage.scale.x += (targetZoom - app.stage.scale.x) * zoomLerp;
    app.stage.scale.y += (targetZoom - app.stage.scale.y) * zoomLerp;

    // 降低蓄力時的攝像機跟隨靈敏度，增加瞄準時的穩定感 (0.1 -> 0.04)
    const currentFollowLerp = (skillState && skillState.skillId === 'flashStep' && skillState.isChanneling) ? 0.04 : followLerp;
    app.stage.pivot.x += (camX - app.stage.pivot.x) * currentFollowLerp;
    app.stage.pivot.y += (camY - app.stage.pivot.y) * currentFollowLerp;
  } else {
    const menuZoom = minZoom * 1.2;
    app.stage.scale.x += (menuZoom - app.stage.scale.x) * zoomLerp;
    app.stage.scale.y += (menuZoom - app.stage.scale.y) * zoomLerp;
    app.stage.pivot.x += (CONFIG.worldSize / 2 - app.stage.pivot.x) * followLerp;
    app.stage.pivot.y += (CONFIG.worldSize / 2 - app.stage.pivot.y) * followLerp;
  }

  if (screenShake > 0) {
    app.stage.position.x = app.screen.width / 2 + (Math.random() - 0.5) * screenShake;
    app.stage.position.y = app.screen.height / 2 + (Math.random() - 0.5) * screenShake;
    screenShake *= 0.9;
    if (screenShake < 0.1) screenShake = 0;
  } else {
    app.stage.position.x = app.screen.width / 2;
    app.stage.position.y = app.screen.height / 2;
  }

  // Timer & UI
  if (isGameRunning && !isGameOver && !isPaused && !isTutorialActive()) {
    elapsedTime += scaledDeltaMS;
    const mins = Math.floor(elapsedTime / 60000).toString().padStart(2, '0');
    const secs = Math.floor((elapsedTime % 60000) / 1000).toString().padStart(2, '0');
    const timerEl = document.getElementById('timer-text');
    if (timerEl) timerEl.innerText = `${mins}:${secs}`;

    boostTextTimer += delta.deltaTime;
    if (boostTextTimer > 30) {
      if (boostAccumulator > 1) {
        showFloatingText(player.body.position.x, player.body.position.y, `-${Math.floor(boostAccumulator)}`, 0xFF4444);
        boostAccumulator = 0;
      }
      boostTextTimer = 0;
    }
    if (spawnedNPCs >= CONFIG.npcCount && entities.length === 1 && entities[0].isPlayer) {
      winGame();
    }
  }

  // Update Kill Combo Timer
  if (isGameRunning && comboCount > 0) {
    const elapsed = Date.now() - lastKillTime;
    if (elapsed > COMBO_WINDOW) {
      comboCount = 0;
      const overlay = document.getElementById('combo-overlay');
      const text = document.getElementById('combo-text-container');
      if (overlay) overlay.classList.remove('active');
      if (text) {
        text.classList.remove('active');
        text.classList.remove('warning');
      }
    } else {
      // 更新計時條
      const bar = document.querySelector('.combo-timer-bar');
      if (bar) {
        const pct = Math.max(0, (COMBO_WINDOW - elapsed) / COMBO_WINDOW) * 100;
        bar.style.width = `${pct}%`;
      }

      // 動態調整火焰強度
      const overlay = document.getElementById('combo-overlay');
      if (overlay) {
        const glow = 150 + comboCount * 20;
        const opacity = Math.min(0.9, 0.4 + comboCount * 0.05);
        overlay.style.setProperty('--combo-glow', `${glow}px`);
        overlay.style.setProperty('--combo-opacity', opacity);
      }

      // 倒數警告閃爍 (最後 1.5 秒)
      const text = document.getElementById('combo-text-container');
      if (text) {
        if (COMBO_WINDOW - elapsed < 1500) {
          text.classList.add('warning');
        } else {
          text.classList.remove('warning');
        }
      }
    }
  }

  // FPS 更新 (約一秒更新一次) - 移至最外層確保始終更新
  if (isGameRunning) {
    fpsUpdateTimer += delta.deltaTime;
    if (fpsUpdateTimer >= 60) {
      const fpsDisplay = document.getElementById('fps-display');
      if (fpsDisplay) {
        fpsDisplay.textContent = `fps ${Math.round(app.ticker.FPS)}`;
      }
      fpsUpdateTimer = 0;
    }
  }

  renderMinimap();
}



function handleInputs() {
  if (!player || isGameOver || player.isRespawning) {
    if (player) player.isBoosting = false;
    joystick.vector = { x: 0, y: 0 };
    return;
  }

  // --- PC Flash Step Aiming (Update skillDrag.vector for camera follow) ---
  if (!isTouchDevice && skillState && skillState.skillId === 'flashStep' && skillState.isChanneling) {
    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    const dist = Matter.Vector.magnitude(diff);

    const def = SKILL_DEFS.flashStep;
    const baseMaxRange = calculateRadius(player.mass) * def.maxRangeMultiplier;
    const softLimit = baseMaxRange * 0.7; // Earlier damping start
    
    let finalDist;
    if (dist <= softLimit) {
      finalDist = dist;
    } else {
      // Use a square-root curve for "infinite resistance" feel
      // This means the point always moves forward, but slower and slower
      const overflow = dist - softLimit;
      finalDist = softLimit + Math.sqrt(overflow) * (baseMaxRange * 0.05);
    }
    const normalizedDist = finalDist / baseMaxRange;

    if (dist > 0) {
      const norm = Matter.Vector.normalise(diff);
      skillDrag.vector = {
        x: norm.x * normalizedDist,
        y: norm.y * normalizedDist
      };
    }
  }

  // MOUSE CONTROL (PC Mode)
  // 如果是觸控設備或正在使用搖桿，則停用滑鼠位置偵測
  if (!joystick.active && !isTouchDevice) {
    // [NEW] 只有移動過滑鼠後才開始根據滑鼠位置移動
    if (!isMouseMoved) {
      joystick.vector = { x: 0, y: 0 };
      return;
    }
    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    const dist = Matter.Vector.magnitude(diff);
    const radius = calculateRadius(player.mass);

    if (dist < 1) {
      joystick.vector = { x: 0, y: 0 };
    } else {
      const norm = Matter.Vector.normalise(diff);
      // Speed control: Full speed outside radius, linear scaling inside
      const multiplier = dist > radius ? 1.0 : (dist / radius);
      joystick.vector = Matter.Vector.mult(norm, multiplier);
    }
  }

  // Apply Player Force (Keyboard/Joystick)
  if (Number.isFinite(joystick.vector.x) && (joystick.vector.x !== 0 || joystick.vector.y !== 0)) {
    // Determine boost multiplier based on skill state
    let boostMult = 1.0;
    if (skillState && skillState.isDefaultBoost && player.isBoosting) {
      boostMult = 2.0;
    } else if (skillState && skillState.skillId === 'overdrive' && skillState.isActive) {
      boostMult = skillState.overdriveSpeedMult;
    }
    const finalMult = boostMult + ((player.speedMult || 1.0) - 1.0);
    const force = CONFIG.baseForce * Math.pow(player.mass / 30, 0.8) * finalMult;

    // Steering Improvement: 
    // 當玩家快速轉向時，消減與目標方向不一致的動量，提升轉向靈敏度
    const currentVel = player.body.velocity;
    const speed = Math.sqrt(currentVel.x * currentVel.x + currentVel.y * currentVel.y);
    if (speed > 2) {
      const normVel = { x: currentVel.x / speed, y: currentVel.y / speed };
      // 計算當前速度與目標方向的點積
      const dot = normVel.x * joystick.vector.x + normVel.y * joystick.vector.y;
      if (dot < 0.6) {
        // 點積小於 0.6 表示轉向角度較大，應用阻尼
        const damping = 0.92;
        Matter.Body.setVelocity(player.body, {
          x: currentVel.x * damping,
          y: currentVel.y * damping
        });
      }
    }

    Matter.Body.applyForce(player.body, player.body.position, {
      x: joystick.vector.x * force,
      y: joystick.vector.y * force
    });
  }
}

function triggerBoostParticles(ent) {
  if (Math.random() > 0.6) return; // Increased frequency
  const frag = new PIXI.Graphics();
  const s = 3 + Math.random() * 4; // Slightly larger
  frag.circle(0, 0, s);
  frag.fill({ color: 0xFFFFFF, alpha: 0.8 }); // Higher opacity

  // Spawn behind movement
  const vel = ent.body.velocity;
  const angle = Math.atan2(vel.y, vel.x) + Math.PI + (Math.random() - 0.5) * 0.5;
  const radius = calculateRadius(ent.mass);

  frag.x = ent.body.position.x + Math.cos(angle) * radius;
  frag.y = ent.body.position.y + Math.sin(angle) * radius;
  app.stage.addChildAt(frag, 1); // Below entities

  const vx = Math.cos(angle) * 2;
  const vy = Math.sin(angle) * 2;
  let life = 1.0;

  const fUpdate = (d) => {
    frag.x += vx * d.deltaTime;
    frag.y += vy * d.deltaTime;
    life -= 0.04 * d.deltaTime;
    frag.alpha = life * 0.5;
    if (life <= 0) {
      app.stage.removeChild(frag);
      app.ticker.remove(fUpdate);
    }
  };
  app.ticker.add(fUpdate);
}





function triggerSpawnVFX(x, y) {
  const ring = new PIXI.Graphics();
  app.stage.addChild(ring);
  let r = 5;
  const rUpdate = (d) => {
    r += 12 * d.deltaTime;
    ring.clear();
    ring.circle(x, y, r);
    ring.stroke({ width: 2, color: 0xFFFFFF, alpha: 1 - r / 400 });
    if (r > 400) { app.stage.removeChild(ring); app.ticker.remove(rUpdate); }
  };
  app.ticker.add(rUpdate);
}

function triggerRespawnVFX(x, y) {
  const ring = new PIXI.Graphics();
  app.stage.addChild(ring);
  let r = 10;
  const rUpdate = (d) => {
    r += 15 * d.deltaTime;
    ring.clear();
    ring.circle(x, y, r);
    ring.stroke({ width: 4, color: 0x00FFFF, alpha: 1 - r / 300 });
    if (r > 300) { app.stage.removeChild(ring); app.ticker.remove(rUpdate); }
  };
  app.ticker.add(rUpdate);
}

function triggerNodePickupVFX(x, y, color) {
  for (let i = 0; i < 6; i++) {
    const p = new PIXI.Graphics();
    const size = 2 + Math.random() * 3;
    p.rect(-size / 2, -size / 2, size, size);
    p.fill({ color: color, alpha: 0.8 });
    p.x = x; p.y = y;
    app.stage.addChild(p);

    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 4;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    let life = 1.0;

    const pUpdate = (d) => {
      p.x += vx * d.deltaTime;
      p.y += vy * d.deltaTime;
      p.rotation += 0.1 * d.deltaTime;
      life -= 0.05 * d.deltaTime;
      p.alpha = life;
      if (life <= 0) {
        app.stage.removeChild(p);
        app.ticker.remove(pUpdate);
      }
    };
    app.ticker.add(pUpdate);
  }
}

function triggerRarePickupVFX(x, y) {
  for (let i = 0; i < 24; i++) {
    const p = new PIXI.Graphics();
    const size = 4 + Math.random() * 6;
    p.poly([0, -size, size / 2, size / 2, -size / 2, size / 2]);
    p.fill({ color: 0xFFD700, alpha: 1 });
    p.x = x; p.y = y;
    app.stage.addChild(p);

    const angle = Math.random() * Math.PI * 2;
    const speed = 5 + Math.random() * 10;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    let life = 1.0;

    const pUpdate = (d) => {
      p.x += vx * d.deltaTime;
      p.y += vy * d.deltaTime;
      p.rotation += 0.2 * d.deltaTime;
      life -= 0.02 * d.deltaTime;
      p.alpha = life;
      if (life <= 0) {
        app.stage.removeChild(p);
        app.ticker.remove(pUpdate);
      }
    };
    app.ticker.add(pUpdate);
  }
}

/**
 * 取得當前連擊帶來的縮減加成 (0.5 ~ 1.0)
 */
function getComboBuff() {
  if (comboCount <= 1) return 1.0;
  const reduction = Math.min(0.5, (comboCount - 1) * 0.05);
  return 1.0 - reduction;
}

/**
 * 更新擊殺連擊 (Combo) 邏輯與特效
 */
function updateCombo() {
  comboCount++;
  lastKillTime = Date.now();

  const overlay = document.getElementById('combo-overlay');
  const textContainer = document.getElementById('combo-text-container');
  if (comboCount > 1) {
    const buff = getComboBuff();
    const reductionPct = Math.round((1 - buff) * 100);
    const buffType = (skillState && !skillState.isDefaultBoost) ?
      (getSkillDef(skillState.skillId).energyRequired ? 'ENG' : 'CD') : 'Cost';

    overlay.classList.add('active');
    textContainer.classList.add('active');
    textContainer.innerHTML = `
      <div class="combo-buff-label">${buffType} -${reductionPct}%</div>
      <div class="combo-number-wrap">
        <span style="font-size: 1.5rem; color: #FFF; display: block; letter-spacing: 4px; margin-bottom: -15px;">COMBO</span>
        ${comboCount}
      </div>
      <div class="combo-timer-wrapper">
        <div class="combo-timer-bar"></div>
      </div>
    `;
  }
}

/**
 * 在左側 Feed 顯示質量變動
 * @param {number} amount - 變動值
 * @param {string} type - 'green' | 'red' | 'rainbow'
 */
function showMassFeed(amount, type) {
  if (Math.floor(Math.abs(amount)) === 0) return; // 忽略為 0 的變動

  const container = document.getElementById('mass-feed-container');
  if (!container) return;

  const item = document.createElement('div');
  item.className = `mass-feed-item mass-${type}`;
  const sign = amount > 0 ? '+' : '';
  item.textContent = `${sign}${Math.floor(amount)}`;

  // 保持 Feed 簡潔，若超過 5 個則移除最舊的
  if (container.children.length > 5) {
    container.removeChild(container.firstChild);
  }

  container.appendChild(item);

  // 1.5 秒後自動消失
  setTimeout(() => {
    item.style.transition = 'all 0.4s ease';
    item.style.opacity = '0';
    item.style.transform = 'translateX(-30px) scale(0.8)';
    setTimeout(() => item.remove(), 400);
  }, 1200);
}

/**
 * 觸發全螢幕特效 (如九九成稀罕物的金色光芒或分裂球的紅色故障)
 * @param {string} type - 'legendary' | 'virus'
 * @param {string} color - 覆蓋顏色 (可選)
 */
function triggerScreenEffect(type, customColor = null) {
  const container = document.getElementById('screen-effects-overlay');
  if (!container) return;

  const fx = document.createElement('div');
  fx.className = type === 'legendary' ? 'fx-legendary-glow' : 'fx-virus-hit';
  if (customColor) {
    fx.style.boxShadow = `inset 0 0 120px ${customColor}, inset 0 0 250px ${customColor}44`;
  }
  container.appendChild(fx);

  // 新增規律的波普點 (Halftone Pattern)
  const halftone = document.createElement('div');
  halftone.className = 'fx-halftone';

  let finalColor = customColor || (type === 'legendary' ? '#FFD700' : '#FF0000');
  halftone.style.color = finalColor;
  fx.appendChild(halftone);

  setTimeout(() => fx.remove(), 3000);
}

function checkCollisions(ent) {
  if (ent.isDestroyed) return;

  const pos = ent.body.position;
  const radius = calculateRadius(ent.mass);

  // 1. Nodes (Allow eating even during protection)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.pickupDelay > 0) continue; // CANNOT PICK UP YET

    const nPos = node.body.position;
    const dx = nPos.x - pos.x;
    const dy = nPos.y - pos.y;
    const dSq = dx * dx + dy * dy;

    if (dSq < radius * radius) {
      let addedMass = node.customMass || (node.isSpecial ? CONFIG.specialNodeMass : CONFIG.nodeMass);

      // UNIFIED: All entities gain 100% mass from nodes
      // No more NPC nerf

      if (ent.isBoosting) addedMass *= 0.5; // Penalty for eating while boosting

      const finalGrowthEff = ent.growthEfficiency !== undefined ? ent.growthEfficiency : (ent.efficiency || 1.0);
      ent.mass += addedMass * finalGrowthEff;

      if (ent.isPlayer) {
        showMassFeed(addedMass * finalGrowthEff, 'green');
        triggerNodePickupVFX(nPos.x, nPos.y, node.isSpecial ? 0x00FFFF : 0xFFFFFF);
        // 補充技能能量
        if (skillState) addSkillEnergy(skillState, addedMass * finalGrowthEff);
      } else {
        triggerNodePickupVFX(nPos.x, nPos.y, node.isSpecial ? 0x00FFFF : 0xFFFFFF);
      }

      nodeLayer.removeChild(node.graphics);
      node.body.isDestroyed = true;
      Matter.World.remove(world, node.body);
      nodes.splice(i, 1);
      spawnNode();
    }
  }

  // 1.2 Powerups (ONLY PLAYER CAN PICK UP RARE ITEMS)
  for (let i = powerups.length - 1; i >= 0; i--) {
    const p = powerups[i];
    const dSq = Matter.Vector.magnitudeSquared(Matter.Vector.sub(p.body.position, pos));
    if (dSq < (radius + 20) * (radius + 20)) {
      if (p.type === 'rareItem' && ent.isPlayer) {
        const tier = CONFIG.rareItemTiers[p.tierKey || 'white'];
        ent.mass += tier.mass;
        ent.speedMult += tier.speed;

        // 觸發對應顏色的特效
        const hexColor = '#' + (tier.color).toString(16).padStart(6, '0');
        if (tier.label === 'IRIDESCENT') triggerScreenEffect('legendary');

        // 補充技能能量
        if (skillState) addSkillEnergy(skillState, tier.mass);

        showMassFeed(tier.mass, 'rainbow');
        screenShake = Math.max(screenShake, p.tierKey === 'iridescent' ? 100 : 60);
        triggerRarePickupVFX(p.body.position.x, p.body.position.y);

        p.body.isDestroyed = true;
        Matter.World.remove(world, p.body);
        powerups.splice(i, 1);
      }
    }
  }

  // 1.5 Virus Collision
  for (let i = 0; i < viruses.length; i++) {
    const v = viruses[i];
    const dSq = Matter.Vector.magnitudeSquared(Matter.Vector.sub(v.body.position, pos));
    const rV = 60; // Virus radius
    if (dSq < (radius + rV) * (radius + rV)) {
      if (ent.mass < CONFIG.virusMinMass) {
        // SOFT PHYSICS: Spring-like repulsion for small entities
        const dist = Math.sqrt(dSq);
        const overlap = (radius + rV) - dist;
        const pushDir = Matter.Vector.normalise(Matter.Vector.sub(pos, v.body.position));

        // Very soft push when overlapping, allowing them to "hide" but feel the edge
        const springK = 0.0015; // Increased repulsion (was 0.0002)
        Matter.Body.applyForce(ent.body, pos, Matter.Vector.mult(pushDir, overlap * springK));

        // Slight damping inside virus to feel "fluid"
        Matter.Body.setVelocity(ent.body, Matter.Vector.mult(ent.body.velocity, 0.98));
      } else {
        // High mass entity: 30% mass loss (Agar.io style penalty)
        // ONLY TRIGGER IF COVERED: Center must be well within the player radius
        const dist = Math.sqrt(dSq);
        if (dist < radius * 0.7) {
          const massLoss = ent.mass * 0.3;
          ent.mass -= massLoss;
          releaseFragments(v.body.position.x, v.body.position.y, massLoss * 1.5, ent);
          if (ent.isPlayer) {
            screenShake = 30;
            triggerScreenEffect('virus');
            showMassFeed(-massLoss, 'red');
          }

          // Destroy the virus after one split
          virusLayer.removeChild(v.graphics);
          Matter.World.remove(world, v.body);
          viruses.splice(i, 1);
          i--;

          // Respawn a new virus elsewhere after a delay (via update loop)
          virusRespawnTimer = 15000;
        }
      }
    }
  }

  // 2. Combat (Integrated into main update loop)
}

function shatterEntity(ent) {
  if (ent.isDestroyed || ent.protectionTime > 0) return;

  // Basic shake if player is involved
  if (ent.isPlayer) screenShake = Math.max(screenShake, 30);

  ent.protectionTime = 180; // Lock immediately to prevent multi-death

  if (ent.lives > 1) {
    ent.lives--;
    ent.mass = Math.max(CONFIG.initialMass, ent.mass * 0.8);

    if (ent.isPlayer) {
      ent.isRespawning = true;
      updateLivesUI();
      showFloatingText(ent.body.position.x, ent.body.position.y, `-20%`, 0xFF4444);

      ent.container.visible = false;
      Matter.Body.setPosition(ent.body, { x: -5000, y: -5000 });
      Matter.Body.setVelocity(ent.body, { x: 0, y: 0 });

      startRespawnSequence(() => {
        const rx = Math.random() * CONFIG.worldSize;
        const ry = Math.random() * CONFIG.worldSize;
        Matter.Body.setPosition(ent.body, { x: rx, y: ry });
        ent.container.visible = true;
        ent.isRespawning = false;
        ent.protectionTime = 180;
        triggerRespawnVFX(rx, ry);
      });
    } else {
      // NPC Respawns immediately but at new location
      const rx = Math.random() * CONFIG.worldSize;
      const ry = Math.random() * CONFIG.worldSize;
      Matter.Body.setPosition(ent.body, { x: rx, y: ry });
      Matter.Body.setVelocity(ent.body, { x: 0, y: 0 });
      ent.protectionTime = 120;
      ent.spawnDelay = 1000;
      triggerRespawnVFX(rx, ry);
    }
    return;
  }

  ent.isDestroyed = true;

  if (ent.isPlayer) {
    isGameOver = true;
    showRewardScreen(false);
    document.querySelector('.ui-overlay').style.display = 'none';
  }
  entityLayer.removeChild(ent.container);
  if (ent.indicator) {
    ent.indicator.visible = false;
    app.stage.removeChild(ent.indicator);
  }
  Matter.World.remove(world, ent.body);
  entities = entities.filter(e => e !== ent);

  for (let i = 0; i < 25; i++) {
    const frag = new PIXI.Graphics();
    const s = 4 + Math.random() * 4;
    frag.rect(-s / 2, -s / 2, s, s);
    frag.fill({ color: 0xFFFFFF, alpha: 0.8 });
    frag.x = ent.body.position.x; frag.y = ent.body.position.y;
    app.stage.addChild(frag);
    const angle = Math.random() * Math.PI * 2;
    const f = 6 + Math.random() * 6;
    const vx = Math.cos(angle) * f; const vy = Math.sin(angle) * f;
    let life = 1.0;
    const fUpdate = (d) => {
      frag.x += vx * d.deltaTime; frag.y += vy * d.deltaTime;
      life -= 0.03 * d.deltaTime; frag.alpha = life;
      if (life <= 0) { app.stage.removeChild(frag); app.ticker.remove(fUpdate); }
    };
    app.ticker.add(fUpdate);
  }
}



// --- Inputs ---
function setupInputs() {
  window.addEventListener('pointermove', (e) => {
    // 只有真正的滑鼠移動才更新滑鼠座標，防止手機觸控誤發
    if (e.pointerType === 'mouse') {
      mousePos.x = e.clientX;
      mousePos.y = e.clientY;
      isMouseMoved = true; // 偵測到滑鼠移動
    }
  });

  const skillBtn = document.getElementById('skill-btn');

  // Skill activation (replaces old boost)
  const activateSkill = (e) => {
    if (isGameOver || isPaused || isTutorialActive() || !player || !skillState) return;

    skillBtn.classList.add('active');

    // 如果是觸控，啟動拖動瞄準模式
    if (e && e.touches) {
      // 找到觸發此事件的新觸摸點
      const touch = e.changedTouches ? e.changedTouches[0] : e.touches[0];
      skillDrag.active = true;
      skillDrag.touchId = touch.identifier;
      skillDrag.startX = touch.clientX;
      skillDrag.startY = touch.clientY;
      skillDrag.vector = { x: 0, y: 0 };
    }

    if (skillState.isDefaultBoost) {
      player.isBoosting = true;
      return;
    }
    handleSkillActivation();
  };

  const deactivateSkill = (e) => {
    if (skillBtn) skillBtn.classList.remove('active');
    if (!player) return;

    // 如果是觸控，檢查是否是當初啟動技能的那個 ID
    if (e && e.changedTouches) {
      let match = false;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === skillDrag.touchId) {
          match = true;
          break;
        }
      }
      if (!match) return; // 不是目標觸摸點抬起，不執行取消
    }

    player.isBoosting = false;
    skillDrag.active = false;
    skillDrag.touchId = null;
    handleSkillDeactivation();
  };

  skillBtn.addEventListener('mousedown', (e) => activateSkill(e));

  // [NEW] PC Mode: Global left-click to activate skill
  window.addEventListener('mousedown', (e) => {
    // 只有真正的滑鼠左鍵 (button 0) 且不是從觸控模擬的點擊才觸發
    if (e.button === 0 && isGameRunning && !isPaused && !isGameOver) {
      // 防止在點擊 UI 面板、按鈕或搖桿區時觸發技能
      const isUI = e.target.closest('.secondary-panel, .main-panel, .guide-panel, .pause-menu, .tab-bar, .mobile-nav-bar, .mobile-top-right-group, .skill-button-zone, #skill-btn, .joystick-zone');
      if (!isUI) {
        activateSkill(e);
      }
    }
  });

  window.addEventListener('mouseup', deactivateSkill);
  skillBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    activateSkill(e);
  });
  window.addEventListener('touchend', (e) => deactivateSkill(e));

  // 處理技能拖動瞄準 (Mobile Drag Aim)
  window.addEventListener('touchmove', (e) => {
    if (!skillDrag.active || !skillState.isChanneling) return;

    // 尋找對應的觸摸點
    let touch = null;
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === skillDrag.touchId) {
        touch = e.touches[i];
        break;
      }
    }
    if (!touch) return;

    const dx = touch.clientX - skillDrag.startX;
    const dy = touch.clientY - skillDrag.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Infinite Elastic Damping for Mobile
    const baseDrag = 80; 
    const softLimit = baseDrag * 0.7;
    
    let finalDrag;
    if (dist <= softLimit) {
      finalDrag = dist;
    } else {
      const overflow = dist - softLimit;
      finalDrag = softLimit + Math.sqrt(overflow) * (baseDrag * 0.05);
    }
    const normalizedDist = finalDrag / baseDrag;
    
    const angle = Math.atan2(dy, dx);

    skillDrag.vector = {
      x: Math.cos(angle) * normalizedDist,
      y: Math.sin(angle) * normalizedDist
    };
  }, { passive: false });

  joyZone = document.getElementById('joystick-container');
  joyThumb = document.getElementById('joystick-thumb');

  const handleJoy = (e) => {
    if (!joystick.active) return;

    let touch = null;
    if (e.touches) {
      // 尋找對應的觸摸點
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === joystick.touchId) {
          touch = e.touches[i];
          break;
        }
      }
    } else {
      touch = e;
    }
    if (!touch) return;

    const rect = joyZone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = touch.clientX - centerX;
    const dy = touch.clientY - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const max = 50;
    const nD = Math.min(dist, max);
    const angle = Math.atan2(dy, dx);
    joystick.vector = { x: Math.cos(angle) * (nD / max), y: Math.sin(angle) * (nD / max) };
    joyThumb.style.transform = `translate(calc(-50% + ${Math.cos(angle) * nD}px), calc(-50% + ${Math.sin(angle) * nD}px))`;
  };

  joyZone.addEventListener('mousedown', () => joystick.active = true);
  joyZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    joystick.active = true;
    joystick.touchId = e.changedTouches[0].identifier;
  });

  window.addEventListener('mousemove', handleJoy);
  window.addEventListener('touchmove', (e) => {
    if (joystick.active) handleJoy(e);
  });

  window.addEventListener('mouseup', () => {
    joystick.active = false;
    joystick.touchId = null;
    joyThumb.style.transform = 'translate(-50%, -50%)';
    joystick.vector = { x: 0, y: 0 };
  });
  window.addEventListener('touchend', (e) => {
    if (joystick.active && e.changedTouches) {
      let match = false;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joystick.touchId) {
          match = true;
          break;
        }
      }
      if (match) {
        joystick.active = false;
        joystick.touchId = null;
        joyThumb.style.transform = 'translate(-50%, -50%)';
        joystick.vector = { x: 0, y: 0 };
      }
    }
  });

  window.addEventListener('contextmenu', e => e.preventDefault());
}

let viruses = [];
function spawnVirus() {
  const x = Math.random() * CONFIG.worldSize;
  const y = Math.random() * CONFIG.worldSize;
  const radius = calculateRadius(500); // Massive size based on mass

  // CLEANUP: Remove any nodes inside the new virus radius (increased safety margin)
  const clearanceR = radius * 1.2;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const dx = node.body.position.x - x;
    const dy = node.body.position.y - y;
    if (dx * dx + dy * dy < clearanceR * clearanceR) {
      nodeLayer.removeChild(node.graphics);
      Matter.World.remove(world, node.body);
      nodes.splice(i, 1);
      // We'll replace nodes AFTER the full cleanup loop to avoid recursion issues
    }
  }
  // Refill nodes to match nodeCount
  while (nodes.length < CONFIG.nodeCount) spawnNode();

  const body = Matter.Bodies.circle(x, y, radius, { isStatic: true, isSensor: true, label: 'virus' });
  const graphics = new PIXI.Graphics();

  const v = { body, graphics, t: Math.random() * 10 };

  const vUpdate = (d) => {
    v.t += d.deltaTime * 0.03;
    const pulse = Math.sin(v.t) * 8;
    graphics.clear();

    // Draw highly rounded spiky ball using Bezier curves
    const points = 10;
    const innerR = radius + pulse;
    const outerR = radius + 25 + pulse;

    graphics.beginPath();
    for (let i = 0; i < points; i++) {
      const angle = (i / points) * Math.PI * 2 + v.t * 0.1;
      const nextAngle = ((i + 1) / points) * Math.PI * 2 + v.t * 0.1;
      const midAngle = (angle + nextAngle) / 2;

      const startX = Math.cos(angle) * innerR;
      const startY = Math.sin(angle) * innerR;
      const peakX = Math.cos(midAngle) * outerR;
      const peakY = Math.sin(midAngle) * outerR;
      const endX = Math.cos(nextAngle) * innerR;
      const endY = Math.sin(nextAngle) * innerR;

      if (i === 0) graphics.moveTo(startX, startY);
      // Use quadraticCurveTo for rounded peaks
      graphics.quadraticCurveTo(peakX, peakY, endX, endY);
    }
    graphics.closePath();
    graphics.fill({ color: 0x330055, alpha: 1.0 });
    graphics.stroke({ width: 6, color: 0xAA00FF, alpha: 1, join: 'round' });

    graphics.x = body.position.x;
    graphics.y = body.position.y;
  };

  app.ticker.add(vUpdate);
  virusLayer.addChild(graphics);
  viruses.push(v);
  Matter.World.add(world, body);
}

function spawnRareItem() {
  if (isGameOver || !isGameRunning) return;

  // 1. 決定是否生成 (每30秒有一定機率)
  rareItemSpawnTimer = 30000; // Reset timer for next attempt

  if (Math.random() > (CONFIG.rareItemProb || 0.7)) {
    return;
  }

  // 2. 決定等級 (虹彩、金色、白色)
  const rng = Math.random();
  let tierKey = 'white';
  if (rng < CONFIG.rareItemTiers.iridescent.prob) tierKey = 'iridescent';
  else if (rng < CONFIG.rareItemTiers.iridescent.prob + CONFIG.rareItemTiers.gold.prob) tierKey = 'gold';

  const tier = CONFIG.rareItemTiers[tierKey];

  let x, y;
  const player = entities.find(e => e.isPlayer);
  let attempts = 0;

  do {
    x = Math.random() * CONFIG.worldSize;
    y = Math.random() * CONFIG.worldSize;
    attempts++;
  } while (player && Matter.Vector.magnitude(Matter.Vector.sub({ x, y }, player.body.position)) < 1200 && attempts < 10);

  const body = Matter.Bodies.circle(x, y, 40, { isSensor: true, label: 'rareItem' });
  const container = new PIXI.Container();
  container.x = x; container.y = y;
  powerupLayer.addChild(container);

  const graphics = new PIXI.Graphics();
  container.addChild(graphics);

  // 波普光點底座 (Halftone Base)
  const halftoneBase = new PIXI.Graphics();
  const dotColor = tierKey === 'iridescent' ? 0xFFCCFF : tier.color;
  for (let r = 50; r <= 120; r += 20) {
    const dots = Math.floor(r / 4);
    const dotSize = Math.max(1, 5 - (r / 30));
    for (let i = 0; i < dots; i++) {
      const angle = (i / dots) * Math.PI * 2;
      halftoneBase.circle(Math.cos(angle) * r, Math.sin(angle) * r, dotSize);
    }
  }
  halftoneBase.fill({ color: dotColor, alpha: 0.3 });
  container.addChildAt(halftoneBase, 0);

  const wobbleOffset = Math.random() * 10;
  let t = 0;
  const update = (d) => {
    t += 0.05 * d.deltaTime;
    graphics.clear();

    const points = 32;
    const radius = 40;
    const time = Date.now() * 0.003 + wobbleOffset;

    // 虹彩顏色變換
    let currentColor = tier.color;
    if (tierKey === 'iridescent') {
      const hue = (Date.now() * 0.1) % 360;
      // 模擬珍珠虹彩：在粉、藍、紫之間切換
      const shift = Math.sin(Date.now() * 0.002) * 30;
      currentColor = PIXI.Color.shared.setValue(`hsl(${300 + shift}, 70%, 85%)`).toNumber();
    }

    graphics.beginPath();
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const wobble = Math.sin(angle * 3 + time) * 3 + Math.cos(angle * 5 - time * 0.5) * 2;
      const r = radius + wobble;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      if (i === 0) graphics.moveTo(px, py);
      else graphics.lineTo(px, py);
    }
    graphics.closePath();
    graphics.fill({ color: currentColor, alpha: 0.95 });
    graphics.stroke({ width: 6, color: 0xFFFFFF, alpha: 0.4, join: 'round' });

    halftoneBase.rotation += 0.01 * d.deltaTime;
    halftoneBase.scale.set(1 + Math.sin(t * 0.5) * 0.1);
    container.scale.set(1 + Math.sin(t) * 0.05);

    if (body.isDestroyed) {
      powerupLayer.removeChild(container);
      app.ticker.remove(update);
    }
  };
  app.ticker.add(update);

  powerups.push({ body, container, type: 'rareItem', tierKey, tierColor: tier.color });
  Matter.World.add(world, body);

  // 小地圖波普擴散特效
  miniVFX.push({
    x, y,
    color: '#' + (tier.color).toString(16).padStart(6, '0'),
    life: 1.0,
    maxRadius: 60
  });

  // Reset timer for next cycle is already handled at the start of spawnRareItem
}

function releaseFragments(x, y, totalMass, triggerer) {
  const count = 6; // Fewer but larger fragments
  const massPerFrag = totalMass / count;
  const trigRadius = calculateRadius(triggerer.mass);
  const fragRadius = calculateRadius(30); // Size of 30 mass entity

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const body = Matter.Bodies.circle(x, y, fragRadius, { isSensor: true, label: 'node' });
    const graphics = new PIXI.Graphics();

    // Draw MINI-VIRUS spikes
    const points = 8;
    const innerR = fragRadius * 0.7;
    const outerR = fragRadius;
    graphics.beginPath();
    for (let j = 0; j < points; j++) {
      const a = (j / points) * Math.PI * 2;
      const na = ((j + 1) / points) * Math.PI * 2;
      const ma = (a + na) / 2;
      const sx = Math.cos(a) * innerR;
      const sy = Math.sin(a) * innerR;
      const px = Math.cos(ma) * outerR;
      const py = Math.sin(ma) * outerR;
      const ex = Math.cos(na) * innerR;
      const ey = Math.sin(na) * innerR;
      if (j === 0) graphics.moveTo(sx, sy);
      graphics.quadraticCurveTo(px, py, ex, ey);
    }
    graphics.closePath();
    graphics.fill({ color: 0x330055, alpha: 1.0 });
    graphics.stroke({ width: 3, color: 0xAA00FF, alpha: 1, join: 'round' });

    nodeLayer.addChild(graphics); // Ensure it's on the correct layer
    const nodeObj = { body, graphics, isSpecial: true, customMass: massPerFrag, pickupDelay: 100 };
    nodes.push(nodeObj);
    Matter.World.add(world, body);

    // Initial burst: Scaled back to be "just right" (about 2x original)
    const burstForce = (trigRadius / 6) + 35 + Math.random() * 20;
    Matter.Body.setVelocity(body, {
      x: Math.cos(angle) * burstForce,
      y: Math.sin(angle) * burstForce
    });

    const fUpdate = (d) => {
      // DYNAMIC PICKUP: Only allow pickup when fragment has slowed down significantly
      const vel = body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);

      if (speed < 2.0) {
        nodeObj.pickupDelay = 0;
        graphics.alpha = 0.9;
      } else {
        nodeObj.pickupDelay = 60; // Keep it blocked while fast
        graphics.alpha = 0.4 + Math.sin(Date.now() * 0.01) * 0.2; // Pulsing while flying
      }

      // WORLD BOUNDARY BOUNCE: Prevent fragments from flying out of map
      const margin = 20;
      if (body.position.x < margin) Matter.Body.setVelocity(body, { x: Math.abs(body.velocity.x) * 0.5, y: body.velocity.y });
      if (body.position.x > CONFIG.worldSize - margin) Matter.Body.setVelocity(body, { x: -Math.abs(body.velocity.x) * 0.5, y: body.velocity.y });
      if (body.position.y < margin) Matter.Body.setVelocity(body, { x: body.velocity.x, y: Math.abs(body.velocity.y) * 0.5 });
      if (body.position.y > CONFIG.worldSize - margin) Matter.Body.setVelocity(body, { x: body.velocity.x, y: -Math.abs(body.velocity.y) * 0.5 });

      graphics.x = body.position.x;
      graphics.y = body.position.y;
      graphics.rotation += 0.05 * d.deltaTime;

      // DYNAMIC FRICTION: Adjusted for a balanced travel distance
      if (speed > 0.1) {
        const friction = 0.955; // Slightly heavier than 0.982
        Matter.Body.setVelocity(body, { x: vel.x * friction, y: vel.y * friction });
      }

      if (body.isDestroyed) {
        nodeLayer.removeChild(graphics);
        app.ticker.remove(fUpdate);
      }
    };
    app.ticker.add(fUpdate);
  }
}

function updateLivesUI() {
  const h1 = document.getElementById('heart-1');
  const h2 = document.getElementById('heart-2');
  if (!h1 || !h2 || !player) return;

  if (player.lives >= 2) {
    h1.className = 'heart-icon heart-full';
    h2.className = 'heart-icon heart-full';
  } else if (player.lives === 1) {
    h1.className = 'heart-icon heart-full';
    h2.className = 'heart-icon heart-empty';
  } else {
    h1.className = 'heart-icon heart-empty';
    h2.className = 'heart-icon heart-empty';
  }
}

function startRespawnSequence(callback) {
  const overlay = document.getElementById('respawn-overlay');
  const countDisplay = document.getElementById('respawn-countdown');
  overlay.style.display = 'flex';
  let count = 3;
  countDisplay.innerText = count;

  const timer = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(timer);
      overlay.style.display = 'none';
      if (callback) callback();
    } else {
      countDisplay.innerText = count;
    }
  }, 1000);
}

function updateLeaderboard() {
  const sortedAll = [...entities].sort((a, b) => b.mass - a.mass);
  const top5 = sortedAll.slice(0, 5);
  const list = document.getElementById('leaderboard-list');
  const aliveCount = document.getElementById('alive-count');
  if (aliveCount) aliveCount.innerText = entities.length;
  if (!list) return;

  let html = top5.map((ent, i) => `
    <div class="leaderboard-item ${ent.isPlayer ? 'me' : ''} ${i === 0 ? 'is-leader' : ''}">
      <span class="rank">#${i + 1}</span>
      <span class="name">${ent.name}</span>
      <span class="score">${Math.floor(ent.mass)}</span>
    </div>
  `).join('');

  if (isGameRunning) {
    const playerRank = sortedAll.findIndex(e => e.isPlayer) + 1;
    if (playerRank > 5) {
      html += `
        <div class="leaderboard-separator">...</div>
        <div class="leaderboard-item me">
          <span class="rank">#${playerRank}</span>
          <span class="name">${player.name}</span>
          <span class="score">${Math.floor(player.mass)}</span>
        </div>
      `;
    }
  }
  list.innerHTML = html;
}

function initMinimap() {
  miniCanvas = document.getElementById('minimap');
  miniCtx = miniCanvas.getContext('2d');
  miniCanvas.width = 150;
  miniCanvas.height = 150;
}

function renderMinimap() {
  if (!miniCtx) return;
  miniCtx.clearRect(0, 0, 150, 150);
  miniCtx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  miniCtx.fillRect(0, 0, 150, 150);

  const scale = 150 / CONFIG.worldSize;

  entities.forEach(ent => {
    const r = calculateRadius(ent.mass) * scale * 2;
    const x = ent.body.position.x * scale;
    const y = ent.body.position.y * scale;

    miniCtx.fillStyle = ent.isPlayer ? '#FFFFFF' : 'rgba(255, 255, 255, 0.4)';
    miniCtx.beginPath();
    miniCtx.arc(x, y, Math.max(2, r), 0, Math.PI * 2);
    miniCtx.fill();
  });

  // Render Powerups on Minimap
  powerups.forEach(p => {
    const x = p.body.position.x * scale;
    const y = p.body.position.y * scale;
    const hexColor = '#' + (p.tierColor || 0xFFFFFF).toString(16).padStart(6, '0');

    miniCtx.fillStyle = hexColor;
    miniCtx.shadowBlur = 8;
    miniCtx.shadowColor = hexColor;
    miniCtx.beginPath();
    miniCtx.arc(x, y, 4, 0, Math.PI * 2);
    miniCtx.fill();
    miniCtx.shadowBlur = 0;
  });

  // Render Minimap VFX (Halftone expansion)
  miniVFX = miniVFX.filter(vfx => vfx.life > 0);
  miniVFX.forEach(vfx => {
    vfx.life -= 0.015; // Slower fade for better visibility
    const vx = vfx.x * scale;
    const vy = vfx.y * scale;
    const currentRadius = (1 - vfx.life) * vfx.maxRadius;

    miniCtx.fillStyle = vfx.color;
    miniCtx.globalAlpha = vfx.life;

    // Draw halftone ring on minimap
    const dots = 12;
    for (let i = 0; i < dots; i++) {
      const angle = (i / dots) * Math.PI * 2;
      const dotX = vx + Math.cos(angle) * currentRadius;
      const dotY = vy + Math.sin(angle) * currentRadius;
      const dotSize = 2 + vfx.life * 2;

      miniCtx.beginPath();
      miniCtx.arc(dotX, dotY, dotSize, 0, Math.PI * 2);
      miniCtx.fill();
    }
    miniCtx.globalAlpha = 1.0;
  });
}

function winGame() {
  isGameOver = true;
  isGameRunning = false;
  const timeStr = document.getElementById('timer-text').innerText;
  // Reward screen now handles its own display within showRewardScreen
  document.querySelector('.ui-overlay').style.display = 'none';
  saveHistory(timeStr);
  showRewardScreen(true);
}

function saveHistory(time) {
  let history = JSON.parse(localStorage.getItem('null-vector-history') || '[]');
  history.push({ date: new Date().toLocaleDateString(), time: time });
  history.sort((a, b) => a.time.localeCompare(b.time));
  localStorage.setItem('null-vector-history', JSON.stringify(history.slice(0, 5)));
}

function loadHistory() {
  const history = JSON.parse(localStorage.getItem('null-vector-history') || '[]');
  const list = document.getElementById('history-list');

  if (history.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <p>尚無獲勝紀錄</p>
      </div>
    `;
    return;
  }

  const best = history[0];
  const totalWins = history.length;

  const trophyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"></path><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"></path></svg>`;
  const medalIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"></circle><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"></path></svg>`;
  const starIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
  const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  let html = `
    <div class="history-summary-grid">
      <div class="summary-card best-record">
        <div class="summary-icon">${trophyIcon}</div>
        <div class="summary-info">
          <span class="summary-label">最佳成績</span>
          <span class="summary-value">${best.time}</span>
        </div>
      </div>
      <div class="summary-card total-wins">
        <div class="summary-icon">${medalIcon}</div>
        <div class="summary-info">
          <span class="summary-label">總獲勝數</span>
          <span class="summary-value">${totalWins}</span>
        </div>
      </div>
    </div>
    <div class="history-list-header">
      <span>近期最佳成績</span>
      <span class="header-line"></span>
    </div>
  `;

  html += '<div class="history-items-container">';
  html += history.map((h, i) => `
    <div class="history-item ${i === 0 ? 'is-best' : ''}">
      <div class="history-item-left">
        <div class="history-icon-wrapper">${i === 0 ? starIcon : checkIcon}</div>
        <div class="history-details">
          <span class="history-status">${i === 0 ? 'BEST RECORD' : 'MISSION WIN'}</span>
          <span class="history-date">${h.date}</span>
        </div>
      </div>
      <div class="history-item-right">
        <span class="history-time">${h.time}</span>
      </div>
    </div>
  `).join('');
  html += '</div>';

  list.innerHTML = html;
}

window.restartGame = () => {
  document.getElementById('reward-screen').style.display = 'none';
  document.getElementById('pause-menu').style.display = 'none';
  isPaused = false;
  app.ticker.speed = 1; // 確保速度恢復
  showLoadingScreen(startGame);
};

window.returnToMenu = () => {
  isGameRunning = false;
  isGameOver = false;
  isPaused = false;
  app.ticker.speed = 1; // 確保速度恢復

  const fpsDisplay = document.getElementById('fps-display');
  if (fpsDisplay) fpsDisplay.style.display = 'none';

  // 清理世界並重新生成原有的演示背景物件 (4個特定 NPC)
  clearWorld();
  for (let i = 0; i < 4; i++) {
    const rx = CONFIG.worldSize / 2 + (Math.random() - 0.5) * 1500;
    const ry = CONFIG.worldSize / 2 + (Math.random() - 0.5) * 1500;
    if (i === 0) {
      spawnNPC(i, rx, ry, 700, true, false, true, false, false, 1.0, 1.1);
    } else if (i === 1) {
      spawnNPC(i, rx, ry, 500, false, true, true, true, false, 1.0, 1.1);
    } else if (i === 2) {
      spawnNPC(i, rx, ry, 25, false, false, false, false, true, 0.25, 1.3);
    } else {
      spawnNPC(i, rx, ry, null, false, false, true, false, false, 1.0, 1.1);
    }
  }
  for (let i = 0; i < CONFIG.nodeCount; i++) spawnNode();
  for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

  const startMenu = document.getElementById('start-menu');
  document.getElementById('pause-menu').style.display = 'none';
  document.getElementById('reward-screen').style.display = 'none';
  startMenu.style.display = 'flex';
  document.querySelector('.ui-overlay').style.display = 'none';

  // 觸發進場動畫
  startMenu.classList.remove('animate-in');
  void startMenu.offsetWidth; // 觸發 reflow
  startMenu.classList.add('animate-in');

  // Refresh main screen info
  refreshProgressDisplay();
  renderSkillsPage();
  loadHistory();
};

// PAUSE SYSTEM
function togglePause() {
  if (!isGameRunning || isGameOver || isTutorialActive()) return;
  isPaused = !isPaused;
  const pauseMenu = document.getElementById('pause-menu');
  const uiOverlay = document.querySelector('.ui-overlay');

  if (isPaused) {
    pauseMenu.style.display = 'flex';
    uiOverlay.style.display = 'none';
    app.ticker.speed = 0;
    tutorialPauseStart = Date.now();
  } else {
    pauseMenu.style.display = 'none';
    uiOverlay.style.display = 'block';
    app.ticker.speed = 1;
    if (tutorialPauseStart) {
      startTime += Date.now() - tutorialPauseStart;
      tutorialPauseStart = 0;
    }
  }
}

// PWA INSTALL LOGIC
let deferredPrompt;
const installBtns = document.querySelectorAll('#install-pwa-btn, #install-pwa-btn-mobile');

function updateInstallBtnVisibility() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) {
    installBtns.forEach(btn => btn.style.setProperty('display', 'none', 'important'));
  }
}

// Initial check
updateInstallBtnVisibility();

window.addEventListener('beforeinstallprompt', (e) => {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) return;

  e.preventDefault();
  deferredPrompt = e;
  installBtns.forEach(btn => {
    btn.style.display = 'block';
    btn.innerText = '安裝應用程式';
  });
});

installBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      installBtns.forEach(b => b.style.setProperty('display', 'none', 'important'));
    }
    deferredPrompt = null;
  });
});

window.addEventListener('appinstalled', () => {
  console.log('PWA was installed');
  installBtns.forEach(btn => btn.style.setProperty('display', 'none', 'important'));
  deferredPrompt = null;
});

// Event Listeners for Pause
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('p-resume-btn').addEventListener('click', togglePause);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !isTutorialActive()) {
    togglePause();
  }
});

// ==========================================================
// PROGRESSION SYSTEM FUNCTIONS
// ==========================================================

/**
 * 初始化成長系統 UI（Tab 切換、等級/金幣顯示、技能頁面）
 */
function initProgressionUI() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');
      btn.classList.add('active');
    });
  });

  refreshProgressDisplay();
  renderSkillsPage();
}

/**
 * 刷新主選單的等級/金幣/經驗條顯示
 */
function refreshProgressDisplay() {
  const pct = getLevelProgress(progress);
  const levelLabel = document.getElementById('level-label');

  // Calculate raw XP for display
  const startXP = getXPForCurrentLevel(progress.level);
  const nextLevelXP = getXPForNextLevel(progress.level);
  const curXP = Math.floor(progress.xp - startXP);
  const reqXP = Math.floor(nextLevelXP - startXP);
  const xpStr = progress.level >= MAX_LEVEL ? 'MAX' : `${curXP} / ${reqXP}`;

  if (progress.level >= MAX_LEVEL) {
    levelLabel.textContent = 'MAX';
    levelLabel.classList.add('is-max');
    document.getElementById('xp-bar-fill').style.width = '100%';
    document.getElementById('xp-percent').textContent = '100%';
  } else {
    levelLabel.textContent = `Lv.${progress.level}`;
    levelLabel.classList.remove('is-max');
    document.getElementById('xp-bar-fill').style.width = `${Math.round(pct * 100)}%`;
    document.getElementById('xp-percent').textContent = `${Math.round(pct * 100)}%`;
  }

  // Update Numerical XP Text
  const xpText = document.getElementById('xp-text');
  if (xpText) xpText.textContent = xpStr;

  document.getElementById('gold-amount').textContent = progress.gold;

  // [NEW] Sync Mobile Stats Corner
  const mLevel = document.getElementById('m-level');
  const mGold = document.getElementById('m-gold');
  const mXpFill = document.getElementById('m-xp-fill');
  const mXpText = document.getElementById('m-xp-text');

  if (mLevel) mLevel.textContent = progress.level >= MAX_LEVEL ? 'MAX' : progress.level;
  if (mGold) mGold.textContent = progress.gold;
  if (mXpFill) mXpFill.style.width = `${Math.round(pct * 100)}%`;
  if (mXpText) mXpText.textContent = xpStr;

  // Sync skin page gold
  const skinGold = document.getElementById('skin-gold-amount');
  if (skinGold) skinGold.textContent = progress.gold;
}

/**
 * 渲染技能頁面（卡片狀態、裝備欄、技能點）
 */
function renderSkillsPage() {
  console.log('[Progression] Rendering Skills Page. Current Progress:', JSON.parse(JSON.stringify(progress)));
  document.getElementById('skill-points-count').textContent = progress.skillPoints;

  // Equipped banner
  const equipped = progress.equippedSkill;
  if (equipped && SKILL_DEFS[equipped]) {
    const def = SKILL_DEFS[equipped];
    document.getElementById('equipped-skill-icon').textContent = def.icon;
    document.getElementById('equipped-skill-name').textContent = def.name;
  } else {
    document.getElementById('equipped-skill-icon').textContent = '—';
    document.getElementById('equipped-skill-name').textContent = '預設加速';
  }

  // Render each skill card
  const unlockCosts = { sprint: 0, tripleDash: 1, overdrive: 2, flashStep: 3 };
  const levelReqs = { sprint: 2, tripleDash: 1, overdrive: 1, flashStep: 1 };

  ['sprint', 'overdrive', 'tripleDash', 'flashStep'].forEach(id => {
    const skill = progress.skills[id];
    const card = document.querySelector(`.skill-card[data-skill="${id}"]`);
    const actionsEl = document.getElementById(`actions-${id}`);

    card.classList.remove('locked', 'equipped');

    if (!skill.unlocked) {
      card.classList.add('locked');
      const cost = unlockCosts[id];
      const lvlReq = levelReqs[id];

      let btnLabel = `${cost} 技能點`;
      if (id === 'sprint' && progress.level < 2) {
        btnLabel = 'Lv.2 解鎖';
      }

      const canUnlock = progress.level >= lvlReq && progress.skillPoints >= cost;
      actionsEl.innerHTML = `<button class="btn-unlock" ${!canUnlock ? 'disabled' : ''} data-action="unlock" data-skill="${id}">${btnLabel}</button>`;
    } else {
      let html = '';
      if (equipped === id) {
        card.classList.add('equipped');
        // 改為「卸下」按鈕
        html += `<button class="btn-unequip" data-action="unequip" data-skill="${id}">卸下</button>`;
      } else {
        html += `<button class="btn-equip" data-action="equip" data-skill="${id}">裝備</button>`;
      }
      actionsEl.innerHTML = html;
    }
  });

  // Bind action buttons (event delegation)
  document.querySelectorAll('.skill-card-actions button[data-action]').forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.action;
      const skillId = btn.dataset.skill;
      if (action === 'unlock') {
        unlockSkill(progress, skillId);
      } else if (action === 'equip') {
        equipSkill(progress, skillId);
        onSkillEquipped(skillId);
      } else if (action === 'unequip') {
        progress.equippedSkill = null;
      } else if (action === 'upgrade') {
        upgradeSkill(progress, skillId);
      }
      saveProgress(progress);
      renderSkillsPage();
      refreshProgressDisplay();
    };
  });
}

/**
 * 更新遊戲內技能按鈕的名稱與圖示
 */
function updateInGameSkillButton() {
  const nameEl = document.querySelector('.skill-name');
  if (!nameEl) return;
  if (!skillState || skillState.isDefaultBoost) {
    nameEl.textContent = '加速';
  } else {
    const def = getSkillDef(skillState.skillId);
    nameEl.textContent = def ? def.name : '加速';
  }
}

/**
 * 處理技能啟動（按下/點擊）
 */
function handleSkillActivation() {
  if (!player || !skillState || skillState.isDefaultBoost) return;
  const { canUse } = canUseSkill(skillState, player);
  if (!canUse) return;

  const def = getSkillDef(skillState.skillId);
  if (!def) return;

  switch (skillState.skillId) {
    case 'sprint':
      executeSprint();
      break;
    case 'overdrive':
      if (skillState.isActive) {
        // 再次點按提前結束
        endOverdrive();
      } else {
        startOverdrive();
      }
      break;
    case 'tripleDash':
      executeTripleDash();
      break;
    case 'flashStep':
      startFlashStepChannel();
      break;
  }
}

/**
 * 處理技能停止（放開）
 */
function handleSkillDeactivation() {
  if (!player || !skillState || skillState.isDefaultBoost) return;
  if (skillState.skillId === 'flashStep' && skillState.isChanneling) {
    executeFlashStep();
  }
}

// --- Sprint ---
function executeSprint() {
  const def = SKILL_DEFS.sprint;
  const buff = getComboBuff();
  const cost = Math.floor(getSkillParam(def, 'massCost', skillState.level) * buff);
  if (player.mass < cost + 5) return;

  player.mass -= cost;
  showMassFeed(-cost, 'red');
  // Dash in current movement direction
  const vel = player.body.velocity;
  let angle = Math.atan2(vel.y, vel.x);

  if (isTouchDevice && joystick.vector.x !== 0) {
    // 手機模式：優先使用搖桿指向
    angle = Math.atan2(joystick.vector.y, joystick.vector.x);
  } else if (Math.sqrt(vel.x * vel.x + vel.y * vel.y) < 0.5) {
    // PC 模式或靜止時：使用滑鼠方向
    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    angle = Math.atan2(diff.y, diff.x);
  }

  player.sprintVisualTimer = 200; // 200ms 的變形效果
  const force = def.dashForce;
  Matter.Body.setVelocity(player.body, {
    x: Math.cos(angle) * force,
    y: Math.sin(angle) * force
  });

  // VFX: Trail
  const radius = calculateRadius(player.mass);
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      if (player) createTrail(player.body.position.x, player.body.position.y, radius, 0xFFFFFF, 0.4, 400);
    }, i * 40);
  }

  screenShake = Math.max(screenShake, 15);
  startCooldown(skillState, buff);
}

// --- Overdrive ---
function startOverdrive() {
  // 啟動加速狀態
  skillState.overdrivePhase = 'rampUp';
  skillState.overdriveElapsed = 0;
  skillState.overdriveSpeedMult = 1.01;
  player.isBoosting = true;

  // 立即進入「充能模式」，並套用 Combo 帶來的能量減免
  startCooldown(skillState, getComboBuff());
  // 強制重新標記為活躍，因為 startCooldown 會將其設為 false
  skillState.isActive = true;
}

function endOverdrive() {
  skillState.overdrivePhase = 'idle';
  skillState.overdriveSpeedMult = 1.0;
  skillState.isActive = false;
  player.isBoosting = false;
}

// --- Triple Dash ---
function executeTripleDash() {
  const def = SKILL_DEFS.tripleDash;
  const costPerDash = getSkillParam(def, 'massCostPerDash', skillState.level);
  if (player.mass < costPerDash * 3 + 5) return;

  skillState.isActive = true;
  skillState.tripleDashRemaining = 3;
  skillState.tripleDashTimer = 0;
  performSingleDash(costPerDash);
}

function performSingleDash(cost) {
  if (!player || player.isDestroyed) return;

  const buff = getComboBuff();
  // Use percentage-based mass cost for Triple Dash
  const actualCost = Math.floor(player.mass * 0.015 * buff); // 1.5% mass * buff
  player.mass -= actualCost;
  showMassFeed(-actualCost, 'red');

  // Dash toward current mouse/joystick direction
  let angle = 0;
  if (isTouchDevice && (joystick.vector.x !== 0 || joystick.vector.y !== 0)) {
    angle = Math.atan2(joystick.vector.y, joystick.vector.x);
  } else {
    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    angle = Math.atan2(diff.y, diff.x);
  }

  const force = SKILL_DEFS.tripleDash.dashForce;
  player.dashVisualTimer = 300; // Trigger body stretch for 300ms
  Matter.Body.setVelocity(player.body, {
    x: Math.cos(angle) * force,
    y: Math.sin(angle) * force
  });

  // VFX: Ghostly dash (Below player)
  const radius = calculateRadius(player.mass);
  createTrail(player.body.position.x, player.body.position.y, radius, 0xFFFFFF, 0.6, 500);
  triggerShockwave(player.body.position.x, player.body.position.y, 0xFFFFFF);

  screenShake = Math.max(screenShake, 12);
  skillState.tripleDashRemaining--;

  if (skillState.tripleDashRemaining <= 0) {
    startCooldown(skillState, getComboBuff());
  }
}

// --- Flash Step ---
let flashStepIndicator = null;
let flashStepLine = null;

function startFlashStepChannel() {
  skillState.isChanneling = true;
  skillState.isActive = true;
  timeScale = SKILL_DEFS.flashStep.slowMotionScale;

  // Add visual effect class
  document.body.classList.add('skill-channeling');
  if (!isTouchDevice) document.body.classList.add('hide-cursor');

  // Create indicator circle and line
  flashStepIndicator = new PIXI.Graphics();
  flashStepLine = new PIXI.Graphics();
  gameContainer.addChild(flashStepLine);
  gameContainer.addChild(flashStepIndicator);
}

async function executeFlashStep() {
  if (!skillState.isChanneling) return;
  skillState.isChanneling = false;
  
  // Smoothly recover timeScale (linear decay over 400ms)
  const startT = timeScale;
  const targetT = 1.0;
  const duration = 400;
  const startTimeRec = Date.now();
  
  const recovery = () => {
    const elapsed = Date.now() - startTimeRec;
    const p = Math.min(1, elapsed / duration);
    timeScale = startT + (targetT - startT) * p;
    if (p >= 1) app.ticker.remove(recovery);
  };
  app.ticker.add(recovery);

  document.body.classList.remove('skill-channeling');
  document.body.classList.remove('hide-cursor');

  const def = SKILL_DEFS.flashStep;
  const cost = getSkillParam(def, 'massCost', skillState.level);
  if (player.mass < cost + 5) {
    cleanupFlashStepVisuals();
    skillState.isActive = false;
    return;
  }

  if (cost > 0) {
    player.mass -= cost;
    showMassFeed(-cost, 'red');
  }

  // Calculate target position
  let targetX, targetY;
  const radius = calculateRadius(player.mass);
  const maxDist = radius * def.maxRangeMultiplier;

  if (isTouchDevice && skillDrag.active && (skillDrag.vector.x !== 0 || skillDrag.vector.y !== 0)) {
    // 手機模式：使用技能鈕拖動位移決定落點
    const mag = Math.sqrt(skillDrag.vector.x ** 2 + skillDrag.vector.y ** 2);
    const clampedDist = mag * maxDist;
    const angle = Math.atan2(skillDrag.vector.y, skillDrag.vector.x);
    targetX = player.body.position.x + Math.cos(angle) * clampedDist;
    targetY = player.body.position.y + Math.sin(angle) * clampedDist;
  } else if (isTouchDevice) {
    // 手機模式：若沒拖動，則往目前移動方向閃現一段距離
    const vel = player.body.velocity;
    const moveAngle = Math.atan2(vel.y, vel.x);
    const d = maxDist * 0.6; // 預設 60% 距離
    targetX = player.body.position.x + Math.cos(moveAngle) * d;
    targetY = player.body.position.y + Math.sin(moveAngle) * d;
  } else {
    // PC 模式：使用滑鼠座標
    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    const dist = Matter.Vector.magnitude(diff);
    const clampedDist = Math.min(dist, maxDist);
    const norm = Matter.Vector.normalise(diff);
    targetX = player.body.position.x + norm.x * clampedDist;
    targetY = player.body.position.y + norm.y * clampedDist;
  }

  // 邊界限制
  targetX = Math.max(100, Math.min(CONFIG.worldSize - 100, targetX));
  targetY = Math.max(100, Math.min(CONFIG.worldSize - 100, targetY));

  const startX = player.body.position.x;
  const startY = player.body.position.y;
  const startPos = { x: startX, y: startY };

  // NEW: Fast Dash instead of teleport
  const dashSteps = 2; // Reduced for faster movement

  let killedSomething = false;

  // Animation for fast movement
  for (let i = 1; i <= dashSteps; i++) {
    const t = i / dashSteps;
    const curX = startX + (targetX - startX) * t;
    const curY = startY + (targetY - startY) * t;
    Matter.Body.setPosition(player.body, { x: curX, y: curY });
    Matter.Body.setVelocity(player.body, { x: 0, y: 0 });

    // Tiny delay for visual speed
    await new Promise(r => setTimeout(r, 8)); // Faster delay
  }

  // Final position
  Matter.Body.setPosition(player.body, { x: targetX, y: targetY });

  // KILL CHECK: Only at target position
  entities.forEach(ent => {
    if (ent === player || ent.isDestroyed || ent.isPlayer) return;
    if (ent.mass >= player.mass) return;

    const diff = Matter.Vector.sub(ent.body.position, { x: targetX, y: targetY });
    const dist = Matter.Vector.magnitude(diff);
    const entRadius = calculateRadius(ent.mass);

    if (dist < radius + entRadius) {
      const gainedMass = ent.mass * 0.5;
      player.mass += gainedMass;
      killCount++;
      killedSomething = true;

      updateCombo();
      showMassFeed(gainedMass, 'green');

      // 補充技能能量 (擊殺轉化率降低為 10%)
      if (skillState) addSkillEnergy(skillState, gainedMass * 0.1);

      // TRIGGER SHAKE WITH SLIGHT DELAY (to avoid being cancelled by high-speed movement interpolation)
      setTimeout(() => {
        screenShake = Math.max(screenShake, 60);
      }, 50);

      shatterEntity(ent);

      // Blade slash effect (Now just at hit point)
      drawBladeSlash(startPos, { x: targetX, y: targetY });

      // Brief Time Freeze on kill
      timeScale = 0;
      setTimeout(() => { if (!skillState.isChanneling) timeScale = 1.0; }, 150);
    }
  });

  // VFX

  cleanupFlashStepVisuals();
  startCooldown(skillState, getComboBuff());
  skillState.isActive = false;
}

function drawBladeSlash(start, end) {
  const slash = new PIXI.Graphics();
  slash.moveTo(start.x, start.y);
  slash.lineTo(end.x, end.y);
  slash.stroke({ width: 2, color: 0xFFFFFF, alpha: 0.8, cap: 'round' }); // Thin white line
  gameContainer.addChild(slash);

  let alpha = 0.8;
  const anim = (d) => {
    alpha -= 0.05 * d.deltaTime;
    slash.alpha = alpha;
    if (alpha <= 0) {
      gameContainer.removeChild(slash);
      app.ticker.remove(anim);
    }
  };
  app.ticker.add(anim);
}

function cleanupFlashStepVisuals() {
  if (flashStepIndicator) { gameContainer.removeChild(flashStepIndicator); flashStepIndicator = null; }
  if (flashStepLine) { gameContainer.removeChild(flashStepLine); flashStepLine = null; }
}

/** Point-to-segment distance helper */
function pointToSegmentDist(p, a, b) {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const ap = { x: p.x - a.x, y: p.y - a.y };
  const t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / (ab.x * ab.x + ab.y * ab.y)));
  const proj = { x: a.x + t * ab.x, y: a.y + t * ab.y };
  return Math.sqrt((p.x - proj.x) ** 2 + (p.y - proj.y) ** 2);
}

/**
 * 每幀更新技能效果（Overdrive 漸增、Triple Dash 連擊、Flash Step 指示器）
 */
function updateSkillEffects(delta) {
  if (!skillState || !player || player.isDestroyed) return;
  const dt = delta.deltaTime;

  // Overdrive ramp-up and sustain
  if (skillState.skillId === 'overdrive' && skillState.isActive) {
    const def = SKILL_DEFS.overdrive;
    skillState.overdriveElapsed += delta.elapsedMS;

    if (skillState.overdrivePhase === 'rampUp') {
      const overdriveProgress = Math.min(1, skillState.overdriveElapsed / def.rampUpDuration);
      skillState.overdriveSpeedMult = 1.0 + overdriveProgress * (def.maxSpeedMult - 1.0);
      if (overdriveProgress >= 1) {
        skillState.overdrivePhase = 'sustain';
        skillState.overdriveElapsed = 0;
      }
      player.isBoosting = true;
    } else if (skillState.overdrivePhase === 'sustain') {
      const sustainDur = getSkillParam(def, 'sustainDuration', skillState.level);
      skillState.overdriveSpeedMult = def.maxSpeedMult;
      if (skillState.overdriveElapsed >= sustainDur) {
        skillState.overdrivePhase = 'decay';
        skillState.overdriveElapsed = 0;
      }
      player.isBoosting = true;
    } else if (skillState.overdrivePhase === 'decay') {
      const decayDur = 800; // 0.8秒平滑跌落
      const decayProgress = Math.min(1, skillState.overdriveElapsed / decayDur);
      // 從 maxSpeedMult 跌落回 1.0
      skillState.overdriveSpeedMult = def.maxSpeedMult - decayProgress * (def.maxSpeedMult - 1.0);
      if (decayProgress >= 1) {
        endOverdrive();
      }
      player.isBoosting = true;
    }
    // Trigger boost particles
    triggerBoostParticles(player);
  }

  // Triple Dash interval
  if (skillState.skillId === 'tripleDash' && skillState.isActive && skillState.tripleDashRemaining > 0) {
    skillState.tripleDashTimer += delta.elapsedMS;
    if (skillState.tripleDashTimer >= SKILL_DEFS.tripleDash.dashInterval) {
      skillState.tripleDashTimer = 0;
      const costPerDash = getSkillParam(SKILL_DEFS.tripleDash, 'massCostPerDash', skillState.level);
      performSingleDash(costPerDash);
      if (skillState.tripleDashRemaining <= 0) {
        skillState.isActive = false;
        startCooldown(skillState, getComboBuff());
      }
    }
  }

  // Flash Step channeling visuals
  if (skillState.skillId === 'flashStep' && skillState.isChanneling && flashStepIndicator && flashStepLine) {
    const radius = calculateRadius(player.mass);
    const maxDist = radius * SKILL_DEFS.flashStep.maxRangeMultiplier;

    let tx, ty;
    if (isTouchDevice && skillDrag.active && (skillDrag.vector.x !== 0 || skillDrag.vector.y !== 0)) {
      const mag = Math.sqrt(skillDrag.vector.x ** 2 + skillDrag.vector.y ** 2);
      const d = mag * maxDist;
      const angle = Math.atan2(skillDrag.vector.y, skillDrag.vector.x);
      tx = player.body.position.x + Math.cos(angle) * d;
      ty = player.body.position.y + Math.sin(angle) * d;
    } else if (isTouchDevice) {
      // 預設朝向移動方向
      const vel = player.body.velocity;
      const angle = Math.atan2(vel.y, vel.x);
      const d = maxDist * 0.6;
      tx = player.body.position.x + Math.cos(angle) * d;
      ty = player.body.position.y + Math.sin(angle) * d;
    } else {
      const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
      const worldMouse = app.stage.toLocal(screenPos);
      const diff = Matter.Vector.sub(worldMouse, player.body.position);
      const dist = Matter.Vector.magnitude(diff);
      const d = Math.min(dist, maxDist);
      const norm = Matter.Vector.normalise(diff);
      tx = player.body.position.x + norm.x * d;
      ty = player.body.position.y + norm.y * d;
    }
    tx = Math.max(100, Math.min(CONFIG.worldSize - 100, tx));
    ty = Math.max(100, Math.min(CONFIG.worldSize - 100, ty));

    // Draw target circle
    flashStepIndicator.clear();
    flashStepIndicator.circle(tx, ty, radius);
    flashStepIndicator.stroke({ width: 3, color: 0xFFFFFF, alpha: 0.7 });

    // --- [NEW] Tactical Crosshair inside indicator ---
    const crossSize = radius * 0.4;
    flashStepIndicator.moveTo(tx - crossSize, ty);
    flashStepIndicator.lineTo(tx + crossSize, ty);
    flashStepIndicator.moveTo(tx, ty - crossSize);
    flashStepIndicator.lineTo(tx, ty + crossSize);
    flashStepIndicator.stroke({ width: 2, color: 0xFFFFFF, alpha: 0.5 });

    // Draw dashed line
    flashStepLine.clear();
    const segments = 12;
    const finalDiff = { x: tx - player.body.position.x, y: ty - player.body.position.y };

    for (let i = 0; i < segments; i++) {
      if (i % 2 === 0) {
        const s = i / segments;
        const e = (i + 1) / segments;
        const sx = player.body.position.x + finalDiff.x * s;
        const sy = player.body.position.y + finalDiff.y * s;
        const ex = player.body.position.x + finalDiff.x * e;
        const ey = player.body.position.y + finalDiff.y * e;
        flashStepLine.moveTo(sx, sy);
        flashStepLine.lineTo(ex, ey);
      }
    }
    flashStepLine.stroke({ width: 2, color: 0xFFFFFF, alpha: 0.4 });
  }
}

/**
 * 更新遊戲內技能冷卻 UI（按鈕上的遮罩與倒數）
 */
function updateCooldownUI() {
  if (!skillState || skillState.isDefaultBoost) return;
  const skillBtn = document.getElementById('skill-btn');
  let overlay = skillBtn.querySelector('.cooldown-overlay');
  let cdText = skillBtn.querySelector('.cooldown-text');
  let chargeBadge = skillBtn.querySelector('.charge-badge');
  const cdProgress = getCooldownProgress(skillState);

  // Show charges if applicable
  if (skillState.maxCharges > 1) {
    if (!chargeBadge) {
      chargeBadge = document.createElement('div');
      chargeBadge.className = 'charge-badge';
      skillBtn.appendChild(chargeBadge);
    }
    chargeBadge.textContent = skillState.charges;
  } else if (chargeBadge) {
    chargeBadge.remove();
  }


  if (cdProgress > 0) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'cooldown-overlay';
      skillBtn.appendChild(overlay);
    }
    if (!cdText) {
      cdText = document.createElement('div');
      cdText.className = 'cooldown-text';
      skillBtn.appendChild(cdText);
    }

    const def = SKILL_DEFS[skillState.skillId];
    const nameEl = skillBtn.querySelector('.skill-name');
    const iconEl = skillBtn.querySelector('.skill-icon');

    // 計算能量/進度百分比 (0-100)
    let pct = 0;
    if (def && def.energyRequired) {
      const total = getSkillParam(def, 'energyRequired', skillState.level);
      const current = total - skillState.cooldownRemaining;
      pct = Math.floor((current / total) * 100);

      const isReady = skillState.charges > 0;
      cdText.textContent = isReady ? '' : `${pct}%`;
      if (nameEl) nameEl.style.display = isReady ? 'block' : 'none';
      if (iconEl) iconEl.style.display = isReady ? 'block' : 'none';

      overlay.style.clipPath = `inset(${100 - pct}% 0 0 0)`;
    } else {
      const secs = Math.ceil(skillState.cooldownRemaining / 1000);
      const isReady = skillState.charges > 0;
      cdText.textContent = isReady ? '' : `${secs}s`;
      if (nameEl) nameEl.style.display = isReady ? 'block' : 'none';
      if (iconEl) iconEl.style.display = isReady ? 'block' : 'none';

      overlay.style.clipPath = `inset(${100 - (cdProgress * 100)}% 0 0 0)`;
    }

    if (skillState.charges <= 0) {
      skillBtn.classList.add('disabled');
    } else {
      skillBtn.classList.remove('disabled');
    }
  } else {
    // 當冷卻完全結束 (cdProgress == 0)
    const def = SKILL_DEFS[skillState.skillId];
    const nameEl = skillBtn.querySelector('.skill-name');
    const iconEl = skillBtn.querySelector('.skill-icon');

    if (nameEl) nameEl.style.display = 'block';
    if (iconEl) iconEl.style.display = 'block';

    if (def && def.energyRequired) {
      // 能量制技能滿了以後，應保持全白填充
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'cooldown-overlay';
        skillBtn.appendChild(overlay);
      }
      overlay.style.clipPath = 'inset(0% 0 0 0)';
      if (cdText) cdText.textContent = '';
    } else {
      if (overlay) overlay.remove();
      if (cdText) cdText.remove();
    }

    // Also check if mass is insufficient
    const { canUse } = canUseSkill(skillState, player || { mass: 0 });
    if (!canUse && !skillState.isActive) {
      skillBtn.classList.add('disabled');
    } else {
      skillBtn.classList.remove('disabled');
    }
  }
}

/**
 * 顯示結算獎勵畫面（勝利或敗場）
 */
async function showRewardScreen(isVictory) {
  const xpReward = calculateXPReward(isVictory, elapsedTime, killCount);
  const goldReward = calculateGoldReward(isVictory, killCount);

  // Capture initial state before granting
  const initialLevel = progress.level;
  const initialXP = progress.xp;
  const initialTotalXP = getXPForNextLevel(initialLevel);
  const initialStartXP = getXPForCurrentLevel(initialLevel);
  const startPct = initialXP >= initialTotalXP ? 1 : (initialXP - initialStartXP) / (initialTotalXP - initialStartXP);

  console.log('[Progression] Granting XP. Before:', { level: progress.level, xp: progress.xp });
  const result = grantXP(progress, xpReward);
  grantGold(progress, goldReward);
  console.log('[Progression] Granting XP. After:', { level: progress.level, xp: progress.xp, sprint: progress.skills.sprint.unlocked });
  saveProgress(progress);

  const screen = document.getElementById('reward-screen');
  const title = document.getElementById('reward-title');
  const subtitle = document.getElementById('reward-subtitle');
  const halo = document.getElementById('reward-halo');

  // Set Title and Subtitle based on victory/defeat
  if (isVictory) {
    title.textContent = '獲得勝利';
    title.style.background = 'linear-gradient(135deg, #FFFFFF 0%, #00FFBB 100%)';
    title.style.webkitBackgroundClip = 'text';
    title.style.webkitTextFillColor = 'transparent';
    title.style.filter = 'drop-shadow(0 0 30px rgba(0, 255, 187, 0.4))';

    const mins = Math.floor(elapsedTime / 60000).toString().padStart(2, '0');
    const secs = Math.floor((elapsedTime % 60000) / 1000).toString().padStart(2, '0');
    subtitle.textContent = `達成時間 ${mins}:${secs}`;
    halo.style.display = 'block';
  } else {
    title.textContent = '遊戲結束';
    title.style.background = 'linear-gradient(135deg, #FFFFFF 0%, #FF4444 100%)';
    title.style.webkitBackgroundClip = 'text';
    title.style.webkitTextFillColor = 'transparent';
    title.style.filter = 'drop-shadow(0 0 30px rgba(255, 68, 68, 0.4))';

    subtitle.textContent = '已被淘汰';
    halo.style.display = 'none';
  }

  screen.style.display = 'flex';

  // Helper for counting up
  const animateNumber = (el, start, end, duration, fmt = v => v) => {
    return new Promise(resolve => {
      let startTime = null;
      const step = (now) => {
        if (!startTime) startTime = now;
        const p = Math.min(1, (now - startTime) / duration);
        el.textContent = fmt(Math.floor(start + (end - start) * p));
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  };

  // Reset UI for animation
  const barFill = document.getElementById(`reward-xp-bar-fill`);
  const levelLabel = document.getElementById(`reward-level-label`);
  const xpValue = document.getElementById(`reward-xp`);
  const goldValue = document.getElementById(`reward-gold`);
  const killsValue = document.getElementById(`reward-kills`);
  const banner = document.getElementById(`reward-level-up-banner`);
  const spRow = document.getElementById(`reward-sp-row`);
  const spValue = document.getElementById(`reward-sp`);

  // 1. XP Bar Initialization
  barFill.style.width = `${startPct * 100}%`;
  levelLabel.textContent = `Lv.${initialLevel}`; // [FIX] 確保初始顯示正確等級
  xpValue.textContent = '+0 XP';
  goldValue.textContent = '+0';
  spRow.style.display = 'none';
  banner.style.display = 'none';
  banner.classList.remove('animate');
  document.getElementById('reward-actions').classList.remove('show');

  // 2. Parallel Staggered Animations
  const anims = [];

  // XP Counter & Bar
  anims.push((async () => {
    await animateNumber(xpValue, 0, xpReward, 1200, v => `+${v} XP`);
  })());

  anims.push((async () => {
    await new Promise(r => setTimeout(r, 200)); // Slight delay
    if (result.levelsGained > 0) {
      // Multiple level ups?
      for (let i = 0; i < result.levelsGained; i++) {
        barFill.style.transition = 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)';
        barFill.style.width = '100%';
        await new Promise(r => setTimeout(r, 850));
        barFill.style.transition = 'none';
        barFill.style.width = '0%';
        void barFill.offsetWidth; // Force reflow
      }
      barFill.style.transition = 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)';
      barFill.style.width = `${getLevelProgress(progress) * 100}%`;
      levelLabel.textContent = `Lv.${progress.level}`;

      // Update Numerical XP during reward
      const rXpText = document.getElementById('reward-xp-text');
      if (rXpText) {
        const sXP = getXPForCurrentLevel(progress.level);
        const nXP = getXPForNextLevel(progress.level);
        rXpText.textContent = progress.level >= MAX_LEVEL ? 'MAX' : `${Math.floor(progress.xp - sXP)} / ${Math.floor(nXP - sXP)}`;
      }

      banner.style.display = 'block';
      banner.classList.add('animate');
    } else {
      barFill.style.transition = 'width 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
      barFill.style.width = `${getLevelProgress(progress) * 100}%`;

      const rXpText = document.getElementById('reward-xp-text');
      if (rXpText) {
        const sXP = getXPForCurrentLevel(progress.level);
        const nXP = getXPForNextLevel(progress.level);
        rXpText.textContent = progress.level >= MAX_LEVEL ? 'MAX' : `${Math.floor(progress.xp - sXP)} / ${Math.floor(nXP - sXP)}`;
      }
    }
  })());

  // Gold
  anims.push((async () => {
    await new Promise(r => setTimeout(r, 400));
    await animateNumber(goldValue, 0, goldReward, 1000, v => `+${v}`);
  })());

  // Skill Points
  if (result.skillPointsGained > 0) {
    anims.push((async () => {
      await new Promise(r => setTimeout(r, 600));
      spRow.style.display = 'flex';
      await animateNumber(spValue, 0, result.skillPointsGained, 800, v => `+${v}`);
    })());
  }

  // 3. Wait for all animations to settle
  await Promise.all(anims);
  await new Promise(r => setTimeout(r, 500));

  // 4. Show actions & Trigger tutorial
  document.getElementById('reward-actions').classList.add('show');
  if (isVictory) triggerConfetti();

  if (progress.level >= 2 && !progress.tutorialDone) {
    console.log('[Tutorial] Animation complete. Waiting 1s to trigger guide.');
    setTimeout(() => {
      // Re-verify we are still on reward screen
      const rs = document.getElementById('reward-screen');
      if (rs && rs.style.display !== 'none') {
        showTutorialStep(1);
      }
    }, 1000);
  }
}

function triggerConfetti() {
  const container = document.getElementById('reward-confetti');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#00FFBB', '#FFFFFF', '#00FFFF', '#FFD700', '#FF00FF'];

  for (let i = 0; i < 80; i++) {
    const p = document.createElement('div');
    p.style.position = 'absolute';
    p.style.width = `${Math.random() * 8 + 4}px`;
    p.style.height = `${Math.random() * 8 + 4}px`;
    p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    p.style.left = `${Math.random() * 100}%`;
    p.style.top = `-20px`;
    p.style.borderRadius = '2px';
    p.style.opacity = Math.random();

    container.appendChild(p);

    const duration = Math.random() * 2 + 1.5;
    const delay = Math.random() * 1.5;
    p.animate([
      { transform: `translate(0, 0) rotate(0deg)`, opacity: 1 },
      { transform: `translate(${(Math.random() - 0.5) * 300}px, ${window.innerHeight + 20}px) rotate(${Math.random() * 1000}deg)`, opacity: 0 }
    ], {
      duration: duration * 1000,
      delay: delay * 1000,
      easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      fill: 'forwards'
    });
  }
}

// ==========================================================
// TUTORIAL PAUSE/RESUME
// ==========================================================

/** 暫停遊戲並記錄暫停起始時間（用於計時補償） */
function pauseForTutorial() {
  if (isPaused) return; // 防止重複重置暫停點
  isPaused = true;
  app.ticker.speed = 0;
  tutorialPauseStart = Date.now();
}

/** 恢復遊戲並補償暫停期間的計時偏差 */
function resumeFromTutorial() {
  if (!isPaused) return; // 如果本來就沒暫停則忽略

  if (tutorialPauseStart) {
    startTime += Date.now() - tutorialPauseStart;
    tutorialPauseStart = 0;
  }
  isPaused = false;
  app.ticker.speed = 1;
}

// ==========================================================
// INITIALIZATION
// ==========================================================

initTutorial({
  progress,
  saveProgress,
  pauseForTutorial,
  resumeFromTutorial,
  isGameRunning: () => isGameRunning,
  getPlayer: () => player,
  calculateRadius,
});

init();
setupTutorialHooks();
window.progress = progress;

// DEBUG HELPERS
window.debugWin = () => {
  elapsedTime = 60000;
  killCount = 10;
  isGameRunning = true;
  winGame();
};

window.debugLevelUp = () => {
  grantXP(progress, 150);
  saveProgress(progress);
  refreshProgressDisplay();
  renderSkillsPage();
};

function createTrail(x, y, radius, color, alpha, duration) {
  const trail = new PIXI.Graphics();
  trail.circle(0, 0, radius);
  trail.fill({ color, alpha });
  trail.position.set(x, y);
  nodeLayer.addChild(trail); // Put in nodeLayer (below entities)

  let elapsed = 0;
  const anim = (d) => {
    elapsed += d.elapsedMS;
    const p = Math.min(1, elapsed / duration);
    trail.alpha = alpha * (1 - p);
    trail.scale.set(1 - 0.3 * p);
    if (p >= 1) {
      nodeLayer.removeChild(trail);
      app.ticker.remove(anim);
    }
  };
  app.ticker.add(anim);
}

function triggerShockwave(x, y, color) {
  const ring = new PIXI.Graphics();
  nodeLayer.addChild(ring); // Put in nodeLayer (below entities)
  let r = 5;
  const anim = (d) => {
    r += 18 * d.deltaTime;
    ring.clear();
    ring.circle(x, y, r);
    ring.stroke({ width: 4, color, alpha: 1 - r / 180 });
    if (r > 180) {
      nodeLayer.removeChild(ring);
      app.ticker.remove(anim);
    }
  };
  app.ticker.add(anim);
}
