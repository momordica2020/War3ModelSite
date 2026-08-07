// 生成内置 MMD 基础动作（VMD 文件）到 ModelMMD/Motions/
// 本脚本目前只生成"待机-呼吸"这一个原创动作（标准 MMD 日文骨骼名）；
// 走路/挥手/行礼等已改用 MMDAgent-EX（Apache-2.0）的真实动作数据。
//
// 关键点：
// 1. 骨骼名以 Shift-JIS 写入；从项目的 greendam.pmd 中提取各骨骼名的原始字节，
//    保证与项目内 MMD 模型 100% 匹配。
// 2. 手臂姿势根据 PMD 骨骼真实位置计算：把平举的手臂旋转到自然下垂方向
//    （纯 Z 轴旋转，避免最短弧把手臂甩到身体内侧），并叠加小幅前后摆动；
//    肘部按骨骼链换算做轻微前弯。这样待机/走路/鞠躬等动作不再是"人字形"。
//
// 用法: node scripts/generate-builtin-vmds.js
const fs = require('fs');
const path = require('path');
const THREE = require('three');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'ModelMMD', 'Motions');
const MODEL_PMD = path.join(ROOT, 'ModelMMD', 'GreenDam久天版绿坝娘MMD模型', 'greendam.pmd');

// ---------- PMD 骨骼信息读取（名称字节 + 位置） ----------
function readPmdBones(file) {
    const b = fs.readFileSync(file);
    const vertexCount = b.readUInt32LE(283);
    const indexCount = b.readUInt32LE(287 + vertexCount * 38);
    const matCount = b.readUInt32LE(291 + vertexCount * 38 + indexCount * 2);
    let off = 295 + vertexCount * 38 + indexCount * 2 + matCount * 70;
    const boneCount = b.readUInt16LE(off);
    off += 2;
    const nameBytes = {};
    const positions = {};
    for (let i = 0; i < boneCount; i++) {
        const raw = b.subarray(off, off + 20);
        const end = raw.indexOf(0);
        const bytes = Buffer.from(raw.subarray(0, end < 0 ? 20 : end));
        const name = new TextDecoder('shift-jis').decode(bytes);
        const pos = [b.readFloatLE(off + 27), b.readFloatLE(off + 31), b.readFloatLE(off + 35)];
        if (name) {
            if (!nameBytes[name]) nameBytes[name] = bytes;
            positions[name] = pos;
        }
        off += 20 + 2 + 2 + 1 + 2 + 12;
    }
    return { nameBytes, positions };
}

// ---------- 向量/四元数工具（three.js 空间） ----------
const DEG = Math.PI / 180;
const V3 = (arr) => new THREE.Vector3(arr[0], arr[1], -arr[2]); // PMD 的 Z 需取反
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

function rotZ(deg) {
    return new THREE.Quaternion().setFromAxisAngle(Z_AXIS, deg * DEG);
}

function rotX(deg) {
    return new THREE.Quaternion().setFromAxisAngle(X_AXIS, deg * DEG);
}

function toMmd(q) {
    // 运行时: bone.quaternion.set(-x, -y, z, w)，这里反解回 VMD 分量
    return [q.x, q.y, q.z, q.w].map((v, i) => (i < 2 ? -v : v));
}

// ---------- 手臂姿势计算 ----------
// 坐标说明：three.js 中模型正面朝 +Z，手臂放下沿 -Y。
// 1) 肩部：绕 Z 旋转把上臂转到“离垂直约 hangAngle 度”的自然外展位置
//    （对齐真实 MMD 动作的放松站姿，手臂不会贴死躯干），再绕 X 前后摆动。
// 2) 肘部：在“上臂坐标系”里绕 上臂方向×前方(+Z) 的轴做前弯，
//    这样前臂不会甩到身体内侧（之前的错误是在模型坐标系里直接弯向 (0,-1,0)）。
function armPoseAt(boneData, t, opt) {
    const { swingL, swingR, swayL = 0, swayR = 0, elbowBend = 10, hangAngle = 20 } = opt;
    const q = {};

    const qL = shoulderDownQuat(boneData, 'L', swingL, swayL, hangAngle);
    const qR = shoulderDownQuat(boneData, 'R', swingR, swayR, hangAngle);
    q['左肩'] = toMmd(qL);
    q['右肩'] = toMmd(qR);
    q['左ひじ'] = toMmd(elbowQuat(boneData.armDirL, boneData.foreDirL, elbowBend));
    q['右ひじ'] = toMmd(elbowQuat(boneData.armDirR, boneData.foreDirR, elbowBend));
    return q;
}

// 肩部“自然下垂”旋转（three.js 空间）：
// 把上臂静止方向转到 上臂离垂直 hangAngle 度 的放松外展位置（+sway 微调），再叠加前后摆 swing。
function shoulderDownQuat(boneData, side, swing, sway, hangAngle) {
    const armDir = side === 'L' ? boneData.armDirL : boneData.armDirR;
    const sign = side === 'L' ? 1 : -1;
    const restAng = Math.atan2(armDir.y, armDir.x);
    // 目标上臂方向：(sign*sin(α), -cos(α), 0)
    const targetAng = Math.atan2(-Math.cos(hangAngle * DEG), sign * Math.sin(hangAngle * DEG));
    const delta = targetAng - restAng;
    return rotX(swing).multiply(rotZ((delta / DEG) + sway));
}

// 肘部旋转（在肘部父系=上臂静止坐标系中计算）：
// 把前臂从静止方向转到“上臂方向前弯 bend 度”的方向。
function elbowQuat(armDir, foreDir, bendDeg) {
    const FRONT = new THREE.Vector3(0, 0, 1); // three.js 模型前方
    const axis = new THREE.Vector3().crossVectors(armDir, FRONT).normalize();
    const target = armDir.clone().applyAxisAngle(axis, bendDeg * DEG);
    return new THREE.Quaternion().setFromUnitVectors(foreDir, target.normalize());
}

// ---------- VMD 写入 ----------
const FPS = 30;

function padNameBytes(bytes, size) {
    const buf = Buffer.alloc(size);
    bytes.copy(buf, 0, 0, Math.min(bytes.length, size));
    return buf;
}

function quat(degX, degY, degZ) {
    // 欧拉角 -> 四元数 (x, y, z, w)。
    // 运行时应用时会对 X/Y 分量取反（bone.quaternion.set(-x,-y,z,w)），
    // 这里预先取反，使 VMD 里写的角度 = 最终 three.js 渲染角度。
    const hx = (degX * DEG) / 2;
    const hy = (degY * DEG) / 2;
    const hz = (degZ * DEG) / 2;
    const cx = Math.cos(hx), sx = Math.sin(hx);
    const cy = Math.cos(hy), sy = Math.sin(hy);
    const cz = Math.cos(hz), sz = Math.sin(hz);
    const q = [
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ];
    return [-q[0], -q[1], q[2], q[3]];
}

function buildVmd(boneNameBytes, modelName, tracks, propertyFrame) {
    // tracks: { 骨骼名: [ { frame, position:[x,y,z], rotation:[x,y,z,w] }, ... ] }
    const parts = [];
    const header = Buffer.alloc(30);
    Buffer.from('Vocaloid Motion Data 0002').copy(header);
    parts.push(header);

    const mn = Buffer.alloc(20);
    Buffer.from(modelName, 'ascii').copy(mn);
    parts.push(mn);

    const boneFrames = [];
    for (const name of Object.keys(tracks)) {
        for (const f of tracks[name]) {
            boneFrames.push({ name, ...f });
        }
    }
    boneFrames.sort((a, b) => a.frame - b.frame);

    const bc = Buffer.alloc(4);
    bc.writeUInt32LE(boneFrames.length);
    parts.push(bc);

    for (const f of boneFrames) {
        const nameBytes = boneNameBytes[f.name];
        if (!nameBytes) {
            throw new Error('模型缺少骨骼: ' + f.name);
        }
        const nameBuf = padNameBytes(nameBytes, 15);
        const frameBuf = Buffer.alloc(4);
        frameBuf.writeUInt32LE(f.frame);
        const posBuf = Buffer.alloc(12);
        posBuf.writeFloatLE(f.position[0], 0);
        posBuf.writeFloatLE(f.position[1], 4);
        posBuf.writeFloatLE(f.position[2], 8);
        const rotBuf = Buffer.alloc(16);
        rotBuf.writeFloatLE(f.rotation[0], 0);
        rotBuf.writeFloatLE(f.rotation[1], 4);
        rotBuf.writeFloatLE(f.rotation[2], 8);
        rotBuf.writeFloatLE(f.rotation[3], 12);
        const interp = Buffer.alloc(64);
        if (f.interp && f.interp.length === 16) {
            // 保留原始插值曲线（16 个归一化值 -> 4 通道 × 4 控制点，0-127）
            for (let c = 0; c < 4; c++) {
                for (let p = 0; p < 4; p++) {
                    interp[4 * p + c] = Math.max(0, Math.min(127, Math.round(f.interp[c * 4 + p] * 127)));
                }
            }
        } else {
            // 默认线性插值曲线（4 通道各 20,20,107,107）
            for (let k = 0; k < 4; k++) {
                interp[k] = 20;
                interp[4 + k] = 20;
                interp[8 + k] = 107;
                interp[12 + k] = 107;
            }
        }
        parts.push(nameBuf, frameBuf, posBuf, rotBuf, interp);
    }

    // 表情帧：无
    const mc = Buffer.alloc(4);
    mc.writeUInt32LE(0);
    parts.push(mc);

    // 相机/灯光/自阴影：无
    for (let i = 0; i < 3; i++) {
        const zero = Buffer.alloc(4);
        zero.writeUInt32LE(0);
        parts.push(zero);
    }

    // 属性帧（可选）：用于关闭腿部 IK，让走路动作的腿按骨骼旋转直接驱动
    if (propertyFrame) {
        const pc = Buffer.alloc(4);
        pc.writeUInt32LE(1);
        parts.push(pc);
        const frameBuf = Buffer.alloc(4);
        frameBuf.writeUInt32LE(propertyFrame.frame);
        parts.push(frameBuf);
        parts.push(Buffer.from([1])); // visible
        const ikc = Buffer.alloc(4);
        ikc.writeUInt32LE(propertyFrame.disabledIkBoneNames.length);
        parts.push(ikc);
        for (const name of propertyFrame.disabledIkBoneNames) {
            const nameBytes = boneNameBytes[name];
            if (!nameBytes) {
                throw new Error('模型缺少 IK 骨骼: ' + name);
            }
            parts.push(padNameBytes(nameBytes, 20));
            parts.push(Buffer.from([0])); // enabled=false（关闭该 IK）
        }
    }

    return Buffer.concat(parts);
}

// ---------- 关键帧工具 ----------
function keyTracks(defs, totalFrames) {
    // defs(t) -> { 骨骼名: { pos:[x,y,z], rot:[dx,dy,dz] | quat:[x,y,z,w] } }
    const names = Object.keys(defs(0));
    const tracks = {};
    for (const name of names) {
        tracks[name] = [];
    }
    for (let t = 0; t <= totalFrames; t++) {
        const v = defs(t);
        for (const name of names) {
            tracks[name].push({
                frame: t,
                position: v[name].pos,
                rotation: v[name].quat || quat(v[name].rot[0], v[name].rot[1], v[name].rot[2]),
            });
        }
    }
    return tracks;
}

const ZERO = [0, 0, 0];
function motion(name, totalFrames, defs, outFile, propertyFrame) {
    const tracks = keyTracks(defs, totalFrames);
    const vmd = buildVmd(boneNameBytes, 'BuiltinMotion', tracks, propertyFrame);
    const outPath = path.join(OUT_DIR, outFile);
    fs.writeFileSync(outPath, vmd);
    console.log(`生成 ${outFile} (${totalFrames} 帧, ${vmd.length} 字节) - ${name}`);
}

function sin(t, period, amp, phase = 0) {
    return amp * Math.sin((2 * Math.PI * t) / period + phase);
}

// ---------- 主流程（仅直接运行时执行） ----------
function readBoneData() {
    const { nameBytes, positions } = readPmdBones(MODEL_PMD);
    return {
        nameBytes,
        boneData: {
            // 上臂方向（肩 -> 肘）：决定“直臂”方向
            armDirL: V3(positions['左ひじ']).sub(V3(positions['左肩'])).normalize(),
            armDirR: V3(positions['右ひじ']).sub(V3(positions['右肩'])).normalize(),
            // 手臂整体方向（肩 -> 手）：用于自然下垂旋转
            handDirL: V3(positions['左手首']).sub(V3(positions['左肩'])).normalize(),
            handDirR: V3(positions['右手首']).sub(V3(positions['右肩'])).normalize(),
            // 前臂方向（肘 -> 手）
            foreDirL: V3(positions['左手首']).sub(V3(positions['左ひじ'])).normalize(),
            foreDirR: V3(positions['右手首']).sub(V3(positions['右ひじ'])).normalize(),
        },
    };
}

// 动作定义。手臂姿势统一用 armPoseAt() 计算（自然下垂，不再人字形）。
const motions = [
    {
        name: '待机-呼吸',
        out: 'idle_breath.vmd',
        frames: 120,
        defs: (t) => {
            const arm = armPoseAt(boneData, t, {
                swingL: 1.5 * sin(t, 120, 1, Math.PI),
                swingR: -1.5 * sin(t, 120, 1, Math.PI),
                swayL: 2 * sin(t, 240, 1),
                swayR: -2 * sin(t, 240, 1),
                elbowBend: 10,
            });
            return {
                センター: {
                    pos: [0, 0.12 * Math.sin((2 * Math.PI * t) / 120), 0],
                    rot: [0, 0, 0],
                },
                上半身: {
                    pos: ZERO,
                    rot: [2 * sin(t, 120, 1, Math.PI), 0, 0.6 * sin(t, 240, 1)],
                },
                首: {
                    pos: ZERO,
                    rot: [1.5 * sin(t, 120, 1, Math.PI), 0, 0],
                },
                頭: {
                    pos: ZERO,
                    rot: [1.5 * sin(t, 120, 1, Math.PI), 0, 0],
                },
                左肩: { pos: ZERO, quat: arm['左肩'] },
                右肩: { pos: ZERO, quat: arm['右肩'] },
                左ひじ: { pos: ZERO, quat: arm['左ひじ'] },
                右ひじ: { pos: ZERO, quat: arm['右ひじ'] },
            };
        },
    },
];

if (require.main === module) {
    if (!fs.existsSync(MODEL_PMD)) {
        console.error('找不到模型文件用于提取骨骼名: ' + MODEL_PMD);
        process.exit(1);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const { nameBytes: boneNameBytes } = readBoneData();
    for (const m of motions) {
        motion(m.name, m.frames, m.defs, m.out);
    }
    console.log('全部内置动作已生成到 ' + OUT_DIR);
}

module.exports = {
    readPmdBones,
    readBoneData,
    V3,
    DEG,
    rotX,
    rotZ,
    toMmd,
    shoulderDownQuat,
    elbowQuat,
    buildVmd,
    padNameBytes,
};
