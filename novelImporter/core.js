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

    const VERSION = '1.4.46';

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

    /** 勾了「保留分隔线」时，去掉会删「=====」这类分隔线的广告规则 */
    function adPatternsFor(settings) {
        const list = (settings && settings.adPatterns) || [];
        if (!settings || !settings.keepSeparatorLines) return list;
        return list.filter((p) => {
            try {
                return !['=====', '＝＝＝＝＝', '-----', '*****', '~~~~~', '—————'].some((x) => new RegExp(p).test(x));
            } catch (e) {
                return true;
            }
        });
    }

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

    // 世界书分类：字段和「TXT转世界书」的自定义提取分类一样，可以直接互相导入；constant 是本模块加的「常驻（蓝灯）」
    const wbCat = (name, enabled, isBuiltin, entryExample, keywordsExample, contentGuide) => ({
        name,
        enabled,
        isBuiltin,
        entryExample,
        keywordsExample,
        contentGuide,
        defaultPosition: 0,
        defaultDepth: 4,
        defaultOrder: 100,
        autoIncrementOrder: false,
        constant: false,
    });
    const DEFAULT_WORLDBOOK_CATEGORIES = [
        wbCat('角色', true, true, '角色真实姓名', ['真实姓名', '称呼1', '称呼2', '绰号'], '基于原文的角色描述，包含但不限于**名称**:（必须要）、**性别**:、**年龄**:（原文写明才填）、**身份**:、**外貌**:、**性格**:、**能力/境界**:、**与主角关系**:、**重要经历**:、**话语示例**:等（实际嵌套或者排列方式按合理的逻辑）'),
        wbCat('地点', true, true, '地点真实名称', ['地点名', '别称', '俗称'], '基于原文的地点描述，包含但不限于**名称**:（必须要）、**位置**:、**特征**:、**重要事件**:等（实际嵌套或者排列方式按合理的逻辑）'),
        wbCat('组织', true, true, '组织真实名称', ['组织名', '简称', '代号'], '基于原文的组织描述，包含但不限于**名称**:（必须要）、**性质**:、**成员**:、**目标**:等（实际嵌套或者排列方式按合理的逻辑）'),
        wbCat('设定', true, false, '设定名称', ['设定名', '别称'], '世界规则、修炼体系、境界划分、特殊名词的解释，包含但不限于**名称**:、**说明**:、**相关角色或势力**:等'),
        wbCat('道具', false, false, '道具名称', ['道具名', '别名'], '基于原文的道具描述，包含但不限于**名称**:、**类型**:、**功能**:、**来源**:、**持有者**:等'),
        wbCat('玩法', false, false, '玩法名称', ['玩法名', '规则名'], '基于原文的玩法/规则描述，包含但不限于**名称**:、**规则说明**:、**参与条件**:、**奖惩机制**:等'),
        wbCat('章节剧情', false, false, '第X章', ['章节名', '章节号'], '该章节的剧情概要，包含但不限于**章节标题**:、**主要事件**:、**出场角色**:、**关键转折**:、**伏笔线索**:等'),
        wbCat('角色内心', false, false, '角色名-内心世界', ['角色名', '内心', '心理'], '角色的内心想法和心理活动，包含但不限于**原文内容**:、**内心独白**:、**情感变化**:、**动机分析**:、**心理矛盾**:等'),
    ];

    /** 统一成 TXT转世界书的分类格式；旧版本模块的 {name, enabled, constant, guide} 也认 */
    function normalizeCategory(c) {
        const name = String((c && c.name) || '').trim();
        const kw = Array.isArray(c.keywordsExample) ? c.keywordsExample : String(c.keywordsExample || '').split(/[,，]/);
        const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
        return {
            name,
            enabled: c.enabled !== false,
            isBuiltin: !!c.isBuiltin,
            entryExample: String(c.entryExample || `${name}名称`),
            keywordsExample: kw.map((k) => String(k).trim()).filter(Boolean).length ? kw.map((k) => String(k).trim()).filter(Boolean) : [`${name}名`],
            contentGuide: String(c.contentGuide ?? c.guide ?? `基于原文的${name}描述`),
            defaultPosition: num(c.defaultPosition, 0),
            defaultDepth: num(c.defaultDepth, 4),
            defaultOrder: num(c.defaultOrder, 100),
            autoIncrementOrder: !!c.autoIncrementOrder,
            constant: !!c.constant,
        };
    }

    function normalizeCategories(list) {
        const seen = new Set();
        return (Array.isArray(list) ? list : []).map(normalizeCategory).filter((c) => c.name && !seen.has(c.name) && seen.add(c.name));
    }

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

    // 每层回复的输出格式（设置里可以改，清空或点「恢复默认」回到这里）
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

    // 放在输出格式后面的 JSON 写法提醒
    const JSON_REMINDER = `<改写判定>、<世界书>、<表格> 里必须是能被 JSON.parse 解析的合法 JSON：键和字符串一律用英文双引号 "，字符串里要用引号就写成 \\" 或改用「」，字符串里不要直接回车（换行写 \\n），不要注释、尾逗号、代码块标记。`;

    const DEFAULT_SETTINGS = {
        // 分层
        layerChars: 15000,
        alignToChapter: true,
        chapterRegex: DEFAULT_CHAPTER_REGEX,
        adPatterns: DEFAULT_AD_PATTERNS.slice(),
        keepSeparatorLines: false, // 保留「=====」这类分隔线（不按广告行删）
        adRemovePrevLine: true,
        inlineAdPatterns: DEFAULT_INLINE_AD_PATTERNS.slice(),
        // 全书出现这么多次以上的长段落当作盗版站塞的垃圾段删掉，0 为不删
        repeatParaLimit: 3,
        repeatParaMinChars: 12,
        // 用户在「清掉的内容」里点了保留的段落，分层时不删
        cleanKeep: [],

        // 改写
        expansionRatio: 10,
        rewritePrompt: DEFAULT_REWRITE_PROMPT,
        outputFormat: OUTPUT_FORMAT,
        jsonReminder: JSON_REMINDER,
        maxPatchChars: 120,
        extraRules: '',
        // 酒馆里开着的世界书当作输出要求发给 AI；stWorldExclude 是取消勾选的书名
        stWorldEnabled: false,
        stWorldExclude: [],
        stWorldEntryExclude: [], // 单独关掉的条目：「书名::uid」

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
        aliasReplaceBy: 'ai', // ai：让 AI 输出时按语境把主角写成 {{user}}；text：导出时按已知称呼直接替换
        personaName: '',
        useUserMacro: false,

        // 标签与标题
        titleTag: 'bt',
        floorTags: '',
        floorTagsBefore: '', // 额外放在标题和正文之间的标签，逗号分隔
        wordReplace: '', // 词语替换：每行「原词 → 新词」
        wordReplaceMode: 'ai', // ai：写进提示词让 AI 输出时按语境换；text：导出和导入酒馆时按文字直接换 // 额外放进楼层的标签：从 AI 原始回复里取，放在正文后面，逗号分隔
        bodyTag: '正文',
        titleMode: 'ai', // ai：AI 起标题；original：用原文章节标题
        titleFormat: '#第{n}{unit}：{title}',
        chapterUnit: 'auto', // auto：按原文判断；章；话

        // 翻译：auto 时原文大部分不是中文就整层翻译成简体中文
        translateMode: 'auto',
        importHighlight: 'off', // 导入酒馆时标出 AI 补充/改写的字（聊天记录导出成 EPUB 时带上）：off；mark：黄底；color：彩色字
        imageMode: 'bbi', // bbi：柏宝绘格式（聊天记录导出能打进 EPUB）；img：直接 <img>；off：不导入插图
        tableMessageTemplate: '', // 记忆插件设置里的「消息模板」，从插件读取或手填
        useMessageTemplate: true,
        glossaryEnabled: true, // 翻译时用术语表统一人名地名（只发给 AI，不进正文）
        glossaryMax: 300, // 每层最多带多少条（只带本层原文里出现的）
        writeTableEdit: true,

        // 世界书
        worldbookEnabled: true,
        worldbookCategories: DEFAULT_WORLDBOOK_CATEGORIES.map((c) => ({ ...c, keywordsExample: c.keywordsExample.slice() })),
        worldbookPrompt: '',
        worldbookContextChars: 6000,
        plotSummaryEntries: true,
        // 每层 <摘要> 的写法；摘要导出为「剧情」条目，也用作前情提要和角色卡简介
        summaryGuide: '本层剧情摘要，100 到 200 字，写清楚谁做了什么',
        // 承接上一层：带上一层正文最后多少字（0 不带），以及上一层回复里哪些标签原样一起发（逗号分隔）
        prevTailChars: 300,
        carryTags: '',
        plotPosition: 0,
        plotDepth: 4,
        plotOrder: 50,

        // 表格
        tablesEnabled: true,
        tableRoles: { ...DEFAULT_TABLE_ROLES },
        tablePrompt: '',
        tableContextRows: 30,
        tableContextAll: false, // 每层把表格的行全部发给 AI（不只发本层提到的）

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

    /** 高亮标记换成 HTML（每行单独闭合，免得跨段的标签被酒馆拆坏） */
    function marksToHtml(text, mode) {
        const [open, close] = mode === 'color' ? ['<span style="color:#e67e22">', '</span>'] : ['<mark>', '</mark>'];
        let on = false;
        return String(text || '')
            .split('\n')
            .map((line) => {
                let out = on ? open : '';
                for (const ch of line) {
                    if (ch === MARK_OPEN) {
                        if (!on) out += open;
                        on = true;
                    } else if (ch === MARK_CLOSE) {
                        if (on) out += close;
                        on = false;
                    } else out += ch;
                }
                if (on) out += close;
                return out.replace(new RegExp(escapeRegExp(open) + escapeRegExp(close), 'g'), '');
            })
            .join('\n');
    }

    // 正文里常见的排版标签，不算「别的标签」
    const INLINE_TAGS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'font', 'ruby', 'rt', 'rp', 'sup', 'sub', 'small', 'big', 'center', 'p', 'br', 'mark', 'q']);
    // 插件自己的协议标签：夹在正文里的直接丢掉（表格由程序按 <表格> 生成 tableEdit，留着会重复插入）
    const PROTOCOL_TAGS = new Set(['bt', '摘要', '补丁', '改写判定', '称呼', '世界书', '表格', '新术语', '主角', '大总结', '改写正文', '正文', 'tableedit', '上一层结尾', '原文']);

    /**
     * AI 有时把别的标签（状态栏、Calculated_data 之类）写进 <正文> 里。
     * 独占行的 <X>…</X> 整块拿出来：协议标签丢掉，其余放到正文后面（extras）。
     */
    function splitBodyBlocks(text, bodyTag) {
        const extras = [];
        const re = /^[ \t\uE000\uE001]*<([^<>\/\s][^<>\/]{0,40}?)>[\s\S]*?<\/\1>[ \t\uE000\uE001]*$/gm;
        const body = String(text || '').replace(re, (m, tag) => {
            const name = String(tag).trim().toLowerCase();
            if (INLINE_TAGS.has(name)) return m;
            if (!PROTOCOL_TAGS.has(name) && name !== String(bodyTag || '').toLowerCase()) extras.push(m.trim());
            return '';
        });
        return { body: body.replace(/\n{3,}/g, '\n\n'), extras };
    }

    // 只有符号的分隔线（---、***、=====）
    const SEPARATOR_RE = /^(?:[-=*_~—－＝]\s*){3,}$/;

    /**
     * 分隔线在 Markdown 里紧跟在文字下面会把上一行变成大标题（---、=== 是标题下划线），
     * 前面空一行就成了普通分隔线；紧挨着章节标题或在开头结尾的分隔线没用，去掉。
     */
    function fixSeparators(lines, titleTag) {
        const isSep = (l) => SEPARATOR_RE.test(stripMarks(l).trim());
        const out = [];
        for (let k = 0; k < lines.length; k++) {
            if (!isSep(lines[k])) {
                out.push(lines[k]);
                continue;
            }
            let n = k + 1;
            while (n < lines.length && isSep(lines[n])) n++;
            const next = n < lines.length ? stripMarks(lines[n]).trim() : '';
            if (!out.length || !next || next.startsWith(`<${titleTag || 'bt'}>`)) continue;
            if (out[out.length - 1] !== '') out.push('');
            out.push(lines[k]);
        }
        return out;
    }

    /**
     * 正文里独占一行的章节标题（第X章/第X话 标题）改成和楼层标题一样的 <bt>#第X章：标题</bt>。
     * opts.dropFirst：楼层标题就是取的本层第一个章节标题时，正文开头那行重复了，去掉。
     * 行里可以带高亮标记，判断时忽略。
     */
    function formatBodyHeadings(paras, settings, bookUnit, opts = {}) {
        const s = { ...DEFAULT_SETTINGS, ...settings };
        const fmt = s.titleFormat || '#第{n}{unit}：{title}';
        const re = new RegExp(`^第\\s*[${CN_NUM}]+\\s*[章话話回节節]`);
        const out = [];
        let first = true;
        for (const line of paras) {
            // AI 有时把标题写成 **第二话 xxx** 或 ## 第二话，先去掉 Markdown 记号再判断
            const t = stripMarks(line).trim().replace(/^(?:#+\s*|[*_]{1,3})|[*_]{1,3}$/g, '').trim();
            // 「第3话说的是……」这种句子不算：章号后面要有空格/冒号，或者整行很短又没有句读
            const m = t && t.length <= 40 ? re.exec(t) : null;
            const rest = m ? t.slice(m[0].length) : '';
            const ok = m && (!rest || /^[\s：:、.．\-—]/.test(rest) || (t.length <= 20 && !/[。，！？…“”「」,!?]/.test(rest)));
            const p = ok ? parseChapterTitle(t) : null;
            const wasFirst = first;
            if (t && !SEPARATOR_RE.test(t)) first = false;
            if (!p) {
                out.push(line);
                continue;
            }
            if (wasFirst && opts.dropFirst) continue;
            const unit = s.chapterUnit === '章' || s.chapterUnit === '话' ? s.chapterUnit : p.unit || bookUnit || '章';
            let h = fmt.replace(/\{n\}/g, String(p.num)).replace(/\{unit\}/g, unit).replace(/\{title\}/g, p.title);
            if (!p.title) h = h.replace(/[：:]\s*$/, '');
            out.push(`<${s.titleTag}>\n${h}\n</${s.titleTag}>`);
        }
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

    /** 这些开头的行是对话，正文里同一句台词重复很正常，不当垃圾段 */
    const REPEAT_EXEMPT = /^[「『“"‘]/;

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
        // 清掉了什么都记下来，方便用户核对有没有删错（每类最多记 LOG_MAX 条）
        const LOG_MAX = 3000;
        const log = { ads: [], inline: [], repeated: [] };
        const push = (list, item) => list.length < LOG_MAX && list.push(item);
        // 用户点了「保留」的段落：不当广告、不当垃圾段
        const keepKey = (l) => String(l || '').replace(/[\s\u3000]/g, '');
        const keep = new Set((opts.keepLines || []).map(keepKey).filter(Boolean));
        const isKept = (l) => keep.size > 0 && keep.has(keepKey(l));
        let chap = '';
        const track = (l) => {
            if (protect && l && isChapterTitle(l, protect)) chap = l;
        };
        if (inline.length) {
            lines = lines.map((line) => {
                track(line);
                let l = line;
                for (const r of inline) {
                    r.lastIndex = 0;
                    l = l.replace(r, (m) => (inlineRemoved++, push(log.inline, { chapter: chap, text: m, line }), ''));
                }
                return l === line ? line : l.trim();
            });
        }

        // 盗版源常把整章换成同一段垃圾文字反复出现，按全书重复次数删掉
        let repeated = 0;
        const limit = Number(opts.repeatLimit) || 0;
        if (limit > 0) {
            const minChars = Math.max(4, Number(opts.repeatMinChars) || 12);
            const key = keepKey;
            // 对话（「」“”开头）、分隔线这类没有文字的行在正文里本来就会重复，不算垃圾段
            const candidate = (l) => {
                const k = key(l);
                return k.length >= minChars && !(protect && protect.test(l)) && !isKept(l) && !REPEAT_EXEMPT.test(k) && /[\p{L}\p{N}]/u.test(k);
            };
            const count = new Map();
            for (const l of lines) {
                if (candidate(l)) count.set(key(l), (count.get(key(l)) || 0) + 1);
            }
            // 按章统计：一章里大半都是垃圾段时，剩下的零星几行也一并删掉
            const isJunk = (l) => candidate(l) && (count.get(key(l)) || 0) >= limit;
            const kept = [];
            let chapter = [];
            let title = '';
            const seen = new Map();
            const flush = () => {
                const total = chapter.reduce((n, l) => n + l.length, 0);
                const junk = chapter.reduce((n, l) => n + (isJunk(l) ? l.length : 0), 0);
                const dropAll = total > 0 && junk / total >= 0.6;
                for (const l of chapter) {
                    if (l && !isKept(l) && (dropAll || isJunk(l))) {
                        repeated++;
                        // 同一段只记一次，记下出现的次数和第一次所在的章
                        const k = key(l);
                        const hit = seen.get(k);
                        if (hit) hit.count++;
                        else if (log.repeated.length < LOG_MAX) {
                            const item = { chapter: title, text: l, count: 1, reason: isJunk(l) ? 'repeat' : 'chapter' };
                            seen.set(k, item);
                            log.repeated.push(item);
                        }
                    } else kept.push(l);
                }
                chapter = [];
            };
            for (const l of lines) {
                if (protect && isChapterTitle(l, protect)) {
                    flush();
                    title = l;
                    kept.push(l);
                } else chapter.push(l);
            }
            flush();
            lines = kept;
        }

        const out = [];
        chap = '';
        for (const line of lines) {
            track(line);
            if (line && !isKept(line) && regs.some((r) => r.test(line))) {
                removed++;
                let prev = '';
                if (removePrev) {
                    // 回退到上一条非空行
                    let k = out.length - 1;
                    while (k >= 0 && !out[k]) k--;
                    if (k >= 0 && out[k].length <= 40 && !isKept(out[k]) && !SENTENCE_END.test(out[k]) && !regs.some((r) => r.test(out[k])) && !(protect && protect.test(out[k]))) {
                        prev = out[k];
                        out.splice(k, 1);
                        removed++;
                    }
                }
                push(log.ads, { chapter: chap, text: line, prev });
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
        return { text: result.join('\n'), removed, repeated, inlineRemoved, emptyChapters, log };
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


    const PATCH_RULES = `## 补丁规则
- 锚点必须从该段原文中**原样复制**一小段（5 到 15 个字），并且在该段里只出现一次
- 单条补丁的补充内容不超过 {MAX_PATCH} 字
- 只写需要改动的地方，没有列出的段落一律保持原文
- 不要输出整段原文，不要重复原文
- 原文里单独一行的 〔插图N〕 是插图位置，不要改动或删除`;

    function buildWorldbookSection(settings) {
        const cats = normalizeCategories(settings.worldbookCategories).filter((c) => c.enabled);
        if (!cats.length) return '';
        const guide = cats.map((c) => `- ${c.name}（条目名如「${c.entryExample}」，关键词如 ${JSON.stringify(c.keywordsExample)}）：${c.contentGuide}`).join('\n');
        const custom = (settings.worldbookPrompt || '').trim();
        return `## 世界书任务
从本层正文提取或更新世界书条目，只允许这些分类：${cats.map((c) => c.name).join('、')}
${guide}
- 条目名用原文里的正式名称；关键词是原文里实际出现的名称、别称
- 已有条目（见下方「相关世界书条目」）如有新信息，输出**更新后的完整内容**：旧内容全部保留（可以改写整合），再加上新信息，会整条替换旧内容；不要只写追加的部分；没有新信息就不要输出
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
            : `- 触发时：在 <改写判定> 里写 "触发": true、命中的规则和改写说明，并且**不输出 <补丁>，改为输出 <改写正文>本层完整的改写后正文</改写正文>**；<改写正文> 里和原文不同的部分（新写的、改动的）用 ⟪ 和 ⟫ 包起来，照抄原文的不包
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

    /** 主角原名：用户填的优先，没填就用 AI 在前面的层认出来的 */
    function protagonistOf(settings, state) {
        return String(settings.protagonistName || (state && state.protagonist) || '').trim();
    }

    function buildAliasSection(settings, state) {
        const name = protagonistOf(settings, state);
        if (!name) {
            return `## 主角
还不知道主角是谁。请根据本层判断主角（故事的主人公、叙述视角所跟随的人物），把主角的名字写进 <主角>：写正文里实际出现的名字（翻译时写中文译名），只写一个；本层还看不出主角名字就留空。
- 第一人称叙述里的「我」不算称呼，不要写进 <称呼>`;
        }
        const aliases = uniq([name, ...(state.aliases || [])]);
        return `## 主角
主角是「${name}」，已知称呼：${aliases.join('、')}
- 正文中出现其他指代主角的称呼（外号、昵称、尊称）时，写进 <称呼>
- 只写专指主角的称呼；像「师兄」「少爷」这种也可能指别人的，不要写进 <称呼>`;
    }

    const TRANSLATE_RULES = `## 翻译要求
- **完整翻译**：不得省略、概括或跳过原文的任何内容，逐句翻译成简体中文
- **只输出译文**：<正文> 里直接写中文译文，不要复述原文，不要写段号（P1、[P1]）、「→」或原文对照，否则输出量翻倍
- **保持格式**：原文的分段、换行、对话格式全部保留，一个原文段落对应一个译文段落
- **自然流畅**：符合中文小说的表达习惯，不要生硬直译
- **章节标题也要翻译**成中文
- 人名、地名、招式等专有名词的译名全书统一：「相关世界书条目」里已有译名的必须沿用
- 原文中单独一行的 〔插图N〕 是插图位置，原样保留在对应位置
- 不要添加解释、注释或原文
- 按改写要求补充的话、因剧情改写而和原文意思不同的内容，用 ⟪ 和 ⟫ 包起来（只包新增或改动的部分，照原文翻的不包；程序会去掉这两个符号，只用来给用户标出改动）`;

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

    /**
     * 酒馆里已开的世界书当作输出要求：books = [{name, entries}]，entries 是世界书文件里的 entries（对象或数组）。
     * 关掉的、没内容的条目不要；按条目的顺序值排。
     */
    /** 一本世界书里能当输出要求的条目（没关、有内容），按顺序排好；key 是条目的 uid */
    function outputRuleItems(entries) {
        const list = Array.isArray(entries) ? entries.map((e, i) => [String(i), e]) : Object.entries(entries || {});
        return list
            .filter(([, e]) => e && !e.disable && typeof e.content === 'string' && e.content.trim())
            .map(([k, e], i) => ({ e, i, key: String(e.uid ?? k), order: Number.isFinite(Number(e.order)) ? Number(e.order) : 100 }))
            .sort((a, b2) => a.order - b2.order || a.i - b2.i)
            .map(({ e, key }) => ({
                key,
                title: String(e.comment || '').trim() || (Array.isArray(e.key) ? e.key.join('、') : ''),
                content: e.content.trim(),
            }));
    }

    /** opts.skip：不发的条目，Set 里放「书名::uid」 */
    function buildOutputRules(books, opts = {}) {
        const skip = opts.skip instanceof Set ? opts.skip : new Set(opts.skip || []);
        const out = [];
        for (const b of Array.isArray(books) ? books : []) {
            if (!b) continue;
            const items = outputRuleItems(b.entries)
                .filter((it) => !skip.has(`${b.name}::${it.key}`))
                .map((it) => (it.title ? `【${it.title}】\n` : '') + it.content);
            if (items.length) out.push(`### 《${b.name}》\n${items.join('\n\n')}`);
        }
        return out.join('\n\n');
    }

    function buildGlossarySection(s, state, layerText) {
        const hits = selectGlossary(state.glossary, layerText, s.glossaryMax);
        const table = hits.length
            ? `## 专有名词对照表（必须严格遵守，不得改译${aiReplaceLines(s).length ? '；和「名称和称呼替换」冲突时以替换为准' : ''}）\n${hits.map((it) => `- ${it.source} → ${it.target}${it.note ? `（${it.note}）` : ''}`).join('\n')}\n\n`
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

    /** 取最后 n 字左右，从一段的开头切，不把句子切半 */
    function tailText(text, n) {
        const t = String(text || '').trim();
        if (t.length <= n) return t;
        const cut = t.slice(-n);
        const nl = cut.indexOf('\n');
        return (nl >= 0 && nl < cut.length / 2 ? cut.slice(nl + 1) : cut).trim();
    }

    /** 「Plotline, <摘要>，Calculated data」→ ['Plotline','摘要','Calculated data']（标签名里可以有空格） */
    function splitTagList(v) {
        return uniq(
            String(v || '')
                .split(/[,，、;；\n]+/)
                .map((x) => x.trim().replace(/^<\/?|>$/g, '').trim())
                .filter(Boolean),
        );
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
        if ((extra.outputRules || '').trim()) parts.push(`## 输出要求（来自酒馆里开着的世界书，写正文时必须遵守）\n${extra.outputRules.trim()}`);
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
        if (extra.prevTail) parts.push(`## 上一层正文的结尾（只用来承接，让本层开头衔接自然；不要重复输出这段）\n<上一层结尾>\n${extra.prevTail}\n</上一层结尾>`);
        if (extra.prevTail && extra.prevSourceTail)
            parts.push(
                `## 上一层原文的结尾（和上面的译文结尾对照）\n<上一层原文结尾>\n${extra.prevSourceTail}\n</上一层原文结尾>\n- 对照看上一层译文是不是翻到了原文最后：如果原文最后几句在译文里漏掉了，本层译文开头先把漏掉的那几句译出来，再接着译本层；已经译过的不要重复`,
            );
        for (const t of extra.carryTags || [])
            parts.push(`## 目前最新的 <${t.tag}>（来自第 ${t.layer + 1} 层，在这个基础上更新；本层照常输出完整的 <${t.tag}>）\n<${t.tag}>\n${t.content}\n</${t.tag}>`);
        let format = (String(s.outputFormat || '').trim() || OUTPUT_FORMAT).replace('<bt>本层标题，10 字以内，概括本层主要剧情</bt>', titleInstruction(s, layer));
        const guide = String(s.summaryGuide || '').trim();
        if (guide) format = format.replace('<摘要>本层剧情摘要，100 到 200 字，写清楚谁做了什么</摘要>', () => `<摘要>${guide}</摘要>`);
        if (tr) format = format.replace(/<补丁>[\s\S]*?<\/补丁>/, `<${s.bodyTag}>\n本层完整的简体中文译文\n</${s.bodyTag}>`);
        if (tr && s.glossaryEnabled) format += '\n<新术语>\n原文 → 译名\n</新术语>';
        if (!protagonistOf(s, state)) format += '\n<主角>主角的名字，看不出就留空</主角>';
        // 放在世界书、术语表、前情后面，免得被前面的旧写法盖过去
        // 放在世界书、术语表、前情后面，免得被前面的旧写法盖过去
        const un = buildUserNameSection(s, state, tr);
        if (un) parts.push(un);
        const wr = buildWordReplaceSection(s, tr);
        if (wr) parts.push(wr);
        if (extra.feedback && extra.previousRaw) parts.push(`## 你上一次的输出（用户不满意，要按最后的修改要求重做）\n<上一次输出>\n${extra.previousRaw}\n</上一次输出>`);
        // 翻译不用补丁，原文不带段号，免得 AI 照着段号逐段「原文 → 译文」对照着输出
        const src = tr ? layer.paras.map((p) => p.text) : layer.paras.map((p) => `[P${p.id}]${p.text}`);
        parts.push(`## 本层正文（第 ${layer.index + 1} 层）\n<原文>\n${src.join('\n')}\n</原文>`);
        // 输出格式放在原文后面：原文很长时，放前面 AI 读到最后就忘了格式，JSON 容易写坏
        parts.push(format + (extra.needBigSummary ? '\n<大总结>总结内容</大总结>' : '') + '\n\n' + (tr ? `<${s.bodyTag}> 里只写正文；其他标签一律写在 </${s.bodyTag}> 后面，不要夹在正文里。\n` : '') + String(s.jsonReminder ?? JSON_REMINDER).trim());
        const wrLines = aiReplaceLines(s);
        const target = aliasTargetOf(s);
        const reminders = [];
        if (aiUserName(s)) reminders.push(`指主角的名字和称呼一律写成 ${target}`);
        if (wrLines.length) reminders.push(`按「名称和称呼替换」换掉：${wrLines.join('；')}`);
        if (reminders.length) parts.push(`再次提醒（硬性要求，按语境做，即使原文、术语表、世界书还是旧写法也要换）：${reminders.join('。')}`);
        // 修改要求放在最后：前面有上一次的输出和整层原文，放中间 AI 很容易看漏
        if ((layer.note || '').trim()) parts.push(`## 这一层的额外要求（用户提前为第 ${layer.index + 1} 层写的，必须做到；其他照上面的要求和格式）\n${layer.note.trim()}`);
        if (extra.feedback) parts.push(`## 这次重做的修改要求（最优先，必须做到；其他照上面的要求和格式）\n${extra.feedback}`);
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

    /**
     * 取标签内容。模型常在正式输出前先「想」一遍，想的时候会提到 <bt>标题</bt>、<正文>译文</正文> 这样的格式，
     * 所以取最后一个完整闭合的；都没闭合就取最后一个开头（被截断）。
     */
    function extractTag(raw, tag) {
        const s = String(raw || '');
        const open = new RegExp(`<${escapeRegExp(tag)}>`, 'gi');
        const closeTag = `</${tag}>`;
        const starts = [];
        let m;
        while ((m = open.exec(s))) starts.push(m.index + m[0].length);
        if (!starts.length) return { found: false, closed: false, content: '' };
        for (let k = starts.length - 1; k >= 0; k--) {
            const end = s.indexOf(closeTag, starts[k]);
            if (end >= 0) return { found: true, closed: true, content: s.slice(starts[k], end).trim() };
        }
        return { found: true, closed: false, content: s.slice(starts[starts.length - 1]).trim() };
    }

    /**
     * 字符串里的裸换行、制表符转义掉；字符串外当分隔符用的中文引号换成英文引号。
     * 模型常见的写法：“键”: “值”，或者值里直接回车换行。
     */
    function normalizeJsonText(t) {
        let out = '';
        let inStr = false;
        let closer = '"';
        for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (inStr) {
                if (c === '\\') {
                    out += c + (t[i + 1] || '');
                    i++;
                } else if (c === closer && /^[ \t]*(\r?\n|[,}\]:，：]|$)/.test(t.slice(i + 1, i + 40))) {
                    // 后面紧跟逗号、括号、冒号才算字符串结束，否则是正文里的引号
                    out += '"';
                    inStr = false;
                } else if (c === '"') out += '\\"';
                else if (c === '\n') out += '\\n';
                else if (c === '\r') out += '';
                else if (c === '\t') out += '\\t';
                else out += c;
            } else if (c === '"' || c === '“' || c === '”') {
                out += '"';
                inStr = true;
                closer = c === '"' ? '"' : '”';
            } else if (c === '，') out += ',';
            else if (c === '：') out += ':';
            else out += c;
        }
        return out;
    }

    /** 宽松 JSON：去代码块、中文引号、尾逗号、注释、字符串里的裸换行；「无」当空对象 */
    function parseLooseJson(text) {
        let t = String(text || '').trim();
        if (!t) return {};
        t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        if (/^(无|没有|空|暂无|none|null|n\/a|-)?[。.]?$/i.test(t)) return {};
        try {
            return JSON.parse(t);
        } catch (e) {
            /* 继续修 */
        }
        const first = t.search(/[{[]/);
        const lastObj = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
        if (first < 0 || lastObj < first) throw new Error('JSON 解析失败');
        const body = t.slice(first, lastObj + 1);
        const tries = [];
        const trailing = (x) => x.replace(/,\s*([}\]])/g, '$1');
        tries.push(trailing(body));
        let n = normalizeJsonText(body);
        n = n.replace(/^\s*\/\/.*$/gm, '');
        n = n.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
        n = trailing(n);
        tries.push(n);
        // 键没加引号：{触发: false}
        tries.push(n.replace(/([{,]\s*)([^\s"{}\[\],:]+)\s*:/g, '$1"$2":'));
        // 缺了相邻两项之间的逗号："a"\n"b"、}\n"b"
        tries.push(tries[tries.length - 1].replace(/(["}\]0-9]|true|false|null)(\s*\n\s*)(["{[])/g, '$1,$2$3'));
        for (const x of tries) {
            try {
                return JSON.parse(x);
            } catch (e) {
                /* 下一种 */
            }
        }
        throw new Error('JSON 解析失败');
    }

    /** 只是 JSON 块坏了（正文、摘要都好好的）的错误 */
    const JSON_TAGS = ['改写判定', '世界书', '表格'];
    function isJsonError(msg) {
        return JSON_TAGS.some((t) => msg === `<${t}> 不是合法 JSON`);
    }

    /** 把回复里某个标签的内容换掉 */
    function replaceTag(raw, tag, content) {
        const s = String(raw || '');
        const m = new RegExp(`<${escapeRegExp(tag)}>`, 'i').exec(s);
        if (!m) return s;
        const start = m.index + m[0].length;
        const end = s.indexOf(`</${tag}>`, start);
        if (end < 0) return s;
        return s.slice(0, start) + content + s.slice(end);
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

    /**
     * AI 有时把译文写成「P29: 原文 → 译文」逐段对照，或者每段带 [P29] 段号。
     * 对照格式只留箭头后面的译文，段号去掉；正常的译文原样返回。
     */
    /** AI 用 ⟪ ⟫ 标出的改动；正文里去掉，界面高亮时换成 MARK_OPEN/MARK_CLOSE */
    function stripChangeMarks(t) {
        return String(t || '').replace(/[⟪⟫]/g, '');
    }

    function stripEchoedSource(text) {
        const lines = String(text || '').split('\n');
        const NUM = /^\s*\[?P\d+\]?\s*[:：]?\s*/;
        const ARROW = /^\s*(?:→|->|=>)\s*/;
        const numbered = lines.filter((l) => NUM.test(l) && /^\s*\[?P\d+/.test(l)).length;
        if (numbered < 2) return text;
        const arrows = lines.filter((l) => ARROW.test(l) || /\s(?:→|->)\s/.test(l)).length;
        if (arrows < 2) return lines.map((l) => (/^\s*\[?P\d+/.test(l) ? l.replace(NUM, '') : l)).join('\n');
        const out = [];
        let inTarget = false;
        for (const l of lines) {
            if (/^\s*\[?P\d+/.test(l)) {
                // 同一行里「原文 → 译文」
                const m = l.match(/\s(?:→|->)\s(.*)$/);
                inTarget = !!m;
                if (m && m[1].trim()) out.push(m[1].trim());
            } else if (ARROW.test(l)) {
                inTarget = true;
                const t = l.replace(ARROW, '').trim();
                if (t) out.push(t);
            } else if (!l.trim()) {
                inTarget = false;
            } else if (inTarget || /^〔插图\d+〕$/.test(l.trim())) out.push(l.trim());
        }
        return out.join('\n');
    }

    function parseLayerResponse(raw, opts = {}) {
        const errors = [];
        const warnings = [];
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
        const hero = extractTag(raw, '主角');

        if (!title.closed) errors.push('缺少 <bt> 标题');
        if (!summary.closed) errors.push('缺少 <摘要>');
        // 正文太短多半是把格式说明抄了一遍（比如只写了「译文」两个字），不能当成功
        const tooShort = (t) => opts.sourceChars > 200 && t.replace(/\s+/g, '').length < opts.sourceChars * 0.1;
        if (opts.translate) {
            if (!rewritten.closed || !rewritten.content) errors.push(`缺少完整的 <${bodyTag}> 译文（或被截断）`);
            else if (tooShort(rewritten.content)) errors.push(`<${bodyTag}> 只有 ${rewritten.content.length} 字，原文 ${opts.sourceChars} 字，译文不完整`);
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
                if (opts.lenient) {
                    warnings.push('<改写判定> 格式坏了，已按有没有 <改写正文> 判断');
                    divergence.triggered = !opts.translate && rewritten.closed && !!rewritten.content;
                } else errors.push('<改写判定> 不是合法 JSON');
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
                    if (opts.lenient) warnings.push('<世界书> 格式坏了，本层的世界书更新跳过');
                    else errors.push('<世界书> 不是合法 JSON');
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
                    if (opts.lenient) warnings.push('<表格> 格式坏了，本层的表格更新跳过');
                    else errors.push('<表格> 不是合法 JSON');
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
            // 只有 JSON 块坏了：正文能用，修格式就行，不用整层重写
            jsonOnly: errors.length > 0 && errors.every(isJsonError),
            warnings,
            title: title.content.replace(/\s+/g, ' ').trim(),
            summary: summary.content,
            patches,
            badPatchLines: bad,
            rewrittenText: rewritten.closed ? stripChangeMarks(opts.translate ? stripEchoedSource(rewritten.content) : rewritten.content) : null,
            // 带 ⟪⟫ 改动标记的版本，只给界面高亮用
            markedText: rewritten.closed && /[⟪⟫]/.test(rewritten.content) ? (opts.translate ? stripEchoedSource(rewritten.content) : rewritten.content) : null,
            divergence,
            aliases,
            worldbook,
            tableOps,
            bigSummary: big.closed ? big.content : '',
            terms: terms.closed ? parseGlossaryLines(terms.content) : [],
            // 只认一个短名字；「无」「未知」之类当没认出来
            protagonist: (() => {
                const n = hero.closed ? hero.content.split(/[/／、,，\n]/)[0].trim() : '';
                return n && n.length <= 12 && !/^(无|未知|不明|不确定|空)$/.test(n) && !/[看不出留]/.test(n) ? n : '';
            })(),
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
    // 界面里高亮 AI 补充的内容用的标记（私用区字符，正文里不会出现；只在界面显示时用，楼层和导出不带）
    const MARK_OPEN = '\uE000';
    const MARK_CLOSE = '\uE001';
    const stripMarks = (t) => String(t || '').replace(/[\uE000\uE001]/g, '');

    /** opts.mark：补充的内容前后加上高亮标记 */
    function applyPatches(paras, patches, opts = {}) {
        const wrap = (t) => (opts.mark && t ? MARK_OPEN + t + MARK_CLOSE : t);
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
                extraParas[idx].push(wrap(pt.text));
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
            edits[idx].push({ pos, len, insert: wrap(pt.text) });
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
    /** AI 只回了「追加」那一段：比旧内容短一大截，或者以追加、补充、新增开头 */
    function isPartialWbUpdate(content, oldContent) {
        const c = String(content || '').trim();
        return c.length < String(oldContent || '').length * 0.6 || /^#*\s*[^\n]{0,12}(追加|补充|新增)/.test(c);
    }

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
                // 旧内容发给过 AI，按理回的是改好的完整版，整条替换；
                // 但 AI 常常只写「追加」那一段，比旧内容短一大截时当补充接在后面，免得旧信息丢掉
                if (provided.has(`${category}/${existing}`) && !isPartialWbUpdate(content, e.内容)) {
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
     * 词语替换规则：每行「原词 → 新词」（也可以写 ->），新词留空就是删掉；原词写成 /正则/flags 按正则替换。
     */
    function parseWordReplace(text) {
        const rules = [];
        for (const line of String(text || '').split('\n')) {
            const m = /^(.*?)\s*(?:→|->)\s*(.*)$/.exec(line.trim());
            if (!m || !m[1]) continue;
            const from = m[1].trim();
            const re = /^\/(.+)\/([a-z]*)$/.exec(from);
            try {
                rules.push({ re: re ? new RegExp(re[1], re[2].includes('g') ? re[2] : re[2] + 'g') : new RegExp(escapeRegExp(from), 'g'), to: m[2] });
            } catch (e) {
                /* 正则写错的跳过 */
            }
        }
        return rules;
    }

    function applyWordReplace(text, rules) {
        let t = String(text ?? '');
        for (const r of rules || []) t = t.replace(r.re, r.to);
        return t;
    }

    /** 导出时按文字直接替换的规则；交给 AI 替换时导出不再换，免得单字称呼之类被误换 */
    function textReplaceRules(settings) {
        return (settings.wordReplaceMode || 'ai') === 'text' ? parseWordReplace(settings.wordReplace) : [];
    }

    /** 交给 AI 替换时写进提示词的规则行 */
    function aiReplaceLines(s) {
        if ((s.wordReplaceMode || 'ai') !== 'ai') return [];
        return String(s.wordReplace || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => parseWordReplace(l).length)
            .map((l) => {
                const m = /^(.*?)\s*(?:→|->)\s*(.*)$/.exec(l);
                return `${m[1].trim()} → ${m[2].trim() || '（删掉）'}`;
            });
    }

    /** 主角写成 {{user}} 交给 AI 做（默认）；text 时导出按已知称呼直接替换 */
    function aiUserName(s) {
        return (s.aliasReplaceBy || 'ai') === 'ai';
    }

    function buildUserNameSection(s, state, tr) {
        if (!aiUserName(s)) return '';
        const target = aliasTargetOf(s);
        const name = protagonistOf(s, state);
        const who = name ? `主角「${name}」（已知称呼：${uniq([name, ...((state && state.aliases) || [])]).filter((a) => a !== target).join('、')}）` : '主角（按上面「主角」一节认出来的那个人）';
        return `## 主角在输出里写成 ${target}（用户的硬性要求，必须执行）
- ${who}在${tr ? '译文' : '你写的补丁、补充内容'}、标题、摘要、世界书、表格里，凡是指主角的名字、姓、名、单字昵称、外号、尊称，一律写成 ${target}
- 称呼带后缀、敬称时保留后缀，只把名字部分换掉：例如「真君」「真くん」→「${target}君」，「春日同学」→「${target}同学」
- 按语境判断：只换真正指主角的地方；别的角色恰好用同一个字、同一个名字时（例如另一个人也叫「真」），那个人不换，照常写他的名字
- 不要以「原文就是这个名字」「保持原文设定」为理由不换；第一人称的「我」不用换
${tr ? '' : `- 原文里指主角的名字和称呼，用「=」补丁换成 ${target}：锚点从原文复制包含名字的一小段，替换内容写换好之后的这段；一段里出现几次就写几条，锚点互不重叠
`}- <称呼> 里照常写原文里指主角的称呼（原来的写法），<主角> 里写主角原来的名字`;
    }

    function buildWordReplaceSection(s, tr) {
        const lines = aiReplaceLines(s);
        if (!lines.length) return '';
        return `## 名称和称呼替换（用户的硬性要求，必须执行）
用户要求把左边的写法换成右边的（/…/ 是正则写法）：
${lines.map((l) => '- ' + l).join('\n')}
- 这是用户有意的改动，不是翻译或原文问题：不要以「原文就是这个名字」「保持原文设定」「和别的角色同名」为理由不换
- 优先级高于原文写法、术语表、已有世界书条目和前面的层：那些地方还是旧写法时，本层一律改用右边的新写法（世界书、表格里也写新写法）
- 按语境替换：只换真正指规则里那个人、那个东西的地方；原文里别的角色恰好用同一个字或同一个名字时，那个角色不换；原词只是别的词的一部分时也不换
- 换名字后，别人对他的称呼（单字、昵称、尊称、敬称等）也按新名字自然地改过来
${tr ? '- 翻译时直接译成新的写法，原文里的旧名字不要出现在译文里' : '- 原文里出现要换的词的地方，用「=」补丁改：锚点从原文复制包含原词的一小段，替换内容写换好之后的这段；一段里出现几次就写几条，锚点互不重叠；补充内容里直接用新的写法'}`;
    }

    /**
     * 列出一段文字里每条规则换掉的地方（按规则顺序依次替换，和 applyWordReplace 结果一致）。
     * 每处给前后 ctx 个字：{ rule, from, to, before, after }，before/after 是替换前后的片段。
     */
    function findWordReplaceHits(text, rules, ctx = 15) {
        const hits = [];
        let t = String(text ?? '');
        (rules || []).forEach((r, ri) => {
            const re = new RegExp(r.re.source, r.re.flags);
            let m;
            const found = [];
            while ((m = re.exec(t))) {
                if (!m[0]) {
                    re.lastIndex++;
                    continue;
                }
                found.push({ at: m.index, match: m[0], to: m[0].replace(new RegExp(r.re.source, r.re.flags.replace('g', '')), r.to) });
            }
            for (const f of found) {
                const pre = (f.at > ctx ? '…' : '') + t.slice(Math.max(0, f.at - ctx), f.at);
                const end = f.at + f.match.length;
                const post = t.slice(end, end + ctx) + (end + ctx < t.length ? '…' : '');
                hits.push({ rule: ri, from: f.match, to: f.to, pre, post });
            }
            t = t.replace(r.re, r.to);
        });
        return hits;
    }

    /**
     * 转成酒馆世界书文件格式（{entries: {uid: entry}}），称呼替换在这里做。
     * 条目注释沿用「TXT转世界书」的「分类 - 名称」，两边导出的条目可以混用。
     */
    function worldbookToST(wb, opts = {}) {
        const cats = normalizeCategories(opts.categories || DEFAULT_WORLDBOOK_CATEGORIES);
        const catOf = (c) => cats.find((x) => x.name === c) || normalizeCategory({ name: c });
        const conv = (s) => applyWordReplace(opts.aliases ? applyAliases(s, opts.aliases, opts.target) : s, opts.replace);
        const entries = {};
        let uid = 0;
        for (const [category, items] of Object.entries(wb || {})) {
            // 位置、深度、顺序按分类设置走，和 TXT转世界书导出一致：position 4 是按深度插入
            const cat = catOf(category);
            let k = 0;
            for (const [name, item] of Object.entries(items || {})) {
                const shown = conv(name);
                entries[uid] = makeWorldEntry(uid, {
                    key: uniq((item.关键词 || []).map(conv)),
                    comment: `${category} - ${shown}`,
                    content: conv(item.内容 || ''),
                    constant: cat.constant,
                    group: `${category}_${shown}`,
                    position: cat.defaultPosition,
                    depth: cat.defaultDepth,
                    order: cat.autoIncrementOrder ? cat.defaultOrder + k : cat.defaultOrder,
                });
                uid++;
                k++;
            }
        }
        const plot = opts.plot || {};
        for (const p of opts.plotEntries || []) {
            entries[uid] = makeWorldEntry(uid, {
                key: uniq((p.keys || []).map(conv)),
                comment: `剧情 - ${conv(p.title)}`,
                content: conv(p.content),
                constant: false,
                position: finiteInt(plot.position, 0),
                depth: finiteInt(plot.depth, 4),
                order: finiteInt(plot.order, 50, Number.MIN_SAFE_INTEGER),
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
        // 行的主键（比如「佐仓花恋」）在原文里可能是别的写法：翻译时原文是外文，平时也有称呼、外号。
        // 用术语表的原文写法、同名世界书条目的关键词、主角的称呼一起去找，免得本层明明出场却没带上这一行，AI 又插一行重复的
        const memo = new Map();
        const namesFor = (key) => {
            if (memo.has(key)) return memo.get(key);
            const out = [key];
            for (const g of state.glossary || []) if (g && g.target === key && g.source) out.push(g.source);
            for (const items of Object.values(state.worldbook || {})) {
                for (const [n, e] of Object.entries(items || {})) {
                    const ks = (e && e.关键词) || [];
                    if (n === key || ks.includes(key)) out.push(n, ...ks);
                }
            }
            if (key === protagonistOf(settings, state)) out.push(...(state.aliases || []));
            const res = uniq(out.map((x) => String(x || '').trim()).filter((x) => x.length >= 2));
            memo.set(key, res);
            return res;
        };
        const lines = [];
        t.template.tables.forEach((tb, i) => {
            if (tb.name === roles.summaryTable) {
                lines.push(`[${tb.name}] 已有 ${t.rows[i].length} 行（不需要输出）`);
                return;
            }
            let rows = t.rows[i];
            if (roles.appendOnly.includes(tb.name)) rows = rows.slice(-5);
            else if (settings.tableContextAll) rows = rows.slice();
            else if (!roles.singleRow.includes(tb.name)) rows = rows.filter((r) => r[0] && namesFor(r[0]).some((n) => text.includes(n))).slice(0, maxRows);
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
        for (const x of floor.before || []) parts.push(x);
        parts.push(`<${s.bodyTag}>\n${floor.body}\n</${s.bodyTag}>`);
        // 夹在正文里的别的标签挪到正文后面、tableEdit 前面
        for (const x of floor.extras || []) parts.push(x);
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
     *   messageChain    消息链（可选，旧格式）
     *   preset          酒馆预设条目（可选，优先于 messageChain）
     *   substitute      展开预设条目里 {{char}}/{{user}} 等宏的函数（可选）
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
            stats: { cleanedLines: 0, repeatedLines: 0, inlineAds: 0, emptyChapters: [], inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
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
                protagonist: '', // 没填主角原名时，AI 认出来的主角
            };
        }

        /** 用户在术语表里删掉的词，AI 之后再报也不收 */
        function keptTerms(terms) {
            const removed = new Set(cfg.glossaryRemoved || []);
            return removed.size ? normalizeGlossary(terms).filter((t) => !removed.has(t.source)) : terms;
        }

        /** 有预设条目时按条目拼，否则用旧的消息链 */
        function buildMessages(prompt) {
            return cfg.preset ? assemblePresetMessages(cfg.preset, prompt, cfg.substitute) : applyMessageChain(prompt, cfg.messageChain);
        }

        /** 用已完成的层从头重放出状态。确定性的，不调 AI。 */
        // replay 的中间状态缓存：cache[k] 是合并完前 k 层后的状态，refs[k-1] 记下当时用的是哪个结果对象。
        // 某层结果被替换（重做、重跑、恢复任务）或设置变了，从那里往后重新算，免得上千层时每层都从头算一遍。
        const replayCache = { sig: '', states: [], refs: [] };

        function replay(upTo) {
            const sig = JSON.stringify(settings) + '|' + E.layers.length;
            const gloss = cfg.seedGlossary;
            const removed = cfg.glossaryRemoved;
            if (replayCache.sig !== sig || replayCache.tpl !== cfg.tableTemplate || replayCache.seed !== cfg.seedWorldbook || replayCache.gloss !== gloss || replayCache.removed !== removed) {
                Object.assign(replayCache, { sig, tpl: cfg.tableTemplate, seed: cfg.seedWorldbook, gloss, removed, states: [], refs: [] });
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
                glossary: layer.translate && settings.glossaryEnabled ? mergeGlossary(st.glossary, keptTerms(p.terms)) : st.glossary,
                // 第一次认出来的就定下来，后面的层不再改
                protagonist: st.protagonist || (settings.protagonistName ? '' : p.protagonist || ''),
            };
            next.aliases = mergeAliases(st.aliases, p.aliases, {
                protagonistName: protagonistOf(settings, next),
                blacklist: settings.aliasBlacklist,
                target: aliasTargetOf(settings),
            });
            if (settings.worldbookEnabled) {
                const cats = normalizeCategories(settings.worldbookCategories).filter((c) => c.enabled).map((c) => c.name);
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
            const cleaned = cleanText(text, adPatternsFor(settings), settings.adRemovePrevLine, settings.chapterRegex, {
                inlinePatterns: settings.inlineAdPatterns,
                repeatLimit: settings.repeatParaLimit,
                repeatMinChars: settings.repeatParaMinChars,
                keepLines: settings.cleanKeep,
            });
            E.stats.cleanedLines = cleaned.removed;
            E.stats.repeatedLines = cleaned.repeated;
            E.stats.inlineAds = cleaned.inlineRemoved;
            E.stats.emptyChapters = cleaned.emptyChapters;
            E.stats.cleanLog = cleaned.log;
            const paras = splitParagraphs(cleaned.text);
            // 重新分层时，每层提前写好的提示词按这层第一段对回去
            const notes = new Map((E.layers || []).filter((l) => l.note && l.paras && l.paras[0]).map((l) => [l.paras[0].text, l.note]));
            E.layers = splitLayers(paras, settings);
            for (const l of E.layers) if (l.paras[0] && notes.has(l.paras[0].text)) l.note = notes.get(l.paras[0].text);
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
            const prev = i > 0 ? E.results[i - 1] : null;
            const prevDone = prev && prev.status === 'done';
            const tailN = Math.max(0, Number(settings.prevTailChars) || 0);
            const prevTail = prevDone && tailN && prev.finalParas ? tailText(splitBodyBlocks(prev.finalParas.join('\n'), settings.bodyTag).body, tailN) : '';
            // 翻译时把上一层原文结尾也带上同样字数，AI 对照着看上一层最后几句有没有漏译
            const prevSourceTail = prevTail && i > 0 && E.layers[i - 1].translate ? tailText(E.layers[i - 1].paras.map((p) => p.text).join('\n'), tailN) : '';
            // 像表格一样带「最新的一份」：上一层没输出这个标签，就往前找最近一次有的，状态不会断
            const carryTags = splitTagList(settings.carryTags)
                .map((tag) => {
                    for (let k = i - 1; k >= 0; k--) {
                        const r = E.results[k];
                        if (!r || r.status !== 'done') continue;
                        const x = extractTag(r.raw, tag);
                        if (x.closed && x.content) return { tag, content: x.content, layer: k };
                    }
                    return null;
                })
                .filter(Boolean);
            // 用户在界面里改过这一层的提示词就直接用改过的（预设部分照常套）
            const prompt = typeof extra.customPrompt === 'string' && extra.customPrompt.trim() ? extra.customPrompt : buildLayerPrompt(layer, settings, st, {
                outputRules: typeof cfg.outputRules === 'string' ? cfg.outputRules : '',
                prevTail,
                prevSourceTail,
                carryTags,
                ...extra,
                needBigSummary: askBig,
                eventRows: askBig ? eventRowsOf(st) : [],
            });
            return {
                prompt,
                messages: buildMessages(prompt),
                providedNames: rel.map((x) => `${x.category}/${x.name}`),
                askedBigSummary: askBig,
            };
        }

        /**
         * 记一次请求的用量。callModel 可以只回字符串，也可以回 {text, usage}：
         * usage 是接口返回的真实用量（OpenAI 的 prompt_tokens/completion_tokens 或 Claude 的 input_tokens/output_tokens），
         * 没有就按字数估算。r 是层结果，记到 r.tokens 里；返回回复文本。
         */
        function addUsage(r, messages, res) {
            const text = typeof res === 'string' ? res : String((res && res.text) || '');
            const u = res && typeof res === 'object' ? res.usage : null;
            const real = !!(u && (u.prompt_tokens || u.input_tokens || u.completion_tokens || u.output_tokens));
            const input = real ? Number(u.prompt_tokens || u.input_tokens || 0) : estimateTokens(messages.map((m) => m.content).join('\n'));
            const output = real ? Number(u.completion_tokens || u.output_tokens || 0) : estimateTokens(text);
            const cached = real ? Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.cache_read_input_tokens || u.prompt_cache_hit_tokens || 0) : 0;
            E.stats.inputTokens += input;
            E.stats.outputTokens += output;
            E.stats.cachedTokens = (E.stats.cachedTokens || 0) + cached;
            if (!real) E.stats.estimated = true;
            if (r) {
                const t = r.tokens || (r.tokens = { input: 0, output: 0, cached: 0, calls: 0, estimated: false });
                t.input += input;
                t.output += output;
                t.cached += cached;
                t.calls++;
                if (!real) t.estimated = true;
            }
            return text;
        }

        /**
         * 发一次请求并把原始输出记在 r.calls 里（每次请求一条：用途、第几次、原始输出或错误、用量），
         * 给界面逐次查看。keepRequest 时连发出去的消息一起存（修格式那种小请求）。
         */
        async function callAndLog(r, messages, info, keepRequest) {
            const rec = { purpose: info.purpose || 'layer', attempt: info.attempt || 0, time: Date.now() };
            if (keepRequest) rec.request = messages.map((m) => ({ role: m.role, content: m.content }));
            if (r) (r.calls || (r.calls = [])).push(rec);
            const before = r && r.tokens ? { ...r.tokens } : { input: 0, output: 0, cached: 0 };
            try {
                const text = addUsage(r, messages, await cfg.callModel(messages, info));
                rec.raw = text;
                if (r && r.tokens) rec.tokens = { input: r.tokens.input - before.input, output: r.tokens.output - before.output, cached: r.tokens.cached - before.cached, estimated: r.tokens.estimated };
                return text;
            } catch (e) {
                rec.error = String(e.message || e);
                throw e;
            }
        }

        /** 把坏掉的 JSON 块单独发给 AI 修，返回替换好的回复；请求失败就原样返回 */
        async function repairJsonBlocks(i, raw, errors, r) {
            const tags = JSON_TAGS.filter((t) => errors.includes(`<${t}> 不是合法 JSON`));
            const blocks = tags.map((t) => `<${t}>\n${extractTag(raw, t).content}\n</${t}>`).join('\n\n');
            const prompt = `下面几段本该是 JSON，但格式写坏了，解析不了。请只修正格式，让每段都是能被 JSON.parse 解析的合法 JSON：
- 键和字符串一律用英文双引号，字符串里的双引号写成 \\"，换行写成 \\n
- 不要尾逗号、注释、代码块标记
- 内容一个字都不要改、不要增删条目
- 原样保留外面的标签，只输出这几段，别的什么都不要写

${blocks}`;
            try {
                if (E.stopRequested) throw new Error('ABORTED');
                // 不套用户的预设：预设里的角色扮演规则会让 AI 去写正文而不是修格式
                const messages = [
                    { role: 'system', content: '你是 JSON 格式修复工具。只修格式，不改内容，只输出修好的几段，不写任何别的话。' },
                    { role: 'user', content: prompt },
                ];
                const fixed = await callAndLog(r, messages, { layer: i, attempt: 0, prompt, purpose: 'repair' }, true);
                let out = raw;
                for (const t of tags) {
                    const x = extractTag(fixed, t);
                    if (x.closed && x.content) out = replaceTag(out, t, x.content);
                }
                return out;
            } catch (e) {
                if (String(e.message || e) === 'ABORTED') throw e;
                emit('layer-repair-failed', { index: i, error: String(e.message || e) });
                return raw;
            }
        }

        async function processLayer(i, extra = {}) {
            const st = replay(i);
            const req = buildRequest(i, st, extra);
            const startedAt = Date.now();
            const r = {
                status: 'running',
                attempts: 0,
                providedNames: req.providedNames,
                askedBigSummary: req.askedBigSummary,
                // 发出去的提示词：prompt 是本模块拼的任务部分（可以改了重做），request 是套上预设后的完整消息
                prompt: req.prompt,
                request: req.messages.map((m) => ({ role: m.role, content: m.content })),
                customPrompt: typeof extra.customPrompt === 'string' && extra.customPrompt.trim() ? true : undefined,
            };
            E.results[i] = r;
            emit('layer-start', { index: i });
            let lastErr = null;
            for (let attempt = 0; attempt <= settings.retries; attempt++) {
                if (E.stopRequested) throw new Error('ABORTED');
                r.attempts = attempt + 1;
                let raw;
                try {
                    raw = await callAndLog(r, req.messages, { layer: i, attempt, prompt: req.prompt });
                } catch (e) {
                    lastErr = e;
                    emit('layer-retry', { index: i, attempt, error: String(e.message || e) });
                    continue;
                }
                const layerNow = E.layers[i];
                const popts = { translate: !!layerNow.translate, bodyTag: settings.bodyTag, sourceChars: layerNow.chars };
                let parsed = parseLayerResponse(raw, popts);
                const mainRec = r.calls[r.calls.length - 1];
                if (!parsed.ok) mainRec.problem = parsed.errors.join('；');
                // 正文没问题、只是 JSON 块写坏了：单独让 AI 修格式（只回几个 JSON，很省），
                // 修不好就丢掉坏的那几块，保住正文，不整层重写
                if (!parsed.ok && parsed.jsonOnly) {
                    emit('layer-repair', { index: i, error: parsed.errors.join('；') });
                    raw = await repairJsonBlocks(i, raw, parsed.errors, r);
                    parsed = parseLayerResponse(raw, popts);
                    if (!parsed.ok && parsed.jsonOnly) parsed = parseLayerResponse(raw, { ...popts, lenient: true });
                    if (parsed.warnings.length) emit('layer-warn', { index: i, warnings: parsed.warnings });
                    const fixRec = r.calls[r.calls.length - 1];
                    if (fixRec !== mainRec) fixRec.problem = parsed.ok ? (parsed.warnings.length ? `修好一部分：${parsed.warnings.join('；')}` : '') : parsed.errors.join('；');
                }
                if (!parsed.ok) {
                    lastErr = new Error(parsed.errors.join('；'));
                    emit('layer-retry', { index: i, attempt, error: lastErr.message });
                    continue;
                }
                r.raw = raw;
                r.parsed = parsed;
                r.warnings = parsed.warnings;
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
                // 这层用了多久（含重试、修格式），用来估算剩余时间
                r.ms = Date.now() - startedAt;
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
            return runSingle(() => rejectInner(feedback));
        }

        async function rejectInner(feedback) {
            const i = E.reviewing;
            if (i === null) return null;
            const prev = E.results[i];
            return redoLayer(i, { feedback, previousRaw: prev && prev.raw });
        }

        /**
         * 重做第 i 层（之后的层作废）。中途点了停止就把原来的结果放回去，什么都不丢。
         */
        /**
         * 重做第 i 层。opts.keepLater：只换这一层，后面的层保留（世界书、表格按新结果重算）；
         * 这时重做失败就把这层的旧结果放回去，不进审阅。
         */
        async function redoLayer(i, extra, opts = {}) {
            const keep = !!opts.keepLater;
            const saved = keep ? [E.results[i]] : E.results.slice(i);
            if (keep) E.results[i] = null;
            else for (let k = i; k < E.results.length; k++) E.results[k] = null;
            E.reviewing = null;
            let res;
            try {
                res = await processLayer(i, extra);
            } catch (e) {
                if (e.message !== 'ABORTED') throw e;
                saved.forEach((r, k) => (E.results[i + k] = r));
                emit('run-end', { done: E.results.filter((r) => r && r.status === 'done').length, total: E.layers.length });
                return null;
            }
            if (keep) {
                if (res.status !== 'done' && saved[0]) E.results[i] = saved[0];
                emit('run-end', { done: E.results.filter((r) => r && r.status === 'done').length, total: E.layers.length });
                return res;
            }
            E.reviewing = res.status === 'done' ? i : null;
            emit('review', { index: i, result: res });
            return res;
        }

        /** 只重 roll 第 i 层（同样的提示词再要一次），默认保留后面的层 */
        async function rerollLayer(i, opts = { keepLater: true }) {
            return runSingle(() => (E.layers[i] ? redoLayer(i, {}, opts) : null));
        }

        /** 只让 AI 重新输出 JSON 的提示词：用这层处理完的正文当原文，不再要正文 */
        function buildJsonOnlyPrompt(i, st, extraPrompt) {
            const s = { ...DEFAULT_SETTINGS, ...settings };
            const r = E.results[i];
            const body = splitBodyBlocks(r.finalParas.join('\n'), settings.bodyTag).body;
            const parts = [`你是小说资料整理助手。下面是一部小说第 ${i + 1} 层已经定稿的正文。正文不用改、也不要输出；只按要求输出这一层的 <改写判定>、<世界书>、<表格> 三段，每段都必须是能被 JSON.parse 解析的合法 JSON（键和字符串用英文双引号，字符串里的双引号写成 \\"，不要注释、尾逗号、代码块标记）。`];
            const div = buildDivergenceSection(s, st, !!E.layers[i].translate);
            if (div) parts.push(div);
            if (s.worldbookEnabled) {
                parts.push(buildWorldbookSection(s));
                const rel = selectRelevantEntries(st.worldbook || {}, body, s.worldbookContextChars);
                if (rel.length) parts.push(`## 相关世界书条目（已有内容）\n` + rel.map((x) => `### ${x.category} / ${x.name}\n关键词：${(x.entry.关键词 || []).join('、')}\n${x.entry.内容}`).join('\n\n'));
            }
            const table = buildTableSection(s, st, body);
            if (table) parts.push(table);
            const old = JSON_TAGS.map((t) => extractTag(r.raw, t)).some((x) => x.found)
                ? `## 你上次给的（格式有问题或需要改，供参考）\n${JSON_TAGS.map((t) => `<${t}>\n${extractTag(r.raw, t).content}\n</${t}>`).join('\n')}`
                : '';
            if (old) parts.push(old);
            if ((extraPrompt || '').trim()) parts.push(`## 用户的补充要求（优先遵守）\n${extraPrompt.trim()}`);
            parts.push(`## 本层定稿正文\n<原文>\n${body}\n</原文>`);
            parts.push(`## 输出格式（只输出这三段，别的什么都不要写）\n<改写判定>{"触发": false, "规则": "", "说明": "", "回归原文": false}</改写判定>\n<世界书>JSON，没有新内容就输出 {}</世界书>\n<表格>JSON，没有变化就输出 {}</表格>\n\n${String(s.jsonReminder ?? JSON_REMINDER).trim()}`);
            return parts.join('\n\n');
        }

        /**
         * 正文不动，只让 AI 重新输出这层的 JSON（改写判定、世界书、表格），换进这层的结果里。
         * opts.usePreset：套用户的酒馆预设（默认不套，免得预设让 AI 去写正文）。之后的层保留，状态按新结果重算。
         */
        async function regenJson(i, extraPrompt, opts = {}) {
            const old = E.results[i];
            if (!old || old.status !== 'done') throw new Error('这一层还没完成');
            if (E.running) throw new Error('正在处理中');
            // 标成运行中，界面的停止按钮才能点
            E.running = true;
            try {
                return await regenJsonInner(i, old, extraPrompt, opts);
            } finally {
                E.running = false;
            }
        }

        async function regenJsonInner(i, old, extraPrompt, opts) {
            const st = replay(i);
            const prompt = buildJsonOnlyPrompt(i, st, extraPrompt);
            const messages = opts.usePreset
                ? buildMessages(prompt)
                : [
                      { role: 'system', content: '你是小说资料整理助手，只输出要求的几段 JSON，不写正文、不写别的话。' },
                      { role: 'user', content: prompt },
                  ];
            const r = { ...old, calls: (old.calls || []).slice(), tokens: old.tokens ? { ...old.tokens } : undefined };
            let reply;
            try {
                reply = await callAndLog(r, messages, { layer: i, attempt: 0, prompt, purpose: 'json' }, true);
            } catch (err) {
                Object.assign(old, { calls: r.calls, tokens: r.tokens });
                throw err;
            }
            let raw = old.raw;
            const got = [];
            for (const t of JSON_TAGS) {
                const x = extractTag(reply, t);
                if (!x.closed) continue;
                got.push(t);
                raw = extractTag(raw, t).closed ? replaceTag(raw, t, x.content) : `${raw}\n<${t}>${x.content}</${t}>`;
            }
            const rec = r.calls[r.calls.length - 1];
            // 失败也把这次请求记在原结果上，方便看 AI 回了什么（不影响状态）
            const keepLog = () => Object.assign(old, { calls: r.calls, tokens: r.tokens });
            if (!got.length) {
                keepLog();
                rec.problem = '回复里没有 <改写判定>/<世界书>/<表格>';
                throw new Error(rec.problem);
            }
            const layer = E.layers[i];
            const popts = { translate: !!layer.translate, bodyTag: settings.bodyTag, sourceChars: layer.chars };
            let parsed = parseLayerResponse(raw, popts);
            if (!parsed.ok && parsed.jsonOnly) {
                // 还有段 JSON 是坏的：能用的先换上，坏的那段照旧跳过
                rec.problem = parsed.errors.join('；');
                parsed = parseLayerResponse(raw, { ...popts, lenient: true });
            }
            if (!parsed.ok) {
                rec.problem = parsed.errors.join('；');
                keepLog();
                throw new Error(rec.problem);
            }
            Object.assign(r, { raw, parsed, warnings: parsed.warnings });
            const c = commit(st, i, r);
            r.tableActions = c.out.tableActions;
            r.tableLog = c.out.tableLog;
            r.divergenceStart = c.out.divergenceStart;
            r.inDivergence = c.out.inDivergence;
            // 换成新对象，重放缓存会从这层往后重新算
            E.results[i] = r;
            emit('layer-done', { index: i, result: r });
            return r;
        }

        /** 带修改要求重做第 i 层（不用等审阅；之后的层作废） */
        /** 单层重做期间标成运行中：界面的停止按钮能点，停止后这次请求中断 */
        async function runSingle(fn) {
            if (E.running) throw new Error('正在处理中');
            E.running = true;
            E.stopRequested = false;
            try {
                return await fn();
            } finally {
                E.running = false;
            }
        }

        async function redoWithFeedback(i, feedback, opts) {
            return runSingle(() => redoWithFeedbackInner(i, feedback, opts));
        }

        async function redoWithFeedbackInner(i, feedback, opts) {
            if (!E.layers[i]) return null;
            const prev = E.results[i];
            return redoLayer(i, { feedback, previousRaw: prev && prev.raw }, opts);
        }

        /** 用改过的提示词重做第 i 层（之后的层作废） */
        async function redoWithPrompt(i, prompt, opts) {
            return runSingle(() => redoWithPromptInner(i, prompt, opts));
        }

        async function redoWithPromptInner(i, prompt, opts) {
            if (!E.layers[i]) return null;
            return redoLayer(i, { customPrompt: String(prompt || '') }, opts);
        }

        /**
         * 词语替换直接改到已生成的层里（正文、标题、摘要、世界书、表格、原始回复），之后的展示、导出、重做都用改过的。
         * 请求记录不动。返回改到的层数。
         */
        function applyReplaceToResults(text) {
            const rules = parseWordReplace(text);
            if (!rules.length) return 0;
            const deep = (v) => {
                if (typeof v === 'string') return applyWordReplace(v, rules);
                if (Array.isArray(v)) return v.map(deep);
                if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [applyWordReplace(k, rules), deep(x)]));
                return v;
            };
            let changed = 0;
            for (let i = 0; i < E.results.length; i++) {
                const r = E.results[i];
                if (!r || r.status !== 'done') continue;
                const nr = { ...r, raw: deep(r.raw), finalParas: deep(r.finalParas), parsed: deep(r.parsed), tableActions: deep(r.tableActions) };
                if (JSON.stringify([nr.raw, nr.finalParas, nr.parsed]) === JSON.stringify([r.raw, r.finalParas, r.parsed])) continue;
                nr.appliedReplace = [r.appliedReplace, String(text).trim()].filter(Boolean).join('\n');
                // 换成新对象，重放缓存从这层往后重新算（世界书、表格跟着变）
                E.results[i] = nr;
                changed++;
            }
            return changed;
        }

        /**
         * 先看看词语替换会换掉哪些地方，不改内容。
         * 返回 { rules: [{ text, count }], hits: [{ layer, where, rule, from, to, pre, post }] }。
         */
        function previewReplaceInResults(text) {
            const lines = String(text || '')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => parseWordReplace(l).length);
            const rules = lines.map((l) => parseWordReplace(l)[0]);
            const hits = [];
            const scan = (layer, where, v) => {
                if (typeof v === 'string') {
                    for (const h of findWordReplaceHits(v, rules)) hits.push({ layer, where, ...h });
                } else if (Array.isArray(v)) v.forEach((x) => scan(layer, where, x));
                else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(layer, where, k), scan(layer, where, x);
            };
            for (let i = 0; i < E.results.length; i++) {
                const r = E.results[i];
                if (!r || r.status !== 'done') continue;
                const p = r.parsed || {};
                scan(i, '标题', p.title);
                (r.finalParas || []).forEach((x) => scan(i, '正文', x));
                scan(i, '摘要', [p.summary, p.bigSummary]);
                scan(i, '世界书', p.worldbook);
                scan(i, '表格', r.tableActions || p.tableOps);
            }
            return { rules: lines.map((l, ri) => ({ text: l, count: hits.filter((h) => h.rule === ri).length })), hits };
        }

        /** 给第 i 层提前写提示词，处理到这层（包括重做）时一起发给 AI；空字符串就是删掉 */
        function setLayerNote(i, text) {
            const l = E.layers[i];
            if (!l) return;
            const t = String(text || '').trim();
            if (t) l.note = t;
            else delete l.note;
        }

        /** 剩余时间估算（毫秒）：最近 10 层的平均耗时 × 没跑完的层数；还没有跑完的层记过时间就返回 0 */
        function estimateRemaining() {
            const times = E.results.filter((r) => r && r.status === 'done' && r.ms > 0).map((r) => r.ms).slice(-10);
            if (!times.length) return 0;
            const left = E.layers.length - E.results.filter((r) => r && r.status === 'done').length;
            return Math.round((times.reduce((a, b) => a + b, 0) / times.length) * left);
        }

        /** 从第 i 层起全部重跑 */
        function resetFrom(i) {
            for (let k = i; k < E.results.length; k++) E.results[k] = null;
            E.reviewing = null;
        }

        /** 渲染所有已完成的层为楼层（称呼按最终称呼表统一替换） */
        /** opts.highlight：mark / color 时楼层正文（mes）里标出 AI 补充的字，floor.body 仍是干净的 */
        function renderFloors(opts = {}) {
            const done = [];
            for (let i = 0; i < E.layers.length; i++) {
                const r = E.results[i];
                if (!r || r.status !== 'done') break;
                done.push(i);
            }
            const st = replay(done.length);
            const conv = (s) => outText(s, st);
            let lastHeading = '';
            return done.map((i) => {
                const r = E.results[i];
                let heading = conv(formatHeading(E.layers[i], r.parsed.title, settings, E.stats.chapterUnit));
                // 原文标题模式下，一章被切成几层时后面的层沿用这一章的标题，免得章号跳成层号
                if (settings.titleMode === 'original' && !(E.layers[i].chapters || []).length && lastHeading) heading = lastHeading.replace(/（续）$/, '') + '（续）';
                lastHeading = heading;
                const parts = floorParts(i, r.finalParas);
                const layout = floorTagLayout(r, parts.extras);
                const floor = {
                    layer: i,
                    title: conv(r.parsed.title),
                    heading,
                    body: conv(parts.paras.join('\n')),
                    before: layout.before.map(conv),
                    extras: layout.after.map(conv),
                    tableEdit: settings.tablesEnabled ? renderTableEdit(r.tableActions || [], conv) : '',
                    divergenceStart: r.divergenceStart,
                    divergence: r.inDivergence,
                };
                floor.mes = buildFloorText(floor, settings);
                if (opts.highlight === 'mark' || opts.highlight === 'color') {
                    const m = markedBody(i);
                    if (m && stripMarks(m) === floor.body && /\uE000/.test(m)) floor.mes = buildFloorText({ ...floor, body: marksToHtml(m, opts.highlight) }, settings);
                }
                return floor;
            });
        }

        /**
         * 某层正文，AI 补充的地方用 MARK_OPEN/MARK_CLOSE 包起来，给界面高亮用。
         * 补丁层标出每条补充；整层改写的层标出原文里没有的段落；翻译层不标（返回 null）。
         * 去掉标记后和 renderFloors 里的 body 一致。
         */
        function markedBody(i) {
            const r = E.results[i];
            const layer = E.layers[i];
            if (!r || r.status !== 'done' || !layer) return null;
            // 用「立即应用」改过存档的层，标记版也照样换一遍，才对得上
            const appliedRules = r.appliedReplace ? parseWordReplace(r.appliedReplace) : [];
            const applied = (arr) => (appliedRules.length ? arr.map((p) => applyWordReplace(p, appliedRules)) : arr);
            let paras;
            const mt = r.parsed && r.parsed.markedText;
            if (r.patchStats && r.patchStats.rewritten && mt) {
                // 独占一行的标记并到相邻行，免得分段时多出只有标记的空段
                const conv = mt.replace(/(^|\n)[ \t]*⟪[ \t]*\n/g, '$1⟪').replace(/\n[ \t]*⟫[ \t]*(?=\n|$)/g, '⟫').replace(/⟪/g, MARK_OPEN).replace(/⟫/g, MARK_CLOSE);
                const marked = applied(ensureImageMarkers(layer.paras, splitParagraphs(conv)));
                if (stripMarks(marked.join('\n')) === r.finalParas.join('\n')) paras = marked;
            }
            if (paras) {
                /* 用 AI 标的 */
            } else if (r.patchStats && r.patchStats.rewritten) {
                if (r.patchStats.translated || layer.translate) return null;
                const norm = (t) => String(t).replace(/\s+/g, '');
                const orig = new Set(layer.paras.map((p) => norm(p.text)));
                paras = r.finalParas.map((t) => (orig.has(norm(t)) || !norm(t) ? t : MARK_OPEN + t + MARK_CLOSE));
            } else {
                paras = applied(applyPatches(layer.paras, (r.parsed && r.parsed.patches) || [], { maxPatchChars: settings.maxPatchChars, mark: true }).paras);
                if (stripMarks(paras.join('\n')) !== r.finalParas.join('\n')) return null;
            }
            let n = 0;
            while (n < E.layers.length && E.results[n] && E.results[n].status === 'done') n++;
            const st = replay(n);
            return outText(bodyParas(i, paras).join('\n'), st);
        }

        /** 导出时按文字替换的主角称呼；交给 AI 写 {{user}} 时不再硬换，免得别人同名、同字被误换 */
        function textAliases(st) {
            return aiUserName(settings) ? [] : st.aliases;
        }

        /** 导出前的最后一步：主角称呼替换 + 用户的词语替换 */
        function outText(s, st) {
            return applyWordReplace(applyAliases(s, textAliases(st), aliasTargetOf(settings)), textReplaceRules(settings));
        }

        /** 楼层正文的段落：章节标题行换成 <bt> 格式 */
        function bodyParas(i, paras) {
            return floorParts(i, paras).paras;
        }

        /** 设置里要额外放进楼层的标签：从这层 AI 的原始回复里取（已经从正文里挪出来的不重复放） */
        function floorTagBlocks(r, have, list) {
            const out = [];
            for (const tag of splitTagList(list)) {
                if (tag === settings.titleTag || tag === settings.bodyTag) continue;
                if (have.some((x) => x.startsWith(`<${tag}>`))) continue;
                const x = extractTag(r.raw, tag);
                if (x.closed && x.content) out.push(`<${tag}>\n${x.content}\n</${tag}>`);
            }
            return out;
        }

        /** 楼层里正文前、正文后各放哪些标签块：「放正文前面」里写了的标签（包括从正文里挪出来的）放前面 */
        function floorTagLayout(r, extras) {
            const beforeNames = splitTagList(settings.floorTagsBefore);
            const isBefore = (x) => beforeNames.some((t) => x.startsWith(`<${t}>`));
            const before = extras.filter(isBefore);
            const after = extras.filter((x) => !isBefore(x));
            return {
                before: before.concat(floorTagBlocks(r, extras, settings.floorTagsBefore)),
                after: after.concat(floorTagBlocks(r, extras, settings.floorTags)),
            };
        }

        /** 楼层正文拆成：正文段落（别的标签块拿掉）+ 拿出来的标签块 */
        function floorParts(i, paras) {
            const layer = E.layers[i];
            const split = splitBodyBlocks(paras.join('\n'), settings.bodyTag);
            const clean = split.body.split('\n').filter((l) => stripMarks(l).trim().length > 0);
            const dropFirst = settings.titleMode === 'original' && !!(layer.chapters || []).length;
            return { paras: fixSeparators(formatBodyHeadings(clean, settings, E.stats.chapterUnit, { dropFirst }), settings.titleTag), extras: split.extras };
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
                aliases: textAliases(st),
                target,
                replace: textReplaceRules(settings),
                plotEntries: plot,
                plot: { position: settings.plotPosition, depth: settings.plotDepth, order: settings.plotOrder },
            });
        }

        function exportTables() {
            const st = finalState();
            if (!st.tables) return [];
            return st.tables.template.tables.map((tb, i) => ({
                name: tb.name,
                data: [tb.columns, ...st.tables.rows[i].map((r) => r.map((c) => outText(c, st)))],
            }));
        }

        /** 主角的人设：优先「定位=主角」的角色条目，其次条目名或关键词等于主角原名 */
        function exportPersona() {
            const st = finalState();
            const target = aliasTargetOf(settings);
            const chars = st.worldbook.角色 || {};
            const name = protagonistOf(settings, st);
            let hit = Object.entries(chars).find(([, e]) => e.定位 === '主角');
            if (!hit && name) hit = Object.entries(chars).find(([n, e]) => n === name || (e.关键词 || []).includes(name));
            if (!hit) hit = Object.entries(chars).find(([n, e]) => n === target || (e.关键词 || []).includes(target));
            if (!hit) return { name: target, description: '' };
            return { name: target, description: outText(hit[1].内容, st) };
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
            const conv = (x) => applyAliases(x, textAliases(st), target);
            const sums = st.summaries.map((x) => `- 第${x.layer + 1}层 ${conv(x.title)}：${conv(x.summary)}`).join('\n');
            const heroines = listHeroines().map(conv).join('、') || '（无）';
            const prompt = `下面是一部小说已导入部分的分层摘要。主角在聊天里叫「${target}」。请写角色卡信息：
<简介>200 到 400 字的作品简介：世界观、主角处境、主要人物（${heroines}），不剧透结局</简介>
<场景>一句话说明聊天的场景：这是按原著逐层导入的小说正文，${target} 是主角</场景>

## 分层摘要
${sums}`;
            return { prompt, messages: buildMessages(prompt) };
        }

        async function generateCardInfo() {
            const req = buildCardInfoRequest();
            const raw = addUsage(null, req.messages, await cfg.callModel(req.messages, { layer: -1, attempt: 0, prompt: req.prompt, purpose: 'card' }));
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
            redoWithPrompt,
            redoWithFeedback,
            regenJson,
            applyReplaceToResults,
            previewReplaceInResults,
            setLayerNote,
            rerollLayer,
            estimateRemaining,
            resetFrom,
            replay,
            renderFloors,
            markedBody,
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

    // ============================================
    // 酒馆预设（条目可开关、排序、编辑；和柏宝绘的重型提示词同一套规则）
    // ============================================

    // 每层提示词的占位条目，相当于酒馆预设里「聊天记录」的位置
    const PRESET_SLOT_ID = 'nim-layer-prompt';

    function presetSlotEntry() {
        return { id: PRESET_SLOT_ID, name: '本层提示词（小说正文和任务）', role: 'user', content: '', enabled: true, position: 'relative', depth: 0, order: 100 };
    }

    function presetDefaults() {
        return { name: '', entries: [presetSlotEntry()], squash: false };
    }

    const normRole = (v) => (v === 'user' || v === 'assistant' ? v : 'system');
    const finiteInt = (v, fb, min = 0) => {
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fb;
    };

    function normalizePresetEntry(id, e) {
        return {
            id,
            name: typeof e.name === 'string' ? e.name : id,
            role: normRole(e.role),
            content: typeof e.content === 'string' ? e.content : '',
            enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
            position: e.position === 'depth' ? 'depth' : 'relative',
            depth: finiteInt(e.depth, 4),
            order: finiteInt(e.order, 100, Number.MIN_SAFE_INTEGER),
        };
    }

    /** 设置兜底：占位条目缺了补到末尾、重复的只留一个（旧版存的 extras 不再保留） */
    function normalizePreset(raw) {
        const r = raw && typeof raw === 'object' ? raw : {};
        const seen = new Set();
        const entries = [];
        for (const e of Array.isArray(r.entries) ? r.entries : []) {
            if (!e || typeof e !== 'object') continue;
            const id = typeof e.id === 'string' && e.id ? e.id : '';
            if (!id || seen.has(id)) continue;
            seen.add(id);
            entries.push(id === PRESET_SLOT_ID ? presetSlotEntry() : normalizePresetEntry(id, e));
        }
        if (!seen.has(PRESET_SLOT_ID)) entries.push(presetSlotEntry());
        return { name: typeof r.name === 'string' ? r.name : '', entries, squash: r.squash === true };
    }

    /** 旧版的消息链（{role, content, enabled}，{PROMPT} 处放提示词）转成条目 */
    function presetFromMessageChain(chain) {
        const entries = [];
        let slot = false;
        (Array.isArray(chain) ? chain : []).forEach((m, i) => {
            const content = String((m && m.content) || '');
            if (!slot && content.includes('{PROMPT}')) {
                const [before, after] = content.split('{PROMPT}');
                if (before.trim()) entries.push(normalizePresetEntry(`nim-chain-${i}a`, { name: `消息 ${i + 1}（前半）`, role: m.role, content: before.trim(), enabled: m.enabled !== false }));
                entries.push(presetSlotEntry());
                if ((after || '').trim()) entries.push(normalizePresetEntry(`nim-chain-${i}b`, { name: `消息 ${i + 1}（后半）`, role: m.role, content: after.trim(), enabled: m.enabled !== false }));
                slot = true;
            } else if (content.trim()) {
                entries.push(normalizePresetEntry(`nim-chain-${i}`, { name: `消息 ${i + 1}`, role: m.role, content, enabled: m.enabled !== false }));
            }
        });
        return normalizePreset({ entries });
    }

    /** 和 TXT转世界书 一样取酒馆列表：全局的 100001，没有就取最后一份（酒馆最后存的那份）；提示词管理器导出的是平铺的一份 */
    function pickPromptOrder(raw) {
        if (!Array.isArray(raw) || !raw.length) return null;
        if (raw.every((x) => x && typeof x === 'object' && 'identifier' in x)) return raw;
        const lists = raw.filter((x) => x && typeof x === 'object' && Array.isArray(x.order));
        const g = lists.find((x) => Number(x.character_id) === 100001) || lists[lists.length - 1];
        return g ? g.order : null;
    }

    /**
     * 解析酒馆聊天补全预设（整份预设，或提示词管理器单独导出的 {data:{prompts, prompt_order}}）。
     * 和 TXT转世界书 一样只按酒馆的条目列表（prompt_order）走，顺序和开关跟酒馆里看到的一致；
     * 条目库里有、列表里没放的条目酒馆里看不到也不发送，这里同样不导入（没有 prompt_order 时按 prompts 原顺序）；
     * 角色卡、世界书等标记条目不导入；「聊天记录」换成本层提示词。
     */
    function parseSTPreset(json) {
        const root = json && typeof json === 'object' ? json : null;
        const data = root && root.data && typeof root.data === 'object' ? root.data : root;
        const prompts = data && data.prompts;
        if (!Array.isArray(prompts) || !prompts.length) throw new Error('没有找到预设条目（prompts），请导入酒馆的聊天补全预设 JSON');
        const byId = new Map();
        for (const p of prompts) if (p && typeof p.identifier === 'string' && p.identifier && !byId.has(p.identifier)) byId.set(p.identifier, p);
        const order = pickPromptOrder(data.prompt_order);
        const seq = [];
        const placed = new Set();
        for (const it of order || []) {
            const id = it && typeof it.identifier === 'string' ? it.identifier : '';
            if (!id || placed.has(id) || !byId.has(id)) continue;
            placed.add(id);
            seq.push({ id, enabled: typeof it.enabled === 'boolean' ? it.enabled : true });
        }
        if (!order) for (const id of byId.keys()) if (!placed.has(id)) seq.push({ id, enabled: null });
        const toEntry = (id, p, enabled) => {
            const self = typeof p.enabled === 'boolean' ? p.enabled : true;
            return {
                id,
                name: typeof p.name === 'string' && p.name.trim() ? p.name : id,
                role: normRole(p.role),
                content: typeof p.content === 'string' ? p.content : '',
                enabled: enabled ?? self,
                position: Number(p.injection_position) === 1 ? 'depth' : 'relative',
                depth: finiteInt(p.injection_depth, 4),
                order: finiteInt(p.injection_order, 100, Number.MIN_SAFE_INTEGER),
            };
        };
        const entries = [];
        let slotPlaced = false;
        let droppedMarkers = 0;
        for (const { id, enabled } of seq) {
            const p = byId.get(id);
            if (id === 'chatHistory') {
                if (!slotPlaced) entries.push(presetSlotEntry());
                slotPlaced = true;
                continue;
            }
            if (p.marker === true || ST_MARKERS.includes(id)) {
                droppedMarkers++;
                continue;
            }
            entries.push(toEntry(id, p, enabled));
        }
        if (!slotPlaced) entries.push(presetSlotEntry());
        const imported = entries.filter((e) => e.id !== PRESET_SLOT_ID);
        const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);
        return {
            entries,
            skipped: order ? byId.size - placed.size : 0,
            squash: data.squash_system_messages === true || root.squash_system_messages === true,
            promptCount: imported.length,
            enabledCount: imported.filter((e) => e.enabled).length,
            droppedMarkers,
            hadChatHistory: slotPlaced,
            params: { temperature: num(root.temperature), maxTokens: num(root.openai_max_tokens) ?? num(root.max_tokens) },
        };
    }

    /**
     * 按条目拼消息：相对条目按列表顺序，占位条目换成本层提示词；
     * 深度条目按酒馆规则插在本层提示词前后（深度 0 在最后，同深度按顺序从小到大，同顺序同身份合并）；
     * 关闭的、空的条目跳过；squash 时相邻的 system 合并。
     */
    function assemblePresetMessages(preset, prompt, substitute) {
        const sub = typeof substitute === 'function' ? substitute : (t) => t;
        const p = normalizePreset(preset);
        const live = p.entries
            .filter((e) => e.id === PRESET_SLOT_ID || e.enabled)
            .map((e) => (e.id === PRESET_SLOT_ID ? e : { ...e, content: sub(e.content) }))
            .filter((e) => e.id === PRESET_SLOT_ID || e.content.trim());
        const depthEntries = live.filter((e) => e.id !== PRESET_SLOT_ID && e.position === 'depth');
        // 和酒馆一样在倒序的「聊天」里按深度插入再翻回来；这里聊天只有本层提示词这一条
        const rev = [{ role: 'user', content: prompt }];
        let ins = 0;
        for (const depth of [...new Set(depthEntries.map((e) => e.depth))].sort((a, b) => a - b)) {
            const atDepth = depthEntries.filter((e) => e.depth === depth);
            for (const order of [...new Set(atDepth.map((e) => e.order))].sort((a, b) => b - a)) {
                const group = atDepth.filter((e) => e.order === order);
                const msgs = [];
                for (const role of ['system', 'user', 'assistant']) {
                    const content = group.filter((e) => e.role === role).map((e) => e.content).join('\n');
                    if (content) msgs.push({ role, content });
                }
                if (!msgs.length) continue;
                rev.splice(Math.min(depth + ins, rev.length), 0, ...msgs);
                ins += msgs.length;
            }
        }
        const chatBlock = rev.reverse();
        const ordered = [];
        for (const e of live) {
            if (e.id === PRESET_SLOT_ID) ordered.push(...chatBlock);
            else if (e.position === 'relative') ordered.push({ role: e.role, content: e.content });
        }
        if (!p.squash) return ordered;
        const out = [];
        for (const m of ordered) {
            const prev = out[out.length - 1];
            if (prev && prev.role === 'system' && m.role === 'system') prev.content += `\n\n${m.content}`;
            else out.push({ ...m });
        }
        return out;
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
        adPatternsFor,
        DEFAULT_INLINE_AD_PATTERNS,
        DEFAULT_REWRITE_PROMPT,
        DEFAULT_DIVERGENCE_RULES,
        DEFAULT_DIVERGENCE_DIRECTION,
        DEFAULT_WORLDBOOK_CATEGORIES,
        normalizeCategory,
        normalizeCategories,
        DEFAULT_TABLE_ROLES,
        OUTPUT_FORMAT,
        cnToInt,
        parseChapterTitle,
        detectChapterUnit,
        formatHeading,
        formatBodyHeadings,
        splitBodyBlocks,
        fixSeparators,
        parseWordReplace,
        applyWordReplace,
        marksToHtml,
        detectForeign,
        IMAGE_MARKER_RE,
        ensureImageMarkers,
        condenseMessageTemplate,
        normalizeGlossary,
        mergeGlossary,
        parseGlossaryLines,
        selectGlossary,
        buildOutputRules,
        tailText,
        splitTagList,
        outputRuleItems,
        stripEchoedSource,
        protagonistOf,
        aliasTargetOf,
        cleanCell,
        estimateTokens,
        normalizeText,
        cleanText,
        splitParagraphs,
        splitLayers,
        buildLayerPrompt,
        applyMessageChain,
        PRESET_SLOT_ID,
        presetDefaults,
        normalizePreset,
        presetFromMessageChain,
        parseSTPreset,
        assemblePresetMessages,
        extractTag,
        parseLooseJson,
        replaceTag,
        stripMarks,
        findWordReplaceHits,
        isPartialWbUpdate,
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
