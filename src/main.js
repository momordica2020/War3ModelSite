const ModelViewerLib = require('mdx-m3-viewer');
import './style.css';
import MmdRenderer from './mmd-renderer.js';

const ModelViewer = ModelViewerLib.viewer.ModelViewer;
const handlers = ModelViewerLib.viewer.handlers;
const MdlxModel = ModelViewerLib.parsers.mdlx.Model;

/**
 * MMD 内置动作目录（ModelMMD/Motions/，webpack 随 ModelMMD 一并拷贝）。
 * 前 5 个由 scripts/generate-builtin-vmds.js 原创生成，wavefile_v2.vmd
 * 来自 three.js 官方示例（社区动作，许可见 ModelMMD/Motions/README-wavefile.txt）。
 */
const MMD_MOTIONS_BASE = './ModelMMD/Motions/';
// 内置动作内容版本号：VMD 重新生成后递增，避免浏览器缓存旧动作
const MMD_MOTIONS_VERSION = 6;
const MMD_BUILTIN_MOTIONS = [
    { name: '待机-呼吸', file: 'idle_breath.vmd' },
    { name: '走路（MMDAgent）', file: 'mmdagent_walk.vmd' },
    { name: '挥手（MMDAgent）', file: 'mmdagent_wave.vmd' },
    { name: '会釈-行礼（MMDAgent）', file: 'mmdagent_eshaku.vmd' },
    { name: '舞蹈-WAVEFILE', file: 'wavefile_v2.vmd' },
];

/**
 * Monkey-patch: 让 mdx-m3-viewer 优先使用 WebGL 2.0 context
 * WebGL 2.0 原生支持浮点纹理和实例化渲染，不需要 OES_texture_float / ANGLE_instanced_arrays 扩展
 * 很多手机浏览器在 WebGL 1.0 下不支持这些扩展，但在 WebGL 2.0 下原生支持
 */
function setupWebGL2Polyfill() {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function (contextType, ...args) {
        // 当请求 webgl 或 experimental-webgl 时，优先尝试 webgl2
        if (contextType === 'webgl' || contextType === 'experimental-webgl') {
            let gl = originalGetContext.call(this, 'webgl2', ...args);
            if (gl) {
                console.log('[WebGL2Polyfill] 使用 WebGL 2.0 context');
                return gl;
            }
            // 回退到原本请求的 context 类型
            console.log('[WebGL2Polyfill] WebGL 2.0 不可用，回退到 ' + contextType);
        }
        return originalGetContext.call(this, contextType, ...args);
    };
}

/**
 * 为 WebGL 2.0 context 创建扩展 polyfill
 * mdx-m3-viewer 调用 ensureExtension('OES_texture_float') 和 ensureExtension('ANGLE_instanced_arrays')
 * 在 WebGL 2.0 下这些是核心功能，需要返回兼容的 polyfill 对象
 */
function patchWebGLExtensions(viewer) {
    const gl = viewer.gl;
    const webgl = viewer.webgl;
    const isWebGL2 = typeof gl.drawArraysInstanced === 'function'; // WebGL2 独有方法

    if (!isWebGL2) {
        console.log('[WebGL2Polyfill] 当前为 WebGL 1.0，不应用 polyfill');
        return false;
    }

    // ---- 1. Patch texImage2D: WebGL 2.0 下 FLOAT 纹理需要 sized internal format ----
    // mdx-m3-viewer 使用 gl.RGBA + gl.FLOAT（unsized），某些驱动会静默失败
    // 改为 gl.RGBA32F 等 sized internal format
    const originalTexImage2D = gl.texImage2D.bind(gl);
    gl.texImage2D = function (target, level, internalformat, ...rest) {
        if (internalformat === gl.RGBA && rest.length >= 5 && rest[4] === gl.FLOAT) {
            internalformat = gl.RGBA32F;
        } else if (internalformat === gl.RGB && rest.length >= 5 && rest[4] === gl.FLOAT) {
            internalformat = gl.RGB32F;
        } else if (internalformat === gl.LUMINANCE && rest.length >= 5 && rest[4] === gl.FLOAT) {
            internalformat = gl.R32F;
        } else if (internalformat === gl.LUMINANCE_ALPHA && rest.length >= 5 && rest[4] === gl.FLOAT) {
            internalformat = gl.RG32F;
        }
        return originalTexImage2D(target, level, internalformat, ...rest);
    };

    // ---- 2. 覆盖 ensureExtension ----
    const originalEnsureExtension = webgl.ensureExtension.bind(webgl);
    webgl.ensureExtension = function (name) {
        if (name === 'OES_texture_float') {
            if (!this.extensions[name]) {
                this.extensions[name] = {};
            }
            return true;
        }
        if (name === 'OES_texture_float_linear') {
            // 浮点纹理线性过滤 — bone texture 可能使用 LINEAR，缺少此扩展会导致纹理 incomplete
            const real = originalEnsureExtension(name);
            if (!real) {
                if (!this.extensions[name]) {
                    this.extensions[name] = {};
                }
                return true;
            }
            return true;
        }
        if (name === 'ANGLE_instanced_arrays') {
            // WebGL 2.0 原生支持实例化渲染，创建兼容 API 的 polyfill
            if (!this.extensions[name]) {
                this.extensions[name] = {
                    vertexAttribDivisorANGLE: (index, divisor) => gl.vertexAttribDivisor(index, divisor),
                    drawArraysInstancedANGLE: (mode, first, count, primcount) =>
                        gl.drawArraysInstanced(mode, first, count, primcount),
                    drawElementsInstancedANGLE: (mode, count, type, offset, primcount) =>
                        gl.drawElementsInstanced(mode, count, type, offset, primcount),
                };
            }
            return true;
        }
        // 其他扩展走原逻辑
        return originalEnsureExtension(name);
    };

    console.log('[WebGL2Polyfill] WebGL 2.0 扩展 polyfill 已安装 (texImage2D sized format + OES_texture_float + OES_texture_float_linear + ANGLE_instanced_arrays)');
    return true;
}

class War3ModelViewerApp {
    constructor() {
        this.viewer = null;
        this.scene = null;
        this.currentModel = null;
        this.currentInstance = null;
        this.autoRotate = false;
        this.isPaused = false;
        this.rotationSpeed = 0.005;
        this.lastFrameTime = 0;

        // 相机状态
        this.cameraDistance = 500;
        this.cameraAngleX = 0;
        this.cameraAngleY = 0.3;

        // 线框模式状态
        this.wireframeBuffers = null;

        // 模型加载令牌：防止快速切换时旧模型加载完覆盖新模型
        this._loadToken = 0;
        this._currentModelPath = null;   // 当前已加载/显示的模型路径（用于同模型点击跳过）
        this.mmdModelCache = new Map();  // 已加载的 MMD 模型缓存（仅存已卸载的模型，最多 2 个）

        // 模型源数据（用于解析面数据）
        this.modelSource = null;
        this.modelParser = null;

        // ===== MMD 通道状态 =====
        this.mmdMode = false;
        this.mmdRenderer = null;
        this.mmdMotions = [];       // { name, animation }
        this.mmdCurrentMotion = -1;
        this.mmdFit = null;         // 当前 MMD 模型的自动取景结果

        // 皮肤背景色
        this.themeColors = {
            dark: [0.1, 0.1, 0.15],
            light: [0.78, 0.81, 0.88]
        };

        // War3资源目录（MPQ解压后的文件）
        this.war3AssetsPath = './War3Assets/';
        this.uploadedAssets = new Map(); // 用户上传的资源文件 blob URL

        this.init();
    }

    // ===== 移动端调试日志系统 =====
    initDebugSystem() {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
                          || window.innerWidth < 768;

        const panel = document.getElementById('debug-panel');
        const panelBody = document.getElementById('debug-panel-body');
        const toggleBtn = document.getElementById('debug-toggle-btn');
        const closeBtn = document.getElementById('debug-close-btn');
        const clearBtn = document.getElementById('debug-clear-btn');
        const header = document.getElementById('debug-panel-header');

        const appendLog = (level, args) => {
            if (!panelBody) return;
            const time = new Date().toLocaleTimeString();
            const msg = args.map(a => {
                if (typeof a === 'object') {
                    try { return JSON.stringify(a).slice(0, 300); }
                    catch (e) { return String(a).slice(0, 300); }
                }
                return String(a).slice(0, 300);
            }).join(' ');
            const div = document.createElement('div');
            div.className = `debug-log-entry ${level}`;
            div.innerHTML = `<span class="time">[${time}]</span>${escapeHtml(level.toUpperCase())}: ${escapeHtml(msg)}`;
            panelBody.appendChild(div);
            panelBody.scrollTop = panelBody.scrollHeight;
            // 限制日志数量
            while (panelBody.children.length > 200) {
                panelBody.removeChild(panelBody.firstChild);
            }
        };

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // 劫持 console 方法
        const origError = console.error.bind(console);
        const origWarn = console.warn.bind(console);
        const origLog = console.log.bind(console);
        const origInfo = console.info.bind(console);

        console.error = (...args) => { origError(...args); appendLog('error', args); };
        console.warn = (...args) => { origWarn(...args); appendLog('warn', args); };
        console.log = (...args) => { origLog(...args); appendLog('info', args); };
        console.info = (...args) => { origInfo(...args); appendLog('info', args); };

        // 捕获未处理错误
        window.addEventListener('error', (e) => {
            appendLog('error', [`${e.message} (${e.filename}:${e.lineno})`]);
        });
        window.addEventListener('unhandledrejection', (e) => {
            appendLog('error', ['Unhandled Promise:', e.reason]);
        });

        // 绑定按钮事件
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                panel.classList.remove('visible');
                toggleBtn.classList.add('visible');
            });
        }
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                panelBody.innerHTML = '';
            });
        }
        if (header) {
            header.addEventListener('click', (e) => {
                if (e.target.tagName !== 'BUTTON') {
                    panel.classList.remove('visible');
                    toggleBtn.classList.add('visible');
                }
            });
        }
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                panel.classList.add('visible');
                toggleBtn.classList.remove('visible');
            });
        }

        // 移动端自动显示调试面板
        if (isMobile) {
            toggleBtn.classList.add('visible');
        }

        appendLog('info', ['调试系统已启动', '移动端: ' + isMobile, '屏幕尺寸: ' + window.innerWidth + 'x' + window.innerHeight]);
    }

    async init() {
        // 初始化调试系统（尽早启动以捕获所有错误）
        this.initDebugSystem();

        // 初始化皮肤（在渲染之前）
        this.initTheme();

        // 预检：用临时 canvas 检测 WebGL 1.0 扩展支持
        // 只有缺少扩展时才启用 WebGL 2.0 polyfill，避免影响桌面端
        const testCanvas = document.createElement('canvas');
        const testCtx = testCanvas.getContext('webgl', { alpha: false });
        const hasFloatExt = testCtx && testCtx.getExtension('OES_texture_float');
        const hasInstancedExt = testCtx && testCtx.getExtension('ANGLE_instanced_arrays');
        const needsWebGL2 = !hasFloatExt || !hasInstancedExt;
        console.log('[Init] WebGL 1.0 扩展检测: OES_texture_float=' + !!hasFloatExt + ', ANGLE_instanced_arrays=' + !!hasInstancedExt + ', 需要WebGL2: ' + needsWebGL2);
        if (needsWebGL2) {
            setupWebGL2Polyfill();
            console.log('[Init] 已启用 WebGL 2.0 polyfill');
        }

        const canvas = document.getElementById('canvas');
        this.resizeCanvas();

        try {
            this.viewer = new ModelViewer(canvas, { alpha: false, antialias: true, preserveDrawingBuffer: false, powerPreference: 'default' });
            console.log('[Init] WebGL Viewer 创建成功');
        } catch (e) {
            console.error('WebGL 初始化失败:', e);
            alert('WebGL 不可用，请使用支持 WebGL 的浏览器。错误: ' + e.message);
            return;
        }

        // 为 WebGL 2.0 context 安装扩展 polyfill
        const polyfilled = patchWebGLExtensions(this.viewer);

        this.scene = this.viewer.addScene();
        const savedBg = localStorage.getItem('war3-bg-color');
        if (savedBg) {
            this.customBgColor = savedBg;
            const bgInput = document.getElementById('bg-color-input');
            if (bgInput) bgInput.value = savedBg;
        }
        this.updateSceneColor();

        this.viewer.on('error', (error) => {
            console.error('Viewer error:', error);
        });

        // 检测 WebGL 版本和扩展支持
        const gl = this.viewer.gl;
        const isWebGL2 = typeof gl.drawArraysInstanced === 'function';
        console.log('[Init] WebGL 版本: ' + (isWebGL2 ? '2.0' : '1.0') + ', polyfill: ' + polyfilled);
        if (!isWebGL2) {
            const extFloat = gl.getExtension('OES_texture_float');
            const extInstanced = gl.getExtension('ANGLE_instanced_arrays');
            console.log('[Init] WebGL 1.0 扩展: OES_texture_float=' + !!extFloat + ', ANGLE_instanced_arrays=' + !!extInstanced);
            if (!extFloat || !extInstanced) {
                console.error('[Init] WebGL 1.0 下缺少扩展，MDX handler 可能注册失败');
            }
        }

        let mdxHandlerOk = false;
        try {
            mdxHandlerOk = this.viewer.addHandler(handlers.mdx, (path) => {
                return this.resolveAssetPath(path);
            });
            console.log('[Init] MDX handler 注册结果: ' + mdxHandlerOk);
            if (!mdxHandlerOk) {
                console.error('[Init] MDX handler 注册失败！模型将无法加载。');
            }
        } catch (e) {
            console.error('[Init] MDX handler 注册异常:', e);
        }
        this.viewer.addHandler(handlers.blp);
        this.viewer.addHandler(handlers.tga);
        this.viewer.addHandler(handlers.dds);

        const camera = this.scene.camera;
        camera.perspective(Math.PI / 4, canvas.width / canvas.height, 1, 10000);

        this.setupEventListeners();
        this.setupCameraControls();
        this.lastFrameTime = performance.now();
        this.animate();

        this.loadModel('./Models/初音/HeroMiku.MDx', '初音未来');
    }

    // ===== 皮肤相关 =====
    initTheme() {
        const savedTheme = localStorage.getItem('war3-theme');
        let theme;
        if (savedTheme === 'dark' || savedTheme === 'light') {
            theme = savedTheme;
        } else {
            // 读取系统夜间模式偏好
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            theme = prefersDark ? 'dark' : 'light';
        }
        this.setTheme(theme, false);
    }

    setTheme(theme, save = true) {
        document.body.setAttribute('data-theme', theme);
        const btn = document.getElementById('theme-toggle-btn');
        if (btn) {
            btn.textContent = theme === 'dark' ? '🌙' : '☀️';
        }
        if (save) {
            localStorage.setItem('war3-theme', theme);
        }
        if (this.scene) {
            this.updateSceneColor();
        }
    }

    toggleTheme() {
        const current = document.body.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        this.setTheme(next);
    }

    updateSceneColor() {
        if (this.customBgColor) {
            const rgb = this.hexToRgb(this.customBgColor);
            this.scene.color = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
            this.viewer.gl.clearColor(rgb.r / 255, rgb.g / 255, rgb.b / 255, 1);
            if (this.mmdRenderer) this.mmdRenderer.setBackground(this.customBgColor);
            return;
        }
        const theme = document.body.getAttribute('data-theme');
        const color = this.themeColors[theme] || this.themeColors.dark;
        this.scene.color = [color[0], color[1], color[2]];
        this.viewer.gl.clearColor(color[0], color[1], color[2], 1);
        if (this.mmdRenderer) this.mmdRenderer.setBackground(this.rgbToHex(color));
    }

    setBackgroundColor(hex) {
        this.customBgColor = hex;
        const rgb = this.hexToRgb(hex);
        this.scene.color = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
        this.viewer.gl.clearColor(rgb.r / 255, rgb.g / 255, rgb.b / 255, 1);
        if (this.mmdRenderer) this.mmdRenderer.setBackground(hex);
        localStorage.setItem('war3-bg-color', hex);
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 26, g: 26, b: 46 };
    }

    // ===== 资源路径解析 =====
    // 缓存：路径大小写映射（避免反复扫描目录）
    // key: 小写相对路径, value: 实际路径（含正确大小写）
    _pathCaseCache = new Map();
    _pathCaseCacheDir = null; // 当前缓存的基础目录

    resolveAssetPath(assetPath) {
        const normalizedPath = assetPath.replace(/\\/g, '/');

        // 1. 先查找用户上传的资源
        if (this.uploadedAssets.has(normalizedPath)) {
            return this.uploadedAssets.get(normalizedPath);
        }
        const lowerPath = normalizedPath.toLowerCase();
        if (this.uploadedAssets.has(lowerPath)) {
            return this.uploadedAssets.get(lowerPath);
        }

        // 2. 判断是否为 War3 标准资源
        const isWar3Path = normalizedPath.startsWith('ReplaceableTextures/') ||
                          normalizedPath.startsWith('Units/') ||
                          normalizedPath.startsWith('Abilities/') ||
                          normalizedPath.startsWith('Doodads/') ||
                          normalizedPath.startsWith('Environment/') ||
                          normalizedPath.startsWith('UI/') ||
                          normalizedPath.startsWith('SharedModels/') ||
                          normalizedPath.startsWith('Textures/');

        // 如果当前模型是 War3 模型，或者路径看起来像 War3 标准路径
        const modelDirIsWar3 = this.currentModelDir && this.currentModelDir.startsWith('War3Assets/');

        if ((isWar3Path || modelDirIsWar3) && normalizedPath.includes('/')) {
            // War3 标准路径：映射到 War3Assets/ 目录
            return this.war3AssetsPath + this.resolveCaseInsensitive(normalizedPath);
        }

        // 3. 自定义模型的路径：相对于当前模型目录解析
        if (this.currentModelDir) {
            // 如果路径包含 /，说明是相对路径，需要规范化
            if (normalizedPath.includes('/')) {
                // 提取文件名部分，忽略目录部分（因为自定义模型贴图通常在同目录）
                const fileName = normalizedPath.split('/').pop();
                return this.currentModelDir + '/' + fileName;
            }
            return this.currentModelDir + '/' + normalizedPath;
        }

        // 4. 无目录信息，返回原路径由调用方处理
        return assetPath;
    }

    // 大小写不敏感路径解析：在 War3Assets 中查找实际路径
    // 例如引用 "units/Creeps/X/Y.blp" 实际为 "Units/Creeps/X/Y.blp"
    resolveCaseInsensitive(refPath) {
        const lower = refPath.toLowerCase();
        // 检查缓存
        if (this._pathCaseCache.has(lower)) {
            return this._pathCaseCache.get(lower);
        }

        // 直接构造路径检查（快速路径：大小写正好匹配）
        // 此处无法访问 fs，所以用 try-catch + 同步 XHR 不可行
        // 改为：对常见目录做大小写修正
        const fixed = this.fixCommonCaseIssues(refPath);
        this._pathCaseCache.set(lower, fixed);
        return fixed;
    }

    // 修正 War3 资源路径中常见的大小写问题
    // Linux/GitHub Pages 区分大小写，但 MDX 内部引用的目录名常与实际不符
    // 此映射表通过扫描所有 mdx 文件统计得出（共 15 个目录需修正）
    static CASE_FIX_MAP = {
        'abilities': 'Abilities',
        'altarofelders': 'AltarOfElders',
        'altarofstorms': 'AltarOfStorms',
        'ancientoflore': 'AncientOfLore',
        'ancientofwar': 'AncientOfWar',
        'ancientofwind': 'AncientOfWind',
        'doodads': 'Doodads',
        'environment': 'Environment',
        'gyrocopter': 'GyroCopter',
        'minimap': 'MiniMap',
        'objects': 'Objects',
        'treasurechest': 'TreasureChest',
        'treeoflife': 'TreeOfLife',
        'ui': 'UI',
        'units': 'Units',
    };

    fixCommonCaseIssues(refPath) {
        const sep = '/';
        const parts = refPath.split(sep);
        // 只修正目录部分（最后一段是文件名，不修正）
        for (let i = 0; i < parts.length - 1; i++) {
            const lower = parts[i].toLowerCase();
            if (this.constructor.CASE_FIX_MAP[lower]) {
                parts[i] = this.constructor.CASE_FIX_MAP[lower];
            }
        }
        return parts.join(sep);
    }

    // ===== 事件监听 =====
    setupEventListeners() {
        document.getElementById('theme-toggle-btn').addEventListener('click', () => {
            this.toggleTheme();
        });

        const modelSearch = document.getElementById('model-search');
        if (modelSearch) {
            modelSearch.addEventListener('input', (e) => this.filterModelTree(e.target.value));
        }

        document.querySelectorAll('.model-item').forEach(item => {
            item.addEventListener('click', () => {
                const modelPath = item.querySelector('.model-path').textContent;
                const modelName = item.querySelector('.model-name').textContent;
                document.querySelectorAll('.model-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                this.loadModel(modelPath, modelName);
            });
        });

        // 加载模型树
        this.loadModelTree();

        // 动作列表点击（事件委托）
        document.getElementById('animation-list').addEventListener('click', (e) => {
            const item = e.target.closest('.animation-item');
            if (item && this.currentInstance) {
                const index = parseInt(item.dataset.index);
                this.selectAnimation(index);
                // 移动端：选择后收起下拉
                const list = document.getElementById('animation-list');
                const trigger = document.getElementById('animation-dropdown-trigger');
                if (list && trigger && list.classList.contains('dropdown-open')) {
                    list.classList.remove('dropdown-open');
                    trigger.classList.remove('open');
                    trigger.setAttribute('aria-expanded', 'false');
                }
            }
        });

        // 动作下拉触发器：点击切换展开/收起
        const animTrigger = document.getElementById('animation-dropdown-trigger');
        if (animTrigger) {
            animTrigger.addEventListener('click', () => {
                const list = document.getElementById('animation-list');
                if (!list) return;
                const isOpen = list.classList.toggle('dropdown-open');
                animTrigger.classList.toggle('open', isOpen);
                animTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            });
        }

        document.getElementById('play-btn').addEventListener('click', () => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.setPaused(false);
                this.isPaused = false;
                const speed = parseFloat(document.getElementById('speed-slider').value);
                this.mmdRenderer.setSpeed(speed);
                return;
            }
            if (this.currentInstance) {
                this.isPaused = false;
                const speed = parseFloat(document.getElementById('speed-slider').value);
                this.currentInstance.timeScale = speed;
            }
        });

        document.getElementById('pause-btn').addEventListener('click', () => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.setPaused(true);
                this.isPaused = true;
                return;
            }
            if (this.currentInstance) {
                this.isPaused = true;
                this.currentInstance.timeScale = 0;
            }
        });

        document.getElementById('stop-btn').addEventListener('click', () => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.stop();
                this.isPaused = false;
                this.mmdCurrentMotion = -1;
                this.updateMmdAnimationList();
                return;
            }
            if (this.currentInstance) {
                this.currentInstance.setSequence(-1);
                this.isPaused = false;
                document.querySelectorAll('.animation-item').forEach(i => i.classList.remove('active'));
            }
        });

        document.getElementById('loop-checkbox').addEventListener('change', (e) => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.setLoop(e.target.checked);
            }
            if (this.currentInstance) {
                this.currentInstance.setSequenceLoopMode(e.target.checked ? 2 : 0);
            }
        });

        const speedSlider = document.getElementById('speed-slider');
        speedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            document.getElementById('speed-value').textContent = speed.toFixed(2) + 'x';
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.setSpeed(speed);
                return;
            }
            if (this.currentInstance && !this.isPaused) {
                this.currentInstance.timeScale = speed;
            }
        });

        document.getElementById('reset-camera-btn').addEventListener('click', () => {
            this.resetCamera();
        });

        document.getElementById('auto-rotate-btn').addEventListener('click', () => {
            this.autoRotate = !this.autoRotate;
            document.getElementById('auto-rotate-btn').textContent = this.autoRotate ? '停止旋转' : '自动旋转';
        });

        document.getElementById('wireframe-checkbox').addEventListener('change', (e) => {
            this.setWireframe(e.target.checked);
        });

        const bgColorInput = document.getElementById('bg-color-input');
        if (bgColorInput) {
            bgColorInput.addEventListener('input', (e) => {
                this.setBackgroundColor(e.target.value);
            });
        }

        document.querySelectorAll('.bg-preset').forEach(btn => {
            // 设置圆圈显示其对应的颜色
            btn.style.backgroundColor = btn.dataset.color;
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                document.getElementById('bg-color-input').value = color;
                this.setBackgroundColor(color);
            });
        });

        document.getElementById('team-color-select').addEventListener('change', (e) => {
            if (this.currentInstance) {
                const color = parseInt(e.target.value);
                this.applyTeamColor(color);
            }
        });

        // ===== MMD 动作上传 =====
        const mmdMotionInput = document.getElementById('mmd-motion-input');
        const mmdLoadMotionBtn = document.getElementById('mmd-load-motion-btn');
        const mmdLoadMotionBtnM = document.getElementById('mmd-load-motion-btn-m');
        if (mmdMotionInput) {
            mmdMotionInput.addEventListener('change', (e) => {
                this.loadMmdMotionFiles(e.target.files);
                e.target.value = '';
            });
            if (mmdLoadMotionBtn) {
                mmdLoadMotionBtn.addEventListener('click', () => mmdMotionInput.click());
            }
            if (mmdLoadMotionBtnM) {
                mmdLoadMotionBtnM.addEventListener('click', () => mmdMotionInput.click());
            }
        }

        // ===== 移动端紧凑布局控件绑定 =====
        this.setupMobileControls();

        window.addEventListener('resize', () => this.onResize());

        // ===== 移动端侧栏管理 =====
        this.setupMobileSidebars();
    }

    // ===== 移动端紧凑布局控件 =====
    setupMobileControls() {
        const mPlay = document.getElementById('play-btn-m');
        const mPause = document.getElementById('pause-btn-m');
        const mStop = document.getElementById('stop-btn-m');
        const mLoop = document.getElementById('loop-checkbox-m');
        const mSpeed = document.getElementById('speed-slider-m');
        const mSpeedVal = document.getElementById('speed-value-m');
        const mResetCam = document.getElementById('reset-camera-btn-m');
        const mAutoRot = document.getElementById('auto-rotate-btn-m');
        const mWireframe = document.getElementById('wireframe-checkbox-m');
        const mBgColor = document.getElementById('bg-color-input-m');
        const mTeamColor = document.getElementById('team-color-select-m');
        const mAnimTrigger = document.getElementById('animation-dropdown-trigger-m');
        const mAnimList = document.getElementById('animation-list-m');
        const mAnimCurrent = document.getElementById('animation-current-name-m');

        if (!mPlay) return;

        // 动作下拉触发器
        if (mAnimTrigger) {
            mAnimTrigger.addEventListener('click', () => {
                if (!mAnimList) return;
                const isOpen = mAnimList.classList.toggle('dropdown-open');
                mAnimTrigger.classList.toggle('open', isOpen);
                mAnimTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            });
        }

        // 动作列表点击
        if (mAnimList) {
            mAnimList.addEventListener('click', (e) => {
                const item = e.target.closest('.animation-item');
                if (item && (this.currentInstance || this.mmdMode)) {
                    const index = parseInt(item.dataset.index);
                    this.selectAnimation(index);
                    // 收起下拉
                    if (mAnimList.classList.contains('dropdown-open')) {
                        mAnimList.classList.remove('dropdown-open');
                        mAnimTrigger.classList.remove('open');
                        mAnimTrigger.setAttribute('aria-expanded', 'false');
                    }
                }
            });
        }

        // 播放
        mPlay.addEventListener('click', () => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.setPaused(false);
                this.isPaused = false;
                const speed = parseFloat(mSpeed.value);
                this.mmdRenderer.setSpeed(speed);
                return;
            }
            if (this.currentInstance) {
                this.isPaused = false;
                const speed = parseFloat(mSpeed.value);
                this.currentInstance.timeScale = speed;
                // 同步桌面端
                const dSpeed = document.getElementById('speed-slider');
                if (dSpeed) dSpeed.value = mSpeed.value;
                const dSpeedVal = document.getElementById('speed-value');
                if (dSpeedVal) dSpeedVal.textContent = speed.toFixed(2) + 'x';
            }
        });

        // 暂停
        mPause.addEventListener('click', () => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.setPaused(true);
                this.isPaused = true;
                return;
            }
            if (this.currentInstance) {
                this.isPaused = true;
                this.currentInstance.timeScale = 0;
            }
        });

        // 停止
        mStop.addEventListener('click', () => {
            if (this.mmdMode && this.mmdRenderer) {
                this.mmdRenderer.stop();
                this.isPaused = false;
                this.mmdCurrentMotion = -1;
                this.updateMmdAnimationList();
                return;
            }
            if (this.currentInstance) {
                this.currentInstance.setSequence(-1);
                this.isPaused = false;
                // 同步动作项active状态
                document.querySelectorAll('.animation-item').forEach(i => i.classList.remove('active'));
                if (mAnimCurrent) mAnimCurrent.textContent = '未选择';
                const dAnimName = document.getElementById('animation-current-name');
                if (dAnimName) dAnimName.textContent = '未选择';
            }
        });

        // 循环
        if (mLoop) {
            mLoop.addEventListener('change', (e) => {
                if (this.mmdMode && this.mmdRenderer) {
                    this.mmdRenderer.setLoop(e.target.checked);
                }
                if (this.currentInstance) {
                    this.currentInstance.setSequenceLoopMode(e.target.checked ? 2 : 0);
                }
                // 同步桌面端
                const dLoop = document.getElementById('loop-checkbox');
                if (dLoop) dLoop.checked = e.target.checked;
            });
        }

        // 速度
        if (mSpeed) {
            mSpeed.addEventListener('input', (e) => {
                const speed = parseFloat(e.target.value);
                if (mSpeedVal) mSpeedVal.textContent = speed.toFixed(2) + 'x';
                if (this.mmdMode && this.mmdRenderer) {
                    this.mmdRenderer.setSpeed(speed);
                    return;
                }
                if (this.currentInstance && !this.isPaused) {
                    this.currentInstance.timeScale = speed;
                }
                // 同步桌面端
                const dSpeed = document.getElementById('speed-slider');
                const dSpeedVal = document.getElementById('speed-value');
                if (dSpeed) dSpeed.value = speed;
                if (dSpeedVal) dSpeedVal.textContent = speed.toFixed(2) + 'x';
            });
        }

        // 重置视角
        if (mResetCam) {
            mResetCam.addEventListener('click', () => {
                this.resetCamera();
            });
        }

        // 自动旋转
        if (mAutoRot) {
            mAutoRot.addEventListener('click', () => {
                this.autoRotate = !this.autoRotate;
                mAutoRot.textContent = this.autoRotate ? '停转' : '自转';
                // 同步桌面端
                const dBtn = document.getElementById('auto-rotate-btn');
                if (dBtn) dBtn.textContent = this.autoRotate ? '停止旋转' : '自动旋转';
            });
        }

        // 线框
        if (mWireframe) {
            mWireframe.addEventListener('change', (e) => {
                this.setWireframe(e.target.checked);
                // 同步桌面端
                const dWire = document.getElementById('wireframe-checkbox');
                if (dWire) dWire.checked = e.target.checked;
            });
        }

        // 背景色
        if (mBgColor) {
            mBgColor.addEventListener('input', (e) => {
                this.setBackgroundColor(e.target.value);
                // 同步桌面端
                const dBg = document.getElementById('bg-color-input');
                if (dBg) dBg.value = e.target.value;
            });
        }

        // 队伍颜色
        if (mTeamColor) {
            mTeamColor.addEventListener('change', (e) => {
                if (this.currentInstance) {
                    const color = parseInt(e.target.value);
                    this.applyTeamColor(color);
                }
                // 同步桌面端
                const dTeam = document.getElementById('team-color-select');
                if (dTeam) dTeam.value = e.target.value;
            });
        }
    }

    setupMobileSidebars() {
        const overlay = document.getElementById('mobile-overlay');
        const sidebarLeft = document.querySelector('.sidebar-left');
        const sidebarRight = document.querySelector('.sidebar-right');
        const modelsBtn = document.getElementById('mobile-models-btn');
        const rightHandle = document.getElementById('sidebar-right-handle');
        const isMobile = () => window.innerWidth <= 768;

        // ===== 左侧栏：滑出式抽屉 =====
        if (modelsBtn) {
            modelsBtn.addEventListener('click', () => {
                if (!isMobile()) return;
                sidebarLeft.classList.add('mobile-open');
                overlay.classList.add('visible');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', () => {
                sidebarLeft.classList.remove('mobile-open');
                overlay.classList.remove('visible');
            });
        }

        // 选择模型后自动关闭左侧栏
        document.querySelectorAll('.model-item').forEach(item => {
            item.addEventListener('click', () => {
                if (isMobile()) {
                    setTimeout(() => {
                        sidebarLeft.classList.remove('mobile-open');
                        overlay.classList.remove('visible');
                    }, 300);
                }
            });
        });

        // ===== 右侧栏：移动端已改为固定底部紧凑栏，不再需要抽屉状态管理 =====
        // 保留 setDrawerState 仅用于向后兼容（实际上不再生效）
        let drawerState = 'half';
        const setDrawerState = (state) => {
            drawerState = state;
            // 不再添加 mobile-* 状态类，避免影响固定底部栏样式
        };

        // 手柄已隐藏，不再绑定拖拽逻辑
        window.addEventListener('resize', () => {
            // 移动端右侧栏现为固定底部，无需调整
        });
    }

    ensureNeutralTeamColor() {
        try {
            const mdxCache = this.viewer.sharedCache.get('mdx');
            if (!mdxCache) return false;
            if (mdxCache.teamColors[24]) return true;

            // mdx-m3-viewer 渲染管线：
            //   1. batchgroup.js:
            //        let teamColorTexture = textures[teamColorId];
            //        if (teamColorTexture.replaceableId === 0 || === 1) {
            //          teamColorTexture = teamColors[instance.teamColor];
            //        }
            //        const actualTeamColorTexture = ... || teamColorTexture.texture;
            //        webgl.bindTextureAndWrap(actualTeamColorTexture, 4, ...);
            //   2. bindTextureAndWrap 内部: gl.bindTexture(gl.TEXTURE_2D, texture.webglResource);
            //   => 必须提供 wrapper.texture.webglResource 链，不能只设 wrapper.webglResource
            //   => 若用 Object.create(reference)，必须覆盖 .texture，否则会继承 reference 的 .texture（导致显示成其他队伍色）
            const gl = this.viewer.gl;

            const createBlackWrapper = (reference, replaceableId) => {
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                if (reference && reference.wrapS !== undefined) {
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, reference.wrapS);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, reference.wrapT);
                } else {
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                }
                gl.texImage2D(
                    gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                    gl.RGBA, gl.UNSIGNED_BYTE,
                    new Uint8Array([0, 0, 0, 255])
                );
                // 构造一个最小可用的 inner texture 对象（模拟 BlpTexture 接口）
                const innerTexture = {
                    webglResource: tex,
                    width: 1,
                    height: 1
                };
                // 关键：用 Object.create 但覆盖 .texture，避免继承 reference 的 .texture
                const wrapper = reference ? Object.create(reference) : {};
                wrapper.texture = innerTexture;
                wrapper.replaceableId = replaceableId;
                return wrapper;
            };

            const colorWrapper = createBlackWrapper(mdxCache.teamColors[0], 0);
            mdxCache.teamColors[24] = colorWrapper;

            const glowWrapper = createBlackWrapper(mdxCache.teamGlows[0], 1);
            mdxCache.teamGlows[24] = glowWrapper;

            console.log('中立颜色纹理已在内存中创建 (纯黑色)');
            return true;
        } catch (e) {
            console.warn('ensureNeutralTeamColor error:', e);
            return false;
        }
    }

    applyTeamColor(color) {
        if (color === -1 || color === 24) {
            const hasNeutral = this.ensureNeutralTeamColor();
            if (hasNeutral) {
                this.currentInstance.setTeamColor(24);
            } else {
                this.currentInstance.setTeamColor(0);
            }
        } else if (color >= 0 && color <= 15) {
            this.currentInstance.setTeamColor(color);
        }
    }

    selectAnimation(index) {
        if (!this.currentInstance && !this.mmdMode) return;
        if (this.mmdMode) {
            this.playMmdMotion(index);
            return;
        }
        this.currentInstance.setSequence(index);
        this.isPaused = false;
        const dSpeed = document.getElementById('speed-slider');
        const speed = parseFloat(dSpeed ? dSpeed.value : '1');
        this.currentInstance.timeScale = speed;

        // 两个列表都同步高亮
        document.querySelectorAll('.animation-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll(`.animation-item[data-index="${index}"]`).forEach(i => i.classList.add('active'));

        // 获取动作名
        const firstItem = document.querySelector(`.animation-item[data-index="${index}"]`);
        const animName = firstItem ? firstItem.querySelector('.animation-item-name') : null;
        const nameText = animName ? animName.textContent : ('动作 ' + (index + 1));

        // 同步桌面端下拉显示
        const dName = document.getElementById('animation-current-name');
        if (dName) dName.textContent = nameText;

        // 同步移动端下拉显示
        const mName = document.getElementById('animation-current-name-m');
        if (mName) mName.textContent = nameText;
    }

    // ===== 相机控制 =====
    setupCameraControls() {
        const canvas = document.getElementById('canvas');
        const mmdCanvas = document.getElementById('mmd-canvas');
        let isDragging = false;
        let dragButton = 0;
        let lastX = 0;
        let lastY = 0;

        // 摄像机目标点（用于平移）
        this.cameraTarget = [0, 0, 0];

        const bindCanvas = (el) => {
            if (!el) return;

            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
            });

            el.addEventListener('mousedown', (e) => {
                isDragging = true;
                dragButton = e.button;
                lastX = e.clientX;
                lastY = e.clientY;
                this.autoRotate = false;
                document.getElementById('auto-rotate-btn').textContent = '自动旋转';
                const mBtn = document.getElementById('auto-rotate-btn-m');
                if (mBtn) mBtn.textContent = '自转';
            });

            el.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const dx = e.clientX - lastX;
                const dy = e.clientY - lastY;

                if (dragButton === 0) {
                    // 左键：旋转
                    this.cameraAngleX -= dx * 0.01;
                    this.cameraAngleY += dy * 0.01;
                    this.cameraAngleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.cameraAngleY));
                } else if (dragButton === 2 || dragButton === 1) {
                    // 右键/中键：平移（"抓取"模式 - 拖动方向 = 场景移动方向）
                    const panSpeed = this.cameraDistance * 0.002;
                    // 计算右方向和上方向在世界空间中的向量
                    const ax = this.cameraAngleX;
                    const ay = this.cameraAngleY;
                    // 右方向（屏幕右 -> 世界X/Z平面）
                    const rightX = Math.cos(ax);
                    const rightZ = -Math.sin(ax);
                    // 上方向（屏幕上 -> 世界Y + 部分X/Z）
                    const upX = -Math.sin(ax) * Math.sin(ay);
                    const upY = Math.cos(ay);
                    const upZ = -Math.cos(ax) * Math.sin(ay);

                    // 拖动右(dx>0) => 场景右移 => 摄像机左移 => 目标点 - right
                    // 拖动下(dy>0) => 场景下移 => 摄像机上移 => 目标点 + up
                    this.cameraTarget[0] -= rightX * dx * panSpeed;
                    this.cameraTarget[2] -= rightZ * dx * panSpeed;
                    this.cameraTarget[0] += upX * dy * panSpeed;
                    this.cameraTarget[1] += upY * dy * panSpeed;
                    this.cameraTarget[2] += upZ * dy * panSpeed;
                }

                lastX = e.clientX;
                lastY = e.clientY;
                this.applyCameraState();
            });

            el.addEventListener('mouseup', () => { isDragging = false; });
            el.addEventListener('mouseleave', () => { isDragging = false; });

            el.addEventListener('wheel', (e) => {
                e.preventDefault();
                if (this.mmdMode) {
                    // MMD 模型尺寸远小于 War3 模型：按当前距离比例缩放（每格约 12%），
                    // 自动适配不同模型的大小
                    this.cameraDistance *= Math.pow(1.0012, e.deltaY);
                } else {
                    this.cameraDistance += e.deltaY * 0.5;
                }
                const minDist = this.mmdMode ? 3 : 50;
                this.cameraDistance = Math.max(minDist, Math.min(2000, this.cameraDistance));
                this.applyCameraState();
            });

            // ===== 触控操作 =====
            let touches = []; // 当前活跃的触摸点
            let pinchStartDist = 0;
            let pinchStartDistance = 0;

            el.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.autoRotate = false;
                const btn = document.getElementById('auto-rotate-btn');
                if (btn) btn.textContent = '自动旋转';
                const mBtn = document.getElementById('auto-rotate-btn-m');
                if (mBtn) mBtn.textContent = '自转';

                touches = Array.from(e.touches);

                if (touches.length === 2) {
                    // 双指：开始缩放
                    const dx = touches[0].clientX - touches[1].clientX;
                    const dy = touches[0].clientY - touches[1].clientY;
                    pinchStartDist = Math.sqrt(dx * dx + dy * dy);
                    pinchStartDistance = this.cameraDistance;
                } else if (touches.length === 1) {
                    // 单指：开始旋转
                    lastX = touches[0].clientX;
                    lastY = touches[0].clientY;
                }
            }, { passive: false });

            el.addEventListener('touchmove', (e) => {
                e.preventDefault();
                touches = Array.from(e.touches);

                if (touches.length === 2 && pinchStartDist > 0) {
                    // 双指缩放
                    const dx = touches[0].clientX - touches[1].clientX;
                    const dy = touches[0].clientY - touches[1].clientY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const scale = pinchStartDist / dist;
                    const minDist = this.mmdMode ? 3 : 50;
                    this.cameraDistance = Math.max(minDist, Math.min(2000, pinchStartDistance * scale));
                    this.applyCameraState();
                } else if (touches.length === 1) {
                    // 单指旋转
                    const dx = touches[0].clientX - lastX;
                    const dy = touches[0].clientY - lastY;
                    this.cameraAngleX -= dx * 0.01;
                    this.cameraAngleY += dy * 0.01;
                    this.cameraAngleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.cameraAngleY));
                    lastX = touches[0].clientX;
                    lastY = touches[0].clientY;
                    this.applyCameraState();
                }
            }, { passive: false });

            el.addEventListener('touchend', (e) => {
                e.preventDefault();
                touches = Array.from(e.touches);
                if (touches.length === 0) {
                    pinchStartDist = 0;
                } else if (touches.length === 1) {
                    // 从双指变单指，重置旋转起点
                    lastX = touches[0].clientX;
                    lastY = touches[0].clientY;
                    pinchStartDist = 0;
                }
            }, { passive: false });
        };

        bindCanvas(canvas);
        bindCanvas(mmdCanvas);

        this.resetCamera = () => {
            if (this.mmdMode && this.mmdFit) {
                // MMD 模式：恢复模型自动取景
                this.cameraDistance = this.mmdFit.distance;
                this.cameraAngleX = 0;
                this.cameraAngleY = 0.3;
                this.cameraTarget = [...this.mmdFit.target];
            } else {
                this.cameraDistance = 500;
                this.cameraAngleX = 0;
                this.cameraAngleY = 0.3;
                this.cameraTarget = [0, 0, 0];
            }
            this.applyCameraState();
        };

        this.applyCameraState();
    }

    applyCameraState() {
        const tx = this.cameraTarget ? this.cameraTarget[0] : 0;
        const ty = this.cameraTarget ? this.cameraTarget[1] : 0;
        const tz = this.cameraTarget ? this.cameraTarget[2] : 0;
        const x = Math.sin(this.cameraAngleX) * Math.cos(this.cameraAngleY) * this.cameraDistance;
        const y = Math.sin(this.cameraAngleY) * this.cameraDistance;
        const z = Math.cos(this.cameraAngleX) * Math.cos(this.cameraAngleY) * this.cameraDistance;

        if (this.mmdMode && this.mmdRenderer && this.mmdRenderer.ready) {
            this.mmdRenderer.setCamera([tx + x, ty + y, tz + z], [tx, ty, tz]);
        } else if (this.scene) {
            this.scene.camera.setLocation([tx + x, ty + y, tz + z]);
            this.scene.camera.face([tx, ty, tz], [0, 1, 0]);
        }
        this.updateOrientationIndicator();
    }

    // ===== 视角示意球 =====
    updateOrientationIndicator() {
        document.getElementById('zoom-value').textContent = Math.round(this.cameraDistance);
        document.getElementById('angle-x-value').textContent = Math.round(this.cameraAngleX * 180 / Math.PI) + '°';
        document.getElementById('angle-y-value').textContent = Math.round(this.cameraAngleY * 180 / Math.PI) + '°';

        const axes = document.getElementById('orientation-axes');
        if (!axes) return;

        const ax = this.cameraAngleX;
        const ay = this.cameraAngleY;

        // 将3D单位向量根据相机旋转投影到2D屏幕
        const project = (vx, vy, vz) => {
            // 绕Y轴旋转ax
            const x1 = vx * Math.cos(ax) + vz * Math.sin(ax);
            const y1 = vy;
            const z1 = -vx * Math.sin(ax) + vz * Math.cos(ax);
            // 绕X轴旋转ay
            const x2 = x1;
            const y2 = y1 * Math.cos(ay) - z1 * Math.sin(ay);
            return { x: x2 * 35, y: -y2 * 35 };
        };

        const yEnd = project(0, 1, 0);
        const xEnd = project(1, 0, 0);
        const zEnd = project(0, 0, 1);

        const lines = axes.querySelectorAll('line');
        const circles = axes.querySelectorAll('circle');
        const texts = axes.querySelectorAll('text');

        // Y轴（红色，向上）
        lines[0].setAttribute('x2', yEnd.x);
        lines[0].setAttribute('y2', yEnd.y);
        circles[0].setAttribute('cx', yEnd.x);
        circles[0].setAttribute('cy', yEnd.y);
        texts[0].setAttribute('x', yEnd.x * 1.2);
        texts[0].setAttribute('y', yEnd.y * 1.2 + 3);

        // X轴（绿色，向右）
        lines[1].setAttribute('x2', xEnd.x);
        lines[1].setAttribute('y2', xEnd.y);
        circles[1].setAttribute('cx', xEnd.x);
        circles[1].setAttribute('cy', xEnd.y);
        texts[1].setAttribute('x', xEnd.x * 1.2);
        texts[1].setAttribute('y', xEnd.y * 1.2 + 3);

        // Z轴（蓝色，向前）
        lines[2].setAttribute('x2', zEnd.x);
        lines[2].setAttribute('y2', zEnd.y);
        circles[2].setAttribute('cx', zEnd.x);
        circles[2].setAttribute('cy', zEnd.y);
        texts[2].setAttribute('x', zEnd.x * 1.2);
        texts[2].setAttribute('y', zEnd.y * 1.2 + 3);
    }

    showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (show) {
            overlay.classList.remove('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    }

    // ===== 模型加载 =====
    async loadModel(modelPath, modelName) {
        // 已加载同一模型：跳过，避免重复下载/解析
        if (this._currentModelPath === modelPath) {
            console.log('[ModelLoader] 已加载同一模型，跳过:', modelPath);
            return;
        }

        // MMD 模型（.pmd/.pmx）走独立渲染通道
        if (this.isMmdFile(modelPath)) {
            this.loadMmdModel(modelPath, modelName);
            return;
        }

        // 递增加载令牌，旧的加载请求完成后会被丢弃
        const myToken = ++this._loadToken;
        // 切回 MDX 时把当前 MMD 模型移入缓存，便于快速切回
        if (this.mmdRenderer && this.mmdRenderer.model) {
            const mmdModel = this.mmdRenderer.detachModel();
            if (mmdModel && this._currentModelPath) {
                this.mmdModelCache.set(this._currentModelPath, {
                    model: mmdModel,
                    fit: this.mmdFit,
                    motions: this.mmdMotions,
                });
                this.trimMmdModelCache();
            }
        }
        // 加载 MDX 模型时切回 MDX 渲染通道
        this.setMmdMode(false);

        this.showLoading(true);
        document.getElementById('model-info').textContent = '正在加载: ' + modelName;
        console.log('[ModelLoader] 开始加载模型:', modelPath, 'token=' + myToken);

        // 立即移除当前实例（避免画面上残留旧模型）
        if (this.currentInstance) {
            this.scene.removeInstance(this.currentInstance);
            this.currentInstance = null;
            this.currentModel = null;
        }

        // 预检：测试模型文件是否可访问
        try {
            const probeResp = await fetch(modelPath, { method: 'HEAD' });
            // 令牌已过期（用户又点了别的模型），直接放弃
            if (myToken !== this._loadToken) {
                console.log('[ModelLoader] 令牌已过期，放弃加载:', modelPath);
                return;
            }
            console.log('[ModelLoader] 预检 HEAD ' + modelPath + ' -> ' + probeResp.status + ' ' + probeResp.statusText);
            if (!probeResp.ok) {
                throw new Error('模型文件不可访问 (HTTP ' + probeResp.status + '): ' + modelPath);
            }
        } catch (probeErr) {
            if (myToken !== this._loadToken) return;
            console.error('[ModelLoader] 预检失败:', probeErr);
            this.showLoading(false);
            this.showError('无法加载模型', modelPath, '预检失败: ' + (probeErr.message || probeErr));
            return;
        }

        // 重置线框状态
        this.wireframeBuffers = null;
        this.modelParser = null;
        document.getElementById('wireframe-checkbox').checked = false;

        this.modelSource = modelPath;

        try {
            // 记录当前模型所在目录（用于解析简单文件名贴图，如 miku1.blp）
            const lastSlashIdx = modelPath.lastIndexOf('/');
            this.currentModelDir = lastSlashIdx >= 0 ? modelPath.substring(0, lastSlashIdx) : '';

            const isWar3Model = modelPath.startsWith('War3Assets/');

            // 自定义模型贴图大小写缓存：key=小写 URL, value=实际可访问的 URL
            const customTextureCaseCache = new Map();
            // 自定义模型目录文件清单缓存：key=目录 URL, value=Set<小写文件名>
            const customDirListingCache = new Map();

            // 异步探测 URL 是否存在（带超时）
            const probeUrl = async (url, timeoutMs = 5000) => {
                if (customTextureCaseCache.has(url)) {
                    return customTextureCaseCache.get(url);
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const response = await fetch(url, { method: 'HEAD', signal: controller.signal, cache: 'no-store' });
                    if (response.ok) {
                        customTextureCaseCache.set(url, url);
                        return url;
                    }
                } catch (e) {
                    // 网络错误或超时
                } finally {
                    clearTimeout(timeoutId);
                }
                customTextureCaseCache.set(url, null);
                return null;
            };

            // 获取目录下所有文件的小写集合
            const listDirLowercase = async (dirUrl) => {
                if (customDirListingCache.has(dirUrl)) {
                    return customDirListingCache.get(dirUrl);
                }
                // 用 fetch 取 HTML 目录列表（仅在某些静态服务器上有效）
                // 如果不支持，退化为单文件探测
                const result = new Set();
                customDirListingCache.set(dirUrl, result);
                return result;
            };

            // 异步解析自定义模型贴图：尝试多种大小写变体
            const customTextureResolveCache = new Map(); // fileName -> Promise<url>
            const resolveCustomTexture = (fileName) => {
                if (customTextureResolveCache.has(fileName)) {
                    return customTextureResolveCache.get(fileName);
                }
                const promise = (async () => {
                    const lastSlash = modelPath.lastIndexOf('/');
                    const baseDir = lastSlash >= 0 ? modelPath.substring(0, lastSlash + 1) : '';
                    const baseUrl = baseDir + fileName;
                    const lowerFile = fileName.toLowerCase();

                    // 1. 尝试精确文件名
                    let found = await probeUrl(baseUrl);
                    if (found) return found;

                    // 2. 尝试小写文件名
                    const lowerUrl = baseDir + lowerFile;
                    found = await probeUrl(lowerUrl);
                    if (found) return found;

                    // 3. 尝试首字母大写
                    const capFile = lowerFile.charAt(0).toUpperCase() + lowerFile.slice(1);
                    const capUrl = baseDir + capFile;
                    found = await probeUrl(capUrl);
                    if (found) return found;

                    // 4. 都找不到，返回原始小写（让浏览器报告 404 以便调试）
                    return lowerUrl;
                })();
                customTextureResolveCache.set(fileName, promise);
                return promise;
            };

            const pathSolver = (path) => {
                if (path === modelPath) {
                    return path;
                }
                const normalizedPath = path.replace(/\\/g, '/');

                // 1. 先查找用户上传的资源
                if (this.uploadedAssets.has(normalizedPath)) {
                    return this.uploadedAssets.get(normalizedPath);
                }
                const lowerPath = normalizedPath.toLowerCase();
                if (this.uploadedAssets.has(lowerPath)) {
                    return this.uploadedAssets.get(lowerPath);
                }
                const fileName = normalizedPath.split('/').pop();
                if (this.uploadedAssets.has(fileName)) {
                    return this.uploadedAssets.get(fileName);
                }
                if (this.uploadedAssets.has(fileName.toLowerCase())) {
                    return this.uploadedAssets.get(fileName.toLowerCase());
                }

                // 2. War3 标准模型：带目录的路径映射到 War3Assets
                if (isWar3Model && normalizedPath.includes('/')) {
                    return this.war3AssetsPath + this.fixCommonCaseIssues(normalizedPath);
                }

                // 3. 自定义模型：带目录前缀的路径（如 Textures/xxx.blp）优先在 War3Assets 中查找
                if (!isWar3Model && normalizedPath.includes('/')) {
                    return this.war3AssetsPath + this.fixCommonCaseIssues(normalizedPath);
                }

                // 4. 自定义模型或简单文件名：相对于模型目录解析
                const lastSlash = modelPath.lastIndexOf('/');
                const baseDir = lastSlash >= 0 ? modelPath.substring(0, lastSlash + 1) : '';

                if (isWar3Model) {
                    // War3 模型的简单文件名也映射到 War3Assets
                    return this.war3AssetsPath + this.fixCommonCaseIssues(normalizedPath);
                }

                // 5. 自定义模型：返回 Promise，探测文件实际大小写
                return resolveCustomTexture(fileName);
            };

            console.log('[ModelLoader] 调用 viewer.load, pathSolver 已就绪');
            const model = await this.viewer.load(modelPath, pathSolver);

            // 令牌检查：如果用户已经切换到别的模型，直接丢弃
            if (myToken !== this._loadToken) {
                console.log('[ModelLoader] 令牌已过期，丢弃已加载模型:', modelPath);
                return;
            }
            console.log('[ModelLoader] viewer.load 返回:', model ? '成功' : 'null/undefined');

            if (!model) {
                throw new Error('无法加载模型 (viewer.load 返回空值，可能是 WebGL 扩展不支持或文件获取失败)');
            }

            this.currentModel = model;

            // 解析模型文件以获取面数据
            await this.parseModelData(modelPath);

            // 再次检查令牌
            if (myToken !== this._loadToken) {
                console.log('[ModelLoader] 令牌已过期 (parseModelData 后)，丢弃模型:', modelPath);
                return;
            }

            const instance = model.addInstance();
            instance.setScene(this.scene);
            const teamColorSelect = document.getElementById('team-color-select');
            const teamColor = teamColorSelect ? parseInt(teamColorSelect.value) : 0;
            if (teamColor === -1 || teamColor === 24) {
                const hasNeutral = this.ensureNeutralTeamColor();
                instance.setTeamColor(hasNeutral ? 24 : 0);
            } else {
                instance.setTeamColor(teamColor);
            }
            instance.setSequenceLoopMode(2);
            // 旋转模型使其面向屏幕
            // 四元数：+X→+Z（朝向相机），+Z→+Y（保持直立）
            instance.setRotation([-0.5, -0.5, -0.5, 0.5]);

            // 设置初始播放速度
            const speed = parseFloat(document.getElementById('speed-slider').value);
            instance.timeScale = speed;

            this.currentInstance = instance;

            // 为所有geoset打补丁以支持线框和隐藏
            this.patchGeosetRenders();

            this.updateAnimationList(model);

            const displayName = this.getTranslation(modelName);
            document.getElementById('model-info').textContent =
                displayName + ' | ' + model.sequences.length + ' 个动作';
            this._currentModelPath = modelPath;

            if (model.sequences.length > 0) {
                this.selectAnimation(this.findDefaultAnimation(model));
            }

        } catch (error) {
            if (myToken !== this._loadToken) {
                console.log('[ModelLoader] 加载出错但令牌已过期，忽略错误:', modelPath);
                return;
            }
            console.error('加载模型失败:', error);
            const errMsg = error && error.message ? error.message : String(error);
            document.getElementById('model-info').textContent = '加载失败: ' + errMsg;
            this.showLoading(false);
            this.showError('无法加载模型', modelPath, errMsg);
            return;
        }

        this.showLoading(false);
    }

    // ===== MMD 模型支持 =====
    isMmdFile(source) {
        if (typeof source !== 'string') return false;
        return /\.(pmd|pmx)$/i.test(source);
    }

    isMmdMotionFile(name) {
        return /\.vmd$/i.test(name);
    }

    rgbToHex(rgb) {
        return '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    }

    ensureMmdRenderer() {
        if (this.mmdRenderer) return this.mmdRenderer;
        const canvas = document.getElementById('mmd-canvas');
        this.mmdRenderer = new MmdRenderer(canvas);
        const rect = canvas.parentElement.getBoundingClientRect();
        this.mmdRenderer.setSize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
        const theme = document.body.getAttribute('data-theme');
        const color = this.customBgColor || this.rgbToHex(this.themeColors[theme] || this.themeColors.dark);
        this.mmdRenderer.setBackground(color);
        console.log('[MMD] three.js 渲染通道已创建');
        return this.mmdRenderer;
    }

    setMmdMode(on) {
        const changed = this.mmdMode !== on;
        this.mmdMode = on;
        document.body.classList.toggle('mmd-mode', on);

        const canvas = document.getElementById('canvas');
        const mmdCanvas = document.getElementById('mmd-canvas');
        if (canvas) canvas.style.display = on ? 'none' : '';
        if (mmdCanvas) mmdCanvas.style.display = on ? 'block' : 'none';

        if (this.mmdRenderer) {
            if (on) {
                this.mmdRenderer.show();
            } else {
                this.mmdRenderer.hide();
            }
        }

        if (!on && changed) {
            // 回到 MDX 模式时清空 MMD 动作列表，避免残留
            this.mmdMotions = [];
            this.mmdCurrentMotion = -1;
        }
    }

    async loadMmdModel(modelPath, modelName) {
        const myToken = ++this._loadToken;
        this.showLoading(true);
        document.getElementById('model-info').textContent = '正在加载: ' + modelName;
        console.log('[MMD] 开始加载 MMD 模型:', modelPath, 'token=' + myToken);

        // 移除当前 MDX 实例
        if (this.currentInstance) {
            this.scene.removeInstance(this.currentInstance);
            this.currentInstance = null;
            this.currentModel = null;
        }

        // 重置 MDX 侧状态
        this.wireframeBuffers = null;
        this.modelParser = null;
        const wire = document.getElementById('wireframe-checkbox');
        if (wire) wire.checked = false;

        this.modelSource = modelPath;

        try {
            const renderer = this.ensureMmdRenderer();
            if (myToken !== this._loadToken) return;
            renderer.show();
            this.setMmdMode(true);
            // 加载完成前暂停渲染，避免与模型解析/动作加载抢占主线程
            renderer.ready = false;

            // 先把当前显示的 MMD 模型移入缓存（不释放资源），便于快速切回
            if (this.mmdRenderer.model) {
                const currentModel = renderer.detachModel();
                if (currentModel && this._currentModelPath) {
                    this.mmdModelCache.set(this._currentModelPath, {
                        model: currentModel,
                        fit: this.mmdFit,
                        motions: this.mmdMotions,
                    });
                    this.trimMmdModelCache();
                }
            }

            // 缓存命中：直接挂载已解析的模型，不再下载/解析/扫描
            const cached = this.mmdModelCache.get(modelPath);
            if (cached) {
                console.log('[MMD] 命中模型缓存:', modelPath);
                this.mmdModelCache.delete(modelPath);
                const fit = renderer.attachModel(cached.model, cached.fit);
                this.mmdFit = fit;
                this.cameraDistance = fit.distance;
                this.cameraAngleX = 0;
                this.cameraAngleY = 0.3;
                this.cameraTarget = [...fit.target];
                this.mmdMotions = cached.motions || [];
                this.mmdCurrentMotion = -1;
                this._currentModelPath = modelPath;
                const displayName = this.getTranslation(modelName);
                document.getElementById('model-info').textContent = displayName + ' | MMD 模型';
                // 渲染就绪后再应用相机，避免首帧黑屏
                renderer.ready = true;
                this.applyCameraState();
                this.updateMmdAnimationList();
                this.showLoading(false);
                return;
            }

            this.mmdMotions = [];
            this.mmdCurrentMotion = -1;

            const loaded = await renderer.loadModel(modelPath);
            if (myToken !== this._loadToken || !loaded) return;

            // 应用自动取景（模型包围盒）
            if (renderer.fit) {
                this.mmdFit = renderer.fit;
                this.cameraDistance = renderer.fit.distance;
                this.cameraAngleX = 0;
                this.cameraAngleY = 0.3;
                this.cameraTarget = [...renderer.fit.target];
            }

            const displayName = this.getTranslation(modelName);
            document.getElementById('model-info').textContent = displayName + ' | MMD 模型';

            // 加载内置动作（失败不阻塞模型显示）
            await this.loadBuiltinMmdMotions(myToken);
            // 渲染就绪后再应用相机，避免首帧黑屏
            renderer.ready = true;
            this.applyCameraState();
            this._currentModelPath = modelPath;
            this.updateMmdAnimationList();
            this.showLoading(false);
        } catch (error) {
            if (myToken !== this._loadToken) return;
            if (this.mmdRenderer) this.mmdRenderer.ready = true;
            console.error('加载 MMD 模型失败:', error);
            const errMsg = error && error.message ? error.message : String(error);
            document.getElementById('model-info').textContent = '加载失败: ' + errMsg;
            this.showLoading(false);
            this.showError('无法加载 MMD 模型', modelPath, errMsg);
        }
    }

    /**
     * 加载 ModelMMD/Motions/ 下的内置 VMD 动作并加入播放列表。
     * 保留顺序；单个失败仅告警跳过。
     */
    async loadBuiltinMmdMotions(token) {
        if (!this.mmdRenderer) return;
        if (token !== undefined && token !== this._loadToken) return;
        // 列表第一项：恢复到无 VMD 的默认人形姿势
        this.mmdMotions.push({
            name: '默认姿势（无动作）',
            duration: 0,
            defaultPose: true,
        });
        for (const item of MMD_BUILTIN_MOTIONS) {
            try {
                if (token !== this._loadToken) return;
                const url = MMD_MOTIONS_BASE + item.file;
                const animation = await this.mmdRenderer.loadMotion(url + '?v=' + MMD_MOTIONS_VERSION);
                if (token !== this._loadToken) return;
                this.mmdMotions.push({
                    name: item.name,
                    animation,
                    duration: this.mmdRenderer.computeMotionDuration(animation),
                    builtin: true,
                });
                console.log('[MMD] 内置动作已加载:', item.name, '(' + item.file + ')');
            } catch (e) {
                console.warn('[MMD] 内置动作加载失败:', item.file, e);
            }
        }
    }

    /**
     * 限制 MMD 模型缓存数量，超出时释放最旧的模型（节省 GPU 内存）。
     */
    trimMmdModelCache() {
        while (this.mmdModelCache.size > 2) {
            const oldestKey = this.mmdModelCache.keys().next().value;
            const entry = this.mmdModelCache.get(oldestKey);
            this.mmdModelCache.delete(oldestKey);
            if (entry && entry.model && this.mmdRenderer) {
                this.mmdRenderer.disposeModelRef(entry.model);
            }
        }
    }

    updateMmdAnimationList() {
        const renderList = (el) => {
            if (!el) return;
            el.innerHTML = '';
            if (this.mmdMotions.length === 0) {
                el.innerHTML = '<div class="animation-empty">暂无动作<br>可上传自己的 VMD 动作</div>';
                return;
            }
            this.mmdMotions.forEach((motion, index) => {
                const item = document.createElement('div');
                item.className = 'animation-item';
                item.dataset.index = index;
                if (index === this.mmdCurrentMotion) item.classList.add('active');
                const name = document.createElement('span');
                name.className = 'animation-item-name';
                name.textContent = motion.name;
                item.appendChild(name);
                if (motion.builtin || motion.defaultPose) {
                    const badge = document.createElement('span');
                    badge.className = 'animation-item-badge';
                    badge.textContent = motion.defaultPose ? '默认' : '内置';
                    item.appendChild(badge);
                }
                const duration = document.createElement('span');
                duration.className = 'animation-item-duration';
                duration.textContent = motion.defaultPose ? '—' : (motion.duration || 0).toFixed(1) + 's';
                item.appendChild(duration);
                item.addEventListener('click', () => this.selectAnimation(index));
                el.appendChild(item);
            });
        };
        renderList(document.getElementById('animation-list'));
        renderList(document.getElementById('animation-list-m'));

        const motion = this.mmdMotions[this.mmdCurrentMotion];
        const label = motion ? motion.name : '未选择';
        const dName = document.getElementById('animation-current-name');
        if (dName) dName.textContent = label;
        const mName = document.getElementById('animation-current-name-m');
        if (mName) mName.textContent = label;
    }

    playMmdMotion(index) {
        if (!this.mmdRenderer || !this.mmdRenderer.model) return;
        const motion = this.mmdMotions[index];
        if (!motion) return;

        // 默认姿势：清空动作，恢复无 VMD 的默认人形
        if (motion.defaultPose) {
            this.mmdRenderer.stop();
            this.mmdCurrentMotion = index;
            this.isPaused = false;
            this.updateMmdAnimationList();
            return;
        }

        this.mmdRenderer.playMotion(motion.animation, motion.name);
        this.mmdCurrentMotion = index;
        this.isPaused = false;

        const speed = parseFloat(document.getElementById('speed-slider').value);
        this.mmdRenderer.setSpeed(speed);
        this.mmdRenderer.setLoop(document.getElementById('loop-checkbox').checked);

        document.querySelectorAll('.animation-item').forEach(item => {
            item.classList.toggle('active', parseInt(item.dataset.index) === index);
        });
        const dName = document.getElementById('animation-current-name');
        if (dName) dName.textContent = motion.name;
        const mName = document.getElementById('animation-current-name-m');
        if (mName) mName.textContent = motion.name;
    }

    async loadMmdMotionFiles(files) {
        const list = Array.from(files || []).filter(f => this.isMmdMotionFile(f.name));
        if (list.length === 0) {
            alert('请选择 .vmd 动作文件');
            return;
        }
        if (!this.mmdMode || !this.mmdRenderer) {
            alert('请先加载一个 MMD 模型');
            return;
        }
        this.showLoading(true);
        try {
            for (const file of list) {
                const animation = await this.mmdRenderer.loadMotion(file);
                this.mmdMotions.push({
                    name: file.name,
                    animation,
                    duration: this.mmdRenderer.computeMotionDuration(animation),
                });
            }
            this.updateMmdAnimationList();
            this.playMmdMotion(this.mmdMotions.length - 1);
        } catch (e) {
            console.error('加载 VMD 动作失败:', e);
            alert('加载 VMD 动作失败: ' + (e && e.message ? e.message : e));
        } finally {
            this.showLoading(false);
        }
    }

    findDefaultAnimation(model) {
        const priority = [
            'stand', 'Stand', 'STAND',
            'walk', 'Walk', 'WALK',
            'idle', 'Idle', 'IDLE',
            'birth', 'Birth', 'BIRTH',
            'attack', 'Attack', 'ATTACK',
            'spell', 'Spell', 'SPELL',
        ];
        for (const name of priority) {
            const idx = model.sequences.findIndex(s =>
                s.name.toLowerCase() === name.toLowerCase() ||
                s.name.toLowerCase().startsWith(name.toLowerCase())
            );
            if (idx >= 0) return idx;
        }
        return 0;
    }

    async parseModelData(source) {
        try {
            let buffer;
            if (source instanceof ArrayBuffer) {
                buffer = source;
            } else if (source instanceof File) {
                buffer = await source.arrayBuffer();
            } else {
                const response = await fetch(source);
                buffer = await response.arrayBuffer();
            }

            const parser = new MdlxModel();
            parser.load(buffer);

            this.modelParser = parser;
        } catch (e) {
            console.warn('解析模型数据失败:', e);
            this.modelParser = null;
        }
    }

    // ===== 动作列表 =====
    updateAnimationList(model) {
        // 桌面端列表
        const list = document.getElementById('animation-list');
        if (list) {
            list.innerHTML = '';
            if (model.sequences.length === 0) {
                list.innerHTML = '<div class="animation-empty">无可用动作</div>';
            } else {
                model.sequences.forEach((seq, index) => {
                    list.appendChild(this.createAnimationItem(seq, index));
                });
            }
        }

        // 移动端列表
        const mList = document.getElementById('animation-list-m');
        if (mList) {
            mList.innerHTML = '';
            if (model.sequences.length === 0) {
                mList.innerHTML = '<div class="animation-empty">无可用动作</div>';
            } else {
                model.sequences.forEach((seq, index) => {
                    mList.appendChild(this.createAnimationItem(seq, index));
                });
            }
            // 重置移动端下拉
            mList.classList.remove('dropdown-open');
            const mTrigger = document.getElementById('animation-dropdown-trigger-m');
            if (mTrigger) {
                mTrigger.classList.remove('open');
                mTrigger.setAttribute('aria-expanded', 'false');
            }
            const mName = document.getElementById('animation-current-name-m');
            if (mName) mName.textContent = '未选择';
        }

        // 重置桌面端下拉（如果有）
        const currentNameEl = document.getElementById('animation-current-name');
        const trigger = document.getElementById('animation-dropdown-trigger');
        if (currentNameEl) currentNameEl.textContent = '未选择';
        if (trigger) {
            trigger.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
        }
        if (list) list.classList.remove('dropdown-open');
    }

    createAnimationItem(seq, index) {
        const item = document.createElement('div');
        item.className = 'animation-item';
        item.dataset.index = index;

        const name = document.createElement('span');
        name.className = 'animation-item-name';
        name.textContent = seq.name || ('动作 ' + (index + 1));

        const duration = document.createElement('span');
        duration.className = 'animation-item-duration';
        const durationSec = (seq.interval[1] - seq.interval[0]) / 1000;
        duration.textContent = durationSec.toFixed(2) + '秒';

        item.appendChild(name);
        item.appendChild(duration);
        return item;
    }

    // ===== 模型树 =====
    async loadModelTree() {
        const treeEl = document.getElementById('model-tree');
        if (!treeEl) return;

        try {
            const [indexResp, transResp] = await Promise.all([
                fetch('./models-index.json'),
                fetch('./model-translations.json').catch(() => ({ ok: false }))
            ]);
            if (!indexResp.ok) {
                throw new Error('索引文件加载失败: ' + indexResp.status);
            }
            const data = await indexResp.json();
            this.modelIndex = data;

            if (transResp.ok) {
                this.translations = await transResp.json();
            } else {
                this.translations = {};
            }

            this.renderModelTree(data.tree);
        } catch (err) {
            console.error('加载模型树失败:', err);
            treeEl.innerHTML = '<div class="tree-empty">模型索引加载失败<br>请运行 npm run gen-index</div>';
        }
    }

    getTranslation(name) {
        if (!this.translations) return name;
        const cn = this.translations[name];
        if (cn && cn !== name) {
            return cn + ' (' + name + ')';
        }
        return name;
    }

    renderModelTree(tree) {
        const treeEl = document.getElementById('model-tree');
        if (!treeEl) return;
        treeEl.innerHTML = '';

        const totalCount = this.modelIndex ? this.modelIndex.totalModels : 0;
        const countEl = document.createElement('div');
        countEl.className = 'tree-count';
        countEl.textContent = '共 ' + totalCount + ' 个模型';
        treeEl.appendChild(countEl);

        tree.forEach(category => {
            const categoryEl = document.createElement('div');
            categoryEl.className = 'tree-category';

            const header = document.createElement('div');
            header.className = 'tree-category-header';
            header.innerHTML = '<span class="tree-icon">' + (category.icon || '📁') + '</span>' +
                '<span class="tree-category-name">' + category.name + '</span>' +
                '<span class="tree-toggle">▶</span>';
            header.addEventListener('click', () => {
                categoryEl.classList.toggle('expanded');
            });
            categoryEl.appendChild(header);

            const content = document.createElement('div');
            content.className = 'tree-category-content';

            // 直接属于该分类的模型
            if (category.models && category.models.length > 0) {
                category.models.forEach(model => {
                    content.appendChild(this.createModelItemEl(model));
                });
            }

            // 子分类
            if (category.subCategories) {
                for (const key in category.subCategories) {
                    const sub = category.subCategories[key];
                    content.appendChild(this.createSubCategoryEl(sub));
                }
            }

            categoryEl.appendChild(content);
            treeEl.appendChild(categoryEl);
        });
    }

    createSubCategoryEl(subCategory) {
        const subEl = document.createElement('div');
        subEl.className = 'tree-subcategory';

        const header = document.createElement('div');
        header.className = 'tree-subcategory-header';
        header.innerHTML = '<span class="tree-subcategory-name">' + subCategory.name + '</span>' +
            '<span class="tree-toggle">▶</span>';
        header.addEventListener('click', () => {
            subEl.classList.toggle('expanded');
        });
        subEl.appendChild(header);

        const content = document.createElement('div');
        content.className = 'tree-subcategory-content';

        // 直接属于该子分类的模型
        if (subCategory.models && subCategory.models.length > 0) {
            subCategory.models.forEach(model => {
                content.appendChild(this.createModelItemEl(model));
            });
        }

        // 嵌套分组
        if (subCategory.groups) {
            for (const groupName in subCategory.groups) {
                const group = subCategory.groups[groupName];
                if (group.length === 1) {
                    content.appendChild(this.createModelItemEl(group[0]));
                } else {
                    const groupEl = document.createElement('div');
                    groupEl.className = 'tree-group';

                    const groupHeader = document.createElement('div');
                    groupHeader.className = 'tree-group-header';
                    groupHeader.innerHTML = '<span class="tree-group-name">' + groupName + '</span>' +
                        '<span class="tree-group-count">' + group.length + '</span>' +
                        '<span class="tree-toggle">▶</span>';
                    groupHeader.addEventListener('click', () => {
                        groupEl.classList.toggle('expanded');
                    });
                    groupEl.appendChild(groupHeader);

                    const groupContent = document.createElement('div');
                    groupContent.className = 'tree-group-content';
                    group.forEach(model => {
                        groupContent.appendChild(this.createModelItemEl(model));
                    });
                    groupEl.appendChild(groupContent);

                    content.appendChild(groupEl);
                }
            }
        }

        subEl.appendChild(content);
        return subEl;
    }

    createModelItemEl(model) {
        const item = document.createElement('div');
        item.className = 'tree-model-item';
        item.dataset.path = model.path;
        item.dataset.name = model.name.toLowerCase();
        // 同时存储中文译名用于搜索
        const cnName = (this.translations && this.translations[model.name]) || '';
        item.dataset.cnName = cnName.toLowerCase();
        const displayName = this.getTranslation(model.name);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tree-model-name';
        if (displayName !== model.name) {
            nameSpan.innerHTML = '<span class="tree-model-cn">' + displayName.split(' (')[0] + '</span>' +
                '<span class="tree-model-en">' + displayName.substring(displayName.indexOf('(')) + '</span>';
        } else {
            nameSpan.textContent = displayName;
        }
        item.appendChild(nameSpan);
        item.title = model.path;
        item.addEventListener('click', () => {
            document.querySelectorAll('.tree-model-item.active').forEach(el => {
                el.classList.remove('active');
            });
            item.classList.add('active');
            this.loadModel(model.path, model.name);
        });
        return item;
    }

    filterModelTree(query) {
        const q = query.trim().toLowerCase();
        const treeEl = document.getElementById('model-tree');
        if (!treeEl) return;

        if (!q) {
            // 清空搜索：恢复初始状态，折叠所有分类
            treeEl.querySelectorAll('.tree-category').forEach(el => {
                el.classList.remove('expanded', 'search-match');
            });
            treeEl.querySelectorAll('.tree-subcategory, .tree-group').forEach(el => {
                el.classList.remove('expanded', 'search-match');
            });
            treeEl.querySelectorAll('.tree-model-item').forEach(el => {
                el.style.display = '';
            });
            return;
        }

        // 展开+过滤（同时匹配英文名和中文名）
        treeEl.querySelectorAll('.tree-model-item').forEach(el => {
            const enName = el.dataset.name || '';
            const cnName = el.dataset.cnName || '';
            const match = enName.includes(q) || cnName.includes(q);
            el.style.display = match ? '' : 'none';
        });

        // 展开包含匹配项的分组
        treeEl.querySelectorAll('.tree-group').forEach(el => {
            const hasMatch = el.querySelectorAll('.tree-model-item').length > 0 &&
                Array.from(el.querySelectorAll('.tree-model-item')).some(m => m.style.display !== 'none');
            if (hasMatch) {
                el.classList.add('expanded');
            } else {
                el.classList.remove('expanded');
            }
        });

        treeEl.querySelectorAll('.tree-subcategory').forEach(el => {
            const hasMatch = Array.from(el.querySelectorAll('.tree-model-item')).some(m => m.style.display !== 'none');
            if (hasMatch) {
                el.classList.add('expanded');
            } else {
                el.classList.remove('expanded');
            }
        });

        treeEl.querySelectorAll('.tree-category').forEach(el => {
            const hasMatch = Array.from(el.querySelectorAll('.tree-model-item')).some(m => m.style.display !== 'none');
            if (hasMatch) {
                el.classList.add('expanded');
            } else {
                el.classList.remove('expanded');
            }
        });
    }

    // ===== 文件上传 =====
    handleFileUpload(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        const mdxFile = Array.from(files).find(f => f.name.toLowerCase().endsWith('.mdx'));
        if (!mdxFile) {
            alert('请选择 .mdx 模型文件');
            return;
        }

        // 递增加载令牌
        const myToken = ++this._loadToken;

        this.showLoading(true);
        document.getElementById('model-info').textContent = '正在加载: ' + mdxFile.name;

        // 立即移除当前实例
        if (this.currentInstance) {
            this.scene.removeInstance(this.currentInstance);
            this.currentInstance = null;
            this.currentModel = null;
        }

        // 重置状态
        this.wireframeBuffers = null;
        this.modelParser = null;
        document.getElementById('wireframe-checkbox').checked = false;

        const blobUrls = new Map();
        for (const file of files) {
            const url = URL.createObjectURL(file);
            const name = file.webkitRelativePath || file.name;
            const normalizedName = name.replace(/\\/g, '/');
            blobUrls.set(normalizedName, url);
            blobUrls.set(normalizedName.toLowerCase(), url);
            blobUrls.set(file.name, url);
            blobUrls.set(file.name.toLowerCase(), url);
        }

        const pathSolver = (path) => {
            const normalizedPath = path.replace(/\\/g, '/');

            // 1. 先查找用户上传的文件（按完整路径）
            if (blobUrls.has(normalizedPath)) {
                return blobUrls.get(normalizedPath);
            }
            if (blobUrls.has(normalizedPath.toLowerCase())) {
                return blobUrls.get(normalizedPath.toLowerCase());
            }

            // 2. 按文件名查找
            const fileName = normalizedPath.split('/').pop();
            if (blobUrls.has(fileName)) {
                return blobUrls.get(fileName);
            }
            if (blobUrls.has(fileName.toLowerCase())) {
                return blobUrls.get(fileName.toLowerCase());
            }

            // 3. 全局上传的资源
            if (this.uploadedAssets.has(normalizedPath)) {
                return this.uploadedAssets.get(normalizedPath);
            }
            if (this.uploadedAssets.has(normalizedPath.toLowerCase())) {
                return this.uploadedAssets.get(normalizedPath.toLowerCase());
            }

            // 4. War3标准路径 -> War3Assets目录
            if (normalizedPath.includes('/')) {
                return this.war3AssetsPath + normalizedPath;
            }

            return path;
        };

        this.modelSource = mdxFile;

        this.viewer.load(blobUrls.get(mdxFile.name), pathSolver).then(async (model) => {
            if (myToken !== this._loadToken) return;
            if (!model) {
                throw new Error('无法加载模型文件');
            }

            this.currentModel = model;

            // 解析模型数据
            await this.parseModelData(mdxFile);
            if (myToken !== this._loadToken) return;

            const instance = model.addInstance();
            instance.setScene(this.scene);
            const teamColorSelect = document.getElementById('team-color-select');
            const teamColor = teamColorSelect ? parseInt(teamColorSelect.value) : 0;
            if (teamColor === -1 || teamColor === 24) {
                const hasNeutral = this.ensureNeutralTeamColor();
                instance.setTeamColor(hasNeutral ? 24 : 0);
            } else {
                instance.setTeamColor(teamColor);
            }
            instance.setSequenceLoopMode(2);
            instance.setRotation([-0.5, -0.5, -0.5, 0.5]);

            const speed = parseFloat(document.getElementById('speed-slider').value);
            instance.timeScale = speed;

            this.currentInstance = instance;

            this.patchGeosetRenders();

            this.updateAnimationList(model);

            document.getElementById('model-info').textContent =
                mdxFile.name + ' | ' + model.sequences.length + ' 个动作';

            if (model.sequences.length > 0) {
                this.selectAnimation(this.findDefaultAnimation(model));
            }

            this.showLoading(false);
        }).catch((error) => {
            if (myToken !== this._loadToken) return;
            console.error('加载模型失败:', error);
            document.getElementById('model-info').textContent = '加载失败: ' + error.message;
            this.showLoading(false);
            this.showError('无法加载模型', mdxFile.name, error.message);
            this.showLoading(false);
        });
    }

    // ===== Geoset渲染补丁 =====
    patchGeosetRenders() {
        const model = this.currentModel;
        if (!model || model._geosetsPatched) return;
        model._geosetsPatched = true;

        for (const geoset of model.geosets) {
            const originalRender = geoset.render.bind(geoset);
            geoset._originalRender = originalRender;
            geoset.render = () => {
                // 检查是否有线框缓冲区
                if (geoset._wireframeBuffer) {
                    const gl = this.viewer.gl;
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geoset._wireframeBuffer);
                    gl.drawElements(gl.LINES, geoset._wireframeCount, gl.UNSIGNED_SHORT, 0);
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, model.elementBuffer);
                } else {
                    originalRender();
                }
            };
        }
    }

    // ===== 线框模式 =====
    async setupWireframeBuffers() {
        if (this.wireframeBuffers || !this.currentModel) return;

        if (!this.modelParser) {
            await this.parseModelData(this.modelSource);
        }

        if (!this.modelParser) return;

        const gl = this.viewer.gl;
        const model = this.currentModel;
        const parser = this.modelParser;

        this.wireframeBuffers = [];

        for (let i = 0; i < model.geosets.length && i < parser.geosets.length; i++) {
            const geoset = model.geosets[i];
            const parserGeoset = parser.geosets[i];

            const faces = parserGeoset.faces;
            if (faces.length === 0) continue;

            const triCount = Math.floor(faces.length / 3);
            const lineIndices = new Uint16Array(triCount * 6);

            for (let j = 0; j < triCount; j++) {
                const a = faces[j * 3];
                const b = faces[j * 3 + 1];
                const c = faces[j * 3 + 2];
                lineIndices[j * 6] = a;
                lineIndices[j * 6 + 1] = b;
                lineIndices[j * 6 + 2] = b;
                lineIndices[j * 6 + 3] = c;
                lineIndices[j * 6 + 4] = c;
                lineIndices[j * 6 + 5] = a;
            }

            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineIndices, gl.STATIC_DRAW);

            this.wireframeBuffers.push({ geoset, buffer, count: lineIndices.length });
        }

        // 重新绑定原始元素缓冲区
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, model.elementBuffer);
    }

    async setWireframe(enabled) {
        if (!this.currentModel) return;

        if (enabled) {
            await this.setupWireframeBuffers();

            if (!this.wireframeBuffers) return;

            for (const { geoset, buffer, count } of this.wireframeBuffers) {
                geoset._wireframeBuffer = buffer;
                geoset._wireframeCount = count;
            }
        } else {
            for (const geoset of this.currentModel.geosets) {
                geoset._wireframeBuffer = null;
                geoset._wireframeCount = 0;
            }
        }
    }

    // ===== 画布大小 =====
    resizeCanvas() {
        const canvas = document.getElementById('canvas');
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
    }

    onResize() {
        const canvas = document.getElementById('canvas');
        this.resizeCanvas();

        if (this.mmdRenderer) {
            const rect = canvas.parentElement.getBoundingClientRect();
            this.mmdRenderer.setSize(
                Math.max(1, Math.floor(rect.width)),
                Math.max(1, Math.floor(rect.height))
            );
        }

        if (this.scene) {
            this.scene.camera.perspective(
                Math.PI / 4,
                canvas.width / canvas.height,
                1,
                10000
            );
            this.scene.viewport = [0, 0, canvas.width, canvas.height];
        }
    }

    // ===== 主循环 =====
    animate() {
        requestAnimationFrame(() => this.animate());

        const now = performance.now();
        const dt = now - this.lastFrameTime;
        this.lastFrameTime = now;

        // MMD 渲染通道
        if (this.mmdMode && this.mmdRenderer && this.mmdRenderer.ready) {
            if (this.autoRotate && !this.mmdRenderer.paused) {
                this.cameraAngleX += this.rotationSpeed;
                this.applyCameraState();
            }
            this.mmdRenderer.update(dt);
            this.mmdRenderer.render();
            return;
        }

        if (this.autoRotate && !this.isPaused) {
            this.cameraAngleX += this.rotationSpeed;
            const camera = this.scene.camera;
            const tx = this.cameraTarget ? this.cameraTarget[0] : 0;
            const ty = this.cameraTarget ? this.cameraTarget[1] : 0;
            const tz = this.cameraTarget ? this.cameraTarget[2] : 0;
            const x = Math.sin(this.cameraAngleX) * Math.cos(this.cameraAngleY) * this.cameraDistance;
            const y = Math.sin(this.cameraAngleY) * this.cameraDistance;
            const z = Math.cos(this.cameraAngleX) * Math.cos(this.cameraAngleY) * this.cameraDistance;
            camera.setLocation([tx + x, ty + y, tz + z]);
            camera.face([tx, ty, tz], [0, 1, 0]);
            this.updateOrientationIndicator();
        }

        // 传入实际帧时间，确保动画速度正确（不随刷新率变化）
        this.viewer.updateAndRender(dt);

        // 首帧渲染后检查 GL 错误（仅检查一次）
        if (!this._glErrorChecked && this.currentInstance) {
            this._glErrorChecked = true;
            const gl = this.viewer.gl;
            const err = gl.getError();
            if (err !== gl.NO_ERROR) {
                console.error('[Render] 首帧后检测到 GL 错误: 0x' + err.toString(16));
            } else {
                console.log('[Render] 首帧渲染 GL 状态正常');
            }
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new War3ModelViewerApp();
});
