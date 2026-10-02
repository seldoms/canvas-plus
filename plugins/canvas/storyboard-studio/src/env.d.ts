// esbuild 以 text loader 把 .css 打成字符串
declare module "*.css" {
    const css: string;
    export default css;
}
