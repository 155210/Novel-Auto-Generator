/**
 * 小说导入改写 · 剧情地图
 *
 * 正式改写前先摸清每层讲了什么，再决定怎么改：
 * - 免费统计（纯代码，不调 AI）：章节目录、角色出场、关键词雷达、人名共现、新角色登场、节奏、章节长度异常
 * - 预扫描（便宜模型，每层只要短输出）：一句话剧情、摘要、出场人物、关系变化、毒点
 * - 规划：每层改写指令、接回点、跳过、书签待办，AI 提议改写点、先改大纲
 *
 * 浏览器端 IIFE，不碰 DOM，挂在 window.NovelImporterPlotMap；测试里直接 eval。
 */
(function (root) {
    'use strict';

    // ============================================
    // 免费统计
    // ============================================

    const DEFAULT_KEYWORDS = ['送给', '献给', '献上', '嫁给', '婚约', '退婚', '背叛', '强占', '夺走', '委身', '侍寝', '玷污'];
    const FIGHT_WORDS = ['剑', '刀', '拳', '掌', '杀', '战', '斩', '血', '攻击', '交手', '出手', '爆发', '轰'];
    const ROMANCE_WORDS = ['脸红', '心跳', '吻', '拥抱', '抱住', '羞', '温柔', '牵手', '依偎', '喜欢', '情意'];

    // 「XX道」「XX说」前面经常出现、但不是人名的词
    const NAME_STOP = new Set(
        '众人 他们 她们 我们 你们 自己 对方 少年 少女 老者 男子 女子 那人 此人 有人 一人 两人 二人 心中 心里 忍不住 低声 轻声 冷声 沉声 笑着 只是 不过 于是 然后 突然 连忙 急忙 微微 淡淡 缓缓 轻轻 默默 继续 开口 说话 知道 一边 一声 这时 此时 那时 随即 当即 立刻 顿时 不禁 不由 还是 但是 可是 因为 所以 如果 虽然 一个 这个 那个 什么 怎么 为何 已经 正在 回头 转头 点头 摇头 叹息 叹了 哼了 大声 小声 喃喃 问道 答道 解释 说明 补充 回答 反问 追问 心想 暗道 暗想 想到 看着 望着 盯着 听到 听着 看到 掌柜 小二 侍女 弟子 师父 师尊 师兄 师姐 师妹 师弟 前辈 晚辈 公子 小姐 姑娘 夫人 老爷 大人 陛下 殿下'.split(
            ' ',
        ),
    );
    const NAME_VERB_RE = /([一-龥]{2,4})(?=(?:笑道|问道|答道|喝道|怒道|叹道|冷笑道|轻声道|低声道|开口道|说道|道：|道:|道，|说：|说:|说，|点了点头|摇了摇头|皱眉|微微一笑|一愣|一怔))/g;

    const layerText = (layer) => (layer.paras || []).map((p) => p.text).join('\n');

    function countOf(text, word) {
        if (!word) return 0;
        let n = 0;
        let i = text.indexOf(word);
        while (i >= 0) {
            n++;
            i = text.indexOf(word, i + word.length);
        }
        return n;
    }

    /** 从原文里猜人名：统计「XX道」「XX说」前面反复出现的两三个字，按次数排 */
    function guessNames(layers, { limit = 60, minCount = 5 } = {}) {
        const counts = new Map();
        for (const l of layers) {
            const text = layerText(l);
            NAME_VERB_RE.lastIndex = 0;
            let m;
            while ((m = NAME_VERB_RE.exec(text))) {
                // 前面粘上的「的」「着」「对」这类字去掉（「看着裘月寒笑道」取「裘月寒」）
                const w = m[1].replace(/^[的了着在和与对向把被让给是也就都又将却便才看见听朝冲跟同]+/, '');
                if (w.length < 2) continue;
                if (NAME_STOP.has(w) || /[的了着么呢吧啊呀]/.test(w)) continue;
                counts.set(w, (counts.get(w) || 0) + 1);
            }
        }
        // 短的是长名字的后几个字（「月寒」和「裘月寒」），并进长的
        const list = [...counts.entries()].filter(([, n]) => n >= minCount);
        const names = new Set(list.map(([w]) => w));
        const merged = new Map();
        for (const [w, n] of list) {
            const full = w.length <= 3 ? [...names].find((x) => x.length > w.length && x.endsWith(w)) : null;
            const key = full || w;
            merged.set(key, (merged.get(key) || 0) + n);
        }
        return [...merged.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => ({ name, count }));
    }

    /** 名单：每行「名字 / 别名 / 别名」，# 开头的行忽略 */
    function parseNameList(text) {
        return String(text || '')
            .split(/\n+/)
            .map((line) => line.replace(/#.*$/, '').trim())
            .filter(Boolean)
            .map((line) => {
                const parts = line
                    .split(/[/／|｜,，、]/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                return { name: parts[0], aliases: [...new Set(parts)] };
            })
            .filter((x) => x.name);
    }

    function parseWordList(text) {
        return [
            ...new Set(
                String(text || '')
                    .split(/[\n,，、]+/)
                    .map((x) => x.trim())
                    .filter(Boolean),
            ),
        ];
    }

    /** 每个人名在一段文字里出现几次（别名合计；长别名先数，免得「月寒」把「裘月寒」又数一遍） */
    function nameCounts(text, names) {
        const out = {};
        for (const n of names) {
            const aliases = [...n.aliases].sort((a, b) => b.length - a.length);
            let rest = text;
            let c = 0;
            for (const a of aliases) {
                const k = countOf(rest, a);
                if (k) {
                    c += k;
                    rest = rest.split(a).join('\u0000');
                }
            }
            if (c) out[n.name] = c;
        }
        return out;
    }

    const median = (arr) => {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    /** 对话占比：引号里的字数 / 总字数 */
    function dialogueRatio(text) {
        const q = text.match(/[“「『"][^”」』"]{0,400}[”」』"]/g) || [];
        const n = q.reduce((a, x) => a + x.length, 0);
        return text.length ? n / text.length : 0;
    }

    /**
     * 整本书的免费统计。layers 是 core 分好的层；opts：
     * names [{name, aliases}]、keywords [词]、isChapterTitle(text) 判断章节标题行
     */
    function analyze(layers, opts = {}) {
        const names = opts.names || [];
        const keywords = opts.keywords && opts.keywords.length ? opts.keywords : DEFAULT_KEYWORDS;
        const isTitle = opts.isChapterTitle || (() => false);
        const rows = [];
        const firstSeen = {};
        const pairTotals = {};
        // 章节长度：按标题行切，记下每章在哪层开头
        const chapters = [];
        let cur = null;
        for (const l of layers) {
            for (const p of l.paras || []) {
                if (isTitle(p.text)) {
                    cur = { title: p.text.trim(), layer: l.index, chars: 0 };
                    chapters.push(cur);
                } else if (cur) cur.chars += p.text.length;
            }
        }
        const med = median(chapters.map((c) => c.chars));
        for (const c of chapters) {
            c.flag = med && c.chars < med * 0.35 ? 'short' : med && c.chars > med * 2.2 ? 'long' : '';
        }

        for (const l of layers) {
            const text = layerText(l);
            const counts = nameCounts(text, names);
            for (const [n, c] of Object.entries(counts)) if (c >= 3 && firstSeen[n] === undefined) firstSeen[n] = l.index;
            // 同一段里一起出现的两个人
            const pairs = {};
            for (const p of l.paras || []) {
                const here = Object.keys(nameCounts(p.text, names));
                for (let a = 0; a < here.length; a++)
                    for (let b = a + 1; b < here.length; b++) {
                        const key = [here[a], here[b]].sort().join('|');
                        pairs[key] = (pairs[key] || 0) + 1;
                        pairTotals[key] = (pairTotals[key] || 0) + 1;
                    }
            }
            const kw = {};
            for (const w of keywords) {
                const c = countOf(text, w);
                if (c) kw[w] = c;
            }
            const fight = FIGHT_WORDS.reduce((a, w) => a + countOf(text, w), 0);
            const romance = ROMANCE_WORDS.reduce((a, w) => a + countOf(text, w), 0);
            const dlg = dialogueRatio(text);
            const per10k = (n) => (text.length ? (n * 10000) / text.length : 0);
            const pace = per10k(fight) > 25 ? '战斗' : per10k(romance) > 8 ? '感情' : dlg > 0.45 ? '对话' : '日常';
            rows.push({
                layer: l.index,
                chars: l.chars || text.length,
                chapters: chapters.filter((c) => c.layer === l.index).map((c) => c.title),
                odd: chapters.filter((c) => c.layer === l.index && c.flag).map((c) => ({ title: c.title, chars: c.chars, flag: c.flag })),
                names: counts,
                pairs,
                keywords: kw,
                keywordTotal: Object.values(kw).reduce((a, b) => a + b, 0),
                pace,
                dialogue: Math.round(dlg * 100),
                fight: Math.round(per10k(fight)),
                romance: Math.round(per10k(romance)),
                newNames: [],
            });
        }
        for (const [n, i] of Object.entries(firstSeen)) if (rows[i]) rows[i].newNames.push(n);
        // 关键词命中多的层：总数 ≥ 3，且在全书前 15%
        const totals = rows.map((r) => r.keywordTotal).filter((x) => x > 0);
        const cut = totals.length ? [...totals].sort((a, b) => b - a)[Math.max(0, Math.ceil(totals.length * 0.15) - 1)] : Infinity;
        for (const r of rows) r.hot = r.keywordTotal >= 3 && r.keywordTotal >= cut;
        const pairs = Object.entries(pairTotals)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => ({ a: k.split('|')[0], b: k.split('|')[1], count: n }));
        return { rows, chapters, medianChapter: med, pairs, names: names.map((n) => n.name), keywords };
    }

    // ============================================
    // 规划数据：每层的指令、标记、扫描结果
    // ============================================

    /** plan 的形状，缺的字段补上 */
    function normalizePlan(plan) {
        const p = plan && typeof plan === 'object' ? plan : {};
        return {
            names: typeof p.names === 'string' ? p.names : '',
            keywords: typeof p.keywords === 'string' ? p.keywords : DEFAULT_KEYWORDS.join('、'),
            volumeSize: Math.max(2, Number(p.volumeSize) || 10),
            layers: p.layers && typeof p.layers === 'object' ? p.layers : {},
            suggestions: Array.isArray(p.suggestions) ? p.suggestions : [],
        };
    }

    /** 某层的规划（没有就给空的） */
    function layerPlan(plan, i) {
        const x = (plan && plan.layers && plan.layers[i]) || {};
        return {
            instruction: x.instruction || '', // D1 每层改写指令
            outline: x.outline || '', // D5 定下来的新大纲
            outlines: Array.isArray(x.outlines) ? x.outlines : [], // D8 候选新大纲
            resume: !!x.resume, // D6 从这层接回原文
            skip: !!x.skip, // D11 跳过这层（不出楼层）
            condense: !!x.condense, // D11 压缩这层（水章写短）
            insert: x.insert || '', // D10 这层后面插一段自创剧情
            bookmark: !!x.bookmark, // C8
            todo: !!x.todo, // C8 待决定
            note: x.note || '',
            scan: x.scan || null, // B1 预扫描结果 {hash, oneLine, summary, characters, relations, toxic, tags}
        };
    }

    function setLayerPlan(plan, i, patch) {
        const p = normalizePlan(plan);
        const cur = { ...((p.layers || {})[i] || {}), ...patch };
        // 清掉空字段，存档小一点
        for (const k of Object.keys(cur)) if (cur[k] === '' || cur[k] === false || cur[k] == null || (Array.isArray(cur[k]) && !cur[k].length)) delete cur[k];
        const layers = { ...p.layers };
        if (Object.keys(cur).length) layers[i] = cur;
        else delete layers[i];
        return { ...p, layers };
    }

    /** 这层有没有用户要的改写（指令、新大纲、插入、压缩） */
    function hasRewritePlan(lp) {
        return !!(lp.instruction.trim() || lp.outline.trim() || lp.insert.trim() || lp.condense);
    }

    // 简单的字符串哈希，判断原文变没变（缓存用）
    function hashText(s) {
        let h = 2166136261;
        const str = String(s);
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36) + ':' + str.length;
    }

    // ============================================
    // 预扫描（B1、C5、G5）
    // ============================================

    const DEFAULT_TOXIC = `- 主角把自己的女人送给别人（送女）
- 主角的女人被他人染指、背叛主角（NTR、绿帽）
- 主角被无脑虐、降智`;

    function buildScanPrompt(layer, opts = {}) {
        const text = layerText(layer);
        const names = (opts.names || []).map((n) => n.aliases.join('/')).join('；');
        return [
            `你是网文剧情分析助手。下面是一部长篇小说的第 ${layer.index + 1} 层（约 ${text.length} 字）。只读、不改写，按要求输出一个 JSON。`,
            opts.prevOneLine ? `## 上一层剧情\n${opts.prevOneLine}` : '',
            names ? `## 已知人物（同一人的不同叫法用 / 分隔，统一用第一个名字）\n${names}` : '',
            `## 读者的雷点（本层出现就写进 毒点，附原文证据）\n${opts.toxicRules || DEFAULT_TOXIC}`,
            `## 原文\n<原文>\n${text}\n</原文>`,
            `## 输出格式（只输出这个 JSON，别的什么都不要写）
{"一句话": "30 字以内概括本层主线", "摘要": "100 到 200 字，谁做了什么、结果如何", "人物": ["本层出场的主要人物，用规范名"], "关系": [{"甲": "人名", "乙": "人名", "变化": "比如 结拜、翻脸、订婚、表白"}], "毒点": [{"雷点": "命中的雷点", "证据": "原文里的一句话"}], "标签": ["从 战斗 感情 日常 修炼 阴谋 转折 高潮 水章 里选，最多 3 个"]}
键和字符串一律用英文双引号，没有的写空数组。`,
        ]
            .filter(Boolean)
            .join('\n\n');
    }

    function parseLooseJsonObject(raw, parseLooseJson) {
        const s = String(raw || '');
        const a = s.indexOf('{');
        const b = s.lastIndexOf('}');
        if (a < 0 || b <= a) throw new Error('回复里没有 JSON');
        return parseLooseJson ? parseLooseJson(s.slice(a, b + 1)) : JSON.parse(s.slice(a, b + 1));
    }

    function parseScanResponse(raw, parseLooseJson) {
        const j = parseLooseJsonObject(raw, parseLooseJson);
        const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
        const str = (v) => String(v ?? '').trim();
        return {
            oneLine: str(j.一句话 ?? j.oneLine),
            summary: str(j.摘要 ?? j.summary),
            characters: arr(j.人物 ?? j.characters).map(str).filter(Boolean),
            relations: arr(j.关系 ?? j.relations)
                .map((r) => ({ a: str(r.甲 ?? r.a), b: str(r.乙 ?? r.b), change: str(r.变化 ?? r.change) }))
                .filter((r) => r.a && r.change),
            toxic: arr(j.毒点 ?? j.toxic)
                .map((t) => (typeof t === 'string' ? { rule: t, evidence: '' } : { rule: str(t.雷点 ?? t.rule), evidence: str(t.证据 ?? t.evidence) }))
                .filter((t) => t.rule),
            tags: arr(j.标签 ?? j.tags).map(str).filter(Boolean).slice(0, 3),
        };
    }

    /** F6：按字数估算预扫描的 token 和花费。price 是每百万 token 的价格 */
    function estimateScanCost(layers, { estimateTokens, inPrice = 0, outPrice = 0, outTokens = 350, overhead = 400 } = {}) {
        const est = estimateTokens || ((t) => Math.ceil(String(t).length * 1.1));
        let input = 0;
        for (const l of layers) input += est(layerText(l)) + overhead;
        const output = layers.length * outTokens;
        return { layers: layers.length, input, output, cost: (input * inPrice + output * outPrice) / 1e6 };
    }

    /** F2：最多 n 个同时跑 */
    async function runPool(items, n, worker, shouldStop = () => false) {
        let next = 0;
        const runOne = async () => {
            while (next < items.length && !shouldStop()) {
                const k = next++;
                await worker(items[k], k);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, runOne));
    }

    // ============================================
    // AI 提议改写点（D4）、先改大纲（D5）、多方案（D8）
    // ============================================

    function mapLines(layers, plan, { from = 0, to = Infinity } = {}) {
        return layers
            .filter((l) => l.index >= from && l.index <= to)
            .map((l) => {
                const s = layerPlan(plan, l.index).scan;
                if (!s) return `第${l.index + 1}层：（没扫描）`;
                const tox = s.toxic.length ? ` 【雷点：${s.toxic.map((t) => t.rule).join('、')}】` : '';
                return `第${l.index + 1}层：${s.oneLine || s.summary.slice(0, 60)}${tox}`;
            })
            .join('\n');
    }

    function buildSuggestPrompt(layers, plan, { preference = '', toxicRules = '' } = {}) {
        return `你是网文编辑。下面是一部长篇小说按层整理的剧情地图（每层一句话，标了读者的雷点）。读者想改掉不喜欢的剧情，请找出最值得改的层，给出具体改法。

## 读者的偏好和雷点
${preference || toxicRules || DEFAULT_TOXIC}

## 剧情地图
${mapLines(layers, plan)}

## 要求
- 只挑真正需要改的层，按层号从小到大，最多 30 条
- 每条写清：从哪层开始改、怎么改（改成什么样）、到第几层可以接回原文
- 改法要能让后面的剧情顺下去，不要只说「删掉」

## 输出格式（只输出这个 JSON 数组）
[{"层": 12, "接回": 15, "原因": "原剧情是什么、为什么要改", "改法": "具体改成什么"}]`;
    }

    function parseSuggestResponse(raw, parseLooseJson) {
        const s = String(raw || '');
        const a = s.indexOf('[');
        const b = s.lastIndexOf(']');
        if (a < 0 || b <= a) throw new Error('回复里没有 JSON 数组');
        const arr = parseLooseJson ? parseLooseJson(s.slice(a, b + 1)) : JSON.parse(s.slice(a, b + 1));
        return (Array.isArray(arr) ? arr : [])
            .map((x) => ({
                layer: Math.max(0, (parseInt(x.层 ?? x.layer, 10) || 1) - 1),
                resume: parseInt(x.接回 ?? x.resume, 10) ? parseInt(x.接回 ?? x.resume, 10) - 1 : null,
                reason: String(x.原因 ?? x.reason ?? '').trim(),
                change: String(x.改法 ?? x.change ?? '').trim(),
            }))
            .filter((x) => x.change);
    }

    /** D5/D8：按指令给一段层出新大纲，variants 个方案 */
    function buildOutlinePrompt(layers, plan, from, to, { instruction = '', facts = [], variants = 1 } = {}) {
        const before = mapLines(layers, plan, { from: Math.max(0, from - 3), to: from - 1 });
        const span = mapLines(layers, plan, { from, to });
        const after = mapLines(layers, plan, { from: to + 1, to: to + 2 });
        return `你是网文编辑。读者要改一段剧情，请先只写改写后的新大纲（不写正文）。

## 改写要求
${instruction || '（见各层的改写指令）'}
${facts.length ? `\n## 之前已经改掉、要一直遵守的事实\n${facts.map((f) => `- ${f}`).join('\n')}\n` : ''}
## 前情（原剧情）
${before || '（从开头开始）'}

## 要改的层（原剧情）
${span}

## 后面的原剧情（新大纲最后要能接回这里）
${after || '（到结尾）'}

## 要求
- 第 ${from + 1} 层到第 ${to + 1} 层，每层写一段 80 到 150 字的新大纲，写清人物做了什么、和原剧情哪里不同
- 保持人物性格不变，最后一层要能自然接回后面的原剧情
- 给出 ${variants} 个不同的方案${variants > 1 ? '，方案之间的改法要明显不同' : ''}

## 输出格式（只输出这个 JSON）
{"方案": [{"名称": "方案的一句话概括", "各层": {"${from + 1}": "这一层的新大纲"}}]}`;
    }

    function parseOutlineResponse(raw, parseLooseJson) {
        const j = parseLooseJsonObject(raw, parseLooseJson);
        const list = Array.isArray(j.方案 ?? j.plans) ? (j.方案 ?? j.plans) : [j];
        return list
            .map((p) => {
                const per = p.各层 ?? p.layers ?? {};
                const layers = {};
                for (const [k, v] of Object.entries(per)) {
                    const i = parseInt(k, 10);
                    if (i > 0 && String(v || '').trim()) layers[i - 1] = String(v).trim();
                }
                return { name: String(p.名称 ?? p.name ?? '').trim(), layers };
            })
            .filter((p) => Object.keys(p.layers).length);
    }

    // ============================================
    // D7 指令模板、E2 冲突预警
    // ============================================

    const DEFAULT_TEMPLATES = [
        '把这里的送女情节改成没有发生：主角察觉后出手阻止，女主留在主角身边',
        '这个事件改成未遂：对方的企图被识破，没有得逞',
        '删去这个角色的戏份，相关剧情由主角或其他角色顶上',
        '主角不再降智：提前看穿陷阱，用更聪明的办法解决',
        '加一段主角和女主的日常互动，增进感情',
    ];

    /** E2：后面的层里又写到账本事实里的人名，标出来提醒（账本事实之后的层才算） */
    function conflictHints(rows, facts, names) {
        const out = {};
        if (!facts || !facts.length) return out;
        const byName = names || [];
        for (const f of facts) {
            const who = byName.filter((n) => n.aliases.some((a) => f.text.includes(a))).map((n) => n.name);
            if (!who.length) continue;
            for (const r of rows) {
                if (r.layer <= (f.layer ?? -1)) continue;
                const hit = who.filter((n) => (r.names[n] || 0) >= 2);
                if (hit.length) (out[r.layer] = out[r.layer] || []).push({ fact: f.text, names: hit });
            }
        }
        return out;
    }

    // ============================================
    // 搜原文、目录、空章定位
    // ============================================

    /** 关键词转成正则：英文不分大小写；用 /.../ 包起来就按正则搜 */
    function searchRegex(query) {
        const q = String(query || '').trim();
        if (!q) return null;
        const m = q.match(/^\/(.+)\/([a-z]*)$/);
        try {
            if (m) return new RegExp(m[1], m[2].includes('i') ? 'gi' : 'g');
        } catch (e) {
            return null;
        }
        return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    /** 全书搜：返回命中总数和前 limit 条（带层号、所在章节、前后文） */
    function searchLayers(layers, query, { limit = 300, isChapterTitle = () => false, context = 28 } = {}) {
        const re = searchRegex(query);
        const hits = [];
        let total = 0;
        if (!re) return { total, hits, bad: !!String(query || '').trim() };
        for (const l of layers) {
            let chapter = '';
            let nth = 0;
            for (const p of l.paras || []) {
                const t = p.text || '';
                if (isChapterTitle(t)) chapter = t;
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(t))) {
                    if (!m[0]) {
                        re.lastIndex++;
                        continue;
                    }
                    total++;
                    if (hits.length < limit) {
                        hits.push({
                            layer: l.index,
                            nth,
                            chapter,
                            before: (m.index > context ? '…' : '') + t.slice(Math.max(0, m.index - context), m.index),
                            match: m[0],
                            after: t.slice(m.index + m[0].length, m.index + m[0].length + context) + (m.index + m[0].length + context < t.length ? '…' : ''),
                        });
                    }
                    nth++;
                }
            }
        }
        return { total, hits };
    }

    /** 目录：每个章节标题在哪一层 */
    function chapterIndex(layers) {
        const out = [];
        for (const l of layers) for (const c of l.chapters || []) out.push({ title: c, layer: l.index });
        return out;
    }

    /**
     * 空章在原文里的位置：清洗时空章标题被删了，回原文找到它，
     * 带出它后面那点内容（看得出是被替换还是真没写），并按下一个正常章节推出在第几层附近。
     */
    function locateEmptyChapters(rawText, titles, layers, isChapterTitle = () => false) {
        const raw = String(rawText || '');
        const lines = raw.split(/\r?\n/).map((x) => x.trim());
        const chapLayer = new Map();
        for (const c of chapterIndex(layers)) if (!chapLayer.has(c.title)) chapLayer.set(c.title, c.layer);
        const used = new Set();
        return (titles || []).map((title) => {
            let at = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i] === title && !used.has(i)) {
                    at = i;
                    break;
                }
            }
            if (at < 0) return { title, layer: null, after: '', next: '' };
            used.add(at);
            const body = [];
            let next = '';
            for (let j = at + 1; j < lines.length; j++) {
                if (!lines[j]) continue;
                if (isChapterTitle(lines[j])) {
                    next = lines[j];
                    break;
                }
                body.push(lines[j]);
            }
            let layer = next && chapLayer.has(next) ? chapLayer.get(next) : null;
            if (layer === null) {
                // 后面紧跟的也是空章，就往前找最近的正常章节
                for (let j = at - 1; j >= 0 && layer === null; j--) if (lines[j] && chapLayer.has(lines[j])) layer = chapLayer.get(lines[j]);
            }
            return { title, layer, after: body.join('\n').slice(0, 200), next };
        });
    }

    const API = {
        DEFAULT_KEYWORDS,
        DEFAULT_TOXIC,
        DEFAULT_TEMPLATES,
        layerText,
        countOf,
        guessNames,
        parseNameList,
        parseWordList,
        nameCounts,
        analyze,
        normalizePlan,
        layerPlan,
        setLayerPlan,
        hasRewritePlan,
        hashText,
        buildScanPrompt,
        parseScanResponse,
        estimateScanCost,
        runPool,
        mapLines,
        buildSuggestPrompt,
        parseSuggestResponse,
        buildOutlinePrompt,
        parseOutlineResponse,
        conflictHints,
        searchRegex,
        searchLayers,
        chapterIndex,
        locateEmptyChapters,
    };
    root.NovelImporterPlotMap = API;
})(typeof window !== 'undefined' ? window : globalThis);
