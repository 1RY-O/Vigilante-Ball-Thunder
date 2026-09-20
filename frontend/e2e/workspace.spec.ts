import { test, expect } from '@playwright/test'
function wav() {
  const data = Buffer.alloc(44 + 16000 * 2 * 4)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40)
  return data
}
test('upload → server states → real notation → playback and both exports', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Choose a recording' })).toBeEnabled()
  // The e2e server serves synthetic fixture data, so the UI must label it mock.
  await expect(page.getByText('Demo engine active')).toBeVisible()
  await page.getByLabel('Choose audio recording').setInputFiles({ name: 'Morning melody.wav', mimeType: 'audio/wav', buffer: wav() })
  await expect(page.getByText('Recording selected')).toBeVisible()
  await page.getByRole('button', { name: 'Create sheet music' }).click()
  // Uploading/queued/transcribing are transient on fast backends (real
  // localhost stub completes in milliseconds), so they may never paint;
  // the final readiness must appear either way.
  await expect(page.getByText('Your score is ready')).toBeVisible({ timeout: 30000 })
  const score = page.getByRole('img', { name: 'Sheet music, page 1' })
  const engraving = score.locator('svg.definition-scale')
  await expect(engraving).toBeVisible()
  for (const notation of ['staff', 'clef', 'note', 'rest', 'measure', 'tie']) expect(await engraving.locator(`.${notation}`).count()).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.getByLabel('Zoom level')).toHaveText('110%')
  for (const [name, extension] of [['Download MIDI', '.mid'], ['Download MusicXML', '.musicxml']]) {
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name, exact: false }).click()
    expect((await download).suggestedFilename()).toContain(extension)
  }
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(page.getByLabel('Current position')).toContainText('0:00')
  await page.screenshot({ path: testInfo.outputPath('desktop-result.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mobile-result.png'), fullPage: true })
  await page.setViewportSize({ width: 320, height: 568 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})
test('cancel mid-polling stops cleanly and asks the service to cancel', async ({ page }) => {
  // Keep the job transcribing forever so the stop path is reachable; the
  // DELETE must reach the service.
  await page.route('**/api/transcriptions/mock-job-1', route => {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 200, json: { id: 'mock-job-1', status: 'error', error: { code: 'cancelled', message: 'The transcription was cancelled.' } } })
    return route.fulfill({ status: 200, json: { id: 'mock-job-1', status: 'transcribing', progress: 40 } })
  })
  await page.goto('/')
  await page.getByLabel('Choose audio recording').setInputFiles({ name: 'Morning melody.wav', mimeType: 'audio/wav', buffer: wav() })
  await page.getByRole('button', { name: 'Create sheet music' }).click()
  await expect(page.getByText('Transcribing your recording')).toBeVisible({ timeout: 15000 })
  const deleteSeen = page.waitForRequest(request => request.url().includes('/api/transcriptions/mock-job-1') && request.method() === 'DELETE')
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  await deleteSeen
  await expect(page.getByText('Recording selected')).toBeVisible()
  await expect(page.getByText(/Stopped waiting here/)).toBeVisible()
})
test('unavailable service is honest and visually usable', async ({ page }, testInfo) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: 'private stack trace' }))
  await page.goto('/')
  await expect(page.getByText('Transcription isn’t connected yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a recording' })).toBeDisabled()
  await expect(page.getByText('private stack trace')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('desktop-idle.png'), fullPage: true })
})
