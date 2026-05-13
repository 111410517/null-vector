export const CONFIG = {
  playerColor: 0xFFFFFF,
  npcColor: 0x444444,
  nodeColor: 0xFFFFFF,
  bgColor: 0x121212,
  initialMass: 30,
  nodeMass: 2.0, // Increased from 1.0
  worldSize: 5000, 
  npcCount: 10,
  nodeCount: 350, // Increased from 180
  friction: 0.12, 
  zoomFactor: 0.0015,
  specialNodeMass: 10.0, // Increased from 5.0
  virusCount: 4,
  virusMinMass: 500,
  virusMassLoss: 80,
  baseForce: 0.18,
  visionRange: 1000,
  rareItemMass: 500, // Mass provided by the rare object
  rareItemColor: 0xFFD700, // Golden color
};

export function calculateRadius(mass) {
  return Math.pow(mass, 0.45) * 12;
}
