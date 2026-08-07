// 把 MMDAgent 单手挥手动作（onehandwave.vmd）合并上“左臂自然下垂”轨道：
// 原动作只包含右臂/手指，左臂没有轨道，播放时会停留在模型的默认人字形。
// 本脚本保留原动作右臂的全部帧（含插值曲线），为左肩/左肘补上恒定下垂旋转。
//
// 用法: node scripts/merge-wave-leftarm.mjs
import { parseVmd } from '@yohawing/three-mmd-loader/parser';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import gen from './generate-builtin-vmds.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOTIONS = path.join(ROOT, 'ModelMMD', 'Motions');
const ORIG = path.join(MOTIONS, 'mmdagent_wave_orig.vmd');
const MERGED = path.join(MOTIONS, 'mmdagent_wave.vmd');
const SRC_URL = 'https://raw.githubusercontent.com/mmdagent-ex/example/main/example_motion/onehandwave.vmd';

const { readBoneData, buildVmd, shoulderDownQuat, elbowQuat, toMmd } = gen;
const { nameBytes, boneData } = readBoneData();

// 1. 获取原始单手挥手 VMD（本地保留 mmdagent_wave_orig.vmd，缺失时联网下载）
if (!existsSync(ORIG)) {
    console.log('下载原始挥手动作:', SRC_URL);
    const resp = await fetch(SRC_URL);
    if (!resp.ok) {
        throw new Error('下载失败: ' + resp.status);
    }
    writeFileSync(ORIG, Buffer.from(await resp.arrayBuffer()));
}

// 2. 解析原始动作，转换为帧列表（保留每帧插值曲线）
const parsed = parseVmd(readFileSync(ORIG));
const tracks = {};
for (const name of Object.keys(parsed.boneTracks)) {
    // 只保留项目模型里存在的骨骼（缺失骨骼加载器会忽略，写入反而会失败）
    if (!nameBytes[name]) {
        console.log('跳过模型缺失骨骼:', name);
        continue;
    }
    const t = parsed.boneTracks[name];
    const frames = [];
    for (let i = 0; i < t.frames.length; i++) {
        const to = i * 3, ro = i * 4;
        frames.push({
            frame: t.frames[i],
            position: [t.translations[to], t.translations[to + 1], t.translations[to + 2]],
            rotation: [t.rotations[ro], t.rotations[ro + 1], t.rotations[ro + 2], t.rotations[ro + 3]],
            interp: Array.from(t.interpolations.subarray(i * 16, i * 16 + 16)),
        });
    }
    tracks[name] = frames;
}

// 3. 补上左臂自然下垂轨道（全程恒定，与待机姿势一致）
const maxFrame = parsed.metadata.maxFrame;
const qShoulder = shoulderDownQuat(boneData, 'L', 0, 0, 20);
const qElbow = elbowQuat(boneData.armDirL, boneData.foreDirL, 10);
const leftShoulder = [];
const leftElbow = [];
for (let f = 0; f <= maxFrame; f++) {
    leftShoulder.push({ frame: f, position: [0, 0, 0], rotation: toMmd(qShoulder) });
    leftElbow.push({ frame: f, position: [0, 0, 0], rotation: toMmd(qElbow) });
}
tracks['左肩'] = leftShoulder;
tracks['左ひじ'] = leftElbow;

// 4. 写出合并后的 VMD
const vmd = buildVmd(nameBytes, 'MMDAgentWave+Merge', tracks);
writeFileSync(MERGED, vmd);
console.log(`已生成合并挥手动作: ${MERGED} (${vmd.length} 字节, ${Object.keys(tracks).length} 个骨骼轨道)`);
