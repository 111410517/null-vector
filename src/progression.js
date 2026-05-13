/**
 * progression.js — 等級、經驗值、金幣、技能點管理
 * 
 * 所有跨局進度資料使用 localStorage 持久化。
 * 等級範圍 Lv.1 ~ Lv.10，約 15~25 場可滿級。
 */

const STORAGE_KEY = 'null-vector-progress';

/**
 * 各等級累計經驗需求表
 * index = 目標等級 - 2（Lv.2 需要 100, Lv.3 需要 300, ...）
 */
const LEVEL_XP_TABLE = [
  100,   // Lv.1 → Lv.2
  250,   // Lv.2 → Lv.3
  500,   // Lv.3 → Lv.4
  850,   // Lv.4 → Lv.5
  1300,  // Lv.5 → Lv.6
];

const MAX_LEVEL = 6;

/**
 * 建立預設進度資料結構
 * @returns {object} 預設的進度物件
 */
function createDefaultProgress() {
  return {
    level: 1,
    xp: 0,
    gold: 0,
    skillPoints: 0,
    skills: {
      sprint: { unlocked: false, level: 0 },
      overdrive: { unlocked: false, level: 0 },
      tripleDash: { unlocked: false, level: 0 },
      flashStep: { unlocked: false, level: 0 },
    },
    equippedSkill: null, // null = 預設加速
    skins: {
      owned: ['default'],
      equipped: 'default',
    },
  };
}

/**
 * 從 localStorage 載入進度，如不存在則建立預設值
 * @returns {object} 進度物件
 */
export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      // 向前相容：合併預設值以確保新欄位存在
      const defaults = createDefaultProgress();
      return {
        ...defaults,
        ...data,
        skills: { ...defaults.skills, ...data.skills },
        skins: { ...defaults.skins, ...data.skins },
      };
    }
  } catch (e) {
    console.warn('[Progression] 載入進度失敗，使用預設值', e);
  }
  return createDefaultProgress();
}

/**
 * 儲存進度到 localStorage
 * @param {object} progress - 進度物件
 */
export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    console.warn('[Progression] 儲存進度失敗', e);
  }
}

/**
 * 取得當前等級升級所需的累計經驗值
 * @param {number} level - 當前等級
 * @returns {number} 升至下一級所需的累計 XP，已滿級回傳 Infinity
 */
export function getXPForNextLevel(level) {
  if (level >= MAX_LEVEL) return Infinity;
  return LEVEL_XP_TABLE[level - 1];
}

/**
 * 取得當前等級的起始累計經驗值
 * @param {number} level - 當前等級
 * @returns {number} 該等級起始所需的累計 XP
 */
export function getXPForCurrentLevel(level) {
  if (level <= 1) return 0;
  return LEVEL_XP_TABLE[level - 2];
}

/**
 * 計算等級內的經驗進度百分比（0~1）
 * @param {object} progress - 進度物件
 * @returns {number} 0~1 之間的進度值
 */
export function getLevelProgress(progress) {
  if (progress.level >= MAX_LEVEL) return 1;
  const currentStart = getXPForCurrentLevel(progress.level);
  const nextRequired = getXPForNextLevel(progress.level);
  const levelXP = nextRequired - currentStart;
  const earned = progress.xp - currentStart;
  return Math.max(0, Math.min(1, earned / levelXP));
}

/**
 * 發放經驗值並處理升級
 * @param {object} progress - 進度物件（會被直接修改）
 * @param {number} xpGain - 獲得的經驗值
 * @returns {{ levelsGained: number, skillPointsGained: number }} 升級資訊
 */
export function grantXP(progress, xpGain) {
  const result = { levelsGained: 0, skillPointsGained: 0 };
  progress.xp += xpGain;

  // 連續升級檢查
  while (progress.level < MAX_LEVEL) {
    const required = getXPForNextLevel(progress.level);
    if (progress.xp >= required) {
      progress.level++;
      progress.skillPoints++;
      result.levelsGained++;
      result.skillPointsGained++;
    } else {
      break;
    }
  }

  return result;
}

/**
 * 發放金幣
 * @param {object} progress - 進度物件（會被直接修改）
 * @param {number} amount - 獲得的金幣數量
 */
export function grantGold(progress, amount) {
  progress.gold += amount;
}

/**
 * 計算一場遊戲的經驗值獎勵
 * @param {boolean} isVictory - 是否勝利
 * @param {number} survivalTimeMs - 存活時間（毫秒）
 * @param {number} killCount - 淘汰 NPC 數量
 * @returns {number} 經驗值
 */
export function calculateXPReward(isVictory, survivalTimeMs, killCount) {
  let xp = 0;
  if (isVictory) {
    xp += 100; // 基礎勝利獎勵
    // 存活時間 bonus（每分鐘 +10，最多 +50）
    const minutes = survivalTimeMs / 60000;
    xp += Math.min(50, Math.floor(minutes) * 10);
  } else {
    // 敗場：基於存活時間
    const minutes = survivalTimeMs / 60000;
    xp += 20 + Math.min(20, Math.floor(minutes) * 10);
  }
  // 淘汰獎勵
  xp += killCount * 5;
  return xp;
}

/**
 * 計算一場遊戲的金幣獎勵
 * @param {boolean} isVictory - 是否勝利
 * @param {number} killCount - 淘汰 NPC 數量
 * @returns {number} 金幣
 */
export function calculateGoldReward(isVictory, killCount) {
  let gold = isVictory ? 50 : 15;
  gold += killCount * 5;
  return gold;
}

/**
 * 解鎖技能 (新機制：不同技能點需求，衝刺等級 2 自動解鎖)
 * @param {object} progress - 進度物件
 * @param {string} skillId - 技能 ID
 * @returns {boolean} 是否成功解鎖
 */
export function unlockSkill(progress, skillId) {
  const skill = progress.skills[skillId];
  if (!skill || skill.unlocked) return false;

  const costMap = {
    sprint: 0,
    tripleDash: 1,
    overdrive: 2,
    flashStep: 3
  };

  const levelReqMap = {
    sprint: 2,
    tripleDash: 1,
    overdrive: 1,
    flashStep: 1
  };

  const cost = costMap[skillId] || 0;
  const levelReq = levelReqMap[skillId] || 1;

  if (progress.level < levelReq || progress.skillPoints < cost) return false;

  skill.unlocked = true;
  skill.level = 3; // 預設滿級 (因為取消強化系統)
  progress.skillPoints -= cost;
  return true;
}

/**
 * 強化技能 (已取消)
 */
export function upgradeSkill(progress, skillId) {
  return false; // 不再支援強化
}

/**
 * 裝備技能
 * @param {object} progress - 進度物件
 * @param {string|null} skillId - 技能 ID，null 表示使用預設加速
 * @returns {boolean} 是否成功裝備
 */
export function equipSkill(progress, skillId) {
  if (skillId === null) {
    progress.equippedSkill = null;
    return true;
  }
  const skill = progress.skills[skillId];
  if (!skill) return false;

  // [TEMP FOR TESTING] Bypassing unlocked check
  progress.equippedSkill = skillId;
  if (skill.level === 0) skill.level = 3; // Use max level for testing
  return true;
}

export { MAX_LEVEL };
