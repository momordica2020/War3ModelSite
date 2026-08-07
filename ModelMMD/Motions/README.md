# MMD 内置动作

本目录存放项目内置的 VMD 动作。加载任意 MMD 模型（PMD/PMX）后，这些动作会自动出现在
右侧“动作列表”中（带“内置”标记），直接点击即可播放；同时保留“上传 VMD 动作”按钮，
可继续加载自己的 .vmd 文件。

## 动作清单

| 文件 | 显示名称 | 时长 | 说明 |
| --- | --- | --- | --- |
| `idle_breath.vmd` | 待机-呼吸 | ~4.0s | 呼吸起伏待机 |
| `mmdagent_walk.vmd` | 走路（MMDAgent） | ~3.2s | 自然走路（专业制作） |
| `mmdagent_wave.vmd` | 挥手（MMDAgent） | ~2.6s | 单手挥手（专业制作，已合并左臂自然下垂） |
| `mmdagent_eshaku.vmd` | 会釈-行礼（MMDAgent） | ~1.6s | 点头行礼（专业制作） |
| `wavefile_v2.vmd` | 舞蹈-WAVEFILE | ~93.7s | 完整节奏舞蹈（社区动作） |

## 来源与许可

- `mmdagent_walk.vmd`、`mmdagent_wave.vmd`、`mmdagent_eshaku.vmd`：
  来自 **MMDAgent-EX** 开源项目（[github.com/mmdagent-ex/example](https://github.com/mmdagent-ex/example)），
  由名古屋工业大学团队制作，遵循 Apache License 2.0，允许自由使用与再分发。
  文件使用标准 MMD 日文骨骼名，兼容项目内 PMD/PMX 模型（少量扭骨/手指骨缺失时自动忽略）。
  `mmdagent_wave.vmd` 是在原始单手挥手动作（`mmdagent_wave_orig.vmd`）基础上，
  由 `scripts/merge-wave-leftarm.mjs` 合并了左臂自然下垂轨道（原始动作只含右臂，
  不合并时左臂会停留在模型默认人字形）。如需重新合并，运行 `npm run merge-wave`。
- `wavefile_v2.vmd`：社区舞蹈动作 **WAVEFILE**，配布者 hino（niconico：
  [sm13147122](https://www.nicovideo.jp/watch/sm13147122)，原曲为ラマーズP 的
  WAVEFILE）。该文件取自 three.js 官方示例仓库（MIT 协议仓库）。原配布说明
  （见 `README-wavefile.txt`）允许自由修改与再配布，未联系前禁止商用。
- `idle_breath.vmd`：由本项目 `scripts/generate-builtin-vmds.js` 原创生成，
  使用标准 MMD 日文骨骼名，无第三方版权问题。如需重新生成，运行 `npm run gen-motions`。
