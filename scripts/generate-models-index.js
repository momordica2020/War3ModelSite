// 生成War3模型索引文件
// 扫描 War3Assets/ 下的 .mdx 文件，按目录结构生成 JSON 索引
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'War3Assets');
const MMD_DIR = path.join(ROOT, 'ModelMMD');
const OUTPUT = path.join(ROOT, 'src', 'models-index.json');

// 要扫描的模型目录（按类别）
const SCAN_DIRS = [
    { dir: 'Units', category: '单位', icon: '⚔' },
    { dir: 'buildings', category: '建筑', icon: '🏰' },
    { dir: 'Doodads', category: '装饰物', icon: '🌳' },
    { dir: 'SharedModels', category: '特效与共享', icon: '✨' },
    { dir: 'Objects', category: '对象', icon: '📦' },
];

// 类别名称中文化映射
const CATEGORY_CN = {
    // Units 下的种族
    'Human': '人族',
    'Orc': '兽族',
    'NightElf': '暗夜精灵',
    'Undead': '不死族',
    'Naga': '娜迦',
    'Demon': '恶魔',
    'Creeps': '野生中立',
    'Critters': '小动物',
    'Other': '其他',
    'Neutral': '中立',
    // buildings 下
    'Human': '人族',
    'Orc': '兽族',
    'NightElf': '暗夜精灵',
    'Undead': '不死族',
    'Other': '其他',
    'Neutral': '中立',
};

function findMdxFiles(dir, basePath = '') {
    const results = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = basePath ? basePath + '/' + entry.name : entry.name;

        if (entry.isDirectory()) {
            results.push(...findMdxFiles(fullPath, relPath));
        } else if (entry.isFile() && /\.mdx$/i.test(entry.name)) {
            // 排除portrait模型（肖像模型通常不需要浏览）
            if (!/_?portrait/i.test(entry.name)) {
                results.push({
                    name: entry.name.replace(/\.mdx$/i, ''),
                    path: 'War3Assets/' + relPath.replace(/\\/g, '/'),
                });
            }
        }
    }
    return results;
}

// 扫描 ModelMMD/ 下的 .pmd/.pmx 文件（跳过"复件"副本与压缩包）
function findMmdFiles(dir, basePath = '') {
    const results = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('复件')) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = basePath ? basePath + '/' + entry.name : entry.name;

        if (entry.isDirectory()) {
            results.push(...findMmdFiles(fullPath, relPath));
        } else if (entry.isFile() && /\.(pmd|pmx)$/i.test(entry.name)) {
            results.push({
                name: entry.name.replace(/\.(pmd|pmx)$/i, ''),
                path: 'ModelMMD/' + relPath.replace(/\\/g, '/'),
            });
        }
    }
    return results;
}

// 构建 MMD 模型分类（ModelMMD 下每个子目录作为一个子分类）
function buildMmdCategory() {
    const rootModels = [];
    const subCategories = {};

    if (fs.existsSync(MMD_DIR)) {
        const entries = fs.readdirSync(MMD_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('复件')) continue;
            if (entry.isDirectory()) {
                const models = findMmdFiles(path.join(MMD_DIR, entry.name), entry.name);
                if (models.length > 0) {
                    subCategories[entry.name] = {
                        name: entry.name,
                        path: 'ModelMMD/' + entry.name,
                        models: models,
                        groups: {},
                    };
                }
            } else if (entry.isFile() && /\.(pmd|pmx)$/i.test(entry.name)) {
                rootModels.push({
                    name: entry.name.replace(/\.(pmd|pmx)$/i, ''),
                    path: 'ModelMMD/' + entry.name,
                });
            }
        }
    }

    if (rootModels.length === 0 && Object.keys(subCategories).length === 0) {
        return null;
    }
    return {
        name: 'MMD 模型',
        icon: '🎤',
        path: 'ModelMMD',
        models: rootModels,
        subCategories: subCategories,
    };
}

function buildCategoryTree(scanDirInfo) {
    const { dir, category, icon } = scanDirInfo;
    const fullDir = path.join(ASSETS_DIR, dir);
    if (!fs.existsSync(fullDir)) {
        return { name: category, icon, path: dir, children: [] };
    }

    // 读取一级子目录作为子分类
    const subCategories = {};
    const rootModels = [];

    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const subDir = path.join(fullDir, entry.name);
            const subPath = dir + '/' + entry.name;
            const models = findMdxFiles(subDir, subPath);
            if (models.length > 0) {
                const subName = CATEGORY_CN[entry.name] || entry.name;
                // 如果子目录下还有更深层的子目录，按子目录分组
                const nestedGroups = {};
                const directModels = [];

                const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
                for (const subEntry of subEntries) {
                    if (subEntry.isDirectory()) {
                        const nestedDir = path.join(subDir, subEntry.name);
                        const nestedPath = subPath + '/' + subEntry.name;
                        const nestedModels = findMdxFiles(nestedDir, nestedPath);
                        if (nestedModels.length > 0) {
                            nestedGroups[subEntry.name] = nestedModels;
                        }
                    } else if (subEntry.isFile() && /\.mdx$/i.test(subEntry.name)) {
                        if (!/_?portrait/i.test(subEntry.name)) {
                            directModels.push({
                                name: subEntry.name.replace(/\.mdx$/i, ''),
                                path: 'War3Assets/' + subPath + '/' + subEntry.name,
                            });
                        }
                    }
                }

                const subCategory = {
                    name: subName,
                    path: subPath,
                    models: directModels,
                    groups: nestedGroups,
                };
                subCategories[entry.name] = subCategory;
            }
        } else if (entry.isFile() && /\.mdx$/i.test(entry.name)) {
            if (!/_?portrait/i.test(entry.name)) {
                rootModels.push({
                    name: entry.name.replace(/\.mdx$/i, ''),
                    path: 'War3Assets/' + dir + '/' + entry.name,
                });
            }
        }
    }

    return {
        name: category,
        icon: icon,
        path: dir,
        models: rootModels,
        subCategories: subCategories,
    };
}

console.log('扫描 War3Assets/ 生成模型索引...');
const tree = SCAN_DIRS.map(buildCategoryTree);

// 统计模型总数
let totalCount = 0;
function countModels(node) {
    totalCount += (node.models || []).length;
    if (node.subCategories) {
        for (const key in node.subCategories) {
            countModels(node.subCategories[key]);
        }
    }
    if (node.groups) {
        for (const key in node.groups) {
            totalCount += node.groups[key].length;
        }
    }
}
tree.forEach(countModels);

// 同时把自定义模型也加入
const customModelsDir = path.join(ROOT, 'Models');
const customModels = [];
if (fs.existsSync(customModelsDir)) {
    const customEntries = fs.readdirSync(customModelsDir, { withFileTypes: true });
    for (const entry of customEntries) {
        if (entry.isDirectory()) {
            const subDir = path.join(customModelsDir, entry.name);
            const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
            for (const subEntry of subEntries) {
                if (subEntry.isFile() && /\.mdx$/i.test(subEntry.name)) {
                    customModels.push({
                        name: subEntry.name.replace(/\.mdx$/i, ''),
                        path: 'Models/' + entry.name + '/' + subEntry.name,
                    });
                }
            }
        } else if (entry.isFile() && /\.mdx$/i.test(entry.name)) {
            customModels.push({
                name: entry.name.replace(/\.mdx$/i, ''),
                path: 'Models/' + entry.name,
            });
        }
    }
}

if (customModels.length > 0) {
    tree.unshift({
        name: '自定义模型',
        icon: '⭐',
        path: 'Models',
        models: customModels,
        subCategories: {},
    });
    totalCount += customModels.length;
}

// MMD 模型分类（放在最后）
const mmdCategory = buildMmdCategory();
if (mmdCategory) {
    tree.push(mmdCategory);
    countModels(mmdCategory);
}

const output = {
    totalModels: totalCount,
    tree: tree,
};

const newContent = JSON.stringify(output, null, 2) + '\n';

let shouldWrite = true;
if (fs.existsSync(OUTPUT)) {
    const oldContent = fs.readFileSync(OUTPUT, 'utf-8');
    const oldData = JSON.parse(oldContent);
    if (oldData.totalModels === output.totalModels &&
        JSON.stringify(oldData.tree) === JSON.stringify(output.tree)) {
        shouldWrite = false;
    }
}

if (shouldWrite) {
    fs.writeFileSync(OUTPUT, newContent, 'utf-8');
    console.log(`完成！共索引 ${totalCount} 个模型（已更新）`);
} else {
    console.log(`完成！共索引 ${totalCount} 个模型（无变化，未更新文件）`);
}
console.log(`输出文件: ${OUTPUT}`);
