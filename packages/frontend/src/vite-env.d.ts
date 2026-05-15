/// <reference types="vite/client" />

declare module '*.css?inline' {
    const cssText: string;
    export default cssText;
}
