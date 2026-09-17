declare module 'verovio/wasm' {
  export default function createModule(): Promise<unknown>
}
declare module 'verovio/esm' {
  export class VerovioToolkit {
    constructor(module: unknown)
    setOptions(options: Record<string, unknown>): boolean
    loadData(data: string): boolean
    getPageCount(): number
    renderToSVG(page: number): string
    destroy(): void
  }
}
