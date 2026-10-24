// ============================================================
// novelImporter/stBridge.js - 小说导入改写：酒馆对接层
//
// 只做和酒馆打交道的事：存世界书、建角色卡、写聊天、打开聊天、
// 让记忆表格插件按楼层重建表格并核对结果、写用户人设。
// 挂到 window.NovelImporterST。
// ============================================================

(function (root) {
    'use strict';

    function ctx() {
        if (!root.SillyTavern || typeof root.SillyTavern.getContext !== 'function') throw new Error('找不到酒馆上下文');
        return root.SillyTavern.getContext();
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function humanDate(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
    }

    /** 存世界书文件（同名覆盖） */
    async function saveWorldbook(name, data) {
        const c = ctx();
        if (typeof c.saveWorldInfo === 'function') {
            await c.saveWorldInfo(name, data, true);
        } else {
            const resp = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: c.getRequestHeaders(),
                body: JSON.stringify({ name, data }),
            });
            if (!resp.ok) throw new Error(`保存世界书失败：HTTP ${resp.status}`);
        }
        if (typeof c.updateWorldInfoList === 'function') await c.updateWorldInfoList();
        return name;
    }

    function findCharacterIndex(avatar) {
        const list = ctx().characters || [];
        return list.findIndex((ch) => ch && ch.avatar === avatar);
    }

    /**
     * 新建角色卡并绑定世界书。世界书要先存好，酒馆建卡时会把它嵌进卡里。
     * @returns {Promise<string>} 角色卡文件名（avatar）
     */
    async function createCharacter(opts) {
        const c = ctx();
        const fd = new FormData();
        fd.append('ch_name', opts.name);
        fd.append('description', opts.description || '');
        fd.append('personality', '');
        fd.append('scenario', opts.scenario || '');
        fd.append('first_mes', opts.firstMes || '');
        fd.append('mes_example', '');
        fd.append('creator_notes', opts.creatorNotes || '由小说导入改写模块生成');
        fd.append('system_prompt', '');
        fd.append('post_history_instructions', '');
        fd.append('tags', '小说导入');
        fd.append('creator', '');
        fd.append('character_version', '1.0');
        fd.append('talkativeness', '0.5');
        fd.append('fav', 'false');
        fd.append('world', opts.worldName || '');
        fd.append('depth_prompt_prompt', '');
        fd.append('depth_prompt_depth', '4');
        fd.append('depth_prompt_role', 'system');
        const resp = await fetch('/api/characters/create', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: fd,
            cache: 'no-cache',
        });
        if (!resp.ok) throw new Error(`创建角色卡失败：HTTP ${resp.status}`);
        const avatar = (await resp.text()).trim();
        await c.getCharacters();
        return avatar;
    }

    /** 更新已有角色卡的简介和绑定的世界书（重新导入世界书时用） */
    async function updateCharacter(avatar, fields) {
        const c = ctx();
        const resp = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ avatar, ...fields }),
        });
        if (!resp.ok) throw new Error(`更新角色卡失败：HTTP ${resp.status}`);
        await c.getCharacters();
    }

    /** 把楼层写成聊天文件（新文件，不覆盖已有聊天） */
    async function saveChat(avatar, charName, fileName, chatArray) {
        const c = ctx();
        const resp = await fetch('/api/chats/save', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({
                ch_name: charName,
                file_name: fileName,
                chat: chatArray,
                avatar_url: avatar,
                force: true,
            }),
        });
        if (!resp.ok) throw new Error(`保存聊天失败：HTTP ${resp.status}`);
        return fileName;
    }

    async function openChat(avatar, fileName) {
        const c = ctx();
        const idx = findCharacterIndex(avatar);
        if (idx < 0) throw new Error(`找不到角色卡 ${avatar}`);
        if (String(c.characterId) !== String(idx)) {
            await c.selectCharacterById(idx);
            await sleep(500);
        }
        if (ctx().getCurrentChatId() !== fileName) {
            await ctx().openCharacterChat(fileName);
            await sleep(500);
        }
    }

    // ============================================
    // 记忆表格
    // ============================================

    function memoryPlugin() {
        const p = root.stMemoryEnhancement;
        return p && (typeof p.ext_getAllTables === 'function' || typeof p.ext_exportAllTablesAsJson === 'function') ? p : null;
    }

    function memorySettings() {
        const s = ctx().extensionSettings || {};
        return s.muyoo_dataTable || null;
    }

    /** 插件当前启用的表（名字和列），用来确认模板对得上 */
    function readPluginTables() {
        const p = memoryPlugin();
        if (!p) return null;
        try {
            return p.ext_getAllTables() || [];
        } catch (e) {
            // 部分插件版本的 ext_getAllTables 调用了不存在的 getBody，改用导出接口：content 每行第一格是行号格
            try {
                return Object.values(p.ext_exportAllTablesAsJson() || {}).map((t) => ({
                    name: t.name,
                    data: (t.content || []).map((row) => row.slice(1)),
                }));
            } catch (e2) {
                return null;
            }
        }
    }

    /**
     * 插件里每张表的填写说明（note / 初始化、插入、更新、删除的触发条件）。
     * 新版插件存在 power_user.table_database_templates[].cellHistory 的 sheet_origin 里，
     * 旧版存在 extension_settings.muyoo_dataTable.tableStructure 里。按表名返回。
     */
    function readPluginTemplateNotes() {
        const out = {};
        const pick = (d) => ({
            note: d.note || '',
            initNode: d.initNode || '',
            insertNode: d.insertNode || '',
            updateNode: d.updateNode || '',
            deleteNode: d.deleteNode || '',
        });
        try {
            const old = (memorySettings() || {}).tableStructure;
            if (Array.isArray(old)) for (const t of old) if (t && t.tableName) out[t.tableName] = pick(t);
        } catch (e) {
            /* 没有旧版设置 */
        }
        try {
            const tpls = (ctx().powerUserSettings || {}).table_database_templates;
            if (Array.isArray(tpls)) {
                for (const t of tpls) {
                    const origin = (t && Array.isArray(t.cellHistory) ? t.cellHistory : []).find((h) => h && h.type === 'sheet_origin');
                    if (t && t.name && origin && origin.data) out[t.name] = pick(origin.data);
                }
            }
        } catch (e) {
            /* 没有新版模板 */
        }
        return out;
    }

    /** 插件设置里的「消息模板」（给 AI 说明怎么用表格、怎么改表格的那段，带 {{tableData}}） */
    function readMessageTemplate() {
        const s = memorySettings();
        return (s && typeof s.message_template === 'string' && s.message_template) || '';
    }

    /**
     * 酒馆现在开着的世界书：全局选中的、当前角色绑定的（含附加的）、聊天绑定的、人设绑定的。
     * 返回 [{name, source}]，同名只留一个。
     */
    async function listActiveWorldbooks() {
        const c = ctx();
        const out = [];
        const add = (name, source) => {
            const n = typeof name === 'string' ? name.trim() : '';
            if (n && !out.some((x) => x.name === n)) out.push({ name: n, source });
        };
        let wi = null;
        try {
            wi = await import('/scripts/world-info.js');
        } catch (e) {
            /* 拿不到模块就只看上下文 */
        }
        const globalList = (wi && wi.selected_world_info) || c.selected_world_info || root.selected_world_info || [];
        for (const n of Array.isArray(globalList) ? globalList : []) add(n, '全局');
        const ch = c.characterId !== undefined && c.characters ? c.characters[c.characterId] : null;
        if (ch) {
            add(ch.data && ch.data.extensions && ch.data.extensions.world, '角色');
            const file = String(ch.avatar || '').replace(/\.[^.]+$/, '');
            const extra = wi && wi.world_info && Array.isArray(wi.world_info.charLore) ? wi.world_info.charLore.find((x) => x.name === file) : null;
            for (const n of (extra && extra.extraBooks) || []) add(n, '角色');
        }
        const meta = c.chatMetadata || c.chat_metadata || {};
        add(meta.world_info, '聊天');
        add(c.powerUserSettings && c.powerUserSettings.persona_description_lorebook, '人设');
        return out;
    }

    /** 读一本世界书的条目（世界书文件里的 entries 对象） */
    async function loadWorldbookEntries(name) {
        const c = ctx();
        let data = null;
        if (typeof c.loadWorldInfo === 'function') data = await c.loadWorldInfo(name);
        else {
            const resp = await fetch('/api/worldinfo/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ name }) });
            if (resp.ok) data = await resp.json();
        }
        return (data && data.entries) || {};
    }

    /** 上传一张图到 user/images/<角色名>/，返回酒馆里的路径 */
    async function uploadImage(chName, filename, base64, format) {
        const c = ctx();
        const resp = await fetch('/api/images/upload', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ image: base64, format, ch_name: chName, filename }),
        });
        if (!resp.ok) throw new Error(`上传插图失败：HTTP ${resp.status}`);
        const j = await resp.json();
        return j.path;
    }

    /** 模板表名、列数和插件里的是否一致；不一致时行号会错位 */
    function checkTemplate(expected) {
        const live = readPluginTables();
        if (!live) return { ok: false, reason: '没有检测到记忆表格插件（st-memory-enhancement）' };
        if (!live.length) return { ok: true, unknown: true };
        const problems = [];
        if (live.length !== expected.length) problems.push(`插件里启用了 ${live.length} 张表，模板里是 ${expected.length} 张`);
        expected.forEach((t, i) => {
            const l = live[i];
            if (!l) return;
            if (l.name !== t.name) problems.push(`第 ${i} 张表：插件里是「${l.name}」，模板里是「${t.name}」`);
            else if ((l.data[0] || []).length !== t.data[0].length) problems.push(`「${t.name}」列数不一致`);
        });
        return { ok: problems.length === 0, problems };
    }

    // 插件执行 <tableEdit> 前酒馆会替换宏，所以 {{user}} 在插件里是 user 的名字
    function normCell(v) {
        const c = ctx();
        return String(v ?? '')
            .replace(/\{\{user\}\}/gi, c.name1 || '')
            .replace(/\{\{char\}\}/gi, c.name2 || '')
            .trim();
    }

    /** 逐表比较插件里的结果和本模块逐层模拟的结果 */
    function compareTables(expected, live) {
        const diffs = [];
        for (const t of expected) {
            const l = (live || []).find((x) => x.name === t.name);
            if (!l) {
                diffs.push({ table: t.name, reason: '插件里没有这张表' });
                continue;
            }
            const a = t.data.slice(1);
            const b = (l.data || []).slice(1);
            if (a.length !== b.length) {
                diffs.push({ table: t.name, reason: `行数不同：应为 ${a.length}，插件里是 ${b.length}` });
                continue;
            }
            for (let r = 0; r < a.length; r++) {
                const ra = a[r].map(normCell);
                const rb = (b[r] || []).map(normCell);
                const bad = ra.findIndex((v, k) => v !== (rb[k] ?? ''));
                if (bad >= 0) {
                    diffs.push({ table: t.name, reason: `第 ${r + 1} 行第 ${bad + 1} 列：应为「${ra[bad]}」，插件里是「${rb[bad] ?? ''}」` });
                    break;
                }
            }
        }
        return diffs;
    }

    /**
     * 让插件从第一层开始按顺序执行每层的 <tableEdit>。
     * 插件只在「消息被编辑」时执行旧楼层的表格指令，而且是基于上一层的表格，
     * 所以必须从前往后一层一层触发，并等每一层处理完。
     */
    async function rebuildTables(opts = {}) {
        const c = ctx();
        const ms = memorySettings();
        if (!memoryPlugin()) throw new Error('没有检测到记忆表格插件（st-memory-enhancement），无法重建表格');
        if (ms && ms.isExtensionAble === false) throw new Error('记忆表格插件处于关闭状态，请先在插件设置里开启');
        // 分步填表模式下插件会忽略消息编辑事件，重建期间临时关掉，结束后恢复
        const restore = {};
        if (ms) {
            for (const [k, v] of [['step_by_step', false], ['isAiWriteTable', true]]) {
                if (ms[k] !== v) {
                    restore[k] = ms[k];
                    ms[k] = v;
                }
            }
        }
        // 插件每执行一层都会 console.log 整个聊天和全部表格；开着开发者工具时这些对象不会被回收，
        // 上千层时内存一路涨到页面崩溃。重建期间先把普通日志静音，结束后恢复
        const quiet = opts.quietConsole !== false && root.console;
        const saved = quiet ? { log: root.console.log, info: root.console.info, debug: root.console.debug } : null;
        if (quiet) root.console.log = root.console.info = root.console.debug = () => {};
        try {
            const chat = c.chat;
            const total = chat.length;
            for (let i = 0; i < total; i++) {
                if (opts.shouldStop && opts.shouldStop()) throw new Error('已停止');
                if (chat[i].is_user) continue;
                // 清掉插件的去重标记，确保这一层会被重新执行
                delete chat[i].tableEditMatches;
                await c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, i);
                if (opts.onProgress) opts.onProgress(i + 1, total);
                if (i % 20 === 19) await sleep(0);
            }
            await c.saveChat();
        } finally {
            if (saved) Object.assign(root.console, saved);
            Object.assign(ms || {}, restore);
            if (Object.keys(restore).length && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        }
        const live = readPluginTables();
        const diffs = opts.expected ? compareTables(opts.expected, live) : [];
        return { live, diffs, ok: diffs.length === 0 };
    }

    // ============================================
    // 用户人设
    // ============================================

    /** 把主角人设写进当前用户人设的描述（会覆盖原描述，调用前要让用户确认） */
    async function writePersonaDescription(description) {
        const c = ctx();
        const pu = c.powerUserSettings;
        if (!pu) throw new Error('找不到用户人设设置');
        let avatar = '';
        try {
            const mod = await import('/scripts/personas.js');
            avatar = mod.user_avatar || '';
        } catch (e) {
            /* 拿不到当前头像就只改全局描述 */
        }
        pu.persona_description = description;
        if (avatar) {
            pu.persona_descriptions = pu.persona_descriptions || {};
            pu.persona_descriptions[avatar] = { ...(pu.persona_descriptions[avatar] || {}), description };
        }
        const desc = root.document && root.document.getElementById('persona_description');
        if (desc) desc.value = description;
        c.saveSettingsDebounced();
        return avatar;
    }

    function currentUserName() {
        try {
            return ctx().name1 || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * 一键导入：存世界书 → 建卡绑世界书 → 写聊天 → 打开 → 重建表格 → 核对。
     * @param {object} p {cardName, worldName, worldbook, description, scenario, chatArray, expectedTables, onStep, onProgress}
     */
    async function importAll(p) {
        const step = p.onStep || (() => {});
        step('保存世界书');
        await saveWorldbook(p.worldName, p.worldbook);
        let avatar = p.avatar;
        if (avatar && findCharacterIndex(avatar) >= 0) {
            step('更新角色卡');
            await updateCharacter(avatar, {
                description: p.description || '',
                scenario: p.scenario || '',
                data: { description: p.description || '', scenario: p.scenario || '', extensions: { world: p.worldName } },
            });
        } else {
            step('创建角色卡');
            avatar = await createCharacter({ name: p.cardName, description: p.description, scenario: p.scenario, worldName: p.worldName });
        }
        const fileName = p.chatFileName || `${p.cardName} - 导入 ${humanDate(new Date())}`;
        step('写入聊天');
        await saveChat(avatar, p.cardName, fileName, p.chatArray);
        step('打开聊天');
        // 先把角色卡的当前聊天指向导入的聊天，选中角色时就不会再自动新建一个空聊天
        await updateCharacter(avatar, { chat: fileName });
        await openChat(avatar, fileName);
        let tables = null;
        if (p.rebuildTables !== false && p.expectedTables && p.expectedTables.length) {
            step('重建记忆表格');
            const tpl = checkTemplate(p.expectedTables);
            if (!tpl.ok && !tpl.unknown) throw new Error('记忆表格模板对不上：' + (tpl.reason || tpl.problems.join('；')));
            tables = await rebuildTables({ expected: p.expectedTables, onProgress: p.onProgress, shouldStop: p.shouldStop });
        }
        return { avatar, fileName, tables };
    }

    root.NovelImporterST = {
        ctx,
        saveWorldbook,
        listActiveWorldbooks,
        loadWorldbookEntries,
        createCharacter,
        updateCharacter,
        saveChat,
        openChat,
        readPluginTables,
        readPluginTemplateNotes,
        readMessageTemplate,
        uploadImage,
        checkTemplate,
        compareTables,
        rebuildTables,
        writePersonaDescription,
        currentUserName,
        memorySettings,
        importAll,
    };
})(typeof window !== 'undefined' ? window : globalThis);
