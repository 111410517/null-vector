import './style.css';
import './pwa.js';
import * as Matter from 'matter-js';
import * as PIXI from 'pixi.js';
import { CONFIG, calculateRadius } from './constants.js';
import { updateAI } from './ai.js';
import {
  loadProgress, saveProgress, getLevelProgress, grantXP, grantGold,
  calculateXPReward, calculateGoldReward, unlockSkill, equipSkill, upgradeSkill,
  MAX_LEVEL
} from './progression.js';
import {
  SKILL_DEFS, createSkillState, getSkillDef, getSkillParam,
  canUseSkill, updateSkillCooldown, startCooldown, getCooldownProgress
} from './skills.js';

// --- Game State ---
let app, engine, world;
let nodeLayer, entityLayer, virusLayer, powerupLayer, vfxLayer, gameContainer;
let player, entities = [], nodes = [], powerups = [];
let mousePos = { x: 0, y: 0 };
let joystick = { active: false, vector: { x: 0, y: 0 } };
let isGameOver = false;
let isGameRunning = false;
let isPaused = false;
let screenShake = 0;
let joyZone, joyThumb;
let startTime = 0;
let elapsedTime = 0;
let miniCanvas, miniCtx;
let boostAccumulator = 0;
let boostTextTimer = 0;

// --- Progression State ---
let progress = loadProgress();
let skillState = null;
let killCount = 0;
/** 閃現技能的全域時間縮放 (1.0 = 正常, 0.3 = 減速) */
let timeScale = 1.0;

const NPC_NAMES = [
  "Shadow_Hunter", "Zephyr", "Apex_Void", "CyberPulse", "Neon_Ghost",
  "8822", "4040", "11111", "霧島", "Ø_X99_!!!"
];

// --- Initialization ---
async function init() {
  app = new PIXI.Application();
  await app.init({
    width: window.innerWidth, height: window.innerHeight,
    backgroundColor: CONFIG.bgColor, antialias: true, resizeTo: window
  });
  document.getElementById('app').prepend(app.canvas);

  engine = Matter.Engine.create();
  world = engine.world;
  world.gravity.y = 0;

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

  // Create World Mask to clip everything outside boundaries
  const mask = new PIXI.Graphics();
  mask.rect(0, 0, CONFIG.worldSize, CONFIG.worldSize);
  mask.fill(0xffffff);
  gameContainer.mask = mask;
  app.stage.addChild(mask); // Mask needs to be on stage to work correctly in some PIXI versions

  // Initial NPCs
  for (let i = 0; i < 4; i++) {
    spawnNPC(i);
  }

  // Create Nodes
  for (let i = 0; i < CONFIG.nodeCount; i++) spawnNode();

  // Create Viruses (Mother Cells)
  for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

  setupInputs();
  document.getElementById('start-btn').onclick = startGame;

  app.ticker.add((delta) => {
    update(delta);
  });

  setInterval(updateLeaderboard, 1000);
}

function spawnNPC(index) {
  const isSmart = index < (CONFIG.npcCount * 0.5); // 50% Smart AI
  let name;
  if (isSmart) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()";
    name = Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } else {
    name = NPC_NAMES[index % (NPC_NAMES.length - 1)];
  }
  const ent = createEntity(Math.random() * CONFIG.worldSize, Math.random() * CONFIG.worldSize, CONFIG.initialMass, name, false);
  ent.isSmart = isSmart;
  ent.protectionTime = 180;
}

function startGame() {
  // --- RESET WORLD FOR FRESH START ---
  // 1. Remove all entities, nodes, and viruses from stage and world
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

  // 2. Clear arrays
  entities = [];
  nodes = [];
  viruses = [];
  powerups = [];
  killCount = 0;
  timeScale = 1.0;

  // 3. Re-spawn initial game objects
  for (let i = 0; i < CONFIG.nodeCount; i++) spawnNode();
  for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

  // 4. Start Player
  const nameInput = document.getElementById('player-name-input').value || "PLAYER";
  player = createEntity(CONFIG.worldSize / 2, CONFIG.worldSize / 2, CONFIG.initialMass, nameInput, true);
  updateLivesUI();

  // 5. Initialize skill state for this match
  const equipped = progress.equippedSkill;
  const skillLevel = equipped ? (progress.skills[equipped]?.level || 1) : 0;
  skillState = createSkillState(equipped, skillLevel);
  updateInGameSkillButton();
  
  isGameRunning = true;
  startTime = Date.now();
  document.getElementById('start-menu').style.display = 'none';
  document.querySelector('.ui-overlay').style.display = 'block';

  // START RARE ITEM (Delayed by 30s)
  setTimeout(spawnRareItem, 30000); 

  // 6. Start Spawning NPCs over time
  let spawned = 0;
  const spawnInterval = setInterval(() => {
    if (spawned >= CONFIG.npcCount || !isGameRunning) {
      clearInterval(spawnInterval);
      return;
    }
    if (spawned === 0) {
      for (let i = 0; i < 4; i++) spawnNPC(spawned++);
    } else {
      spawnNPC(spawned++);
    }
  }, 1000);
}

// --- Factory Functions ---
function createEntity(x, y, mass, name, isPlayer) {
  const radius = calculateRadius(mass);
  const body = Matter.Bodies.circle(x, y, radius, {
    frictionAir: CONFIG.friction,
    restitution: 0.6,
    label: isPlayer ? 'player' : 'npc'
  });
  
  const container = new PIXI.Container();
  const graphics = new PIXI.Graphics();
  
  // FIXED: Draw at a standard size and let the update loop handle scaling
  // This ensures NPCs and Players of same mass have same size
  const refRadius = calculateRadius(CONFIG.initialMass);
  drawEntityBody(graphics, isPlayer, refRadius);
  container.addChild(graphics);

  // Name Label (Outside Above)
  const nameLabel = new PIXI.Text({
    text: name,
    style: {
      fontFamily: 'Outfit',
      fontSize: 14,
      fill: 0xFFFFFF,
      align: 'center',
      fontWeight: '900',
      dropShadow: { blur: 4, distance: 0, color: 0x000000, alpha: 0.5 }
    }
  });
  nameLabel.anchor.set(0.5, 1.2);
  // Do NOT add to container, add to entityLayer directly to handle Z-order if needed,
  // but for now, we'll keep it in container but ensure wallLayer is higher.
  container.addChild(nameLabel);

  // Mass Label (Inside Center)
  const massLabel = new PIXI.Text({
    text: Math.floor(mass),
    style: {
      fontFamily: 'Outfit',
      fontSize: 28, 
      fill: isPlayer ? 0x000000 : 0xFFFFFF, 
      align: 'center',
      fontWeight: '900',
    }
  });
  massLabel.anchor.set(0.5, 0.5);
  container.addChild(massLabel);
  
  // Ensure vfxLayer is always on top within gameContainer
  if (vfxLayer) gameContainer.setChildIndex(vfxLayer, gameContainer.children.length - 1);

  // Indicator Line
  const indicator = new PIXI.Graphics();
  indicator.visible = false;
  app.stage.addChild(indicator);

  const entity = { 
    body, container, graphics, nameLabel, massLabel, indicator, 
    mass, name, isPlayer, 
    lives: 2,
    protectionTime: 180,
    isBoosting: false,
    isDestroyed: false,

    lifeRings: [],
    dirIndicator: null,
    wobbleOffset: Math.random() * Math.PI * 2,
    smoothRotation: 0,
    boostFactor: 0,
    tailAngle: 0,
    isSmart: false,
    boostBudget: 0,
    isRespawning: false,
    speedMult: 1.0 // Base speed multiplier
  };

  entity.body.collisionFilter = {
    group: -1, // Don't collide with other entities
    category: 0x0002,
    mask: 0x0001 // Only collide with walls (if walls use category 1)
  };

  // Direction Indicator (Triangle)
  if (isPlayer) {
    const dirIndicator = new PIXI.Graphics();
    dirIndicator.poly([0, 0, -12, -6, -12, 6]); 
    dirIndicator.fill({ color: 0xFFFFFF });
    container.addChild(dirIndicator);
    entity.dirIndicator = dirIndicator;
  }

  // Draw initial life rings (1 ring for 2 lives)
  for (let i = 0; i < 1; i++) {
    const ring = new PIXI.Graphics();
    entity.lifeRings.push(ring);
    container.addChild(ring);
  }
  updateLifeRings(entity);
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
    const ripple = Math.sin(angle * 6 + time) * wobbleAmp;
    let r = radius + ripple;
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

// --- Logic ---
function update(delta) {
  if (!isGameRunning || isGameOver || isPaused) return;

  // Apply timeScale (Flash Step bullet time)
  const scaledDeltaMS = Math.min(16.6, delta.elapsedMS) * timeScale;
  Matter.Engine.update(engine, scaledDeltaMS);

  // Update skill cooldown
  if (skillState) {
    updateSkillCooldown(skillState, delta.elapsedMS); // Cooldown uses real time
    updateSkillEffects(delta);
    updateCooldownUI();
  }

  handleInputs();

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
      Matter.Body.setPosition(ent.body, { x: CONFIG.worldSize/2, y: CONFIG.worldSize/2 });
    }
    // --------------------------------------------

    // RESTORE NPC AI
    if (!ent.isPlayer) updateAI(ent, delta, { entities, viruses, nodes, powerups, isGameOver });

    // Protection Effect
    if (ent.protectionTime > 0) {
      ent.protectionTime -= delta.deltaTime;
      ent.container.alpha = 0.4 + Math.sin(Date.now() * 0.01) * 0.4;
    } else {
      ent.container.alpha = 1.0;
    }

    const pos = ent.body.position;
    const radius = calculateRadius(ent.mass);
    ent.body.circleRadius = radius;
    
    // CRITICAL FIX: Synchronize physical mass with logic mass
    // Matter.js doesn't automatically update body.mass when we change logic variables.
    // Without this, large entities keep the initial mass of 30 but get the force of 1000+, 
    // causing them to move at supersonic speeds.
    Matter.Body.setMass(ent.body, ent.mass);
    
    updateLifeRings(ent);

    // DYNAMIC BOOST CONSUMPTION & DEFORMATION LERP
    // Safety check for player boost state to prevent stuck "Overdrive" effect
    if (ent.isPlayer && skillState) {
      const isDefaultBoost = skillState.isDefaultBoost && ent.isBoosting;
      const isOverdrive = skillState.skillId === 'overdrive' && skillState.isActive;
      const isTripleDash = skillState.skillId === 'tripleDash' && skillState.isActive;
      if (!isDefaultBoost && !isOverdrive && !isTripleDash) {
        ent.isBoosting = false;
      }
    }

    const targetBoost = ent.isBoosting ? 1.0 : 0.0;
    ent.boostFactor += (targetBoost - ent.boostFactor) * 0.08;
    
    // Only consume mass if it's NOT a skill boost (Overdrive doesn't cost mass)
    const isSkillBoost = ent.isPlayer && skillState && !skillState.isDefaultBoost && skillState.isActive;
    if (ent.isBoosting && ent.mass > 20 && !isSkillBoost) {
      ent.mass -= 0.01 * delta.deltaTime;
    }

    const baseForce = CONFIG.baseForce * Math.pow(ent.mass / 30, 0.8);

    // TAIL ANGLE LERP (Inertia)
    const currentVelAngle = Math.atan2(ent.body.velocity.y, ent.body.velocity.x);
    let angleDiff = currentVelAngle - ent.tailAngle;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    ent.tailAngle += angleDiff * 0.12; // Adjust for sway speed

    if (ent.isBoosting && ent.mass > CONFIG.initialMass * 0.8 && !isSkillBoost) {
      // Slither.io style: Subtle mass loss (approx 10-15 mass per second for a 1000 mass entity)
      const consumption = (0.01 + ent.mass * 0.00015) * delta.deltaTime;
      ent.mass -= consumption;
      
      // NPC Budget Management
      if (!ent.isPlayer) {
        ent.boostBudget -= consumption;
        if (ent.boostBudget <= 0) ent.isBoosting = false;
      } else {
        boostAccumulator += consumption;
      }
      triggerBoostParticles(ent);
    }

    // SOFT BOUNDARIES & WALL DAMPING
    const springK = 0.01;
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

    // SOFT CENTER REPULSION & EATING (Agar.io Style)
    entities.forEach(other => {
      if (ent === other || other.isDestroyed) return;
      const diff = Matter.Vector.sub(other.body.position, ent.body.position);
      const dist = Matter.Vector.magnitude(diff);
      const otherRadius = calculateRadius(other.mass);
      const combinedRadius = radius + otherRadius;

      if (dist < combinedRadius) {
        // 1. Soft Repulsion (Only when very close to center to avoid stacking)
        const repulsionThreshold = combinedRadius * 0.5;
        if (dist < repulsionThreshold) {
          const overlap = repulsionThreshold - dist;
          const repulsionK = 0.00005; // Much weaker than before (was 0.0002)
          const force = Matter.Vector.mult(Matter.Vector.normalise(diff), overlap * repulsionK);
          Matter.Body.applyForce(other.body, other.body.position, force);
          Matter.Body.applyForce(ent.body, ent.body.position, Matter.Vector.neg(force));
        }

        // 2. Eating Logic
        if (ent.protectionTime <= 0 && other.protectionTime <= 0) {
          // SPECIAL: Disable normal eating for player during Flash Step to prevent logic conflict
          if (ent.isPlayer && skillState && skillState.skillId === 'flashStep' && (skillState.isChanneling || skillState.isActive)) {
            return;
          }

          // Condition: Mass ratio >= 1.25 and small ball center is well within large ball
          // More forgiving threshold: dist < radius * 0.9
          if (ent.mass > other.mass * 1.25 && dist < radius * 0.9) {
            ent.mass += other.mass * 0.5;
            if (ent.isPlayer || other.isPlayer) screenShake = Math.max(screenShake, 40); // Increased to 40
            if (ent.isPlayer && !other.isPlayer) killCount++;
            shatterEntity(other);
          }
        }
      }
    });

    // Sync Graphics
    ent.container.x = ent.body.position.x;
    ent.container.y = ent.body.position.y;
    ent.massLabel.text = Math.floor(ent.mass);
    
    // Position name label above the scaled graphics
    ent.nameLabel.y = -radius - 15;
    
    drawEntityBody(ent.graphics, ent.isPlayer, radius, ent);

    // TEXT COMPENSATION: Counter-act stage zoom to keep text readable
    const inverseZoom = 1 / app.stage.scale.x;
    ent.nameLabel.scale.set(inverseZoom);
    ent.massLabel.scale.set(inverseZoom);

    // Velocity Clamping removed to allow pure physical formula balancing as suggested.
    // Friction (0.12) and Force (mass^0.6) will naturally define terminal velocity.

    checkCollisions(ent);

    // Update Direction Indicator (Outside of Life Rings)
    if (ent.isPlayer && ent.dirIndicator) {
      const vel = ent.body.velocity;
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed > 0.5) {
        ent.dirIndicator.visible = true;
        const targetAngle = Math.atan2(vel.y, vel.x);
        
        // SMOOTH ROTATION (Lerp) to prevent bouncing
        let diff = targetAngle - ent.smoothRotation;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        ent.smoothRotation += diff * 0.2;
        ent.dirIndicator.rotation = ent.smoothRotation;
        
        // Counter-act stage zoom
        const inverseZoom = 1 / app.stage.scale.x;
        ent.dirIndicator.scale.set(inverseZoom);

        // GET ACTUAL RADIUS AT THIS ANGLE
        const deformedR = getDeformedRadius(ent, ent.smoothRotation, radius);
        
        // Position relative to current shape edge
        const ringSpacing = 0.15;
        const ringOffsetMult = (ent.lives > 1 ? (ent.lives - 1) * ringSpacing + 0.1 : 0.05);
        const dist = deformedR + (radius * ringOffsetMult) + (15 * inverseZoom);
        
        ent.dirIndicator.x = Math.cos(ent.smoothRotation) * dist;
        ent.dirIndicator.y = Math.sin(ent.smoothRotation) * dist;
      } else {
        ent.dirIndicator.visible = false;
      }
    }
  });

  // Camera Zoom & Follow Logic
  const minZoom = Math.max(app.screen.width, app.screen.height) / (CONFIG.worldSize * 1.05);
  const zoomLerp = 0.04;
  const followLerp = 0.1;

  if (player) {
    let targetZoom = Math.max(minZoom, 0.85 / (1 + (player.mass - CONFIG.initialMass) * 0.0006));
    // SLITHER.IO CAMERA: Zoom out slightly when boosting for better vision
    if (player.isBoosting) targetZoom *= 0.85; 
    app.stage.scale.x += (targetZoom - app.stage.scale.x) * zoomLerp;
    app.stage.scale.y += (targetZoom - app.stage.scale.y) * zoomLerp;

    app.stage.pivot.x += (player.body.position.x - app.stage.pivot.x) * followLerp;
    app.stage.pivot.y += (player.body.position.y - app.stage.pivot.y) * followLerp;
  } else {
    // Menu background view: stay at center, slightly zoomed in
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

  // Player Exclusive UI & State
  if (player) {
    const skillBtn = document.getElementById('skill-btn');
    // For default boost mode, show active state
    if (skillState && skillState.isDefaultBoost) {
      if (player.isBoosting) {
        skillBtn.classList.add('active');
      } else {
        skillBtn.classList.remove('active');
      }
    } else if (skillState && skillState.isActive) {
      skillBtn.classList.add('active');
    } else {
      skillBtn.classList.remove('active');
    }
  }
  
  // Timer and Victory
  if (isGameRunning && !isGameOver) {
    elapsedTime = Date.now() - startTime;
    const mins = Math.floor(elapsedTime / 60000).toString().padStart(2, '0');
    const secs = Math.floor((elapsedTime % 60000) / 1000).toString().padStart(2, '0');
    const timerEl = document.getElementById('timer-text');
    if (timerEl) timerEl.innerText = `${mins}:${secs}`;
    
    // Accumulative Boost Text
    boostTextTimer += delta.deltaTime;
    if (boostTextTimer > 30) { // Every ~0.5s
      if (boostAccumulator > 1) {
        showFloatingText(player.body.position.x, player.body.position.y, `-${Math.floor(boostAccumulator)}`, 0xFF4444);
        boostAccumulator = 0;
      }
      boostTextTimer = 0;
    }

    // Win Condition (Added delay to allow NPCs to spawn)
    if (elapsedTime > 2000 && entities.length === 1 && entities[0].isPlayer) {
      winGame();
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
  // MOUSE CONTROL (PC Mode)
  if (!joystick.active) {
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
    const finalMult = boostMult * (player.speedMult || 1.0);
    const force = CONFIG.baseForce * Math.pow(player.mass / 30, 0.8) * finalMult;
    
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
  const angle = Math.atan2(vel.y, vel.x) + Math.PI + (Math.random()-0.5) * 0.5;
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





function triggerRespawnVFX(x, y) {
  const ring = new PIXI.Graphics();
  app.stage.addChild(ring);
  let r = 10;
  const rUpdate = (d) => {
    r += 15 * d.deltaTime;
    ring.clear();
    ring.circle(x, y, r);
    ring.stroke({ width: 4, color: 0x00FFFF, alpha: 1 - r/300 });
    if (r > 300) { app.stage.removeChild(ring); app.ticker.remove(rUpdate); }
  };
  app.ticker.add(rUpdate);
}

function triggerNodePickupVFX(x, y, color) {
  for (let i = 0; i < 6; i++) {
    const p = new PIXI.Graphics();
    const size = 2 + Math.random() * 3;
    p.rect(-size/2, -size/2, size, size);
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
    p.poly([0, -size, size/2, size/2, -size/2, size/2]);
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
      
      ent.mass += addedMass;
      
      if (ent.isPlayer) {
        showFloatingText(node.body.position.x, node.body.position.y, `+${addedMass.toFixed(1)}`);
        triggerNodePickupVFX(nPos.x, nPos.y, node.isSpecial ? 0x00FFFF : 0xFFFFFF);
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
        ent.mass += CONFIG.rareItemMass;
        ent.speedMult += 0.2; // Add 20% speed
        showFloatingText(p.body.position.x, p.body.position.y, "GODSPEED +20% | MASS +500", 0xFFFFFF);
        screenShake = Math.max(screenShake, 60); // Increased and used Math.max
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
          if (ent.isPlayer) screenShake = 20;
          
          // Destroy the virus after one split
          virusLayer.removeChild(v.graphics);
          Matter.World.remove(world, v.body);
          viruses.splice(i, 1);
          i--;
          
          // Respawn a new virus elsewhere after a delay
          setTimeout(spawnVirus, 15000);
        }
      }
    }
  }

  // 2. Combat (Integrated into main update loop)
}

function shatterEntity(ent) {
  if (ent.isDestroyed || ent.protectionTime > 0) return;
  
  // Basic shake for any death
  screenShake = Math.max(screenShake, 30);
  
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
      triggerRespawnVFX(rx, ry);
    }
    return;
  }

  ent.isDestroyed = true;

  if (ent.isPlayer) {
    isGameOver = true;
    showRewardScreen(false);
    document.getElementById('game-over').style.display = 'flex';
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
    frag.rect(-s/2, -s/2, s, s);
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
  window.addEventListener('mousemove', (e) => {
    mousePos.x = e.clientX;
    mousePos.y = e.clientY;
  });

  const skillBtn = document.getElementById('skill-btn');
  
  // Skill activation (replaces old boost)
  const activateSkill = () => {
    if (isGameOver || !player || !skillState) return;
    if (skillState.isDefaultBoost) {
      player.isBoosting = true;
      return;
    }
    handleSkillActivation();
  };
  const deactivateSkill = () => {
    if (!player || !skillState) return;
    if (skillState.isDefaultBoost) {
      player.isBoosting = false;
      return;
    }
    handleSkillDeactivation();
  };

  window.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('#leaderboard')) return;
    if (e.button === 0) activateSkill();
  });
  window.addEventListener('mouseup', deactivateSkill);

  skillBtn.addEventListener('touchstart', (e) => { e.preventDefault(); activateSkill(); });
  window.addEventListener('touchend', deactivateSkill);

  joyZone = document.getElementById('joystick-container');
  joyThumb = document.getElementById('joystick-thumb');
  const handleJoy = (e) => {
    if (!joystick.active) return;
    const touch = e.touches ? e.touches[0] : e;
    const rect = joyZone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = touch.clientX - centerX;
    const dy = touch.clientY - centerY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const max = 50;
    const nD = Math.min(dist, max);
    const angle = Math.atan2(dy, dx);
    joystick.vector = { x: Math.cos(angle) * (nD/max), y: Math.sin(angle) * (nD/max) };
    joyThumb.style.transform = `translate(calc(-50% + ${Math.cos(angle)*nD}px), calc(-50% + ${Math.sin(angle)*nD}px))`;
  };

  joyZone.addEventListener('mousedown', () => joystick.active = true);
  joyZone.addEventListener('touchstart', (e) => { e.preventDefault(); joystick.active = true; });
  window.addEventListener('mousemove', handleJoy);
  window.addEventListener('touchmove', handleJoy);
  window.addEventListener('mouseup', () => { joystick.active = false; joyThumb.style.transform = 'translate(-50%, -50%)'; joystick.vector = { x: 0, y: 0 }; });
  window.addEventListener('touchend', () => { joystick.active = false; joyThumb.style.transform = 'translate(-50%, -50%)'; joystick.vector = { x: 0, y: 0 }; });

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
  const x = Math.random() * CONFIG.worldSize;
  const y = Math.random() * CONFIG.worldSize;
  
  const body = Matter.Bodies.circle(x, y, 40, { isSensor: true, label: 'rareItem' });
  const container = new PIXI.Container();
  container.x = x; container.y = y;

  const graphics = new PIXI.Graphics();
  container.addChild(graphics);

  // ADD GLOW EFFECT
  const glow = new PIXI.Graphics();
  glow.circle(0, 0, 60);
  glow.fill({ color: 0xFFFFFF, alpha: 0.2 });
  container.addChildAt(glow, 0);

  const wobbleOffset = Math.random() * 10;
  let t = 0;
  const update = (d) => {
    t += 0.05 * d.deltaTime;
    graphics.clear();
    
    // Use the same Jelly wobble logic as players/NPCs
    const points = 32;
    const radius = 40;
    const time = Date.now() * 0.003 + wobbleOffset;
    
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
    graphics.fill({ color: 0xFFFFFF, alpha: 0.95 });
    graphics.stroke({ width: 6, color: 0xFFFFFF, alpha: 0.4, join: 'round' });

    glow.scale.set(1 + Math.sin(t * 0.5) * 0.2);
    container.scale.set(1 + Math.sin(t) * 0.05);

    if (body.isDestroyed) {
      powerupLayer.removeChild(container);
      app.ticker.remove(update);
    }
  };
  app.ticker.add(update);

  powerups.push({ body, container, type: 'rareItem' });
  Matter.World.add(world, body);
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
  const heart = document.getElementById('central-heart');
  if (!heart) return;
  
  heart.className = ''; // Reset
  if (player.lives >= 2) {
    heart.classList.add('heart-full');
  } else if (player.lives === 1) {
    heart.classList.add('heart-half');
  } else {
    heart.classList.add('heart-empty');
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
}

function winGame() {
  isGameOver = true;
  isGameRunning = false;
  const timeStr = document.getElementById('timer-text').innerText;
  document.getElementById('victory-screen').style.display = 'flex';
  document.getElementById('victory-time-label').innerText = `總計時間：${timeStr}`;
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
    list.innerHTML = '<div class="history-empty">尚無獲勝紀錄</div>';
    return;
  }

  const best = history[0]; // Sorted by time
  const totalWins = history.length;

  let html = `
    <div class="history-summary">
      <div class="summary-item">
        <span class="summary-label">最佳成績</span>
        <span class="summary-value">${best.time}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">總獲勝數</span>
        <span class="summary-value">${totalWins}</span>
      </div>
    </div>
    <div class="history-list-header">近期戰績</div>
  `;

  html += history.map((h, i) => `
    <div class="history-item ${i === 0 ? 'is-best' : ''}">
      <div class="history-item-left">
        <span class="history-icon">${i === 0 ? 'BEST' : 'WIN'}</span>
        <span class="history-date">${h.date}</span>
      </div>
      <span class="history-time">${h.time}</span>
    </div>
  `).join('');
  
  list.innerHTML = html;
}

window.restartGame = () => {
  document.getElementById('victory-screen').style.display = 'none';
  document.getElementById('game-over').style.display = 'none';
  document.getElementById('pause-menu').style.display = 'none';
  isPaused = false;
  startGame();
};

window.returnToMenu = () => {
  isGameRunning = false;
  isGameOver = false;
  isPaused = false;
  document.getElementById('pause-menu').style.display = 'none';
  document.getElementById('victory-screen').style.display = 'none';
  document.getElementById('game-over').style.display = 'none';
  document.getElementById('start-menu').style.display = 'flex';
  document.querySelector('.ui-overlay').style.display = 'none';
  
  // Refresh main screen info
  refreshProgressDisplay();
  loadHistory();
};

// PAUSE SYSTEM
function togglePause() {
  if (!isGameRunning || isGameOver) return;
  isPaused = !isPaused;
  const pauseMenu = document.getElementById('pause-menu');
  const uiOverlay = document.querySelector('.ui-overlay');
  
  if (isPaused) {
    pauseMenu.style.display = 'flex';
    uiOverlay.style.display = 'none';
  } else {
    pauseMenu.style.display = 'none';
    uiOverlay.style.display = 'block';
  }
}

// PWA INSTALL LOGIC
let deferredPrompt;
const installBtn = document.getElementById('install-pwa-btn');

// Check if already in standalone mode
const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
if (isStandalone && installBtn) {
  installBtn.style.display = 'none';
}

window.addEventListener('beforeinstallprompt', (e) => {
  // If we are already in standalone, don't show the button
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) {
    installBtn.style.display = 'block';
    installBtn.innerText = '安裝應用程式';
  }
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      installBtn.style.display = 'none';
    }
    deferredPrompt = null;
  });
}

window.addEventListener('appinstalled', () => {
  console.log('PWA was installed');
  if (installBtn) installBtn.style.display = 'none';
  deferredPrompt = null;
});

// Event Listeners for Pause
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('p-resume-btn').addEventListener('click', togglePause);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
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

  // Unequip skill button
  document.getElementById('unequip-skill-btn').addEventListener('click', () => {
    progress.equippedSkill = null;
    saveProgress(progress);
    renderSkillsPage();
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
  
  document.getElementById('gold-amount').textContent = progress.gold;
  // Sync skin page gold
  const skinGold = document.getElementById('skin-gold-amount');
  if (skinGold) skinGold.textContent = progress.gold;
}

/**
 * 渲染技能頁面（卡片狀態、裝備欄、技能點）
 */
function renderSkillsPage() {
  document.getElementById('skill-points-count').textContent = progress.skillPoints;

  // Equipped banner
  const equipped = progress.equippedSkill;
  const unequipBtn = document.getElementById('unequip-skill-btn');
  if (equipped && SKILL_DEFS[equipped]) {
    const def = SKILL_DEFS[equipped];
    const lvl = progress.skills[equipped].level;
    document.getElementById('equipped-skill-icon').textContent = def.icon;
    document.getElementById('equipped-skill-name').textContent = def.name;
    document.getElementById('equipped-skill-level').textContent = `Lv.${lvl}/3`;
    unequipBtn.style.display = 'inline-block';
  } else {
    document.getElementById('equipped-skill-icon').textContent = '—';
    document.getElementById('equipped-skill-name').textContent = '預設加速';
    document.getElementById('equipped-skill-level').textContent = '';
    unequipBtn.style.display = 'none';
  }

  // Render each skill card
  const unlockCosts = { sprint: 0, tripleDash: 1, overdrive: 2, flashStep: 3 };
  const levelReqs = { sprint: 2, tripleDash: 1, overdrive: 1, flashStep: 1 };

  ['sprint', 'overdrive', 'tripleDash', 'flashStep'].forEach(id => {
    const skill = progress.skills[id];
    const card = document.querySelector(`.skill-card[data-skill="${id}"]`);
    const actionsEl = document.getElementById(`actions-${id}`);

    card.classList.remove('locked', 'equipped');

    // Auto-unlock Sprint at Level 2
    if (id === 'sprint' && progress.level >= 2 && !skill.unlocked) {
      skill.unlocked = true;
      skill.level = 3;
      saveProgress(progress);
    }

    // [TEMP FOR TESTING] Bypass unlocked visual check
    const isActuallyUnlocked = skill.unlocked;
    const forceEquippable = true; // Set to true for manual testing

    if (!isActuallyUnlocked && !forceEquippable) {
      card.classList.add('locked');
      const cost = unlockCosts[id];
      const lvlReq = levelReqs[id];
      
      let btnLabel = `解鎖 ${cost}`;
      if (id === 'sprint' && progress.level < 2) {
        btnLabel = 'Lv.2 解鎖';
      }
      
      const canUnlock = progress.level >= lvlReq && progress.skillPoints >= cost;
      actionsEl.innerHTML = `<button class="btn-unlock" ${!canUnlock ? 'disabled' : ''} data-action="unlock" data-skill="${id}">${btnLabel}</button>`;
    } else {
      let html = '';
      if (equipped === id) {
        card.classList.add('equipped');
        html += `<button class="btn-equipped-label" disabled>裝備中</button>`;
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
  const cost = getSkillParam(def, 'massCost', skillState.level);
  if (player.mass < cost + 5) return;

  player.mass -= cost;
  showFloatingText(player.body.position.x, player.body.position.y, `-${cost}`, 0xFF4444);

  // Dash in current movement direction
  const vel = player.body.velocity;
  let angle = Math.atan2(vel.y, vel.x);
  if (Math.sqrt(vel.x * vel.x + vel.y * vel.y) < 0.5) {
    // Use mouse direction if not moving
    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    angle = Math.atan2(diff.y, diff.x);
  }

  const force = def.dashForce;
  Matter.Body.setVelocity(player.body, {
    x: Math.cos(angle) * force,
    y: Math.sin(angle) * force
  });
  screenShake = Math.max(screenShake, 8);
  startCooldown(skillState);
}

// --- Overdrive ---
function startOverdrive() {
  skillState.isActive = true;
  skillState.overdrivePhase = 'rampUp';
  skillState.overdriveElapsed = 0;
  skillState.overdriveSpeedMult = 1.01;
  player.isBoosting = true; // Trigger visual deformation
}

function endOverdrive() {
  skillState.overdrivePhase = 'idle';
  skillState.overdriveSpeedMult = 1.0;
  skillState.isActive = false;
  player.isBoosting = false;
  startCooldown(skillState);
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
  
  // Use percentage-based mass cost for Triple Dash
  const actualCost = Math.floor(player.mass * 0.015); // 1.5% mass
  player.mass -= actualCost;
  showFloatingText(player.body.position.x, player.body.position.y, `-${actualCost}`, 0xFF4444);

  // Dash toward current mouse/joystick direction
  const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
  const worldMouse = app.stage.toLocal(screenPos);
  const diff = Matter.Vector.sub(worldMouse, player.body.position);
  const angle = Math.atan2(diff.y, diff.x);

  const force = SKILL_DEFS.tripleDash.dashForce;
  Matter.Body.setVelocity(player.body, {
    x: Math.cos(angle) * force,
    y: Math.sin(angle) * force
  });
  screenShake = Math.max(screenShake, 12); // Increased from 6 for better feel
  skillState.tripleDashRemaining--;
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

  // Create indicator circle and line
  flashStepIndicator = new PIXI.Graphics();
  flashStepLine = new PIXI.Graphics();
  gameContainer.addChild(flashStepLine);
  gameContainer.addChild(flashStepIndicator);
}

async function executeFlashStep() {
  if (!skillState.isChanneling) return;
  skillState.isChanneling = false;
  timeScale = 1.0;
  document.body.classList.remove('skill-channeling');

  const def = SKILL_DEFS.flashStep;
  const cost = getSkillParam(def, 'massCost', skillState.level);
  if (player.mass < cost + 5) {
    cleanupFlashStepVisuals();
    skillState.isActive = false;
    return;
  }

  if (cost > 0) {
    player.mass -= cost;
    showFloatingText(player.body.position.x, player.body.position.y, `-${cost}`, 0xFF4444);
  }

  // Calculate target position
  const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
  const worldMouse = app.stage.toLocal(screenPos);
  const radius = calculateRadius(player.mass);
  const maxDist = radius * def.maxRangeMultiplier;

  const diff = Matter.Vector.sub(worldMouse, player.body.position);
  const dist = Matter.Vector.magnitude(diff);
  const clampedDist = Math.min(dist, maxDist);
  const norm = Matter.Vector.normalise(diff);
  const startX = player.body.position.x;
  const startY = player.body.position.y;
  const targetX = Math.max(100, Math.min(CONFIG.worldSize - 100, startX + norm.x * clampedDist));
  const targetY = Math.max(100, Math.min(CONFIG.worldSize - 100, startY + norm.y * clampedDist));

  // NEW: Fast Dash instead of teleport
  const dashSteps = 2; // Reduced for faster movement
  const startPos = { x: startX, y: startY };
  
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
      player.mass += ent.mass * 0.5;
      killCount++;
      killedSomething = true;
      
      // TRIGGER SHAKE IMMEDIATELY
      screenShake = Math.max(screenShake, 60); 
      
      shatterEntity(ent);
      
      // Blade slash effect (Now just at hit point)
      drawBladeSlash(startPos, { x: targetX, y: targetY });
      
      // Brief Time Freeze on kill
      timeScale = 0;
      setTimeout(() => { if (!skillState.isChanneling) timeScale = 1.0; }, 150);
    }
  });

  // VFX
  // Basic dash shake if nothing killed
  if (!killedSomething) screenShake = Math.max(screenShake, 20); 
  
  cleanupFlashStepVisuals();
  startCooldown(skillState);
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
      const progress = Math.min(1, skillState.overdriveElapsed / def.rampUpDuration);
      skillState.overdriveSpeedMult = 1.0 + progress * (def.maxSpeedMult - 1.0);
      if (progress >= 1) {
        skillState.overdrivePhase = 'sustain';
        skillState.overdriveElapsed = 0;
      }
      player.isBoosting = true;
    } else if (skillState.overdrivePhase === 'sustain') {
      const sustainDur = getSkillParam(def, 'sustainDuration', skillState.level);
      skillState.overdriveSpeedMult = def.maxSpeedMult;
      if (skillState.overdriveElapsed >= sustainDur) {
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
        startCooldown(skillState);
      }
    }
  }

  // Flash Step channeling visuals
  if (skillState.skillId === 'flashStep' && skillState.isChanneling && flashStepIndicator && flashStepLine) {
    const radius = calculateRadius(player.mass);
    const maxDist = radius * SKILL_DEFS.flashStep.maxRangeMultiplier;

    const screenPos = new PIXI.Point(mousePos.x, mousePos.y);
    const worldMouse = app.stage.toLocal(screenPos);
    const diff = Matter.Vector.sub(worldMouse, player.body.position);
    const dist = Matter.Vector.magnitude(diff);
    const clampedDist = Math.min(dist, maxDist);
    const norm = Matter.Vector.normalise(diff);
    const tx = Math.max(100, Math.min(CONFIG.worldSize - 100, player.body.position.x + norm.x * clampedDist));
    const ty = Math.max(100, Math.min(CONFIG.worldSize - 100, player.body.position.y + norm.y * clampedDist));

    // Draw target circle
    flashStepIndicator.clear();
    flashStepIndicator.circle(tx, ty, radius);
    flashStepIndicator.stroke({ width: 3, color: 0xFFFFFF, alpha: 0.7 });

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
      overlay.innerHTML = '<span class="cooldown-text"></span>';
      skillBtn.appendChild(overlay);
    }
    const secs = Math.ceil(skillState.cooldownRemaining / 1000);
    overlay.querySelector('.cooldown-text').textContent = skillState.charges > 0 ? '' : `${secs}s`;
    
    // Clip from bottom upwards
    const pct = cdProgress * 100;
    overlay.style.clipPath = `inset(${100 - pct}% 0 0 0)`;
    
    if (skillState.charges <= 0) {
      skillBtn.classList.add('disabled');
    } else {
      skillBtn.classList.remove('disabled');
    }
  } else {
    if (overlay) { overlay.remove(); }
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
function showRewardScreen(isVictory) {
  const xpReward = calculateXPReward(isVictory, elapsedTime, killCount);
  const goldReward = calculateGoldReward(isVictory, killCount);

  const result = grantXP(progress, xpReward);
  grantGold(progress, goldReward);
  saveProgress(progress);

  // Use correct element IDs based on screen
  const prefix = isVictory ? '' : 'go-';
  document.getElementById(`${prefix}reward-xp`).textContent = `+${xpReward} XP`;
  document.getElementById(`${prefix}reward-gold`).textContent = `+${goldReward}`;
  document.getElementById(`${prefix}reward-kills`).textContent = `×${killCount}`;
  document.getElementById(`${prefix}reward-level-label`).textContent = `Lv.${progress.level}`;

  const pct = getLevelProgress(progress);
  document.getElementById(`${prefix}reward-xp-bar-fill`).style.width = `${Math.round(pct * 100)}%`;

  // Show level up banner
  const banner = document.getElementById(`${prefix}level-up-banner`);
  if (result.levelsGained > 0) {
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

init();

