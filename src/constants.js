export const CONFIG = {
  playerColor: 0xFFFFFF,
  npcColor: 0x444444,
  nodeColor: 0xFFFFFF,
  bgColor: 0x121212,
  initialMass: 30,
  nodeMass: 2.0, 
  worldSize: 5000, 
  npcCount: 10,
  nodeCount: 350, 
  friction: 0.12, 
  zoomFactor: 0.0015,
  specialNodeMass: 10.0, 
  virusCount: 4,
  virusMinMass: 500,
  virusMassLoss: 80,
  baseForce: 0.18,
  visionRange: 1000,
  
  rareItemProb: 0.7, 
  rareItemTiers: {
    white: { prob: 0.5, mass: 500, speed: 0.2, color: 0xFFFFFF, label: 'WHITE' },
    gold: { prob: 0.3, mass: 1000, speed: 0.4, color: 0xFFD700, label: 'GOLD' },
    iridescent: { prob: 0.2, mass: 2000, speed: 0.8, color: 0xFF00FF, label: 'IRIDESCENT' }
  }
};

export function calculateRadius(mass) {
  return Math.pow(mass, 0.45) * 12;
}
