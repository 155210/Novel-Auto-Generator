import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { initTxtToWorldbookBridge } from './txtToWorldbook/main.js';

// TXT转世界书模块现在是模块化目录（txtToWorldbook/），需要显式初始化
initTxtToWorldbookBridge().catch((error) => {
    console.error('[NovelGen] TxtToWorldbook 初始化失败:', error);
});

const extensionName = "novel-auto-generator";

// 自动获取当前扩展的路径
const extensionFolderPath = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));

const defaultSettings = {};

let settings = {};

// ============================================
// 工具函数
// ============================================

function log(msg, type = 'info') {
    const p = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' }[type] || 'ℹ️';
    console.log(`[NovelGen] ${p} ${msg}`);
}

// 动态加载JS文件
// 每次打开酒馆都带上新的时间戳，免得更新扩展后浏览器（尤其手机）还用缓存里的旧脚本，新旧文件混在一起
const LOAD_STAMP = Date.now();

async function loadScript(filename) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${extensionFolderPath}/${filename}?v=${LOAD_STAMP}`;
        script.onload = () => resolve();
        script.onerror = (e) => reject(e);
        document.head.appendChild(script);
    });
}

// ============================================
// 设置 & UI
// ============================================

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
}

function saveSettings() {
    Object.assign(extension_settings[extensionName], settings);
    saveSettingsDebounced();
}

function createUI() {
    const html = `
    <div id="nag-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📚 文件转换工具</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="nag-section">
                    <div class="nag-btn-row">
                        <button id="nag-btn-txt-to-worldbook" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400); width: 100%;">
                            📚 TXT转世界书
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        将TXT文件转换为SillyTavern世界书格式
                    </div>
                    
                    <div class="nag-btn-row" style="margin-top: 15px;">
                        <button id="nag-btn-epub-to-txt" class="menu_button" style="background: linear-gradient(135deg, #9b59b6, #8e44ad); width: 100%;">
                            📖 EPUB转TXT
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        将EPUB电子书转换为TXT纯文本格式
                    </div>
                    
                    <div class="nag-btn-row" style="margin-top: 15px;">
                        <button id="nag-btn-worldbook-export" class="menu_button" style="background: linear-gradient(135deg, #1abc9c, #16a085); width: 100%;">
                            📤 世界书导出
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        一键导出有激活条目的世界书
                    </div>

                    <div class="nag-btn-row" style="margin-top: 15px;">
                        <button id="nag-btn-novel-translate" class="menu_button" style="background: linear-gradient(135deg, #3498db, #2980b9); width: 100%;">
                            📖 小说翻译
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        TXT小说并发翻译成中文，导出带目录的EPUB
                    </div>

                    <div class="nag-btn-row" style="margin-top: 15px;">
                        <button id="nag-btn-novel-importer" class="menu_button" style="background: linear-gradient(135deg, #27ae60, #1e8449); width: 100%;">
                            📥 小说导入改写
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        小说分层改写导入酒馆聊天，同时生成世界书、填写记忆表格
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    
    $('#extensions_settings').append(html);
    bindEvents();
}

function bindEvents() {
    $('#nag-btn-txt-to-worldbook').on('click', () => {
        if (typeof window.TxtToWorldbook !== 'undefined') {
            window.TxtToWorldbook.open();
        } else {
            toastr.error('TXT转世界书模块未加载');
        }
    });
    
    $('#nag-btn-epub-to-txt').on('click', async () => {
        if (typeof window.EpubToTxt === 'undefined') {
            try {
                toastr.info('正在加载EPUB模块...');
                await loadScript('epubToTxt.js');
            } catch (e) {
                toastr.error('EPUB转TXT模块加载失败');
                console.error('[NovelGen] 加载epubToTxt.js失败:', e);
                console.error('[NovelGen] 尝试加载路径:', `${extensionFolderPath}/epubToTxt.js`);
                return;
            }
        }
        
        if (typeof window.EpubToTxt !== 'undefined') {
            window.EpubToTxt.open();
        } else {
            toastr.error('EPUB转TXT模块未加载');
        }
    });
    
    $('#nag-btn-novel-translate').on('click', async () => {
        if (typeof window.NovelTranslate === 'undefined') {
            try {
                toastr.info('正在加载小说翻译模块...');
                await loadScript('novelTranslate.js');
            } catch (e) {
                toastr.error('小说翻译模块加载失败');
                console.error('[NovelGen] 加载novelTranslate.js失败:', e);
                console.error('[NovelGen] 尝试加载路径:', `${extensionFolderPath}/novelTranslate.js`);
                return;
            }
        }

        if (typeof window.NovelTranslate !== 'undefined') {
            window.NovelTranslate.open();
        } else {
            toastr.error('小说翻译模块未加载');
        }
    });

    $('#nag-btn-novel-importer').on('click', async () => {
        if (typeof window.NovelImporter === 'undefined') {
            try {
                toastr.info('正在加载小说导入改写模块...');
                if (typeof window.EpubToTxt === 'undefined') await loadScript('epubToTxt.js').catch(() => {});
                await loadScript('novelImporter/core.js');
                await loadScript('novelImporter/stBridge.js');
                await loadScript('novelImporter/ui.js');
            } catch (e) {
                toastr.error('小说导入改写模块加载失败');
                console.error('[NovelGen] 加载 novelImporter 失败:', e);
                return;
            }
        }

        if (typeof window.NovelImporter !== 'undefined') {
            try {
                await window.NovelImporter.open();
            } catch (e) {
                toastr.error(`小说导入改写打开失败：${e.message}`);
                console.error('[NovelGen] 打开 novelImporter 失败:', e);
            }
        } else {
            toastr.error('小说导入改写模块未加载');
        }
    });

    $('#nag-btn-worldbook-export').on('click', async () => {
        if (typeof window.WorldbookExport === 'undefined') {
            try {
                toastr.info('正在加载世界书导出模块...');
                await loadScript('worldbookExport.js');
            } catch (e) {
                toastr.error('世界书导出模块加载失败');
                console.error('[NovelGen] 加载worldbookExport.js失败:', e);
                console.error('[NovelGen] 尝试加载路径:', `${extensionFolderPath}/worldbookExport.js`);
                return;
            }
        }
        
        if (typeof window.WorldbookExport !== 'undefined') {
            window.WorldbookExport.open();
        } else {
            toastr.error('世界书导出模块未加载');
        }
    });
}

// ============================================
// 初始化
// ============================================

jQuery(async () => {
    loadSettings();
    createUI();
    
    log('扩展路径: ' + extensionFolderPath, 'debug');
    
    try {
        await loadScript('epubToTxt.js');
        log('EPUB转TXT模块已加载', 'success');
    } catch (e) {
        log('EPUB转TXT模块将在点击时加载', 'warning');
    }
    
    try {
        await loadScript('worldbookExport.js');
        log('世界书导出模块已加载', 'success');
    } catch (e) {
        log('世界书导出模块将在点击时加载', 'warning');
    }
    
    log('文件转换工具扩展已加载', 'success');
});
