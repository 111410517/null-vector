import * as Matter from 'matter-js';
import { CONFIG } from './constants.js';

/**
 * Scripted AI for Main Menu Demo Background
 */
export function updateDemoAI(npc, delta, gameState) {
  const { entities, viruses, nodes, isGameOver } = gameState;
  if (npc.isDestroyed || isGameOver) return;

  let intention = null;
  const npcPos = npc.body.position;

  // 1. SCRIPTED HUNTER (NPC 1)
  if (npc.isDemoScripted && npc.mass >= CONFIG.virusMinMass) {
    let nearestVirus = null;
    let minDist = Infinity;
    viruses.forEach(v => {
      const d = Matter.Vector.magnitude(Matter.Vector.sub(v.body.position, npcPos));
      if (d < minDist) { minDist = d; nearestVirus = v; }
    });
    if (nearestVirus) {
      const dir = Matter.Vector.normalise(Matter.Vector.sub(nearestVirus.body.position, npcPos));
      intention = { dir, power: 1.0, isBoosting: true };
    }
  }

  // 2. OPPORTUNIST BOT (NPC 2)
  if (!intention && npc.isOpportunist) {
    // A. Prioritize special nodes (virus fragments)
    let bestSpecialNode = null;
    let maxSpecialScore = -1;
    nodes.forEach(node => {
      if (!node.isSpecial) return;
      const d = Matter.Vector.magnitude(Matter.Vector.sub(node.body.position, npcPos));
      if (d < 1500) {
        const score = 100 / (d + 10);
        if (score > maxSpecialScore) { maxSpecialScore = score; bestSpecialNode = node; }
      }
    });
    if (bestSpecialNode) {
      const dir = Matter.Vector.normalise(Matter.Vector.sub(bestSpecialNode.body.position, npcPos));
      intention = { dir, power: 1.0, isBoosting: false };
    }

    // B. Target the scripted NPC (NPC 1) - Aggressive stalking
    if (!intention) {
      const targetNPC = entities.find(e => e.isDemoScripted);
      if (targetNPC && !targetNPC.isDestroyed) {
        const d = Matter.Vector.magnitude(Matter.Vector.sub(targetNPC.body.position, npcPos));
        if (d < 3000) {
          const dir = Matter.Vector.normalise(Matter.Vector.sub(targetNPC.body.position, npcPos));
          intention = { dir, power: 1.0, isBoosting: false };
        }
      }
    }
  }

  // 3. FALLBACK TO NORMAL WANDER/FORAGE (for NPC 3, 4 and others)
  if (!intention) {
    // Simple demo foraging logic
    let bestNode = null;
    let maxScore = -1;
    nodes.forEach(node => {
      const d = Matter.Vector.magnitude(Matter.Vector.sub(node.body.position, npcPos));
      if (d < 1000) {
        const score = (node.isSpecial ? 10 : 1) / (d + 1);
        if (score > maxScore) { maxScore = score; bestNode = node; }
      }
    });

    if (bestNode) {
      const dir = Matter.Vector.normalise(Matter.Vector.sub(bestNode.body.position, npcPos));
      intention = { dir, power: 1.0, isBoosting: npc.isAlwaysBoosting };
    } else {
      const wanderTime = Date.now() * 0.0005; 
      const dir = { x: Math.cos(wanderTime + (npc.wobbleOffset || 0)), y: Math.sin(wanderTime + (npc.wobbleOffset || 0)) };
      intention = { dir, power: 1.0, isBoosting: npc.isAlwaysBoosting };
    }
  }

  // ANGULAR STEERING (Reuse from main AI but isolated)
  if (npc.currentAngle === undefined) npc.currentAngle = Math.atan2(intention.dir.y, intention.dir.x);
  const targetAngle = Math.atan2(intention.dir.y, intention.dir.x);
  let angleDiff = targetAngle - npc.currentAngle;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
  const maxTurnSpeed = 0.2 * delta.deltaTime;
  npc.currentAngle += Math.max(-maxTurnSpeed, Math.min(maxTurnSpeed, angleDiff));

  const moveVec = { x: Math.cos(npc.currentAngle), y: Math.sin(npc.currentAngle) };
  
  // Visual & Physics State
  npc.isBoosting = npc.noBoost ? false : (npc.isAlwaysBoosting ? true : intention.isBoosting);
  
  // DEMO RESTRICTION: Keep Speedster small to maintain max speed
  if (npc.isAlwaysBoosting) {
    npc.mass = 25;
  }

  // Apply Force - Boosted base speed for demo effect
  const baseForce = CONFIG.baseForce * Math.pow(npc.mass / 30, 0.8) * 1.2; 
  const boostMult = npc.isBoosting ? 1.5 : 1.0; 
  Matter.Body.applyForce(npc.body, npc.body.position, Matter.Vector.mult(moveVec, baseForce * intention.power * boostMult));
}
