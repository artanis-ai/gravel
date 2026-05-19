/**
 * Integration test for the Gemini auto-patch against the REAL
 * `@google/genai` SDK. Catches the class of bug that `vi.mock` shaped
 * tests can never catch: the FakeModels in `tracing-gemini.test.ts`
 * declares the public method on the prototype, but the real SDK
 * assigns it as an instance own-property delegating to `*Internal` on
 * the prototype — so a patch against `Models.prototype.generateContent`
 * is a no-op against the real SDK and every customer call goes
 * untraced. v0.7.0 shipped exactly that bug.
 *
 * This test:
 *   1. Spins up a tiny local HTTP server that speaks the Gemini
 *      `generateContent` shape (canned response).
 *   2. Imports the real `@google/genai` SDK and the gravel patch.
 *   3. Calls `ai.models.generateContent({...})` against the mock base
 *      URL.
 *   4. Asserts `persistSample` was called with name=`gemini.models.generate_content`
 *      and provider=`gemini`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'

const persistSpy = vi.fn(async () => {})
vi.mock('../src/tracing/persist.js', () => ({
  persistSample: persistSpy,
  _resetGravelTracingForTests: () => {},
  setGravelTracingConfig: () => {},
}))

let server: Server
let baseUrl = ''

beforeAll(async () => {
  // Realistic shape captured from gemini-flash-latest on 2026-05-19.
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const out = {
        candidates: [
          {
            content: {
              parts: [{ text: 'mock-gemini-response', thoughtSignature: 'AAAA' }],
              role: 'model',
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 4,
          totalTokenCount: 60,
          promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }],
          thoughtsTokenCount: 48,
          serviceTier: 'standard',
        },
        modelVersion: 'gemini-mock',
        responseId: 'mock-001',
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(0, '127.0.0.1')
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  // Install the patch against the REAL @google/genai by importing both.
  await import('../src/tracing/gemini.js')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  persistSpy.mockClear()
})

describe('Gemini auto-patch against real @google/genai', () => {
  it('intercepts a real SDK call and persists a sample with the canonical trace name', async () => {
    const { GoogleGenAI } = await import('@google/genai')
    const ai = new GoogleGenAI({
      apiKey: 'test-key',
      httpOptions: { baseUrl },
    })
    const response = await ai.models.generateContent({
      model: 'gemini-mock-test',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })
    // Real SDK shape access: the response is the GenerateContentResponse object.
    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('mock-gemini-response')

    // Tracing happens in `void persistSample(...)` after the call returns; give
    // microtasks a beat to settle.
    await new Promise((r) => setTimeout(r, 50))

    expect(persistSpy).toHaveBeenCalledTimes(1)
    const call = persistSpy.mock.calls[0][0] as {
      name: string
      status: string
      provider?: string
      tokensInput?: number
      tokensOutput?: number
    }
    expect(call.name).toBe('gemini.models.generate_content')
    expect(call.status).toBe('completed')
    expect(call.provider).toBe('gemini')
    // Real v1beta usage_metadata fields land via tokensInput/tokensOutput.
    expect(call.tokensInput).toBe(8)
    expect(call.tokensOutput).toBe(4)
  })
})
