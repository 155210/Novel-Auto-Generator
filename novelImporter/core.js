// ============================================================
// novelImporter/core.js - 小说导入改写：纯逻辑层
//
// 不碰 DOM、不碰酒馆，只做：清洗分层、拼提示词、解析回复、应用补丁、
// 称呼替换、世界书合并、表格指令模拟、楼层组装、运行引擎。
// 浏览器里挂到 window.NovelImporterCore，测试里直接 eval 后取 globalThis.NovelImporterCore。
//
// 设计要点：
// - 整本书只让 AI 读一遍，每层一次调用同时返回 标题/摘要/补丁/世界书/表格/称呼
// - 不改的原文由程序拼回，AI 只输出补丁；剧情改写模式下才输出整层正文
// - 表格操作让 AI 按「表名 + 主键 + 列名」给，行号由程序按记忆表格插件的执行规则换算
// - 处理时始终用原名，称呼替换在渲染时统一做，前面的层也能用上后面才发现的称呼
// ============================================================

(function (root) {
    'use strict';

    const VERSION = '1.1.0';

    // ============================================
    // 默认配置
    // ============================================

    const CN_NUM = '0-9０-９一二三四五六七八九十百千万零两';
    const DEFAULT_CHAPTER_REGEX = `^(?:第[${CN_NUM}]+[章话話回节節卷篇幕][^\\n]{0,40}|[0-9]{1,5}[.．、 ][^\\n]{1,40}|(?:Chapter|CHAPTER|Ch\\.)\\s*[0-9]+[^\\n]{0,60}|제\\s*[0-9]+\\s*[화장][^\\n]{0,40}|(?:序章|楔子|尾声|尾聲|终章|終章|番外|プロローグ|エピローグ|Prologue|Epilogue|PROLOGUE|EPILOGUE)[^\\n]{0,40})$`;

    const DEFAULT_AD_PATTERNS = [
        '^=+$',
        '^继续阅读$',
        '请收藏[:：]?',
        '(最新章节|全文阅读|免费阅读|手机阅读|无弹窗|笔趣阁|www\\.|\\.com|\\.net)',
    ];

    // 行内水印：只删掉命中的那一段，不删整行（如「bg90○ cc」「xunbeiyi8点cc」）
    const DEFAULT_INLINE_AD_PATTERNS = [
        '[A-Za-z0-9]{2,}\\s?(?:[^\\sA-Za-z0-9\\u3400-\\u9fff]|[点點])\\s?(?:cc|com|net|org|cn)(?![A-Za-z])',
    ];

    const DEFAULT_REWRITE_PROMPT = `- 对话之后如果看不出是谁说的，用一句简短的动作或神态补上说话人，例如：“……。”裘月寒蹙眉道。
- 已经能看出说话人的对话不要补。
- 补充内容贴合原文文风，不要改变剧情，不要添加原文没有的事件。`;

    const DEFAULT_DIVERGENCE_RULES = `- 出现主角把自己的女人送给别人（送女）的情节
- 出现主角的女人被他人染指、背叛主角（NTR、绿帽）的情节`;

    const DEFAULT_DIVERGENCE_DIRECTION = `把相关情节改成没有发生：保持其他角色的性格和动机不变，后续剧情顺着这个改动自然发展，直到能重新接回原文为止。`;

    const DEFAULT_WORLDBOOK_CATEGORIES = [
        {
            name: '角色',
            enabled: true,
            constant: false,
            guide: '**名称**、**性别**、**年龄**（原文写明才填）、**身份**、**外貌**、**性格**、**能力/境界**、**与主角关系**、**重要经历**、**话语示例**',
        },
        { name: '地点', enabled: true, constant: false, guide: '**名称**、**位置**、**特征**、**发生过的重要事件**' },
        { name: '组织', enabled: true, constant: false, guide: '**名称**、**性质**、**主要成员**、**目标**、**势力范围**' },
        { name: '道具', enabled: false, constant: false, guide: '**名称**、**类型**、**功能**、**持有者**、**来历**' },
        { name: '设定', enabled: true, constant: false, guide: '世界规则、修炼体系、境界划分、特殊名词的解释' },
    ];

    // 主角和女主的角色条目按人设格式写，导入后可直接当用户人设 / 角色人设用
    const PERSONA_GUIDE = `- 角色条目多给一个 "定位" 字段：主角 / 女主 / 配角。女主指和主角有感情线或明显暧昧的女性角色
- 定位为主角或女主的条目，"内容" 按人设格式写完整：**名称**、**性别**、**年龄**（原文写明才填）、**身份**、**外貌**、**性格**、**说话风格**、**背景经历**、**能力/境界**、**与主角关系**、**话语示例**（从原文摘 1 到 3 句）
- 配角条目写简要信息即可`;

    const DEFAULT_TABLE_ROLES = {
        singleRow: ['时空表格'],
        appendOnly: ['事件历史', '重要事件历史表格'],
        eventTable: '事件历史',
        summaryTable: '大总结',
        summaryThreshold: 20,
        eventsPerLayer: '3到5',
    };

    const DEFAULT_SETTINGS = {
        // 分层
        layerChars: 15000,
        alignToChapter: true,
        chapterRegex: DEFAULT_CHAPTER_REGEX,
        adPatterns: DEFAULT_AD_PATTERNS.slice(),
        adRemovePrevLine: true,
        inlineAdPatterns: DEFAULT_INLINE_AD_PATTERNS.slice(),
        // 全书出现这么多次以上的长段落当作盗版站塞的垃圾段删掉，0 为不删
        repeatParaLimit: 3,
        repeatParaMinChars: 12,

        // 改写
        expansionRatio: 10,
        rewritePrompt: DEFAULT_REWRITE_PROMPT,
        maxPatchChars: 120,
        extraRules: '',

        // 剧情改写（送女/NTR 等）
        divergenceEnabled: true,
        divergenceRules: DEFAULT_DIVERGENCE_RULES,
        divergenceDirection: DEFAULT_DIVERGENCE_DIRECTION,

        // 称呼
        protagonistName: '',
        protagonistAliases: [],
        aliasBlacklist: [],
        aliasMode: 'user', // user：{{user}}；persona：酒馆当前 user 名字；custom：自定义
        aliasTarget: 'fary',
        personaName: '',
        useUserMacro: false,

        // 标签与标题
        titleTag: 'bt',
        bodyTag: '正文',
        titleMode: 'ai', // ai：AI 起标题；original：用原文章节标题
        titleFormat: '#第{n}{unit}：{title}',
        chapterUnit: 'auto', // auto：按原文判断；章；话

        // 翻译：auto 时原文大部分不是中文就整层翻译成简体中文
        translateMode: 'auto',
        imageMode: 'bbi', // bbi：柏宝绘格式（聊天记录导出能打进 EPUB）；img：直接 <img>；off：不导入插图
        tableMessageTemplate: '', // 记忆插件设置里的「消息模板」，从插件读取或手填
        useMessageTemplate: true,
        glossaryEnabled: true, // 翻译时用术语表统一人名地名（只发给 AI，不进正文）
        glossaryMax: 300, // 每层最多带多少条（只带本层原文里出现的）
        writeTableEdit: true,

        // 世界书
        worldbookEnabled: true,
        worldbookCategories: DEFAULT_WORLDBOOK_CATEGORIES.map((c) => ({ ...c })),
        worldbookPrompt: '',
        worldbookContextChars: 6000,
        plotSummaryEntries: true,

        // 表格
        tablesEnabled: true,
        tableRoles: { ...DEFAULT_TABLE_ROLES },
        tablePrompt: '',
        tableContextRows: 30,

        // 审阅
        reviewMode: 'divergence', // off | every | divergence

        // 运行
        concurrency: 1,
        retries: 2,
    };

    // ============================================
    // 小工具
    // ============================================

    function clone(v) {
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    }

    function escapeRegExp(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** 粗估 token：中日韩字符按 1.1，其余按 4 个字符 1 个 */
    const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

    /** 「十二」「一百零三」「１２」「12」转成数字，转不了返回 NaN */
    function cnToInt(str) {
        const t = String(str || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        if (/^\d+$/.test(t)) return Number(t);
        let total = 0;
        let section = 0;
        let num = 0;
        for (const ch of t) {
            if (ch in CN_DIGIT) num = CN_DIGIT[ch];
            else if (ch in CN_UNIT) {
                const u = CN_UNIT[ch];
                if (u === 10000) {
                    total += (section + num) * u;
                    section = 0;
                } else section += (num || 1) * u;
                num = 0;
            } else return NaN;
        }
        return total + section + num;
    }

    /** 拆章节标题：{num, unit, title}。认不出来返回 null */
    function parseChapterTitle(line) {
        const t = String(line || '').trim();
        let m = new RegExp(`^第\\s*([${CN_NUM}]+)\\s*([章话話回节節])\\s*[：:、.．\\-—\\s]*(.*)$`).exec(t);
        if (m) return { num: cnToInt(m[1]), unit: /[话話]/.test(m[2]) ? '话' : '章', title: m[3].trim() };
        m = /^([0-9]{1,5})\s*[.．、 ]\s*(.*)$/.exec(t);
        if (m) return { num: Number(m[1]), unit: '', title: m[2].trim() };
        m = /^(?:Chapter|CHAPTER|Ch\.)\s*([0-9]+)\s*[:：.\-—\s]*(.*)$/.exec(t);
        if (m) return { num: Number(m[1]), unit: '', title: m[2].trim() };
        m = /^제\s*([0-9]+)\s*([화장])\s*[:：.\-—\s]*(.*)$/.exec(t);
        if (m) return { num: Number(m[1]), unit: m[2] === '화' ? '话' : '章', title: m[3].trim() };
        return null;
    }

    /** 全书按「话」还是按「章」：数章节标题里哪个多 */
    function detectChapterUnit(lines) {
        let hua = 0;
        let zhang = 0;
        for (const l of lines || []) {
            const p = parseChapterTitle(l);
            if (p && p.unit === '话') hua++;
            else if (p && p.unit === '章') zhang++;
        }
        return hua > zhang ? '话' : '章';
    }

    /**
     * 楼层标题行，默认「#第X章：标题」。
     * AI 标题：X 是层号；原文标题：X 和标题取本层第一个章节标题（翻译时标题用 AI 给的译名）。
     */
    function formatHeading(layer, aiTitle, settings, bookUnit) {
        const s = { ...DEFAULT_SETTINGS, ...settings };
        const fmt = s.titleFormat || '#第{n}{unit}：{title}';
        let n = layer.index + 1;
        let title = String(aiTitle || '').trim();
        let unit = s.chapterUnit === '章' || s.chapterUnit === '话' ? s.chapterUnit : bookUnit || '章';
        if (s.titleMode === 'original' && layer.chapters && layer.chapters.length) {
            const first = layer.chapters[0];
            const p = parseChapterTitle(first);
            if (!p) return fmt.replace(/^(#*).*$/s, `$1${layer.translate && title ? title : first}`);
            n = p.num;
            if (s.chapterUnit === 'auto' && p.unit) unit = p.unit;
            if (!layer.translate || !title) title = p.title;
        }
        // AI 有时把「第X章」也写进标题，去掉免得重复
        title = title.replace(new RegExp(`^第\\s*[${CN_NUM}]+\\s*[章话話回节節]\\s*[：:、.．\\-—\\s]*`), '').trim();
        let out = fmt.replace(/\{n\}/g, String(n)).replace(/\{unit\}/g, unit).replace(/\{title\}/g, title);
        if (!title) out = out.replace(/[：:]\s*$/, '');
        return out;
    }

    /** 判断正文是不是外文：有一定量假名，或汉字只占字母类字符的一小半 */
    function detectForeign(text) {
        const s = String(text || '').slice(0, 200000);
        const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
        const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
        const other = (s.match(/[A-Za-z\u0400-\u04ff\uac00-\ud7af\u00c0-\u024f]/g) || []).length;
        const letters = han + kana + other;
        if (letters < 50) return false;
        if (kana / letters > 0.05) return true;
        return han / letters < 0.5;
    }

    // EPUB 插图在正文里的占位行，导入酒馆时换成插图
    const IMAGE_MARKER_RE = /〔插图(\d+)〕/g;

    /** 整层重写（翻译 / 剧情改写）后，AI 漏掉的插图占位行按原来的相对位置补回去 */
    function ensureImageMarkers(srcParas, outParas) {
        const want = [];
        srcParas.forEach((p, i) => {
            for (const m of String(p.text).matchAll(IMAGE_MARKER_RE)) want.push({ marker: m[0], ratio: srcParas.length > 1 ? i / (srcParas.length - 1) : 0 });
        });
        if (!want.length) return outParas;
        const out = outParas.slice();
        const have = new Set(out.join('\n').match(IMAGE_MARKER_RE) || []);
        for (const w of want) {
            if (have.has(w.marker)) continue;
            out.splice(Math.min(out.length, Math.round(w.ratio * out.length)), 0, w.marker);
        }
        return out;
    }

    function estimateTokens(text) {
        if (!text) return 0;
        const s = String(text);
        const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) || []).length;
        return Math.ceil(cjk * 1.1 + (s.length - cjk) / 4);
    }

    function uniq(arr) {
        return [...new Set(arr.filter((x) => x !== undefined && x !== null && String(x).trim() !== '').map((x) => String(x).trim()))];
    }

    function safeRegex(src, flags) {
        try {
            return new RegExp(src, flags);
        } catch (e) {
            return null;
        }
    }

    // ============================================
    // 清洗与分层
    // ============================================

    function normalizeText(text) {
        return String(text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/^﻿/, '')
            .split('\n')
            .map((l) => l.replace(/^[\s　]+|[\s　]+$/g, ''))
            .join('\n');
    }

    const SENTENCE_END = /[。！？!?…」』”"）)~～—]$/;

    /**
     * 去掉广告行。命中的行删掉；adRemovePrevLine 时，紧挨着的上一行如果很短又没有句末标点，
     * 多半是广告标题（例如「XXX狂XX」+「请收藏：」），一起删。章节标题（protectRegex）不删。
     */
    function cleanText(text, patterns, removePrev, protectRegex, opts = {}) {
        const regs = (patterns || []).map((p) => safeRegex(p)).filter(Boolean);
        const inline = (opts.inlinePatterns || []).map((p) => safeRegex(p, 'g')).filter(Boolean);
        const protect = protectRegex ? safeRegex(protectRegex) : null;
        let lines = normalizeText(text).split('\n');
        let removed = 0;
        let inlineRemoved = 0;
        if (inline.length) {
            lines = lines.map((line) => {
                let l = line;
                for (const r of inline) {
                    r.lastIndex = 0;
                    l = l.replace(r, () => (inlineRemoved++, ''));
                }
                return l === line ? line : l.trim();
            });
        }

        // 盗版源常把整章换成同一段垃圾文字反复出现，按全书重复次数删掉
        let repeated = 0;
        const limit = Number(opts.repeatLimit) || 0;
        if (limit > 0) {
            const minChars = Math.max(4, Number(opts.repeatMinChars) || 12);
            const key = (l) => l.replace(/[\s\u3000]/g, '');
            const count = new Map();
            for (const l of lines) {
                const k = key(l);
                if (k.length >= minChars && !(protect && protect.test(l))) count.set(k, (count.get(k) || 0) + 1);
            }
            // 按章统计：一章里大半都是垃圾段时，剩下的零星几行也一并删掉
            const isJunk = (l) => {
                const k = key(l);
                return k.length >= minChars && (count.get(k) || 0) >= limit && !(protect && protect.test(l));
            };
            const kept = [];
            let chapter = [];
            const flush = () => {
                const total = chapter.reduce((n, l) => n + l.length, 0);
                const junk = chapter.reduce((n, l) => n + (isJunk(l) ? l.length : 0), 0);
                const dropAll = total > 0 && junk / total >= 0.6;
                for (const l of chapter) {
                    if (l && (dropAll || isJunk(l))) repeated++;
                    else kept.push(l);
                }
                chapter = [];
            };
            for (const l of lines) {
                if (protect && isChapterTitle(l, protect)) {
                    flush();
                    kept.push(l);
                } else chapter.push(l);
            }
            flush();
            lines = kept;
        }

        const out = [];
        for (const line of lines) {
            if (line && regs.some((r) => r.test(line))) {
                removed++;
                if (removePrev) {
                    // 回退到上一条非空行
                    let k = out.length - 1;
                    while (k >= 0 && !out[k]) k--;
                    if (k >= 0 && out[k].length <= 40 && !SENTENCE_END.test(out[k]) && !regs.some((r) => r.test(out[k])) && !(protect && protect.test(out[k]))) {
                        out.splice(k, 1);
                        removed++;
                    }
                }
                continue;
            }
            out.push(line);
        }

        // 只剩标题、没有正文的章节：删掉标题并记下来，提醒用户换源
        const emptyChapters = [];
        let result = out;
        if (protect) {
            const nonEmpty = out.filter((l) => l.length > 0);
            const drop = new Set();
            for (let i = 0; i < nonEmpty.length; i++) {
                // 卷名后面紧跟章节标题是正常的
                if (!isChapterTitle(nonEmpty[i], protect) || /^第[^\n]{1,12}[卷部篇]/.test(nonEmpty[i])) continue;
                let body = 0;
                for (let j = i + 1; j < nonEmpty.length && !isChapterTitle(nonEmpty[j], protect); j++) body += nonEmpty[j].length;
                if (body < (Number(opts.emptyChapterChars) || 5)) {
                    emptyChapters.push(nonEmpty[i]);
                    drop.add(i);
                }
            }
            if (drop.size) {
                let n = -1;
                result = out.filter((l) => (l.length > 0 ? !drop.has(++n) : true));
            }
        }
        return { text: result.join('\n'), removed, repeated, inlineRemoved, emptyChapters };
    }

    function splitParagraphs(text) {
        return normalizeText(text)
            .split('\n')
            .filter((l) => l.length > 0);
    }

    function isChapterTitle(line, regex) {
        if (!regex || !line || line.length > 45) return false;
        return regex.test(line);
    }

    /**
     * 按字数切层。alignToChapter 时到字数后继续读到下一个章节标题再切，
     * 但不超过 1.5 倍字数，免得一章特别长的书切不开。
     */
    function splitLayers(paragraphs, opts = {}) {
        const target = Math.max(500, Number(opts.layerChars) || DEFAULT_SETTINGS.layerChars);
        const regex = opts.chapterRegex ? safeRegex(opts.chapterRegex) : null;
        const align = opts.alignToChapter !== false && !!regex;
        const layers = [];
        let cur = [];
        let chars = 0;
        const push = () => {
            if (!cur.length) return;
            const chapters = cur.filter((p) => isChapterTitle(p.text, regex)).map((p) => p.text);
            layers.push({ index: layers.length, paras: cur, chars, chapters });
            cur = [];
            chars = 0;
        };
        paragraphs.forEach((text, i) => {
            const para = { id: i + 1, text };
            const title = isChapterTitle(text, regex);
            if (chars >= target) {
                if (!align || title || chars >= target * 1.5) push();
            }
            cur.push(para);
            chars += text.length;
        });
        push();
        // 结尾剩下太短的一截并进上一层，免得最后一层只有几百字
        if (layers.length > 1 && layers[layers.length - 1].chars < target * 0.3) {
            const tail = layers.pop();
            const last = layers[layers.length - 1];
            last.paras = last.paras.concat(tail.paras);
            last.chars += tail.chars;
            last.chapters = last.chapters.concat(tail.chapters);
        }
        return layers;
    }

    // ============================================
    // 提示词
    // ============================================

    const OUTPUT_FORMAT = `## 输出格式（严格遵守，按顺序输出这些标签，不要输出其他内容）
<bt>本层标题，10 字以内，概括本层主要剧情</bt>
<摘要>本层剧情摘要，100 到 200 字，写清楚谁做了什么</摘要>
<补丁>
每行一条补丁，没有就留空。格式：
P段号 | 锚点 | +补充内容      在锚点文字之后插入补充内容
P段号 | 锚点 | =替换内容      把锚点文字整体替换成替换内容
P段号 |  | +补充内容         在该段末尾追加
P段号 |  | ++新段落          在该段之后另起一段
</补丁>
<改写判定>{"触发": false, "规则": "", "说明": "", "回归原文": false}</改写判定>
<称呼>本层新出现的、指代主角的称呼，用 / 分隔；没有就留空</称呼>
<世界书>JSON，没有新内容就输出 {}</世界书>
<表格>JSON，没有变化就输出 {}</表格>`;

    const PATCH_RULES = `## 补丁规则
- 锚点必须从该段原文中**原样复制**一小段（5 到 15 个字），并且在该段里只出现一次
- 单条补丁的补充内容不超过 {MAX_PATCH} 字
- 只写需要改动的地方，没有列出的段落一律保持原文
- 不要输出整段原文，不要重复原文
- 原文里单独一行的 〔插图N〕 是插图位置，不要改动或删除`;

    function buildWorldbookSection(settings) {
        const cats = (settings.worldbookCategories || []).filter((c) => c.enabled !== false);
        if (!cats.length) return '';
        const guide = cats.map((c) => `- ${c.name}：${c.guide || ''}`).join('\n');
        const custom = (settings.worldbookPrompt || '').trim();
        return `## 世界书任务
从本层正文提取或更新世界书条目，只允许这些分类：${cats.map((c) => c.name).join('、')}
${guide}
- 条目名用原文里的正式名称；关键词是原文里实际出现的名称、别称
- 已有条目（见下方「相关世界书条目」）如有新信息，输出**更新后的完整内容**；没有新信息就不要输出
- 只写原文明确写出的信息，不要编造
${cats.some((c) => c.name === '角色') ? PERSONA_GUIDE + '\n' : ''}${custom ? custom + '\n' : ''}格式：{"角色": {"条目名": {"关键词": ["名称", "别称"], "定位": "女主", "内容": "markdown 文本"}}, "地点": {"条目名": {"关键词": [], "内容": "markdown 文本"}}}`;
    }

    /**
     * 记忆插件的「消息模板」是写给聊天里的 AI 的：里面的填写规则要照做，
     * 但 insertRow 这套写法和行号在这里用不上（这里按主键输出，程序换算行号），去掉免得 AI 混着写。
     */
    function condenseMessageTemplate(tpl) {
        let t = String(tpl || '');
        if (!t.trim()) return '';
        t = t.replace(/\{\{tableData\}\}/g, '（表格数据见下面的「当前表格」）');
        t = t.replace(/^[ \t]*<OperateRule>[\s\S]*?<\/OperateRule>[ \t]*$/gim, '');
        // <tableEdit> 示例里只留 // 开头的注释（大多是规则），函数调用示例去掉
        // 只认单独成行的标签，正文里顺嘴提到的「<tableEdit>标签内……」不算
        t = t.replace(/^[ \t]*<tableEdit>[ \t]*$([\s\S]*?)^[ \t]*<\/tableEdit>[ \t]*$/gim, (m, inner) =>
            inner
                .split('\n')
                .filter((l) => /^\s*\/\//.test(l))
                .map((l) => l.replace(/^\s*\/\/\s*/, '- '))
                .join('\n'),
        );
        t = t
            .split('\n')
            .filter((l) => !/^\s*(insertRow|updateRow|deleteRow)\s*\(/.test(l) && !/^\s*例如[：:]\s*(insertRow|updateRow|deleteRow)/.test(l))
            .join('\n');
        t = t.replace(/<\/?tableThink>|<!--|-->/gi, '');
        return t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function buildTableSection(settings, state, layerText) {
        if (!settings.tablesEnabled || !state.tables) return '';
        const t = state.tables;
        const roles = { ...DEFAULT_TABLE_ROLES, ...(settings.tableRoles || {}) };
        const defs = t.template.tables
            .map((tb) => {
                const notes = [tb.note, tb.insertNode && `插入：${tb.insertNode}`, tb.updateNode && `更新：${tb.updateNode}`]
                    .filter(Boolean)
                    .join('；')
                    .replace(/\s+/g, ' ')
                    .slice(0, 600);
                let kind = '主键为第一列，同主键的行会被更新';
                if (roles.singleRow.includes(tb.name)) kind = '只保留一行，输出当前最新状态即可';
                else if (roles.appendOnly.includes(tb.name)) kind = '只能插入，不能更新或删除';
                if (tb.name === roles.summaryTable) kind = '由程序在需要时单独要求填写，平时不要输出';
                return `- [${tb.index}:${tb.name}]（列：${tb.columns.join('、')}）：${kind}。${notes}`;
            })
            .join('\n');
        const custom = (settings.tablePrompt || '').trim();
        const mt = settings.useMessageTemplate !== false ? condenseMessageTemplate(settings.tableMessageTemplate) : '';
        const mtBlock = mt
            ? `\n### 记忆插件「消息模板」里的规则\n其中的填写要求照做；但修改方式以本节最后的 JSON 格式为准，不要输出 insertRow / updateRow / deleteRow 或 <tableEdit>。提到的 tableIndex 就是表名前的编号。\n<消息模板>\n${mt}\n</消息模板>\n`
            : '';
        return `## 记忆表格任务
根据本层正文更新下列表格。这是导入原著，不是聊天：
- 只填原文明确写出的信息；原文没写的列留空字符串，不要编造，不要随机生成数值
- 「${roles.eventTable}」本层插入 ${roles.eventsPerLayer} 行，按时间顺序概括本层的重要事件，每行 30 到 50 字，必须有主语
- 单元格里不要用逗号和双引号，语义分隔用 /
${custom ? custom + '\n' : ''}${mtBlock}表格定义：
${defs}

当前表格中与本层相关的行：
${tablesForPrompt(state, layerText, settings)}

格式：{"表名": [{"操作": "更新或插入", "主键": "第一列的值", "数据": {"列名": "值"}}, {"操作": "插入", "数据": {"列名": "值"}}, {"操作": "删除", "主键": "第一列的值"}]}`;
    }

    function buildDivergenceSection(settings, state, translate = false) {
        if (!settings.divergenceEnabled) return '';
        const div = state.divergence || {};
        const how = translate
            ? `- 触发时：在 <改写判定> 里写 "触发": true、命中的规则和改写说明，<${settings.bodyTag || '正文'}> 里直接输出按改写方向改好的译文
- 未触发时：<改写判定> 写 "触发": false，照常完整翻译`
            : `- 触发时：在 <改写判定> 里写 "触发": true、命中的规则和改写说明，并且**不输出 <补丁>，改为输出 <改写正文>本层完整的改写后正文</改写正文>**
- 未触发时：<改写判定> 写 "触发": false，照常输出 <补丁>`;
        const base = `## 剧情改写规则（强规则）
当本层原文出现下列情节时，触发剧情改写：
${settings.divergenceRules || DEFAULT_DIVERGENCE_RULES}
改写方向：${settings.divergenceDirection || DEFAULT_DIVERGENCE_DIRECTION}
${how}`;
        if (!div.active) return base;
        const notes = (div.notes || []).slice(-8).map((n) => `- 第 ${n.layer + 1} 层：${n.note}`).join('\n');
        return `${base}

## 当前处于剧情改写状态（从第 ${div.startLayer + 1} 层开始）
之前的改动记录：
${notes || '- （无）'}
- 本层必须和上面的改动保持一致：原文中与改动冲突的内容要一起改
${translate ? '- 本层译文同样要按上面的改动改写' : '- 本层输出 <改写正文>完整正文</改写正文>，不输出 <补丁>'}
- 如果本层原文已经和改动不冲突、可以直接接回原文，在 <改写判定> 里写 "回归原文": true（本层仍输出${translate ? '完整译文' : '改写正文'}）
- <改写判定> 的 "说明" 写本层又改了什么，供后续层参考`;
    }

    function buildAliasSection(settings, state) {
        const name = settings.protagonistName || '';
        if (!name) return '';
        const aliases = uniq([name, ...(state.aliases || [])]);
        return `## 主角
主角是「${name}」，已知称呼：${aliases.join('、')}
- 正文中出现其他指代主角的称呼（外号、昵称、尊称）时，写进 <称呼>
- 只写专指主角的称呼；像「师兄」「少爷」这种也可能指别人的，不要写进 <称呼>`;
    }

    const TRANSLATE_RULES = `## 翻译要求
- **完整翻译**：不得省略、概括或跳过原文的任何内容，逐句翻译成简体中文
- **保持格式**：原文的分段、换行、对话格式全部保留，一个原文段落对应一个译文段落（不要输出 [P段号]）
- **自然流畅**：符合中文小说的表达习惯，不要生硬直译
- **章节标题也要翻译**成中文
- 人名、地名、招式等专有名词的译名全书统一：「相关世界书条目」里已有译名的必须沿用
- 原文中单独一行的 〔插图N〕 是插图位置，原样保留在对应位置
- 不要添加解释、注释或原文`;

    // ============================================
    // 术语表（翻译模式）
    // ============================================

    /** 统一成 [{source, target, note}]，去掉空的和重复原文（先出现的为准） */
    function normalizeGlossary(list) {
        const out = [];
        const seen = new Set();
        for (const it of Array.isArray(list) ? list : []) {
            if (!it) continue;
            const source = String(it.source || it['原文'] || '').trim();
            const target = String(it.target || it['译名'] || '').trim();
            if (!source || !target || seen.has(source)) continue;
            seen.add(source);
            out.push({ source, target, note: String(it.note || it['说明'] || '').trim() });
        }
        return out;
    }

    /** 已有的原文不覆盖，免得后面的层把前面定好的译名改掉 */
    function mergeGlossary(list, items) {
        const base = list || [];
        const known = new Set(base.map((it) => it.source));
        const added = normalizeGlossary(items).filter((it) => !known.has(it.source));
        return added.length ? base.concat(added) : base;
    }

    /** 「原文 → 译名（说明）」一行一条，和小说翻译模块同一格式 */
    function parseGlossaryLines(text) {
        const out = [];
        for (const line of String(text || '').split('\n')) {
            const t = line.trim();
            if (!t || t === '无') continue;
            const m = t.match(/^[-*·]?\s*(.+?)\s*(?:→|->|=>)\s*(.+?)\s*(?:（(.*)）|\((.*)\))?\s*$/);
            if (m) out.push({ source: m[1].trim(), target: m[2].trim(), note: (m[3] || m[4] || '').trim() });
        }
        return out;
    }

    /** 只带本层原文里出现过的术语，表长到上千条也不会撑爆提示词 */
    function selectGlossary(list, layerText, max) {
        const hits = (list || []).filter((it) => layerText.includes(it.source));
        return hits.slice(0, Math.max(1, Number(max) || 300));
    }

    function buildGlossarySection(s, state, layerText) {
        const hits = selectGlossary(state.glossary, layerText, s.glossaryMax);
        const table = hits.length
            ? `## 专有名词对照表（必须严格遵守，不得改译）\n${hits.map((it) => `- ${it.source} → ${it.target}${it.note ? `（${it.note}）` : ''}`).join('\n')}\n\n`
            : '';
        return `${table}## 新术语
本层出现了上表没有的人名、地名、组织名、招式、特殊称谓时，定一个中文译名，写进 <新术语>，一行一条：原文 → 译名（可选说明）。没有就写「无」。`;
    }

    function titleInstruction(s, layer) {
        if (s.titleMode === 'original' && layer.translate && layer.chapters && layer.chapters.length) {
            return `<bt>本层第一个章节标题「${layer.chapters[0]}」的中文译名，只写标题文字，不要写章节号</bt>`;
        }
        return '<bt>本层标题，10 字以内，概括本层主要剧情</bt>';
    }

    function buildLayerPrompt(layer, settings, state, extra = {}) {
        const s = { ...DEFAULT_SETTINGS, ...settings };
        const layerText = layer.paras.map((p) => p.text).join('\n');
        const tr = !!layer.translate;
        const parts = [];
        const ratioText = `本层补充内容合计约为原文字数的 ${s.expansionRatio}%（原文约 ${layer.chars} 字，补充约 ${Math.round((layer.chars * s.expansionRatio) / 100)} 字）`;
        if (tr) {
            parts.push(`你是专业的小说翻译兼改编助手。任务：把下面这一层外文小说完整翻译成简体中文，导入角色扮演聊天，同时提取世界书和记忆表格（世界书、表格一律用中文写）。`);
            parts.push(TRANSLATE_RULES);
            parts.push(`## 用户的改写要求（翻译时一并做到）\n${(s.rewritePrompt || '').trim()}\n- ${ratioText}`);
        } else {
            parts.push(`你是小说改编助手。任务：把下面这一层小说正文导入角色扮演聊天。按用户的改写要求只输出补丁，同时提取世界书和记忆表格。`);
            parts.push(`## 用户的改写要求\n${(s.rewritePrompt || '').trim()}\n- ${ratioText}`);
        }
        if ((s.extraRules || '').trim()) parts.push(`## 其他规则\n${s.extraRules.trim()}`);
        if (!tr) parts.push(PATCH_RULES.replace('{MAX_PATCH}', String(s.maxPatchChars)));
        const div = buildDivergenceSection(s, state, tr);
        if (div) parts.push(div);
        const alias = buildAliasSection(s, state);
        if (alias) parts.push(alias);
        if (tr && s.glossaryEnabled) parts.push(buildGlossarySection(s, state, layerText));
        if (s.worldbookEnabled) {
            parts.push(buildWorldbookSection(s) + (tr ? '\n- 条目名和内容用中文译名；"关键词" 里同时写中文译名和原文写法（方便后面的层按原文找到这个条目）' : ''));
            const rel = selectRelevantEntries(state.worldbook || {}, layerText, s.worldbookContextChars);
            if (rel.length) {
                parts.push(
                    `## 相关世界书条目（已有内容）\n` +
                        rel.map((r) => `### ${r.category} / ${r.name}\n关键词：${(r.entry.关键词 || []).join('、')}\n${r.entry.内容}`).join('\n\n'),
                );
            }
        }
        const table = buildTableSection(s, state, layerText);
        if (table) parts.push(table);
        if (extra.needBigSummary && extra.eventRows && extra.eventRows.length) {
            parts.push(
                `## 大总结任务\n「${s.tableRoles.eventTable}」已满 ${extra.eventRows.length} 条，请把下面这些事件整合成一段客观总结（100 到 180 字，格式：日期/地点/总结内容），输出在 <大总结></大总结> 里：\n` +
                    extra.eventRows.map((r, i) => `${i + 1}. ${r.join(' / ')}`).join('\n'),
            );
        }
        const prevSummary = (state.summaries || []).slice(-2).map((x) => `- ${x.title}：${x.summary}`).join('\n');
        if (prevSummary) parts.push(`## 前情提要\n${prevSummary}`);
        let format = OUTPUT_FORMAT.replace('<bt>本层标题，10 字以内，概括本层主要剧情</bt>', titleInstruction(s, layer));
        if (tr) format = format.replace(/<补丁>[\s\S]*?<\/补丁>/, `<${s.bodyTag}>\n本层完整的简体中文译文\n</${s.bodyTag}>`);
        if (tr && s.glossaryEnabled) format += '\n<新术语>\n原文 → 译名\n</新术语>';
        parts.push(format + (extra.needBigSummary ? '\n<大总结>总结内容</大总结>' : ''));
        if (extra.feedback) {
            parts.push(`## 用户对上一次结果的修改意见（优先遵守）\n${extra.feedback}`);
            if (extra.previousRaw) parts.push(`## 你上一次的输出\n${extra.previousRaw}`);
        }
        parts.push(`## 本层正文（第 ${layer.index + 1} 层）\n<原文>\n${layer.paras.map((p) => `[P${p.id}]${p.text}`).join('\n')}\n</原文>`);
        return parts.join('\n\n');
    }

    /** 把提示词按消息链展开（与小说翻译模块同一规则） */
    function applyMessageChain(prompt, chain) {
        if (!Array.isArray(chain) || chain.length === 0) return [{ role: 'user', content: prompt }];
        const enabled = chain.filter((m) => m && m.enabled !== false);
        if (!enabled.length) return [{ role: 'user', content: prompt }];
        const hasSlot = enabled.some((m) => String(m.content || '').includes('{PROMPT}'));
        const msgs = enabled
            .map((m) => ({ role: m.role || 'user', content: String(m.content || '').replace(/\{PROMPT\}/g, prompt) }))
            .filter((m) => m.content.trim().length > 0);
        if (!hasSlot) msgs.push({ role: 'user', content: prompt });
        return msgs;
    }

    // ============================================
    // 解析回复
    // ============================================

    function extractTag(raw, tag) {
        const s = String(raw || '');
        const open = new RegExp(`<${escapeRegExp(tag)}>`, 'i');
        const m = open.exec(s);
        if (!m) return { found: false, closed: false, content: '' };
        const start = m.index + m[0].length;
        const closeTag = `</${tag}>`;
        const end = s.indexOf(closeTag, start);
        if (end < 0) return { found: true, closed: false, content: s.slice(start).trim() };
        return { found: true, closed: true, content: s.slice(start, end).trim() };
    }

    /** 宽松 JSON：去代码块、中文引号、尾逗号 */
    function parseLooseJson(text) {
        let t = String(text || '').trim();
        if (!t) return {};
        t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        try {
            return JSON.parse(t);
        } catch (e) {
            /* 继续修 */
        }
        const fixed = t.replace(/,\s*([}\]])/g, '$1');
        try {
            return JSON.parse(fixed);
        } catch (e) {
            /* 继续修 */
        }
        const first = fixed.indexOf('{');
        const last = fixed.lastIndexOf('}');
        if (first >= 0 && last > first) {
            try {
                return JSON.parse(fixed.slice(first, last + 1));
            } catch (e) {
                /* 放弃 */
            }
        }
        throw new Error('JSON 解析失败');
    }

    function parsePatchLines(text) {
        const patches = [];
        const bad = [];
        for (const rawLine of String(text || '').split('\n')) {
            const line = rawLine.trim();
            if (!line || line === '无') continue;
            const m = /^\[?P(\d+)\]?\s*[|｜]\s*(.*?)\s*[|｜]\s*(\+\+|\+|=)([\s\S]*)$/.exec(line);
            if (!m) {
                bad.push(line);
                continue;
            }
            const op = m[3] === '++' ? 'para' : m[3] === '+' ? 'after' : 'replace';
            patches.push({ pid: Number(m[1]), anchor: m[2].trim(), op, text: m[4].trim() });
        }
        return { patches, bad };
    }

    function parseLayerResponse(raw, opts = {}) {
        const errors = [];
        const title = extractTag(raw, 'bt');
        const summary = extractTag(raw, '摘要');
        const patch = extractTag(raw, '补丁');
        const bodyTag = opts.bodyTag || '正文';
        const rewritten = extractTag(raw, opts.translate ? bodyTag : '改写正文');
        const judge = extractTag(raw, '改写判定');
        const alias = extractTag(raw, '称呼');
        const wb = extractTag(raw, '世界书');
        const tb = extractTag(raw, '表格');
        const big = extractTag(raw, '大总结');
        const terms = extractTag(raw, '新术语');

        if (!title.closed) errors.push('缺少 <bt> 标题');
        if (!summary.closed) errors.push('缺少 <摘要>');
        if (opts.translate) {
            if (!rewritten.closed || !rewritten.content) errors.push(`缺少完整的 <${bodyTag}> 译文（或被截断）`);
        } else {
            if (rewritten.found && !rewritten.closed) errors.push('<改写正文> 被截断');
            if (!rewritten.found && !patch.closed) errors.push('缺少 <补丁>（或被截断）');
        }

        let divergence = { triggered: false, rule: '', note: '', resume: false };
        if (judge.closed && judge.content) {
            try {
                const j = parseLooseJson(judge.content);
                divergence = {
                    triggered: j.触发 === true || j.triggered === true,
                    rule: String(j.规则 || j.rule || ''),
                    note: String(j.说明 || j.note || ''),
                    resume: j.回归原文 === true || j.resume === true,
                };
            } catch (e) {
                errors.push('<改写判定> 不是合法 JSON');
            }
        }
        if (!opts.translate && divergence.triggered && !rewritten.closed) errors.push('触发了剧情改写但没有完整的 <改写正文>');

        let worldbook = {};
        if (wb.found) {
            if (!wb.closed) errors.push('<世界书> 被截断');
            else {
                try {
                    worldbook = parseLooseJson(wb.content) || {};
                } catch (e) {
                    errors.push('<世界书> 不是合法 JSON');
                }
            }
        }
        let tableOps = {};
        if (tb.found) {
            if (!tb.closed) errors.push('<表格> 被截断');
            else {
                try {
                    tableOps = parseLooseJson(tb.content) || {};
                } catch (e) {
                    errors.push('<表格> 不是合法 JSON');
                }
            }
        }
        const { patches, bad } = parsePatchLines(patch.content);
        const aliases = alias.closed
            ? uniq(alias.content.split(/[/／、,，\n]/).map((x) => x.trim()).filter((x) => x && x !== '无'))
            : [];

        return {
            ok: errors.length === 0,
            errors,
            title: title.content.replace(/\s+/g, ' ').trim(),
            summary: summary.content,
            patches,
            badPatchLines: bad,
            rewrittenText: rewritten.closed ? rewritten.content : null,
            divergence,
            aliases,
            worldbook,
            tableOps,
            bigSummary: big.closed ? big.content : '',
            terms: terms.closed ? parseGlossaryLines(terms.content) : [],
        };
    }

    // ============================================
    // 应用补丁
    // ============================================

    // 只做一对一的字符替换，保证归一化前后下标一致
    const CHAR_FOLD = {
        '“': '"', '”': '"', '「': '"', '」': '"', '『': '"', '』': '"', '＂': '"',
        '‘': "'", '’': "'",
        '，': ',', '。': '.', '！': '!', '？': '?', '：': ':', '；': ';', '（': '(', '）': ')',
        '　': ' ',
    };
    function fold(s) {
        let out = '';
        for (const ch of s) out += CHAR_FOLD[ch] || ch;
        return out;
    }

    function findUnique(hay, needle) {
        const first = hay.indexOf(needle);
        if (first < 0) return { pos: -1, reason: '锚点不在该段' };
        if (hay.indexOf(needle, first + 1) >= 0) return { pos: -1, reason: '锚点在该段出现多次' };
        return { pos: first };
    }

    function locateAnchor(text, anchor) {
        let r = findUnique(text, anchor);
        if (r.pos >= 0 || r.reason === '锚点在该段出现多次') return r;
        // 引号、全半角标点不一致是最常见的失败原因
        if (fold(text).length === text.length && fold(anchor).length === anchor.length) {
            r = findUnique(fold(text), fold(anchor));
        }
        return r;
    }

    /**
     * 把补丁应用到一层段落上。
     * @returns {{paras: string[], applied: number, failed: Array, addedChars: number}}
     */
    function applyPatches(paras, patches, opts = {}) {
        const maxChars = Number(opts.maxPatchChars) || DEFAULT_SETTINGS.maxPatchChars;
        const byId = new Map(paras.map((p, i) => [p.id, i]));
        const failed = [];
        const edits = paras.map(() => []); // 每段：[{pos, len, insert}]
        const extraParas = paras.map(() => []);
        let addedChars = 0;
        let applied = 0;

        for (const pt of patches) {
            const idx = byId.get(pt.pid);
            if (idx === undefined) {
                failed.push({ patch: pt, reason: '段号不在本层' });
                continue;
            }
            if (!pt.text && pt.op !== 'replace') {
                failed.push({ patch: pt, reason: '补充内容为空' });
                continue;
            }
            if (pt.text.length > maxChars) {
                failed.push({ patch: pt, reason: `补充内容超过 ${maxChars} 字` });
                continue;
            }
            const src = paras[idx].text;
            if (pt.op === 'para') {
                extraParas[idx].push(pt.text);
                addedChars += pt.text.length;
                applied++;
                continue;
            }
            let pos;
            let len = 0;
            if (!pt.anchor) {
                if (pt.op === 'replace') {
                    failed.push({ patch: pt, reason: '替换补丁缺少锚点' });
                    continue;
                }
                pos = src.length;
            } else {
                const r = locateAnchor(src, pt.anchor);
                if (r.pos < 0) {
                    failed.push({ patch: pt, reason: r.reason });
                    continue;
                }
                if (pt.op === 'after') pos = r.pos + pt.anchor.length;
                else {
                    pos = r.pos;
                    len = pt.anchor.length;
                }
            }
            const overlap = edits[idx].some((e) => (len > 0 ? pos < e.pos + e.len && e.pos < pos + len : e.len > 0 && pos > e.pos && pos < e.pos + e.len));
            if (overlap) {
                failed.push({ patch: pt, reason: '与同段另一条补丁重叠' });
                continue;
            }
            edits[idx].push({ pos, len, insert: pt.text });
            addedChars += pt.text.length - len;
            applied++;
        }

        const out = [];
        paras.forEach((p, i) => {
            let t = p.text;
            // 从后往前改，前面的下标不受影响；同一位置按出现顺序
            const list = edits[i].map((e, k) => ({ ...e, k })).sort((a, b) => b.pos - a.pos || b.k - a.k);
            for (const e of list) t = t.slice(0, e.pos) + e.insert + t.slice(e.pos + e.len);
            out.push(t);
            out.push(...extraParas[i]);
        });
        return { paras: out, applied, failed, addedChars };
    }

    // ============================================
    // 称呼
    // ============================================

    function mergeAliases(current, incoming, opts = {}) {
        const black = new Set((opts.blacklist || []).map((x) => String(x).trim()));
        const name = opts.protagonistName || '';
        const out = uniq([...(current || []), ...(incoming || [])]).filter((a) => a && !black.has(a) && a.length <= 12 && a !== opts.target);
        if (name && !out.includes(name)) out.unshift(name);
        return out;
    }

    /** 长的先换，避免「阿诺斯·沃勒迪戈」被「阿诺斯」先截掉一半 */
    function applyAliases(text, aliases, target) {
        const list = uniq(aliases || []).filter((a) => a !== target).sort((a, b) => b.length - a.length);
        if (!list.length || !target || !text) return text;
        const re = new RegExp(list.map(escapeRegExp).join('|'), 'g');
        return String(text).replace(re, target);
    }

    function aliasTargetOf(settings) {
        if (settings.useUserMacro) return '{{user}}';
        if (settings.aliasMode === 'custom') return settings.aliasTarget || '{{user}}';
        if (settings.aliasMode === 'persona') return settings.personaName || '{{user}}';
        return '{{user}}';
    }

    // ============================================
    // 世界书
    // ============================================

    function selectRelevantEntries(wb, text, budgetChars) {
        const hits = [];
        for (const [category, items] of Object.entries(wb || {})) {
            for (const [name, entry] of Object.entries(items || {})) {
                const keys = uniq([name, ...(entry.关键词 || [])]);
                let count = 0;
                for (const k of keys) {
                    if (k.length < 2) continue;
                    let pos = text.indexOf(k);
                    while (pos >= 0 && count < 50) {
                        count++;
                        pos = text.indexOf(k, pos + k.length);
                    }
                }
                if (count > 0) hits.push({ category, name, entry, count });
            }
        }
        hits.sort((a, b) => b.count - a.count);
        const out = [];
        let used = 0;
        const budget = Number(budgetChars) || DEFAULT_SETTINGS.worldbookContextChars;
        for (const h of hits) {
            const size = String(h.entry.内容 || '').length + 40;
            if (used + size > budget && out.length) continue;
            out.push(h);
            used += size;
        }
        return out;
    }

    function findEntryByKey(wb, category, name, keys) {
        const items = wb[category] || {};
        if (items[name]) return name;
        const want = new Set([name, ...keys]);
        for (const [n, e] of Object.entries(items)) {
            const ks = [n, ...(e.关键词 || [])];
            if (ks.some((k) => want.has(k))) return n;
        }
        return null;
    }

    /**
     * 合并 AI 给的世界书增量。
     * providedNames：本次请求里提供给 AI 的条目（"分类/名称"），这些条目 AI 已经看过全文，
     * 输出的是完整新内容，直接替换；没看过的条目只能追加，免得覆盖掉旧信息。
     */
    function mergeWorldbook(wb, delta, opts = {}) {
        const out = clone(wb || {});
        const provided = opts.providedNames || new Set();
        const allowed = opts.categories ? new Set(opts.categories) : null;
        const log = [];
        for (const [category, items] of Object.entries(delta || {})) {
            if (!items || typeof items !== 'object' || Array.isArray(items)) continue;
            if (allowed && !allowed.has(category)) {
                log.push({ type: 'skip', category, reason: '分类未启用' });
                continue;
            }
            out[category] = out[category] || {};
            for (const [rawName, item] of Object.entries(items)) {
                if (!item || typeof item !== 'object') continue;
                const name = String(rawName).trim();
                const keys = uniq(Array.isArray(item.关键词) ? item.关键词 : item.关键词 ? [item.关键词] : []);
                const content = String(item.内容 || '').trim();
                if (!name || !content) continue;
                const existing = findEntryByKey(out, category, name, keys);
                const role = String(item.定位 || '').trim();
                if (!existing) {
                    out[category][name] = { 关键词: uniq([name, ...keys]), 内容: content };
                    if (role) out[category][name].定位 = role;
                    log.push({ type: 'add', category, name });
                    continue;
                }
                const e = out[category][existing];
                e.关键词 = uniq([...(e.关键词 || []), name, ...keys]);
                if (role) e.定位 = role;
                if (provided.has(`${category}/${existing}`)) {
                    e.内容 = content;
                    log.push({ type: 'replace', category, name: existing });
                } else if (!e.内容.includes(content)) {
                    e.内容 = `${e.内容}\n\n${content}`;
                    log.push({ type: 'append', category, name: existing });
                }
            }
        }
        return { worldbook: out, log };
    }

    function makeWorldEntry(uid, fields) {
        return {
            uid,
            key: fields.key || [],
            keysecondary: [],
            comment: fields.comment || '',
            content: fields.content || '',
            constant: !!fields.constant,
            vectorized: false,
            selective: !fields.constant,
            selectiveLogic: 0,
            addMemo: true,
            order: fields.order ?? 100,
            position: fields.position ?? 0,
            disable: false,
            ignoreBudget: false,
            excludeRecursion: true,
            preventRecursion: true,
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: fields.depth ?? 4,
            outletName: '',
            group: fields.group || '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: null,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            triggers: [],
            displayIndex: uid,
        };
    }

    /**
     * 转成酒馆世界书文件格式（{entries: {uid: entry}}），称呼替换在这里做。
     * 条目注释沿用「TXT转世界书」的「分类 - 名称」，两边导出的条目可以混用。
     */
    function worldbookToST(wb, opts = {}) {
        const cats = opts.categories || DEFAULT_WORLDBOOK_CATEGORIES;
        const constantOf = (c) => !!(cats.find((x) => x.name === c) || {}).constant;
        const conv = (s) => (opts.aliases ? applyAliases(s, opts.aliases, opts.target) : s);
        const entries = {};
        let uid = 0;
        for (const [category, items] of Object.entries(wb || {})) {
            for (const [name, item] of Object.entries(items || {})) {
                const shown = conv(name);
                entries[uid] = makeWorldEntry(uid, {
                    key: uniq((item.关键词 || []).map(conv)),
                    comment: `${category} - ${shown}`,
                    content: conv(item.内容 || ''),
                    constant: constantOf(category),
                    group: `${category}_${shown}`,
                });
                uid++;
            }
        }
        for (const p of opts.plotEntries || []) {
            entries[uid] = makeWorldEntry(uid, {
                key: uniq((p.keys || []).map(conv)),
                comment: `剧情 - ${conv(p.title)}`,
                content: conv(p.content),
                constant: false,
                order: 50,
            });
            uid++;
        }
        return { entries };
    }

    // ============================================
    // 记忆表格（st-memory-enhancement）
    // ============================================

    /**
     * 读取表格插件导出的模板。支持：完整设置导出（tableStructure）、
     * 纯数组、{tables: [...]}。只保留启用的表，按插件的规则重新编号。
     */
    function parseTableTemplate(json) {
        let list = null;
        if (Array.isArray(json)) list = json;
        else if (json && Array.isArray(json.tableStructure)) list = json.tableStructure;
        else if (json && Array.isArray(json.tables)) list = json.tables;
        if (!list) throw new Error('不是记忆表格模板（找不到 tableStructure）');
        // 记忆插件 ext_getAllTables() 的结果：{name, data: [表头, ...行]}
        list = list.map((t) => (t && !Array.isArray(t.columns) && Array.isArray(t.data) && Array.isArray(t.data[0]) ? { tableName: t.name, columns: t.data[0] } : t));
        const tables = list
            .filter((t) => t && t.enable !== false && Array.isArray(t.columns) && t.columns.some((c) => c))
            .map((t, i) => ({
                index: i,
                name: String(t.tableName || t.name || `表${i}`),
                columns: t.columns.map((c) => String(c ?? '')),
                note: t.note || '',
                initNode: t.initNode || '',
                insertNode: t.insertNode || '',
                updateNode: t.updateNode || '',
                deleteNode: t.deleteNode || '',
            }));
        return { tables };
    }

    function createTableState(template) {
        return { template, rows: template.tables.map(() => []) };
    }

    function cleanCell(v) {
        return String(v ?? '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/,/g, '，')
            .replace(/["“”]/g, '')
            .replace(/-{2,}/g, '—')
            .trim();
    }

    function tablesForPrompt(state, text, settings) {
        const t = state.tables;
        if (!t) return '（无）';
        const roles = { ...DEFAULT_TABLE_ROLES, ...(settings.tableRoles || {}) };
        const maxRows = Number(settings.tableContextRows) || 30;
        const lines = [];
        t.template.tables.forEach((tb, i) => {
            if (tb.name === roles.summaryTable) {
                lines.push(`[${tb.name}] 已有 ${t.rows[i].length} 行（不需要输出）`);
                return;
            }
            let rows = t.rows[i];
            if (roles.appendOnly.includes(tb.name)) rows = rows.slice(-5);
            else if (!roles.singleRow.includes(tb.name)) rows = rows.filter((r) => r[0] && text.includes(r[0])).slice(0, maxRows);
            lines.push(`[${tb.name}] ${tb.columns.join(',')}`);
            if (!rows.length) lines.push('（无相关行）');
            for (const r of rows) lines.push(r.join(','));
        });
        return lines.join('\n');
    }

    function normalizeOpName(op) {
        const s = String(op || '').trim().toLowerCase();
        if (['删除', 'delete', 'del', 'remove'].includes(s)) return 'delete';
        if (['插入', 'insert', 'add', '新增'].includes(s)) return 'insert';
        return 'upsert';
    }

    function dataToCols(table, data) {
        const cols = {};
        if (!data || typeof data !== 'object') return cols;
        for (const [k, v] of Object.entries(data)) {
            let ci = table.columns.indexOf(k);
            if (ci < 0 && /^\d+$/.test(k)) ci = Number(k);
            if (ci < 0) ci = table.columns.findIndex((c) => c && (c.includes(k) || k.includes(c)));
            if (ci >= 0 && ci < table.columns.length) cols[ci] = cleanCell(v);
        }
        return cols;
    }

    /**
     * 把 AI 的表格操作换算成插件指令。
     * 插件执行顺序是：先全部 update，再全部 insert（追加到末尾），最后 delete（行号从大到小）。
     * 所以这里 update/delete 的行号一律按本层开始前的表格计算。
     */
    function planTableActions(state, ops, opts = {}) {
        const t = state.tables;
        const roles = { ...DEFAULT_TABLE_ROLES, ...(opts.roles || {}) };
        const actions = [];
        const log = [];
        if (!t) return { actions, log };
        const byName = new Map(t.template.tables.map((tb) => [tb.name, tb]));
        const updated = new Map(); // tableIndex -> Map(rowIndex -> action)
        const inserted = new Map(); // tableIndex -> Map(key -> action)
        const deleted = new Set();

        const findTable = (name) => {
            if (byName.has(name)) return byName.get(name);
            return t.template.tables.find((tb) => tb.name.includes(name) || name.includes(tb.name)) || null;
        };

        for (const [tname, list] of Object.entries(ops || {})) {
            const tb = findTable(tname);
            if (!tb) {
                log.push(`未知表格：${tname}`);
                continue;
            }
            if (tb.name === roles.summaryTable) {
                log.push(`忽略「${tb.name}」：由程序控制`);
                continue;
            }
            const rows = t.rows[tb.index];
            const single = roles.singleRow.includes(tb.name);
            const appendOnly = roles.appendOnly.includes(tb.name);
            for (const op of Array.isArray(list) ? list : [list]) {
                if (!op || typeof op !== 'object') continue;
                const kind = normalizeOpName(op.操作 || op.op || op.action);
                const data = dataToCols(tb, op.数据 || op.data || {});
                const key = cleanCell(op.主键 ?? op.key ?? data[0] ?? '');
                if (kind !== 'delete' && !Object.keys(data).length) continue;

                if (single) {
                    if (rows.length) {
                        const prev = updated.get(tb.index)?.get(0);
                        if (prev) Object.assign(prev.data, data);
                        else {
                            const a = { type: 'update', tableIndex: tb.index, rowIndex: 0, data: { ...data } };
                            actions.push(a);
                            if (!updated.has(tb.index)) updated.set(tb.index, new Map());
                            updated.get(tb.index).set(0, a);
                        }
                        for (let r = rows.length - 1; r >= 1; r--) {
                            const k = `${tb.index}:${r}`;
                            if (!deleted.has(k)) {
                                deleted.add(k);
                                actions.push({ type: 'delete', tableIndex: tb.index, rowIndex: r });
                            }
                        }
                    } else {
                        const prev = inserted.get(tb.index)?.get('__single__');
                        if (prev) Object.assign(prev.data, data);
                        else {
                            const a = { type: 'insert', tableIndex: tb.index, data: { ...data } };
                            actions.push(a);
                            if (!inserted.has(tb.index)) inserted.set(tb.index, new Map());
                            inserted.get(tb.index).set('__single__', a);
                        }
                    }
                    continue;
                }

                if (appendOnly) {
                    if (kind !== 'insert' && kind !== 'upsert') {
                        log.push(`「${tb.name}」只能插入，已忽略${kind === 'delete' ? '删除' : '更新'}`);
                        continue;
                    }
                    actions.push({ type: 'insert', tableIndex: tb.index, data });
                    continue;
                }

                const rowIdx = key ? rows.findIndex((r) => cleanCell(r[0]) === key) : -1;
                if (kind === 'delete') {
                    if (rowIdx < 0) {
                        log.push(`「${tb.name}」找不到要删除的「${key}」`);
                        continue;
                    }
                    const k = `${tb.index}:${rowIdx}`;
                    if (!deleted.has(k)) {
                        deleted.add(k);
                        actions.push({ type: 'delete', tableIndex: tb.index, rowIndex: rowIdx });
                    }
                    continue;
                }
                if (rowIdx >= 0 && kind === 'upsert') {
                    const prev = updated.get(tb.index)?.get(rowIdx);
                    if (prev) Object.assign(prev.data, data);
                    else {
                        const a = { type: 'update', tableIndex: tb.index, rowIndex: rowIdx, data: { ...data } };
                        actions.push(a);
                        if (!updated.has(tb.index)) updated.set(tb.index, new Map());
                        updated.get(tb.index).set(rowIdx, a);
                    }
                    continue;
                }
                if (key && data[0] === undefined) data[0] = key;
                const ik = key || `__${actions.length}`;
                const prev = inserted.get(tb.index)?.get(ik);
                if (prev) Object.assign(prev.data, data);
                else {
                    const a = { type: 'insert', tableIndex: tb.index, data };
                    actions.push(a);
                    if (!inserted.has(tb.index)) inserted.set(tb.index, new Map());
                    inserted.get(tb.index).set(ik, a);
                }
            }
        }

        // 大总结：插入总结，删掉本层开始前的全部事件
        if (opts.bigSummary) {
            const st = byName.get(roles.summaryTable);
            const ev = byName.get(roles.eventTable);
            if (st) actions.push({ type: 'insert', tableIndex: st.index, data: { 0: cleanCell(opts.bigSummary) } });
            if (ev) {
                for (let r = t.rows[ev.index].length - 1; r >= 0; r--) {
                    const k = `${ev.index}:${r}`;
                    if (!deleted.has(k)) {
                        deleted.add(k);
                        actions.push({ type: 'delete', tableIndex: ev.index, rowIndex: r });
                    }
                }
            }
        }
        // 插件插入新行时，没给的列会写成 undefined，这里补成空字符串
        for (const a of actions) {
            if (a.type !== 'insert') continue;
            const w = t.template.tables[a.tableIndex].columns.length;
            for (let c = 0; c < w; c++) if (a.data[c] === undefined) a.data[c] = '';
        }
        return { actions, log };
    }

    /** 按插件的执行规则模拟一遍，得到本层之后的表格 */
    function simulateTableActions(state, actions) {
        const t = state.tables;
        const rows = t.rows.map((r) => r.map((c) => c.slice()));
        const width = (i) => t.template.tables[i].columns.length;
        const prio = { update: 0, insert: 1, delete: 2 };
        const sorted = actions
            .map((a, k) => ({ ...a, k }))
            .sort((a, b) =>
                prio[a.type] === 2 && prio[b.type] === 2 ? b.rowIndex - a.rowIndex : prio[a.type] - prio[b.type] || a.k - b.k,
            );
        for (const a of sorted) {
            const tr = rows[a.tableIndex];
            if (!tr) continue;
            if (a.type === 'update' && a.rowIndex < tr.length) {
                for (const [c, v] of Object.entries(a.data || {})) if (Number(c) < width(a.tableIndex)) tr[a.rowIndex][Number(c)] = v;
            } else if (a.type === 'insert' || a.type === 'update') {
                const row = new Array(width(a.tableIndex)).fill('');
                for (const [c, v] of Object.entries(a.data || {})) if (Number(c) < row.length) row[Number(c)] = v;
                tr.push(row);
            } else if (a.type === 'delete' && a.rowIndex < tr.length) {
                tr.splice(a.rowIndex, 1);
            }
        }
        return { template: t.template, rows };
    }

    function renderTableEdit(actions, conv) {
        if (!actions.length) return '';
        const c = conv || ((x) => x);
        const dataStr = (d) =>
            `{${Object.entries(d || {})
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([k, v]) => `"${k}":"${c(cleanCell(v))}"`)
                .join(', ')}}`;
        const lines = actions.map((a) => {
            if (a.type === 'insert') return `insertRow(${a.tableIndex}, ${dataStr(a.data)})`;
            if (a.type === 'update') return `updateRow(${a.tableIndex}, ${a.rowIndex}, ${dataStr(a.data)})`;
            return `deleteRow(${a.tableIndex}, ${a.rowIndex})`;
        });
        return `<tableEdit>\n<!--\n${lines.join('\n')}\n-->\n</tableEdit>`;
    }

    // ============================================
    // 楼层与导出
    // ============================================

    function buildFloorText(floor, settings) {
        const s = { ...DEFAULT_SETTINGS, ...settings };
        const parts = [];
        const mark = floor.divergenceStart ? '【改写起点】' : floor.divergence ? '【改写中】' : '';
        // 标记放在「：」后面，导出插件按「第X话：」切章时不受影响
        let heading = floor.heading || floor.title;
        if (mark) heading = /[：:]/.test(heading) ? heading.replace(/[：:]/, (c) => c + mark) : mark + heading;
        parts.push(`<${s.titleTag}>\n${heading}\n</${s.titleTag}>`);
        parts.push(`<${s.bodyTag}>\n${floor.body}\n</${s.bodyTag}>`);
        if (s.writeTableEdit && floor.tableEdit) parts.push(floor.tableEdit);
        return parts.join('\n');
    }

    function humanDate(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
    }

    /** 酒馆聊天文件：第一行是元数据，之后每行一条消息 */
    function buildChatArray(floors, opts = {}) {
        const now = opts.date || new Date();
        const charName = opts.charName || '小说';
        const userName = opts.userName || 'User';
        const header = {
            user_name: userName,
            character_name: charName,
            create_date: humanDate(now),
            chat_metadata: opts.chatMetadata || {},
        };
        const msgs = floors.map((f, i) => ({
            name: charName,
            is_user: false,
            is_system: false,
            send_date: humanDate(new Date(now.getTime() + i * 1000)),
            mes: f.mes,
            extra: { novel_importer: { layer: f.layer, divergence: f.divergence || false } },
            swipe_id: 0,
            swipes: [f.mes],
            swipe_info: [],
        }));
        return [header, ...msgs];
    }

    function chatToJsonl(arr) {
        return arr.map((x) => JSON.stringify(x)).join('\n');
    }

    /** 角色卡 V2 JSON（可内嵌世界书），供导出分享用 */
    function buildCharacterCard(opts = {}) {
        const data = {
            name: opts.name || '小说',
            description: opts.description || '',
            personality: '',
            scenario: opts.scenario || '',
            first_mes: opts.firstMes || '',
            mes_example: '',
            creator_notes: opts.creatorNotes || '由小说导入改写模块生成',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['小说导入'],
            creator: '',
            character_version: '1.0',
            extensions: { talkativeness: '0.5', fav: false, world: opts.worldName || '', depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        };
        if (opts.worldbook) {
            data.character_book = {
                name: opts.worldName || data.name,
                entries: Object.values(opts.worldbook.entries || {}).map((e, i) => ({
                    id: i,
                    keys: e.key,
                    secondary_keys: [],
                    comment: e.comment,
                    content: e.content,
                    constant: e.constant,
                    selective: e.selective,
                    insertion_order: e.order,
                    enabled: !e.disable,
                    position: e.position === 1 ? 'after_char' : 'before_char',
                    extensions: { position: e.position, depth: e.depth, probability: 100, useProbability: true, exclude_recursion: true, prevent_recursion: true },
                })),
            };
        }
        return { spec: 'chara_card_v2', spec_version: '2.0', ...data, data };
    }

    // ============================================
    // 运行引擎
    // ============================================

    /**
     * @param {object} cfg
     *   settings        配置
     *   callModel       async (messages, {layer, attempt}) => string
     *   messageChain    消息链（可选）
     *   tableTemplate   parseTableTemplate 的结果（可选）
     *   seedWorldbook   已有世界书（内部格式，可选）
     *   onEvent         (type, payload) => void
     */
    function createEngine(cfg) {
        const settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
        settings.tableRoles = { ...DEFAULT_TABLE_ROLES, ...(settings.tableRoles || {}) };
        const emit = (type, payload) => {
            try {
                cfg.onEvent && cfg.onEvent(type, payload);
            } catch (e) {
                /* 界面异常不影响运行 */
            }
        };

        const E = {
            settings,
            layers: [],
            results: [], // 每层：{status, raw, parsed, finalParas, tableActions, ...}
            stats: { cleanedLines: 0, repeatedLines: 0, inlineAds: 0, emptyChapters: [], inputTokens: 0, outputTokens: 0 },
            running: false,
            pauseRequested: false,
            stopRequested: false,
            reviewing: null, // 正在等待审阅的层号
        };

        function initialState() {
            return {
                aliases: mergeAliases(settings.protagonistAliases, [], {
                    protagonistName: settings.protagonistName,
                    blacklist: settings.aliasBlacklist,
                    target: aliasTargetOf(settings),
                }),
                worldbook: clone(cfg.seedWorldbook || {}),
                tables: settings.tablesEnabled && cfg.tableTemplate ? createTableState(cfg.tableTemplate) : null,
                divergence: { active: false, startLayer: -1, notes: [] },
                summaries: [],
                glossary: normalizeGlossary(cfg.seedGlossary),
            };
        }

        /** 用已完成的层从头重放出状态。确定性的，不调 AI。 */
        // replay 的中间状态缓存：cache[k] 是合并完前 k 层后的状态，refs[k-1] 记下当时用的是哪个结果对象。
        // 某层结果被替换（重做、重跑、恢复任务）或设置变了，从那里往后重新算，免得上千层时每层都从头算一遍。
        const replayCache = { sig: '', states: [], refs: [] };

        function replay(upTo) {
            const sig = JSON.stringify(settings) + '|' + E.layers.length;
            if (replayCache.sig !== sig || replayCache.tpl !== cfg.tableTemplate || replayCache.seed !== cfg.seedWorldbook || replayCache.gloss !== cfg.seedGlossary) {
                Object.assign(replayCache, { sig, tpl: cfg.tableTemplate, seed: cfg.seedWorldbook, gloss: cfg.seedGlossary, states: [], refs: [] });
            }
            let k = 0;
            const max = Math.min(upTo, replayCache.states.length - 1);
            while (k < max && replayCache.refs[k] === E.results[k]) k++;
            if (k === upTo && k > 0) return replayCache.states[k];
            let st = k > 0 ? replayCache.states[k] : initialState();
            if (k < replayCache.refs.length && replayCache.refs[k] !== E.results[k]) {
                replayCache.states.length = k + 1;
                replayCache.refs.length = k;
            }
            replayCache.states[k] = st;
            for (let i = k; i < upTo; i++) {
                const r = E.results[i];
                if (!r || r.status !== 'done') break;
                st = commit(st, i, r).state;
                replayCache.refs[i] = r;
                replayCache.states[i + 1] = st;
            }
            return st;
        }

        function eventRowsOf(st) {
            if (!st.tables) return [];
            const ev = st.tables.template.tables.find((t) => t.name === settings.tableRoles.eventTable);
            return ev ? st.tables.rows[ev.index] : [];
        }

        function needsBigSummary(st) {
            return !!st.tables && eventRowsOf(st).length >= (Number(settings.tableRoles.summaryThreshold) || 20);
        }

        /** 把一层结果合进状态。返回新状态和本层产物。 */
        function commit(st, i, r) {
            const p = r.parsed;
            const layer = E.layers[i];
            const next = {
                aliases: st.aliases,
                worldbook: st.worldbook,
                tables: st.tables,
                divergence: clone(st.divergence),
                summaries: st.summaries.concat([{ layer: i, title: p.title, summary: p.summary }]),
                glossary: layer.translate && settings.glossaryEnabled ? mergeGlossary(st.glossary, p.terms) : st.glossary,
            };
            next.aliases = mergeAliases(st.aliases, p.aliases, {
                protagonistName: settings.protagonistName,
                blacklist: settings.aliasBlacklist,
                target: aliasTargetOf(settings),
            });
            if (settings.worldbookEnabled) {
                const cats = settings.worldbookCategories.filter((c) => c.enabled !== false).map((c) => c.name);
                next.worldbook = mergeWorldbook(st.worldbook, p.worldbook, {
                    providedNames: new Set(r.providedNames || []),
                    categories: cats,
                }).worldbook;
            }
            let tableActions = [];
            let tableLog = [];
            if (st.tables) {
                const plan = planTableActions(st, p.tableOps, {
                    roles: settings.tableRoles,
                    bigSummary: r.askedBigSummary ? p.bigSummary : '',
                });
                tableActions = plan.actions;
                tableLog = plan.log;
                next.tables = simulateTableActions(st, tableActions);
            }
            const d = next.divergence;
            let divergenceStart = false;
            const useRewrite = !!p.rewrittenText && (d.active || p.divergence.triggered);
            if (!d.active && p.divergence.triggered) {
                d.active = true;
                d.startLayer = i;
                divergenceStart = true;
            }
            if (useRewrite) d.notes.push({ layer: i, note: p.divergence.note || p.divergence.rule || '改写' });
            const inDivergence = d.active;
            if (d.active && p.divergence.resume && !divergenceStart) {
                d.active = false;
            }
            return {
                state: next,
                out: { tableActions, tableLog, divergenceStart, inDivergence: inDivergence || useRewrite, useRewrite, layer },
            };
        }

        function prepare(text) {
            const cleaned = cleanText(text, settings.adPatterns, settings.adRemovePrevLine, settings.chapterRegex, {
                inlinePatterns: settings.inlineAdPatterns,
                repeatLimit: settings.repeatParaLimit,
                repeatMinChars: settings.repeatParaMinChars,
            });
            E.stats.cleanedLines = cleaned.removed;
            E.stats.repeatedLines = cleaned.repeated;
            E.stats.inlineAds = cleaned.inlineRemoved;
            E.stats.emptyChapters = cleaned.emptyChapters;
            const paras = splitParagraphs(cleaned.text);
            E.layers = splitLayers(paras, settings);
            const translate = settings.translateMode === 'on' || (settings.translateMode === 'auto' && detectForeign(cleaned.text));
            E.layers.forEach((l) => (l.translate = translate));
            E.stats.translate = translate;
            E.stats.chapterUnit = detectChapterUnit(E.layers.flatMap((l) => l.chapters || []));
            E.stats.images = (cleaned.text.match(IMAGE_MARKER_RE) || []).length;
            E.results = E.layers.map(() => null);
            emit('prepared', { layers: E.layers.length, removed: cleaned.removed, repeated: cleaned.repeated, inlineAds: cleaned.inlineRemoved, emptyChapters: cleaned.emptyChapters, translate, images: E.stats.images });
            return E.layers;
        }

        function buildRequest(i, st, extra = {}) {
            const layer = E.layers[i];
            const layerText = layer.paras.map((p) => p.text).join('\n');
            const rel = settings.worldbookEnabled ? selectRelevantEntries(st.worldbook, layerText, settings.worldbookContextChars) : [];
            const askBig = needsBigSummary(st);
            const prompt = buildLayerPrompt(layer, settings, st, {
                ...extra,
                needBigSummary: askBig,
                eventRows: askBig ? eventRowsOf(st) : [],
            });
            return {
                prompt,
                messages: applyMessageChain(prompt, cfg.messageChain),
                providedNames: rel.map((x) => `${x.category}/${x.name}`),
                askedBigSummary: askBig,
            };
        }

        async function processLayer(i, extra = {}) {
            const st = replay(i);
            const req = buildRequest(i, st, extra);
            const r = { status: 'running', attempts: 0, providedNames: req.providedNames, askedBigSummary: req.askedBigSummary };
            E.results[i] = r;
            emit('layer-start', { index: i });
            let lastErr = null;
            for (let attempt = 0; attempt <= settings.retries; attempt++) {
                if (E.stopRequested) throw new Error('ABORTED');
                r.attempts = attempt + 1;
                let raw;
                try {
                    raw = await cfg.callModel(req.messages, { layer: i, attempt, prompt: req.prompt });
                } catch (e) {
                    lastErr = e;
                    emit('layer-retry', { index: i, attempt, error: String(e.message || e) });
                    continue;
                }
                const layerNow = E.layers[i];
                const parsed = parseLayerResponse(raw, { translate: !!layerNow.translate, bodyTag: settings.bodyTag });
                E.stats.inputTokens += estimateTokens(req.messages.map((m) => m.content).join('\n'));
                E.stats.outputTokens += estimateTokens(raw);
                if (!parsed.ok) {
                    lastErr = new Error(parsed.errors.join('；'));
                    emit('layer-retry', { index: i, attempt, error: lastErr.message });
                    continue;
                }
                r.raw = raw;
                r.parsed = parsed;
                const layer = E.layers[i];
                const useRewrite = !!parsed.rewrittenText && (layer.translate || st.divergence.active || parsed.divergence.triggered);
                if (useRewrite) {
                    r.finalParas = ensureImageMarkers(layer.paras, splitParagraphs(parsed.rewrittenText));
                    r.patchStats = { applied: 0, failed: [], addedChars: parsed.rewrittenText.length - layer.chars, rewritten: true, translated: !!layer.translate };
                } else {
                    const ap = applyPatches(layer.paras, parsed.patches, { maxPatchChars: settings.maxPatchChars });
                    r.finalParas = ap.paras;
                    r.patchStats = { applied: ap.applied, failed: ap.failed, addedChars: ap.addedChars, rewritten: false };
                }
                const c = commit(st, i, r);
                r.tableActions = c.out.tableActions;
                r.tableLog = c.out.tableLog;
                r.divergenceStart = c.out.divergenceStart;
                r.inDivergence = c.out.inDivergence;
                r.status = 'done';
                emit('layer-done', { index: i, result: r });
                return r;
            }
            r.status = 'failed';
            r.error = String((lastErr && lastErr.message) || lastErr || '未知错误');
            emit('layer-failed', { index: i, error: r.error });
            return r;
        }

        function shouldReview(r) {
            if (settings.reviewMode === 'every') return true;
            if (settings.reviewMode === 'divergence' && (r.divergenceStart || r.inDivergence)) return true;
            return false;
        }

        /** 从第一个没完成的层开始跑，直到结束、暂停、失败或需要审阅 */
        async function run() {
            if (E.running) return;
            E.running = true;
            E.pauseRequested = false;
            E.stopRequested = false;
            emit('run-start', {});
            try {
                for (let i = 0; i < E.layers.length; i++) {
                    const r = E.results[i];
                    if (r && r.status === 'done') continue;
                    if (E.reviewing !== null) break;
                    if (E.pauseRequested || E.stopRequested) break;
                    const res = await processLayer(i);
                    if (res.status === 'failed') {
                        emit('run-blocked', { index: i, error: res.error });
                        break;
                    }
                    if (shouldReview(res) || E.pauseAfterCurrent) {
                        E.pauseAfterCurrent = false;
                        E.reviewing = i;
                        emit('review', { index: i, result: res });
                        break;
                    }
                }
            } catch (e) {
                if (e.message !== 'ABORTED') emit('error', { error: String(e.message || e) });
            } finally {
                E.running = false;
                emit('run-end', { done: E.results.filter((r) => r && r.status === 'done').length, total: E.layers.length });
            }
        }

        /** 审阅通过：继续往下跑 */
        function accept() {
            E.reviewing = null;
        }

        /** 审阅不通过：带上修改意见重做这一层（之后的层作废） */
        async function reject(feedback) {
            const i = E.reviewing;
            if (i === null) return null;
            const prev = E.results[i];
            for (let k = i; k < E.results.length; k++) E.results[k] = null;
            const res = await processLayer(i, { feedback, previousRaw: prev && prev.raw });
            E.reviewing = res.status === 'done' ? i : null;
            emit('review', { index: i, result: res });
            return res;
        }

        /** 从第 i 层起全部重跑 */
        function resetFrom(i) {
            for (let k = i; k < E.results.length; k++) E.results[k] = null;
            E.reviewing = null;
        }

        /** 渲染所有已完成的层为楼层（称呼按最终称呼表统一替换） */
        function renderFloors() {
            const done = [];
            for (let i = 0; i < E.layers.length; i++) {
                const r = E.results[i];
                if (!r || r.status !== 'done') break;
                done.push(i);
            }
            const st = replay(done.length);
            const target = aliasTargetOf(settings);
            const conv = (s) => applyAliases(s, st.aliases, target);
            let lastHeading = '';
            return done.map((i) => {
                const r = E.results[i];
                let heading = conv(formatHeading(E.layers[i], r.parsed.title, settings, E.stats.chapterUnit));
                // 原文标题模式下，一章被切成几层时后面的层沿用这一章的标题，免得章号跳成层号
                if (settings.titleMode === 'original' && !(E.layers[i].chapters || []).length && lastHeading) heading = lastHeading.replace(/（续）$/, '') + '（续）';
                lastHeading = heading;
                const floor = {
                    layer: i,
                    title: conv(r.parsed.title),
                    heading,
                    body: conv(r.finalParas.join('\n')),
                    tableEdit: settings.tablesEnabled ? renderTableEdit(r.tableActions || [], conv) : '',
                    divergenceStart: r.divergenceStart,
                    divergence: r.inDivergence,
                };
                floor.mes = buildFloorText(floor, settings);
                return floor;
            });
        }

        function finalState() {
            let n = 0;
            while (n < E.layers.length && E.results[n] && E.results[n].status === 'done') n++;
            return replay(n);
        }

        function exportWorldbook() {
            const st = finalState();
            const target = aliasTargetOf(settings);
            const plot = settings.plotSummaryEntries
                ? st.summaries.map((s) => ({
                      title: `第${s.layer + 1}层 ${s.title}`,
                      keys: [s.title],
                      content: s.summary,
                  }))
                : [];
            return worldbookToST(st.worldbook, {
                categories: settings.worldbookCategories,
                aliases: st.aliases,
                target,
                plotEntries: plot,
            });
        }

        function exportTables() {
            const st = finalState();
            if (!st.tables) return [];
            const target = aliasTargetOf(settings);
            return st.tables.template.tables.map((tb, i) => ({
                name: tb.name,
                data: [tb.columns, ...st.tables.rows[i].map((r) => r.map((c) => applyAliases(c, st.aliases, target)))],
            }));
        }

        /** 主角的人设：优先「定位=主角」的角色条目，其次条目名或关键词等于主角原名 */
        function exportPersona() {
            const st = finalState();
            const target = aliasTargetOf(settings);
            const chars = st.worldbook.角色 || {};
            const name = settings.protagonistName;
            let hit = Object.entries(chars).find(([, e]) => e.定位 === '主角');
            if (!hit && name) hit = Object.entries(chars).find(([n, e]) => n === name || (e.关键词 || []).includes(name));
            if (!hit) return { name: target, description: '' };
            return { name: target, description: applyAliases(hit[1].内容, st.aliases, target) };
        }

        /** 女主列表（人设已写在世界书角色条目里） */
        function listHeroines() {
            const st = finalState();
            return Object.entries(st.worldbook.角色 || {})
                .filter(([, e]) => e.定位 === '女主')
                .map(([n]) => n);
        }

        /** 角色卡简介：所有层跑完后再调一次 AI，用各层摘要生成 */
        function buildCardInfoRequest() {
            const st = finalState();
            const target = aliasTargetOf(settings);
            const conv = (x) => applyAliases(x, st.aliases, target);
            const sums = st.summaries.map((x) => `- 第${x.layer + 1}层 ${conv(x.title)}：${conv(x.summary)}`).join('\n');
            const heroines = listHeroines().map(conv).join('、') || '（无）';
            const prompt = `下面是一部小说已导入部分的分层摘要。主角在聊天里叫「${target}」。请写角色卡信息：
<简介>200 到 400 字的作品简介：世界观、主角处境、主要人物（${heroines}），不剧透结局</简介>
<场景>一句话说明聊天的场景：这是按原著逐层导入的小说正文，${target} 是主角</场景>

## 分层摘要
${sums}`;
            return { prompt, messages: applyMessageChain(prompt, cfg.messageChain) };
        }

        async function generateCardInfo() {
            const req = buildCardInfoRequest();
            const raw = await cfg.callModel(req.messages, { layer: -1, attempt: 0, prompt: req.prompt, purpose: 'card' });
            E.cardInfo = { description: extractTag(raw, '简介').content, scenario: extractTag(raw, '场景').content };
            return E.cardInfo;
        }

        function serialize() {
            return {
                version: VERSION,
                settings,
                layers: E.layers,
                results: E.results,
                stats: E.stats,
                reviewing: E.reviewing,
                cardInfo: E.cardInfo || null,
            };
        }

        function restore(data) {
            if (!data) return;
            E.layers = data.layers || [];
            E.results = (data.results || []).map((r) => (r && r.status === 'running' ? null : r));
            E.stats = data.stats || E.stats;
            E.reviewing = data.reviewing ?? null;
            E.cardInfo = data.cardInfo || null;
        }

        return Object.assign(E, {
            prepare,
            run,
            accept,
            reject,
            resetFrom,
            replay,
            renderFloors,
            finalState,
            exportWorldbook,
            exportTables,
            exportPersona,
            listHeroines,
            buildCardInfoRequest,
            generateCardInfo,
            serialize,
            restore,
            requestPause() {
                E.pauseRequested = true;
            },
            pauseAfterCurrentLayer() {
                E.pauseAfterCurrent = true;
            },
            stop() {
                E.stopRequested = true;
            },
            buildRequestFor(i) {
                return buildRequest(i, replay(i));
            },
        });
    }

    // ============================================
    // 酒馆预设解析（与小说翻译模块同一规则，精简版）
    // ============================================
    const ST_MARKERS = ['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples'];

    function parseTavernPreset(json) {
        if (!json || !Array.isArray(json.prompts)) throw new Error('不是有效的酒馆对话补全预设（缺少 prompts 数组）');
        const byId = {};
        for (const p of json.prompts) if (p && p.identifier) byId[p.identifier] = p;
        let order = null;
        if (Array.isArray(json.prompt_order) && json.prompt_order.length) {
            const global =
                json.prompt_order.find((o) => o.character_id === 100001) ||
                json.prompt_order.slice().sort((a, b) => (b?.order?.length || 0) - (a?.order?.length || 0))[0];
            order = Array.isArray(global && global.order) ? global.order : null;
        }
        if (!order) order = json.prompts.map((p) => ({ identifier: p.identifier, enabled: p.enabled !== false }));
        const chain = [];
        let hasSlot = false;
        for (const item of order) {
            const p = byId[item.identifier];
            if (!p) continue;
            if (p.marker === true || ST_MARKERS.includes(p.identifier)) {
                if (p.identifier === 'chatHistory') {
                    chain.push({ role: 'user', content: '{PROMPT}', enabled: true });
                    hasSlot = true;
                }
                continue;
            }
            const content = (p.content || '').trim();
            if (!content) continue;
            let role = p.role || 'system';
            if (!['system', 'user', 'assistant'].includes(role)) role = 'system';
            chain.push({ role, content, enabled: item.enabled !== false });
        }
        if (!hasSlot) chain.push({ role: 'user', content: '{PROMPT}', enabled: true });
        const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);
        return {
            chain,
            params: {
                temperature: num(json.temperature),
                maxTokens: num(json.openai_max_tokens) ?? num(json.max_tokens),
            },
        };
    }

    /** 读取「TXT转世界书」导出的世界书（酒馆格式或内部格式）作为初始世界书 */
    function importWorldbook(json) {
        if (!json || typeof json !== 'object') return {};
        const entries = json.entries ? (Array.isArray(json.entries) ? json.entries : Object.values(json.entries)) : null;
        if (!entries) return clone(json); // 已经是内部格式
        const out = {};
        for (const e of entries) {
            const comment = String(e.comment || '');
            const m = /^(.+?)\s*-\s*(.+)$/.exec(comment);
            const category = m ? m[1] : '未分类';
            const name = m ? m[2] : comment || (e.key || [])[0] || `条目${e.uid}`;
            out[category] = out[category] || {};
            out[category][name] = { 关键词: uniq(e.key || []), 内容: String(e.content || '') };
        }
        return out;
    }

    root.NovelImporterCore = {
        VERSION,
        DEFAULT_SETTINGS,
        DEFAULT_CHAPTER_REGEX,
        DEFAULT_AD_PATTERNS,
        DEFAULT_INLINE_AD_PATTERNS,
        DEFAULT_REWRITE_PROMPT,
        DEFAULT_DIVERGENCE_RULES,
        DEFAULT_DIVERGENCE_DIRECTION,
        DEFAULT_WORLDBOOK_CATEGORIES,
        DEFAULT_TABLE_ROLES,
        OUTPUT_FORMAT,
        cnToInt,
        parseChapterTitle,
        detectChapterUnit,
        formatHeading,
        detectForeign,
        IMAGE_MARKER_RE,
        ensureImageMarkers,
        condenseMessageTemplate,
        normalizeGlossary,
        mergeGlossary,
        parseGlossaryLines,
        selectGlossary,
        aliasTargetOf,
        cleanCell,
        estimateTokens,
        normalizeText,
        cleanText,
        splitParagraphs,
        splitLayers,
        buildLayerPrompt,
        applyMessageChain,
        extractTag,
        parseLooseJson,
        parsePatchLines,
        parseLayerResponse,
        applyPatches,
        mergeAliases,
        applyAliases,
        selectRelevantEntries,
        mergeWorldbook,
        worldbookToST,
        importWorldbook,
        parseTableTemplate,
        createTableState,
        planTableActions,
        simulateTableActions,
        renderTableEdit,
        buildFloorText,
        buildChatArray,
        chatToJsonl,
        buildCharacterCard,
        parseTavernPreset,
        createEngine,
    };
})(typeof window !== 'undefined' ? window : globalThis);
