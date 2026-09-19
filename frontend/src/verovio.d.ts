declare module 'verovio/wasm' {
  export default function createModule(): Promise<unknown>
}
declare module 'verovio/esm' {
  /**
   * Shape of the JSON returned by getElementsAtTime (verovio 6.x). Element ids
   * are the plain `id` attributes of the rendered SVG groups, which is how a
   * highlighted note is located in the DOM.
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
    /** Element ids sounding at the given time in ms; requires `timemap: true`. */
    getElementsAtTime(milliseconds: number): VerovioTimemap
    destroy(): void
  }
}
