import './style.css';
import './pwa.js';
import * as Matter from 'matter-js';
import * as PIXI from 'pixi.js';
import { CONFIG, calculateRadius } from './constants.js';
import { updateAI } from './ai.js';

// --- Game State ---
let app, engine, world;
let nodeLayer, entityLayer, virusLayer, powerupLayer;
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

  // Create Layers
  nodeLayer = new PIXI.Container();
  entityLayer = new PIXI.Container();
  virusLayer = new PIXI.Container();
  powerupLayer = new PIXI.Container();
  app.stage.addChild(nodeLayer, powerupLayer, entityLayer, virusLayer);

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

  // 3. Re-spawn initial game objects
  for (let i = 0; i < CONFIG.nodeCount; i++) spawnNode();
  for (let i = 0; i < CONFIG.virusCount; i++) spawnVirus();

  // 4. Start Player
  const nameInput = document.getElementById('player-name-input').value || "PLAYER";
  player = createEntity(CONFIG.worldSize / 2, CONFIG.worldSize / 2, CONFIG.initialMass, nameInput, true);
  updateLivesUI();
  
  isGameRunning = true;
  startTime = Date.now();
  document.getElementById('start-menu').style.display = 'none';
  document.querySelector('.ui-overlay').style.display = 'block';

  // START RARE ITEM (Delayed by 30s)
  setTimeout(spawnRareItem, 30000); 

  // 5. Start Spawning NPCs over time (Restoring your original design)
  let spawned = 0;
  const spawnInterval = setInterval(() => {
    if (spawned >= CONFIG.npcCount || !isGameRunning) {
      clearInterval(spawnInterval);
      return;
    }
    // Batch the first 4 NPCs, then 1 by 1
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
  
  app.stage.addChild(t);
  
  let life = 1.0;
  const fUpdate = (d) => {
    t.y -= 1.5 * d.deltaTime;
    life -= 0.02 * d.deltaTime;
    t.alpha = life;
    if (life <= 0) {
      app.stage.removeChild(t);
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
  // Cap delta to prevent Matter.js warnings and physics jitter
  Matter.Engine.update(engine, Math.min(16.6, delta.elapsedMS));

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
    const targetBoost = ent.isBoosting ? 1.0 : 0.0;
    ent.boostFactor += (targetBoost - ent.boostFactor) * 0.08;
    
    if (ent.isBoosting && ent.mass > 20) {
      ent.mass -= 0.01 * delta.deltaTime;
    }

    const baseForce = CONFIG.baseForce * Math.pow(ent.mass / 30, 0.8);

    // TAIL ANGLE LERP (Inertia)
    const currentVelAngle = Math.atan2(ent.body.velocity.y, ent.body.velocity.x);
    let angleDiff = currentVelAngle - ent.tailAngle;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    ent.tailAngle += angleDiff * 0.12; // Adjust for sway speed

    if (ent.isBoosting && ent.mass > CONFIG.initialMass * 0.8) {
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
          // Condition: Mass ratio >= 1.25 and small ball center is well within large ball
          // More forgiving threshold: dist < radius * 0.9
          if (ent.mass > other.mass * 1.25 && dist < radius * 0.9) {
            ent.mass += other.mass * 0.5;
            if (ent.isPlayer || other.isPlayer) screenShake = 20;
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
    // UI Feedback for Boosting
    const skillBtn = document.getElementById('skill-btn');
    if (player.isBoosting) {
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
    const boostMult = player.isBoosting ? 2.0 : 1.0; 
    const finalMult = boostMult * (player.speedMult || 1.0);
    // REDUCED GAP: Acceleration proportional to 1/mass^0.2 (was 0.4)
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
        screenShake = 50;
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
  
  // Continuous Boost Setup
  const startBoost = () => { if (isGameOver || !player) return; player.isBoosting = true; };
  const endBoost = () => { if (player) player.isBoosting = false; };

  window.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('#leaderboard')) return;
    if (e.button === 0) startBoost();
  });
  window.addEventListener('mouseup', endBoost);

  skillBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startBoost(); });
  window.addEventListener('touchend', endBoost);

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
    <div class="leaderboard-item ${ent.isPlayer ? 'me' : ''}">
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
    miniCtx.fillStyle = ent.isPlayer ? '#FFFFFF' : 'rgba(255, 255, 255, 0.4)';
    miniCtx.beginPath();
    miniCtx.arc(ent.body.position.x * scale, ent.body.position.y * scale, Math.max(2, r), 0, Math.PI * 2);
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
  list.innerHTML = history.map(h => `
    <div class="history-item">
      <span>${h.date}</span>
      <span class="time">${h.time}</span>
    </div>
  `).join('');
}

window.restartGame = () => location.reload();

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

init();

