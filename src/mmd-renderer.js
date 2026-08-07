import * as THREE from 'three';
import {
    ThreeMmdLoader,
    initCoreWithFallback,
    FallbackCore,
    disposeMmdModel,
} from '@yohawing/three-mmd-loader';
// Webpack 以 asset 方式打包 WASM，加载器用它做 PMX/PMD 快速解析；
// 若 WASM 不可用，initCoreWithFallback 会自动回退到纯 TS 解析器。
import mmdWasmUrl from '@yohawing/three-mmd-loader/dist/parser/wasm/generated/mmd_anim_wasm_bg.wasm';

const MMD_FRAME_RATE = 30;

/**
 * WASM 核心初始化加超时保护：移动/弱网下若 wasm 文件 fetch 卡住，
 * 超时后自动回退到纯 TS 解析器，避免加载永远卡在“加载中”。
 */
function initMmdCoreWithTimeout(wasmUrl, timeoutMs = 8000) {
    return Promise.race([
        initCoreWithFallback({ wasmUrl }),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]).then((core) => core || new FallbackCore());
}

/**
 * MMD 渲染通道：基于 three.js + @yohawing/three-mmd-loader。
 * 负责 PMD/PMX 模型、VMD 动作的加载与播放，以及独立的 WebGL 场景。
 * 相机轨道参数（距离/角度/目标点）由外层 main.js 统一管理，这里只负责应用。
 */
export default class MmdRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            alpha: false,
            antialias: true,
            powerPreference: 'default',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
        this.camera.up.set(0, 1, 0);

        // MMD 卡通渲染需要方向光 + 环境光
        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        this.directionalLight.position.set(0.8, 1.4, 0.6);
        this.fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        this.fillLight.position.set(-0.6, 0.4, -0.8);
        this.scene.add(this.ambientLight, this.directionalLight, this.fillLight);

        // 使用回退安全的解析核心（WASM 优先，失败自动降级为 TS 解析）
        this.loader = new ThreeMmdLoader({
            core: initMmdCoreWithTimeout(mmdWasmUrl),
            // 启用内置弹簧物理：头发/裙子等带刚体的部位会随动作摆动，不再穿模
            runtime: { physics: 'stateful-spring' },
        });

        this.model = null;        // ThreeMmdModel
        this.motion = null;       // ThreeMmdAnimation（当前绑定动作）
        this.motionName = '';
        this.motionDuration = 0;  // 秒
        this.time = 0;            // 当前播放时间（秒）
        this.paused = true;
        this.loop = true;
        this.speed = 1;
        this.ready = false;
        this.fit = null;          // 自动取景结果 { distance, target }
        this._loadToken = 0;      // 渲染器级加载令牌：防止并发加载旧模型残留

        // 首次 show 时按需设置尺寸
        this._sized = false;
    }

    setSize(width, height) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.setSize(Math.floor(width * dpr), Math.floor(height * dpr), false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this._sized = true;
    }

    setBackground(hex) {
        const rgb = this.hexToRgb(hex);
        this.renderer.setClearColor(new THREE.Color(rgb.r / 255, rgb.g / 255, rgb.b / 255), 1);
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
        } : { r: 26, g: 26, b: 46 };
    }

    show() {
        this.canvas.style.display = 'block';
        this.ready = true;
    }

    hide() {
        this.canvas.style.display = 'none';
        this.ready = false;
    }

    /**
     * 加载 PMD/PMX 模型。source 可为 URL、File、ArrayBuffer 或 Uint8Array。
     */
    async loadModel(source) {
        const myLoadToken = ++this._loadToken;
        this.disposeModel();
        this.motion = null;
        this.motionName = '';
        this.motionDuration = 0;
        this.time = 0;
        this.paused = true;

        const model = await this.loader.loadModel(source, {
            // 关闭轮廓与渲染顺序代理网格，避免加载器自定义着色器钩子引发贴图异常
            outline: false,
            materialRenderOrder: false,
        });
        if (myLoadToken !== this._loadToken) {
            // 期间用户切换了其他模型：丢弃本次结果，避免旧模型叠加在场景里
            try {
                disposeMmdModel(model);
            } catch (e) {
                console.warn('[MMD] 释放过期加载的模型失败:', e);
            }
            return null;
        }
        this.simplifyMaterials(model);
        this.model = model;
        this.scene.add(model.root);
        this.fit = this.frameModel();
        return model;
    }

    /**
     * 挂载一个已加载好的模型（来自缓存），不重复加载。
     * 调用前应确保当前场景没有已挂载模型（main.js 会先 detachModel）。
     */
    attachModel(model, fit) {
        // 使任何仍在进行的 loadModel 失效（防止旧模型加载完成后叠加进场景）
        this._loadToken++;
        if (this.model && this.model !== model) {
            this.scene.remove(this.model.root);
        }
        this.model = model;
        this.scene.add(model.root);
        this.motion = null;
        this.motionName = '';
        this.motionDuration = 0;
        this.time = 0;
        this.paused = true;
        this.fit = fit || this.frameModel();
        return this.fit;
    }

    /**
     * 从场景移除当前模型但不释放资源，返回模型对象供外部缓存复用。
     */
    detachModel() {
        this._loadToken++;
        const model = this.model;
        if (model) {
            this.scene.remove(model.root);
        }
        this.model = null;
        this.motion = null;
        this.motionName = '';
        this.motionDuration = 0;
        this.time = 0;
        this.paused = true;
        return model;
    }

    /**
     * 用标准 MeshToonMaterial 替换加载器生成的自定义材质，
     * 保留漫反射贴图与 toon 渐变贴图，规避自定义 MMD 着色器在部分 GPU 上的渲染问题。
     */
    simplifyMaterials(model) {
        const materials = Array.isArray(model.mesh.material) ? model.mesh.material : [model.mesh.material];
        const plain = materials.map((orig) => {
            const m = new THREE.MeshToonMaterial({
                color: orig.color ? orig.color.clone() : new THREE.Color(1, 1, 1),
                opacity: orig.opacity,
                transparent: orig.transparent,
                alphaTest: orig.alphaTest,
                side: orig.side,
                depthWrite: orig.depthWrite,
                map: orig.map || null,
                gradientMap: orig.gradientMap || null,
                visible: orig.visible,
                name: orig.name || '',
            });
            m.morphTargets = !!orig.morphTargets;
            m.morphNormals = !!orig.morphNormals;
            // MMD 渲染始终尊重贴图 alpha：全透明纹素应被丢弃。
            // 否则"表情/脸线"这类叠加材质（在 other.png 上是透明黑条带）会以不透明黑色渲染出来。
            if (orig.map && !(m.alphaTest > 0)) {
                m.alphaTest = 0.5 / 255;
            }
            // 叠加类材质（表情/脸线等）在静止时应完全透明：
            // 它们采样贴图上的透明黑条带，半透明边缘若按不透明渲染会残留黑点。
            // 用 alpha 混合（而不是 alphaTest 丢弃）让这些条带完全不可见。
            if (orig.map && /表情|脸线|face.?line|expression|overlay/i.test(orig.name || '')) {
                m.transparent = true;
            }
            return m;
        });
        model.mesh.material = plain.length === 1 ? plain[0] : plain;
        return plain;
    }

    /**
     * 解析 VMD 动作（不立即播放，返回 ThreeMmdAnimation）。
     */
    async loadMotion(source) {
        return this.loader.loadAnimation(source);
    }

    /**
     * 绑定并开始播放一个动作。
     */
    playMotion(animation, name = '') {
        if (!this.model) return;
        this.motion = animation;
        this.motionName = name || animation.name || '';
        this.motionDuration = this.computeMotionDuration(animation);
        this.time = 0;
        this.paused = false;
        this.model.setAnimation(animation.animation);
        this.model.update(0);
    }

    stop() {
        this.paused = true;
        this.time = 0;
        this.motionName = '';
        if (this.model) {
            this.model.runtime.clearAnimation();
            // 恢复模型的默认人形姿势（重置骨骼到静止姿态）
            this.model.runtime.resetPose();
            // 重置物理状态，避免头发/裙子残留摆动
            this.model.runtime.resetPhysicsState();
            this.model.update(0);
        }
    }

    setPaused(paused) {
        this.paused = paused;
    }

    setSpeed(speed) {
        this.speed = speed;
    }

    setLoop(loop) {
        this.loop = loop;
    }

    /**
     * 每帧推进。dt 为毫秒。
     */
    update(dt) {
        if (!this.model || this.paused) return;
        this.time += (dt * 0.001) * this.speed;

        const duration = this.motionDuration;
        if (duration > 0) {
            if (this.loop) {
                this.time = this.time % duration;
            } else if (this.time >= duration) {
                this.time = duration;
                this.paused = true;
            }
        }
        this.model.update(this.time);
    }

    render() {
        if (this.model) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /**
     * 应用外层轨道相机参数（与 MDX 通道的相机公式一致）。
     */
    setCamera(position, target) {
        this.camera.position.set(position[0], position[1], position[2]);
        this.camera.lookAt(target[0], target[1], target[2]);
    }

    /**
     * 根据模型包围盒自动取景。
     */
    frameModel() {
        const box = new THREE.Box3().setFromObject(this.model.root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) * 0.5;
        const fov = (this.camera.fov * Math.PI) / 180;
        const safeRadius = Math.max(radius, 1);
        const distance = Math.max(
            safeRadius / Math.tan(fov / 2) * 1.4,
            safeRadius * 4,
            8
        );
        return {
            distance,
            target: [center.x, center.y, center.z],
        };
    }

    computeMotionDuration(animation) {
        const maxFrame = animation.animation.metadata.maxFrame;
        if (Number.isFinite(maxFrame) && maxFrame > 0) {
            return (maxFrame + 1) / MMD_FRAME_RATE;
        }
        // 兜底：从骨骼/表情轨道中取最大帧
        let max = 0;
        const tracks = animation.animation.boneTracks || {};
        for (const key in tracks) {
            const frames = tracks[key].frames;
            if (frames && frames.length > 0) {
                max = Math.max(max, frames[frames.length - 1]);
            }
        }
        const morphTracks = animation.animation.morphTracks || {};
        for (const key in morphTracks) {
            const frames = morphTracks[key].frames;
            if (frames && frames.length > 0) {
                max = Math.max(max, frames[frames.length - 1]);
            }
        }
        return max > 0 ? (max + 1) / MMD_FRAME_RATE : 0;
    }

    disposeModel() {
        if (this.model) {
            this.scene.remove(this.model.root);
            try {
                disposeMmdModel(this.model);
            } catch (e) {
                console.warn('[MMD] 释放模型资源失败:', e);
            }
            this.model = null;
        }
    }

    /**
     * 释放一个不在场景中的模型对象（缓存淘汰时使用）。
     */
    disposeModelRef(model) {
        if (!model) return;
        try {
            disposeMmdModel(model);
        } catch (e) {
            console.warn('[MMD] 释放缓存模型失败:', e);
        }
    }

    dispose() {
        this.disposeModel();
        this.renderer.dispose();
    }
}
