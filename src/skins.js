/**
 * skins.js — 皮膚定義與管理
 *
 * 共 11 套皮膚（含預設），每套包含：
 * - 外觀參數（填色、描邊、紋理類型）
 * - 常駐環境特效設定
 * - 技能 VFX 配色覆蓋
 * - 微小 Buff 定義（最大 3%）
 *
 * 稀有度分級：common / fine / rare / epic / legendary
 */

/**
 * 稀有度定義（用於 UI 邊框色和標籤）
 */
export const RARITY_DEFS = {
  common:    { label: '普通', color: '#888888', borderColor: 'rgba(136,136,136,0.4)' },
  fine:      { label: '精良', color: '#00FFBB', borderColor: 'rgba(0,255,187,0.4)' },
  rare:      { label: '稀有', color: '#4488FF', borderColor: 'rgba(68,136,255,0.4)' },
  epic:      { label: '史詩', color: '#FFD700', borderColor: 'rgba(255,215,0,0.4)' },
  legendary: { label: '傳說', color: '#FF00FF', borderColor: 'rgba(255,0,255,0.4)' },
};

/**
 * 皮膚定義表
 */
export const SKIN_DEFS = {
  // ── 0. 預設 ──────────────────────────────
  default: {
    id: 'default',
    name: '幽靈白',
    price: 0,
    rarity: 'common',
    description: '預設白色球體',
    /** 玩家球體填充色 */
    playerColor: 0xFFFFFF,
    /** 質量標籤顏色 */
    massLabelColor: 0x000000,
    /** 描邊色（null = 無描邊）*/
    outlineColor: null,
    outlineWidth: 0,
    /** 填色模式：solid | noise | wireframe | circuit | halftone | metallic | voidcore | iridescent */
    fillMode: 'solid',
    /** 常駐 VFX 類型 */
    ambientVFX: null,
    /** 技能粒子色（fallback 白色） */
    vfxColor: 0xFFFFFF,
    /** 技能 VFX 覆蓋（null = 使用預設） */
    skillVFX: null,
    /** Buff 定義 */
    buff: null,
  },

  // ── 1. 🤓☝️ ──────────────────────────────
  nerd: {
    id: 'nerd',
    name: '🤓☝️',
    price: 200,
    rarity: 'common',
    description: '戴著黑框眼鏡的書呆子球體',
    playerColor: 0xFFFFFF,
    massLabelColor: 0x000000,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'solid',
    /** 額外裝飾：眼鏡 */
    overlay: 'glasses',
    ambientVFX: null,
    vfxColor: 0xFFFFFF,
    skillVFX: null,
    buff: { type: 'pickupRange', value: 0.01 },
  },

  // ── 2. 靜電噪點 ──────────────────────────
  static: {
    id: 'static',
    name: '靜電噪點',
    price: 250,
    rarity: 'common',
    description: '老電視雪花效果，邊緣微弱閃爍',
    playerColor: 0xCCCCCC,
    massLabelColor: 0x000000,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'noise',
    ambientVFX: 'staticSparks',
    vfxColor: 0xAAAAAA,
    skillVFX: { particleShape: 'square' },
    buff: { type: 'speed', value: 0.01 },
  },

  // ── 3. 網格線框 ──────────────────────────
  gridline: {
    id: 'gridline',
    name: '網格線框',
    price: 300,
    rarity: 'fine',
    description: '透明線框球體，內部經緯網格自轉',
    playerColor: 0x000000,
    massLabelColor: 0xFFFFFF,
    outlineColor: 0xFFFFFF,
    outlineWidth: 2,
    fillMode: 'wireframe',
    ambientVFX: 'gridPulse',
    vfxColor: 0xFFFFFF,
    skillVFX: { particleShape: 'cross' },
    buff: { type: 'xpGain', value: 0.02 },
  },

  // ── 4. 薄荷迴路 ──────────────────────────
  mint: {
    id: 'mint',
    name: '薄荷迴路',
    price: 350,
    rarity: 'fine',
    description: '白色球體表面流動薄荷綠電路紋路',
    playerColor: 0xFFFFFF,
    massLabelColor: 0x000000,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'circuit',
    ambientVFX: 'circuitSparks',
    vfxColor: 0x00FFBB,
    skillVFX: { trailColor: 0x00FFBB },
    buff: { type: 'cooldown', value: 0.01 },
  },

  // ── 5. 波普半調 ──────────────────────────
  halftone: {
    id: 'halftone',
    name: '波普半調',
    price: 400,
    rarity: 'fine',
    description: '覆蓋規律黑色半調網點的波普藝術風格',
    playerColor: 0xFFFFFF,
    massLabelColor: 0x000000,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'halftone',
    ambientVFX: 'orbitDots',
    vfxColor: 0xFFFFFF,
    skillVFX: { particleShape: 'dot' },
    buff: { type: 'goldGain', value: 0.02 },
  },

  // ── 6. 黑曜石 ──────────────────────────
  obsidian: {
    id: 'obsidian',
    name: '黑曜石',
    price: 500,
    rarity: 'rare',
    description: '純黑球體，白色細描邊，暗影蒸氣環繞',
    playerColor: 0x111111,
    massLabelColor: 0xFFFFFF,
    outlineColor: 0xFFFFFF,
    outlineWidth: 2,
    fillMode: 'solid',
    ambientVFX: 'darkSmoke',
    vfxColor: 0x444444,
    skillVFX: { trailColor: 0x222222, particleColor: 0x333333 },
    buff: { type: 'speed', value: 0.02 },
  },

  // ── 7. 駭客終端 ──────────────────────────
  hacker: {
    id: 'hacker',
    name: '駭客終端',
    price: 600,
    rarity: 'rare',
    description: '表面流動綠色數位雨代碼',
    playerColor: 0x0A0A0A,
    massLabelColor: 0x00FF88,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'matrix',
    ambientVFX: 'matrixRain',
    vfxColor: 0x00FF88,
    skillVFX: { trailColor: 0x00FF88, textVFX: true },
    buff: { type: 'cooldown', value: 0.02 },
  },

  // ── 8. 鎏金 ──────────────────────────
  aureate: {
    id: 'aureate',
    name: '鎏金',
    price: 750,
    rarity: 'epic',
    description: '金色球體帶金屬光澤，持續金色光點粒子',
    playerColor: 0xFFD700,
    massLabelColor: 0x3D2B00,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'metallic',
    ambientVFX: 'goldenGlow',
    vfxColor: 0xFFD700,
    skillVFX: { trailColor: 0xFFD700, particleShape: 'triangle' },
    buff: { type: 'xpGain', value: 0.03 },
  },

  // ── 9. 零核 ──────────────────────────
  nullcore: {
    id: 'nullcore',
    name: '零核',
    price: 900,
    rarity: 'epic',
    description: '白色半透明外殼，黑洞核心吸入周圍粒子',
    playerColor: 0xDDDDDD,
    massLabelColor: 0x000000,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'voidcore',
    ambientVFX: 'voidSuction',
    vfxColor: 0xFFFFFF,
    skillVFX: { trailColor: 0xFFFFFF, particleColor: 0x111111 },
    buff: { type: 'pickupRange', value: 0.02 },
  },

  // ── 10. 虹彩稜鏡 ──────────────────────────
  iridescent: {
    id: 'iridescent',
    name: '虹彩稜鏡',
    price: 1000,
    rarity: 'legendary',
    description: '緩慢流動的虹彩漸層，稜鏡光芒環繞',
    playerColor: 0xFF00FF, // 基底色（實際由 iridescent shader 覆蓋）
    massLabelColor: 0x000000,
    outlineColor: null,
    outlineWidth: 0,
    fillMode: 'iridescent',
    ambientVFX: 'prismGlow',
    vfxColor: 0xFF00FF,
    skillVFX: { trailColor: 0xFF00FF, rainbow: true },
    buff: { type: 'speed', value: 0.03 },
  },
};

/**
 * 取得皮膚定義
 * @param {string} skinId - 皮膚 ID
 * @returns {object} 皮膚定義
 */
export function getSkinDef(skinId) {
  return SKIN_DEFS[skinId] || SKIN_DEFS.default;
}

/**
 * 取得所有皮膚定義（陣列）
 * @returns {object[]}
 */
export function getAllSkins() {
  return Object.values(SKIN_DEFS);
}

/**
 * 取得皮膚的稀有度定義
 * @param {string} skinId - 皮膚 ID
 * @returns {object} 稀有度定義
 */
export function getSkinRarity(skinId) {
  const skin = getSkinDef(skinId);
  return RARITY_DEFS[skin.rarity] || RARITY_DEFS.common;
}

/**
 * 取得皮膚的 Buff 描述文字
 * @param {object} buff - buff 定義 { type, value }
 * @returns {string} 中文描述
 */
export function getBuffDescription(buff) {
  if (!buff) return '';
  const pct = Math.round(buff.value * 100);
  const labels = {
    speed: `移速 +${pct}%`,
    pickupRange: `拾取範圍 +${pct}%`,
    xpGain: `經驗獲取 +${pct}%`,
    goldGain: `金幣獲取 +${pct}%`,
    cooldown: `技能冷卻 -${pct}%`,
  };
  return labels[buff.type] || '';
}
