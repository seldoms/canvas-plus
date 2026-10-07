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
 * 真正会被当作**图**注入模型的 ref 类型。
 *
 * 音色（voice）不在其中：它是一段音频 profileId，模型收不到「图」，
 * pipeline 的注入顺序（shotReferenceContext → resolveSelectedArtifacts）也只遍历
 * character / scene / prop 三类。音色若参与编号，中间插一条就会让**后面每一项的编号整体错位** ——
 * 实测过一镜两角色各带音色时：refs 显示母亲是 `@image#3`，而模型实际收到的 `<image2>` 才是母亲，
 * `<image3>` 已经是场景。给用户看一个与模型实收不一致的编号，比不给编号更糟。
 */
export const IMAGE_REF_KINDS = Object.freeze(["character", "scene", "prop"]);

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
 *
 * **只给会被注入成图的 ref 编号**（IMAGE_REF_KINDS）；音色是音频、不占图位，
 * 它的 `index`/`tag` 如实为 null —— 不编一个假的编号出来。
 */
export function numberShotRefs(refs) {
    const seen = new Map();
    let next = 0;
    return (Array.isArray(refs) ? refs : []).map((ref, index) => {
        const stableKey = `${ref.kind}:${ref.bindingId}`;
        // 编号在**本次调用内**按出现顺序分配；同stableKey 复用同一个号。
        // 不跨调用保留顺序 —— 渲染期重新编号正是「顺序变、编号跟着变」的预期行为。
        if (!IMAGE_REF_KINDS.includes(ref.kind)) {
            return { ...ref, stableKey, index: null, tag: null, ordinal: index + 1 };
        }
        if (!seen.has(stableKey)) {
            next += 1;
            seen.set(stableKey, next);
        }
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
 * 5. 与 pipeline 实际注入顺序对齐（编号的唯一正确性判据）
 * ------------------------------------------------------------------ */

/**
 * 把 reference-lock 的解析结果摊成「模型实际收到的 `<imageN>` 顺序」。
 *
 * ⚠️ 顺序必须与 pipeline.shotReferenceContext 完全一致（角色 → 场景 → 道具），
 * 那段遍历代码是注入的事实源；这里只把它的输出换个形状，便于与 refs 编号逐项比对。
 * 两边顺序若各自演化，界面上的 `@image#N` 就会指向另一张图 —— 而用户看不出来。
 *
 * @param {object} resolved resolveSelectedArtifacts() 的返回值
 * @returns {Array<{ index: number, kind: string, bindingId: string, artifactId: string|null, assetRefId: string|null, url: string|null }>}
 */
export function injectedImageOrder(resolved) {
    const rows = [];
    for (const [kind, bucket] of [
        ["character", resolved?.character],
        ["scene", resolved?.scene],
        ["prop", resolved?.prop],
    ]) {
        for (const entry of Array.isArray(bucket) ? bucket : []) {
            const bindingId = String(entry?.bindingId ?? "").trim();
            if (!bindingId) continue;
            rows.push({
                index: rows.length + 1,
                kind,
                bindingId,
                artifactId: String(entry?.artifactId ?? "").trim() || null,
                // assetRefId 要带出来：前端从「本镜引用」跳回资料包那条引用时要它。
                assetRefId: String(entry?.assetRefId ?? "").trim() || null,
                url: String(entry?.url ?? "").trim() || null,
            });
        }
    }
    return rows;
}

/**
 * 核对 refs 的图编号与实际注入顺序是否逐项一致。
 *
 * 为什么要有这个函数：编号是**给人看的对应关系**，一旦与模型实收错位，
 * 用户按 `@image#3` 去核对提示词就会核对到别人的图 —— 且没有任何报错。
 * 所以把它做成可执行的不变量，端点与测试都跑它，而不是靠注释约定。
 *
 * @returns {{ aligned: boolean, mismatches: Array<{ index: number, ref: object|null, injected: object|null }> }}
 */
export function checkRefNumbering(refs, resolved) {
    const injected = injectedImageOrder(resolved);
    // 只比有编号的（图类）ref；音色没有编号，天然不参与。
    const numbered = (Array.isArray(refs) ? refs : []).filter((ref) => Number.isInteger(ref?.index));
    const mismatches = [];
    const byIndex = new Map(numbered.map((ref) => [ref.index, ref]));
    // 两侧都按 index 归位比对：注入多了或少了都要能看出来，不能只比重叠部分。
    const span = Math.max(numbered.length, injected.length);
    for (let index = 1; index <= span; index += 1) {
        const ref = byIndex.get(index) ?? null;
        const actual = injected[index - 1] ?? null;
        const same = Boolean(ref) && Boolean(actual) && ref.kind === actual.kind && ref.bindingId === actual.bindingId;
        if (!same) mismatches.push({ index, ref, injected: actual });
    }
    return { aligned: mismatches.length === 0, mismatches };
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
 * @param {object} [args.resolved] resolveSelectedArtifacts() 的返回值。
 *   传了就同时给出「编号 ↔ 模型实收」的对齐结论与实际产物地址（前端缩略图要用）；
 *   没传则 alignment 为 null —— **不假装已核对**，由调用方决定能不能显示编号。
 * @returns {{ refs: Array, summary: string, gaps: string[], alignment: object|null, images: Array }}
 */
export function composeShotRefs({ binding, design, expectedCharacterIds, resolved } = {}) {
    const { names, voiceProfileId } = namesFromDesign(design);
    const numbered = numberShotRefs(buildShotRefs(binding, { names, voiceProfileId }));
    // 缺口只报**不该出现却出现**的：剧本有角色但本镜一个都没引，说明要么漏写要么角色名没对上。
    const referenced = numbered.filter((ref) => ref.kind === "character").map((ref) => ref.bindingId);
    const gaps = Array.isArray(expectedCharacterIds) && expectedCharacterIds.length ? refsGaps(referenced, expectedCharacterIds) : [];
    const alignment = resolved ? checkRefNumbering(numbered, resolved) : null;
    const images = resolved ? injectedImageOrder(resolved) : [];
    return { refs: numbered, summary: describeShotRefs(numbered), gaps, alignment, images };
}
