/**
 * skills.js — 技能定義、冷卻管理、施放邏輯
 *
 * 四個技能取代原有「長按加速」：
 * 1. 衝刺 (Sprint) — 消耗固定質量瞬間衝刺
 * 2. 超級加速 (Overdrive) — 無質量消耗，漸增加速
 * 3. 三段式衝刺 (Triple Dash) — 連續三次方向衝刺
 * 4. 閃現 (Flash Step) — 長按瞄準 + 瞬移 + 路徑擊殺
 */

/**
 * 技能定義表
 * 每個技能包含基礎參數與各強化等級的數值
 */
export const SKILL_DEFS = {
  sprint: {
    id: 'sprint',
    name: '衝刺',
    icon: '↗',
    description: '消耗固定質量，朝當前方向瞬間衝刺',
    type: 'instant', // instant | toggle | channel
    // 各等級參數 [level 1, level 2, level 3]
    massCost: [0, 0, 0],
    cooldown: [2000, 2000, 2000],   // 增加至 2s
    minMass: 0,
    // 衝刺力度倍率（削弱）
    dashForce: 80,
    maxCharges: 2,
  },

  overdrive: {
    id: 'overdrive',
    name: '超級加速',
    icon: '⚡',
    description: '不消耗質量，加速效果從 1% 漸增至 150%',
    type: 'toggle',
    massCost: [0, 0, 0],
    rampUpDuration: 2000,           // 增加至 2s，使加速過程更平滑
    sustainDuration: [1500, 1500, 1500], // 縮短至 1.5s，平衡高極速表現
    maxSpeedMult: 3.8,
    energyRequired: [100, 90, 80], // 調回 100 基準
  },

  tripleDash: {
    id: 'tripleDash',
    name: '三段衝刺',
    icon: '≡',
    description: '以 700ms 間隔朝指向連續衝刺三次',
    type: 'instant',
    massCostPerDash: [0, 0, 0],     // 質量消耗依目前質量而定 (main.js 處理)
    cooldown: [3000, 2500, 2200],   // ms (CD 減半)
    minMass: 10,
    dashCount: 3,
    dashInterval: 600,              // 縮短至 600ms
    dashForce: 90,
  },

  flashStep: {
    id: 'flashStep',
    name: '閃現',
    icon: '◎',
    description: '長按瞄準，放開瞬移至目標點並擊殺路徑上敵人',
    type: 'channel',                // 長按施放
    massCost: [0, 0, 0],            // 不消耗能量
    cooldown: [2000, 2000, 2000],   // 減至 2s
    maxCharges: 2,                  // 可充能 2 次
    minMass: 0,
    maxRangeMultiplier: 10,
    teleportDuration: 150,
    slowMotionScale: 0.05,          // 時緩大幅增強 (5%)
    postInvincibility: 500,
  },
};

/**
 * 技能運行時狀態
 * 在每場遊戲開始時透過 createSkillState() 初始化
 */

/**
 * 建立一場遊戲的技能運行時狀態
 * @param {string|null} equippedSkillId - 裝備的技能 ID，null 表示預設加速
 * @param {number} skillLevel - 技能等級 (1~3)
 * @returns {object} 技能運行時狀態
 */
export function createSkillState(equippedSkillId, skillLevel) {
  return {
    skillId: equippedSkillId,
    level: skillLevel,
    // 冷卻計時（0 表示可用）
    cooldownRemaining: 0,
    // 技能是否正在生效
    isActive: false,
    // 超級加速專用：當前加速倍率
    overdriveSpeedMult: 1.0,
    overdrivePhase: 'idle', // 'idle' | 'rampUp' | 'sustain'
    overdriveElapsed: 0,
    // 三段衝刺專用：剩餘衝刺次數
    tripleDashRemaining: 0,
    tripleDashTimer: 0,
    // 閃現專用：是否在瞄準模式
    isChanneling: false,
    flashTarget: null, // { x, y }
    // 通用：是否為預設加速模式
    isDefaultBoost: equippedSkillId === null,
    // 充能機制
    charges: (equippedSkillId && SKILL_DEFS[equippedSkillId].maxCharges) || 1,
    maxCharges: (equippedSkillId && SKILL_DEFS[equippedSkillId].maxCharges) || 1,
  };
}

/**
 * 取得技能定義
 * @param {string} skillId - 技能 ID
 * @returns {object|null} 技能定義
 */
export function getSkillDef(skillId) {
  return SKILL_DEFS[skillId] || null;
}

/**
 * 取得技能在指定等級的特定參數值
 * @param {object} def - 技能定義
 * @param {string} param - 參數名稱
 * @param {number} level - 技能等級 (1~3)
 * @returns {*} 參數值
 */
export function getSkillParam(def, param, level) {
  const value = def[param];
  if (Array.isArray(value)) {
    return value[Math.min(level - 1, value.length - 1)];
  }
  return value;
}

/**
 * 檢查技能是否可以施放
 * @param {object} skillState - 運行時狀態
 * @param {object} player - 玩家實體
 * @returns {{ canUse: boolean, reason: string }}
 */
export function canUseSkill(skillState, player) {
  if (skillState.isDefaultBoost) {
    return { canUse: true, reason: '' };
  }
  if (!skillState.skillId) {
    return { canUse: false, reason: '未裝備技能' };
  }

  const def = SKILL_DEFS[skillState.skillId];
  if (!def) return { canUse: false, reason: '技能不存在' };

  if (skillState.charges <= 0) {
    return { canUse: false, reason: '冷卻中' };
  }
  if (skillState.isActive) {
    // 超級加速和閃現可以在 active 時再次按下
    if (def.type === 'toggle' || def.type === 'channel') {
      return { canUse: true, reason: '' };
    }
    return { canUse: false, reason: '使用中' };
  }

  const massCost = getSkillParam(def, def.id === 'tripleDash' ? 'massCostPerDash' : 'massCost', skillState.level);
  const totalCost = def.id === 'tripleDash' ? massCost * def.dashCount : massCost;

  if (player.mass < def.minMass || player.mass < totalCost + 5) {
    return { canUse: false, reason: '質量不足' };
  }

  return { canUse: true, reason: '' };
}

/**
 * 更新技能冷卻時間（每幀呼叫）
 * @param {object} skillState - 運行時狀態
 * @param {number} deltaMs - 經過的毫秒數
 */
export function updateSkillCooldown(skillState, deltaMs) {
  // 超級加速使用能量制，不由時間冷卻
  if (skillState.skillId === 'overdrive') return;

  if (skillState.charges < skillState.maxCharges) {
    if (skillState.cooldownRemaining > 0) {
      skillState.cooldownRemaining = Math.max(0, skillState.cooldownRemaining - deltaMs);
    }
    if (skillState.cooldownRemaining <= 0) {
      skillState.charges++;
      if (skillState.charges < skillState.maxCharges) {
        const def = SKILL_DEFS[skillState.skillId];
        if (def) {
          const baseCD = getSkillParam(def, 'cooldown', skillState.level);
          // 使用傳入的倍率（若有），否則預設 1.0
          const multiplier = skillState.currentCDMultiplier || 1.0;
          skillState.cooldownRemaining = baseCD * multiplier;
        }
      }
    }
  }
}

/**
 * 啟動技能冷卻
 * @param {object} skillState - 運行時狀態
 * @param {number} multiplier - 冷卻時間倍率 (預設 1.0)
 */
export function startCooldown(skillState, multiplier = 1.0) {
  const def = SKILL_DEFS[skillState.skillId];
  if (!def) return;
  
  // 紀錄當前倍率供後續充能使用
  skillState.currentCDMultiplier = multiplier;

  // 如果原本是滿的，開始計時第一個充能的恢復
  if (skillState.charges === skillState.maxCharges) {
    if (def.energyRequired) {
      // 能量制技能：設定初始所需能量
      skillState.cooldownRemaining = getSkillParam(def, 'energyRequired', skillState.level);
    } else {
      const baseCD = getSkillParam(def, 'cooldown', skillState.level);
      skillState.cooldownRemaining = baseCD * multiplier;
    }
  }
  
  skillState.charges = Math.max(0, skillState.charges - 1);
  skillState.isActive = false;
}

/**
 * 為能量制技能補充能量
 * @param {object} skillState - 運行時狀態
 * @param {number} amount - 補充量
 */
export function addSkillEnergy(skillState, amount) {
  if (skillState.skillId !== 'overdrive' || skillState.charges >= skillState.maxCharges) return;
  
  // 這裡的 cooldownRemaining 代表「剩餘所需能量」
  if (skillState.cooldownRemaining > 0) {
    skillState.cooldownRemaining = Math.max(0, skillState.cooldownRemaining - amount);
    if (skillState.cooldownRemaining <= 0) {
      skillState.charges = skillState.maxCharges;
    }
  }
}

/**
 * 取得冷卻進度（0 = 就緒，1 = 剛進入冷卻）
 * @param {object} skillState - 運行時狀態
 * @returns {number} 0~1
 */
export function getCooldownProgress(skillState) {
  if (skillState.cooldownRemaining <= 0) return 0;
  const def = SKILL_DEFS[skillState.skillId];
  if (!def) return 0;
  const total = def.energyRequired ? getSkillParam(def, 'energyRequired', skillState.level) : getSkillParam(def, 'cooldown', skillState.level);
  return skillState.cooldownRemaining / total;
}
