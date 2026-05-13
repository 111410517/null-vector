/**
 * skins.js — 皮膚定義與管理
 *
 * 目前僅實作預設皮膚，其餘皮膚留待後續設計。
 */

/**
 * 皮膚定義表
 */
export const SKIN_DEFS = {
  default: {
    id: 'default',
    name: '幽靈白',
    price: 0,
    description: '預設白色球體',
    /** 玩家球體填充色 */
    playerColor: 0xFFFFFF,
    /** 質量標籤顏色 */
    massLabelColor: 0x000000,
  },
  // 後續皮膚在此擴充
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
