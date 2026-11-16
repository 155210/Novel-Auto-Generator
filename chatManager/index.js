/*
 * 聊天记录管家（文件转换工具的子模块，入口在「📚 文件转换工具」面板里）
 * 按角色卡管理 SillyTavern 聊天记录/分支：搜索、预览、批量删除（带回收站）、导出、重命名；
 * 并在酒馆自带的「聊天记录」面板里加「多选」删除。
 *
 * 不 import 酒馆内部模块，只用全局 SillyTavern.getContext()，以兼容不同版本和安装路径。
 * 所有文件操作都走酒馆自带接口（/api/characters/chats、/api/chats/get|save|delete|rename|search）。
 */
(function () {
    'use strict';
    // 同时装了独立版 st-chat-manager 时只启用先加载的那一份
    if (window.STChatManager) return;
    window.STChatManager = { open: () => { } };

    const EXT = 'st-chat-manager';
    const TRASH_AVATAR = '_stcm_trash_.png'; // 回收站 = chats/_stcm_trash_/ 目录
    const LOG = '[聊天记录管家]';
    // 与服务端 sanitize-filename 一致的非法字符；含这些字符的文件名服务端会改写后再定位文件，可能指向别的文件
    const ILLEGAL_RE = /[\/\?<>\\:\*\|"\u0000-\u001f\u0080-\u009f]/;
    const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

    const defaults = { sortKey: 'time', sortDesc: true, tree: true, useTrash: true, pageSize: 30 };

    const S = {
        root: null,
        open: false,
        busy: false,
        sel: null,            // 选中的角色 { avatar, name }
        chats: [],            // 当前角色的聊天列表
        loadedFor: null,
        loading: false,
        loadError: '',
        hasMeta: false,
        checked: new Set(),   // 选中的文件名（含 .jsonl）
        filter: '',
        contentHits: null,    // null 或 { query, ids:Set }
        counts: new Map(),    // avatar -> 聊天数量
        simpleOk: null,       // 服务端是否支持 simple 列表
        countRun: 0,
        view: 'list',         // list | preview | trash
        pv: null,
        trash: { items: [], checked: new Set(), loading: false },
        reqSeq: 0,
    };

    // ---------------------------------------------------------------- 基础工具
    const ctx = () => window.SillyTavern.getContext();

    function settings() {
        const c = ctx();
        const store = c.extensionSettings || c.extension_settings || {};
        if (!store[EXT]) store[EXT] = {};
        for (const k of Object.keys(defaults)) if (store[EXT][k] === undefined) store[EXT][k] = defaults[k];
        return store[EXT];
    }
    function saveSettings() {
        try { const c = ctx(); (c.saveSettingsDebounced || (() => { }))(); } catch (e) { /* ignore */ }
    }

    function h(tag, attrs, ...kids) {
        const el = document.createElement(tag);
        if (attrs) for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids.flat()) {
            if (kid === null || kid === undefined || kid === false) continue;
            el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
        }
        return el;
    }

    async function post(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify(body),
            cache: 'no-cache',
        });
        if (!res.ok) {
            const err = new Error(`${url} 返回 ${res.status}`);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        try { return JSON.parse(text); } catch (e) { return text; }
    }

    function parseSize(s) {
        if (typeof s === 'number') return s;
        const m = /([\d.]+)\s*([a-zA-Z]*)/.exec(String(s || ''));
        if (!m) return 0;
        const u = m[2].toLowerCase();
        const mul = u.startsWith('k') ? 1024 : u.startsWith('m') ? 1048576 : u.startsWith('g') ? 1073741824 : 1;
        return Math.round(parseFloat(m[1]) * mul);
    }
    function fmtSize(n) {
        if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + 'MB';
        if (n >= 1024) return Math.round(n / 1024) + 'KB';
        return n + 'B';
    }
    function parseTime(v) {
        if (typeof v === 'number') return v;
        if (!v) return 0;
        const s = String(v);
        if (/^\d{10,}$/.test(s)) return Number(s);
        // 酒馆旧格式 2024-5-1@12h30m05s / 2024-05-01 @12h 30m 05s 123ms
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s/.exec(s);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        const t = Date.parse(s);
        return Number.isNaN(t) ? 0 : t;
    }
    function fmtTime(ms) {
        if (!ms) return '时间未知';
        const d = new Date(ms), p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function fmtAgo(ms) {
        if (!ms) return '';
        const diff = Date.now() - ms;
        if (diff < 0) return '';
        const day = Math.floor(diff / 86400000);
        if (day >= 365) return Math.floor(day / 365) + '年前';
        if (day >= 30) return Math.floor(day / 30) + '个月前';
        if (day >= 1) return day + '天前';
        const hr = Math.floor(diff / 3600000);
        return hr >= 1 ? hr + '小时前' : '刚刚';
    }

    function unsafeNameReason(base) {
        if (ILLEGAL_RE.test(base)) return '文件名含特殊字符（/ ? < > \\ : * | " 或控制字符）';
        if (RESERVED_RE.test(base)) return '文件名是系统保留名';
        if (/[. ]+$/.test(base)) return '文件名以点或空格结尾';
        if (new TextEncoder().encode(base).length > 255) return '文件名过长';
        if (!base || base === '.' || base === '..') return '文件名无效';
        return '';
    }

    function download(name, text) {
        const blob = new Blob([text], { type: 'application/octet-stream' });
        const a = h('a', { href: URL.createObjectURL(blob), download: name, style: 'display:none' });
        document.body.append(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    }

    // ---------------------------------------------------------------- 酒馆状态
    function currentInfo() {
        const c = ctx();
        if (c.groupId) return { group: true };
        const id = c.characterId;
        if (id === undefined || id === null || id === '') return {};
        const ch = c.characters[id];
        if (!ch) return {};
        return { avatar: ch.avatar, name: ch.name, chat: ch.chat, index: Number(id) };
    }
    function charByAvatar(avatar) {
        return ctx().characters.find(c => c.avatar === avatar);
    }
    /** 该聊天是否是酒馆此刻正打开着的聊天（受保护，不能删/改名） */
    function isOpenChat(avatar, id) {
        const cur = currentInfo();
        return !!cur.avatar && cur.avatar === avatar && cur.chat === id;
    }
    /** 该聊天是否是某（未打开的）角色上次停留的聊天 */
    function isLastChat(avatar, id) {
        const ch = charByAvatar(avatar);
        return !!ch && ch.chat === id && !isOpenChat(avatar, id);
    }
    function thumb(avatar) {
        try {
            const c = ctx();
            if (typeof c.getThumbnailUrl === 'function') return c.getThumbnailUrl('avatar', avatar);
        } catch (e) { /* ignore */ }
        return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
    }

    // ---------------------------------------------------------------- 接口封装
    function normalize(raw) {
        const file = String(raw.file_name || '');
        const id = raw.file_id !== undefined ? String(raw.file_id) : file.replace(/\.jsonl$/i, '');
        const meta = raw.chat_metadata && typeof raw.chat_metadata === 'object' ? raw.chat_metadata : null;
        const mesText = String(raw.mes ?? '');
        return {
            file, id,
            sizeText: String(raw.file_size ?? ''),
            size: parseSize(raw.file_size),
            count: Number(raw.chat_items ?? 0),
            last: parseTime(raw.last_mes),
            preview: mesText.slice(0, 300),
            dupKey: `${Number(raw.chat_items ?? 0)}|${raw.file_size}|${mesText.length}|${mesText.slice(0, 200)}|${mesText.slice(-200)}`,
            meta,
            parent: meta && typeof meta.main_chat === 'string' ? meta.main_chat : '',
        };
    }
    function toArray(r) {
        if (Array.isArray(r)) return r;
        if (r && typeof r === 'object' && !r.error) return Object.values(r).filter(x => x && typeof x === 'object');
        return [];
    }
    /** 完整列表（服务端会逐个扫描文件，较慢但信息全） */
    async function listChats(avatar) {
        const r = await post('/api/characters/chats', { avatar_url: avatar, metadata: true });
        return toArray(r).filter(x => x.file_name).map(normalize);
    }
    /** 仅文件名集合（新版酒馆很快；旧版会退化为完整扫描，结果一样可靠） */
    async function listNames(avatar) {
        const r = await post('/api/characters/chats', { avatar_url: avatar, simple: true });
        const arr = toArray(r).filter(x => x.file_name);
        if (arr.length && S.simpleOk === null) S.simpleOk = !('chat_items' in arr[0]);
        return new Set(arr.map(x => String(x.file_name)));
    }
    async function readChat(avatar, id) {
        const r = await post('/api/chats/get', { avatar_url: avatar, file_name: id });
        return Array.isArray(r) ? r : [];
    }
    function isHeader(line) {
        return !!line && typeof line === 'object' && ('chat_metadata' in line || ('user_name' in line && 'character_name' in line && !('mes' in line)));
    }
    async function writeChat(avatar, id, data) {
        // 目录不存在时 /chats/get 会创建它（各版本通用）
        await post('/api/chats/get', { avatar_url: avatar, file_name: '' });
        const r = await post('/api/chats/save', { avatar_url: avatar, file_name: id, chat: data, force: true });
        if (!r || r.ok !== true) throw new Error('保存接口未返回成功');
    }
    async function deleteFile(avatar, file) {
        const r = await post('/api/chats/delete', { avatar_url: avatar, chatfile: file });
        if (!r || r.ok !== true) throw new Error('删除接口未返回成功');
    }

    // ---------------------------------------------------------------- 删除 / 回收站核心
    /**
     * 把一个聊天完整复制进回收站并回读校验。失败会抛错，且不会动原文件。
     * @returns {Promise<string>} 回收站里的文件 id
     */
    async function copyToTrash(avatar, item) {
        const data = await readChat(avatar, item.id);
        if (!data.length) throw new Error('读取原文件失败或文件为空，未做任何改动');
        const copy = JSON.parse(JSON.stringify(data));
        let noHeader = false;
        if (!isHeader(copy[0])) {
            copy.unshift({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
            noHeader = true;
        }
        const ch = charByAvatar(avatar);
        copy[0].chat_metadata = Object.assign({}, copy[0].chat_metadata || {}, {
            stcm_trash: { avatar, name: item.id, charName: ch ? ch.name : '', deletedAt: Date.now(), noHeader },
        });
        const trashId = `T${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await writeChat(TRASH_AVATAR, trashId, copy);
        const back = await readChat(TRASH_AVATAR, trashId);
        const same = back.length === copy.length
            && JSON.stringify(back.slice(1)) === JSON.stringify(noHeader ? data : data.slice(1));
        if (!same) {
            try { await deleteFile(TRASH_AVATAR, trashId + '.jsonl'); } catch (e) { /* ignore */ }
            throw new Error('回收站副本校验不一致，已中止，原文件未动');
        }
        return trashId;
    }

    /**
     * 删除一批聊天。逐个顺序执行，遇到任何错误立刻停下。
     * @returns {Promise<{done:string[], failed:{file:string,reason:string}[], skipped:string[]}>}
     */
    async function removeChats(avatar, items, permanent, onProgress) {
        const result = { done: [], failed: [], skipped: [] };
        const sent = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            onProgress && onProgress(i, items.length, it);
            try {
                if (avatar !== TRASH_AVATAR && isOpenChat(avatar, it.id)) throw new Error('这是当前正打开的聊天，已保护');
                const bad = unsafeNameReason(it.file);
                if (bad) throw new Error(bad + '，为避免误删其它文件已拒绝，请到文件管理器手动处理');
                if (!permanent && avatar !== TRASH_AVATAR) await copyToTrash(avatar, it);
                await deleteFile(avatar, it.file);
                sent.push(it);
            } catch (e) {
                result.failed.push({ file: it.file, reason: e.message || String(e) });
                for (const rest of items.slice(i + 1)) result.skipped.push(rest.file);
                break;
            }
        }
        // 最终核对：重新读目录，确认文件真的从磁盘上消失了
        if (sent.length) {
            let names = null;
            try { names = await listNames(avatar); } catch (e) { /* 见下 */ }
            for (const it of sent) {
                if (!names) result.failed.push({ file: it.file, reason: '已发送删除，但无法重新读取目录来核对' });
                else if (names.has(it.file)) result.failed.push({ file: it.file, reason: '接口返回成功，但文件仍在磁盘上' });
                else result.done.push(it.file);
            }
        }
        return result;
    }

    /** 从回收站恢复一个聊天 */
    async function restoreOne(trashItem, fallbackAvatar) {
        const data = await readChat(TRASH_AVATAR, trashItem.id);
        if (!data.length) throw new Error('回收站文件读取失败');
        const info = (data[0] && data[0].chat_metadata && data[0].chat_metadata.stcm_trash) || {};
        let target = info.avatar && charByAvatar(info.avatar) ? info.avatar : fallbackAvatar;
        if (!target) throw new Error('原角色卡已不存在，请先在主界面选中一个角色再恢复（会恢复到该角色下）');
        const out = JSON.parse(JSON.stringify(data));
        if (out[0].chat_metadata) delete out[0].chat_metadata.stcm_trash;
        if (info.noHeader) out.shift();
        const names = await listNames(target);
        const base = info.name || trashItem.id;
        let name = base, n = 1;
        while (names.has(name + '.jsonl')) name = `${base} (恢复${n++})`;
        if (unsafeNameReason(name + '.jsonl')) throw new Error('原文件名不合法，无法恢复');
        await writeChat(target, name, out);
        const back = await readChat(target, name);
        if (back.length !== out.length || JSON.stringify(back) !== JSON.stringify(out)) {
            throw new Error('恢复后的文件校验不一致，回收站副本已保留');
        }
        await deleteFile(TRASH_AVATAR, trashItem.file);
        return { avatar: target, name };
    }

    // ---------------------------------------------------------------- 弹窗 / 提示
    function toast(msg, type) {
        if (!S.root || !S.open) {
            const t = window.toastr;
            if (t) (type === 'err' ? t.error : type === 'ok' ? t.success : t.info).call(t, msg, '聊天记录管家');
            return;
        }
        const box = S.root.querySelector('.stcm-toasts');
        const t = h('div', { class: 'stcm-toast ' + (type || ''), text: msg });
        box.append(t);
        setTimeout(() => t.remove(), type === 'err' ? 6000 : 2800);
    }
    function setBusy(text) {
        S.busy = !!text;
        const el = S.root && S.root.querySelector('.stcm-busy');
        if (!el) return;
        el.style.display = text ? 'flex' : 'none';
        el.querySelector('span').textContent = text || '';
    }
    /** 通用弹窗。buttons: [{text, value, cls, disabled}]；返回点击的 value（遮罩/取消为 null） */
    function dialog(title, body, buttons, setup) {
        return new Promise(resolve => {
            const close = v => { mask.remove(); resolve(v); };
            const btnEls = (buttons || [{ text: '知道了', value: true }]).map(b =>
                h('button', { class: 'stcm-btn ' + (b.cls || ''), disabled: !!b.disabled, 'data-v': String(b.value), onclick: () => close(b.value) }, b.text));
            const mask = h('div', { class: 'stcm-mask', onclick: e => { if (e.target === mask) close(null); } },
                h('div', { class: 'stcm-dialog' },
                    h('div', { class: 'stcm-dialog-title', text: title }),
                    h('div', { class: 'stcm-dialog-body' }, body),
                    h('div', { class: 'stcm-dialog-btns' }, btnEls)));
            S.root.append(mask);
            setup && setup({ close, btnEls, mask });
        });
    }
    function itemLine(it) {
        return h('div', { class: 'stcm-confirm-item' },
            h('div', { class: 'stcm-confirm-name', text: it.id }),
            h('div', { class: 'stcm-sub', text: `${it.count} 楼 · ${it.sizeText || fmtSize(it.size)} · ${fmtTime(it.last)}` }));
    }

    // ---------------------------------------------------------------- 列表加载与渲染
    async function loadChats(force) {
        if (!S.sel) { S.chats = []; renderList(); return; }
        const avatar = S.sel.avatar;
        const seq = ++S.reqSeq;
        S.loading = true; S.loadError = '';
        if (force || S.loadedFor !== avatar) { S.chats = []; }
        renderList();
        try {
            const list = await listChats(avatar);
            if (seq !== S.reqSeq) return;
            S.chats = list;
            S.loadedFor = avatar;
            S.hasMeta = list.some(x => x.meta);
            S.counts.set(avatar, list.length);
            const names = new Set(list.map(x => x.file));
            for (const f of [...S.checked]) if (!names.has(f)) S.checked.delete(f);
        } catch (e) {
            if (seq !== S.reqSeq) return;
            console.error(LOG, e);
            S.loadError = '读取聊天列表失败：' + (e.message || e);
        } finally {
            if (seq === S.reqSeq) { S.loading = false; renderHeader(); renderList(); }
        }
    }

    function selectChar(avatar) {
        const ch = charByAvatar(avatar);
        if (!ch) return;
        S.sel = { avatar: ch.avatar, name: ch.name };
        S.checked.clear();
        S.contentHits = null;
        S.filter = '';
        const inp = S.root.querySelector('.stcm-filter');
        if (inp) inp.value = '';
        renderHeader();
        loadChats(true);
    }

    function dupGroups() {
        const map = new Map();
        for (const c of S.chats) {
            const k = c.dupKey;
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(c);
        }
        return [...map.values()].filter(g => g.length > 1);
    }

    function isBranchLike(c) {
        return !!c.parent || /^(branch|checkpoint)\s*#\d+/i.test(c.id) || /(分支|检查点)\s*#\d+/.test(c.id);
    }

    function visibleChats() {
        const st = settings();
        const q = S.filter.trim().toLowerCase();
        let arr = S.chats.filter(c => {
            if (S.contentHits && !S.contentHits.ids.has(c.id)) return false;
            if (!q) return true;
            return c.id.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q);
        });
        const key = st.sortKey, dir = st.sortDesc ? -1 : 1;
        const cmp = (a, b) => {
            let d = 0;
            if (key === 'time') d = a.last - b.last;
            else if (key === 'count') d = a.count - b.count;
            else if (key === 'size') d = a.size - b.size;
            else d = a.id.localeCompare(b.id, 'zh');
            return d * dir || a.id.localeCompare(b.id);
        };
        arr.sort(cmp);
        const rows = arr.map(c => ({ c, depth: 0 }));
        if (!st.tree || !S.hasMeta) return rows;
        // 树状：分支挂到父聊天下面（父聊天不在当前显示范围内的仍排在顶层）
        const byId = new Map(arr.map(c => [c.id, c]));
        const kids = new Map();
        const roots = [];
        for (const c of arr) {
            if (c.parent && c.parent !== c.id && byId.has(c.parent)) {
                if (!kids.has(c.parent)) kids.set(c.parent, []);
                kids.get(c.parent).push(c);
            } else roots.push(c);
        }
        const out = [], seen = new Set();
        const walk = (c, depth) => {
            if (seen.has(c.id)) return;
            seen.add(c.id);
            out.push({ c, depth });
            for (const k of kids.get(c.id) || []) walk(k, depth + 1);
        };
        roots.forEach(r => walk(r, 0));
        for (const c of arr) if (!seen.has(c.id)) walk(c, 0); // 循环引用兜底
        return out;
    }

    function renderHeader() {
        if (!S.root) return;
        const cur = currentInfo();
        const box = S.root.querySelector('.stcm-charbar');
        box.replaceChildren();
        if (S.sel) {
            const isCur = cur.avatar === S.sel.avatar;
            box.append(
                h('button', { class: 'stcm-charbtn', onclick: openCharPicker, title: '切换角色' },
                    h('img', { class: 'stcm-avatar', src: thumb(S.sel.avatar), alt: '', loading: 'lazy' }),
                    h('span', { class: 'stcm-charname', text: S.sel.name }),
                    isCur ? h('span', { class: 'stcm-tag cur', text: '当前角色' }) : null,
                    h('span', { class: 'stcm-caret', text: '▾' })),
                ...(!isCur && cur.avatar ? [h('button', { class: 'stcm-btn small', onclick: () => selectChar(cur.avatar) }, '回到当前角色')] : []));
        } else {
            box.append(h('button', { class: 'stcm-charbtn', onclick: openCharPicker },
                h('span', { class: 'stcm-charname', text: cur.group ? '当前是群聊，请选择一个角色' : '请选择角色' }),
                h('span', { class: 'stcm-caret', text: '▾' })));
        }
    }

    function renderList() {
        if (!S.root) return;
        const st = settings();
        const listEl = S.root.querySelector('.stcm-list');
        const statEl = S.root.querySelector('.stcm-stats');
        const rows = visibleChats();
        const frag = document.createDocumentFragment();
        const dupKeys = new Map();
        dupGroups().forEach((g, i) => g.forEach(c => dupKeys.set(c.file, g.length)));

        if (!S.sel) {
            frag.append(h('div', { class: 'stcm-empty', text: '点上方选择一个角色卡，查看它的全部聊天记录。' }));
        } else if (S.loading && !S.chats.length) {
            frag.append(h('div', { class: 'stcm-empty' }, h('div', { class: 'stcm-spin' }), '正在读取聊天列表…聊天很多/很长时需要等一会儿'));
        } else if (S.loadError) {
            frag.append(h('div', { class: 'stcm-empty err', text: S.loadError }));
        } else if (!S.chats.length) {
            frag.append(h('div', { class: 'stcm-empty', text: '这个角色还没有聊天记录。' }));
        } else if (!rows.length) {
            frag.append(h('div', { class: 'stcm-empty', text: '没有符合筛选条件的聊天。' }));
        }

        for (const { c, depth } of rows) {
            const open = isOpenChat(S.sel.avatar, c.id);
            const last = isLastChat(S.sel.avatar, c.id);
            const checked = S.checked.has(c.file);
            const parentMissing = c.parent && c.parent !== c.id && !S.chats.some(x => x.id === c.parent);
            const row = h('div', { class: 'stcm-row' + (checked ? ' checked' : '') + (open ? ' open' : ''), style: depth ? `margin-left:${Math.min(depth, 4) * 14}px` : null, 'data-file': c.file },
                h('label', { class: 'stcm-check' },
                    open ? h('span', { class: 'stcm-lock', title: '当前正打开的聊天，受保护', text: '🔒' })
                        : h('input', { type: 'checkbox', checked, onchange: e => { e.target.checked ? S.checked.add(c.file) : S.checked.delete(c.file); row.classList.toggle('checked', e.target.checked); renderActionBar(); } })),
                h('div', { class: 'stcm-row-main', onclick: () => openPreview(S.sel.avatar, c) },
                    h('div', { class: 'stcm-row-title' },
                        depth ? h('span', { class: 'stcm-branch-mark', text: '↳' }) : null,
                        h('span', { class: 'stcm-row-name', text: c.id })),
                    h('div', { class: 'stcm-tags' },
                        open ? h('span', { class: 'stcm-tag cur', text: '正在打开' }) : null,
                        last ? h('span', { class: 'stcm-tag', text: '上次停留' }) : null,
                        isBranchLike(c) ? h('span', { class: 'stcm-tag br', text: c.parent && depth === 0 ? (parentMissing ? '分支·父聊天已不在' : '分支自 ' + c.parent) : '分支' }) : null,
                        dupKeys.has(c.file) ? h('span', { class: 'stcm-tag dup', text: `疑似重复×${dupKeys.get(c.file)}` }) : null,
                        h('span', { class: 'stcm-sub', text: `${c.count} 楼 · ${c.sizeText} · ${fmtTime(c.last)} ${fmtAgo(c.last)}` })),
                    h('div', { class: 'stcm-preview-line', text: c.preview.replace(/\s+/g, ' ').slice(0, 160) })),
                h('button', { class: 'stcm-more', title: '更多操作', onclick: e => { e.stopPropagation(); chatMenu(c); } }, '⋯'));
            frag.append(row);
        }
        listEl.replaceChildren(frag);

        const total = S.chats.reduce((a, c) => a + c.size, 0);
        const floors = S.chats.reduce((a, c) => a + c.count, 0);
        statEl.textContent = S.sel && S.chats.length
            ? `共 ${S.chats.length} 个聊天 · ${floors} 楼 · ${fmtSize(total)}` + (rows.length !== S.chats.length ? ` · 显示 ${rows.length} 个` : '') + (S.loading ? ' · 刷新中…' : '')
            : '';
        const hit = S.root.querySelector('.stcm-hitbar');
        hit.style.display = S.contentHits ? 'flex' : 'none';
        if (S.contentHits) hit.firstChild.textContent = `内容含「${S.contentHits.query}」的聊天：${S.contentHits.ids.size} 个`;
        S.root.querySelector('.stcm-sort').value = st.sortKey;
        S.root.querySelector('.stcm-dir').textContent = st.sortDesc ? '↓ 降序' : '↑ 升序';
        const treeBtn = S.root.querySelector('.stcm-tree');
        treeBtn.classList.toggle('on', !!st.tree);
        treeBtn.style.display = S.hasMeta ? '' : 'none';
        renderActionBar();
    }

    function checkedItems() {
        return S.chats.filter(c => S.checked.has(c.file));
    }
    function renderActionBar() {
        const bar = S.root.querySelector('.stcm-actionbar');
        const items = checkedItems();
        bar.style.display = items.length ? 'flex' : 'none';
        if (!items.length) return;
        bar.querySelector('.stcm-selinfo').textContent = `已选 ${items.length} 个 · ${fmtSize(items.reduce((a, c) => a + c.size, 0))}`;
    }

    // ---------------------------------------------------------------- 角色选择器
    function openCharPicker() {
        const cur = currentInfo();
        let q = '', sort = 'recent';
        const listEl = h('div', { class: 'stcm-picker-list' });
        const run = ++S.countRun;
        const draw = () => {
            const chars = ctx().characters.filter(c => c && c.avatar);
            const ql = q.trim().toLowerCase();
            let arr = chars.filter(c => !ql || String(c.name || '').toLowerCase().includes(ql) || String(c.avatar).toLowerCase().includes(ql));
            const t = c => parseTime(c.date_last_chat) || 0;
            if (sort === 'count') arr.sort((a, b) => (S.counts.get(b.avatar) ?? -1) - (S.counts.get(a.avatar) ?? -1));
            else if (sort === 'name') arr.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
            else arr.sort((a, b) => t(b) - t(a));
            const i = arr.findIndex(c => c.avatar === cur.avatar);
            if (i > 0) arr.unshift(arr.splice(i, 1)[0]);
            const frag = document.createDocumentFragment();
            for (const c of arr.slice(0, 300)) {
                const n = S.counts.get(c.avatar);
                frag.append(h('button', { class: 'stcm-pick' + (S.sel && S.sel.avatar === c.avatar ? ' on' : ''), 'data-avatar': c.avatar, onclick: () => { api.close(true); selectChar(c.avatar); } },
                    h('img', { class: 'stcm-avatar', src: thumb(c.avatar), alt: '', loading: 'lazy' }),
                    h('span', { class: 'stcm-pick-name' }, c.name || c.avatar, c.avatar === cur.avatar ? h('span', { class: 'stcm-tag cur', text: '当前角色' }) : null),
                    h('span', { class: 'stcm-count', text: n === undefined ? '' : n + ' 个聊天' })));
            }
            if (arr.length > 300) frag.append(h('div', { class: 'stcm-sub', text: `还有 ${arr.length - 300} 个角色未显示，请输入名字搜索` }));
            if (!arr.length) frag.append(h('div', { class: 'stcm-empty', text: '没有匹配的角色' }));
            listEl.replaceChildren(frag);
        };
        let api = null;
        const body = h('div', { class: 'stcm-picker' },
            h('input', { class: 'stcm-input stcm-picker-search', type: 'search', placeholder: '搜索角色卡名字…', oninput: e => { q = e.target.value; draw(); } }),
            h('div', { class: 'stcm-toolbar' },
                h('select', { class: 'stcm-input', onchange: e => { sort = e.target.value; draw(); } },
                    h('option', { value: 'recent' }, '按最近聊天'), h('option', { value: 'count' }, '按聊天数量'), h('option', { value: 'name' }, '按名字')),
                h('span', { class: 'stcm-sub stcm-count-status' })),
            listEl);
        dialog('选择角色卡', body, [{ text: '关闭', value: null }], a => { api = a; draw(); countAll(run, draw, body.querySelector('.stcm-count-status')); })
            .then(() => { S.countRun++; });
    }

    /** 后台统计每个角色的聊天数量（只在服务端支持 simple 快速列表时进行） */
    async function countAll(run, redraw, statusEl) {
        const chars = ctx().characters.filter(c => c && c.avatar && !S.counts.has(c.avatar));
        if (!chars.length) return;
        let i = 0, done = 0;
        const worker = async () => {
            while (i < chars.length && run === S.countRun && S.simpleOk !== false) {
                const c = chars[i++];
                try { S.counts.set(c.avatar, (await listNames(c.avatar)).size); } catch (e) { /* ignore */ }
                done++;
                if (done % 8 === 0 || done === chars.length) { statusEl.textContent = `统计聊天数量 ${done}/${chars.length}`; redraw(); }
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        if (run !== S.countRun) return;
        statusEl.textContent = S.simpleOk === false ? '当前酒馆版本较旧，不做全角色数量统计' : '';
        redraw();
    }

    // ---------------------------------------------------------------- 删除流程（界面）
    async function deleteFlow(items) {
        if (S.busy || !S.sel) return;
        const avatar = S.sel.avatar;
        items = items.filter(c => !isOpenChat(avatar, c.id));
        if (!items.length) { toast('当前正打开的聊天受保护，请先在酒馆里切到别的聊天再删', 'err'); return; }

        // 1) 删除前重新读一遍磁盘，确保界面上看到的和磁盘上的是同一份
        setBusy('正在核对磁盘上的最新状态…');
        let fresh;
        try { fresh = await listChats(avatar); } catch (e) { setBusy(''); toast('核对失败，未删除任何东西：' + e.message, 'err'); return; }
        setBusy('');
        if (!S.sel || S.sel.avatar !== avatar) return;
        const changed = [], gone = [], ok = [];
        for (const it of items) {
            const f = fresh.find(x => x.file === it.file);
            if (!f) gone.push(it);
            else if (f.count !== it.count || f.sizeText !== it.sizeText) changed.push(it);
            else ok.push(f);
        }
        S.chats = fresh; S.hasMeta = fresh.some(x => x.meta);
        if (changed.length) {
            for (const c of changed) S.checked.delete(c.file);
            renderList();
            await dialog('列表已过期，已中止', h('div', null,
                h('p', { text: '下面这些聊天在你打开列表之后又发生了变化（楼层数或大小不同了）。为避免误删，本次没有删除任何东西，列表已刷新，请重新核对后再操作。' }),
                changed.map(itemLine)));
            return;
        }
        renderList();
        if (!ok.length) { toast('选中的聊天已经不存在了，列表已刷新'); return; }

        const res = await confirmAndRemove(avatar, S.sel.name, ok, gone.length, fresh);
        if (!res) return;
        for (const f of res.done) S.checked.delete(f);
        setBusy('正在刷新列表…');
        try { await loadChats(false); } finally { setBusy(''); }
        await reportResult(res);
        if (S.view === 'preview' && S.pv && res.done.includes(S.pv.item.file)) showView('list');
    }

    /**
     * 弹确认框 → 执行删除 → 核对。ok 必须是刚从磁盘读到的条目。
     * @returns {Promise<null|{done:string[],failed:object[],skipped:string[],permanent:boolean}>} 取消时返回 null
     */
    async function confirmAndRemove(avatar, charName, ok, goneCount, fresh) {
        const st = settings();
        let permanent = !st.useTrash;
        const lastOnes = ok.filter(c => isLastChat(avatar, c.id));
        const kidsOf = ok.filter(c => fresh.some(x => x.parent === c.id && !ok.includes(x)));
        const big = ok.filter(c => c.count >= 100);
        const totalSize = ok.reduce((a, c) => a + c.size, 0);
        const modeRadio = (val, label, sub) => h('label', { class: 'stcm-radio' },
            h('input', { type: 'radio', name: 'stcm-mode', checked: permanent === val, onchange: () => { permanent = val; sync(); } }),
            h('span', null, h('b', { text: label }), h('div', { class: 'stcm-sub', text: sub })));
        const ack = h('input', { type: 'checkbox' });
        let sync = () => { };
        const body = h('div', null,
            h('p', null, '角色：', h('b', { text: charName }), `　共 ${ok.length} 个聊天，${ok.reduce((a, c) => a + c.count, 0)} 楼，${fmtSize(totalSize)}`),
            goneCount ? h('p', { class: 'stcm-warn', text: `另有 ${goneCount} 个在磁盘上已不存在，已自动忽略。` }) : null,
            h('div', { class: 'stcm-confirm-list' }, ok.map(itemLine)),
            big.length ? h('p', { class: 'stcm-warn', text: `⚠ 其中 ${big.length} 个聊天超过 100 楼，请确认不是主线。` }) : null,
            lastOnes.length ? h('p', { class: 'stcm-warn', text: `⚠ 「${lastOnes[0].id}」是该角色上次停留的聊天。删掉后下次打开该角色，酒馆会用同名新建一个只有开场白的空聊天。` }) : null,
            kidsOf.length ? h('p', { class: 'stcm-warn', text: `⚠ 有 ${kidsOf.length} 个聊天还有没被选中的分支，删除后那些分支仍可正常使用，只是「返回主聊天」会失效。` }) : null,
            modeRadio(false, '移入回收站（推荐）', '先完整复制到回收站并校验，再删原文件；之后可一键恢复。会多占一份空间，直到清空回收站。'
                + (totalSize > 20 * 1048576 ? `这批共 ${fmtSize(totalSize)}，每个文件要完整读写一遍，手机上会比较慢，请耐心等。` : '')),
            modeRadio(true, '永久删除', '直接删除本地 .jsonl 文件，无法恢复。速度快。'),
            h('label', { class: 'stcm-radio' }, ack, h('span', { text: '我已核对上面的列表' })));
        const choice = await dialog('确认删除', body,
            [{ text: '取消', value: null }, { text: '删除', value: 'go', cls: 'danger', disabled: true }],
            ({ btnEls }) => {
                sync = () => {
                    btnEls[1].disabled = !ack.checked;
                    btnEls[1].textContent = permanent ? `永久删除 ${ok.length} 个` : `移入回收站 ${ok.length} 个`;
                };
                ack.addEventListener('change', sync);
                sync();
            });
        if (choice !== 'go') return null;
        st.useTrash = !permanent; saveSettings();
        setBusy('准备删除…');
        try {
            const res = await removeChats(avatar, ok, permanent, (i, n, it) => setBusy(`${permanent ? '删除' : '移入回收站'} ${i + 1}/${n}：${it.id}`));
            res.permanent = permanent;
            return res;
        } finally { setBusy(''); }
    }

    async function reportResult(res) {
        const word = res.permanent ? '永久删除' : '移入回收站';
        if (!res.failed.length && !res.skipped.length) { toast(`已${word} ${res.done.length} 个聊天`, 'ok'); return; }
        await dialog('删除未全部完成', h('div', null,
            h('p', { text: res.done.length ? `已${word} ${res.done.length} 个（已重新读取目录确认）。` : '没有删除任何聊天。' }),
            res.failed.length ? h('div', null, h('p', { class: 'stcm-warn', text: `失败 ${res.failed.length} 个（已停止后续操作）：` }),
                res.failed.map(f => h('div', { class: 'stcm-confirm-item' }, h('div', { class: 'stcm-confirm-name', text: f.file }), h('div', { class: 'stcm-sub', text: f.reason })))) : null,
            res.skipped.length ? h('p', { class: 'stcm-warn', text: `因前面出错而未处理：${res.skipped.length} 个，原文件都还在。` }) : null));
    }

    // ---------------------------------------------------------------- 酒馆原生「聊天记录」面板的多选删除
    const N = { on: false, picked: new Set(), mo: null };
    const stripExt = n => String(n || '').replace(/\.jsonl$/i, '');
    function nativeBlocks() {
        return [...document.querySelectorAll('#select_chat_div .select_chat_block_wrapper')].map(w => {
            const b = w.querySelector('.select_chat_block');
            const id = stripExt(b && b.getAttribute('file_name'));
            return { w, b, id };
        }).filter(x => x.b && x.id);
    }
    function nativeLocked(x) {
        const cur = currentInfo();
        return x.b.getAttribute('highlight') === 'true' || (!!cur.avatar && cur.chat === x.id);
    }
    function nativeSync() {
        const btn = document.getElementById('stcm-native-toggle');
        const bar = document.getElementById('stcm-native-bar');
        if (!btn || !bar) return;
        const group = !!currentInfo().group;
        btn.style.display = group ? 'none' : '';
        if (group) N.on = false;
        btn.classList.toggle('stcm-native-on', N.on);
        bar.style.display = N.on ? 'flex' : 'none';
        const blocks = nativeBlocks();
        const visible = new Set(blocks.map(x => x.id));
        for (const id of [...N.picked]) if (!visible.has(id)) N.picked.delete(id); // 看不见的不保留选中
        for (const x of blocks) {
            let box = x.w.querySelector('.stcm-ncheck');
            if (!N.on) { if (box) box.remove(); x.w.classList.remove('stcm-npicked'); continue; }
            if (!box) { box = h('div', { class: 'stcm-ncheck' }); x.w.prepend(box); }
            const locked = nativeLocked(x);
            if (locked) N.picked.delete(x.id);
            box.textContent = locked ? '🔒' : (N.picked.has(x.id) ? '☑' : '☐');
            box.title = locked ? '当前正打开的聊天，受保护' : '';
            x.w.classList.toggle('stcm-npicked', N.picked.has(x.id));
        }
        bar.querySelector('.stcm-ninfo').textContent = `已选 ${N.picked.size} 个`;
        bar.querySelector('.stcm-ndel').textContent = `删除 ${N.picked.size || ''}`;
    }
    function nativeObserve() {
        if (N.mo) N.mo.disconnect();
        N.mo = new MutationObserver(() => { N.mo.disconnect(); nativeSync(); nativeObserve(); });
        const list = document.getElementById('select_chat_div');
        if (list) N.mo.observe(list, { childList: true });
    }
    function nativeInstall() {
        const list = document.getElementById('select_chat_div');
        const importBtn = document.getElementById('chat_import_button');
        if (!list || document.getElementById('stcm-native-toggle')) return;
        const toggle = h('div', { id: 'stcm-native-toggle', class: 'menu_button menu_button_icon', title: '聊天记录管家：多选删除', onclick: () => { N.on = !N.on; N.picked.clear(); nativeSync(); } },
            h('i', { class: 'fa-solid fa-list-check' }), h('span', { text: '多选' }));
        if (importBtn) importBtn.after(toggle); else list.before(toggle);
        const mb = (text, fn, cls) => h('div', { class: 'menu_button ' + (cls || ''), onclick: fn }, text);
        list.before(h('div', { id: 'stcm-native-bar', style: 'display:none' },
            h('b', { class: 'stcm-ninfo' }),
            mb('全选', () => { nativeBlocks().forEach(x => { if (!nativeLocked(x)) N.picked.add(x.id); }); nativeSync(); }),
            mb('清空', () => { N.picked.clear(); nativeSync(); }),
            mb('删除', nativeDelete, 'stcm-ndel'),
            mb('管家', openPanel),
            mb('完成', () => { N.on = false; N.picked.clear(); nativeSync(); })));
        // 多选模式下，点聊天条目只切换勾选，不触发酒馆自己的 打开/改名/导出/删除
        list.addEventListener('click', e => {
            if (!N.on) return;
            const w = e.target.closest && e.target.closest('.select_chat_block_wrapper');
            if (!w) return;
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            const x = nativeBlocks().find(y => y.w === w);
            if (!x) return;
            if (nativeLocked(x)) { toast('当前正打开的聊天受保护，不能在这里删'); return; }
            N.picked.has(x.id) ? N.picked.delete(x.id) : N.picked.add(x.id);
            nativeSync();
        }, true);
        nativeObserve();
        nativeSync();
    }

    /** 没打开管家面板时，借用管家的弹窗层来显示确认框/进度 */
    async function withOverlay(fn) {
        if (!S.root) { S.root = build(); document.body.append(S.root); }
        const bare = !S.open;
        if (bare) { S.root.classList.add('stcm-bare'); S.root.style.display = 'flex'; }
        try { return await fn(); }
        finally { if (bare && !S.open) { S.root.style.display = 'none'; S.root.classList.remove('stcm-bare'); } }
    }

    async function nativeDelete() {
        if (S.busy || N.deleting) return;
        const cur = currentInfo();
        if (!cur.avatar) { toast('只支持角色聊天，群聊记录请用酒馆自带的删除', 'err'); return; }
        const ids = new Set(nativeBlocks().filter(x => N.picked.has(x.id) && !nativeLocked(x)).map(x => x.id));
        if (!ids.size) { toast('先点选要删除的聊天'); return; }
        N.deleting = true;
        try {
            await withOverlay(async () => {
                setBusy('正在核对磁盘上的最新状态…');
                let fresh;
                try { fresh = await listChats(cur.avatar); }
                catch (e) { toast('核对失败，未删除任何东西：' + e.message, 'err'); return; }
                finally { setBusy(''); }
                const ok = fresh.filter(c => ids.has(c.id) && !isOpenChat(cur.avatar, c.id));
                if (!ok.length) { toast('选中的聊天在磁盘上已不存在', 'err'); return; }
                const res = await confirmAndRemove(cur.avatar, cur.name, ok, ids.size - ok.length, fresh);
                if (!res) return;
                const gone = new Set(res.done.map(stripExt));
                for (const x of nativeBlocks()) if (gone.has(x.id)) x.w.remove();
                for (const id of gone) N.picked.delete(id);
                S.loadedFor = null;
                await reportResult(res);
            });
        } finally { N.deleting = false; nativeSync(); }
    }

    // ---------------------------------------------------------------- 其它单项操作
    async function exportChats(avatar, items, format) {
        setBusy('正在导出…');
        try {
            for (let i = 0; i < items.length; i++) {
                setBusy(`导出 ${i + 1}/${items.length}：${items[i].id}`);
                const data = await readChat(avatar, items[i].id);
                if (!data.length) throw new Error(`读取失败：${items[i].id}`);
                if (format === 'txt') {
                    const txt = data.filter(m => !isHeader(m)).map((m, k) => `#${k} ${m.name || ''}:\n${m.mes || ''}`).join('\n\n');
                    download(items[i].id + '.txt', txt);
                } else download(items[i].id + '.jsonl', data.map(x => JSON.stringify(x)).join('\n'));
                if (items.length > 1) await new Promise(r => setTimeout(r, 400));
            }
            toast(`已导出 ${items.length} 个文件（到浏览器下载目录）`, 'ok');
        } catch (e) { toast('导出失败：' + e.message, 'err'); }
        finally { setBusy(''); }
    }
    async function askExport(items) {
        const v = await dialog('导出聊天', h('p', { text: `导出 ${items.length} 个聊天。jsonl 可以再导入酒馆；txt 方便阅读。` }),
            [{ text: '取消', value: null }, { text: 'TXT', value: 'txt' }, { text: 'JSONL', value: 'jsonl', cls: 'primary' }]);
        if (v) await exportChats(S.sel.avatar, items, v);
    }

    async function renameFlow(c) {
        const avatar = S.sel.avatar;
        if (isOpenChat(avatar, c.id)) { toast('当前正打开的聊天请用酒馆自带的重命名', 'err'); return; }
        const inp = h('input', { class: 'stcm-input', type: 'text', value: c.id });
        const hasKids = S.chats.some(x => x.parent === c.id);
        const v = await dialog('重命名聊天', h('div', null, inp,
            hasKids ? h('p', { class: 'stcm-warn', text: '⚠ 它有分支，改名后那些分支的「返回主聊天」会失效。' }) : null,
            isLastChat(avatar, c.id) ? h('p', { class: 'stcm-warn', text: '⚠ 这是该角色上次停留的聊天，改名后下次打开该角色会新建一个同名空聊天。' }) : null),
            [{ text: '取消', value: null }, { text: '重命名', value: 'go', cls: 'primary' }]);
        if (v !== 'go') return;
        const name = inp.value.trim();
        if (!name || name === c.id) return;
        const bad = unsafeNameReason(name + '.jsonl') || unsafeNameReason(c.file);
        if (bad) { toast('不能重命名：' + bad, 'err'); return; }
        setBusy('正在重命名…');
        try {
            const names = await listNames(avatar);
            if (!names.has(c.file)) throw new Error('原文件已不存在');
            if (names.has(name + '.jsonl')) throw new Error('已有同名聊天');
            const r = await post('/api/chats/rename', { avatar_url: avatar, original_file: c.file, renamed_file: name + '.jsonl' });
            if (!r || r.ok !== true) throw new Error('接口未返回成功');
            S.checked.delete(c.file);
            toast('已重命名', 'ok');
        } catch (e) { toast('重命名失败：' + e.message, 'err'); }
        finally { setBusy(''); await loadChats(false); }
    }

    async function openInTavern(avatar, id) {
        const c = ctx();
        const cur = currentInfo();
        try {
            if (cur.avatar !== avatar) {
                const idx = c.characters.findIndex(x => x.avatar === avatar);
                if (idx < 0 || typeof c.selectCharacterById !== 'function') throw new Error('无法切换到该角色，请手动打开');
                await c.selectCharacterById(idx);
                for (let i = 0; i < 50 && currentInfo().avatar !== avatar; i++) await new Promise(r => setTimeout(r, 100));
                if (currentInfo().avatar !== avatar) throw new Error('切换角色超时');
            }
            if (currentInfo().chat !== id) {
                if (typeof c.openCharacterChat !== 'function') throw new Error('当前酒馆版本不支持从插件打开聊天');
                await ctx().openCharacterChat(id);
            }
            closePanel();
        } catch (e) { toast('打开失败：' + (e.message || e), 'err'); }
    }

    function chatMenu(c) {
        const avatar = S.sel.avatar;
        const open = isOpenChat(avatar, c.id);
        const act = (text, fn, cls) => h('button', { class: 'stcm-menu-item ' + (cls || ''), onclick: () => { api.close(null); fn(); } }, text);
        let api;
        dialog(c.id, h('div', { class: 'stcm-menu' },
            act('👁 预览内容', () => openPreview(avatar, c)),
            act('💬 在酒馆中打开这个聊天', () => openInTavern(avatar, c.id)),
            act('📤 导出', () => askExport([c])),
            open ? null : act('✏️ 重命名', () => renameFlow(c)),
            open ? h('div', { class: 'stcm-sub', text: '🔒 正在打开的聊天不能在这里删除/重命名' }) : act('🗑 删除', () => deleteFlow([c]), 'danger')),
            [{ text: '关闭', value: null }], a => { api = a; });
    }

    async function quickSelect() {
        const rows = visibleChats().map(r => r.c).filter(c => !isOpenChat(S.sel.avatar, c.id));
        const num = (v, d) => h('input', { class: 'stcm-input stcm-num', type: 'number', min: '0', value: String(d), onclick: e => e.stopPropagation() });
        const nFloor = num(0, 5), nDay = num(0, 30), nKeep = num(0, 3);
        let api;
        const pick = (fn, add) => () => {
            if (!add) S.checked.clear();
            fn().forEach(c => S.checked.add(c.file));
            api.close(null); renderList();
        };
        const item = (label, fn, extra) => h('div', { class: 'stcm-menu-item', onclick: pick(fn) }, label, extra || null);
        await dialog('快速选择', h('div', { class: 'stcm-menu' },
            h('div', { class: 'stcm-sub', text: '只在当前显示的列表里选；正在打开的聊天永远不会被选中。选完还要再点「删除」并确认。' }),
            item('全选', () => rows),
            item('反选', () => { const old = new Set(checkedItems().map(c => c.file)); return rows.filter(c => !old.has(c.file)); }),
            item('全部分支 / 检查点', () => rows.filter(isBranchLike)),
            item('疑似重复的（每组保留最新一个）', () => {
                const vis = new Set(rows.map(c => c.file)), out = [];
                for (const g of dupGroups()) {
                    const keep = g.find(c => isOpenChat(S.sel.avatar, c.id)) || g.slice().sort((a, b) => b.last - a.last)[0];
                    out.push(...g.filter(c => c !== keep && vis.has(c.file)));
                }
                return out;
            }),
            item('楼层数 ≤ ', () => rows.filter(c => c.count <= Number(nFloor.value || 0)), nFloor),
            item('最后活动早于（天）', () => rows.filter(c => c.last && Date.now() - c.last > Number(nDay.value || 0) * 86400000), nDay),
            item('除最新的 N 个以外全部 ', () => rows.slice().sort((a, b) => b.last - a.last).slice(Math.max(0, Number(nKeep.value || 0))), nKeep),
            h('div', { class: 'stcm-menu-item', onclick: () => { S.checked.clear(); api.close(null); renderList(); } }, '清空选择')),
            [{ text: '关闭', value: null }], a => { api = a; });
    }

    async function contentSearch() {
        if (!S.sel) return;
        const q = S.filter.trim();
        if (!q) { toast('先在搜索框里输入要找的内容'); return; }
        const avatar = S.sel.avatar;
        setBusy('正在全文搜索该角色的所有聊天…');
        try {
            let ids;
            try {
                const r = await post('/api/chats/search', { query: q, avatar_url: avatar });
                if (!Array.isArray(r)) throw new Error('bad');
                ids = new Set(r.map(x => String(x.file_name).replace(/\.jsonl$/i, '')));
            } catch (e) {
                // 旧版酒馆没有搜索接口：逐个读取后在本地找
                ids = new Set();
                const words = q.toLowerCase().split(/\s+/).filter(Boolean);
                for (let i = 0; i < S.chats.length; i++) {
                    setBusy(`全文搜索 ${i + 1}/${S.chats.length}…`);
                    const data = await readChat(avatar, S.chats[i].id);
                    const text = data.map(m => String(m.mes || '')).join('\n').toLowerCase();
                    if (words.every(w => text.includes(w))) ids.add(S.chats[i].id);
                }
            }
            S.contentHits = { query: q, ids };
            S.filter = '';
            S.root.querySelector('.stcm-filter').value = '';
            renderList();
        } catch (e) { toast('搜索失败：' + e.message, 'err'); }
        finally { setBusy(''); }
    }

    // ---------------------------------------------------------------- 预览
    async function openPreview(avatar, item, opts) {
        showView('preview');
        const pv = S.pv = { avatar, item, msgs: [], start: 0, hits: [], hitIdx: -1, query: '', loading: true, error: '', fromTrash: avatar === TRASH_AVATAR, title: (opts && opts.title) || item.id };
        renderPreview();
        try {
            const data = await readChat(avatar, item.id);
            if (S.pv !== pv) return;
            pv.msgs = data.filter(m => !isHeader(m));
            pv.start = Math.max(0, pv.msgs.length - settings().pageSize);
            pv.loading = false;
            if (!data.length) pv.error = '文件为空或读取失败';
            renderPreview();
            if (S.contentHits && !pv.fromTrash) { S.root.querySelector('.stcm-pv-search').value = S.contentHits.query; previewSearch(S.contentHits.query); }
        } catch (e) {
            if (S.pv !== pv) return;
            pv.loading = false; pv.error = '读取失败：' + e.message;
            renderPreview();
        }
    }

    function previewSearch(q) {
        const pv = S.pv;
        if (!pv) return;
        pv.query = q.trim();
        pv.hits = []; pv.hitIdx = -1;
        if (pv.query) {
            const ql = pv.query.toLowerCase();
            pv.msgs.forEach((m, i) => { if (String(m.mes || '').toLowerCase().includes(ql) || String(m.name || '').toLowerCase().includes(ql)) pv.hits.push(i); });
            if (pv.hits.length) { pv.hitIdx = pv.hits.length - 1; jumpTo(pv.hits[pv.hitIdx], true); return; }
        }
        renderPreview();
    }
    function jumpTo(idx, focus) {
        const pv = S.pv, size = settings().pageSize;
        idx = Math.max(0, Math.min(pv.msgs.length - 1, idx | 0));
        pv.start = Math.floor(idx / size) * size;
        pv.focus = focus ? idx : -1;
        renderPreview();
    }
    function highlight(text, q) {
        if (!q) return [text];
        const out = [], low = text.toLowerCase(), ql = q.toLowerCase();
        let pos = 0, i;
        while ((i = low.indexOf(ql, pos)) !== -1 && out.length < 400) {
            if (i > pos) out.push(text.slice(pos, i));
            out.push(h('mark', { text: text.slice(i, i + q.length) }));
            pos = i + q.length;
        }
        out.push(text.slice(pos));
        return out;
    }

    function renderPreview() {
        const pv = S.pv;
        if (!pv || !S.root) return;
        const size = settings().pageSize;
        const el = S.root.querySelector('.stcm-view-preview');
        const total = pv.msgs.length;
        const end = Math.min(total, pv.start + size);
        const body = h('div', { class: 'stcm-pv-body' });
        if (pv.loading) body.append(h('div', { class: 'stcm-empty' }, h('div', { class: 'stcm-spin' }), '正在读取聊天内容…'));
        else if (pv.error) body.append(h('div', { class: 'stcm-empty err', text: pv.error }));
        else if (!total) body.append(h('div', { class: 'stcm-empty', text: '这个聊天里没有消息。' }));
        let focusEl = null;
        for (let i = pv.start; i < end; i++) {
            const m = pv.msgs[i];
            const text = String(m.mes ?? '');
            const isHit = pv.query && pv.hits.includes(i);
            const long = text.length > 900 && !(isHit && pv.focus === i);
            const textEl = h('div', { class: 'stcm-msg-text' }, highlight(long ? text.slice(0, 900) + '…' : text, pv.query));
            const box = h('div', { class: 'stcm-msg' + (m.is_user ? ' user' : '') + (m.is_system ? ' sys' : '') + (pv.focus === i ? ' focus' : '') },
                h('div', { class: 'stcm-msg-head' },
                    h('span', { class: 'stcm-floor', text: '#' + i }),
                    h('b', { text: m.name || (m.is_user ? '用户' : '角色') }),
                    m.is_system ? h('span', { class: 'stcm-tag', text: '隐藏/系统' }) : null,
                    Array.isArray(m.swipes) && m.swipes.length > 1 ? h('span', { class: 'stcm-tag', text: `${m.swipes.length} 个滑动` }) : null,
                    h('span', { class: 'stcm-sub', text: m.send_date ? fmtTime(parseTime(m.send_date)) : '' })),
                textEl,
                long ? h('button', { class: 'stcm-btn small', onclick: e => { textEl.replaceChildren(...highlight(text, pv.query)); e.target.remove(); } }, `展开全文（${text.length} 字）`) : null);
            if (pv.focus === i) focusEl = box;
            body.append(box);
        }
        const st = S.sel && !pv.fromTrash ? S.chats.find(c => c.file === pv.item.file) : null;
        const parent = st && st.parent && S.chats.find(c => c.id === st.parent && c.id !== st.id);
        const floorInput = h('input', { class: 'stcm-input stcm-num', type: 'number', min: '0', placeholder: '楼层', onkeydown: e => { if (e.key === 'Enter') jumpTo(Number(e.target.value), true); } });
        el.replaceChildren(
            h('div', { class: 'stcm-pv-head' },
                h('button', { class: 'stcm-btn', onclick: () => showView(pv.fromTrash ? 'trash' : 'list') }, '← 返回'),
                h('div', { class: 'stcm-pv-title' }, h('div', { class: 'stcm-row-name', text: pv.title }),
                    h('div', { class: 'stcm-sub', text: pv.loading ? '' : `共 ${total} 楼` + (total ? ` · 正在看 #${pv.start}–#${end - 1}` : '') }))),
            h('div', { class: 'stcm-toolbar' },
                h('input', { class: 'stcm-input stcm-pv-search', type: 'search', placeholder: '在这个聊天里搜索…', value: pv.query, onkeydown: e => { if (e.key === 'Enter') previewSearch(e.target.value); }, onsearch: e => previewSearch(e.target.value) }),
                h('button', { class: 'stcm-btn small', onclick: () => previewSearch(el.querySelector('.stcm-pv-search').value) }, '搜索'),
                pv.query ? h('span', { class: 'stcm-sub', text: pv.hits.length ? `${pv.hitIdx + 1}/${pv.hits.length}` : '无匹配' }) : null,
                pv.hits.length > 1 ? h('button', { class: 'stcm-btn small', onclick: () => { pv.hitIdx = (pv.hitIdx - 1 + pv.hits.length) % pv.hits.length; jumpTo(pv.hits[pv.hitIdx], true); } }, '上一处') : null,
                pv.hits.length > 1 ? h('button', { class: 'stcm-btn small', onclick: () => { pv.hitIdx = (pv.hitIdx + 1) % pv.hits.length; jumpTo(pv.hits[pv.hitIdx], true); } }, '下一处') : null),
            body,
            h('div', { class: 'stcm-pv-foot' },
                h('div', { class: 'stcm-toolbar' },
                    h('button', { class: 'stcm-btn small stcm-first', disabled: pv.start <= 0, title: '开头', onclick: () => jumpTo(0) }, '⏮'),
                    h('button', { class: 'stcm-btn small', disabled: pv.start <= 0, title: '上一页', onclick: () => jumpTo(pv.start - size) }, '◀'),
                    floorInput,
                    h('button', { class: 'stcm-btn small', onclick: () => jumpTo(Number(floorInput.value), true) }, '跳转'),
                    h('button', { class: 'stcm-btn small', disabled: end >= total, title: '下一页', onclick: () => jumpTo(pv.start + size) }, '▶'),
                    h('button', { class: 'stcm-btn small stcm-last', disabled: end >= total, title: '末尾', onclick: () => jumpTo(total - 1) }, '⏭')),
                pv.fromTrash ? null : h('div', { class: 'stcm-toolbar' },
                    parent ? h('button', { class: 'stcm-btn small', onclick: () => findFork(pv, parent) }, '查分叉点') : null,
                    h('button', { class: 'stcm-btn small', onclick: () => openInTavern(pv.avatar, pv.item.id) }, '在酒馆打开'),
                    h('button', { class: 'stcm-btn small', onclick: () => askExport([pv.item]) }, '导出'),
                    isOpenChat(pv.avatar, pv.item.id) ? h('span', { class: 'stcm-sub', text: '🔒 正在打开' })
                        : h('button', { class: 'stcm-btn small danger', onclick: () => { const c = S.chats.find(x => x.file === pv.item.file); if (c) deleteFlow([c]); } }, '删除这个聊天'))));
        if (focusEl) focusEl.scrollIntoView({ block: 'start' }); else body.scrollTop = 0;
    }

    async function findFork(pv, parent) {
        setBusy('正在和父聊天逐楼对比…');
        try {
            const p = (await readChat(pv.avatar, parent.id)).filter(m => !isHeader(m));
            if (S.pv !== pv) return;
            let i = 0;
            while (i < p.length && i < pv.msgs.length && p[i].mes === pv.msgs[i].mes && p[i].name === pv.msgs[i].name) i++;
            setBusy('');
            const v = await dialog('分叉点', h('p', { text: i >= pv.msgs.length ? `这个分支的全部 ${pv.msgs.length} 楼都和「${parent.id}」的前 ${i} 楼相同（没有独有内容）。` : `和「${parent.id}」的前 ${i} 楼相同，从 #${i} 开始不同。本分支独有 ${pv.msgs.length - i} 楼。` }),
                i < pv.msgs.length ? [{ text: '关闭', value: null }, { text: `跳到 #${i}`, value: 'go', cls: 'primary' }] : [{ text: '关闭', value: null }]);
            if (v === 'go') jumpTo(i, true);
        } catch (e) { toast('对比失败：' + e.message, 'err'); }
        finally { setBusy(''); }
    }

    // ---------------------------------------------------------------- 回收站
    async function loadTrash() {
        S.trash.loading = true; renderTrash();
        try {
            const list = await listChats(TRASH_AVATAR);
            S.trash.items = list.map(c => Object.assign(c, { info: (c.meta && c.meta.stcm_trash) || null }))
                .sort((a, b) => ((b.info && b.info.deletedAt) || 0) - ((a.info && a.info.deletedAt) || 0));
            const names = new Set(list.map(c => c.file));
            for (const f of [...S.trash.checked]) if (!names.has(f)) S.trash.checked.delete(f);
        } catch (e) { toast('读取回收站失败：' + e.message, 'err'); }
        S.trash.loading = false; renderTrash();
    }
    function renderTrash() {
        if (!S.root) return;
        const el = S.root.querySelector('.stcm-view-trash');
        const T = S.trash;
        const picked = () => T.items.filter(c => T.checked.has(c.file));
        const list = h('div', { class: 'stcm-list' });
        if (T.loading && !T.items.length) list.append(h('div', { class: 'stcm-empty' }, h('div', { class: 'stcm-spin' }), '正在读取回收站…'));
        else if (!T.items.length) list.append(h('div', { class: 'stcm-empty', text: '回收站是空的。' }));
        for (const c of T.items) {
            const info = c.info || {};
            const exists = info.avatar && charByAvatar(info.avatar);
            const title = info.name || c.id;
            list.append(h('div', { class: 'stcm-row' + (T.checked.has(c.file) ? ' checked' : '') },
                h('label', { class: 'stcm-check' }, h('input', { type: 'checkbox', checked: T.checked.has(c.file), onchange: e => { e.target.checked ? T.checked.add(c.file) : T.checked.delete(c.file); renderTrash(); } })),
                h('div', { class: 'stcm-row-main', onclick: () => openPreview(TRASH_AVATAR, c, { title: '[回收站] ' + title }) },
                    h('div', { class: 'stcm-row-title' }, h('span', { class: 'stcm-row-name', text: title })),
                    h('div', { class: 'stcm-tags' },
                        h('span', { class: 'stcm-tag' + (exists ? '' : ' dup'), text: info.avatar ? `角色：${info.charName || info.avatar}${exists ? '' : '（已不存在）'}` : '来源未知（点开可预览）' }),
                        h('span', { class: 'stcm-sub', text: `${c.count} 楼 · ${c.sizeText}` + (info.deletedAt ? ` · 删除于 ${fmtTime(info.deletedAt)}` : '') })),
                    h('div', { class: 'stcm-preview-line', text: c.preview.replace(/\s+/g, ' ').slice(0, 160) }))));
        }
        const n = picked().length;
        el.replaceChildren(
            h('div', { class: 'stcm-pv-head' },
                h('button', { class: 'stcm-btn', onclick: () => { showView('list'); if (S.sel) loadChats(false); } }, '← 返回'),
                h('div', { class: 'stcm-pv-title' }, h('div', { class: 'stcm-row-name', text: '回收站' }),
                    h('div', { class: 'stcm-sub', text: `${T.items.length} 个聊天 · 占用 ${fmtSize(T.items.reduce((a, c) => a + c.size, 0))}（数据目录 chats/_stcm_trash_/）` }))),
            h('div', { class: 'stcm-toolbar' },
                h('button', { class: 'stcm-btn small', onclick: () => { if (T.checked.size === T.items.length) T.checked.clear(); else T.items.forEach(c => T.checked.add(c.file)); renderTrash(); } }, T.checked.size && T.checked.size === T.items.length ? '取消全选' : '全选'),
                h('button', { class: 'stcm-btn small primary', disabled: !n, onclick: () => restoreFlow(picked()) }, `恢复 ${n || ''}`),
                h('button', { class: 'stcm-btn small danger', disabled: !n, onclick: () => purgeFlow(picked()) }, `永久删除 ${n || ''}`),
                h('button', { class: 'stcm-btn small', onclick: loadTrash }, '刷新')),
            list);
    }
    async function restoreFlow(items) {
        if (S.busy || !items.length) return;
        const fails = []; let ok = 0;
        try {
            for (let i = 0; i < items.length; i++) {
                setBusy(`恢复 ${i + 1}/${items.length}…`);
                try { await restoreOne(items[i], S.sel && S.sel.avatar); ok++; S.trash.checked.delete(items[i].file); }
                catch (e) { fails.push({ it: items[i], reason: e.message }); }
            }
        } finally { setBusy(''); }
        await loadTrash();
        if (fails.length) await dialog('部分恢复失败', h('div', null, h('p', { text: `成功 ${ok} 个，失败 ${fails.length} 个（失败的仍在回收站里）：` }),
            fails.map(f => h('div', { class: 'stcm-confirm-item' }, h('div', { class: 'stcm-confirm-name', text: (f.it.info && f.it.info.name) || f.it.id }), h('div', { class: 'stcm-sub', text: f.reason })))));
        else toast(`已恢复 ${ok} 个聊天到原角色`, 'ok');
    }
    async function purgeFlow(items) {
        if (S.busy || !items.length) return;
        const v = await dialog('永久删除', h('div', null, h('p', { class: 'stcm-warn', text: `将从回收站永久删除 ${items.length} 个聊天，无法恢复。` }),
            h('div', { class: 'stcm-confirm-list' }, items.map(c => itemLine(Object.assign({}, c, { id: (c.info && c.info.name) || c.id }))))),
            [{ text: '取消', value: null }, { text: `永久删除 ${items.length} 个`, value: 'go', cls: 'danger' }]);
        if (v !== 'go') return;
        let res;
        try { res = await removeChats(TRASH_AVATAR, items, true, (i, n) => setBusy(`永久删除 ${i + 1}/${n}…`)); }
        finally { setBusy(''); }
        await loadTrash();
        if (res.failed.length) await dialog('未全部完成', h('div', null, res.failed.map(f => h('div', { class: 'stcm-confirm-item' }, h('div', { class: 'stcm-confirm-name', text: f.file }), h('div', { class: 'stcm-sub', text: f.reason })))));
        else toast(`已永久删除 ${res.done.length} 个`, 'ok');
    }

    // ---------------------------------------------------------------- 面板
    function showView(v) {
        S.view = v;
        for (const name of ['list', 'preview', 'trash']) S.root.querySelector('.stcm-view-' + name).style.display = name === v ? 'flex' : 'none';
        if (v !== 'preview') S.pv = null;
        if (v === 'list') renderList();
    }

    function build() {
        const st = settings();
        const root = h('div', { id: 'stcm-root', class: 'stcm-root' },
            h('div', { class: 'stcm-panel' },
                h('div', { class: 'stcm-view stcm-view-list' },
                    h('div', { class: 'stcm-topbar' },
                        h('div', { class: 'stcm-title', text: '聊天记录管家' }),
                        h('button', { class: 'stcm-btn small', onclick: () => { showView('trash'); loadTrash(); } }, '🗑 回收站'),
                        h('button', { class: 'stcm-btn small stcm-close', onclick: closePanel, title: '关闭' }, '✕')),
                    h('div', { class: 'stcm-charbar' }),
                    h('div', { class: 'stcm-toolbar' },
                        h('input', { class: 'stcm-input stcm-filter', type: 'search', placeholder: '筛选：聊天名 / 最后一条消息', oninput: e => { S.filter = e.target.value; renderList(); } }),
                        h('button', { class: 'stcm-btn small', onclick: contentSearch, title: '在该角色所有聊天的全部楼层里搜索' }, '搜全文')),
                    h('div', { class: 'stcm-hitbar', style: 'display:none' }, h('span'), h('button', { class: 'stcm-btn small', onclick: () => { S.contentHits = null; renderList(); } }, '清除')),
                    h('div', { class: 'stcm-toolbar' },
                        h('select', { class: 'stcm-input stcm-sort', onchange: e => { st.sortKey = e.target.value; saveSettings(); renderList(); } },
                            h('option', { value: 'time' }, '按时间'), h('option', { value: 'count' }, '按楼层数'), h('option', { value: 'size' }, '按大小'), h('option', { value: 'name' }, '按名称')),
                        h('button', { class: 'stcm-btn small stcm-dir', onclick: () => { st.sortDesc = !st.sortDesc; saveSettings(); renderList(); } }),
                        h('button', { class: 'stcm-btn small stcm-tree', onclick: () => { st.tree = !st.tree; saveSettings(); renderList(); }, title: '把分支挂在父聊天下面显示' }, '分支树'),
                        h('button', { class: 'stcm-btn small', onclick: () => S.sel && quickSelect() }, '快速选择'),
                        h('button', { class: 'stcm-btn small', onclick: () => loadChats(false), title: '重新读取' }, '刷新')),
                    h('div', { class: 'stcm-stats stcm-sub' }),
                    h('div', { class: 'stcm-list' }),
                    h('div', { class: 'stcm-actionbar', style: 'display:none' },
                        h('span', { class: 'stcm-selinfo' }),
                        h('button', { class: 'stcm-btn small', onclick: () => { S.checked.clear(); renderList(); } }, '取消'),
                        h('button', { class: 'stcm-btn small', onclick: () => askExport(checkedItems()) }, '导出'),
                        h('button', { class: 'stcm-btn small danger stcm-del', onclick: () => deleteFlow(checkedItems()) }, '删除'))),
                h('div', { class: 'stcm-view stcm-view-preview', style: 'display:none' }),
                h('div', { class: 'stcm-view stcm-view-trash', style: 'display:none' }),
                h('div', { class: 'stcm-busy', style: 'display:none' }, h('div', { class: 'stcm-spin' }), h('span')),
                h('div', { class: 'stcm-toasts' })));
        return root;
    }

    function openPanel() {
        if (S.open) return;
        if (!S.root) { S.root = build(); document.body.append(S.root); }
        S.root.style.display = 'flex';
        S.open = true;
        showView('list');
        const cur = currentInfo();
        // 每次打开都自动定位到当前角色卡
        if (cur.avatar) selectChar(cur.avatar);
        else if (S.sel && charByAvatar(S.sel.avatar)) { renderHeader(); loadChats(false); }
        else { S.sel = null; renderHeader(); renderList(); if (!cur.group) openCharPicker(); }
    }
    function closePanel() {
        if (!S.root || S.busy) return;
        S.root.style.display = 'none';
        S.root.querySelectorAll('.stcm-mask').forEach(m => m.remove());
        S.open = false;
        S.countRun++;
    }

    // ---------------------------------------------------------------- 入口
    function addEntries() {
        const menu = document.getElementById('extensionsMenu');
        if (menu && !document.getElementById('stcm-menu-entry')) {
            const entry = h('div', { id: 'stcm-menu-entry', class: 'list-group-item flex-container flexGap5 interactable', tabindex: '0', onclick: openPanel },
                h('div', { class: 'fa-solid fa-box-archive extensionsMenuExtensionButton' }), h('span', { text: '聊天记录管家' }));
            menu.append(entry);
        }
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (host && !document.getElementById('stcm-settings') && !document.getElementById('nag-container')) {
            host.append(h('div', { id: 'stcm-settings' },
                h('div', { class: 'inline-drawer' },
                    h('div', { class: 'inline-drawer-toggle inline-drawer-header' }, h('b', { text: '🗂 聊天记录管家' }), h('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
                    h('div', { class: 'inline-drawer-content' },
                        h('button', { class: 'menu_button', style: 'width:100%', onclick: openPanel }, '打开聊天记录管家'),
                        h('div', { style: 'font-size:12px;opacity:.7;text-align:center;margin-top:6px', text: '按角色卡查看、搜索、预览、批量删除聊天记录和分支' })))));
        }
        injectNag();
        nativeInstall();
    }
    /** 在「文件转换工具」(Novel-Auto-Generator) 的面板里加一个入口按钮 */
    function injectNag() {
        const sec = document.querySelector('#nag-container .nag-section');
        if (!sec || document.getElementById('stcm-nag-btn')) return !!sec;
        sec.append(
            h('div', { class: 'nag-btn-row', style: 'margin-top:15px' },
                h('button', { id: 'stcm-nag-btn', class: 'menu_button', style: 'background:linear-gradient(135deg,#e74c3c,#c0392b);width:100%', onclick: openPanel }, '🗂 聊天记录管家')),
            h('div', { style: 'margin-top:10px;font-size:12px;opacity:.7;text-align:center', text: '按角色卡搜索、预览、批量清理聊天记录和分支' }));
        return true;
    }

    function init() {
        if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
            console.error(LOG, '找不到 SillyTavern.getContext，酒馆版本过旧，插件未启用');
            return;
        }
        addEntries();
        // Novel-Auto-Generator 可能比本插件晚加载，观察一段时间再补按钮
        if (!document.getElementById('stcm-nag-btn')) {
            const mo = new MutationObserver(() => { if (injectNag()) mo.disconnect(); });
            const target = document.getElementById('extensions_settings') || document.body;
            mo.observe(target.parentElement || target, { childList: true, subtree: true });
            setTimeout(() => mo.disconnect(), 120000);
        }
        try {
            const c = ctx();
            const ev = c.eventTypes || c.event_types;
            if (c.eventSource && ev && ev.CHAT_CHANGED) c.eventSource.on(ev.CHAT_CHANGED, () => { if (S.open && S.view === 'list' && !S.busy) { renderHeader(); renderList(); } N.picked.clear(); nativeSync(); });
        } catch (e) { /* ignore */ }
        window.STChatManager = { open: openPanel, close: closePanel };
        console.log(LOG, '已加载');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
