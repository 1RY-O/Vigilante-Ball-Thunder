declare module 'verovio/wasm' {
  export default function createModule(): Promise<unknown>
}
declare module 'verovio/esm' {
  /**
   * One live answer from getElementsAtTime(ms) (verovio 6.3.0, verified by a
   * Node probe against frontend/e2e/fixtures/score.musicxml: at 0ms the
   * toolkit returns e.g. { chords: [], measure: "…", notes: ["…"], page: 1,
   * rests: [] }). Element ids are the plain `id` attributes of the rendered
   * SVG groups, which is how a highlighted note is located in the DOM. No
   * render option is required for these answers to be available.
   */
  export interface VerovioTimemap {
    notes?: string[]
    rests?: string[]
    chords?: string[]
    measure?: string
    page?: number
  }
  export class VerovioToolkit {
    constructor(module: unknown)
    setOptions(options: Record<string, unknown>): boolean
    loadData(data: string): boolean
    getPageCount(): number
    renderToSVG(page: number): string
    /** Full onset map; entries carry timing only, never note ids. */
    renderToTimemap(options?: Record<string, unknown>): VerovioTimemapEntry[]
    /** Element ids sounding at the given time in ms; needs no render option. */
    getElementsAtTime(milliseconds: number): VerovioTimemap
    destroy(): void
  }
}
