const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

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
            fallback: {
                events: require.resolve('events/'),
                buffer: require.resolve('buffer/'),
                stream: require.resolve('stream-browserify'),
                util: require.resolve('util/'),
                path: require.resolve('path-browserify'),
            }
        },
        devtool: isDev ? 'eval-cheap-module-source-map' : 'source-map',
        devServer: {
            static: [
                { directory: path.join(__dirname, '.') },
                { directory: path.join(__dirname, 'src'), publicPath: '/' }
            ],
            port: 8080,
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
