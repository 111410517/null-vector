import * as Matter from 'matter-js';
import { CONFIG, calculateRadius } from './constants.js';

/**
 * NPC AI Decision Logic - Overhauled for "God-like" efficiency
 */
export function updateAI(npc, delta, gameState) {
  const { isGameOver } = gameState;
  if (npc.isDestroyed || isGameOver) return;

  const intention = calculateIntention(npc, gameState);
  
  // ANGULAR STEERING: Replace vector LERP with smooth rotation
  if (npc.currentAngle === undefined) {
    npc.currentAngle = Math.atan2(intention.dir.y, intention.dir.x);
  }

  const targetAngle = Math.atan2(intention.dir.y, intention.dir.x);
  let angleDiff = targetAngle - npc.currentAngle;
  
  // Normalize angle difference to [-PI, PI]
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

  // Turning Speed: Max turning speed per frame
  const maxTurnSpeed = (npc.isSmart ? 0.25 : 0.15) * delta.deltaTime;
  const actualTurn = Math.max(-maxTurnSpeed, Math.min(maxTurnSpeed, angleDiff));
  npc.currentAngle += actualTurn;

  const moveVec = {
    x: Math.cos(npc.currentAngle),
    y: Math.sin(npc.currentAngle)
  };
  
  npc.isBoosting = intention.isBoosting;
  applyNPCForce(npc, moveVec, intention.power);
}

function calculateIntention(npc, { entities, viruses, nodes, powerups }) {
  const npcPos = npc.body.position;
  const visionRange = CONFIG.visionRange;
  const fleeRange = 600;

  let fleeForce = { x: 0, y: 0 };
  let huntForce = { x: 0, y: 0 };
  let forageForce = { x: 0, y: 0 };
  let shatterForce = { x: 0, y: 0 };
  let wallAvoidance = { x: 0, y: 0 };
  
  let nearestThreatDist = Infinity;
  let isBoosting = false;

  // 0. WALL AVOIDANCE (Built into intention)
  const margin = 250;
  if (npcPos.x < margin) wallAvoidance.x += Math.pow((margin - npcPos.x) / margin, 1.5);
  if (npcPos.x > CONFIG.worldSize - margin) wallAvoidance.x -= Math.pow((npcPos.x - (CONFIG.worldSize - margin)) / margin, 1.5);
  if (npcPos.y < margin) wallAvoidance.y += Math.pow((margin - npcPos.y) / margin, 1.5);
  if (npcPos.y > CONFIG.worldSize - margin) wallAvoidance.y -= Math.pow((npcPos.y - (CONFIG.worldSize - margin)) / margin, 1.5);

  // 1. POWERUPS (Avoid Legendary)
  powerups.forEach(p => {
    const diff = Matter.Vector.sub(npc.body.position, p.body.position);
    const dist = Matter.Vector.magnitude(diff);
    if (dist < 500) {
      const weight = (500 - dist) / 500;
      fleeForce = Matter.Vector.add(fleeForce, Matter.Vector.mult(Matter.Vector.normalise(diff), weight * 10));
    }
  });

  // 2. SCAN ENTITIES
  entities.forEach(other => {
    if (other === npc || other.isDestroyed || other.protectionTime > 0) return;
    const diff = Matter.Vector.sub(npc.body.position, other.body.position);
    const dist = Matter.Vector.magnitude(diff);
    
    if (dist < visionRange) {
      if (dist < fleeRange && other.mass > npc.mass * 1.25) {
        const weight = Math.pow((fleeRange - dist) / fleeRange, 2);
        const norm = Matter.Vector.normalise(diff);
        const tangent = { x: -norm.y, y: norm.x }; // Add some tangential steering to avoid head-on
        const steering = Matter.Vector.add(norm, Matter.Vector.mult(tangent, 0.4));
        fleeForce = Matter.Vector.add(fleeForce, Matter.Vector.mult(steering, weight * 12));
        if (dist < nearestThreatDist) nearestThreatDist = dist;
      } 
      else if (npc.mass > other.mass * 1.25) {
        const weight = (visionRange - dist) / visionRange;
        const leadTime = dist / 15;
        const aimPos = Matter.Vector.add(other.body.position, Matter.Vector.mult(other.body.velocity, leadTime));
        const chaseNorm = Matter.Vector.normalise(Matter.Vector.sub(aimPos, npcPos));
        huntForce = Matter.Vector.add(huntForce, Matter.Vector.mult(chaseNorm, weight * 5));
      }
    }
  });

  // 3. SCAN VIRUSES
  viruses.forEach(v => {
    const diff = Matter.Vector.sub(npc.body.position, v.body.position);
    const dist = Matter.Vector.magnitude(diff);
    if (dist < 600) {
      const norm = Matter.Vector.normalise(diff);
      if (npc.mass >= CONFIG.virusMinMass) {
        if (nearestThreatDist > 1200) {
          shatterForce = Matter.Vector.add(shatterForce, Matter.Vector.mult(Matter.Vector.neg(norm), 3));
        } else {
          fleeForce = Matter.Vector.add(fleeForce, Matter.Vector.mult(norm, 6));
        }
      } else if (nearestThreatDist < 600) {
        forageForce = Matter.Vector.add(forageForce, Matter.Vector.mult(Matter.Vector.neg(norm), 4));
      }
    }
  });

  // 4. SCAN NODES
  if (!npc.targetNodeId || !nodes.find(n => n.body.id === npc.targetNodeId)) {
    npc.targetNodeId = null;
    let bestNode = null;
    let maxScore = -1;
    nodes.forEach(node => {
      const diff = Matter.Vector.sub(node.body.position, npcPos);
      const dist = Matter.Vector.magnitude(diff);
      if (dist < 1000) {
        const value = node.isSpecial ? 15 : 2;
        const score = value / (dist + 50);
        if (score > maxScore) { maxScore = score; bestNode = node; }
      }
    });
    if (bestNode) {
      npc.targetNodeId = bestNode.body.id;
      npc.targetNodeExpireTime = Date.now() + 1500; // Increased stickiness
    }
  } else if (Date.now() > (npc.targetNodeExpireTime || 0)) {
    npc.targetNodeId = null;
  }

  const currentTarget = nodes.find(n => n.body.id === npc.targetNodeId);
  if (currentTarget) {
    const nodeDir = Matter.Vector.normalise(Matter.Vector.sub(currentTarget.body.position, npcPos));
    forageForce = Matter.Vector.add(forageForce, Matter.Vector.mult(nodeDir, 3.5));
  }

  // 5. COMBINE FORCES (Priority Weighted)
  let combined = Matter.Vector.add(wallAvoidance, Matter.Vector.mult(fleeForce, 1.5));
  
  const fleeMag = Matter.Vector.magnitude(fleeForce);
  if (fleeMag < 0.1) {
    combined = Matter.Vector.add(combined, huntForce);
    combined = Matter.Vector.add(combined, Matter.Vector.mult(forageForce, 0.8));
    combined = Matter.Vector.add(combined, shatterForce);
  } else {
    // If fleeing, dramatically reduce interest in forage
    combined = Matter.Vector.add(combined, Matter.Vector.mult(forageForce, 0.1));
  }

  let finalDir = combined;
  if (Matter.Vector.magnitude(combined) < 0.01) {
    const wanderTime = Date.now() * 0.0005; 
    finalDir = { x: Math.cos(wanderTime + npc.wobbleOffset), y: Math.sin(wanderTime + npc.wobbleOffset) };
  }

  return { 
    dir: Matter.Vector.normalise(finalDir), 
    power: 1.0, 
    isBoosting: (nearestThreatDist < 450 || (huntForce.x !== 0 && npc.mass > 100))
  };
}

function applyNPCForce(npc, moveVec, multiplier) {
  const speedBonus = npc.isSmart ? 0.95 : 0.85;
  const baseForce = CONFIG.baseForce * Math.pow(npc.mass / 30, 0.8) * speedBonus; 
  const boostMult = npc.isBoosting ? 1.5 : 1.0; 
  Matter.Body.applyForce(npc.body, npc.body.position, Matter.Vector.mult(moveVec, baseForce * multiplier * boostMult));
}
