/**
 * tutorial.js — 新手教學系統
 *
 * 獨立管理三組教學流程：
 * 1. intro (Step 5→9)：初次進入遊戲教學
 * 2. levelUp (Step 1→3)：晉升 Lv.2 後教學
 * 3. sprintEquipped (Step 4)：裝備衝刺後首次進入遊戲教學
 *
 * 依賴注入：透過 initTutorial(deps) 接收外部函式，避免循環依賴。
 */

let tutorialStep = 0;
let deps = null;

// ─── 步驟定義 ───────────────────────────────────────────

/** 產生畫面中央的虛擬目標 */
/** 
 * 產生畫面中央的虛擬目標（自動適應玩家大小）
 * @param {number} fallbackHalfSize - 若無法獲取玩家時的預設半徑
 * @param {number} multiplier - 半徑倍率（用於包含圓環等情況）
 */
function centerTarget(fallbackHalfSize, multiplier = 1) {
  return {
    getBoundingClientRect: () => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      let radius = fallbackHalfSize;

      if (deps && deps.getPlayer && deps.calculateRadius) {
        const p = deps.getPlayer();
        if (p) {
          radius = deps.calculateRadius(p.mass);
        }
      }

      const r = radius * multiplier;
      return {
        top: cy - r, left: cx - r,
        width: r * 2, height: r * 2,
        bottom: cy + r, right: cx + r,
      };
    },
  };
}

const STEPS = {
  // ── 流程 2: 晉升 Lv.2 教學（必須點擊目標）──
  1: {
    text: '恭喜升到 2 級！你獲得了第一個技能點。點擊「返回主畫面」來查看如何使用它。',
    target: () => document.querySelector('.end-game-btn.secondary'),
    pos: 'top',
    clickAnywhere: false,
  },
  2: {
    text: '點擊「技能」分頁來進入技能管理頁面。',
    target: () => document.querySelector('.tab-btn[data-tab="skills"]'),
    pos: 'bottom',
    clickAnywhere: false,
  },
  3: {
    text: '每升一級可以獲得 1 個技能點，你可以在這裡查看目前擁有的點數。',
    target: () => document.querySelector('.skill-points-card'),
    pos: 'bottom',
    clickAnywhere: true,
    next: 11,
  },
  11: {
    text: '目前你已經自動解鎖了「衝刺」技能，點擊「裝備」來啟用它！',
    target: () => document.querySelector('.skill-card[data-skill="sprint"] .btn-equip'),
    pos: 'top',
    clickAnywhere: false,
  },

  // ── 流程 3: 裝備衝刺後教學（點擊任意位置）──
  4: {
    text: '你已經裝備了「衝刺」技能！點擊此按鈕即可向前位移，注意它有 2 次充能，使用後會自動恢復CD。',
    target: () => document.getElementById('skill-btn'),
    pos: 'top',
    clickAnywhere: true,
    flow: 'sprintEquipped',
  },

  // ── 流程 1: 初次進入遊戲教學（點擊任意位置）──
  5: {
    text: '歡迎來到 Null Vector！你的目標是吞噬比你小的細胞來壯大自己。',
    target: () => centerTarget(50, 1.1),
    pos: 'top',
    clickAnywhere: true,
    next: 6,
  },
  6: {
    text: '觀察這裡的存活人數。吞噬所有對手，成為場上最後的贏家！',
    target: () => document.querySelector('.survival-stats'),
    pos: 'bottom',
    clickAnywhere: true,
    next: 7,
  },
  7: {
    text: '這是你的雷達小地圖。白點代表其他玩家，彩色亮點則是稀有資源，記得善加利用！',
    target: () => document.getElementById('minimap'),
    pos: 'bottom',
    clickAnywhere: true,
    next: 8,
  },
  8: {
    text: '這是你的生命值。每次被更大的對手碰撞會失去一顆心。',
    target: () => document.getElementById('central-heart-container'),
    pos: 'bottom',
    clickAnywhere: true,
    next: 9,
  },
  9: {
    text: '玩家周圍的圓環代表額外生命。圓環消失後再次被吞噬就會淘汰！',
    target: () => centerTarget(70, 1.4), // 包含生命圓環的範圍
    pos: 'top',
    clickAnywhere: true,
    next: 10,
  },
  10: {
    text: '教學結束！現在，目標是成為場上最後的贏家，祝你好運！',
    target: () => centerTarget(100, 1.1),
    pos: 'top',
    clickAnywhere: true,
    flow: 'intro',
  },
};

// ─── 核心 API ───────────────────────────────────────────

/**
 * 初始化教學系統，注入外部依賴
 * @param {object} d
 * @param {object}   d.progress           - 進度物件參考（原地修改）
 * @param {Function} d.saveProgress       - 儲存進度
 * @param {Function} d.pauseForTutorial   - 暫停遊戲（含計時補償）
 * @param {Function} d.resumeFromTutorial - 恢復遊戲（含計時補償）
 * @param {Function} d.isGameRunning      - 查詢遊戲是否運行中
 */
export function initTutorial(d) {
  deps = d;
}

/** 教學是否正在進行中 */
export function isTutorialActive() {
  return tutorialStep !== 0;
}

/** 取得目前教學步驟 */
export function getTutorialStep() {
  return tutorialStep;
}

/**
 * 顯示或隱藏教學步驟
 * @param {number} step - 步驟編號，0 = 關閉教學
 */
export function showTutorialStep(step) {
  if (step === tutorialStep && step !== 0) return;

  const overlay = document.getElementById('tutorial-overlay');
  if (!overlay) return;

  // ── 關閉教學 ──
  if (step === 0) {
    overlay.classList.remove('active');
    overlay.onclick = null;
    tutorialStep = 0;
    return;
  }

  const s = STEPS[step];
  if (!s) return;

  tutorialStep = step;

  // 暫停遊戲（僅在局內）
  if (deps.isGameRunning()) {
    deps.pauseForTutorial();
  }

  // ── 設定 UI ──
  overlay.classList.add('active');
  const textBox = overlay.querySelector('#tutorial-text');
  const highlight = overlay.querySelector('#tutorial-highlight');
  const box = overlay.querySelector('.tutorial-box');
  const skipBtn = overlay.querySelector('#tutorial-skip');

  textBox.textContent = s.text;

  const targetEl = s.target();
  if (!targetEl) return;

  const rect = targetEl.getBoundingClientRect();

  // Spotlight ring
  const pad = 5;
  highlight.style.display = 'block';
  highlight.style.top = `${rect.top - pad}px`;
  highlight.style.left = `${rect.left - pad}px`;
  highlight.style.width = `${rect.width + pad * 2}px`;
  highlight.style.height = `${rect.height + pad * 2}px`;

  // Tutorial box positioning
  box.classList.remove('pos-top', 'pos-bottom');
  if (s.pos === 'bottom') {
    box.classList.add('pos-bottom');
    box.style.top = `${rect.bottom + 40}px`;
    box.style.bottom = 'auto';
  } else {
    box.classList.add('pos-top');
    const bottomVal = window.innerHeight - rect.top + 40;
    box.style.bottom = `${Math.max(10, Math.min(window.innerHeight - 300, bottomVal))}px`;
    box.style.top = 'auto';
  }

  const boxWidth = box.offsetWidth || 320;
  const centerX = rect.left + rect.width / 2;
  box.style.left = `${Math.max(20, Math.min(window.innerWidth - boxWidth - 20, centerX - boxWidth / 2))}px`;
  box.style.transform = 'none';

  // ── Click Handler ──
  overlay.onclick = (e) => {
    if (e.target === skipBtn || e.target.id === 'tutorial-skip') return;

    if (s.clickAnywhere) {
      advanceStep(s);
    } else {
      // 必須點擊 highlight 區域內
      const isInside = (
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom
      );
      if (isInside) {
        advanceStep(s);
        targetEl.click();
      }
      // 區域外的點擊被吸收（不做任何事）
    }
  };

  // ── Skip Button ──
  skipBtn.onclick = (e) => {
    e.stopPropagation();
    if (confirm('確定要跳過新手教學嗎？')) {
      const p = deps.progress;
      p.tutorialDone = true;
      p.tutorialIntroDone = true;
      p.tutorialSkillGameDone = true;
      deps.saveProgress(p);
      if (deps.isGameRunning()) deps.resumeFromTutorial();
      showTutorialStep(0);
    }
  };
}

// ─── 內部輔助 ───────────────────────────────────────────

/** 推進到下一步或完成流程 */
function advanceStep(s) {
  if (s.next) {
    setTimeout(() => showTutorialStep(s.next), 100);
  } else if (s.flow) {
    // 流程結束 → 更新進度旗標
    const p = deps.progress;
    if (s.flow === 'intro') {
      p.tutorialIntroDone = true;
    } else if (s.flow === 'sprintEquipped') {
      p.tutorialSkillGameDone = true;
    }
    deps.saveProgress(p);
    if (deps.isGameRunning()) deps.resumeFromTutorial();
    showTutorialStep(0);
  }
}

// ─── 鉤子 ───────────────────────────────────────────────

/**
 * 設定教學觸發鉤子。應在 main.js 初始化完成後呼叫一次。
 */
export function setupTutorialHooks() {
  // Hook: returnToMenu → 觸發 Lv.2 教學
  const originalReturnToMenu = window.returnToMenu;
  window.returnToMenu = () => {
    originalReturnToMenu();
    if (deps.progress.level >= 2 && !deps.progress.tutorialDone) {
      setTimeout(() => showTutorialStep(2), 500);
    }
  };

  // Hook: tab 切換 → 步驟 2→3
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (tutorialStep === 2 && btn.dataset.tab === 'skills') {
        setTimeout(() => showTutorialStep(3), 300);
      }
    });
  });
}

/**
 * 處理技能裝備時的教學回應。由 main.js 呼叫。
 * @param {string} skillId - 被裝備的技能 ID
 */
export function onSkillEquipped(skillId) {
  if (tutorialStep === 11 && skillId === 'sprint') {
    deps.progress.tutorialDone = true;
    deps.saveProgress(deps.progress);
    showTutorialStep(0);
  }
}
