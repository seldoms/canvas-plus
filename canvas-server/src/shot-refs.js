/**
 * 镜头「参考清单」：把 buildShotBinding 的隐式推导结果**物化成可见、可渲染的清单**。
 *
 * 为什么需要它（这是 2026-10-08 查证出的真实结构缺口）：
 *   `skills/02-storyboard/SKILL.md` 定的镜头权威形状里**根本没有「引用哪个资产」这个位置**。
 *   于是「这一镜用的是谁的定妆照」只能由 `reference-lock.buildShotBinding()` 在生成那一刻
 *   隐式推导（角色 token + 角色名文本匹配 → characterIds/locationId/propIds），
 *   用户在分镜页**看不见、也改不了**。资料包选了一张脸，分镜页不会告诉你它被哪几镜用到了。
 *
 * 为什么不把 refs 做成可编辑字段（关键决策）：
 *   推导链`buildShotBinding` 已经是一个**单一事实源**（显式 token 优先 + 角色名文本兜底）。
 *   再允许手改 refs，就等于承认「声明」与「推导」两个真相 —— 一旦不一致，
 *   锁脸用哪张图、QC 报不报缺参考，全都要开始对账。所以 refs 是**只读派生视图**：
 *   要改引用关系，改的是角色名/ token 那些真源（走既有 updateShot），refs 随之更新。
 *
 * 与 libtv 那种 `@image#1` 文本标记的关键区别：
 *   libtv 是单平台闭环，编号就是它自己上下文里的图，可以直接烧进提示词文本。
 *   我们是多后端（本地 ComfyUI / RunningHub 可选 / 任意模型），项目铁律是
 *   **换模型即报废的提示词不许烧进分镜**。所以编号只在前端渲染时生成，**不落库** ——
 *   顺序一变编号就得变，落库就成了另一处会漂的真相。
 */

/** ref 的 kind：与项目侧资产角色同名，便于前端按类分组渲染。 */
export const REF_KINDS = Object.freeze(["character", "scene", "prop", "voice"]);

/**
 * 把 ShotBinding 摊平成前端可渲染的参考清单。
 *
 * @param {object} binding buildShotBinding() 的返回值
 * @param {object} [options]
 * @param {Record<string,string>} [options.names] bindingId → 中文名（剧本/服化道产物的角色名等）
 * @param {Record<string,string>} [options.voiceProfileId] bindingId → 音色 id
 * @returns {Array<{ kind: string, bindingId: string, label: string, role: string }>}
 *   role 是这一项在本镜里的**用法**（形象/ 站位 / 环境 / 道具），不是资产角色。
 */
export function buildShotRefs(binding, options = {}) {
    const names = options.names || {};
    const voices = options.voiceProfileId || {};
    const rows = [];
    // 按 kind+bindingId 去重：同一个角色在 characterIds 里出现两次，
    // 清单里就该只列一条 —— 否则界面上同一个名字出现两遍，看起来像两张不同的图。
    const seen = new Set();
    const add = (kind, bindingId, role, label) => {
        const id = String(bindingId ?? "").trim();
        if (!id) return;
        const key = `${kind}:${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ kind, bindingId: id, label: String(label ?? names[id] ?? id).trim(), role });
    };

    // 角色：形象 + 音色是两件事，分开列 —— libtv 也把「角色音频」与「角色形象」分两条。
    for (const id of binding?.characterIds || []) {
        add("character", id, "形象");
        // 音色的 label 是**音色 id 本身**（它没有中文名），不能沿用角色名 ——
        // 否则两条参考显示同一个名字，用户根本分不清换的是形还是声。
        if (voices[id]) add("voice", id, "音色", voices[id]);
    }
    add("scene", binding?.locationId, "环境");
    for (const id of binding?.propIds || []) add("prop", id, "道具");
    return rows;
}

/**
 * 给参考清单编 `@image#N` 形式的**展示编号**。
 *
 * 刻意只在渲染期算、不落库：编号跟着顺序走，顺序变了编号就得变。
 * 落库等于多一处必然漂的真相（而项目已经有两处口径漂移的教训了）。
 * 稳定的 key 用 `${kind}:${bindingId}` —— 与顺序无关，供 React key 与去重用。
 */
export function numberShotRefs(refs) {
    const seen = new Map();
    return (Array.isArray(refs) ? refs : []).map((ref, index) => {
        const stableKey = `${ref.kind}:${ref.bindingId}`;
        // 编号在**本次调用内**按出现顺序分配；同stableKey 复用同一个号。
        // 不跨调用保留顺序 —— 渲染期重新编号正是「顺序变、编号跟着变」的预期行为。
        if (!seen.has(stableKey)) seen.set(stableKey, seen.size + 1);
        const n = seen.get(stableKey);
        return { ...ref, stableKey, index: n, tag: `@image#${n}`, ordinal: index + 1 };
    });
}

/**
 * 参考清单是否齐全：只用于**如实提示**「这一镜还缺哪些参考」，绝不据此声称已锁脸。
 * 与 contracts §11.5.3 的 stale 语义同源 —— 缺料是事实，不是失败。
 */
export function refsGaps(refs, expected) {
    // 两种入参都吃：完整 ref 对象，或已取出的 id 字符串。
    // 早先只认 `{ bindingId }` 对象，于是传 id 数组时 have 装进一堆 undefined，
    // 全部 id 都被判成缺口 —— 一个「什么都在」的局面报出「什么都不在」。
    const idsOf = (list) =>
        (Array.isArray(list) ? list : [])
            .map((item) => (typeof item === "string" ? item : item?.bindingId))
            .map((id) => String(id ?? "").trim())
            .filter(Boolean);
    const have = new Set(idsOf(refs));
    return idsOf(expected).filter((id) => !have.has(id));
}

/** 渲染成一句人话，用于 QC warning 与提示条（不给 UI 拼字符串用）。 */
export function describeShotRefs(refs) {
    if (!Array.isArray(refs) || !refs.length) return "";
    return refs.map((ref) => `${ref.label}（${ref.role}）`).join("、");
}

/* ------------------------------------------------------------------ *
 * 4. 组装：项目镜头 + 流水线产物 → 带编号与缺口的参考清单
 * ------------------------------------------------------------------ */

/**
 * 从 03 服化道产物抽「bindingId → 中文名」与「bindingId → 音色 id」。
 *
 * 为什么只抽名字与音色，不抽图：图在 AssetRef.selectedArtifactId / artifacts 里，
 * 由 reference-lock.resolveSelectedArtifacts 解析（那是锁脸的单一事实源）。
 * 本模块只负责**让人看得见**用谁，不负责决定用哪张 —— 那是 reference-lock 的职责。
 */
export function namesFromDesign(design) {
    const names = {};
    const voiceProfileId = {};
    const take = (list, key) => {
        for (const item of Array.isArray(list) ? list : []) {
            const id = String(item?.id ?? item?.bindingId ?? "").trim();
            if (!id) continue;
            const name = String(item?.name ?? item?.label ?? "").trim();
            if (name) names[id] = name;
            const voice = String(item?.voiceProfileId ?? item?.voiceId ?? "").trim();
            if (voice) voiceProfileId[id] = voice;
        }
    };
    take(design?.characters, "character");
    take(design?.locations, "scene");
    take(design?.props, "prop");
    return { names, voiceProfileId };
}

/**
 * 组装单镜参考清单。
 *
 * @param {object} args
 * @param {object} args.binding buildShotBinding() 的返回值
 * @param {object} [args.design] 03 服化道产物
 * @param {Array}  [args.expectedCharacterIds] 剧本声明但本镜没引用到的角色（用于如实报缺口）
 * @returns {{ refs: Array, summary: string, gaps: string[] }}
 */
export function composeShotRefs({ binding, design, expectedCharacterIds } = {}) {
    const { names, voiceProfileId } = namesFromDesign(design);
    const numbered = numberShotRefs(buildShotRefs(binding, { names, voiceProfileId }));
    // 缺口只报**不该出现却出现**的：剧本有角色但本镜一个都没引，说明要么漏写要么角色名没对上。
    const referenced = numbered.filter((ref) => ref.kind === "character").map((ref) => ref.bindingId);
    const gaps = Array.isArray(expectedCharacterIds) && expectedCharacterIds.length ? refsGaps(referenced, expectedCharacterIds) : [];
    return { refs: numbered, summary: describeShotRefs(numbered), gaps };
}
