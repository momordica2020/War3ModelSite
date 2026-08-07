const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const EMPTY_MODULE = path.resolve(__dirname, 'src/empty.js');

// GitHub Pages 仓库名，用于子路径部署（留空则使用根路径）
// 部署到 https://用户名.github.io/仓库名/ 时填写仓库名
const PUBLIC_PATH = process.env.GH_PAGES_BASE || './';

module.exports = (env, argv) => {
    const isDev = argv.mode === 'development';

    return {
        entry: './src/main.js',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'bundle.js',
            publicPath: PUBLIC_PATH,
            clean: true
        },
        plugins: [
            // mmd 加载器在 Node 分支动态导入 node: 内建模块，浏览器打包替换为空模块
            new webpack.NormalModuleReplacementPlugin(
                /^node:(fs\/promises|url)$/,
                (resource) => {
                    resource.request = EMPTY_MODULE;
                }
            ),
            new webpack.DefinePlugin({
                'process.env.FENGARICONF': 'void 0',
                'typeof process': JSON.stringify('undefined'),
            }),
            new HtmlWebpackPlugin({
                template: './index.html',
                inject: 'body'
            }),
            // 复制静态资源到 dist（仅小文件，War3Assets 由用户自行处理）
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: 'Models',
                        to: 'Models',
                        noErrorOnMissing: true
                    },
                    // MMD 模型目录（排除压缩包与配置文件）
                    {
                        from: 'ModelMMD',
                        to: 'ModelMMD',
                        noErrorOnMissing: true,
                        globOptions: {
                            ignore: ['**/*.zip', '**/*.ZIP', '**/TPOConfig.xml']
                        }
                    },
                    // MMD 解析用 WASM（供 mmd-anim 核心使用，缺失时自动回退 TS 解析）
                    {
                        from: 'node_modules/@yohawing/three-mmd-loader/dist/parser/wasm/generated/mmd_anim_wasm_bg.wasm',
                        to: 'mmd_anim_wasm_bg.wasm',
                        noErrorOnMissing: true
                    },
                    {
                        from: 'src/models-index.json',
                        to: 'models-index.json',
                        noErrorOnMissing: true
                    },
                    {
                        from: 'src/model-translations.json',
                        to: 'model-translations.json',
                        noErrorOnMissing: true
                    },
                    { from: 'War3Assets/**/*.mdx', noErrorOnMissing: true },
                    { from: 'War3Assets/**/*.MDX', noErrorOnMissing: true },
                    { from: 'War3Assets/**/*.blp', noErrorOnMissing: true },
                    { from: 'War3Assets/**/*.BLP', noErrorOnMissing: true }
                ]
            })
        ],
        module: {
            rules: [
                {
                    test: /\.wasm$/i,
                    type: 'asset/resource',
                },
                {
                    test: /\.css$/i,
                    use: ['style-loader', 'css-loader'],
                },
                {
                    test: /\.json$/i,
                    type: 'json',
                },
            ],
        },
        resolve: {
            extensions: ['.js', '.ts'],
            // 允许访问带 exports 限制的包内部路径（如 mmd 加载器的 wasm 资源）
            exportsFields: [],
            fallback: {
                events: require.resolve('events/'),
                buffer: require.resolve('buffer/'),
                stream: require.resolve('stream-browserify'),
                util: require.resolve('util/'),
                path: require.resolve('path-browserify'),
            },
            alias: {
                // mmd 加载器仅在 Node 环境动态导入这些模块，浏览器打包时忽略
                'node:fs/promises': false,
                'node:url': false,
            },
        },
        devtool: isDev ? 'eval-cheap-module-source-map' : 'source-map',
        devServer: {
            static: [
                { directory: path.join(__dirname, '.'), watch: false },
                { directory: path.join(__dirname, 'src'), publicPath: '/', watch: false }
            ],
            port: 8097,
            open: true,
            hot: true,
            client: {
                overlay: true,
            }
        },
        performance: {
            hints: false,
        },
    };
};
